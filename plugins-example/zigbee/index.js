'use strict';
// Zigbee direkt (ohne Zigbee2MQTT): ZHA-Kern (Python-Bibliothek „zha“ mit zigpy/bellows + zha-quirks) als Brücke.
// Der Funk-Dongle (z. B. Sonoff Dongle Max, USB oder Netzwerk) wird von diesem Plugin selbst gehalten.
// HomeLite bildet die Entitäten der Geräte ab (Licht, Schalter, Sensoren, Rollos, Thermostate, Tasten …).
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const { spawn } = require('child_process');
const readline = require('readline');

const DC = { temperature: 'Temperatur', humidity: 'Feuchte', pressure: 'Luftdruck', illuminance: 'Helligkeit', power: 'Leistung', energy: 'Energie', voltage: 'Spannung', current: 'Strom', battery: 'Batterie', carbon_dioxide: 'CO₂', volatile_organic_compounds: 'VOC', pm25: 'Feinstaub', pm10: 'Feinstaub PM10', moisture: 'Feuchte', power_factor: 'Leistungsfaktor', frequency: 'Frequenz', apparent_power: 'Scheinleistung', distance: 'Abstand', signal_strength: 'Signal', gas: 'Gas', co: 'CO', sound_pressure: 'Lautstärke', atmospheric_pressure: 'Luftdruck' };
const BDC = { motion: 'Bewegung', occupancy: 'Anwesenheit', presence: 'Präsenz', moisture: 'Wasser', smoke: 'Rauch', vibration: 'Vibration', tamper: 'Sabotage', gas: 'Gas', carbon_monoxide: 'CO', battery: 'Batterie schwach', opening: 'Kontakt (an = offen)', door: 'Tür (an = offen)', window: 'Fenster (an = offen)', garage_door: 'Garagentor (an = offen)', lock: 'Verriegelung', problem: 'Störung', heat: 'Hitze', cold: 'Kälte', light: 'Licht', sound: 'Geräusch', running: 'Läuft', safety: 'Sicherheit', connectivity: 'Verbindung', plug: 'Stecker', power: 'Spannung', presence_: 'Präsenz' };
const RADIOS = { ezsp: 'Silicon Labs EZSP/EmberZNet – Sonoff Dongle Max, ZBDongle-E, SkyConnect, ZBT-1/-2, HUSBZB-1, Elelabs', znp: 'Texas Instruments Z-Stack – Sonoff ZBDongle-P, CC2652/CC1352', deconz: 'dresden elektronik – ConBee I/II/III, RaspBee', xbee: 'Digi XBee', zigate: 'ZiGate' };

