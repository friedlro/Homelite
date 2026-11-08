'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const Devices = require('./lib/devices');
const Presence = require('./lib/presence');
const Car = require('./lib/car');
const createHeating = require('./lib/heating');
const createEngine = require('./lib/engine');
const AppleTV = require('./lib/appletv');

const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || '0.0.0.0';
const PUB = path.join(__dirname, 'public');

store.load();
const cfg = () => store.cfg;

// ---------- Log + SSE ----------
const logs = [];
const clients = new Set();
function sse(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const r of clients) r.write(data);
}
function log(level, msg) {
  const e = { ts: Date.now(), level, msg };
  logs.push(e);
  if (logs.length > 300) logs.shift();
  if (level !== 'debug') console.log(`[${new Date(e.ts).toLocaleTimeString('de-AT')}] ${level.toUpperCase()} ${msg}`);
  sse({ t: 'log', e });
}

// ---------- Reparatur: ungültiges Z2M-Basis-Topic (z. B. "#") ----------
function repairMqttBase() {
  const c = cfg();
  let changed = false;
  if (!c.mqtt.z2mBase || /[#+]/.test(c.mqtt.z2mBase)) { c.mqtt.z2mBase = 'zigbee2mqtt'; changed = true; }
  const fix = (t) => (typeof t === 'string' && /^[#+]\//.test(t) ? c.mqtt.z2mBase + t.slice(1) : t);
  for (const d of c.devices) {
    if (Array.isArray(d.stateTopics)) d.stateTopics = d.stateTopics.map((t) => { const n = fix(t); if (n !== t) changed = true; return n; });
    for (const o of [d.get, d.cmd]) {
      if (!o) continue;
      for (const k of ['topic', 'brightnessTopic']) if (o[k]) { const n = fix(o[k]); if (n !== o[k]) { o[k] = n; changed = true; } }
    }
  }
  if (changed) { store.save(); console.log('MQTT: ungültiges Basis-Topic repariert → zigbee2mqtt'); }
}
repairMqttBase();
require('./lib/migrate_tuya')({ store, log: (l, m) => console.log(`[${l}] ${m}`), root: __dirname });

// ---------- Module ----------
const devices = new Devices(store, log);
const presence = new Presence(store, log);
const car = new Car(store, log);
const heating = createHeating({ store, devices, presence, log });

async function notify(title, message) {
  const n = cfg().notify;
  if (!n.topic) throw new Error('ntfy-Topic nicht konfiguriert');
  const r = await fetch(String(n.url || 'https://ntfy.sh').replace(/\/+$/, ''), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ topic: n.topic, title: title || 'HomeLite', message: message || '' }),
  });
  if (!r.ok) throw new Error('ntfy HTTP ' + r.status);
}

const engine = createEngine({ store, devices, presence, heating, car, notify, log });
const createHistory = require('./lib/history');
const history = createHistory({ store, devices, sse });
devices.history = history;
const importer = require('./lib/importer')({ store, devices, log });
const updater = require('./lib/updater')({ store, log, notify: (t, m) => notify(t, m) });
const plugins = require('./lib/plugins')({ store, devices, engine, sse, log, notify, coreVersion: () => updater.version(), getMcp: () => mcp });
devices.plugins = plugins;
const createEnergy = require('./lib/energy');
const victronTemplate = require('./lib/victron').template;
const ecowitt = require('./lib/ecowitt')({ store, devices, log, onStatus: () => sse({ t: 'ecowitt', ecowitt: ecowitt.status() }) });
const matter = new (require('./lib/matter'))({ store, devices, log });
devices.matter = matter;
const appletv = new (require('./lib/appletv'))({ store, devices, log });
const findmy = new (require('./lib/findmy'))({ store, presence, log });
const shellyFw = new (require('./lib/shellyfw'))({ devices, log });
const coiot = new (require('./lib/coiot'))({ store, devices, log });
coiot.on('change', () => sse({ t: 'coiot', coiot: coiot.snapshot() }));
shellyFw.on('change', () => sse({ t: 'shellyfw', shellyfw: shellyFw.snapshot() }));
appletv.on('status', () => sse({ t: 'appletv', appletv: appletv.snapshot() }));
findmy.on('status', () => sse({ t: 'findmy', findmy: findmy.snapshot() }));
const energy = createEnergy({ store, devices, log, sse });
const dew = require('./lib/dew')({ store, devices, log, enabled: () => on('dew') });
let dewTimer = null;
const dewSoon = () => { clearTimeout(dewTimer); dewTimer = setTimeout(() => { dewTimer = null; try { dew.sync(); } catch (e) { log('error', 'Taupunkt: ' + e.message); } }, 1500); };
{ const origSave = store.save; store.save = (...a) => { const r = origSave.apply(store, a); dewSoon(); return r; }; }
const broker = new (require('./lib/broker'))({ store, log });
let brokerTimer = null;
const brokerPush = () => { if (brokerTimer) return; brokerTimer = setTimeout(() => { brokerTimer = null; sse({ t: 'broker', broker: broker.snapshot() }); }, 1500); };
broker.on('status', brokerPush);
setInterval(() => { if (broker.server) brokerPush(); }, 5000);
const mcp = require('./lib/mcp')({ store, devices, engine, presence, energy, heating, car, logs, version: () => updater.version(), log, pluginEndpoint: (id) => plugins.mcpToken(id),
  saveAutomation: (body, id) => { const old = id ? cfg().automations.find((x) => x.id === id) : null; const a = cleanAutomation(body, old || {}); if (old) cfg().automations[cfg().automations.indexOf(old)] = a; else cfg().automations.push(a); store.save(); return a; } });
const victron = require('./lib/victron')({ store, devices, log, onStatus: () => sse({ t: 'victron', victron: victron.status() }) });
const backup = require('./lib/backup')({ store, log, notify, version: updater.version });

// ---------- Erweiterungen (Module) ein-/ausschaltbar ----------
const MODULES = {
  energy: ['⚡ Energie & Victron', 'Energie-Dashboard (PV, Netz, Batterie, Verbrauch) mit Victron-Anbindung'],
  heating: ['🌡 Heizung', 'Raumregelung mit Zeitplänen und Frostschutz'],
  car: ['🚗 Leapmotor-Auto', 'Ladestand, Reichweite, Fernbefehle'],
  ecowitt: ['🌤 Wetterstation Ecowitt', 'GW1100 & Co. per WLAN abfragen'],
  matter: ['🧩 Matter', 'Matter-Geräte (z. B. SwitchBot-Schloss) als Controller einbinden'],
  appletv: ['📺 Apple TV (Status)', 'Standby, App und Titel als Sensoren (pyatv)'],
  geo: ['📍 Anwesenheit / Geofence', 'Personen, Zonen und Betreten/Verlassen-Auslöser'],
  dew: ['💧 Taupunkt-Sensoren', 'Legt zu jedem Temperatur-/Feuchte-Paar automatisch einen berechneten Taupunkt-Sensor an'],
  broker: ['📡 Eingebauter MQTT-Broker', 'Eigener MQTT-Server in HomeLite (Port 1883) – Zigbee2MQTT, Shelly, Tasmota verbinden sich direkt, kein Mosquitto nötig'],
  mcp: ['🤖 KI-Zugriff (MCP)', 'Claude kann HomeLite abfragen und steuern (MCP-Server unter /mcp)'],
  where: ['🗺️ „Wo ist?“ (Karte, iCloud)', 'Karte mit Positionen, iCloud Find My, Handy-Seite'],
};
const on = (id) => !!(store.cfg.modules && store.cfg.modules[id]);
(function initModules() {
  const c = store.cfg;
  if (c.modules && c.modules.dew === undefined) c.modules.dew = true; // Updates: Taupunkt-Sensoren standardmäßig an
  if (c.modules && typeof c.modules === 'object') return;
  const e = c.energy;
  const used = {
    energy: !!(e.pv.length || e.grid.length || e.battery.length || e.house.length || e.soc || e.victron.host),
    heating: c.heating.rooms.length > 0, car: !!c.car.enabled, ecowitt: !!c.ecowitt.ip, matter: !!c.matter.enabled,
    mcp: false, broker: false, dew: true, appletv: c.appletv.devices.length > 0, geo: c.geofence.persons.length > 0 || c.geofence.zones.some((z) => z.lat != null), where: !!c.findmy.enabled,
  };
  c.modules = Object.fromEntries(Object.keys(MODULES).map((k) => [k, !!used[k]]));
  store.save();
})();

let heatTimer = null;
function runHeating() {
  clearTimeout(heatTimer);
  if (!on('heating')) return;
  heatTimer = setTimeout(() => { heating.tick(); sse({ t: 'heating', heating: heating.status() }); }, 400);
}

devices.on('state', (dev, st, prev, force) => {
  sse({ t: 'state', id: dev.id, st });
  if (dew) dew.onState(dev);
  if (cfg().energy.grid.includes(dev.id)) energy.noteGrid();
  history.onState(dev, st, prev, force);
  plugins.onDeviceState(dev, st, prev);
  engine.onDeviceState(dev, st, prev, force);
  runHeating();
});
devices.on('status', () => sse({ t: 'mqtt', mqtt: mqttInfo(), discovery: devices.discovery() }));
presence.on('event', (e) => { engine.onGeo(e); runHeating(); });
presence.on('change', () => sse({ t: 'presence', presence: presence.snapshot() }));
car.on('status', () => sse({ t: 'car', car: car.snapshot() }));

const mqttInfo = () => ({ ok: devices.mqttOk, error: devices.mqttError, configured: !!cfg().mqtt.url });

// ---------- Hilfen ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const str = (v, max = 200) => String(v ?? '').slice(0, max);
const num = (v, d) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? d : Number(v));
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const strMap = (o) => (isObj(o) ? Object.fromEntries(Object.entries(o).slice(0, 20).map(([k, v]) => [str(k, 60), str(v, 500)])) : undefined);

