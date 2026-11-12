'use strict';
const EventEmitter = require('events');

const TYPES = ['switch', 'light', 'sensor', 'binary', 'thermostat', 'event', 'cover', 'lock'];
const Z2M_SENSORS = {
  temperature: 'Temperatur', humidity: 'Feuchte', battery: 'Batterie', power: 'Leistung', energy: 'Energie',
  illuminance: 'Helligkeit', illuminance_lux: 'Helligkeit', pressure: 'Druck', co2: 'CO2', voltage: 'Spannung',
};
const Z2M_BINARY = ['contact', 'occupancy', 'presence', 'water_leak', 'smoke', 'vibration', 'tamper'];

// Punkt-Pfad mit Filtern: "common_list[id=0x0B].val", "data[0].x"
function getPath(o, p) {
  if (!p) return o;
  let cur = o;
  for (const tok of String(p).split('.')) {
    if (cur == null) return undefined;
    const m = /^([^[\]]*)((?:\[[^\]]+\])*)$/.exec(tok);
    if (!m) return undefined;
    if (m[1]) cur = cur[m[1]];
    for (const f of m[2].match(/\[[^\]]+\]/g) || []) {
      if (cur == null) return undefined;
      const inner = f.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq > 0 && Array.isArray(cur)) cur = cur.find((x) => x && String(x[inner.slice(0, eq)]) === inner.slice(eq + 1));
      else cur = cur[inner];
    }
  }
  return cur;
}

