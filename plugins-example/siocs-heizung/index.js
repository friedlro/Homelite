'use strict';
// SIOCS Heizung: Python-Brücke (Playwright/Chromium) bedient das SIOCS-Webportal. Sensoren, Betriebsart, Korrektur, Heizzeiten.
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

const MODES = { auto: 'Automatik', off: 'Aus / Frostschutz', setback: 'Absenkbetrieb', heat: 'Heizbetrieb', schedule: 'Zeitprogramm', party: 'Partymodus' };
const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

// Sensoren: key = Feld der Brücke
const SENSORS = [
  { k: 'room_temp', key: 'raumtemperatur', name: 'Heizung Raumtemperatur', unit: '°C' },
  { k: 'room_setpoint', key: 'raumsoll', name: 'Heizung Raumsoll', unit: '°C' },
  { k: 'setpoint_param', key: 'raumsolltemperatur', name: 'Heizung Raumsolltemperatur', unit: '°C' },
  { k: 'offset', key: 'korrektur', name: 'Heizung Korrektur', unit: 'K' },
  { k: 'outdoor_avg_control', key: 'aussen', name: 'Heizung Außentemperatur (Regelung)', unit: '°C' },
  { k: 'power_kw', key: 'leistung', name: 'Heizung Leistung', unit: 'kW' },
  { k: 'spread_k', key: 'spreizung', name: 'Heizung Spreizung', unit: 'K' },
  { k: 'energy_kwh', key: 'waermemenge', name: 'Heizung Wärmemenge', unit: 'kWh' },
  { k: 'volume_m3', key: 'volumen', name: 'Heizung Volumen', unit: 'm³' },
  { k: 'mode_status', key: 'status', name: 'Heizung Status', unit: '' },
  { k: 'mode_selected', key: 'betriebsart', name: 'Heizung Betriebsart', unit: '' },
];

