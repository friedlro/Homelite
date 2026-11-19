'use strict';
// Zigbee über Zigbee2MQTT (MQTT-Broker von HomeLite). Zigbee2MQTT verwaltet den Dongle
// (Sonoff ZBDongle-E/-P, ConBee II/III, SkyConnect …), HomeLite bildet die Geräte ab und steuert sie.
const fs = require('fs');
const net = require('net');
const os = require('os');
const http = require('http');
const dns = require('dns').promises;

const LABEL = { temperature: 'Temperatur', humidity: 'Feuchte', pressure: 'Luftdruck', illuminance: 'Helligkeit', illuminance_lux: 'Helligkeit', power: 'Leistung', energy: 'Energie', voltage: 'Spannung', current: 'Strom', co2: 'CO₂', voc: 'VOC', pm25: 'Feinstaub', battery: 'Batterie', soil_moisture: 'Bodenfeuchte', linkquality: 'Verbindung', local_temperature: 'Temperatur', position: 'Position', distance: 'Abstand' };
const BIN = { occupancy: 'Bewegung', presence: 'Präsenz', water_leak: 'Wasser', smoke: 'Rauch', vibration: 'Vibration', tamper: 'Sabotage', gas: 'Gas', carbon_monoxide: 'CO', battery_low: 'Batterie schwach', contact: 'Kontakt' };
const ADAPTERS = {
  max: 'Sonoff Dongle Max (Dongle-M, EFR32MG24) – USB oder Netzwerk („ember“)',
  ember: 'Sonoff ZBDongle-E / Dongle Max / SkyConnect / ZBT-1 (EFR32, „ember“)',
  zstack: 'Sonoff ZBDongle-P, CC2652/CC1352 („zstack“)',
  deconz: 'ConBee II / ConBee III / RaspBee („deconz“)',
  zboss: 'nRF52840-Dongles („zboss“)',
  ezsp: 'Ältere EFR32-Dongles (ezsp, nur wenn ember nicht geht)',
};