// gültiger MQTT-Subscribe-Filter (kein leerer String, # nur am Ende, +/# nur als ganze Ebene)
function validFilter(t) {
  if (!t || t.length > 65535 || t.includes('\u0000')) return false;
  const parts = t.split('/');
  return parts.every((p, i) => (p === '#' ? i === parts.length - 1 : p === '+' || !/[#+]/.test(p)));
}

class Devices extends EventEmitter {
  constructor(store, log) {
    super();
    this.store = store;
    this.log = log;
    this.states = new Map();
    this.mqtt = null;
    this.mqttOk = false;
    this.mqttError = '';
    this.subs = new Set();
    this.index = new Map();
    this.z2m = [];
    this.tasmota = new Map();
    this.tasmotaCfg = new Map();
    this.shmotion = new Map();
    this.shellyTimer = null;
    this.httpTimer = null;
    this.shFail = new Map();      // Geräte-ID -> aufeinanderfolgende Fehlversuche
    this.macTry = new Map();      // Geräte-ID -> letzter Versuch, die MAC zu lernen
    this.finding = false;
    this.findLast = 0;
    this.findMiss = 0;
  }

  get list() { return this.store.cfg.devices; }
  byId(id) { return this.list.find((d) => d.id === id); }

  // ---------- MQTT ----------
  connectMqtt() {
    this.disconnectMqtt();
    const c = this.store.cfg.mqtt;
    if (!c.url) { this.mqttError = 'Nicht konfiguriert'; return; }
    let mqtt;
    try { mqtt = require('mqtt'); } catch { this.mqttError = 'Paket "mqtt" fehlt (npm install ausführen)'; return; }
    this.mqttError = '';
    const cl = mqtt.connect(c.url, {
      username: c.user || undefined, password: c.pass || undefined,
      reconnectPeriod: 5000, connectTimeout: 10000,
    });
    this.mqtt = cl;
    cl.on('connect', () => {
      this.mqttOk = true;
      this._z2mAsked = false;
      this.mqttError = '';
      this.subs.clear();
      this.syncSubs();
      this.requestStates();
      this.log('info', 'MQTT verbunden');
      this.emit('status');
    });
    cl.on('close', () => {
      const was = this.mqttOk;
      this.mqttOk = false;
      this.emit('status');
      const now = Date.now();
      if (was && now - (this.lastCloseLog || 0) > 30000) {
        this.lastCloseLog = now;
        this.log('warn', `MQTT-Verbindung vom Broker getrennt${this.mqttError ? ' (' + this.mqttError + ')' : ''} – Ursache steht im Broker-Log`);
      }
    });
    cl.on('disconnect', (pkt) => this.log('warn', 'MQTT: Broker sendet DISCONNECT ' + JSON.stringify(pkt)));
    cl.on('error', (e) => { this.mqttError = e.message; if (e.message !== this.lastErr) { this.lastErr = e.message; this.log('warn', 'MQTT-Fehler: ' + e.message); } });
    cl.on('message', (t, buf) => this.onMessage(t, buf.toString()));
  }

  disconnectMqtt() {
    if (this.mqtt) { try { this.mqtt.end(true); } catch { /* ignore */ } }
    this.mqtt = null;
    this.mqttOk = false;
    this.subs = new Set();
  }

  discoveryTopics() {
    return [`${this.store.cfg.mqtt.z2mBase}/bridge/devices`, 'tele/+/STATE', 'tasmota/discovery/+/config', 'shellies/+/info', 'shellies/+/status'];
  }

  rebuild() {
    this.index = new Map();
    for (const d of this.list) {
      if (d.driver !== 'mqtt') continue;
      for (const t of d.stateTopics || []) {
        if (!this.index.has(t)) this.index.set(t, []);
        this.index.get(t).push(d);
      }
    }
    this.syncSubs();
    for (const d of this.list) {
      if (d.driver === 'virtual' && !this.states.has(d.id)) this.states.set(d.id, { on: !!d.value, ts: Date.now() });
    }
    this.resolveTasmota();
    this.startShelly();
    this.startHttp();
  }

  syncSubs() {
    if (!this.mqtt || !this.mqttOk) return;
    const want = new Set([...this.index.keys(), ...this.discoveryTopics(), ...(this.extraSubs ? this.extraSubs.keys() : [])]);
    for (const t of want) {
      if (this.subs.has(t)) continue;
      this.subs.add(t);
      if (!validFilter(t)) { this.log('warn', `MQTT: ungültiges Topic übersprungen: „${t}“`); continue; }
      this.mqtt.subscribe(t, (err, granted) => {
        if (err) this.log('warn', `MQTT subscribe „${t}“: ${err.message}`);
        else if (granted && granted.some((g) => g.qos === 128)) this.log('warn', `MQTT: Broker verweigert Subscribe auf „${t}“ (ACL/Berechtigung)`);
      });
    }
    for (const t of [...this.subs]) if (!want.has(t)) { this.subs.delete(t); if (validFilter(t)) this.mqtt.unsubscribe(t); }
  }

  // zusätzliche Abos (Plugins): Filter -> Anzahl Nutzer
  addSub(filter) { if (!this.extraSubs) this.extraSubs = new Map(); this.extraSubs.set(filter, (this.extraSubs.get(filter) || 0) + 1); this.syncSubs(); }
  removeSub(filter) { if (!this.extraSubs) return; const n = (this.extraSubs.get(filter) || 0) - 1; if (n > 0) this.extraSubs.set(filter, n); else this.extraSubs.delete(filter); this.syncSubs(); }

  publish(topic, payload, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.mqtt || !this.mqttOk) return reject(new Error('MQTT nicht verbunden'));
      this.mqtt.publish(topic, String(payload), { qos: opts.qos === 1 ? 1 : 0, retain: !!opts.retain }, (e) => (e ? reject(e) : resolve()));
    });
  }

  requestStates() {
    if (!this.mqttOk) return;
    this.publish(`cmnd/${this.store.cfg.mqtt.tasmotaGroup || 'tasmotas'}/STATE`, '').catch(() => {});
    for (const d of this.list) {
      if (d.driver === 'mqtt' && d.get && d.get.topic) this.publish(d.get.topic, d.get.payload || '').catch(() => {});
    }
  }

  // Mithören (MQTT-Monitor): sammelt Nachrichten zu einem Topic-Filter für einige Sekunden
  peek(filter, seconds = 20) {
    return new Promise((resolve, reject) => {
      if (!this.mqtt || !this.mqttOk) return reject(new Error('MQTT nicht verbunden'));
      if (!validFilter(filter)) return reject(new Error('Ungültiger Topic-Filter'));
      const re = new RegExp('^' + filter.split('/').map((p) => (p === '#' ? '.*' : p === '+' ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '$');
      const got = new Map();
      let first = 0;
      const onRaw = (t, payload) => {
        if (!re.test(t)) return;
        if (!first) first = Date.now();
        got.set(t, { topic: t, payload: String(payload).slice(0, 4000), ts: Date.now() });
        if (got.size > 60) got.delete(got.keys().next().value);
      };
      this.on('raw', onRaw);
      const had = this.subs.has(filter);
      if (!had) this.mqtt.subscribe(filter);
      const end = Date.now() + Math.max(3, Math.min(30, Number(seconds) || 20)) * 1000;
      const timer = setInterval(() => {
        if (Date.now() < end && !(first && Date.now() - first > 4000)) return;
        clearInterval(timer);
        this.off('raw', onRaw);
        if (!had && this.mqtt) this.mqtt.unsubscribe(filter);
        resolve([...got.values()]);
      }, 300);
    });
  }

  onMessage(topic, payload) {
    this.emit('raw', topic, payload);
    if (topic === `${this.store.cfg.mqtt.z2mBase}/bridge/devices`) this.parseZ2m(payload);
    const tm = /^tele\/([^/]+)\/STATE$/.exec(topic);
    if (tm) this.tasmotaSeen(tm[1], payload);
    const sm = /^shellies\/([^/]+)\/(?:info|status)$/.exec(topic);
    if (sm) this.shellyMotionSeen(sm[1], payload);
    const td = /^tasmota\/discovery\/([^/]+)\/config$/.exec(topic);
    if (td) this.tasmotaConfig(payload);
    for (const d of this.index.get(topic) || []) this.apply(d, payload);
  }

  apply(dev, payload) {
    let parsed;
    try { parsed = JSON.parse(payload); } catch { parsed = undefined; }
    const pick = (p) => {
      if (p === undefined) return undefined;
      if (p === '') return payload;
      if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return undefined;
      return getPath(parsed, p);
    };
    const P = dev.paths || {};
    const prev = { ...(this.states.get(dev.id) || {}) };
    const st = { ...prev };
    let force = false;
    switch (dev.type) {
      case 'switch': case 'light': case 'binary': {
        const v = pick(P.on);
        if (v === undefined || v === null) return;
        st.on = this.isOn(v, dev);
        if (dev.type === 'light') {
          const b = pick(P.brightness);
          if (b !== undefined && b !== null && !isNaN(Number(b))) st.brightness = Math.round((Number(b) / (dev.brightnessMax || 100)) * 100);
        }
        break;
      }
      case 'sensor': {
        const v = pick(P.value);
        if (v === undefined || v === null) return;
        st.value = isNaN(Number(v)) ? String(v) : Number(v);
        break;
      }
      case 'thermostat': {
        const c = pick(P.current);
        const s = pick(P.setpoint);
        if (c !== undefined && !isNaN(Number(c))) st.current = Number(c);
        if (s !== undefined && !isNaN(Number(s))) st.setpoint = Number(s);
        if (c === undefined && s === undefined) return;
        break;
      }
      case 'event': {
        const v = pick(P.value);
        if (v === undefined || v === null || v === '') return;
        st.value = String(v);
        force = true;
        break;
      }
      default: return;
    }
    st.ts = Date.now();
    this.setState(dev, st, prev, force);
  }

  isOn(v, dev) {
    const s = String(v).toLowerCase();
    if (dev.onValue !== undefined && dev.onValue !== '') return s === String(dev.onValue).toLowerCase();
    return ['on', 'true', '1', 'online'].includes(s);
  }

  setState(dev, st, prev, force) {
    this.states.set(dev.id, st);
    const key = (s) => JSON.stringify([s.on, s.brightness, s.value, s.current, s.setpoint, s.power, s.online]);
    if (force || key(st) !== key(prev || {})) this.emit('state', dev, st, prev || {}, force);
  }

  stateString(dev, st = this.states.get(dev.id)) {
    if (!st) return undefined;
    switch (dev.type) {
      case 'switch': case 'light': case 'binary': return st.on === undefined ? undefined : (st.on ? 'on' : 'off');
      case 'sensor': case 'event': return st.value === undefined ? undefined : String(st.value);
      case 'thermostat': return st.current === undefined ? undefined : String(st.current);
      case 'cover': case 'lock': return st.state;
      default: return undefined;
    }
  }

  numeric(dev) {
    const st = this.states.get(dev.id);
    if (!st) return NaN;
    const v = dev.type === 'thermostat' ? st.current : st.value;
    return v === undefined ? NaN : Number(v);
  }

  // ---------- Steuerung ----------
  async control(dev, action, value, by) {
    const st = { ...(this.states.get(dev.id) || {}) };
    const prev = { ...st };
    if (this.isPending(dev)) throw new Error(`„${dev.name}“ ist noch nicht verbunden`);
    if (dev.driver === 'appletv') throw new Error('Apple TV liefert nur Status');
    if (dev.driver === 'dew') throw new Error('Berechneter Wert – nicht steuerbar');
    if (this.history) this.history.mark(dev, by);
    if (dev.driver === 'plugin') return this.plugins.control(dev, action, value);
    if (dev.driver === 'matter') {
      if (!this.matter) throw new Error('Matter nicht aktiv');
      return this.matter.control(dev, action, value);
    }
    if (dev.type === 'cover') {
      if (action === 'toggle') {
        action = st.state === 'open' ? 'close' : st.state === 'opening' || st.state === 'closing' ? 'stop' : 'open';
      }
      if (dev.driver === 'shelly') return this.controlShelly(dev, action, st, prev);
      throw new Error('Rollo/Markise nur über Shelly unterstützt');
    }
    if (action === 'toggle') action = st.on ? 'off' : 'on';
    if (dev.driver === 'virtual') {
      if (action !== 'on' && action !== 'off') throw new Error('Aktion nicht unterstützt: ' + action);
      st.on = action === 'on';
      st.ts = Date.now();
      dev.value = st.on;
      this.store.save();
      this.setState(dev, st, prev);
      return undefined;
    }
    if (dev.driver === 'http') throw new Error('Sensor kann nicht geschaltet werden');
    if (dev.driver === 'shelly') return this.controlShelly(dev, action, st, prev);
    const cmd = dev.cmd || {};
    let topic = cmd.topic;
    let payload;
    switch (action) {
      case 'on': payload = cmd.on; st.on = true; break;
      case 'off': payload = cmd.off; st.on = false; break;
      case 'brightness': {
        const v = Math.max(0, Math.min(100, Number(value)));
        if (cmd.brightness === undefined) throw new Error('Dimmen nicht unterstützt');
        payload = cmd.brightness.replace('{{v}}', Math.round((v / 100) * (dev.brightnessMax || 100)));
        topic = cmd.brightnessTopic || topic;
        st.brightness = v;
        if (v > 0) st.on = true;
        break;
      }
      case 'setpoint': {
        const v = Number(value);
        if (isNaN(v)) throw new Error('Ungültiger Wert');
        if (cmd.setpoint === undefined) throw new Error('Solltemperatur nicht unterstützt');
        payload = cmd.setpoint.replace('{{v}}', v);
        topic = cmd.setpointTopic || topic;
        st.setpoint = v;
        break;
      }
      default: throw new Error('Aktion nicht unterstützt: ' + action);
    }
    if (payload === undefined || !topic) throw new Error('Befehl für dieses Gerät nicht konfiguriert');
    await this.publish(topic, payload);
    st.ts = Date.now();
    this.setState(dev, st, prev);
  }

  // ---------- Shelly (HTTP) ----------
  shellyFetch(dev, path) {
    const headers = {};
    if (dev.user) headers.Authorization = 'Basic ' + Buffer.from(`${dev.user}:${dev.pass || ''}`).toString('base64');
    return fetch(`http://${dev.ip}${path}`, { headers, signal: AbortSignal.timeout(4000) })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  async ensureGen(dev) {
    if (dev.gen === 1 || dev.gen === 2) return;
    const info = await this.shellyFetch(dev, '/shelly');
    dev.gen = Number(info.gen) >= 2 ? 2 : 1;
    this.store.save();
  }

  async pollShelly(dev) {
    try { await this.ensureGen(dev); } catch { /* offline */ }
    const prev = { ...(this.states.get(dev.id) || {}) };
    const st = { ...prev };
    try {
      const ch = dev.channel || 0;
      if (dev.type === 'cover') {
        if (dev.gen === 2) {
          const j = await this.shellyFetch(dev, `/rpc/Cover.GetStatus?id=${ch}`);
          st.state = String(j.state || 'stopped');
        } else {
          const j = await this.shellyFetch(dev, '/status');
          const r = (j.rollers || [])[ch];
          if (!r) throw new Error('Kanal nicht gefunden');
          st.state = { open: 'open', close: 'closed', stop: 'stopped' }[r.state] || String(r.state);
        }
      } else if (dev.gen === 2) {
        const j = await this.shellyFetch(dev, `/rpc/Switch.GetStatus?id=${ch}`);
        st.on = !!j.output;
        if (j.apower !== undefined) st.power = Number(j.apower);
      } else {
        const j = await this.shellyFetch(dev, '/status');
        const r = (j.relays || [])[ch];
        if (!r) throw new Error('Kanal nicht gefunden');
        st.on = !!r.ison;
        const m = (j.meters || [])[ch];
        if (m && m.power !== undefined) st.power = Number(m.power);
      }
      st.online = true;
      this.shFail.delete(dev.id);
      if (!dev.mac) this.learnMac(dev);
    } catch {
      st.online = false;
      const n = (this.shFail.get(dev.id) || 0) + 1;
      this.shFail.set(dev.id, n);
      if (n >= 3 && dev.mac) this.findShellies('Gerät offline');
    }
    st.ts = Date.now();
    this.setState(dev, st, prev);
  }

  async controlShelly(dev, action, st, prev) {
    await this.ensureGen(dev);
    const ch = dev.channel || 0;
    if (dev.type === 'cover') {
      if (!['open', 'close', 'stop'].includes(action)) throw new Error('Aktion nicht unterstützt: ' + action);
      if (dev.gen === 2) await this.shellyFetch(dev, `/rpc/Cover.${action[0].toUpperCase()}${action.slice(1)}?id=${ch}`);
      else await this.shellyFetch(dev, `/roller/${ch}?go=${action}`);
      st.state = action === 'open' ? 'opening' : action === 'close' ? 'closing' : 'stopped';
      st.online = true;
      st.ts = Date.now();
      this.setState(dev, st, prev);
      setTimeout(() => this.pollShelly(dev), 2500);
      return undefined;
    }
    if (action !== 'on' && action !== 'off') throw new Error('Aktion nicht unterstützt: ' + action);
    const on = action === 'on';
    if (dev.gen === 2) await this.shellyFetch(dev, `/rpc/Switch.Set?id=${ch}&on=${on}`);
    else await this.shellyFetch(dev, `/relay/${ch}?turn=${action}`);
    st.on = on;
    st.online = true;
    st.ts = Date.now();
    this.setState(dev, st, prev);
  }

  // MAC-Adresse des Shelly merken (einmalig, danach lässt er sich auch unter neuer IP wiederfinden)
  async learnMac(dev) {
    const now = Date.now();
    if (now - (this.macTry.get(dev.id) || 0) < 600000) return;
    this.macTry.set(dev.id, now);
    try {
      const info = await this.shellyFetch(dev, '/shelly');
      const mac = require('./netfind').normMac(info.mac);
      if (mac.length === 12) { dev.mac = mac; this.store.save(); }
    } catch { /* später erneut */ }
  }

  // Neue IP eines bekannten Shelly übernehmen (aus Scan oder CoIoT-Meldung)
  shellyMoved(mac, ip) {
    let n = 0;
    for (const d of this.list) {
      if (d.driver !== 'shelly' || !d.mac || d.mac !== mac || d.ip === ip) continue;
      this.log('info', `Shelly „${d.name}“ hat jetzt die IP ${ip} (vorher ${d.ip}) – anhand der MAC ${mac} wiedergefunden`);
      d.ip = ip; n++; this.shFail.delete(d.id);
      this.pollShelly(d).catch(() => {});
    }
    if (n) { this.store.save(); this.emit('shelly-moved'); }
    return n;
  }

  // Netzwerk nach Shellys absuchen und geänderte IPs übernehmen (höchstens alle 60 s, bei Misserfolg seltener)
  async findShellies(reason = 'manuell', force = false) {
    if (this.finding) return { running: true };
    const gap = force ? 5000 : Math.min(60000 * 2 ** this.findMiss, 600000);
    if (Date.now() - this.findLast < gap) return { skipped: true };
    this.finding = true; this.findLast = Date.now();
    let moved = 0, seen = 0;
    try {
      const found = await require('./netfind').scan();
      seen = found.size;
      for (const [mac, f] of found) moved += this.shellyMoved(mac, f.ip);
      for (const d of this.list) if (d.driver === 'shelly' && d.ip && !d.mac) { const f = [...found].find(([, v]) => v.ip === d.ip); if (f) { d.mac = f[0]; this.store.save(); } }
      this.findMiss = moved ? 0 : Math.min(this.findMiss + 1, 4);
      this.log('info', `Shelly-Suche (${reason}): ${seen} Gerät(e) im Netz, ${moved} neue IP übernommen`);
    } catch (e) { this.log('warn', 'Shelly-Suche: ' + e.message); this.findMiss = Math.min(this.findMiss + 1, 4); }
    this.finding = false;
    return { seen, moved };
  }

  startShelly() {
    clearInterval(this.shellyTimer);
    let round = 0;
    // Meldet ein Gen1-Shelly per CoIoT, reicht eine Sicherheitsabfrage pro Minute
    const run = () => {
      round++;
      return Promise.allSettled(this.list.filter((d) => d.driver === 'shelly' && d.ip && (round % 6 === 1 || !(this.coiot && this.coiot.fresh(d.ip)))).map((d) => this.pollShelly(d)));
    };
    run();
    this.shellyTimer = setInterval(run, 10000);
  }

  // ---------- HTTP-Sensoren (JSON-Abfrage, z. B. Ecowitt, Open-Meteo) ----------
  async pollHttp(dev) {
    const prev = { ...(this.states.get(dev.id) || {}) };
    const st = { ...prev };
    try {
      const r = await fetch(dev.url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const raw = getPath(j, dev.jsonPath);
      const n = parseFloat(String(raw));
      if (isNaN(n)) throw new Error('Kein Zahlenwert unter ' + dev.jsonPath);
      st.value = Math.round(n * (Number(dev.scale) || 1) * 100) / 100;
      st.online = true;
    } catch (e) {
      st.online = false;
      st.error = e.message;
    }
    st.ts = Date.now();
    this.setState(dev, st, prev);
  }

  startHttp() {
    clearInterval(this.httpTimer);
    const due = new Map();
    const run = () => {
      const now = Date.now();
      for (const d of this.list.filter((x) => x.driver === 'http' && x.url)) {
        if ((due.get(d.id) || 0) > now) continue;
        due.set(d.id, now + Math.max(10, Number(d.interval) || 60) * 1000);
        this.pollHttp(d);
      }
    };
    run();
    this.httpTimer = setInterval(run, 5000);
  }

  isPending(dev) {
    if (dev.pending) return true;
    switch (dev.driver) {
      case 'mqtt': return !((dev.stateTopics && dev.stateTopics.length) || (dev.cmd && dev.cmd.topic));
      case 'shelly': return !dev.ip;
      case 'http': return !dev.url;
      case 'plugin': return !(this.plugins && this.plugins.running(dev.plugin));
      default: return false;
    }
  }

  async probeShelly(ip, user, pass) {
    const dev = { ip, user, pass };
    const info = await this.shellyFetch(dev, '/shelly');
    const gen = Number(info.gen) >= 2 ? 2 : 1;
    const base = info.name || info.id || ip;
    if (/^SHMOS-0[12]$/.test(info.type || '')) {
      const mac = String(info.mac || '').toUpperCase();
      if (!mac) throw new Error('MAC-Adresse nicht lesbar');
      return Devices.shellyMotionItems(`${info.type === 'SHMOS-02' ? 'shellymotion2' : 'shellymotionsensor'}-${mac}`);
    }
    let count = 0;
    if (gen === 2) {
      const s = await this.shellyFetch(dev, '/rpc/Shelly.GetStatus');
      count = Object.keys(s).filter((k) => /^switch:\d+$/.test(k)).length;
    } else {
      const s = await this.shellyFetch(dev, '/settings');
      count = (s.relays || []).length;
    }
    if (!count) throw new Error('Keine Schaltkanäle gefunden');
    return Array.from({ length: count }, (_, i) => ({
      key: `shelly:${ip}:${i}`, name: count > 1 ? `${base} ${i + 1}` : base, type: 'switch',
      driver: 'shelly', ip, gen, channel: i, user: user || '', pass: pass || '',
    }));
  }

  // Nach dem (Wieder-)Verbinden aktuelle Werte der Zigbee-Geräte bei Zigbee2MQTT anfragen (nur Eigenschaften mit „get“-Unterstützung)
  askZ2mStates() {
    if (this._z2mAsked || !this.mqttOk || !this.z2mGets || !this.z2mGets.length) return;
    this._z2mAsked = true;
    const list = [...this.z2mGets];
    list.forEach((g, i) => { const t = setTimeout(() => { this.publish(g.topic, g.payload).catch(() => {}); }, 3000 + i * 150); if (t.unref) t.unref(); });
  }

  // ---------- Entdeckung ----------
  parseZ2m(payload) {
    let arr;
    try { arr = JSON.parse(payload); } catch { return; }
    if (!Array.isArray(arr)) return;
    const base = this.store.cfg.mqtt.z2mBase;
    const out = [];
    const gets = [];
    for (const d of arr) {
      if (d.type === 'Coordinator' || !d.friendly_name) continue;
      const name = d.friendly_name;
      const topic = `${base}/${name}`;
      const set = `${topic}/set`;
      const stateTopics = [topic];
      const exposes = (d.definition && d.definition.exposes) || [];
      const getProps = [];
      for (const e of exposes) {
        const feats = e.features || [];
        for (const f of (feats.length ? feats : [e])) if (f.property && typeof f.access === 'number' && (f.access & 4) && !getProps.includes(f.property)) getProps.push(f.property);
        const sfx = e.endpoint ? ` ${e.endpoint}` : '';
        if (e.type === 'light' || e.type === 'switch') {
          const f = feats.find((x) => x.name === 'state');
          if (!f) continue;
          const b = feats.find((x) => x.name === 'brightness');
          out.push({
            key: `z2m:${name}:${e.type}:${f.property}`, name: name + sfx, type: e.type, driver: 'mqtt', stateTopics,
            paths: { on: f.property, ...(b ? { brightness: b.property } : {}) }, brightnessMax: 254,
            cmd: {
              topic: set, on: `{"${f.property}":"ON"}`, off: `{"${f.property}":"OFF"}`,
              ...(b ? { brightness: `{"${b.property}":{{v}}}` } : {}),
            },
            get: { topic: `${topic}/get`, payload: `{"${f.property}":""}` },
          });
        } else if (e.type === 'climate') {
          const sp = feats.find((x) => x.name === 'occupied_heating_setpoint') || feats.find((x) => x.name === 'current_heating_setpoint');
          const cur = feats.find((x) => x.name === 'local_temperature');
          out.push({
            key: `z2m:${name}:climate`, name: name + sfx, type: 'thermostat', driver: 'mqtt', stateTopics,
            paths: { current: cur ? cur.property : 'local_temperature', setpoint: sp ? sp.property : undefined },
            cmd: sp ? { topic: set, setpoint: `{"${sp.property}":{{v}}}` } : { topic: set },
          });
        } else if (e.type === 'numeric' && Z2M_SENSORS[e.name]) {
          out.push({
            key: `z2m:${name}:${e.property}`, name: `${name} ${Z2M_SENSORS[e.name]}`, type: 'sensor', driver: 'mqtt', stateTopics,
            paths: { value: e.property }, unit: e.unit || '',
          });
        } else if (e.type === 'binary' && Z2M_BINARY.includes(e.name)) {
          out.push({
            key: `z2m:${name}:${e.property}`, name: `${name} ${e.name}`, type: 'binary', driver: 'mqtt', stateTopics,
            paths: { on: e.property }, onValue: String(e.value_on),
          });
        } else if (e.type === 'enum' && e.property === 'action') {
          out.push({
            key: `z2m:${name}:action`, name: `${name} Taster`, type: 'event', driver: 'mqtt', stateTopics, paths: { value: 'action' },
          });
        }
      }
      if (getProps.length && d.supported !== false) gets.push({ topic: `${topic}/get`, payload: JSON.stringify(Object.fromEntries(getProps.map((x) => [x, '']))) });
    }
    this.z2m = out;
    this.z2mGets = gets;
    this.askZ2mStates();
    this.emit('status');
  }

  // Shelly Motion / Motion 2 (Batteriegerät, sendet per MQTT beim Aufwachen)
  static shellyMotionItems(id) {
    const topics = [`shellies/${id}/info`, `shellies/${id}/status`];
    const mac = (/-([0-9A-Fa-f]{12})$/.exec(id) || [])[1];
    const model = /motion2/i.test(id) ? 'Shelly Motion 2' : /motion/i.test(id) ? 'Shelly Motion' : id;
    const label = mac ? `${model} (${mac.slice(-4).toUpperCase()})` : model;
    const mk = (k, name, type, path, unit) => ({ key: `shellymotion:${id}:${k}`, name: `${label} ${name}`, type, driver: 'mqtt', stateTopics: topics, paths: type === 'binary' ? { on: path } : { value: path }, unit: unit || '' });
    return [mk('motion', 'Bewegung', 'binary', 'sensor.motion'), mk('vibration', 'Erschütterung', 'binary', 'sensor.vibration'), mk('lux', 'Helligkeit', 'sensor', 'lux.value', 'lx'), mk('temp', 'Temperatur', 'sensor', 'tmp.value', '°C'), mk('bat', 'Batterie', 'sensor', 'bat.value', '%')];
  }

  shellyMotionSeen(id, payload) {
    let j;
    try { j = JSON.parse(payload); } catch { return; }
    if (!j || typeof j !== 'object' || !j.sensor || typeof j.sensor !== 'object' || j.sensor.motion === undefined) return;
    if (!this.shmotion.has(id)) this.shmotion.set(id, Devices.shellyMotionItems(id));
  }

  tasmotaSeen(t, payload) {
    let j;
    try { j = JSON.parse(payload); } catch { return; }
    const relays = Object.keys(j).filter((k) => /^POWER\d*$/.test(k));
    if (!relays.length) return;
    const out = relays.map((k) => ({
      key: `tasmota:${t}:${k}`,
      name: relays.length > 1 ? `${t} ${k.replace('POWER', '') || 1}` : t,
      type: j.Dimmer !== undefined ? 'light' : 'switch', driver: 'mqtt',
      stateTopics: [`stat/${t}/RESULT`, `tele/${t}/STATE`],
      paths: { on: k, ...(j.Dimmer !== undefined ? { brightness: 'Dimmer' } : {}) }, brightnessMax: 100,
      cmd: {
        topic: `cmnd/${t}/${k}`, on: 'ON', off: 'OFF',
        ...(j.Dimmer !== undefined ? { brightnessTopic: `cmnd/${t}/Dimmer`, brightness: '{{v}}' } : {}),
      },
      get: { topic: `cmnd/${t}/${k}`, payload: '' },
    }));
    this.tasmota.set(t, out);
  }

  tasmotaConfig(payload) {
    let j;
    try { j = JSON.parse(payload); } catch { return; }
    if (!j || !j.mac || !j.t) return;
    this.tasmotaCfg.set(String(j.mac).toUpperCase(), { topic: j.t, relays: (j.rl || []).filter((x) => x > 0).length, ip: j.ip || '', name: j.dn || j.t });
    this.resolveTasmota();
  }

  // Importierte Tasmota-Geräte (nur MAC bekannt) mit dem echten Topic verbinden
  resolveTasmota() {
    let changed = false;
    for (const d of this.list) {
      if (!d.tasmota || !d.tasmota.mac || !d.pending) continue;
      const c = this.tasmotaCfg.get(String(d.tasmota.mac).toUpperCase());
      if (!c) continue;
      const k = c.relays > 1 ? `POWER${d.tasmota.relay || 1}` : 'POWER';
      d.driver = 'mqtt';
      d.stateTopics = [`stat/${c.topic}/RESULT`, `tele/${c.topic}/STATE`];
      d.paths = { on: k };
      d.cmd = { topic: `cmnd/${c.topic}/${k}`, on: 'ON', off: 'OFF' };
      d.get = { topic: `cmnd/${c.topic}/${k}`, payload: '' };
      d.pending = false;
      d.note = `Tasmota „${c.topic}“ ${k}`;
      changed = true;
    }
    if (changed) {
      this.store.save();
      this.rebuild();
      this.requestStates();
      this.log('info', 'Tasmota-Geräte aus Import verbunden');
    }
  }

  discovery() {
    const have = new Set(this.list.map((d) => d.src).filter(Boolean));
    const mark = (c) => ({ ...c, added: have.has(c.key) });
    return {
      mqtt: this.mqttOk,
      z2m: this.z2m.map(mark),
      tasmota: [...this.tasmota.values()].flat().map(mark),
      shelly: [...this.shmotion.values()].flat().map(mark),
    };
  }

  snapshot() {
    const o = {};
    for (const [id, st] of this.states) o[id] = st;
    return o;
  }

  // Werte, die Zigbee-/MQTT-Sensoren nur bei Änderung melden (Präsenz, Helligkeit …), überleben einen Neustart
  persistable(dev) { return dev && dev.driver === 'mqtt' && ['sensor', 'binary', 'thermostat'].includes(dev.type); }
  restoreStates() {
    let saved; try { saved = this.store.kvGet && this.store.kvGet('laststates'); } catch { saved = null; }
    if (!saved || typeof saved !== 'object') return;
    for (const dev of this.list) {
      const st = saved[dev.id];
      if (st && typeof st === 'object' && this.persistable(dev) && !this.states.has(dev.id)) this.states.set(dev.id, { ...st, restored: true });
    }
  }
  saveStatesSoon() {
    if (this._saveT) return;
    this._saveT = setTimeout(() => {
      this._saveT = null;
      try {
        const o = {};
        for (const dev of this.list) { const st = this.states.get(dev.id); if (st && this.persistable(dev)) { const { restored, ...rest } = st; o[dev.id] = rest; } }
        this.store.kvSet('laststates', o);
      } catch { /* egal */ }
    }, 30000);
    if (this._saveT.unref) this._saveT.unref();
  }

  start() {
    if (!this._restored) { this._restored = true; this.restoreStates(); this.on('state', (dev) => { if (this.persistable(dev)) this.saveStatesSoon(); }); }
    this.connectMqtt();
    this.rebuild();
  }
}

Devices.TYPES = TYPES;
module.exports = Devices;
