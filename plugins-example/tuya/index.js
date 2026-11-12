'use strict';
// Tuya / Smart Life als Plugin: Python-Brücke (Tuya-Device-Sharing-SDK + tinytuya), QR-Anmeldung, lokale Steuerung mit Cloud-Rückfall.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function pythonBin() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const roots = [process.cwd(), path.resolve(__dirname, '..', '..', '..'), path.resolve(__dirname, '..', '..')];
  for (const r of roots) for (const rel of ['.venv/bin/python3', '.venv/bin/python', 'venv/bin/python3']) { const f = path.join(r, rel); if (fs.existsSync(f)) return f; }
  return 'python3';
}

module.exports = (api) => {
  let proc = null, seq = 1, retry = null, stopped = false;
  let devices = [];                 // Tuya-Geräte des Kontos (Beschreibung + Status)
  let connected = false, error = '', qrToken = null, localAvailable = null;
  const localInfo = {};             // id -> { state, ip, version, reason }
  const pending = new Map();
  let stderr = [];

  const kvAuth = () => api.kv.get('auth') || { userCode: '', auth: null };
  const kvLocal = () => { const l = api.kv.get('local'); return { enabled: !l || l.enabled !== false, devices: (l && l.devices) || {} }; };
  const links = () => { const l = api.kv.get('links'); return Array.isArray(l) ? l : []; };
  const saveLinks = (l) => api.kv.set('links', l);

  // ---------- Brücke ----------
  function spawnProc() {
    if (proc) return;
    const bin = pythonBin();
    const p = spawn(bin, [process.env.HOMELITE_TUYA_BRIDGE || path.join(__dirname, 'tuya_bridge.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc = p; stderr = [];
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.event) return onEvent(m);
      const w = pending.get(m.id); if (!w) return;
      pending.delete(m.id); clearTimeout(w.t); w.resolve(m);
    });
    readline.createInterface({ input: p.stderr }).on('line', (l) => { stderr.push(l); if (stderr.length > 10) stderr.shift(); });
    p.on('error', (e) => { if (proc === p) dead(e.code === 'ENOENT' ? `${bin} nicht gefunden` : e.message); });
    p.on('exit', (code) => { if (proc === p) dead((stderr.slice(-3).join(' | ') || 'Brücke beendet') + ` [Python: ${bin}, Exit ${code}]`); });
  }
  function dead(msg) {
    proc = null; connected = false; error = msg;
    for (const w of pending.values()) { clearTimeout(w.t); w.reject(new Error(msg)); }
    pending.clear(); push();
    if (!stopped && kvAuth().auth) { clearTimeout(retry); retry = setTimeout(start, 60000); }
  }
  function send(cmd, extra = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      spawnProc();
      if (!proc) return reject(new Error(error || 'Brücke nicht gestartet'));
      const id = seq++;
      const t = setTimeout(() => { pending.delete(id); reject(new Error('Zeitüberschreitung')); }, timeoutMs);
      pending.set(id, { resolve, reject, t });
      proc.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n');
    });
  }

  function onEvent(m) {
    if (m.event === 'update') {
      const d = devices.find((x) => x.id === m.id);
      if (d) { d.status = m.status; d.online = m.online; }
      applyDevice(m.id, m.status, m.online);
    } else if (m.event === 'local') {
      const was = (localInfo[m.id] || {}).state;
      localInfo[m.id] = { state: m.state, ip: m.ip || '', version: m.version || 0, reason: m.reason || '' };
      if (m.state !== was) {
        const d = devices.find((x) => x.id === m.id);
        api.log('info', `${d ? d.name : m.id}: ${m.state === 'ok' ? `lokal verbunden (${m.ip}, v${m.version})` : 'lokal nicht verbunden' + (m.reason ? ' – ' + m.reason : '') + ' → Cloud'}`);
      }
      push();
    } else if (m.event === 'local_info') { localAvailable = !!m.available; push();
    } else if (m.event === 'devices') { setDevices(m.devices);
    } else if (m.event === 'token') { const a = kvAuth(); if (a.auth) { a.auth.token_info = m.token; api.kv.set('auth', a); } }
  }

  function setDevices(list) {
    devices = Array.isArray(list) ? list : [];
    for (const d of devices) applyDevice(d.id, d.status, d.online);
    push();
  }

  // ---------- Geräte in HomeLite ----------
  const SENSOR = 'sensor';
  // Batterie des Tuya-Geräts: Prozent (battery_percentage, battery, residual_electricity) oder Stufe (battery_state, va_battery)
  const BAT_NUM = ['battery_percentage', 'battery', 'residual_electricity', 'battery_level'];
  const BAT_ENUM = ['battery_state', 'va_battery'];
  const BAT_TEXT = { low: 'niedrig', middle: 'mittel', normal: 'normal', high: 'voll' };
  function batteryOf(status) {
    const s = status || {};
    for (const c of BAT_NUM) if (typeof s[c] === 'number' && s[c] >= 0 && s[c] <= 100) return { battery: Math.round(s[c]), batteryState: undefined };
    for (const c of BAT_ENUM) if (typeof s[c] === 'string' && s[c]) return { battery: undefined, batteryState: BAT_TEXT[s[c]] || s[c] };
    return null;
  }
  function applyDevice(tuyaId, status, online) {
    const bat = batteryOf(status);
    for (const l of links()) {
      if (l.tuyaId !== tuyaId) continue;
      const patch = { online: online !== false };
      if (bat) Object.assign(patch, bat);
      try {
        if (l.type === SENSOR) {
          const v = (status || {})[l.value];
          if (v === undefined || v === null) continue;
          patch.value = typeof v === 'number' ? Math.round((v / 10 ** (l.scale || 0)) * 100) / 100 : v;
        } else {
          const v = (status || {})[l.on];
          if (v === undefined) continue;
          patch.on = v === true || v === 'true' || v === 1;
          const b = (status || {})[l.brightness];
          if (l.type === 'light' && l.brightness && typeof b === 'number') patch.brightness = Math.round((b / (l.brightnessMax || 1000)) * 100);
        }
        api.devices.setState(l.key, patch);
      } catch (e) { /* Gerät (noch) nicht angelegt */ }
    }
  }
  function ensureLinked() {
    for (const l of links()) {
      try { api.devices.ensure({ key: l.key, name: l.name, room: l.room, type: l.type, unit: l.unit || '' }); } catch (e) { api.log('warn', `Gerät ${l.key}: ${e.message}`); }
    }
  }

  api.devices.onCommand(async (dev, action, value) => {
    const l = links().find((x) => x.key === dev.key);
    if (!l) throw new Error('Tuya-Verknüpfung fehlt');
    if (!connected) throw new Error('Tuya ist nicht verbunden' + (error ? ': ' + error : ''));
    const cur = (devices.find((d) => d.id === l.tuyaId) || {}).status || {};
    const isOn = cur[l.on] === true;
    const cmds = []; let patch;
    if (action === 'toggle') action = isOn ? 'off' : 'on';
    if (action === 'on' || action === 'off') { cmds.push({ code: l.on, value: action === 'on' }); patch = { on: action === 'on' }; }
    else if (action === 'brightness') {
      if (!l.brightness) throw new Error('Dimmen nicht unterstützt');
      const v = Math.max(0, Math.min(100, Number(value)));
      if (v > 0 && !isOn && l.on) cmds.push({ code: l.on, value: true });
      cmds.push({ code: l.brightness, value: Math.max(l.brightnessMin || 10, Math.round((v / 100) * (l.brightnessMax || 1000))) });
      patch = { on: v > 0, brightness: v };
    } else throw new Error('Aktion nicht unterstützt: ' + action);
    const r = await send('control', { device: l.tuyaId, commands: cmds }, 20000);
    if (!r.ok) throw new Error(r.error);
    return patch;
  });

  // ---------- Verbindung ----------
  async function start() {
    clearTimeout(retry);
    const a = kvAuth();
    if (!a.auth || !a.userCode) { connected = false; push(); return; }
    try {
      const r = await send('connect', { userCode: a.userCode, auth: a.auth, local: kvLocal() }, 90000);
      if (!r.ok) throw new Error(r.error);
      connected = true; error = '';
      setDevices(r.devices);
      api.log('info', `verbunden (${devices.length} Geräte)`);
    } catch (e) {
      connected = false; error = e.message;
      api.log('warn', e.message); push();
      if (!stopped) retry = setTimeout(start, 120000);
    }
  }

  const model = () => {
    const a = kvAuth(), l = kvLocal(), ls = links();
    return {
      userCode: a.userCode || '', loggedIn: !!a.auth, username: (a.auth && a.auth.username) || '', connected, error,
      local: { enabled: l.enabled, available: localAvailable, manual: l.devices },
      devices: devices.map((d) => ({ ...d, local: localInfo[d.id] || null, linked: ls.filter((x) => x.tuyaId === d.id).map((x) => api.devices.list().find((v) => v.key === x.key)).filter(Boolean).map((v) => v.id) })),
      placeholders: api.devices.all().filter((d) => d.pending && /^Tuya/.test(d.note || '')).map((d) => ({ id: d.id, name: d.name, room: d.room, type: d.type })),
    };
  };
  const push = () => api.emit({ model: model() });

  api.route('GET', 'model', () => model());
  api.route('POST', 'qr', async ({ body }) => {
    const code = String((body && body.userCode) || '').trim();
    if (!code) throw new Error('Benutzercode fehlt');
    const r = await send('qr', { userCode: code });
    if (!r.ok) throw new Error(r.error);
    qrToken = r.token;
    const a = kvAuth(); a.userCode = code; api.kv.set('auth', a);
    return { qr: r.qr };
  });
  api.route('POST', 'qrpoll', async () => {
    if (!qrToken) throw new Error('Kein QR-Code angefordert');
    const a = kvAuth();
    const r = await send('qr_poll', { userCode: a.userCode, token: qrToken });
    if (!r.ok) throw new Error(r.error);
    if (!r.done) return { done: false };
    a.auth = r.auth; api.kv.set('auth', a); qrToken = null;
    api.log('info', 'angemeldet' + (r.auth.username ? ' als ' + r.auth.username : ''));
    start();
    return { done: true };
  });
  api.route('POST', 'refresh', async () => { const r = await send('refresh'); if (!r.ok) throw new Error(r.error); setDevices(r.devices); return { ok: true }; });
  api.route('POST', 'logout', async () => {
    clearTimeout(retry);
    try { if (proc) await send('disconnect', {}, 15000); } catch { /* ignorieren */ }
    api.kv.set('auth', { userCode: kvAuth().userCode, auth: null });
    devices = []; connected = false; error = ''; push();
    return { ok: true };
  });
  api.route('PUT', 'local', async ({ body }) => {
    const cur = kvLocal();
    const devs = {};
    if (body.devices && typeof body.devices === 'object') for (const [id, v] of Object.entries(body.devices)) {
      const ip = String((v && v.ip) || '').trim();
      if (!ip) continue;
      if (!/^[\d.]{7,15}$/.test(ip)) throw new Error(`IP-Adresse „${ip}“ ungültig`);
      const ver = Number(v.version) || 3.3;
      if (![3.1, 3.2, 3.3, 3.4, 3.5].includes(ver)) throw new Error('Protokollversion: 3.1 – 3.5');
      devs[String(id).slice(0, 60)] = { ip, version: ver };
    }
    const next = { enabled: body.enabled === undefined ? cur.enabled : !!body.enabled, devices: body.devices ? devs : cur.devices };
    api.kv.set('local', next);
    for (const k of Object.keys(localInfo)) delete localInfo[k];
    if (connected) { const r = await send('local_config', next, 20000); if (!r.ok) throw new Error(r.error); }
    push();
    return model();
  });
  api.route('POST', 'scan', async () => { if (connected) await send('local_scan', {}, 10000); return { ok: true }; });
  api.route('POST', 'link', ({ body }) => {
    const t = devices.find((x) => x.id === body.tuyaId);
    if (!t) throw new Error('Tuya-Gerät nicht gefunden');
    const type = ['light', 'switch', 'sensor', 'binary'].includes(body.type) ? body.type : 'switch';
    const code = String(body.code || '').slice(0, 60);
    const r = (t.ranges && t.ranges[code]) || {};
    const l = { tuyaId: t.id, type, name: String(body.name || t.name).slice(0, 80), room: String(body.room || '').slice(0, 60), unit: r.unit || '' };
    if (type === 'sensor') { l.value = code; l.scale = r.scale || 0; if (!l.value) throw new Error('Kein Messwert gewählt'); }
    else {
      l.on = code || (t.guess && t.guess.on) || '';
      if (!l.on) throw new Error('Kein Schaltcode für dieses Gerät gefunden');
      if (type === 'light' && t.guess && t.guess.brightness) { l.brightness = t.guess.brightness; l.brightnessMax = t.guess.brightnessMax || 1000; l.brightnessMin = (t.ranges[t.guess.brightness] || {}).min || 10; }
    }
    l.key = `${t.id}.${code || l.on}`.replace(/[^\w.:@#-]/g, '_').slice(0, 80);
    const all = links().filter((x) => x.key !== l.key);
    all.push(l); saveLinks(all);
    const v = api.devices.ensure({ key: l.key, name: l.name, room: l.room, type, unit: l.unit, adopt: body.deviceId || undefined });
    applyDevice(t.id, t.status, t.online);
    push();
    return { ok: true, id: v.id };
  });

  ensureLinked();
  start();
  return { stop() { stopped = true; clearTimeout(retry); const p = proc; proc = null; if (p) { try { p.kill(); } catch { /* ignorieren */ } } } };
};