module.exports = (api) => {
  let proc = null, retry = null, stopped = false, error = '', stderr = [];
  let st = {};                 // letzter Stand der Brücke
  let dbgSeq = 1; const dbgWait = new Map();
  const K = (s) => 'siocs:' + s;

  function configured() { const c = api.config(); return !!(String(c.url || '').trim() && String(c.username || '').trim() && String(c.password || '').trim()); }

  function spawnProc() {
    if (proc) return;
    const bin = pythonBin();
    const p = spawn(bin, [process.env.HOMELITE_SIOCS_BRIDGE || path.join(__dirname, 'siocs_bridge.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc = p; stderr = [];
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.event === 'state') { st = m.state || {}; apply(); }
      else if (m.event === 'fatal') { error = m.error || 'Fehler'; push(); }
      else if (m.event === 'debug') { const w = dbgWait.get(m.id); if (w) { dbgWait.delete(m.id); clearTimeout(w.t); w.resolve(m); } }
    });
    readline.createInterface({ input: p.stderr }).on('line', (l) => { stderr.push(l); if (stderr.length > 12) stderr.shift(); api.log('debug', l); });
    p.on('error', (e) => { if (proc === p) dead(e.code === 'ENOENT' ? `${bin} nicht gefunden` : e.message); });
    p.on('exit', (code) => { if (proc === p) dead(error || (stderr.slice(-2).join(' | ') || 'Brücke beendet') + ` [Python: ${bin}, Exit ${code}]`); });
    const c = api.config();
    p.stdin.write(JSON.stringify({ cmd: 'config', url: c.url, username: c.username, password: c.password, poll: Number(c.poll) || 60 }) + '\n');
  }
  function dead(msg) {
    proc = null; error = msg; st = { ...st, ok: false };
    api.log('warn', msg); push();
    if (!stopped && configured()) { clearTimeout(retry); retry = setTimeout(start, 120000); }
  }
  function write(o) { if (!proc) throw new Error(error || 'Verbindung zum Portal nicht aktiv'); proc.stdin.write(JSON.stringify(o) + '\n'); }
  function kill() { const p = proc; proc = null; if (p) { try { p.kill(); } catch { /* ignorieren */ } } }
  function start() {
    clearTimeout(retry); kill(); error = '';
    if (!configured()) { st = {}; push(); return; }
    spawnProc(); push();
  }

  // ---------- Geräte ----------
  const room = () => api.config().room || '';
  function ensure() {
    const r = room();
    for (const s of SENSORS) api.devices.ensure({ key: K(s.key), name: s.name, type: 'sensor', unit: s.unit, room: r });
    api.devices.ensure({ key: K('heizung'), name: 'Heizung', type: 'thermostat', room: r });
    api.devices.ensure({ key: K('absenkung'), name: 'Heizung Absenkbetrieb', type: 'switch', room: r });
    api.devices.ensure({ key: K('party'), name: 'Heizung Partymodus', type: 'switch', room: r });
  }
  function apply() {
    try {
      for (const s of SENSORS) {
        let v = st[s.k];
        if (v === undefined || v === null) continue;
        if (s.k === 'mode_selected') v = MODES[v] || v;
        api.devices.setState(K(s.key), { value: v, online: st.ok !== false });
      }
      const t = {};
      if (typeof st.room_temp === 'number') t.current = st.room_temp;
      const sp = typeof st.setpoint_param === 'number' ? st.setpoint_param : st.room_setpoint;
      if (typeof sp === 'number') t.setpoint = sp;
      if (Object.keys(t).length) api.devices.setState(K('heizung'), { ...t, online: st.ok !== false });
      if (st.mode_selected) {
        api.devices.setState(K('absenkung'), { on: st.mode_selected === 'setback', online: st.ok !== false });
        api.devices.setState(K('party'), { on: st.mode_selected === 'party', online: st.ok !== false });
      }
    } catch (e) { api.log('warn', 'Zustand: ' + e.message); }
    push();
  }

  function setMode(mode) {
    if (!MODES[mode]) throw new Error('Betriebsart: ' + Object.keys(MODES).join(', '));
    write({ cmd: 'mode', mode });
    st.mode_selected = mode; apply();
  }
  function setOffset(v) {
    v = Number(v);
    if (!isFinite(v)) throw new Error('Zahl erwartet');
    v = Math.round(Math.max(-5, Math.min(5, v)) * 10) / 10;
    write({ cmd: 'offset', value: v });
    st.offset = v; apply();
    return v;
  }

  function setSetpoint(v) {
    v = Number(v);
    if (!isFinite(v)) throw new Error('Zahl erwartet');
    v = Math.round(Math.max(10, Math.min(30, v)) * 10) / 10;
    write({ cmd: 'setpoint', value: v });
    st.setpoint_param = v; apply();
    return v;
  }

  api.devices.onCommand((dev, action, value) => {
    if (!proc || st.ok === false && !st.updated) throw new Error('Portal nicht verbunden' + (error ? ': ' + error : ''));
    if (dev.key === K('absenkung') || dev.key === K('party')) {
      const mode = dev.key === K('absenkung') ? 'setback' : 'party';
      const on = action === 'toggle' ? st.mode_selected !== mode : action === 'on';
      if (action !== 'on' && action !== 'off' && action !== 'toggle') throw new Error('Aktion nicht unterstützt');
      setMode(on ? mode : 'auto');
      return { on };
    }
    if (dev.key === K('heizung') && action === 'setpoint') return { setpoint: setSetpoint(value) };
    throw new Error('Aktion nicht unterstützt: ' + action);
  });

  // ---------- Oberfläche ----------
  const today = () => { const d = (st.schedule || {})[DAYS[(new Date().getDay() + 6) % 7]]; return d ? d.filter((p) => p[0] !== p[1]).map((p) => `${p[0]}–${p[1]}`).join(', ') || 'keine' : null; };
  const model = () => ({
    configured: configured(), running: !!proc, error, ok: st.ok === true, updated: st.updated || null, values: st,
    modes: MODES, today: today(), schedule: st.schedule || null, scheduleCircuit: st.schedule_circuit || '', scheduleUpdated: st.schedule_updated || null, days: DAYS,
  });
  const push = () => api.emit({ model: model() });

  api.route('GET', 'model', () => model());
  api.route('POST', 'mode', ({ body }) => { setMode(body && body.mode); return model(); });
  api.route('POST', 'setpoint', ({ body }) => { setSetpoint(body && body.value); return model(); });
  api.route('POST', 'offset', ({ body }) => { setOffset(body && body.value); return model(); });
  api.route('POST', 'refresh', () => { write({ cmd: 'refresh' }); return { ok: true }; });
  api.route('POST', 'restart', () => { start(); return model(); });
  api.route('GET', 'debug', () => new Promise((resolve, reject) => {
    try { const id = dbgSeq++; const t = setTimeout(() => { dbgWait.delete(id); reject(new Error('Zeitüberschreitung')); }, 15000); dbgWait.set(id, { resolve, t }); write({ cmd: 'debug', id }); } catch (e) { reject(e); }
  }));
  api.mcp.tool({
    name: 'heizung_betriebsart', description: 'Betriebsart der Fernwärme-Heizung setzen: auto, off, setback, heat, schedule, party. Wirkt auf die echte Anlage.',
    control: true,
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: Object.keys(MODES) } }, required: ['mode'] },
    run: ({ mode }) => { setMode(mode); return { ok: true, mode }; },
  });

  api.onConfig(() => { ensure(); start(); });
  ensure();
  start();
  return { stop() { stopped = true; clearTimeout(retry); kill(); } };
};