module.exports = (api) => {
  let base = 'zigbee2mqtt';
  let bridge = { state: 'unknown' }, info = {};
  const devs = new Map();    // friendly_name -> { ieee, name, def, type, interviewed, supported, disabled, power, state, avail, lastSeen }
  const byIeee = new Map();
  const specs = new Map();   // key -> { ieee, write }
  const events = [], logs = [];
  let unsub = null;

  const cfg = () => api.config() || {};
  const pushEv = (txt) => { events.unshift({ t: Date.now(), txt }); events.length = Math.min(events.length, 40); };

  // ---------- Expose → Geräte ----------
  const readable = (e) => e.access === undefined || (e.access & 1) === 1;
  const writable = (e) => e.access !== undefined && (e.access & 2) === 2;

  function build(d) {
    const out = [];
    const room = cfg().room || '';
    const exposes = (d.def && d.def.exposes) || [];
    const send = (obj) => publish(d.name + '/set', obj);
    for (const e of exposes) {
      const feats = e.features || [];
      const ep = e.endpoint ? ` ${e.endpoint}` : '';
      const k = (s) => `zb:${d.ieee}:${s}`;
      if (e.type === 'light' || e.type === 'switch') {
        const f = feats.find((x) => x.name === 'state'); if (!f) continue;
        const b = feats.find((x) => x.name === 'brightness');
        const max = (b && b.value_max) || 254;
        const von = f.value_on === undefined ? 'ON' : f.value_on, voff = f.value_off === undefined ? 'OFF' : f.value_off;
        out.push({
          key: k(`${e.type}:${f.property}`), name: d.name + ep, type: b ? 'light' : e.type, room,
          pick: (s) => {
            if (s[f.property] === undefined) return null;
            const p = { on: s[f.property] === von };
            if (b && typeof s[b.property] === 'number') p.brightness = Math.round(s[b.property] * 100 / max);
            return p;
          },
          write: (action, value) => {
            if (action === 'toggle') { send({ [f.property]: 'TOGGLE' }); return null; }
            if (action === 'on') { send({ [f.property]: von }); return { on: true }; }
            if (action === 'off') { send({ [f.property]: voff }); return { on: false }; }
            if (action === 'brightness' && b) { const v = Math.max(0, Math.min(100, Number(value))); send(v === 0 ? { [f.property]: voff } : { [b.property]: Math.max(1, Math.round(v * max / 100)) }); return { on: v > 0, brightness: v }; }
            throw new Error('Aktion nicht unterstützt: ' + action);
          },
        });
      } else if (e.type === 'lock') {
        const f = feats.find((x) => x.name === 'state'); if (!f) continue;
        out.push({
          key: k('lock'), name: d.name + ep, type: 'lock', room,
          pick: (s) => (s[f.property] === undefined ? null : { state: s[f.property] === 'LOCK' ? 'locked' : 'unlocked', on: s[f.property] === 'LOCK' }),
          write: (action) => {
            const lockIt = action === 'lock' || action === 'on' ? true : action === 'unlock' || action === 'off' ? false : null;
            if (lockIt === null) throw new Error('Aktion nicht unterstützt: ' + action);
            send({ [f.property]: lockIt ? 'LOCK' : 'UNLOCK' }); return { state: lockIt ? 'locked' : 'unlocked', on: lockIt };
          },
        });
      } else if (e.type === 'climate') {
        const sp = feats.find((x) => x.name === 'occupied_heating_setpoint') || feats.find((x) => x.name === 'current_heating_setpoint');
        const cur = feats.find((x) => x.name === 'local_temperature');
        out.push({
          key: k('climate' + (e.endpoint ? ':' + e.endpoint : '')), name: d.name + ep, type: 'thermostat', unit: '°C', room,
          pick: (s) => { const p = {}; if (sp && typeof s[sp.property] === 'number') p.setpoint = s[sp.property]; if (cur && typeof s[cur.property] === 'number') p.current = s[cur.property]; return Object.keys(p).length ? p : null; },
          write: (action, value) => {
            if (action !== 'setpoint' || !sp) throw new Error('Aktion nicht unterstützt: ' + action);
            const v = Number(value); if (!isFinite(v)) throw new Error('Zahl erwartet');
            send({ [sp.property]: v }); return { setpoint: v };
          },
        });
      } else if (e.type === 'numeric' && readable(e) && !writable(e)) {
        if (e.name === 'battery' && cfg().batteries === false) continue;
        if (e.name === 'linkquality' && !cfg().linkquality) continue;
        out.push({
          key: k('n:' + e.property), name: `${d.name}${ep} ${LABEL[e.name] || e.label || e.name}`, type: 'sensor', unit: e.unit || '', room,
          pick: (s) => (typeof s[e.property] === 'number' ? { value: Math.round(s[e.property] * 1000) / 1000 } : null),
        });
      } else if (e.type === 'binary' && BIN[e.name] && readable(e) && !writable(e)) {
        const von = e.value_on;
        const open = e.name === 'contact';          // Z2M definiert value_on=false → „an“ = offen
        out.push({
          key: k('b:' + e.property), name: `${d.name}${ep} ${open ? 'Kontakt (an = offen)' : BIN[e.name]}`, type: 'binary', room,
          pick: (s) => (s[e.property] === undefined ? null : { on: s[e.property] === von }),
        });
      } else if (e.type === 'enum' && e.property === 'action') {
        out.push({ key: k('action'), name: `${d.name}${ep} Taster`, type: 'event', room, pick: (s) => (s.action ? { value: String(s.action) } : null) });
      }
    }
    return out;
  }

  function sync(d) {
    for (const s of build(d)) {
      try {
        const spec = { ...s, ieee: d.ieee };
        specs.set(s.key, spec);
        api.devices.ensure({ key: s.key, name: s.name, room: s.room, type: s.type, unit: s.unit || '' });
        const patch = d.state ? s.pick(d.state) : null;
        api.devices.setState(s.key, { ...(patch || {}), online: d.avail !== false });
      } catch (e) { api.log('warn', `Gerät ${s.key}: ${e.message}`); }
    }
  }

  function applyState(d, st) {
    d.state = { ...(d.state || {}), ...st }; d.lastSeen = Date.now();
    for (const [key, sp] of specs) {
      if (sp.ieee !== d.ieee || !sp.pick) continue;
      const p = sp.pick(st);
      if (p) { try { api.devices.setState(key, { ...p, online: d.avail !== false }); } catch { /* noch nicht angelegt */ } }
    }
  }

  function setDevices(arr) {
    const seen = new Set();
    for (const x of arr) {
      if (!x || x.type === 'Coordinator' || !x.friendly_name || !x.ieee_address) continue;
      const old = byIeee.get(x.ieee_address);
      const d = old || { ieee: x.ieee_address, state: null, avail: undefined, lastSeen: 0 };
      if (old && old.name !== x.friendly_name) { devs.delete(old.name); pushEv(`„${old.name}“ umbenannt in „${x.friendly_name}“`); }
      Object.assign(d, { name: x.friendly_name, type: x.type, def: x.definition || null, supported: x.supported !== false, interviewed: x.interview_completed !== false && !x.interviewing, interviewing: !!x.interviewing, disabled: !!x.disabled, power: x.power_source || '', net: x.network_address });
      devs.set(d.name, d); byIeee.set(d.ieee, d); seen.add(d.ieee);
      if (d.def && !d.disabled) sync(d);
    }
    for (const [ieee, d] of [...byIeee]) {
      if (seen.has(ieee)) continue;
      byIeee.delete(ieee); devs.delete(d.name);
      for (const [key, sp] of [...specs]) if (sp.ieee === ieee) { try { api.devices.remove(key); } catch { /* weg */ } specs.delete(key); }
      pushEv(`„${d.name}“ entfernt`);
    }
    push();
  }

  // ---------- MQTT ----------
  function publish(rel, obj) { api.mqtt.publish(`${base}/${rel}`, obj); }
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  function onMsg(topic, payload) {
    const rel = topic.slice(base.length + 1);
    if (rel === 'bridge/state') { const j = parse(payload); bridge.state = j && j.state ? j.state : String(payload).trim(); if (bridge.state !== 'online') for (const d of byIeee.values()) { d.avail = false; for (const [key, sp] of specs) if (sp.ieee === d.ieee) { try { api.devices.setState(key, { online: false }); } catch { /* egal */ } } } return push(); }
    if (rel === 'bridge/info') { info = parse(payload) || {}; return push(); }
    if (rel === 'bridge/devices') { const j = parse(payload); if (Array.isArray(j)) setDevices(j); return; }
    if (rel === 'bridge/logging') { const j = parse(payload); if (j && j.message) { logs.unshift({ t: Date.now(), level: j.level || 'info', msg: String(j.message).slice(0, 300) }); logs.length = Math.min(logs.length, 40); push(); } return; }
    if (rel === 'bridge/event') {
      const j = parse(payload); if (!j) return;
      const n = j.data && (j.data.friendly_name || j.data.ieee_address);
      const txt = { device_joined: `Neues Gerät beigetreten: ${n}`, device_interview: `Einlesen von ${n}: ${j.data && j.data.status}${j.data && j.data.supported === false ? ' (nicht unterstützt)' : ''}`, device_leave: `Gerät hat das Netz verlassen: ${n}`, device_announce: null }[j.type];
      if (txt) { pushEv(txt); if (j.type === 'device_interview' && j.data && j.data.status === 'successful') api.notify('Zigbee', `Neues Gerät eingelesen: ${n}`); push(); }
      return;
    }
    if (rel === 'bridge/response/options') { const j = parse(payload); if (j) { pushEv(j.status === 'ok' ? 'Einstellung gespeichert' + (j.data && j.data.restart_required ? ' – Neustart von Zigbee2MQTT nötig' : '') : `Einstellung abgelehnt: ${j.error || 'Fehler'}`); push(); } return; }
    if (rel.startsWith('bridge/')) return;
    if (rel.endsWith('/availability')) {
      const d = devs.get(rel.slice(0, -13)); if (!d) return;
      const j = parse(payload); d.avail = (j && j.state ? j.state : String(payload).trim()) === 'online';
      for (const [key, sp] of specs) if (sp.ieee === d.ieee) { try { api.devices.setState(key, { online: d.avail }); } catch { /* egal */ } }
      return push();
    }
    if (rel.endsWith('/set') || rel.endsWith('/get')) return;
    const d = devs.get(rel); if (!d) return;
    const st = parse(payload); if (st && typeof st === 'object' && !Array.isArray(st)) applyState(d, st);
  }

  api.devices.onCommand(async (dev, action, value) => {
    const sp = specs.get(dev.key);
    if (!sp || !sp.write) throw new Error('Gerät nicht steuerbar');
    if (bridge.state !== 'online') throw new Error('Zigbee2MQTT ist nicht erreichbar');
    return sp.write(action, value) || {};
  });

  // ---------- Dongle (Koordinator): verbunden? ----------
  // Verbunden heißt: Zigbee2MQTT ist online und meldet einen Koordinator. Ist es nicht online, wird (wenn die Adresse
  // des Netzwerk-Dongles bekannt ist) geprüft, ob Port 6638 antwortet, und der letzte Fehler aus dem Protokoll gezeigt.
  const dg = { host: (api.kv.get('dongleHost') || '') , ip: '', reachable: null, ts: 0, msg: '' };
  const probeDongle = async () => {
    if (!dg.host) { dg.reachable = null; return; }
    try {
      let ip = dg.host; if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) ip = (await dns.lookup(dg.host, { family: 4 })).address;
      dg.ip = ip; dg.reachable = await tcpOpen(ip, 6638, 2000); dg.msg = '';
    } catch { dg.reachable = false; dg.msg = 'Name nicht auflösbar'; }
    dg.ts = Date.now(); push();
  };
  const lastDongleError = () => { const e = logs.find((l) => (l.level === 'error' || l.level === 'warning') && /adapter|serial|herdsman|ember|rstack|stack|port|ECONN|EHOST|timed? ?out|coordinator|tcp/i.test(l.msg)); return e ? { t: e.t, msg: e.msg } : null; };
  const dongleInfo = () => {
    const c = info.coordinator;
    const connected = bridge.state === 'online' && !!c;
    return { connected, type: c ? c.type : '', rev: c && c.meta ? (c.meta.revision || c.meta.maintrel || '') : '', ieee: c ? c.ieee_address || '' : '', host: dg.host, ip: dg.ip, reachable: dg.reachable, checked: dg.ts, msg: dg.msg, error: connected ? null : lastDongleError() };
  };
  api.route('POST', 'donglehost', async ({ body }) => {
    dg.host = String((body && body.host) || '').replace(/[^\w.\-]/g, ''); api.kv.set('dongleHost', dg.host); dg.reachable = null; dg.ip = '';
    await probeDongle(); return model();
  });
  api.timer(() => { if (bridge.state !== 'online') probeDongle(); }, 30000);
  api.after(() => probeDongle(), 3000);

  // ---------- Oberfläche ----------
  const model = () => ({
    base, bridge: bridge.state, mqtt: api.mqtt.connected(), version: info.version || '', coordinator: info.coordinator ? { type: info.coordinator.type, rev: info.coordinator.meta && (info.coordinator.meta.revision || info.coordinator.meta.maintrel) } : null,
    join: info.permit_join_end ? Math.max(0, info.permit_join_end) : (info.permit_join ? Date.now() + 60000 : 0), frontend: cfg().frontend || '',
    devices: [...byIeee.values()].sort((a, b) => a.name.localeCompare(b.name, 'de')).map((d) => ({
      ieee: d.ieee, name: d.name, type: d.type, model: d.def ? `${d.def.vendor || ''} ${d.def.model || ''}`.trim() : '', desc: d.def ? d.def.description : '', supported: d.supported, interviewed: d.interviewed, interviewing: d.interviewing, disabled: d.disabled,
      power: d.power, online: d.avail, lastSeen: d.lastSeen, lqi: d.state && d.state.linkquality, battery: d.state && typeof d.state.battery === 'number' ? d.state.battery : null,
      count: [...specs.values()].filter((s) => s.ieee === d.ieee).length,
    })),
    dongle: dongleInfo(), network: info.network ? { channel: info.network.channel, pan: info.network.pan_id } : null,
    channelConfig: info.config && info.config.advanced ? info.config.advanced.channel : null, restartRequired: !!info.restart_required,
    events, logs,
  });
  const push = () => { try { api.emit({ model: model() }); } catch { /* egal */ } };
  const req = (path, obj) => { if (!api.mqtt.connected()) throw new Error('MQTT-Broker nicht verbunden'); publish('bridge/request/' + path, obj); };

  api.route('GET', 'model', () => model());
  api.route('POST', 'permit', ({ body }) => { const t = Math.max(0, Math.min(254, Number(body && body.time) || 0)); req('permit_join', { time: t }); if (t) pushEv(`Anlernen für ${t} s geöffnet`); return { ok: true }; });
  api.route('POST', 'rename', ({ body }) => {
    const from = String(body.from || ''), to = String(body.to || '').trim();
    if (!devs.has(from)) throw new Error('Gerät unbekannt'); if (!to || /[#+]/.test(to) || to.length > 80) throw new Error('Name ungültig');
    req('device/rename', { from, to, homeassistant_rename: false }); return { ok: true };
  });
  api.route('POST', 'remove', ({ body }) => {
    const d = devs.get(String(body.name || '')); if (!d) throw new Error('Gerät unbekannt');
    req('device/remove', { id: d.ieee, force: !!body.force }); return { ok: true };
  });
  api.route('POST', 'interview', ({ body }) => { const d = devs.get(String(body.name || '')); if (!d) throw new Error('Gerät unbekannt'); req('device/interview', { id: d.ieee }); return { ok: true }; });
  api.route('POST', 'channel', ({ body }) => {
    const n = Math.round(Number(body && body.channel)); if (!(n >= 11 && n <= 26)) throw new Error('Kanal muss zwischen 11 und 26 liegen');
    req('options', { options: { advanced: { channel: n } } }); pushEv(`Funkkanal ${n} angefordert`); push(); return { ok: true };
  });
  api.route('POST', 'restart', () => { req('restart', ''); return { ok: true }; });

  // Dongles am Server erkennen
  function guess(name) {
    const n = name.toLowerCase();
    if (/conbee|raspbee|dresden/.test(n)) return { adapter: 'deconz', hint: 'ConBee/RaspBee' };
    if (/dongle[-_ ]?max|dongle[-_ ]?m(?![a-z])|zbdongle[-_ ]?(max|mg24)|mg24/.test(n)) return { adapter: 'max', hint: 'Sonoff Dongle Max (MG24)' };
    if (/skyconnect|nabu|zbt-?[12]|dongle_max|zbdongle-?e|itead.*v2|plus_v2|mg2[14]|efr32/.test(n)) return { adapter: 'ember', hint: 'Sonoff ZBDongle-E / EFR32' };
    if (/cp210|silicon_labs|zbdongle-?p|cc26|cc13|sonoff/.test(n)) return { adapter: 'zstack', hint: 'Sonoff ZBDongle-P / CC2652' };
    return { adapter: '', hint: '' };
  }
  // Netzwerk-Dongles (Sonoff Dongle Max, SLZB …) im eigenen Subnetz suchen: offener TCP-Port 6638
  const tcpOpen = (ip, port, ms) => new Promise((res) => { const c = net.connect({ host: ip, port, timeout: ms }); c.once('connect', () => { c.destroy(); res(true); }); c.once('timeout', () => { c.destroy(); res(false); }); c.once('error', () => res(false)); });
  const webTitle = (ip) => new Promise((res) => { const r = http.get({ host: ip, port: 80, path: '/', timeout: 1200 }, (x) => { let b = ''; x.on('data', (d) => { if (b.length < 6000) b += d; }); x.on('end', () => { const m = /<title>([^<]*)/i.exec(b); res(m ? m[1].trim().slice(0, 60) : ''); }); }); r.on('timeout', () => { r.destroy(); res(''); }); r.on('error', () => res('')); });
  api.route('POST', 'testdongle', async ({ body }) => {
    const hostIn = String((body && body.host) || '').replace(/[^\w.\-]/g, ''); if (!hostIn) return { ok: false, msg: 'Keine Adresse eingetragen.' };
    let ip = hostIn; if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) { try { ip = (await dns.lookup(hostIn, { family: 4 })).address; } catch { return { ok: false, msg: `„${hostIn}“ lässt sich auf diesem Server nicht auflösen – IP-Adresse verwenden.` }; } }
    const open = await tcpOpen(ip, 6638, 2500);
    return open ? { ok: true, msg: `Port 6638 auf ${ip} antwortet. Zigbee2MQTT sollte sich verbinden können (Dongle auf „Zigbee Coordinator“, keine zweite Verbindung).` } : { ok: false, msg: `Port 6638 auf ${ip} antwortet nicht. Dongle erreichbar? Betriebsmodus „Zigbee Coordinator“? Belegt eine andere Verbindung (ZHA/Home Assistant) den Port? Dongle ggf. über seine Weboberfläche neu starten.` };
  });
  api.route('POST', 'finddongle', async ({ body }) => {
    const nets = []; for (const l of Object.values(os.networkInterfaces())) for (const a of l || []) if (a.family === 'IPv4' && !a.internal) nets.push(a.address);
    const prefs = String((body && body.subnet) || '').match(/^(\d+\.\d+\.\d+)\.?/) ? [String(body.subnet).match(/^(\d+\.\d+\.\d+)/)[1]] : [...new Set(nets.map((a) => a.split('.').slice(0, 3).join('.')))];
    const ips = []; for (const p of prefs) for (let i = 1; i < 255; i++) ips.push(`${p}.${i}`);
    const found = []; let idx = 0;
    await Promise.all(Array.from({ length: 80 }, async () => { while (idx < ips.length) { const ip = ips[idx++]; if (await tcpOpen(ip, 6638, 700)) found.push({ ip, title: await webTitle(ip) }); } }));
    found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
    return { found, scanned: ips.length, subnets: prefs };
  });
  api.route('GET', 'dongles', () => {
    let list = [];
    try { list = fs.readdirSync('/dev/serial/by-id').map((f) => ({ port: '/dev/serial/by-id/' + f, ...guess(f) })); } catch { /* kein USB-Seriell */ }
    return { dongles: list, adapters: ADAPTERS };
  });
  api.route('POST', 'setup', async ({ body }) => {
    const b = body || {};
    const choice = Object.keys(ADAPTERS).includes(b.adapter) ? b.adapter : 'ember';
    const adapter = choice === 'max' ? 'ember' : choice;
    // Dongle Max kann auch per Netzwerk (LAN/PoE/WLAN) angebunden werden: tcp://<Adresse>:6638
    const net = choice === 'max' && b.connection === 'network';
    let nethost = String(b.dongleHost || '').replace(/[^\w.\-]/g, '');
    let resolvedNote = '';
    // Namen wie „dongle-m.local“ (mDNS) kann Zigbee2MQTT im Docker-Container meist nicht auflösen → hier in eine IP umwandeln
    if (net && nethost && !/^\d+\.\d+\.\d+\.\d+$/.test(nethost)) {
      try { const r = await dns.lookup(nethost, { family: 4 }); resolvedNote = `„${nethost}“ wurde auf ${r.address} aufgelöst und als feste Adresse eingetragen (Namen mit .local findet Zigbee2MQTT im Docker-Container oft nicht).`; nethost = r.address; } catch { resolvedNote = `„${nethost}“ konnte hier nicht aufgelöst werden. Wenn Zigbee2MQTT sich nicht verbindet, die IP-Adresse des Dongles eintragen (Router oder „Im Netzwerk suchen“).`; }
    }
    const port = net ? `tcp://${nethost || 'DONGLE-ADRESSE'}:6638` : String(b.port || '/dev/serial/by-id/HIER-DONGLE-EINTRAGEN').replace(/[\r\n"]/g, '');
    const host = String(b.host || 'SERVER-IP').replace(/[^\w.\-]/g, '');
    const user = String(b.user || 'BENUTZER').replace(/[\r\n"]/g, ''), pass = String(b.pass || 'PASSWORT').replace(/[\r\n"]/g, '');
    const topic = String(b.base || base).replace(/[#+\r\n"]/g, '') || 'zigbee2mqtt';
    const ch = [11, 15, 20, 25].includes(Number(b.channel)) ? Number(b.channel) : 11;
    const yaml = [
      'version: 4', 'permit_join: false', 'availability: true', 'mqtt:', `  base_topic: ${topic}`, `  server: mqtt://${host}:1883`, `  user: ${user}`, `  password: ${pass}`,
      'serial:', `  port: ${port}`, `  adapter: ${adapter}`, ...(choice === 'max' ? ['  baudrate: 115200', '  rtscts: false'] : []), 'frontend:', '  enabled: true', '  port: 8080', 'advanced:', `  channel: ${ch}`, '  network_key: GENERATE', '  pan_id: GENERATE', '  ext_pan_id: GENERATE', '  log_level: info', '',
    ].join('\n');
    const compose = ['services:', '  zigbee2mqtt:', '    image: koenkk/zigbee2mqtt:latest', '    restart: unless-stopped', '    network_mode: host', '    environment:', '      - TZ=Europe/Vienna', '    volumes:', '      - ./data:/app/data', '      - /run/udev:/run/udev:ro', ...(net ? [] : ['    devices:', `      - ${port}:${port}`]), ''].join('\n');
    const notes = [];
    if (adapter === 'deconz') notes.push('ConBee: deCONZ/Phoscon darf nicht gleichzeitig laufen (Dienst „deconz“ beenden).');
    if (choice === 'max') notes.push(net ? 'Dongle Max (Netzwerk): In der Weboberfläche des Dongles den Betriebsmodus „Zigbee Coordinator“ wählen. Der Dongle erlaubt nur eine Verbindung auf Port 6638 – ZHA, Home Assistant o. Ä. nicht gleichzeitig verbinden. Wenn der Port nicht antwortet, den Dongle über seine Weboberfläche neu starten.' : 'Dongle Max (USB): Der Dongle muss im Betriebsmodus „Zigbee Coordinator“ laufen (nicht Thread/RCP). Bei Fehlern wie „Waiting for RSTACK“ kurz in den Thread-Modus und zurück stellen.');
    if (resolvedNote) notes.push(resolvedNote);
    if (net && b.dongleHost) { dg.host = String(b.dongleHost).replace(/[^\w.\-]/g, ''); api.kv.set('dongleHost', dg.host); probeDongle(); }
    return { yaml, compose, adapter, note: notes.join(' ') };
  });

  // KI-Zugriff
  try {
    api.mcp.tool({ name: 'zigbee_geraete', description: 'Zigbee-Geräte (Zigbee2MQTT): Name, Modell, Erreichbarkeit, Batterie, Verbindungsqualität', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => model().devices });
    api.mcp.tool({ name: 'zigbee_anlernen', description: 'Zigbee-Anlernmodus für N Sekunden öffnen (0 = schließen, max. 254)', control: true, inputSchema: { type: 'object', properties: { sekunden: { type: 'number' } }, required: ['sekunden'] }, run: ({ sekunden }) => { req('permit_join', { time: Math.max(0, Math.min(254, Number(sekunden) || 0)) }); return { ok: true }; } });
  } catch { /* MCP nicht verfügbar */ }

  function start() {
    base = String(cfg().base || 'zigbee2mqtt').replace(/^\/+|\/+$/g, '') || 'zigbee2mqtt';
    unsub = api.mqtt.subscribe(`${base}/#`, onMsg);
  }
  start();
  return { stop() { if (unsub) unsub(); } };
};