const DRIVERS = ['mqtt', 'shelly', 'virtual', 'http', 'victron', 'ecowitt', 'matter', 'appletv', 'dew', 'plugin'];

function cleanDevice(d, old = {}) {
  if (!isObj(d)) throw bad('Ungültiges Gerät');
  const type = Devices.TYPES.includes(d.type) ? d.type : old.type;
  if (!type) throw bad('Gerätetyp fehlt');
  const driver = DRIVERS.includes(d.driver) ? d.driver : old.driver;
  if (!driver) throw bad('Treiber fehlt');
  const out = {
    id: old.id || store.id(), name: str(d.name ?? old.name, 80) || 'Gerät', room: str(d.room ?? old.room, 60),
    fav: d.fav !== undefined ? !!d.fav : !!old.fav, type, driver, src: str(d.src ?? old.src, 200),
  };
  if (d.hide !== undefined ? d.hide : old.hide) out.hide = true;
  const note = str(d.note ?? old.note, 300);
  if (note) out.note = note;
  const pending = d.pending !== undefined ? !!d.pending : !!old.pending;
  if (pending) out.pending = true;
  const tas = d.tasmota ?? old.tasmota;
  if (isObj(tas) && tas.mac) out.tasmota = { mac: str(tas.mac, 20).toUpperCase(), relay: Math.max(1, Math.floor(num(tas.relay, 1))) };
  if (driver === 'mqtt') {
    const topics = Array.isArray(d.stateTopics) ? d.stateTopics : old.stateTopics || [];
    out.stateTopics = topics.map((t) => str(t, 300)).filter(Boolean).slice(0, 5);
    out.paths = strMap(d.paths ?? old.paths) || {};
    out.cmd = strMap(d.cmd ?? old.cmd) || {};
    const g = d.get ?? old.get;
    if (isObj(g) && g.topic) out.get = { topic: str(g.topic, 300), payload: str(g.payload, 300) };
    out.onValue = str(d.onValue ?? old.onValue, 40);
    out.unit = str(d.unit ?? old.unit, 12);
    out.brightnessMax = num(d.brightnessMax ?? old.brightnessMax, 100);
  } else if (driver === 'shelly') {
    const ip = str(d.ip ?? old.ip, 100);
    if (ip && !/^[\w.:-]+$/.test(ip)) throw bad('Ungültige IP/Hostname');
    out.ip = ip;
    { const g = Number(d.gen ?? old.gen); out.gen = g === 2 ? 2 : g === 0 ? 0 : 1; }
    out.channel = Math.max(0, Math.floor(num(d.channel ?? old.channel, 0)));
    out.user = str(d.user ?? old.user, 60);
    out.pass = d.pass === undefined ? old.pass || '' : str(d.pass, 100);
  } else if (driver === 'matter') {
    const mt = isObj(d.matter) ? d.matter : old.matter || {};
    out.matter = { peer: str(mt.peer, 40), endpoint: Math.max(0, Math.floor(num(mt.endpoint, 0))), kind: str(mt.kind, 20) };
    out.unit = str(d.unit ?? old.unit, 12);
  } else if (driver === 'dew') {
    out.dewT = str(d.dewT ?? old.dewT, 40);
    out.dewH = str(d.dewH ?? old.dewH, 40);
    out.unit = '°C';
  } else if (driver === 'plugin') {
    out.plugin = str(d.plugin ?? old.plugin, 60);
    out.key = str(d.key ?? old.key, 80);
    out.unit = str(d.unit ?? old.unit, 12);
  } else if (driver === 'appletv') {
    out.atvId = str(d.atvId ?? old.atvId, 120);
    out.akey = str(d.akey ?? old.akey, 20);
  } else if (driver === 'ecowitt') {
    out.ekey = str(d.ekey ?? old.ekey, 80);
    out.unit = str(d.unit ?? old.unit, 12);
  } else if (driver === 'victron') {
    out.vtopic = str(d.vtopic ?? old.vtopic, 300);
    out.unit = str(d.unit ?? old.unit, 12);
  } else if (driver === 'http') {
    const url = str(d.url ?? old.url, 500);
    if (url && !/^https?:\/\//i.test(url)) throw bad('URL muss mit http(s):// beginnen');
    out.url = url;
    out.jsonPath = str(d.jsonPath ?? old.jsonPath, 200);
    out.scale = num(d.scale ?? old.scale, 1);
    out.interval = Math.max(10, num(d.interval ?? old.interval, 60));
    out.unit = str(d.unit ?? old.unit, 12);
  } else {
    out.value = d.value !== undefined ? !!d.value : !!old.value;
  }
  return out;
}

const list = (a, max = 50) => (Array.isArray(a) ? a.filter((x) => isObj(x) && typeof x.type === 'string').slice(0, max) : []);

function cleanAutomation(a, old = {}) {
  if (!isObj(a)) throw bad('Ungültige Automation');
  return {
    id: old.id || store.id(), name: str(a.name ?? old.name, 100) || 'Automation',
    enabled: a.enabled !== undefined ? !!a.enabled : old.enabled !== false,
    dash: a.dash !== undefined ? !!a.dash : !!old.dash,
    triggers: list(a.triggers ?? old.triggers), conditions: list(a.conditions ?? old.conditions), actions: list(a.actions ?? old.actions, 80),
    mode: ['single', 'restart', 'queued'].includes(a.mode) ? a.mode : old.mode || 'single',
    silent: a.silent !== undefined ? !!a.silent : !!old.silent,
    desc: str(a.desc ?? old.desc, 600),
    src: str(a.src ?? old.src, 100),
  };
}

function cleanRoom(r, old) {
  if (!isObj(r)) throw bad('Ungültiger Heizraum');
  return {
    id: (old && old.id) || r.id || store.id(), name: str(r.name, 60) || 'Raum', device: str(r.device, 20), sensor: str(r.sensor, 20),
    comfort: num(r.comfort, 21), eco: num(r.eco, 17), awayEco: r.awayEco !== false,
    schedule: (Array.isArray(r.schedule) ? r.schedule : []).slice(0, 20).map((s) => ({
      days: (Array.isArray(s.days) ? s.days : []).map(Number).filter((n) => n >= 0 && n <= 6),
      from: str(s.from, 5) || '06:00', to: str(s.to, 5) || '22:00',
    })),
    ...(old && old.boost ? { boost: old.boost } : {}),
  };
}

const norm = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
// Alphabetisch (deutsch, Zahlen natürlich: „Lampe 2“ vor „Lampe 10“)
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(String(a.name || ''), String(b.name || '')) || String(a.id).localeCompare(String(b.id));

function model() {
  const c = cfg();
  return {
    devices: c.devices.map((d) => ({ ...d, pass: undefined, hasPass: !!d.pass, pending: devices.isPending(d) })).sort(byName), rooms: c.rooms,
    automations: c.automations.map((a) => ({ ...a, lastRun: engine.lastRun.get(a.id) || null })).sort(byName),
    mqtt: { ...mqttInfo(), url: c.mqtt.url, user: c.mqtt.user, hasPass: !!c.mqtt.pass, z2mBase: c.mqtt.z2mBase, tasmotaGroup: c.mqtt.tasmotaGroup },
    notify: c.notify,
    heating: { ...heating.status(), config: c.heating.rooms },
    car: {
      ...car.snapshot(),
      config: { enabled: !!c.car.enabled, name: c.car.name, username: c.car.username, hasPassword: !!c.car.password, hasPin: !!c.car.pin, certPath: c.car.certPath, keyPath: c.car.keyPath, vin: c.car.vin, pollMinutes: c.car.pollMinutes },
      commands: Car.COMMANDS,
    },
    version: updater.version(), updateInfo: updater.status(),
    dash: c.dash.blocks,
    energyCfg: { ...c.energy, victron: { ...c.energy.victron, pass: undefined, hasPass: !!c.energy.victron.pass } }, energy: energy.live(), victron: victron.status(),
    mcp: { token: c.mcp.token, allowControl: c.mcp.allowControl, allowUnlock: c.mcp.allowUnlock, allowAutomations: c.mcp.allowAutomations },
    broker: broker.snapshot(),
    matter: matter.status(), shellyfw: shellyFw.snapshot(), coiot: coiot.snapshot(), plugins: plugins.snapshot(),
    modules: c.modules, moduleInfo: Object.fromEntries(Object.entries(MODULES).map(([k, v]) => [k, { label: v[0], desc: v[1] }])),
    appletv: appletv.snapshot(), findmy: findmy.snapshot(),
    ecowitt: { ...ecowitt.status(), ip: c.ecowitt.ip, interval: c.ecowitt.interval },
    geofence: { key: c.geofence.key, persons: c.geofence.persons, zones: c.geofence.zones },
    presence: presence.snapshot(), states: devices.snapshot(), discovery: devices.discovery(), types: Devices.TYPES,
  };
}

// ---------- Auth ----------
const sign = (exp) => `${exp}.${crypto.createHmac('sha256', cfg().auth.secret).update(String(exp)).digest('hex')}`;
function isAuthed(req) {
  const m = /(?:^|;\s*)hl=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp] = m[1].split('.');
  if (!exp || Number(exp) < Date.now()) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const fails = new Map();
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---------- Body ----------
function readRaw(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new HttpError(413, 'Zu groß')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new HttpError(413, 'Zu groß')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s.trim()) return resolve({});
      const ct = req.headers['content-type'] || '';
      try {
        if (ct.includes('application/x-www-form-urlencoded')) resolve(Object.fromEntries(new URLSearchParams(s)));
        else resolve(JSON.parse(s));
      } catch { reject(bad('Ungültiger Body')); }
    });
    req.on('error', reject);
  });
}

