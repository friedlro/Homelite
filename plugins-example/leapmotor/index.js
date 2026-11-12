'use strict';
// Leapmotor: Fahrzeugstatus (Ladestand, Reichweite, Reifen, Standort …) und Fernbefehle über die Leapmotor-Cloud (inoffiziell).
// Python-Brücke (leap_bridge.py, Client nach kerniger/leapmotor-ha) – früher fest in HomeLite eingebaut (bis 1.25.14).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const COMMANDS = {
  lock: 'Verriegeln', unlock: 'Entriegeln', ac_on: 'Klima an', ac_off: 'Klima aus',
  quick_heat: 'Schnell heizen', quick_cool: 'Schnell kühlen', windshield_defrost: 'Scheibe enteisen',
  battery_preheat: 'Batterie vorheizen', find: 'Fahrzeug finden',
  open_trunk: 'Kofferraum öffnen', close_trunk: 'Kofferraum schließen', unlock_charger: 'Ladestecker entriegeln',
  battery_preheat_off: 'Batterie-Vorheizen aus', steering_wheel_heat_on: 'Lenkradheizung an', steering_wheel_heat_off: 'Lenkradheizung aus',
  windows_close: 'Fenster schließen',
};
const RISKY = ['unlock', 'open_trunk', 'unlock_charger']; // nicht über den KI-Zugriff
const CERT_FILES = ['app_cert.pem', 'app_key.pem'];
const CERT_SRC = { 'app_cert.pem': 'app.crt', 'app_key.pem': 'app.key' };

function pythonBin() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const roots = [process.cwd(), path.resolve(__dirname, '..', '..', '..'), path.resolve(__dirname, '..', '..')];
  for (const r of roots) for (const rel of ['.venv/bin/python3', '.venv/bin/python', 'venv/bin/python3']) { const f = path.join(r, rel); if (fs.existsSync(f)) return f; }
  return 'python3';
}

