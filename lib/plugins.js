'use strict';
// Plugin-System: Erweiterungen als eigene Pakete (tar.gz), installierbar ohne Systemupdate.
//
// Ein Plugin liegt in <data>/plugins/<id>/ und besteht mindestens aus plugin.json und der Hauptdatei (main).
// Plugins laufen im HomeLite-Prozess mit vollen Rechten – nur Pakete aus vertrauenswürdiger Quelle installieren.
// Die Plugin-Schnittstelle ist in PLUGINS.md beschrieben (Plugin-API Version 1).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const API_VERSION = 1;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const KEY_RE = /^[\w.:@#-]{1,80}$/;
const MAX_SIZE = 30e6;

const run = (cmd, args, opt = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 20e6, timeout: opt.timeout || 120000, cwd: opt.cwd }, (e, so, se) => {
    if (e) { const er = new Error(String(se || e.message).trim().slice(0, 400)); er.status = 400; reject(er); } else resolve(String(so));
  });
});
const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };
const cmpVer = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
};
const FIELD_TYPES = ['text', 'textarea', 'number', 'bool', 'password', 'select'];

module.exports = function createPlugins({ store, devices, engine, sse, log, notify, coreVersion, getMcp }) {
  const DIR = path.join(store.DATA, 'plugins');
  const PDATA = path.join(store.DATA, 'plugin-data');
  const live = new Map(); // id -> { inst, timers, routes, cfgCbs, stateCbs, cmd, error }
  const errors = new Map(); // id -> Meldung (Start fehlgeschlagen)
  const watchers = new Map(); // Plugin-ID -> [{ owner, cb }] (api.onUse)
  const tokenOf = (id) => { let t = store.kvGet(`plugin:${id}:__hooktoken`); if (!t) { t = require('crypto').randomBytes(18).toString('base64url'); store.kvSet(`plugin:${id}:__hooktoken`, t); } return t; };
  fs.mkdirSync(DIR, { recursive: true });

  const conf = () => { if (!store.cfg.plugins || typeof store.cfg.plugins !== 'object') store.cfg.plugins = {}; return store.cfg.plugins; };
  const entry = (id) => { const c = conf(); if (!c[id]) c[id] = { enabled: false, config: {} }; return c[id]; };

  // ---------- Manifest ----------
  function readManifest(dir) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch (e) { throw fail('plugin.json fehlt oder ist ungültig: ' + e.message); }
    if (!m || typeof m !== 'object') throw fail('plugin.json ungültig');
    if (!ID_RE.test(String(m.id || ''))) throw fail('Plugin-ID ungültig (nur a-z, 0-9 und Bindestrich, 2–41 Zeichen)');
    if (!/^\d+\.\d+\.\d+$/.test(String(m.version || ''))) throw fail('Plugin-Version fehlt (Format 1.2.3)');
    const main = String(m.main || 'index.js');
    const inside = (rel) => { const abs = path.resolve(dir, rel); return abs === path.resolve(dir) || abs.startsWith(path.resolve(dir) + path.sep); };
    if (!inside(main) || !fs.existsSync(path.resolve(dir, main))) throw fail(`Hauptdatei „${main}“ nicht gefunden`);
    for (const k of ['client', 'style']) if (m[k] && (!inside(String(m[k])) || !fs.existsSync(path.resolve(dir, String(m[k]))))) throw fail(`Datei „${m[k]}“ (${k}) nicht gefunden`);
    const fields = [];
    for (const f of Array.isArray(m.config) ? m.config : []) {
      if (!f || !/^\w{1,40}$/.test(String(f.key || '')) || !FIELD_TYPES.includes(f.type || 'text')) throw fail('Ungültiges Konfigurationsfeld in plugin.json');
      fields.push({ key: f.key, label: String(f.label || f.key).slice(0, 120), type: f.type || 'text', default: f.default, options: f.options && typeof f.options === 'object' ? f.options : undefined, help: f.help ? String(f.help).slice(0, 300) : undefined, placeholder: f.placeholder ? String(f.placeholder).slice(0, 120) : undefined });
    }
    return {
      id: m.id, name: String(m.name || m.id).slice(0, 80), version: m.version, description: String(m.description || '').slice(0, 400),
      author: String(m.author || '').slice(0, 80), icon: String(m.icon || '🧩').slice(0, 4), main, client: m.client ? String(m.client) : '', style: m.style ? String(m.style) : '',
      minCore: m.minCore ? String(m.minCore) : '', api: Number(m.api) || 1, config: fields,
      perms: (Array.isArray(m.permissions) ? m.permissions : []).filter((p) => p === 'core'),
      page: m.page && typeof m.page === 'object' ? { label: String(m.page.label || m.name || m.id).slice(0, 30), icon: String(m.page.icon || m.icon || '🧩').slice(0, 4) } : null,
    };
  }

  function installed() {
    const out = [];
    for (const f of fs.readdirSync(DIR)) {
      const dir = path.join(DIR, f);
      try { if (!fs.statSync(dir).isDirectory()) continue; const m = readManifest(dir); if (m.id === f) out.push({ ...m, dir }); } catch { /* defektes Plugin überspringen */ }
    }
    return out;
  }
  const find = (id) => installed().find((p) => p.id === id);

  // ---------- Konfiguration ----------
  function effectiveConfig(m) {
    const saved = (conf()[m.id] || {}).config || {};
    const out = {};
    for (const f of m.config) {
      let v = saved[f.key] !== undefined ? saved[f.key] : f.default;
      if (f.type === 'number') v = v === '' || v === undefined || v === null || isNaN(Number(v)) ? (f.default ?? null) : Number(v);
      else if (f.type === 'bool') v = !!v;
      else v = v === undefined || v === null ? '' : String(v);
      out[f.key] = v;
    }
    return out;
  }

  function setConfig(id, values) {
    const m = find(id);
    if (!m) throw fail('Plugin nicht gefunden', 404);
    const e = entry(id);
    const next = { ...(e.config || {}) };
    for (const f of m.config) {
      if (values[f.key] === undefined) continue;
      let v = values[f.key];
      if (f.type === 'password' && (v === '' || v === null)) continue; // leer = unverändert
      if (f.type === 'number') { v = v === '' || v === null ? '' : Number(v); if (v !== '' && isNaN(v)) throw fail(`„${f.label}“ muss eine Zahl sein`); } else if (f.type === 'bool') v = !!v;
      else if (f.type === 'select') { v = String(v); if (f.options && !(v in f.options)) throw fail(`„${f.label}“: ungültige Auswahl`); } else v = String(v).slice(0, 5000);
      next[f.key] = v;
    }
    e.config = next;
    store.save();
    const l = live.get(id);
    if (l) for (const cb of l.cfgCbs) safe(id, () => cb(effectiveConfig(m)));
    push();
  }

  // ---------- Plugin-Schnittstelle ----------
  const safe = (id, fn) => { try { const r = fn(); if (r && typeof r.catch === 'function') r.catch((e) => log('error', `[Plugin ${id}] ${e.message}`)); return r; } catch (e) { log('error', `[Plugin ${id}] ${e.message}`); return undefined; } };

  const devView = (d) => ({ id: d.id, name: d.name, room: d.room || '', type: d.type, state: devices.stateString(d), state_raw: devices.states.get(d.id) || {}, ip: d.ip || '', plugin: d.plugin || '', key: d.key || '', pending: !!d.pending, note: d.note || '' });
  const own = (id, key) => devices.list.find((d) => d.driver === 'plugin' && d.plugin === id && d.key === key);

  function makeApi(m, L) {
    const id = m.id;
    const tag = `[${m.name}]`;
    const api = {
      id, apiVersion: API_VERSION, coreVersion: coreVersion(), dataDir: path.join(PDATA, id),
      log: (level, msg) => log(['info', 'warn', 'error'].includes(level) ? level : 'info', `${tag} ${msg}`),
      config: () => effectiveConfig(m),
      onConfig: (cb) => { L.cfgCbs.push(cb); },
      kv: {
        get: (k) => store.kvGet(`plugin:${id}:${k}`),
        set: (k, v) => store.kvSet(`plugin:${id}:${k}`, v),
      },
      timer: (fn, ms) => { const t = setInterval(() => safe(id, fn), Math.max(100, Number(ms) || 1000)); L.timers.add(t); return () => { clearInterval(t); L.timers.delete(t); }; },
      after: (fn, ms) => { const t = setTimeout(() => { L.timers.delete(t); safe(id, fn); }, Math.max(0, Number(ms) || 0)); L.timers.add(t); return () => { clearTimeout(t); L.timers.delete(t); }; },
      route: (method, sub, fn) => {
        const M = String(method).toUpperCase();
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(M)) throw new Error('Methode ungültig');
        const names = [];
        const re = new RegExp('^' + String(sub).replace(/^\/+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
        L.routes.push({ M, re, names, fn });
      },
      emit: (data) => sse({ t: 'plugin', id, data }),
      // KI-Zugriff (MCP) um eigene Werkzeuge erweitern: { name, description, inputSchema, readOnly, control, run(args) }
      mcp: { tool: (def) => { const x = getMcp && getMcp(); if (!x) throw new Error('MCP nicht verfügbar'); x.addTool(id, def); L.mcp = true; },
        // eigener MCP-Endpunkt nur für dieses Plugin: Pfad /mcp-plugin/<id>/<token> (Token wird bei Bedarf erzeugt)
        endpoint: (regenerate) => { const k = `plugin:${id}:__mcptoken`; let t = store.kvGet(k); if (!t || regenerate) { t = crypto.randomBytes(24).toString('hex'); store.kvSet(k, t); } return { path: `/mcp-plugin/${id}/${t}`, token: t }; } },
      // Kern-Werkzeuge (Geräte, Automationen, Protokoll …) – nur mit "permissions": ["core"] in plugin.json
      // MQTT (über die Broker-Verbindung von HomeLite)
      mqtt: {
        subscribe: (filter, cb) => {
          filter = String(filter || '').trim();
          if (!filter || filter.length > 200) throw new Error('MQTT-Filter ungültig');
          const re = new RegExp('^' + filter.split('/').map((p) => (p === '#' ? '.*' : p === '+' ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '$');
          const h = (topic, payload) => { if (re.test(topic)) safe(id, () => cb(topic, String(payload))); };
          devices.on('raw', h); devices.addSub(filter);
          let done = false;
          const un = () => { if (done) return; done = true; devices.off('raw', h); devices.removeSub(filter); };
          L.cleanups.push(un);
          return un;
        },
        publish: (topic, payload, opts) => devices.publish(String(topic), typeof payload === 'object' && payload !== null ? JSON.stringify(payload) : String(payload ?? ''), opts || {}),
        connected: () => !!devices.mqttOk,
      },
      // Öffentlicher Webhook (Zugriff nur mit geheimem Pfad): /hook/<plugin>/<token>/…
      http: {
        url: () => ({ path: `/hook/${id}/${tokenOf(id)}` }),
        regenerate: () => { store.kvSet(`plugin:${id}:__hooktoken`, ''); return { path: `/hook/${id}/${tokenOf(id)}` }; },
        on: (fn) => { L.hook = fn; },
      },
      // Plugin-zu-Plugin: ein Plugin stellt ein Objekt bereit (expose), andere nutzen es (use/onUse)
      expose: (obj) => { L.exposed = obj; for (const w of (watchers.get(id) || [])) safe(w.owner, () => w.cb(obj)); },
      use: (pid) => { const o = live.get(String(pid)); return o && o.exposed ? o.exposed : null; },
      onUse: (pid, cb) => {
        pid = String(pid);
        const w = { owner: id, cb };
        watchers.set(pid, [...(watchers.get(pid) || []), w]);
        const o = live.get(pid);
        if (o && o.exposed) safe(id, () => cb(o.exposed));
        L.cleanups.push(() => watchers.set(pid, (watchers.get(pid) || []).filter((x) => x !== w)));
      },
      core: m.perms && m.perms.includes('core') ? {
        tools: () => { const x = getMcp && getMcp(); if (!x) throw new Error('MCP nicht verfügbar'); return x.coreList(); },
        call: (name, args) => { const x = getMcp && getMcp(); if (!x) throw new Error('MCP nicht verfügbar'); return x.coreCall(String(name), args); },
      } : undefined,
      fire: (name) => engine.webhook(String(name)),
      sun: (d) => { try { const t = engine.sunToday(d instanceof Date ? d : new Date()); return t ? { sunrise: t.sunrise, sunset: t.sunset } : null; } catch { return null; } },
      notify: (title, msg) => notify(String(title || m.name), String(msg || '')),
      devices: {
        // legt das Gerät an (falls neu) oder aktualisiert Typ/Einheit; Name und Raum bleiben, wenn der Nutzer sie geändert hat
        ensure(spec) {
          if (!spec || !KEY_RE.test(String(spec.key || ''))) throw new Error('Geräte-Schlüssel (key) fehlt/ungültig');
          const type = devices.constructor.TYPES.includes(spec.type) ? spec.type : 'sensor';
          let d = own(id, spec.key);
          if (!d && spec.adopt) {
            // vorhandenes Gerät (z. B. Platzhalter) übernehmen: ID bleibt, damit Automationen weiter greifen
            const o = store.cfg.devices.find((x) => x.id === spec.adopt && (x.driver !== 'plugin' || x.pending));
            if (!o) throw new Error('Zu übernehmendes Gerät nicht gefunden');
            for (const k of ['tuya', 'stateTopics', 'cmd', 'paths', 'ip', 'url', 'matter', 'topic']) delete o[k];
            Object.assign(o, { type, driver: 'plugin', plugin: id, key: spec.key, src: `plugin:${id}:${spec.key}`, pending: false, note: '' });
            if (spec.unit !== undefined) o.unit = String(spec.unit).slice(0, 12);
            if (spec.name) o.name = String(spec.name).slice(0, 80);
            if (spec.room !== undefined) o.room = String(spec.room).slice(0, 60);
            store.save(); devices.rebuild && devices.rebuild(); sse({ t: 'devices' });
            d = own(id, spec.key) || o;
          }
          if (!d) {
            d = { id: store.id(), name: String(spec.name || spec.key).slice(0, 80), room: String(spec.room || '').slice(0, 60), fav: false, type, driver: 'plugin', plugin: id, key: spec.key, src: `plugin:${id}:${spec.key}`, unit: String(spec.unit || '').slice(0, 12) };
            store.cfg.devices.push(d);
            if (spec.room && !store.cfg.rooms.includes(d.room)) store.cfg.rooms.push(d.room);
            store.save();
            sse({ t: 'devices' });
          } else if (d.type !== type || (spec.unit !== undefined && d.unit !== String(spec.unit))) {
            d.type = type;
            if (spec.unit !== undefined) d.unit = String(spec.unit).slice(0, 12);
            store.save();
            sse({ t: 'devices' });
          }
          return devView(d);
        },
        setState(key, patch) {
          const d = own(id, key);
          if (!d) throw new Error(`Gerät „${key}“ nicht gefunden (erst devices.ensure aufrufen)`);
          const prev = { ...(devices.states.get(d.id) || {}) };
          const st = { ...prev, ...patch };
          if (patch.online === undefined) st.online = true;
          st.ts = Date.now();
          devices.setState(d, st, prev, d.type === 'event');
        },
        remove(key) {
          const d = own(id, key);
          if (!d) return false;
          store.cfg.devices = store.cfg.devices.filter((x) => x.id !== d.id);
          devices.states.delete(d.id);
          store.save();
          sse({ t: 'devices' });
          return true;
        },
        list: () => devices.list.filter((d) => d.driver === 'plugin' && d.plugin === id).map(devView),
        onCommand: (fn) => { L.cmd = fn; },
        // alle Geräte lesen / steuern / auf Änderungen reagieren
        all: () => devices.list.map(devView),
        get: (ref) => { const d = devices.list.find((x) => x.id === ref || x.name.toLowerCase() === String(ref).toLowerCase()); return d ? devView(d) : null; },
        control: async (ref, action, value) => {
          const d = devices.list.find((x) => x.id === ref || x.name.toLowerCase() === String(ref).toLowerCase());
          if (!d) throw new Error(`Gerät „${ref}“ nicht gefunden`);
          return devices.control(d, String(action), value, { k: 'sys', w: `Plugin ${m.name}` });
        },
        onState: (fn) => { L.stateCbs.push(fn); },
      },
    };
    return api;
  }

  // ---------- Start / Stop ----------
  function purgeCache(dir) {
    const base = path.resolve(dir) + path.sep;
    for (const k of Object.keys(require.cache)) if (k.startsWith(base)) delete require.cache[k];
  }

  async function start(id) {
    const m = find(id);
    if (!m) throw fail('Plugin nicht gefunden', 404);
    if (live.has(id)) return;
    errors.delete(id);
    if (m.api > API_VERSION) { errors.set(id, `benötigt Plugin-API ${m.api} (HomeLite kennt ${API_VERSION}) – bitte HomeLite aktualisieren`); push(); return; }
    if (m.minCore && cmpVer(coreVersion(), m.minCore) < 0) { errors.set(id, `benötigt HomeLite ab Version ${m.minCore} (installiert: ${coreVersion()})`); push(); return; }
    const L = { inst: null, timers: new Set(), routes: [], cfgCbs: [], stateCbs: [], cmd: null, cleanups: [], hook: null, exposed: null };
    live.set(id, L);
    try {
      fs.mkdirSync(path.join(PDATA, id), { recursive: true });
      purgeCache(m.dir);
      const mod = require(path.resolve(m.dir, m.main));
      const api = makeApi(m, L);
      const fn = typeof mod === 'function' ? mod : mod && typeof mod.start === 'function' ? mod.start : null;
      if (!fn) throw new Error('Hauptdatei exportiert weder eine Funktion noch start(api)');
      const inst = await Promise.race([Promise.resolve(fn(api)), new Promise((_, rej) => setTimeout(() => rej(new Error('Start dauerte länger als 30 s')), 30000))]);
      L.inst = inst && typeof inst === 'object' ? inst : (mod && typeof mod.stop === 'function' ? mod : null);
      log('info', `Plugin „${m.name}“ ${m.version} gestartet`);
    } catch (e) {
      await stop(id, true);
      errors.set(id, e.message || String(e));
      log('error', `Plugin „${m.name}“: Start fehlgeschlagen – ${e.message}`);
    }
    for (const d of devices.list) if (d.driver === 'plugin' && d.plugin === id) sse({ t: 'state', id: d.id, st: devices.states.get(d.id) || {} });
    push();
  }

  async function stop(id, silent) {
    const L = live.get(id);
    if (!L) return;
    live.delete(id);
    if (L.inst && typeof L.inst.stop === 'function') { try { await Promise.race([Promise.resolve(L.inst.stop()), new Promise((r) => setTimeout(r, 5000))]); } catch (e) { log('warn', `Plugin ${id}: stop() – ${e.message}`); } }
    for (const t of L.timers) { clearInterval(t); clearTimeout(t); }
    L.timers.clear();
    for (const fn of L.cleanups.splice(0)) { try { fn(); } catch { /* ignorieren */ } }
    for (const w of (watchers.get(id) || [])) { try { w.cb(null); } catch { /* ignorieren */ } }
    for (const [pid, list] of watchers) watchers.set(pid, list.filter((w) => w.owner !== id));
    try { const x = getMcp && getMcp(); if (x) x.removeTools(id); } catch { /* ignorieren */ }
    // Geräte des Plugins als nicht erreichbar markieren
    for (const d of devices.list) {
      if (d.driver !== 'plugin' || d.plugin !== id) continue;
      const prev = { ...(devices.states.get(d.id) || {}) };
      if (prev.online !== false) devices.setState(d, { ...prev, online: false }, prev);
    }
    const m = find(id);
    if (m) purgeCache(m.dir);
    if (!silent) log('info', `Plugin „${m ? m.name : id}“ gestoppt`);
    if (!silent) push();
  }

  // Token des plugin-eigenen MCP-Endpunkts (nur wenn das Plugin läuft, Werkzeuge hat und einen Endpunkt angelegt hat)
  function mcpToken(id) { const L = live.get(id); if (!L || !L.mcp) return null; return store.kvGet(`plugin:${id}:__mcptoken`) || null; }

  async function startAll() {
    for (const m of installed()) if (conf()[m.id] && conf()[m.id].enabled) await start(m.id);
  }
  async function stopAll() { for (const id of [...live.keys()]) await stop(id, true); }

  async function setEnabled(id, on) {
    if (!find(id)) throw fail('Plugin nicht gefunden', 404);
    entry(id).enabled = !!on;
    store.save();
    if (on) await start(id); else await stop(id);
    push();
  }

  // Seite des Plugins im Menü ein-/ausblenden (Plugin läuft weiter)
  function setMenu(id, on) {
    if (!find(id)) throw fail('Plugin nicht gefunden', 404);
    entry(id).menu = !!on;
    store.save();
    push();
  }

  // ---------- Installation ----------
  async function stage(buf, sub) {
    if (!buf || buf.length < 100) throw fail('Datei leer oder zu klein');
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) throw fail('Das ist kein .tar.gz-Archiv (bei GitHub: Adresse des Repositorys oder eines Plugin-Ordners angeben, z. B. …/tree/main/plugins-example/philips-hue)');
    if (buf.length > MAX_SIZE) throw fail('Archiv zu groß (max. 30 MB)');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-plug-'));
    try {
      const file = path.join(tmp, 'p.tgz');
      fs.writeFileSync(file, buf);
      const verbose = (await run('tar', ['-tvzf', file])).split('\n').filter(Boolean);
      if (verbose.some((l) => /^[lh]/.test(l))) throw fail('Archiv enthält Verknüpfungen – abgelehnt');
      const names = (await run('tar', ['-tzf', file])).split('\n').filter(Boolean);
      if (names.some((n) => n.startsWith('/') || n.split('/').includes('..'))) throw fail('Archiv enthält ungültige Pfade – abgelehnt');
      const x = path.join(tmp, 'x');
      fs.mkdirSync(x);
      await run('tar', ['-xzf', file, '-C', x, '--no-same-owner']);
      let root = x;
      const ents = fs.readdirSync(x);
      if (!fs.existsSync(path.join(root, 'plugin.json')) && ents.length === 1 && fs.statSync(path.join(x, ents[0])).isDirectory()) root = path.join(x, ents[0]);
      if (sub) {
        const r2 = path.resolve(root, sub);
        if (!r2.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(path.join(r2, 'plugin.json'))) throw fail(`Im Archiv gibt es keinen Plugin-Ordner „${sub}“`);
        root = r2;
      } else if (!fs.existsSync(path.join(root, 'plugin.json'))) {
        const ex = path.join(root, 'plugins-example');
        const list = fs.existsSync(ex) ? fs.readdirSync(ex).filter((d) => fs.existsSync(path.join(ex, d, 'plugin.json'))) : [];
        if (list.length) throw fail(`Das Repository enthält mehrere Plugins. Gib den Ordner an, z. B. …/tree/main/plugins-example/${list[0]}  (vorhanden: ${list.join(', ')})`);
      }
      const m = readManifest(root);
      await run('node', ['--check', path.resolve(root, m.main)]);
      const old = find(m.id);
      return { tmp, root, manifest: m, old: old ? old.version : null };
    } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  }

  async function install(buf, sub) {
    const s = await stage(buf, sub);
    try {
      const { manifest: m } = s;
      const wasRunning = live.has(m.id);
      if (wasRunning) await stop(m.id, true);
      const dest = path.join(DIR, m.id);
      const backup = dest + '.old';
      fs.rmSync(backup, { recursive: true, force: true });
      if (fs.existsSync(dest)) fs.renameSync(dest, backup);
      try { fs.cpSync(s.root, dest, { recursive: true }); } catch (e) { fs.rmSync(dest, { recursive: true, force: true }); if (fs.existsSync(backup)) fs.renameSync(backup, dest); throw e; }
      fs.rmSync(backup, { recursive: true, force: true });
      entry(m.id);
      store.save();
      log('info', `Plugin „${m.name}“ ${m.version} installiert${s.old ? ` (vorher ${s.old})` : ''}`);
      if (wasRunning || (conf()[m.id] && conf()[m.id].enabled)) await start(m.id);
      push();
      return { ok: true, id: m.id, name: m.name, version: m.version, updated: !!s.old, enabled: !!conf()[m.id].enabled };
    } finally { fs.rmSync(s.tmp, { recursive: true, force: true }); }
  }

  async function fromUrl(u) {
    if (!/^https:\/\//i.test(u || '')) throw fail('Adresse muss mit https:// beginnen');
    // github.com/<nutzer>/<repo>[/tree/<zweig>/<unterordner>]
    const gh = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/?#]+)(?:\/([^?#]*?))?)?\/?(?:[?#].*)?$/.exec(u);
    const sub = gh && gh[4] ? gh[4].replace(/\/+$/, '') : '';
    const url = gh ? `https://api.github.com/repos/${gh[1]}/${gh[2]}/tarball${gh[3] ? '/' + gh[3] : ''}` : u;
    let r;
    try { r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'HomeLite-Plugins' }, signal: AbortSignal.timeout(90000) }); } catch (e) { throw fail('Download fehlgeschlagen: ' + e.message); }
    if (!r.ok) throw fail('Download fehlgeschlagen: HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    return install(buf, sub);
  }

  async function remove(id, { withDevices = true } = {}) {
    const m = find(id);
    if (!m) throw fail('Plugin nicht gefunden', 404);
    await stop(id, true);
    fs.rmSync(m.dir, { recursive: true, force: true });
    delete conf()[id];
    if (withDevices) {
      const gone = devices.list.filter((d) => d.driver === 'plugin' && d.plugin === id);
      for (const d of gone) devices.states.delete(d.id);
      store.cfg.devices = store.cfg.devices.filter((d) => !(d.driver === 'plugin' && d.plugin === id));
      sse({ t: 'devices' });
    }
    store.save();
    log('info', `Plugin „${m.name}“ entfernt`);
    push();
  }

  // ---------- Anbindung an Server/Geräte ----------
  function running(id) { return live.has(id); }

  // Steuerbefehl für ein Plugin-Gerät
  async function control(dev, action, value) {
    const L = live.get(dev.plugin);
    if (!L) throw new Error(`Plugin „${dev.plugin}“ läuft nicht`);
    if (!L.cmd) throw new Error('Dieses Gerät ist nicht steuerbar');
    const res = await L.cmd(devView(dev), action, value);
    const prev = { ...(devices.states.get(dev.id) || {}) };
    let patch = res && typeof res === 'object' ? res : null;
    if (!patch && res !== false) {
      if (action === 'on' || action === 'off') patch = { on: action === 'on' };
      else if (action === 'toggle') patch = { on: !prev.on };
      else if (action === 'brightness') patch = { on: Number(value) > 0, brightness: Number(value) };
    }
    if (patch) devices.setState(dev, { ...prev, ...patch, online: true, ts: Date.now() }, prev);
    return undefined;
  }

  function onDeviceState(dev, st, prev) {
    for (const [id, L] of live) {
      if (!L.stateCbs.length) continue;
      for (const cb of L.stateCbs) safe(id, () => cb(devView(dev), st, prev));
    }
  }

  // Öffentlicher Webhook-Aufruf: /hook/<id>/<token>/…
  async function hook(id, token, ctx) {
    const L = live.get(id);
    if (!L || !L.hook) throw fail('Kein Webhook', 404);
    const want = tokenOf(id);
    const a = Buffer.from(String(token)); const b = Buffer.from(want);
    if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) throw fail('Schlüssel ungültig', 401);
    return L.hook(ctx);
  }

  // Plugin-eigene Routen: /api/plugins/<id>/x/<pfad>
  async function handle(id, method, sub, ctx) {
    const L = live.get(id);
    if (!L) throw fail('Plugin läuft nicht', 404);
    for (const r of L.routes) {
      if (r.M !== method) continue;
      const mm = r.re.exec(sub);
      if (!mm) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(mm[i + 1])]));
      let out;
      try { out = await r.fn({ ...ctx, params }); } catch (e) { if (e && e.status) throw e; log('warn', `[Plugin ${id}] ${e.message}`); throw fail(e.message || 'Fehler', 400); }
      return out === undefined ? { ok: true } : out;
    }
    throw fail('Unbekannter Plugin-Endpunkt', 404);
  }

  function clientFile(id, kind) {
    const m = find(id);
    if (!m || !live.has(id)) return null;
    const rel = kind === 'css' ? m.style : m.client;
    return rel ? path.resolve(m.dir, rel) : null;
  }

  function snapshot() {
    return installed().map((m) => {
      const e = conf()[m.id] || {};
      const cfg = effectiveConfig(m);
      return {
        id: m.id, name: m.name, version: m.version, description: m.description, author: m.author, icon: m.icon, minCore: m.minCore,
        enabled: !!e.enabled, menu: e.menu !== false, running: live.has(m.id), error: errors.get(m.id) || '',
        client: !!m.client, style: !!m.style, page: m.page, perms: m.perms || [],
        config: m.config.map((f) => ({ ...f, value: f.type === 'password' ? '' : cfg[f.key], hasValue: f.type === 'password' ? !!((e.config || {})[f.key]) : undefined })),
        devices: devices.list.filter((d) => d.driver === 'plugin' && d.plugin === m.id).length,
      };
    }).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  let pushT = null;
  function push() { clearTimeout(pushT); pushT = setTimeout(() => sse({ t: 'plugins', plugins: snapshot() }), 150); }

  return { startAll, stopAll, start, stop, setEnabled, setMenu, setConfig, install, fromUrl, remove, snapshot, running, mcpToken, control, onDeviceState, handle, hook, clientFile, API_VERSION };
};
module.exports.API_VERSION = API_VERSION;