// ---------- Geofence-Hook (öffentlich, per Schlüssel) ----------
const toEvent = (v) => {
  const s = String(v).toLowerCase();
  if (['enter', 'arrive', 'in', '1', 'true', 'ankunft', 'betreten'].includes(s)) return 'enter';
  if (['leave', 'exit', 'out', '0', 'false', 'verlassen'].includes(s)) return 'leave';
  return null;
};

const hookMeta = (b) => ({
  ts: b.tst ? Number(b.tst) * 1000 : b.ts ? Number(b.ts) : 0,
  acc: b.acc ?? b.accuracy ?? b.horizontalAccuracy,
  battery: b.batt ?? b.battery,
  src: b.src ? str(b.src, 20) : b._type ? 'OwnTracks' : 'iPhone',
});

async function hook(req, res, url) {
  if (!on('geo') && !on('where')) throw new HttpError(403, 'Erweiterung Anwesenheit/Karte ist ausgeschaltet');
  const key = url.searchParams.get('key') || req.headers['x-key'] || '';
  if (!safeEq(key, cfg().geofence.key)) throw new HttpError(401, 'Schlüssel ungültig');
  const body = req.method === 'GET' ? {} : await readBody(req);
  const b = { ...Object.fromEntries(url.searchParams), ...(isObj(body) ? body : {}) };
  const person = b.person || b.tid || b.device;
  if (!person) throw bad('person fehlt');
  if (b._type === 'transition') {
    const ev = toEvent(b.event);
    if (ev && b.desc) presence.transition(person, b.desc, ev);
  } else if (b._type === 'location') {
    presence.location(person, b.lat, b.lon, hookMeta(b));
  } else if (b._type) {
    // andere OwnTracks-Nachrichten ignorieren
  } else if (b.entry !== undefined && b.name) {
    const ev = toEvent(b.entry);
    if (ev) presence.transition(person, b.name, ev);
  } else if (b.event && b.zone) {
    const ev = toEvent(b.event);
    if (!ev) throw bad('event: enter oder leave');
    presence.transition(person, b.zone, ev);
  } else if (b.lat !== undefined && b.lon !== undefined) {
    presence.location(person, b.lat, b.lon, hookMeta(b));
  } else throw bad('Unbekanntes Format');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('[]');
}

// ---------- Webhook-Auslöser (öffentlich, per Schlüssel) ----------
async function trigger(req, res, url) {
  const key = url.searchParams.get('key') || req.headers['x-key'] || '';
  if (!safeEq(key, cfg().geofence.key)) throw new HttpError(401, 'Schlüssel ungültig');
  const name = str(url.searchParams.get('name'), 60);
  if (!name) throw bad('name fehlt');
  const n = engine.webhook(name);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, triggered: n }));
}

// ---------- API ----------
const routes = [];
const route = (method, re, fn) => routes.push([method, new RegExp(`^${re}$`), fn]);

route('GET', '/api/bootstrap', () => model());
route('GET', '/api/log', () => logs.slice(-200));
route('GET', '/api/history', ({ url }) => {
  const q = url.searchParams;
  return { items: history.query({ dev: q.get('dev') || '', k: q.get('k') || '', before: Number(q.get('before')) || 0, limit: q.get('limit'), q: q.get('q') || '' }), total: history.count() };
});
route('DELETE', '/api/history', () => { history.clear(); return { ok: true }; });