module.exports = (api) => {
  const K = (s) => 'leap:' + s;
  let proc = null, error = '', stderr = [], status = null, timer = null, seq = 1, geo = null, stopped = false, polling = false;
  const pending = new Map();
  const certDir = path.join(api.dataDir, 'certs');
  const cfg = () => api.config();
  const configured = () => !!(String(cfg().username || '').trim() && String(cfg().password || '').trim());
  const certsOk = () => CERT_FILES.every((f) => fs.existsSync(path.join(certDir, f))) || (String(cfg().certPath || '').trim() && String(cfg().keyPath || '').trim());

  // Zertifikate früherer Installationen (lib/leapmotor/certs) übernehmen
  function adoptCerts() {
    fs.mkdirSync(certDir, { recursive: true });
    if (CERT_FILES.every((f) => fs.existsSync(path.join(certDir, f)))) return;
    const roots = [process.cwd(), path.resolve(__dirname, '..', '..', '..'), path.resolve(__dirname, '..', '..')];
    for (const r of roots) {
      const d = path.join(r, 'lib', 'leapmotor', 'certs');
      if (CERT_FILES.every((f) => fs.existsSync(path.join(d, f)))) {
        for (const f of CERT_FILES) fs.copyFileSync(path.join(d, f), path.join(certDir, f));
        try { for (const f of CERT_FILES) fs.chmodSync(path.join(certDir, f), 0o600); } catch { /* egal */ }
        api.log('info', 'App-Zertifikate aus ' + d + ' übernommen');
        return;
      }
    }
  }
  // App-Zertifikate aus dem öffentlichen Repository markoceri/leapmotor-certs laden
  async function downloadCerts() {
    fs.mkdirSync(certDir, { recursive: true });
    for (const f of CERT_FILES) {
      const r = await fetch(`https://raw.githubusercontent.com/markoceri/leapmotor-certs/main/${CERT_SRC[f]}`, { headers: { 'User-Agent': 'HomeLite-Leapmotor' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`Download ${CERT_SRC[f]}: HTTP ${r.status}`);
      const t = await r.text(); const i = t.indexOf('-----BEGIN');
      if (i < 0 || t.length > 20000) throw new Error('Unerwartete Zertifikatsdatei');
      fs.writeFileSync(path.join(certDir, f), t.slice(i), { mode: 0o600 });
    }
    api.log('info', 'App-Zertifikate geladen');
  }

  // ---------- Python-Brücke ----------
  function spawnProc() {
    if (proc) return;
    const bin = pythonBin();
    const p = spawn(bin, [process.env.HOMELITE_LEAP_BRIDGE || path.join(__dirname, 'leap_bridge.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc = p; stderr = [];
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      const w = pending.get(m.id); if (!w) return;
      pending.delete(m.id); clearTimeout(w.t); w.resolve(m);
    });
    readline.createInterface({ input: p.stderr }).on('line', (l) => { stderr.push(l); if (stderr.length > 10) stderr.shift(); });
    p.on('error', (e) => { if (proc === p) dead(e.code === 'ENOENT' ? `${bin} nicht gefunden` : e.message); });
    p.on('exit', (code) => { if (proc === p) dead((stderr.slice(-3).join(' | ') || 'Brücke beendet') + ` [Python: ${bin}, Exit ${code}]`); });
  }
  function dead(msg) {
    proc = null; error = msg; api.log('warn', msg);
    for (const w of pending.values()) { clearTimeout(w.t); w.reject(new Error(msg)); }
    pending.clear(); push();
  }
  function kill() { const p = proc; proc = null; if (p) { try { p.kill(); } catch { /* egal */ } } }
  function send(cmd) {
    return new Promise((resolve, reject) => {
      spawnProc();
      if (!proc) return reject(new Error(error || 'Brücke nicht gestartet'));
      const id = seq++;
      const t = setTimeout(() => { pending.delete(id); reject(new Error('Zeitüberschreitung')); }, 90000);
      pending.set(id, { resolve, reject, t });
      const c = cfg();
      proc.stdin.write(JSON.stringify({ id, cmd, cfg: { username: c.username, password: c.password, pin: c.pin, certPath: c.certPath, keyPath: c.keyPath, vin: c.vin, certDir } }) + '\n');
    });
  }

  // ---------- Standort ----------
  async function reverse(lat, lon) {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (geo && geo.key === key) return geo.addr;
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=de&lat=${lat}&lon=${lon}`, { headers: { 'User-Agent': 'HomeLite/1.0 (private home automation)' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(); const a = j.address || {};
    const street = [a.road || a.pedestrian || a.path || a.footway, a.house_number].filter(Boolean).join(' ');
    const town = [a.postcode, a.city || a.town || a.village || a.municipality].filter(Boolean).join(' ');
    const addr = [street, town].filter(Boolean).join(', ') || j.display_name || '';
    geo = { key, addr };
    return addr;
  }
  function distanceHome(lat, lon) {
    const z = api.home && api.home();
    if (!z) return null;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(lat - z.lat), dLon = rad(lon - z.lon);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(z.lat)) * Math.cos(rad(lat)) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * 6371 * Math.asin(Math.sqrt(a)) * 100) / 100;
  }

  // ---------- Geräte ----------
  const SENSORS = [
    ['soc', 'Ladestand', '%'], ['range', 'Reichweite', 'km'], ['odometer', 'Kilometerstand', 'km'], ['interiorTemp', 'Innentemperatur', '°C'],
    ['outdoorTemp', 'Außentemperatur', '°C'], ['chargePower', 'Ladeleistung', 'kW'], ['distHome', 'Entfernung von Zuhause', 'km'],
  ];
  const BINARY = [['charging', 'lädt', 'Lädt'], ['pluggedIn', 'pluggedIn', 'Ladestecker angesteckt'], ['locked', 'locked', 'Verriegelt'], ['acOn', 'acOn', 'Klima an']];
  const label = () => String(cfg().name || 'Leapmotor').slice(0, 30);
  const room = () => cfg().room || '';
  function ensure() {
    const n = label();
    for (const [k, t, u] of SENSORS) api.devices.ensure({ key: K(k), name: `${n} ${t}`, type: 'sensor', unit: u, room: room() });
    for (const [k, , t] of BINARY) api.devices.ensure({ key: K(k), name: `${n} ${t}`, type: 'binary', room: room() });
  }
  function apply() {
    if (!status) return;
    try {
      for (const [k] of SENSORS) { const v = status[k]; if (typeof v === 'number' && isFinite(v)) api.devices.setState(K(k), { value: v, online: true }); }
      for (const [k] of BINARY) { const v = status[k]; if (typeof v === 'boolean') api.devices.setState(K(k), { on: v, online: true }); }
    } catch (e) { api.log('warn', 'Zustand: ' + e.message); }
  }

  // ---------- Abfrage / Befehle ----------
  const model = () => ({ configured: configured(), certs: !!certsOk(), name: label(), status, error, commands: COMMANDS, pollMinutes: poll() / 60000 });
  const push = () => api.emit({ model: model() });
  const poll = () => Math.max(2, Number(cfg().pollMinutes) || 10) * 60000;

  async function refresh() {
    if (polling) return;
    if (!configured()) { error = 'E-Mail und Passwort fehlen'; push(); return; }
    if (!certsOk()) { error = 'App-Zertifikate fehlen – auf der Seite „Zertifikate laden“ wählen'; push(); return; }
    polling = true;
    try {
      const r = await send('status');
      if (r.ok) {
        status = { ...r.status, vin: r.vin, ts: Date.now() }; error = '';
        const { lat, lon } = status;
        if (typeof lat === 'number' && typeof lon === 'number') {
          status.distHome = distanceHome(lat, lon);
          try { status.address = await reverse(lat, lon); } catch (e) { status.address = (geo && geo.addr) || ''; api.log('debug', 'Adresse: ' + e.message); }
        }
        apply();
      } else error = r.error;
    } catch (e) { error = e.message; }
    polling = false; push();
  }
  async function command(name) {
    if (!COMMANDS[name]) throw new Error('Unbekannter Fahrzeugbefehl');
    if (!configured()) throw new Error('Leapmotor ist nicht eingerichtet');
    const r = await send(name);
    if (!r.ok) throw new Error(r.error);
    api.log('info', `🚗 ${COMMANDS[name]} gesendet`);
    api.after(() => refresh(), 8000);
    return { ok: true, command: name };
  }
  function start() {
    kill(); error = '';
    if (timer) { timer(); timer = null; }
    ensure();
    if (!configured()) { status = null; push(); return; }
    api.after(() => refresh(), 1500);
    timer = api.timer(() => refresh(), poll());
  }

  api.devices.onCommand(() => { throw new Error('Das Auto wird über Befehle gesteuert (Seite „Auto“ oder Automation „Leapmotor“)'); });
  api.route('GET', 'model', () => model());
  api.route('POST', 'refresh', () => { refresh(); return { ok: true }; });
  api.route('POST', 'command', async ({ body }) => command(String(body && body.command || '')));
  api.route('POST', 'certs', async () => { await downloadCerts(); start(); return model(); });
  api.mcp.tool({ name: 'get_car', description: 'Leapmotor-Auto: Ladestand, Reichweite, Verriegelung, Reifendruck, Standort.', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => ({ enabled: configured(), name: label(), status, error }) });
  api.mcp.tool({
    name: 'car_command', description: 'Leapmotor-Befehl senden (Klima, Heizen, Verriegeln, Fahrzeug finden …). Entriegeln und Kofferraum öffnen sind über den KI-Zugriff gesperrt.', control: true,
    inputSchema: { type: 'object', properties: { command: { type: 'string', enum: Object.keys(COMMANDS).filter((k) => !RISKY.includes(k)) } }, required: ['command'] },
    run: ({ command: c }) => { if (RISKY.includes(c)) throw new Error('Dieser Befehl ist über den KI-Zugriff gesperrt'); return command(c); },
  });
  // Für die Automations-Aktion „Leapmotor“ im Kern
  api.expose({ command, snapshot: () => ({ enabled: configured(), name: label(), status, error }), commands: COMMANDS });

  adoptCerts();
  api.onConfig(() => { start(); });
  start();
  return { stop() { stopped = true; kill(); for (const w of pending.values()) clearTimeout(w.t); pending.clear(); } };
};
