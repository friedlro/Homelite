'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = process.env.HOMELITE_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });
const FILE = path.join(DATA, 'config.json');
const DBFILE = path.join(DATA, 'homelite.db');

// SQLite ist in Node ≥ 22.13 eingebaut (node:sqlite). Die Experimental-Meldung wird unterdrückt.
let sqlite = null;
{
  const ow = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w && w.message ? w.message : w).includes('SQLite') ? undefined : ow.call(process, w, ...a));
  try { sqlite = require('node:sqlite'); } catch { sqlite = null; } finally { process.emitWarning = ow; }
}
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS energy_day (day TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS energy_series (ts INTEGER PRIMARY KEY, pv REAL, grid REAL, bat REAL, house REAL, soc REAL);
  CREATE TABLE IF NOT EXISTS energy_quarter (ts INTEGER PRIMARY KEY, imp REAL, exp REAL, peak INTEGER, cov INTEGER, pts INTEGER);
`;

const defaults = () => ({
  mqtt: { url: '', user: '', pass: '', z2mBase: 'zigbee2mqtt', tasmotaGroup: 'tasmotas' },
  auth: { salt: '', hash: '', secret: crypto.randomBytes(32).toString('hex') },
  notify: { url: 'https://ntfy.sh', topic: '' },
  rooms: ['Wohnzimmer', 'Küche', 'Schlafzimmer', 'Bad', 'Außen'],
  devices: [],
  automations: [],
  heating: { mode: 'auto', frost: 7, rooms: [] },
  update: { url: '' },
  dash: { blocks: null },
  ecowitt: { ip: '', interval: 60 },
  matter: { enabled: false },
  modules: null,
  dewIgnore: [],
  broker: { port: 1883, allowAnonymous: false, users: [], internal: null },
  mcp: { token: '', allowControl: true, allowUnlock: false, allowAutomations: true },
  appletv: { devices: [] },
  coiot: { enabled: true, port: 5683, host: '' },
  plugins: {},
  findmy: { enabled: false, apple: '', password: '', china: false, interval: 120, devices: [] },
  energy: { peakLimit: 0, pv: [], grid: [], gridInvert: false, battery: [], batteryInvert: false, soc: '', house: [], consumers: [], victron: { host: '', port: 1883, user: '', pass: '', portalId: '', base: 'N', phases: 3, keepalive: true } },
  backup: { dir: '', keep: 10, auto: false, time: '03:00', allowSameDisk: false, last: null, lastAutoDay: '' },
  car: {
    enabled: false, name: 'Leapmotor', username: '', password: '', pin: '',
    certPath: '', keyPath: '', vin: '', pollMinutes: 10,
  },
  geofence: {
    key: crypto.randomBytes(16).toString('hex'),
    persons: [],
    zones: [{ id: 'home', name: 'Zuhause', lat: null, lon: null, radius: 150, home: true }],
  },
});

const store = { DATA, cfg: defaults() };

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
}

store.setPassword = (pw) => {
  const { salt, hash } = hashPw(pw);
  store.cfg.auth.salt = salt;
  store.cfg.auth.hash = hash;
};

store.checkPassword = (pw) => {
  const { salt, hash } = store.cfg.auth;
  if (!salt || !hash) return false;
  const a = Buffer.from(hashPw(pw, salt).hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

store.db = null;
store.backend = 'json';
const cache = new Map(); // zuletzt gespeicherte Serialisierung je Zeile/Abschnitt (unveränderte werden übersprungen)
const ROWS = ['devices', 'automations'];

function openDb() {
  if (!sqlite) return;
  try {
    const db = new sqlite.DatabaseSync(DBFILE);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    db.exec(SCHEMA);
    store.db = db;
    store.backend = 'sqlite';
    try { fs.chmodSync(DBFILE, 0o600); } catch { /* ignorieren */ }
  } catch (e) { console.error('SQLite nicht verfügbar, verwende config.json:', e.message); store.db = null; }
}

function saveSqlite() {
  const db = store.db;
  const done = [];
  db.exec('BEGIN');
  try {
    const up = db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
    for (const [k, v] of Object.entries(store.cfg)) {
      if (ROWS.includes(k)) continue;
      const sv = JSON.stringify(v);
      if (cache.get('kv:' + k) !== sv) { up.run(k, sv); done.push(['kv:' + k, sv]); }
    }
    for (const t of ROWS) {
      const list = store.cfg[t];
      const ins = db.prepare(`INSERT INTO ${t}(id,pos,json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET pos=excluded.pos, json=excluded.json`);
      const ids = new Set();
      list.forEach((it, i) => {
        ids.add(it.id);
        const sv = i + '|' + JSON.stringify(it);
        if (cache.get(`${t}:${it.id}`) !== sv) { ins.run(it.id, i, JSON.stringify(it)); done.push([`${t}:${it.id}`, sv]); }
      });
      const del = db.prepare(`DELETE FROM ${t} WHERE id=?`);
      for (const k of [...cache.keys()]) {
        if (k.startsWith(t + ':') && !ids.has(k.slice(t.length + 1))) { del.run(k.slice(t.length + 1)); done.push([k, null]); }
      }
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignorieren */ } throw e; }
  for (const [k, v] of done) { if (v === null) cache.delete(k); else cache.set(k, v); }
}

store.save = () => {
  if (store.frozen) return; // nach einer Wiederherstellung bis zum Neustart gesperrt
  if (store.db) { saveSqlite(); return; }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store.cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
};

// Einzelne Zusatzwerte (z. B. Anwesenheit) – in SQLite unter „x:<Schlüssel>“, sonst als <Schlüssel>.json
store.kvGet = (key) => {
  if (store.db) {
    const r = store.db.prepare('SELECT v FROM kv WHERE k=?').get('x:' + key);
    if (r) { try { return JSON.parse(r.v); } catch { return undefined; } }
    const legacy = path.join(DATA, key + '.json');
    try { const v = JSON.parse(fs.readFileSync(legacy, 'utf8')); store.kvSet(key, v); fs.renameSync(legacy, legacy + '.migrated'); return v; } catch { return undefined; }
  }
  try { return JSON.parse(fs.readFileSync(path.join(DATA, key + '.json'), 'utf8')); } catch { return undefined; }
};
store.kvSet = (key, val) => {
  if (store.frozen) return;
  if (store.db) { store.db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('x:' + key, JSON.stringify(val)); return; }
  const f = path.join(DATA, key + '.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(val));
  fs.renameSync(f + '.tmp', f);
};

// konsistente Kopie der Datenbank (für Backups)
store.snapshotDb = (target) => {
  if (!store.db) return false;
  fs.rmSync(target, { force: true });
  store.db.prepare('VACUUM INTO ?').run(target);
  return true;
};

// Prüft eine Datenbankdatei (Backup) und liefert die Anzahl Geräte/Automationen
store.inspectDb = (file) => {
  if (!sqlite) throw new Error('SQLite nicht verfügbar (Node ≥ 22.13 nötig)');
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const n = (t) => db.prepare(`SELECT count(*) c FROM ${t}`).get().c;
    const auth = db.prepare("SELECT v FROM kv WHERE k='auth'").get();
    if (!auth) throw new Error('Datenbank enthält keine Einstellungen');
    return { devices: n('devices'), automations: n('automations') };
  } finally { db.close(); }
};

function readRaw() {
  if (store.db) {
    const kv = store.db.prepare('SELECT k,v FROM kv').all();
    if (kv.length) {
      const j = {};
      for (const { k, v } of kv) { if (k.startsWith('x:')) continue; try { j[k] = JSON.parse(v); } catch { /* ignorieren */ } }
      for (const t of ROWS) {
        j[t] = store.db.prepare(`SELECT json FROM ${t} ORDER BY pos`).all().map((r) => JSON.parse(r.json));
        j[t].forEach((it, i) => cache.set(`${t}:${it.id}`, i + '|' + JSON.stringify(it)));
      }
      for (const [k, v] of Object.entries(j)) if (!ROWS.includes(k)) cache.set('kv:' + k, JSON.stringify(v));
      return { j, migrated: false };
    }
  }
  try { return { j: JSON.parse(fs.readFileSync(FILE, 'utf8')), migrated: !!store.db }; } catch (e) {
    if (e.code !== 'ENOENT') console.error('Konfiguration konnte nicht gelesen werden:', e.message);
    return { j: null, migrated: false };
  }
}

store.load = () => {
  const d = defaults();
  openDb();
  const { j, migrated } = readRaw();
  if (j) {
    store.cfg = {
      ...d, ...j,
      mqtt: { ...d.mqtt, ...j.mqtt },
      auth: { ...d.auth, ...j.auth },
      notify: { ...d.notify, ...j.notify },
      heating: { ...d.heating, ...j.heating },
      car: { ...d.car, ...j.car },
      ...(j.tuya ? { tuya: j.tuya } : {}),   // nur zur einmaligen Übernahme ins Plugin (lib/migrate_tuya.js)
      update: { ...d.update, ...j.update },
      dash: { ...d.dash, ...j.dash },
      ecowitt: { ...d.ecowitt, ...j.ecowitt },
      matter: { ...d.matter, ...j.matter },
      appletv: { ...d.appletv, ...j.appletv },
      coiot: { ...d.coiot, ...j.coiot },
      plugins: j.plugins && typeof j.plugins === 'object' ? j.plugins : {},
      modules: j.modules || null,
      dewIgnore: j.dewIgnore || [],
      broker: { ...d.broker, ...j.broker },
      mcp: { ...d.mcp, ...j.mcp },
      findmy: { ...d.findmy, ...j.findmy },
      energy: { ...d.energy, ...j.energy, victron: { ...d.energy.victron, ...(j.energy || {}).victron } },
      backup: { ...d.backup, ...j.backup },
      geofence: { ...d.geofence, ...j.geofence },
    };
  } else store.cfg = d;
  if (migrated) {
    store.save();
    try { fs.renameSync(FILE, FILE + '.migrated'); } catch { /* ignorieren */ }
    console.log('  Konfiguration aus config.json in die SQLite-Datenbank homelite.db übernommen (Original: config.json.migrated).');
  }
  if (!store.cfg.auth.hash) {
    const pw = crypto.randomBytes(5).toString('hex');
    store.setPassword(pw);
    store.save();
    console.log('\n  Erstes Login-Passwort: ' + pw + '  (in den Einstellungen änderbar)\n');
  }
};

store.id = () => crypto.randomBytes(4).toString('hex');

module.exports = store;