route('PUT', '/api/mqtt', ({ body }) => {
  const m = cfg().mqtt;
  m.url = str(body.url, 200);
  m.user = str(body.user, 100);
  if (body.pass) m.pass = str(body.pass, 200);
  if (body.clearPass) m.pass = '';
  m.z2mBase = str(body.z2mBase, 100).trim().replace(/^\/+|\/+$/g, '') || 'zigbee2mqtt';
  if (/[#+]/.test(m.z2mBase)) throw bad('Basis-Topic darf keine Platzhalter (# oder +) enthalten – normalerweise „zigbee2mqtt“');
  m.tasmotaGroup = str(body.tasmotaGroup, 60) || 'tasmotas';
  store.save();
  devices.z2m = [];
  devices.tasmota.clear();
  devices.start();
  return { ok: true };
});

route('PUT', '/api/notify', ({ body }) => {
  cfg().notify = { url: str(body.url, 200) || 'https://ntfy.sh', topic: str(body.topic, 100) };
  store.save();
  return { ok: true };
});
route('POST', '/api/notify/test', async () => { await notify('HomeLite', 'Testnachricht ✔'); return { ok: true }; });

route('PUT', '/api/rooms', ({ body }) => {
  if (!Array.isArray(body.rooms)) throw bad('rooms fehlt');
  cfg().rooms = [...new Set(body.rooms.map((r) => str(r, 60).trim()).filter(Boolean))].slice(0, 40);
  store.save();
  return { ok: true };
});

route('PUT', '/api/password', ({ body }) => {
  if (!store.checkPassword(body.current || '')) throw new HttpError(403, 'Aktuelles Passwort falsch');
  if (String(body.password || '').length < 6) throw bad('Mindestens 6 Zeichen');
  store.setPassword(body.password);
  cfg().auth.secret = crypto.randomBytes(32).toString('hex');
  store.save();
  return { ok: true, relogin: true };
});

// Geräte
route('POST', '/api/mqtt/peek', async ({ body }) => {
  try { return { messages: await devices.peek(str(body.topic, 300).trim(), num(body.seconds, 20)) }; } catch (e) { throw bad(e.message); }
});
route('GET', '/api/discovery', () => devices.discovery());
route('POST', '/api/discovery/scan', () => { devices.requestStates(); return { ok: true }; });
// Plugins (ohne Systemupdate nachinstallierbar)
route('GET', '/api/plugins', () => plugins.snapshot());
route('POST', '/api/plugins/upload', async ({ body }) => plugins.install(Buffer.from(String(body.data || ''), 'base64')));
route('POST', '/api/plugins/url', async ({ body }) => plugins.fromUrl(str(body.url, 500)));
route('PUT', '/api/plugins/([a-z0-9-]+)', async ({ params, body }) => {
  if (isObj(body.config)) plugins.setConfig(params[0], body.config);
  if (body.enabled !== undefined) await plugins.setEnabled(params[0], !!body.enabled);
  if (body.menu !== undefined) plugins.setMenu(params[0], !!body.menu);
  return { ok: true };
});
route('DELETE', '/api/plugins/([a-z0-9-]+)', async ({ params }) => { await plugins.remove(params[0]); return { ok: true }; });
for (const M of ['GET', 'POST', 'PUT', 'DELETE']) {
  route(M, '/api/plugins/([a-z0-9-]+)/x/(.*)', async ({ params, body, url, req }) => plugins.handle(params[0], M, params[1], { body, url, req }));
}

route('PUT', '/api/coiot', ({ body }) => {
  const c = cfg().coiot;
  if (body.enabled !== undefined) c.enabled = !!body.enabled;
  if (body.port !== undefined) c.port = Math.min(Math.max(num(body.port, 5683), 1024), 65535);
  if (body.host !== undefined) { const h = str(body.host, 100).trim(); if (h && !/^[\w.\-]+$/.test(h)) throw bad('Ungültige Adresse'); c.host = h; }
  store.save();
  coiot.start();
  return coiot.snapshot();
});
route('POST', '/api/coiot/read', async () => { await coiot.readAll(); return coiot.snapshot(); });
route('POST', '/api/coiot/setup', async ({ body }) => {
  const ips = body.all ? coiot.snapshot().devices.filter((x) => x.gen !== 2).map((x) => x.ip) : [str(body.ip, 100)];
  const errs = [];
  let n = 0;
  for (const ip of ips) { try { await coiot.setup(ip); n++; } catch (e) { errs.push(`${ip}: ${e.message}`); } }
  if (!n && errs.length) throw bad(errs.join(' · '));
  return { ok: true, done: n, errors: errs };
});
route('POST', '/api/shelly/fw/check', async ({ body }) => {
  if (body.ip) await shellyFw.check(str(body.ip, 100)); else shellyFw.checkAll().catch(() => {});
  return { ok: true };
});
route('POST', '/api/shelly/fw/update', async ({ body }) => {
  const ips = body.all ? shellyFw.snapshot().filter((x) => x.state === 'available').map((x) => x.ip) : [str(body.ip, 100)];
  const errs = [];
  for (const ip of ips) { try { await shellyFw.update(ip); } catch (e) { errs.push(`${ip}: ${e.message}`); } }
  if (errs.length && errs.length === ips.length) throw bad(errs.join('; '));
  return { ok: true, started: ips.length - errs.length, errors: errs };
});
route('POST', '/api/shelly/probe', async ({ body }) => {
  const ip = str(body.ip, 100);
  if (!/^[\w.:-]+$/.test(ip)) throw bad('Ungültige IP');
  try { return { items: await devices.probeShelly(ip, str(body.user, 60), str(body.pass, 100)) }; } catch (e) { throw bad('Shelly nicht erreichbar: ' + e.message + ' – Batteriegeräte (Motion, Tür/Fenster, …) schlafen: Reset-Taste kurz drücken und sofort erneut suchen, oder unten per MQTT-ID einbinden.'); }
});

route('POST', '/api/shelly/motion', ({ body }) => {
  let id = str(body.id, 80).trim();
  if (/^[0-9a-fA-F]{12}$/.test(id)) id = 'shellymotion2-' + id.toUpperCase();
  if (!/^[\w-]+$/.test(id)) throw bad('Ungültige Geräte-ID (z. B. shellymotion2-AABBCCDDEEFF oder nur die 12-stellige MAC)');
  const added = [];
  for (const it of Devices.shellyMotionItems(id)) {
    if (cfg().devices.some((d) => d.src === it.key)) continue;
    const { key, ...raw } = it;
    const d = cleanDevice({ ...raw, src: key, room: str(body.room, 60) });
    cfg().devices.push(d);
    added.push(d);
  }
  store.save();
  devices.rebuild();
  return { added };
});

route('POST', '/api/devices', ({ body }) => {
  const items = Array.isArray(body.items) ? body.items : [body];
  const added = [];
  for (const it of items.slice(0, 100)) {
    if (it.src && cfg().devices.some((d) => d.src === it.src)) continue;
    const d = cleanDevice(it);
    cfg().devices.push(d);
    added.push(d);
  }
  store.save();
  devices.rebuild();
  devices.requestStates();
  return { added };
});
route('PUT', '/api/devices/(\\w+)', ({ params, body }) => {
  const i = cfg().devices.findIndex((d) => d.id === params[0]);
  if (i < 0) throw new HttpError(404, 'Nicht gefunden');
  cfg().devices[i] = cleanDevice(body, cfg().devices[i]);
  store.save();
  devices.rebuild();
  return cfg().devices[i];
});
route('DELETE', '/api/devices/(\\w+)', ({ params }) => {
  const c = cfg();
  const gone = c.devices.find((d) => d.id === params[0]);
  if (gone && gone.driver === 'dew') c.dewIgnore = [...new Set([...(c.dewIgnore || []), gone.dewT + '|' + gone.dewH])]; // nicht automatisch neu anlegen
  c.devices = c.devices.filter((d) => d.id !== params[0]);
  devices.states.delete(params[0]);
  store.save();
  devices.rebuild();
  return { ok: true };
});
route('POST', '/api/devices/(\\w+)/action', async ({ params, body, req }) => {
  const d = devices.byId(params[0]);
  if (!d) throw new HttpError(404, 'Nicht gefunden');
  try { await devices.control(d, str(body.action, 20), body.value, { k: 'ui', w: createHistory.clientName(req.headers['user-agent']) }); } catch (e) { throw bad(e.message); }
  return { ok: true };
});

// Automationen
route('POST', '/api/automations', ({ body }) => {
  const a = cleanAutomation(body);
  cfg().automations.push(a);
  store.save();
  return a;
});
route('PUT', '/api/automations/(\\w+)', ({ params, body }) => {
  const i = cfg().automations.findIndex((a) => a.id === params[0]);
  if (i < 0) throw new HttpError(404, 'Nicht gefunden');
  cfg().automations[i] = cleanAutomation(body, cfg().automations[i]);
  store.save();
  return cfg().automations[i];
});
route('DELETE', '/api/automations/(\\w+)', ({ params }) => {
  cfg().automations = cfg().automations.filter((a) => a.id !== params[0]);
  store.save();
  return { ok: true };
});
route('POST', '/api/automations/(\\w+)/run', async ({ params }) => {
  try { await engine.run(params[0]); } catch (e) { throw bad(e.message); }
  return { ok: true };
});


// Dashboard-Layout
const DASH_KINDS = ['scenes', 'presence', 'car', 'heating', 'energy', 'weather', 'favs', 'room', 'rest', 'device'];
route('PUT', '/api/dash', ({ body }) => {
  if (body.blocks === null) { cfg().dash.blocks = null; store.save(); return { ok: true }; }
  if (!Array.isArray(body.blocks) || body.blocks.length > 150) throw bad('Ungültiges Layout');
  cfg().dash.blocks = body.blocks.map((b) => {
    if (!isObj(b) || !DASH_KINDS.includes(b.kind)) throw bad('Ungültiger Block');
    return { id: str(b.id, 30) || store.id(), kind: b.kind, ref: str(b.ref, 80) };
  });
  store.save();
  return { ok: true };
});

// Energie
route('GET', '/api/energy', ({ url }) => energy.status(['7', '30'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : 'today'));
route('GET', '/api/energy/peaks', ({ url }) => {
  const span = Number(url.searchParams.get('span')) || 0;
  const back = Math.max(0, Math.min(30, Math.floor(Number(url.searchParams.get('back')) || 0)));
  return energy.peaksView(back, span >= 2 ? Math.min(span, 30) : 0);
});
route('PUT', '/api/energy/config', ({ body }) => {
  const c = cfg().energy;
  const ids = (a) => (Array.isArray(a) ? a.filter((x) => cfg().devices.some((d) => d.id === x)).slice(0, 30) : []);
  c.pv = ids(body.pv); c.grid = ids(body.grid); c.battery = ids(body.battery); c.house = ids(body.house); c.consumers = ids(body.consumers);
  c.gridInvert = !!body.gridInvert; c.batteryInvert = !!body.batteryInvert;
  if (body.peakLimit !== undefined) { const v = Number(body.peakLimit); c.peakLimit = isFinite(v) && v > 0 ? Math.min(Math.round(v * 100) / 100, 1000) : 0; }
  c.soc = cfg().devices.some((d) => d.id === body.soc) ? body.soc : '';
  if (isObj(body.victron)) c.victron.keepalive = !!body.victron.keepalive;
  store.save();
  energy.tick();
  return { ok: true };
});
route('POST', '/api/energy/victron/discover', async ({ body }) => {
  const v = cfg().energy.victron;
  try { return { ids: await victron.discover({ host: str(body.host, 200), port: num(body.port, 1883), user: str(body.user, 100), pass: body.pass === undefined || body.pass === '' ? v.pass : str(body.pass, 200) }) }; } catch (e) { throw bad(e.message); }
});
route('POST', '/api/energy/victron', ({ body }) => {
  const portalId = str(body.portalId, 40).trim();
  if (!/^[\w-]+$/.test(portalId)) throw bad('Portal-ID ungültig (z. B. c0619ab12345 – mit „Suchen“ automatisch ermitteln)');
  const host = str(body.host, 200).trim();
  if (!host || !/^[\w.:/@-]+$/.test(host)) throw bad('Adresse des Cerbo GX fehlt oder ist ungültig (z. B. 192.168.1.50)');
  const phases = Math.max(1, Math.min(3, Math.floor(num(body.phases, 3))));
  const c = cfg().energy;
  const old = c.victron;
  c.victron = {
    host, port: Math.max(1, Math.min(65535, Math.floor(num(body.port, 1883)))), user: str(body.user, 100),
    pass: body.pass === undefined || body.pass === '' ? old.pass : str(body.pass, 200),
    portalId, base: 'N', phases, keepalive: body.keepalive !== false,
  };
  const tpl = victronTemplate(portalId, 'N', phases);
  const roles = { pv: [], grid: [], battery: [], house: [], soc: '' };
  for (const t of tpl) {
    const { role, key, ...raw } = t;
    const i = cfg().devices.findIndex((x) => x.src === key);
    let d;
    if (i >= 0) { d = cleanDevice({ ...raw, driver: 'victron', src: key }, { id: cfg().devices[i].id }); cfg().devices[i] = d; } else { d = cleanDevice({ ...raw, src: key }); cfg().devices.push(d); }
    if (role === 'soc') roles.soc = d.id; else roles[role].push(d.id);
  }
  Object.assign(c, { pv: roles.pv, grid: roles.grid, battery: roles.battery, house: roles.house, soc: roles.soc });
  store.save();
  devices.rebuild();
  if (on('energy')) victron.start();
  return { ok: true, devices: tpl.length };
});


// Ecowitt-Wetterstation
route('POST', '/api/ecowitt/test', async ({ body }) => {
  const ip = str(body.ip, 100).trim();
  if (!/^[\w.:-]+$/.test(ip)) throw bad('Ungültige IP-Adresse');
  try {
    const j = await ecowitt.fetchRaw(ip);
    return { items: ecowitt.readings(j), raw: j };
  } catch (e) { throw bad('Gateway nicht erreichbar: ' + ((e.cause && e.cause.code) || e.message)); }
});
route('POST', '/api/ecowitt', async ({ body }) => {
  const ip = str(body.ip, 100).trim();
  if (!/^[\w.:-]+$/.test(ip)) throw bad('Ungültige IP-Adresse');
  let j;
  try { j = await ecowitt.fetchRaw(ip); } catch (e) { throw bad('Gateway nicht erreichbar: ' + ((e.cause && e.cause.code) || e.message)); }
  const items = ecowitt.readings(j);
  if (!items.length) throw bad('Keine bekannten Messwerte gefunden – Antwort im Log-Viewer prüfen');
  cfg().ecowitt = { ip, interval: Math.max(10, Math.min(3600, Math.floor(num(body.interval, 60)))) };
  let added = 0;
  for (const it of items) {
    const src = 'ecowitt:' + it.key;
    if (cfg().devices.some((d) => d.src === src)) continue;
    cfg().devices.push(cleanDevice({ name: 'Wetter ' + it.name, type: 'sensor', driver: 'ecowitt', ekey: it.key, unit: it.unit, hide: true, src }));
    added++;
  }
  store.save();
  devices.rebuild();
  if (on('ecowitt')) ecowitt.start();
  ecowitt.apply(j);
  return { ok: true, added, total: items.length };
});
route('DELETE', '/api/ecowitt', () => {
  const c = cfg();
  const ids = new Set(c.devices.filter((d) => d.driver === 'ecowitt').map((d) => d.id));
  c.devices = c.devices.filter((d) => !ids.has(d.id));
  for (const id of ids) devices.states.delete(id);
  c.ecowitt = { ip: '', interval: 60 };
  store.save();
  devices.rebuild();
  if (on('ecowitt')) ecowitt.start();
  return { ok: true };
});
route('GET', '/api/ecowitt/raw', () => ({ raw: ecowitt.raw() }));


// Matter
const MATTER_TYPES = { cover: ['cover', ''], lock: ['lock', ''], switch: ['switch', ''], light: ['light', ''], temperature: ['sensor', '°C'], humidity: ['sensor', '%'], illuminance: ['sensor', 'lx'], battery: ['sensor', '%'], contact: ['binary', ''], occupancy: ['binary', ''] };
function matterSync(list) {
  let added = 0;
  for (const x of list) {
    const t = MATTER_TYPES[x.kind];
    if (!t) continue;
    const src = 'matter:' + x.key;
    if (cfg().devices.some((d) => d.src === src)) continue;
    cfg().devices.push(cleanDevice({ name: x.name, type: t[0], driver: 'matter', unit: t[1], matter: { peer: x.peer, endpoint: x.endpoint, kind: x.kind }, src, fav: x.kind === 'lock' }));
    added++;
  }
  if (added) { store.save(); devices.rebuild(); }
  matter.applyAll(list);
  return added;
}
matter.on('entities', (list) => { try { if (matterSync(list)) log('info', 'Matter: neue Geräte angelegt'); } catch (e) { log('error', 'Matter: ' + e.message); } });
matter.on('values', (list) => matter.applyAll(list));
matter.on('status', () => sse({ t: 'matter', matter: matter.status() }));
route('PUT', '/api/matter', ({ body }) => {
  cfg().matter.enabled = !!body.enabled;
  store.save();
  if (cfg().matter.enabled && on('matter')) matter.start(); else matter.stop();
  sse({ t: 'matter', matter: matter.status() });
  return matter.status();
});
route('POST', '/api/matter/install', async () => {
  try { await matter.install(); } catch (e) { throw bad(e.message); }
  if (cfg().matter.enabled && on('matter')) matter.start();
  return matter.status();
});
route('GET', '/api/matter/diag', async () => { try { return await matter.diag(); } catch (e) { throw bad(e.message); } });
route('POST', '/api/matter/commission', async ({ body }) => {
  const code = str(body.code, 200).replace(/[\s-]/g, '');
  if (!/^(MT:[\w.-]+|\d{11}|\d{21})$/.test(code)) throw bad('Kopplungscode ungültig (11- oder 21-stelliger Code bzw. MT:…-QR-Text)');
  try { await matter.commission(code); } catch (e) { throw bad('Koppeln fehlgeschlagen: ' + e.message); }
  return matter.status();
});
route('POST', '/api/matter/remove', async ({ body }) => {
  const peer = str(body.peer, 40);
  try { await matter.remove(peer); } catch (e) { throw bad(e.message); }
  const c = cfg();
  const ids = new Set(c.devices.filter((d) => d.driver === 'matter' && d.matter && d.matter.peer === peer).map((d) => d.id));
  c.devices = c.devices.filter((d) => !ids.has(d.id));
  for (const id of ids) devices.states.delete(id);
  store.save();
  devices.rebuild();
  return { ok: true, removed: ids.size };
});

// Import aus Home Assistant (vorbereitete Datei import/ha-migration.json)
route('GET', '/api/import/ha', () => importer.preview());
route('POST', '/api/import/ha', () => importer.run());

// Heizung
route('PUT', '/api/heating', ({ body }) => {
  const h = cfg().heating;
  h.frost = num(body.frost, 7);
  const old = new Map(h.rooms.map((r) => [r.id, r]));
  h.rooms = (Array.isArray(body.rooms) ? body.rooms : []).slice(0, 40).map((r) => cleanRoom(r, old.get(r.id)));
  store.save();
  heating.reset();
  return { ok: true };
});
route('POST', '/api/heating/command', ({ body }) => {
  try { heating.command({ room: str(body.room, 20), mode: str(body.mode, 10), temp: body.temp, minutes: body.minutes }); } catch (e) { throw bad(e.message); }
  sse({ t: 'heating', heating: heating.status() });
  return { ok: true };
});

// Auto
route('PUT', '/api/car', ({ body }) => {
  const c = cfg().car;
  c.enabled = !!body.enabled;
  c.name = str(body.name, 40) || 'Leapmotor';
  c.username = str(body.username, 150);
  if (body.password) c.password = str(body.password, 200);
  if (body.pin) c.pin = str(body.pin, 20);
  c.certPath = str(body.certPath, 400);
  c.keyPath = str(body.keyPath, 400);
  c.vin = str(body.vin, 30);
  c.pollMinutes = Math.max(2, num(body.pollMinutes, 10));
  store.save();
  if (on('car')) car.start();
  return { ok: true };
});
route('POST', '/api/car/command', async ({ body }) => {
  try { await car.command(str(body.command, 30)); } catch (e) { throw bad(e.message); }
  return { ok: true };
});
route('POST', '/api/car/refresh', () => { car.poll(); return { ok: true }; });

// Backup
route('GET', '/api/backup', () => backup.info());
route('PUT', '/api/backup', ({ body }) => {
  const c = cfg().backup;
  const dir = str(body.dir, 400).trim();
  if (dir && !path.isAbsolute(dir)) throw bad('Der Zielordner muss ein absoluter Pfad sein, z. B. /mnt/backup/homelite');
  c.dir = dir.replace(/\/+$/, '');
  c.keep = Math.max(1, Math.min(100, Math.floor(num(body.keep, 10))));
  c.auto = !!body.auto;
  c.time = /^\d{2}:\d{2}$/.test(body.time || '') ? body.time : '03:00';
  c.allowSameDisk = !!body.allowSameDisk;
  store.save();
  return backup.info();
});
route('POST', '/api/backup/run', async () => backup.create(false));
route('POST', '/api/backup/restore', async ({ body }) => backup.restoreName(str(body.file, 120)));
route('POST', '/api/backup/restore-upload', async ({ body }) => backup.restoreUpload(Buffer.from(String(body.data || ''), 'base64')));
route('POST', '/api/backup/delete', ({ body }) => { backup.remove(str(body.file, 120)); return { ok: true }; });

// Software-Update
const updInfo = () => ({ version: updater.version(), url: cfg().update.url || '', check: updater.status(), backups: updater.backups(), systemd: updater.underSystemd() });
route('GET', '/api/update', () => updInfo());
route('PUT', '/api/update', ({ body }) => {
  const u = str(body.url, 500).trim();
  if (u && !/^https?:\/\//i.test(u)) throw bad('Update-Quelle muss mit http(s):// beginnen');
  cfg().update.url = u;
  if (body.auto !== undefined) cfg().update.auto = !!body.auto;
  store.save();
  return updInfo();
});
route('POST', '/api/update/check', async () => updater.fromUrl(updater.source()));
route('POST', '/api/update/check-now', async () => updater.check());
route('POST', '/api/update/upload', async ({ body }) => {
  const buf = Buffer.from(String(body.data || ''), 'base64');
  return updater.stage(buf);
});
route('POST', '/api/update/install', async ({ body }) => updater.install(str(body.id, 40)));
route('POST', '/api/update/rollback', async ({ body }) => updater.rollback(str(body.file, 120)));


// Eingebauter MQTT-Broker
route('PUT', '/api/broker', ({ body }) => {
  const b = cfg().broker;
  if (body.port !== undefined) b.port = Math.max(1, Math.min(65535, Math.floor(num(body.port, 1883))));
  if (body.allowAnonymous !== undefined) b.allowAnonymous = !!body.allowAnonymous;
  store.save();
  if (on('broker')) { broker.stop(); broker.start(); }
  return { ok: true };
});
route('POST', '/api/broker/user', ({ body }) => {
  const name = str(body.name, 40).trim();
  const pass = str(body.pass, 100);
  if (!/^[\w.@-]{1,40}$/.test(name)) throw bad('Benutzername: nur Buchstaben, Ziffern, . _ - @');
  if (pass.length < 6) throw bad('Passwort mindestens 6 Zeichen');
  broker.setUser(name, pass);
  return { ok: true };
});
route('DELETE', '/api/broker/user/([\\w.@-]+)', ({ params }) => {
  broker.removeUser(params[0]);
  return { ok: true };
});
// HomeLite selbst (MQTT-Client) mit dem eingebauten Broker verbinden
route('POST', '/api/broker/connect-self', () => {
  const b = cfg().broker;
  if (!b.internal) b.internal = { user: 'homelite', pass: crypto.randomBytes(12).toString('hex') };
  broker.setUser(b.internal.user, b.internal.pass);
  const m = cfg().mqtt;
  m.url = `mqtt://127.0.0.1:${b.port}`;
  m.user = b.internal.user;
  m.pass = b.internal.pass;
  store.save();
  if (on('broker')) broker.start();
  devices.z2m = [];
  devices.tasmota.clear();
  devices.start();
  return { ok: true };
});

// KI-Zugriff (MCP)
route('PUT', '/api/mcp', ({ body }) => {
  const m = cfg().mcp;
  if (body.regenerate || !m.token) m.token = require('./lib/mcp').newToken();
  if (body.allowControl !== undefined) m.allowControl = !!body.allowControl;
  if (body.allowUnlock !== undefined) m.allowUnlock = !!body.allowUnlock;
  if (body.allowAutomations !== undefined) m.allowAutomations = !!body.allowAutomations;
  store.save();
  return { ok: true, token: m.token };
});

// System
const os = require('os');
const { execFile } = require('child_process');
const tryExec = (cmd, args) => new Promise((resolve) => { execFile(cmd, args, { timeout: 8000 }, (e) => resolve(e ? e.message : null)); });
route('GET', '/api/system', () => ({ host: os.hostname(), uptime: os.uptime(), proc: process.uptime(), node: process.version, systemd: updater.underSystemd(), root: typeof process.getuid === 'function' ? process.getuid() === 0 : null }));
route('POST', '/api/system/restart', () => {
  const sd = updater.underSystemd();
  if (!sd) throw bad('HomeLite läuft nicht unter systemd – ein automatischer Neustart ist nicht möglich. Bitte manuell neu starten (z. B. „systemctl restart homelite“).');
  log('info', 'HomeLite-Neustart angefordert');
  setTimeout(() => shutdown(), 1000);
  return { ok: true, restart: true, version: updater.version(), title: 'Neustart', message: 'HomeLite wird neu gestartet.' };
});
route('POST', '/api/system/reboot', async ({ body }) => {
  if (!store.checkPassword(String(body.password || ''))) throw new HttpError(401, 'Passwort falsch');
  const custom = process.env.HOMELITE_REBOOT_CMD;
  const attempts = custom ? [[custom, []]] : [['systemctl', ['reboot']], ['sudo', ['-n', 'systemctl', 'reboot']], ['reboot', []], ['sudo', ['-n', 'reboot']]];
  let last = '';
  for (const [c, a] of attempts) {
    const err = await tryExec(c, a);
    if (!err) { log('warn', 'System-Neustart ausgelöst'); return { ok: true, restart: true, version: updater.version(), title: 'Server startet neu', message: 'Der Server wird neu gestartet.', timeout: 600000 }; }
    last = err;
  }
  log('warn', 'System-Neustart nicht möglich: ' + last);
  throw bad('Neustart nicht erlaubt: HomeLite läuft ohne Root-Rechte. Lösung: per „sudo visudo -f /etc/sudoers.d/homelite“ die Zeile „<Benutzer> ALL=(root) NOPASSWD: /usr/bin/systemctl reboot“ eintragen (Benutzer = der HomeLite-Dienst-Benutzer). Letzte Meldung: ' + last.slice(0, 160));
});

// Erweiterungen
function applyModule(id) {
  const o = on(id);
  switch (id) {
    case 'energy': if (o) victron.start(); else victron.stop(); break;
    case 'heating': if (o) runHeating(); break;
    case 'car': if (o) car.start(); else car.stop(); break;
    case 'ecowitt': if (o) ecowitt.start(); else ecowitt.stop(); break;
    case 'matter': if (o && cfg().matter.enabled) matter.start(); else matter.stop(); break;
    case 'dew': dew.sync(); break;
    case 'appletv': if (o) appletv.start(); else appletv.stop(); break;
    case 'broker': if (o) broker.start(); else broker.stop(); break;
    case 'where': if (o) findmy.start(); else findmy.stop(); break;
    default: break;
  }
}
route('PUT', '/api/modules', ({ body }) => {
  if (!MODULES[body.id]) throw bad('Unbekannte Erweiterung');
  cfg().modules[body.id] = !!body.on;
  if (body.id === 'mcp' && body.on && !cfg().mcp.token) cfg().mcp.token = require('./lib/mcp').newToken();
  store.save();
  applyModule(body.id);
  return { ok: true, modules: cfg().modules };
});

// Apple TV (Status)
route('POST', '/api/appletv/scan', async () => { try { return { devices: await appletv.scan() }; } catch (e) { throw bad(e.message); } });
route('POST', '/api/appletv/pair/begin', async ({ body }) => {
  try { return await appletv.pairBegin(str(body.id, 120), str(body.protocol, 20), str(body.address, 100)); } catch (e) { throw bad(e.message); }
});
route('POST', '/api/appletv/pair/pin', async ({ body }) => {
  try { await appletv.pairPin(str(body.pin, 20), str(body.name, 80)); } catch (e) { throw bad(e.message); }
  if (on('appletv')) appletv.start();
  return { ok: true };
});
route('POST', '/api/appletv/link', ({ body }) => {
  const a = cfg().appletv.devices.find((x) => x.id === body.id);
  if (!a) throw new HttpError(404, 'Apple TV nicht gekoppelt');
  let n = 0;
  for (const [akey, label, type] of AppleTV.ITEMS) {
    const src = `appletv:${a.id}:${akey}`;
    if (cfg().devices.some((d) => d.src === src)) continue;
    cfg().devices.push(cleanDevice({ name: `${a.name} ${label}`, type, driver: 'appletv', atvId: a.id, akey, hide: akey !== 'power' && akey !== 'app', src, room: str(body.room, 60) }));
    n++;
  }
  store.save();
  appletv.apply(a.id);
  sse({ t: 'appletv', appletv: appletv.snapshot() });
  return { ok: true, created: n };
});
route('DELETE', '/api/appletv/(.+)', ({ params }) => {
  const id = decodeURIComponent(params[0]);
  const ids = new Set(cfg().devices.filter((d) => d.driver === 'appletv' && d.atvId === id).map((d) => d.id));
  cfg().devices = cfg().devices.filter((d) => !ids.has(d.id));
  appletv.remove(id);
  return { ok: true };
});

// iCloud „Wo ist?“
route('POST', '/api/findmy', async ({ body }) => {
  const c = cfg().findmy;
  const apple = str(body.apple, 200).trim();
  if (!apple) throw bad('Apple-ID fehlt');
  const pass = body.password === undefined || body.password === '' ? c.password : str(body.password, 200);
  if (!pass) throw bad('Passwort fehlt');
  Object.assign(c, { enabled: true, apple, password: pass, china: !!body.china, interval: Math.max(30, Math.min(3600, Math.floor(num(body.interval, 120)))) });
  store.save();
  if (on('where')) findmy.start();
  return { ok: true };
});
route('POST', '/api/findmy/verify', async ({ body }) => {
  try { return { state: await findmy.verify(str(body.code, 12), Math.floor(num(body.device, 0))) }; } catch (e) { throw bad(e.message); }
});
route('PUT', '/api/findmy/mapping', ({ body }) => {
  const list = Array.isArray(body.devices) ? body.devices : [];
  cfg().findmy.devices = list.filter((x) => isObj(x) && x.id && x.person).slice(0, 30).map((x) => ({ id: str(x.id, 200), name: str(x.name, 80), person: str(x.person, 40) }));
  for (const m of cfg().findmy.devices) presence.ensurePerson(m.person);
  store.save();
  findmy.apply(findmy.devices);
  return { ok: true };
});
route('POST', '/api/findmy/refresh', async () => { await findmy.poll(); return { ok: true }; });
route('DELETE', '/api/findmy', async () => { await findmy.logout(); return { ok: true }; });
route('GET', '/api/trail', () => presence.trail);

// Geofence
route('PUT', '/api/geofence', ({ body }) => {
  const g = cfg().geofence;
  g.persons = (Array.isArray(body.persons) ? body.persons : []).slice(0, 20).map((p) => ({ id: str(p.id, 40) || store.id(), name: str(p.name, 40) || 'Person' }));
  const zones = (Array.isArray(body.zones) ? body.zones : []).slice(0, 30).map((z) => ({
    id: str(z.id, 40) || store.id(), name: str(z.name, 40) || 'Zone',
    lat: z.lat === '' || z.lat == null ? null : num(z.lat, null), lon: z.lon === '' || z.lon == null ? null : num(z.lon, null),
    radius: Math.max(20, num(z.radius, 150)), home: !!z.home,
  }));
  if (!zones.some((z) => z.home) && zones.length) zones[0].home = true;
  g.zones = zones;
  store.save();
  runHeating();
  return { ok: true };
});
route('POST', '/api/geofence/regenerate-key', () => {
  cfg().geofence.key = crypto.randomBytes(16).toString('hex');
  store.save();
  return { key: cfg().geofence.key };
});
route('POST', '/api/presence/(\\w[\\w-]*)', ({ params, body }) => {
  const p = cfg().geofence.persons.find((x) => x.id === params[0]);
  if (!p) throw new HttpError(404, 'Person nicht gefunden');
  presence.setHome(p.id, !!body.home);
  return { ok: true };
});

// ---------- Server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const SEC = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};

function serveStatic(req, res, pathname) {
  let p = path.normalize(decodeURIComponent(pathname));
  if (p === '/' || p === path.sep) p = '/index.html';
  const file = path.join(PUB, p);
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC });
    res.end(buf);
  });
}