module.exports = (api) => {
  const cfg = () => api.config() || {};
  const ddir = () => { fs.mkdirSync(api.dataDir, { recursive: true }); return api.dataDir; };
  const vdir = () => path.join(ddir(), 'venv');
  const vpy = () => path.join(vdir(), 'bin', 'python3');

  const devs = new Map();     // ieee -> Info aus der Brücke
  const specs = new Map();    // key -> { ieee, uid, pick, write }
  const events = [], logs = [];
  let st = { state: 'stopped', msg: '', info: {}, since: 0 };
  let proc = null, seq = 1, restartT = null, stopping = false, rl = null;
  const pending = new Map();
  let join = 0;
  let chgBusy = false;
  const inst = { busy: false, ok: null, log: [], py: '' };

  const pushEv = (txt) => { events.unshift({ t: Date.now(), txt }); events.length = Math.min(events.length, 40); };
  const pushLog = (level, msg) => { logs.unshift({ t: Date.now(), level, msg }); logs.length = Math.min(logs.length, 60); };
  const names = () => api.kv.get('names') || {};
  const rooms = () => api.kv.get('rooms') || {};
  const hasVenv = () => fs.existsSync(vpy());

  // ---------- Verbindungsziel ----------
  async function target() {
    const c = cfg();
    if ((c.connection || 'network') === 'usb') {
      const dev = String(c.device || '').trim();
      if (!dev) throw new Error('Kein USB-Gerät eingetragen (z. B. /dev/serial/by-id/usb-…)');
      return { path: dev, ip: '' };
    }
    const host = String(c.host || '').trim();
    if (!host) throw new Error('Keine Adresse des Netzwerk-Dongles eingetragen');
    let ip = host;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      try { ip = (await dns.lookup(host, { family: 4 })).address; } catch { throw new Error(`„${host}“ lässt sich nicht auflösen – bitte die IP-Adresse eintragen`); }
    }
    return { path: `socket://${ip}:${Number(c.port) || 6638}`, ip };
  }

  // ---------- Brücke (Python) ----------
  const send = (cmd, extra = {}, ms = 60000) => new Promise((resolve, reject) => {
    if (!proc) return reject(new Error('Zigbee-Brücke läuft nicht'));
    const id = seq++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error('Zeitüberschreitung')); }, ms);
    pending.set(id, { resolve, reject, t });
    proc.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n');
  });
  const ask = async (cmd, extra, ms) => { const r = await send(cmd, extra, ms); if (!r.ok) throw new Error(r.error || 'Fehler'); return r; };

  function spawnBridge() {
    if (proc) return;
    const py = hasVenv() ? vpy() : '';
    if (!py) { st = { ...st, state: 'noenv', msg: 'Python-Umgebung fehlt – „Installieren“ drücken' }; push(); return; }
    const p = spawn(py, [path.join(__dirname, 'bridge.py')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONWARNINGS: 'ignore' } });
    proc = p; stopping = false;
    rl = readline.createInterface({ input: p.stdout });
    rl.on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.event) return onEvent(m);
      const w = pending.get(m.id); if (!w) return;
      pending.delete(m.id); clearTimeout(w.t); w.resolve(m);
    });
    readline.createInterface({ input: p.stderr }).on('line', (l) => { if (l.trim()) pushLog(/error|exception|traceback/i.test(l) ? 'error' : 'warn', l.slice(0, 300)); });
    p.on('error', (e) => died(e.message));
    p.on('exit', (code) => { if (proc === p) died(`Brücke beendet (Exit ${code})`); });
  }

  function died(msg) {
    proc = null;
    for (const w of pending.values()) { clearTimeout(w.t); w.reject(new Error(msg)); }
    pending.clear();
    for (const k of specs.keys()) setOnline(k, false);
    if (!stopping) { st = { ...st, state: 'error', msg }; pushLog('error', msg); scheduleRestart(30000); }
    push();
  }
  function scheduleRestart(ms) { clearTimeout(restartT); restartT = setTimeout(() => { restartT = null; connect().catch(() => {}); }, ms); }

  async function connect() {
    clearTimeout(restartT); restartT = null;
    if (!hasVenv()) { st = { ...st, state: 'noenv', msg: 'Python-Umgebung fehlt – „Installieren“ drücken' }; push(); return; }
    let t;
    try { t = await target(); } catch (e) { st = { ...st, state: 'config', msg: e.message }; push(); return; }
    spawnBridge(); if (!proc) return;
    const c = cfg();
    st = { ...st, state: 'starting', msg: `Verbinde mit ${t.path} …` }; push();
    try {
      await ask('start', { cfg: { path: t.path, baudrate: Number(c.baudrate) || 115200, flow_control: c.flow || '', channel: Number(c.channel) || 15, radio: c.radio || 'ezsp', data_dir: ddir(), ota: c.ota !== false, custom_quirks: path.join(ddir(), 'quirks') } }, 180000);
    } catch (e) {
      st = { ...st, state: 'error', msg: e.message }; pushLog('error', e.message); push();
      if (proc) { try { await send('stop', {}, 15000); } catch { /* egal */ } }
      scheduleRestart(30000);
    }
  }

  async function shutdown() {
    stopping = true; clearTimeout(restartT); restartT = null;
    const p = proc;
    if (p) { try { await send('stop', {}, 15000); } catch { /* egal */ } try { p.stdin.end(); } catch { /* egal */ } setTimeout(() => { try { p.kill(); } catch { /* egal */ } }, 2000); }
    proc = null;
  }

  // ---------- Ereignisse aus der Brücke ----------
  function onEvent(m) {
    switch (m.event) {
      case 'status':
        st = { ...st, state: m.state, msg: m.msg || '', info: m.info || st.info, since: m.state === 'online' ? Date.now() : st.since };
        if (m.state === 'online') { pushEv('Dongle verbunden'); }
        if (m.state === 'error' && m.msg) pushLog('error', m.msg);
        if (m.state !== 'online') for (const k of specs.keys()) setOnline(k, false);
        break;
      case 'devices': { const seen = new Set(); for (const d of m.devices) { seen.add(d.ieee); setDev(d, false); } for (const ieee of [...devs.keys()]) if (!seen.has(ieee)) dropDev(ieee); break; }
      case 'device': setDev(m.device, !!m.new); break;
      case 'join': pushEv(`Gerät meldet sich: ${m.ieee}`); break;
      case 'join_raw': pushEv(`Gerät erkannt: ${m.manufacturer || '?'} ${m.model || '?'}`); break;
      case 'left': case 'removed': { const d = devs.get(m.ieee); pushEv(`„${d ? disp(d) : m.ieee}“ hat das Netz verlassen`); dropDev(m.ieee); break; }
      case 'state': onState(m); break;
      case 'button': onButton(m.ieee, m.uid, m.type, m.attrs); break;
      case 'zha_event': onZhaEvent(m.ieee, m.data || {}); break;
      case 'health': for (const h of m.devices || []) { const d = devs.get(h.ieee); if (!d) continue; const was = d.available; Object.assign(d, { lqi: h.lqi, rssi: h.rssi, available: h.available, last_seen: h.last_seen }); if (was !== h.available) availability(d); lqiState(d); } break;
      default: break;
    }
    if (m.event !== 'state') push();
  }

  const disp = (d) => names()[d.ieee] || d.name || d.ieee;
  const roomOf = (d) => rooms()[d.ieee] || cfg().room || '';

  function setOnline(key, on) { try { api.devices.setState(key, { online: on }); } catch { /* noch nicht angelegt */ } }
  function availability(d) { for (const [k, sp] of specs) if (sp.ieee === d.ieee) setOnline(k, d.available !== false); }

  function dropDev(ieee) {
    devs.delete(ieee);
    for (const [k, sp] of [...specs]) if (sp.ieee === ieee) { try { api.devices.remove(k); } catch { /* weg */ } specs.delete(k); }
  }

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && v !== '' && isFinite(Number(v)) ? Number(v) : null));
  const R = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

  // Entität -> HomeLite-Gerät(e). Rückgabe: Liste { key, name, type, unit, pick(state), write(action,value) }
  function build(d) {
    const out = [];
    const base = disp(d), room = roomOf(d), eps = new Set((d.entities || []).map((e) => e.endpoint).filter((x) => x != null));
    const multi = eps.size > 1;
    const cnt = {};
    for (const e of d.entities || []) {
      if (e.enabled === false) continue;
      const k = `zha:${d.ieee}:${e.uid}`;
      const ep = multi && e.endpoint != null ? ` ${e.endpoint}` : '';
      const call = (method, args) => ask('call', { ieee: d.ieee, uid: e.uid, method, args: args || {} }, 30000).then((r) => r.state || {}).catch((er) => { throw new Error(er.message); });
      const cat = e.category || '';
      switch (e.platform) {
        case 'light':
          out.push({ key: k, name: base + ep, type: 'light', room,
            pick: (s) => { const p = {}; if (s.on !== undefined && s.on !== null) p.on = !!s.on; const b = num(s.brightness); if (b !== null) p.brightness = Math.round(b * 100 / 255); return Object.keys(p).length ? p : null; },
            write: async (a, v) => {
              if (a === 'toggle') a = (devSt(d.ieee, e.uid) || {}).on ? 'off' : 'on';
              if (a === 'on') { await call('turn_on'); return { on: true }; }
              if (a === 'off') { await call('turn_off'); return { on: false }; }
              if (a === 'brightness') { const p = Math.max(0, Math.min(100, Number(v))); if (p === 0) { await call('turn_off'); return { on: false, brightness: 0 }; } await call('turn_on', { brightness: Math.round(p * 255 / 100) }); return { on: true, brightness: p }; }
              if (a === 'color_temp') { await call('turn_on', { color_temp: Math.round(Number(v)) }); return {}; }
              throw new Error('Aktion nicht unterstützt: ' + a);
            } });
          break;
        case 'switch': case 'siren': case 'fan': case 'valve': {
          if (cat === 'config' || cat === 'diagnostic') break; // z. B. „Kindersicherung“: nur in der Zigbee-Seite
          const isOn = (s) => (s.is_on !== undefined && s.is_on !== null ? !!s.is_on : s.state !== undefined ? s.state === 'on' || s.state === true : undefined);
          const onM = e.platform === 'valve' ? 'open' : 'turn_on', offM = e.platform === 'valve' ? 'close' : 'turn_off';
          out.push({ key: k, name: base + ep + (e.platform === 'siren' ? ' Sirene' : e.platform === 'fan' ? ' Lüfter' : ''), type: 'switch', room,
            pick: (s) => { const v = isOn(s); return v === undefined ? null : { on: v }; },
            write: async (a) => {
              if (a === 'toggle') { const cur = devSt(d.ieee, e.uid); a = isOn(cur || {}) ? 'off' : 'on'; }
              if (a === 'on') { await call(onM); return { on: true }; }
              if (a === 'off') { await call(offM); return { on: false }; }
              throw new Error('Aktion nicht unterstützt: ' + a);
            } });
          break;
        }
        case 'cover':
          out.push({ key: k, name: base + ep, type: 'cover', room,
            pick: (s) => { const p = {}; const pos = num(s.current_position); if (pos !== null) p.position = pos; if (s.is_opening) p.state = 'opening'; else if (s.is_closing) p.state = 'closing'; else if (s.is_closed === true) p.state = 'closed'; else if (s.is_closed === false) p.state = 'open'; return Object.keys(p).length ? p : null; },
            write: async (a, v) => {
              if (a === 'open') { await call('open_cover'); return { state: 'opening' }; }
              if (a === 'close') { await call('close_cover'); return { state: 'closing' }; }
              if (a === 'stop') { await call('stop_cover'); return { state: 'stopped' }; }
              if (a === 'position') { await call('set_cover_position', { position: Math.max(0, Math.min(100, Number(v))) }); return {}; }
              throw new Error('Aktion nicht unterstützt: ' + a);
            } });
          break;
        case 'lock':
          out.push({ key: k, name: base + ep, type: 'lock', room,
            pick: (s) => (s.is_locked === undefined || s.is_locked === null ? null : { state: s.is_locked ? 'locked' : 'unlocked', on: !!s.is_locked }),
            write: async (a) => {
              const lk = a === 'lock' || a === 'on' ? true : a === 'unlock' || a === 'off' ? false : null;
              if (lk === null) throw new Error('Aktion nicht unterstützt: ' + a);
              await call(lk ? 'lock' : 'unlock'); return { state: lk ? 'locked' : 'unlocked', on: lk };
            } });
          break;
        case 'climate':
          out.push({ key: k, name: base + ep, type: 'thermostat', unit: '°C', room,
            pick: (s) => { const p = {}; const c = num(s.current_temperature), t = num(s.target_temperature); if (c !== null) p.current = R(c, 1); if (t !== null) p.setpoint = R(t, 1); return Object.keys(p).length ? p : null; },
            write: async (a, v) => { if (a !== 'setpoint') throw new Error('Aktion nicht unterstützt: ' + a); const t = Number(v); if (!isFinite(t)) throw new Error('Zahl erwartet'); await call('set_temperature', { temperature: t }); return { setpoint: t }; } });
          break;
        case 'sensor': {
          const dc = e.device_class || '';
          if (dc === 'battery') { if (cfg().batteries === false) break; }
          else if (dc === 'signal_strength' || /lqi|rssi/i.test(e.key + e.name)) { if (!cfg().linkquality) break; }
          else if (cat === 'diagnostic' && !cfg().diagnostics) break;
          else if (cat === 'config') break;
          const label = DC[dc] || e.name || e.key || 'Wert';
          const nm = `${base}${ep} ${label}`;
          cnt[nm] = (cnt[nm] || 0) + 1;
          out.push({ key: k, name: cnt[nm] > 1 ? `${nm} ${cnt[nm]}` : nm, type: 'sensor', unit: e.unit || '', room,
            pick: (s) => { const v = s.native_value; if (v === null || v === undefined) return null; const n = num(v); return { value: n !== null ? R(n) : String(v) }; } });
          break;
        }
        case 'binary_sensor': {
          if (cat === 'config') break;
          if (cat === 'diagnostic' && !cfg().diagnostics && e.device_class !== 'battery') break;
          if (e.device_class === 'battery' && cfg().batteries === false) break;
          const nm = `${base}${ep} ${BDC[e.device_class] || e.name || e.key || 'Binär'}`;
          cnt[nm] = (cnt[nm] || 0) + 1;
          out.push({ key: k, name: cnt[nm] > 1 ? `${nm} ${cnt[nm]}` : nm, type: 'binary', room,
            pick: (s) => (s.is_on === undefined || s.is_on === null ? null : { on: !!s.is_on }) });
          break;
        }
        default: break;
      }
    }
    // Tasten/Fernbedienungen: ein Ereignis-Gerät „Taster“
    if ((d.entities || []).some((e) => e.platform === 'event') || btnSeen.has(d.ieee)) {
      out.push({ key: `zha:${d.ieee}:action`, name: `${base} Taster`, type: 'event', room, pick: null });
    }
    return out;
  }

  const btnSeen = new Set();
  const lastSt = new Map(); // ieee|uid -> state
  const devSt = (ieee, uid) => lastSt.get(ieee + '|' + uid);

  function sync(d) {
    const want = new Set();
    for (const s of build(d)) {
      want.add(s.key);
      try {
        specs.set(s.key, { ...s, ieee: d.ieee, uid: s.key.slice(`zha:${d.ieee}:`.length) });
        api.devices.ensure({ key: s.key, name: s.name, room: s.room, type: s.type, unit: s.unit || '' });
        const e = (d.entities || []).find((x) => `zha:${d.ieee}:${x.uid}` === s.key);
        const patch = e && s.pick ? s.pick(e.state || {}) : null;
        api.devices.setState(s.key, { ...(patch || {}), online: d.available !== false });
      } catch (er) { api.log('warn', `Gerät ${s.key}: ${er.message}`); }
    }
    for (const [k, sp] of [...specs]) if (sp.ieee === d.ieee && !want.has(k)) { try { api.devices.remove(k); } catch { /* weg */ } specs.delete(k); }
    for (const e of d.entities || []) lastSt.set(d.ieee + '|' + e.uid, e.state || {});
    lqiState(d);
  }

  function setDev(d, isNew) {
    const old = devs.get(d.ieee);
    devs.set(d.ieee, { ...(old || {}), ...d });
    if (isNew) pushEv(`Neues Gerät: ${disp(d)} (${d.manufacturer || '?'} ${d.model || '?'})`);
    sync(devs.get(d.ieee));
  }

  function lqiState(d) {
    if (!cfg().linkquality) return;
    const key = `zha:${d.ieee}:lqi`;
    try {
      if (d.lqi === null || d.lqi === undefined) return;
      if (!specs.has(key)) { specs.set(key, { ieee: d.ieee, uid: 'lqi', pick: null }); api.devices.ensure({ key, name: `${disp(d)} Verbindung (LQI)`, room: roomOf(d), type: 'sensor', unit: '' }); }
      api.devices.setState(key, { value: d.lqi, online: d.available !== false });
    } catch { /* egal */ }
  }

  function onState(m) {
    lastSt.set(m.ieee + '|' + m.uid, m.state || {});
    const d = devs.get(m.ieee); if (d) { const e = (d.entities || []).find((x) => x.uid === m.uid); if (e) e.state = m.state; }
    const key = `zha:${m.ieee}:${m.uid}`, sp = specs.get(key);
    if (!sp || !sp.pick) return;
    const p = sp.pick(m.state || {});
    if (!p) return;
    const av = m.state && m.state.available;
    try { api.devices.setState(key, { ...p, online: av === false ? false : true }); } catch { /* noch nicht angelegt */ }
  }

  const evVal = (type, attrs) => { const n = attrs && (attrs.press_count || attrs.count); return n ? `${type}_${n}` : String(type); };
  function fireButton(ieee, value) {
    const key = `zha:${ieee}:action`;
    if (!specs.has(key)) { const d = devs.get(ieee); if (!d) return; btnSeen.add(ieee); sync(d); }
    try { api.devices.setState(key, { value: String(value), online: true }); } catch { /* egal */ }
    const d = devs.get(ieee); pushEv(`${d ? disp(d) : ieee}: ${value}`);
  }
  function onButton(ieee, uid, type, attrs) {
    const d = devs.get(ieee); const e = d && (d.entities || []).find((x) => x.uid === uid);
    const nm = e && e.name && e.name !== 'button' ? String(e.name).toLowerCase().replace(/\s+/g, '_') + '_' : '';
    fireButton(ieee, nm + evVal(type, attrs));
  }
  function onZhaEvent(ieee, data) {
    const cmd = data.command || data.cluster_command; if (!cmd) return;
    const args = Array.isArray(data.args) ? data.args : data.args && typeof data.args === 'object' ? Object.values(data.args) : [];
    const val = [cmd, data.endpoint_id ? `ep${data.endpoint_id}` : '', args.length && args.every((x) => typeof x !== 'object') ? args.join('_') : ''].filter(Boolean).join('_');
    fireButton(ieee, val);
  }

  api.devices.onCommand(async (dev, action, value) => {
    const sp = specs.get(dev.key);
    if (!sp || !sp.write) throw new Error('Gerät nicht steuerbar');
    if (st.state !== 'online') throw new Error('Zigbee-Dongle ist nicht verbunden');
    return (await sp.write(action, value)) || {};
  });

  // ---------- Modell für die Seite ----------
  function model() {
    const c = cfg();
    const list = [...devs.values()].map((d) => ({
      ieee: d.ieee, nwk: d.nwk, name: disp(d), orig: d.name, room: roomOf(d), manufacturer: d.manufacturer, model: d.model, quirk: d.quirk, type: d.type, power: d.power, mains: d.mains,
      lqi: d.lqi, rssi: d.rssi, available: d.available !== false, last_seen: d.last_seen, sw: d.sw, endpoints: d.endpoints || [],
      battery: (() => { const e = (d.entities || []).find((x) => x.platform === 'sensor' && x.device_class === 'battery'); const v = e && e.state ? num(e.state.native_value) : null; return v; })(),
      entities: (d.entities || []).map((e) => ({ uid: e.uid, platform: e.platform, name: e.name || e.key, device_class: e.device_class, category: e.category, unit: e.unit, options: e.options, min: e.min, max: e.max, step: e.step, state: e.state,
        mapped: specs.has(`zha:${d.ieee}:${e.uid}`) })),
    })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return {
      status: st.state, msg: st.msg, info: st.info, since: st.since, join, devices: list, events: events.slice(0, 20), logs: logs.slice(0, 30),
      conn: { connection: c.connection || 'network', host: c.host || '', port: Number(c.port) || 6638, device: c.device || '', radio: c.radio || 'ezsp', channel: Number(c.channel) || 15, baudrate: Number(c.baudrate) || 115200, flow: c.flow || '' },
      env: { ready: hasVenv(), busy: inst.busy, ok: inst.ok, log: inst.log.slice(-40) }, chg: chgBusy,
    };
  }
  const push = () => { try { api.emit({ model: model() }); } catch { /* egal */ } };

  // ---------- Installation der Python-Umgebung ----------
  const run = (cmd, args, opts = {}) => new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    const out = [];
    const take = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) { inst.log.push(l.slice(0, 200)); out.push(l); } if (inst.log.length > 200) inst.log.splice(0, inst.log.length - 200); push(); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('error', (e) => { inst.log.push(`${cmd}: ${e.message}`); resolve({ code: 127, out }); });
    p.on('exit', (code) => resolve({ code, out }));
  });
  async function install() {
    if (inst.busy) throw new Error('Installation läuft schon');
    inst.busy = true; inst.ok = null; inst.log = []; push();
    (async () => {
      try {
        await shutdown();
        const sys = String(cfg().python || '').trim() || (() => { for (const n of ['python3.13', 'python3.12', 'python3']) { try { require('child_process').execFileSync(n, ['--version'], { stdio: 'ignore' }); return n; } catch { /* nächster */ } } return 'python3'; })();
        const v = await run(sys, ['-c', 'import sys;print(sys.version.split()[0]);sys.exit(0 if sys.version_info>=(3,12) else 3)']);
        if (v.code !== 0) throw new Error(v.code === 3 ? `Python ${v.out[0] || '?'} ist zu alt – ZHA braucht Python 3.12 oder neuer (im Plugin „Python-Programm“ angeben)` : `Python („${sys}“) nicht gefunden`);
        inst.log.push(`Python ${v.out[0]} ✔`); push();
        if (!hasVenv()) { const r = await run(sys, ['-m', 'venv', vdir()]); if (r.code !== 0) throw new Error('venv konnte nicht angelegt werden (Paket python3-venv installiert?)'); }
        const pip = [vpy(), '-m', 'pip', '--disable-pip-version-check'];
        const r1 = await run(pip[0], [...pip.slice(1), 'install', '--upgrade', 'pip', 'wheel']); if (r1.code !== 0) throw new Error('pip nicht aktualisierbar');
        const r2 = await run(pip[0], [...pip.slice(1), 'install', '--upgrade', 'zigpy', 'bellows', 'zha', 'zha-quirks']);
        if (r2.code !== 0) throw new Error('Installation der Pakete fehlgeschlagen (Internetzugang des Servers für pypi.org nötig)');
        const r3 = await run(vpy(), ['-c', 'import zha, zhaquirks, bellows, zigpy;print("OK")']); if (r3.code !== 0) throw new Error('Pakete lassen sich nicht importieren');
        inst.ok = true; inst.log.push('Fertig ✔'); pushEv('Python-Umgebung installiert/aktualisiert');
        connect().catch(() => {});
      } catch (e) { inst.ok = false; inst.log.push('FEHLER: ' + e.message); pushLog('error', e.message); }
      finally { inst.busy = false; push(); }
    })();
    return { ok: true };
  }

  // ---------- Backup (zigpy „open coordinator backup“-JSON) und Restore ----------
  const bdir = () => { const d = path.join(ddir(), 'backups'); fs.mkdirSync(d, { recursive: true }); return d; };
  const okName = (n) => /^zigbee-backup-[\w-]+\.json$/.test(String(n || ''));
  const stamp = () => { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
  const listBackups = () => { try { return fs.readdirSync(bdir()).filter(okName).map((n) => { const s = fs.statSync(path.join(bdir(), n)); return { name: n, size: s.size, t: s.mtimeMs, note: /-auto\.json$/.test(n) ? 'automatisch' : /-import\.json$/.test(n) ? 'hochgeladen' : /-vor-restore\.json$/.test(n) ? 'vor Restore' : '' }; }).sort((a, b) => b.t - a.t); } catch { return []; } };
  const pruneBackups = () => { const keep = Math.max(1, Number(cfg().backupKeep) || 14); for (const b of listBackups().slice(keep)) { try { fs.unlinkSync(path.join(bdir(), b.name)); } catch { /* egal */ } } };
  async function makeBackup(tag) {
    if (st.state !== 'online') throw new Error('Dongle nicht verbunden – kein Backup möglich');
    const r = await ask('backup', {}, 60000);
    const name = `zigbee-backup-${stamp()}${tag ? '-' + tag : ''}.json`;
    fs.writeFileSync(path.join(bdir(), name), JSON.stringify(r.data, null, 1), { mode: 0o600 });
    pruneBackups(); pushEv(`Backup erstellt: ${name}`); push(); return name;
  }
  const looksOk = (j) => j && typeof j === 'object' && j.network_key && j.pan_id && j.extended_pan_id && j.coordinator_ieee;
  api.route('GET', 'backups', () => ({ backups: listBackups(), auto: cfg().autoBackup !== false, last: api.kv.get('lastAutoBackup') || 0 }));
  api.route('POST', 'backup', async () => ({ name: await makeBackup(''), backups: listBackups() }));
  api.route('GET', 'backup/:name', ({ params }) => { if (!okName(params.name)) throw new Error('Name ungültig'); const f = path.join(bdir(), params.name); if (!fs.existsSync(f)) throw new Error('Backup nicht gefunden'); return { filename: params.name, content: fs.readFileSync(f, 'utf8') }; });
  api.route('DELETE', 'backup/:name', ({ params }) => { if (!okName(params.name)) throw new Error('Name ungültig'); try { fs.unlinkSync(path.join(bdir(), params.name)); } catch { /* egal */ } return { backups: listBackups() }; });
  api.route('POST', 'backup-upload', ({ body }) => {
    let j; try { j = JSON.parse(String(body && body.content || '')); } catch { throw new Error('Keine gültige JSON-Datei'); }
    if (!looksOk(j)) throw new Error('Die Datei sieht nicht wie ein Zigbee-Netzwerk-Backup aus (Open-Coordinator-Backup)');
    fs.writeFileSync(path.join(bdir(), `zigbee-backup-${stamp()}-import.json`), JSON.stringify(j, null, 1), { mode: 0o600 });
    return { backups: listBackups() };
  });
  // Restore: schreibt Netzwerkschlüssel, PAN-ID, Kanal und Koordinator-IEEE auf den (neuen) Dongle. Danach Neustart der Brücke.
  api.route('POST', 'restore/:name', async ({ params }) => {
    if (!okName(params.name)) throw new Error('Name ungültig');
    const f = path.join(bdir(), params.name); if (!fs.existsSync(f)) throw new Error('Backup nicht gefunden');
    if (st.state !== 'online') throw new Error('Dongle nicht verbunden – erst verbinden, dann einspielen');
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    try { await makeBackup('vor-restore'); } catch { /* weiter */ }
    await ask('restore', { data }, 120000);
    pushEv(`Backup ${params.name} eingespielt – Brücke wird neu gestartet`);
    await shutdown(); setTimeout(() => connect().catch(() => {}), 1500); push();
    return { ok: true };
  });
  api.timer(async () => {
    if (cfg().autoBackup === false || st.state !== 'online') return;
    if (Date.now() - (api.kv.get('lastAutoBackup') || 0) < 23.5 * 3600 * 1000) return;
    try { await makeBackup('auto'); api.kv.set('lastAutoBackup', Date.now()); } catch (e) { api.log('warn', 'Auto-Backup: ' + e.message); }
  }, 10 * 60 * 1000);

  // ---------- Routen ----------
  const tcpOpen = (ip, port, ms) => new Promise((res) => { const c = net.connect({ host: ip, port, timeout: ms }); c.once('connect', () => { c.destroy(); res(true); }); c.once('timeout', () => { c.destroy(); res(false); }); c.once('error', () => res(false)); });
  api.route('GET', 'model', () => model());
  api.route('POST', 'install', () => install());
  api.route('POST', 'start', async () => { await shutdown(); connect().catch(() => {}); return { ok: true }; });
  api.route('POST', 'stop', async () => { await shutdown(); st = { ...st, state: 'stopped', msg: 'Angehalten' }; for (const k of specs.keys()) setOnline(k, false); push(); return { ok: true }; });
  api.route('POST', 'test', async ({ body }) => {
    if (st.state === 'online' || st.state === 'starting') return { ok: false, msg: 'Der Dongle wird gerade vom Plugin gehalten (Verbindung steht schon bzw. wird aufgebaut) – ein zweiter Test würde stören.' };
    const host = String(body && body.host || cfg().host || '').trim(), port = Number(body && body.port || cfg().port) || 6638;
    if (!host) return { ok: false, msg: 'Keine Adresse eingetragen' };
    let ip = host; if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) { try { ip = (await dns.lookup(host, { family: 4 })).address; } catch { return { ok: false, msg: `„${host}“ lässt sich auf diesem Server nicht auflösen – IP-Adresse verwenden.` }; } }
    const ok = await tcpOpen(ip, port, 2500);
    return { ok, msg: ok ? `Port ${port} auf ${ip} antwortet. Für die Zigbee-Verbindung muss der Dongle im Modus „Zigbee Coordinator (TCP)“ laufen; es darf nur eine Verbindung bestehen.` : `Port ${port} auf ${ip} antwortet nicht – Dongle, Netzwerk und Betriebsmodus prüfen.` };
  });
  api.route('POST', 'permit', async ({ body }) => {
    const t = Math.max(0, Math.min(254, Number(body && body.time) || 0));
    await ask('permit', { time: t }, 20000);
    join = t ? Date.now() + t * 1000 : 0; if (t) pushEv(`Anlernen für ${t} s geöffnet`); push();
    return { ok: true };
  });
  api.route('POST', 'rename', ({ body }) => {
    const ieee = String(body.ieee || ''), to = String(body.name || '').trim(); const d = devs.get(ieee); if (!d) throw new Error('Gerät unbekannt');
    if (!to || to.length > 80) throw new Error('Name ungültig');
    const n = names(); n[ieee] = to; api.kv.set('names', n);
    if (body.room !== undefined) { const r = rooms(); r[ieee] = String(body.room || '').trim(); api.kv.set('rooms', r); }
    sync(d); push(); return { ok: true, note: 'Bereits angelegte HomeLite-Geräte behalten ihren Namen; ihn in den Geräten von HomeLite ändern.' };
  });
  api.route('POST', 'remove', async ({ body }) => { await ask('remove', { ieee: String(body.ieee || '') }, 40000); return { ok: true }; });
  api.route('POST', 'reinterview', async ({ body }) => { await ask('reinterview', { ieee: String(body.ieee || '') }, 120000); return { ok: true }; });
  api.route('POST', 'poll', async ({ body }) => { await ask('poll', { ieee: String(body.ieee || '') }, 60000); return { ok: true }; });
  // Konfigurations-Entitäten (number/select/button …) direkt aus der Seite
  api.route('POST', 'entity', async ({ body }) => {
    const d = devs.get(String(body.ieee || '')); if (!d) throw new Error('Gerät unbekannt');
    const e = (d.entities || []).find((x) => x.uid === body.uid); if (!e) throw new Error('Entität unbekannt');
    const map = { number: ['set_native_value', (v) => ({ value: Number(v) })], select: ['select_option', (v) => ({ option: String(v) })], button: ['press', () => ({})], switch: [body.value ? 'turn_on' : 'turn_off', () => ({})] };
    const m = map[e.platform]; if (!m) throw new Error('Diese Entität ist hier nicht bedienbar');
    const r = await ask('call', { ieee: d.ieee, uid: e.uid, method: m[0], args: m[1](body.value) }, 30000);
    if (r.state) onState({ ieee: d.ieee, uid: e.uid, state: r.state });
    push(); return { ok: true };
  });
  api.route('POST', 'channel', async ({ body }) => {
    const ch = Number(body && body.channel); if (!(ch >= 11 && ch <= 26)) throw new Error('Kanal 11 bis 26');
    if (st.state !== 'online') throw new Error('Dongle nicht verbunden');
    if (chgBusy) throw new Error('Kanalwechsel läuft schon');
    chgBusy = true; push();
    try { await makeBackup('vor-kanalwechsel').catch(() => {}); const r = await ask('set_channel', { channel: ch }, 120000); st.info = r.info || st.info; pushEv(`Funkkanal auf ${ch} gewechselt`); return { ok: true, info: st.info }; }
    finally { chgBusy = false; push(); }
  });
  api.route('POST', 'scan', async () => { if (st.state !== 'online') throw new Error('Dongle nicht verbunden'); const r = await ask('scan', {}, 120000); return { scan: r.scan }; });
  api.route('POST', 'saveconn', ({ body }) => {
    // Verbindungsdaten werden über die Plugin-Einstellungen gespeichert; diese Route löst nur den Neuverbindungsversuch aus
    return shutdown().then(() => { connect().catch(() => {}); return { ok: true }; });
  });

  api.onConfig && api.onConfig(() => { shutdown().then(() => connect().catch(() => {})); });

  try {
    api.mcp.tool({ name: 'zha_geraete', description: 'Zigbee-Geräte (direkt, ZHA): Name, Hersteller, Modell, Erreichbarkeit, Batterie, Verbindungsqualität', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => model().devices.map((d) => ({ name: d.name, ieee: d.ieee, hersteller: d.manufacturer, modell: d.model, erreichbar: d.available, batterie: d.battery, lqi: d.lqi })) });
    api.mcp.tool({ name: 'zha_anlernen', description: 'Zigbee-Anlernmodus (direkt, ZHA) für N Sekunden öffnen (0 = schließen, max. 254)', control: true, inputSchema: { type: 'object', properties: { sekunden: { type: 'number' } }, required: ['sekunden'] }, run: async ({ sekunden }) => { const t = Math.max(0, Math.min(254, Number(sekunden) || 0)); await ask('permit', { time: t }, 20000); join = t ? Date.now() + t * 1000 : 0; push(); return { ok: true }; } });
  } catch { /* MCP nicht verfügbar */ }

  api.after(() => { connect().catch((e) => api.log('warn', e.message)); }, 1500);
  return { stop() { shutdown(); clearTimeout(restartT); } };
};