function send(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SEC, ...extra });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/hook') return await hook(req, res, url);
    if (p === '/trigger') return await trigger(req, res, url);
    if (p === '/mcp' || p.startsWith('/mcp/') || p.startsWith('/mcp-plugin/')) { if (await mcp.handle(req, res, url, (r) => readBody(r), on('mcp'))) return undefined; }
    const hk = /^\/hook\/([a-z0-9][a-z0-9-]{1,40})\/([A-Za-z0-9_-]{16,64})(\/[^?]*)?$/.exec(p);
    if (hk) {
      const raw = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? '' : await readRaw(req);
      let body = raw;
      if (/json/i.test(req.headers['content-type'] || '') && raw) { try { body = JSON.parse(raw); } catch { /* Text */ } }
      else if (/x-www-form-urlencoded/i.test(req.headers['content-type'] || '') && raw) body = Object.fromEntries(new URLSearchParams(raw));
      let out;
      try { out = await plugins.hook(hk[1], hk[2], { method: req.method, sub: hk[3] || '', query: Object.fromEntries(url.searchParams), headers: req.headers, body, ip: req.socket.remoteAddress }); }
      catch (e) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); return undefined; }
      const o = out && typeof out === 'object' && ('body' in out || 'status' in out) ? out : { body: out };
      const payload = typeof o.body === 'string' || Buffer.isBuffer(o.body) ? o.body : JSON.stringify(o.body === undefined ? { ok: true } : o.body);
      res.writeHead(Number(o.status) || 200, { 'Content-Type': typeof o.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...(o.headers || {}) });
      res.end(payload);
      return undefined;
    }
    if (!p.startsWith('/api/')) return serveStatic(req, res, p);

    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      const f = fails.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
      if (f.n >= 8) throw new HttpError(429, 'Zu viele Versuche, bitte später erneut');
      const body = await readBody(req);
      if (!store.checkPassword(body.password || '')) {
        f.n++; fails.set(ip, f);
        await new Promise((r) => setTimeout(r, 600));
        throw new HttpError(401, 'Passwort falsch');
      }
      fails.delete(ip);
      const exp = Date.now() + 30 * 86400000;
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `hl=${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}` });
    }
    if (p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'hl=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    if (!isAuthed(req)) return send(res, 401, { error: 'Nicht angemeldet' });

    if (p === '/api/backup/download' && req.method === 'GET') {
      const f = backup.filePath(url.searchParams.get('file') || '');
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${path.basename(f)}"`, 'Content-Length': fs.statSync(f).size, ...SEC });
      return fs.createReadStream(f).pipe(res);
    }

    { // Plugin-Oberfläche (JavaScript/CSS des Plugins, nur für angemeldete Nutzer)
      const pm = /^\/api\/plugins\/([a-z0-9-]+)\/client\.(js|css)$/.exec(p);
      if (pm && req.method === 'GET') {
        const f = plugins.clientFile(pm[1], pm[2]);
        if (!f || !fs.existsSync(f)) throw new HttpError(404, 'Nicht gefunden');
        res.writeHead(200, { 'Content-Type': pm[2] === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC });
        return fs.createReadStream(f).pipe(res);
      }
    }

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...SEC });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }

    if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json') && req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined) {
      throw new HttpError(415, 'JSON erwartet');
    }
    for (const [method, re, fn] of routes) {
      if (method !== req.method) continue;
      const m = re.exec(p);
      if (!m) continue;
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req, p === '/api/update/upload' || p === '/api/backup/restore-upload' ? 60e6 : p === '/api/plugins/upload' ? 45e6 : 1e6);
      const out = await fn({ params: m.slice(1), body: isObj(body) ? body : {}, url, req });
      return send(res, 200, out);
    }
    return send(res, 404, { error: 'Unbekannter Endpunkt' });
  } catch (e) {
    if (!(e instanceof HttpError)) log('error', `API ${req.method} ${p}: ${e.message}`);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Interner Fehler' });
  }
});

setInterval(() => sse({ t: 'ping' }), 25000);
setInterval(() => { if (on('energy')) energy.tick(); }, 10000);
setInterval(() => backup.tick().catch(() => {}), 30000);
setInterval(() => { engine.onTick(); runHeating(); }, 20000);

server.listen(PORT, HOST, () => {
  console.log(`HomeLite läuft auf http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  devices.start();
  setTimeout(dewSoon, 3000);
  setInterval(dewSoon, 120000);
  if (on('broker')) broker.start();
  coiot.start();
  plugins.startAll().catch((e) => log('error', 'Plugins: ' + e.message));
  if (on('matter')) matter.start();
  if (on('energy')) victron.start();
  if (on('ecowitt')) ecowitt.start();
  if (on('car')) car.start();
  if (on('appletv')) appletv.start();
  if (on('where')) findmy.start();
  setTimeout(() => heating.reset(), 4000);
  setTimeout(() => engine.onStartup(), 30000);
});

function shutdown() { try { history.flush(); coiot.stop(); } catch { /* ignore */ } try { broker.stop(); } catch { /* ignore */ } presence.save(); presence.saveTrail(); try { appletv.br.stop(); findmy.br.stop(); } catch { /* ignore */ } try { devices.disconnectMqtt(); } catch { /* ignore */ } Promise.race([plugins.stopAll(), new Promise((r) => setTimeout(r, 3000))]).catch(() => {}).finally(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => log('error', 'Unbehandelt: ' + (e && e.message)));
