'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const EventEmitter = require('events');

const COMMANDS = {
  lock: 'Verriegeln', unlock: 'Entriegeln', ac_on: 'Klima an', ac_off: 'Klima aus',
  quick_heat: 'Schnell heizen', quick_cool: 'Schnell kühlen', windshield_defrost: 'Scheibe enteisen',
  battery_preheat: 'Batterie vorheizen', find: 'Fahrzeug finden',
  open_trunk: 'Kofferraum öffnen', close_trunk: 'Kofferraum schließen', unlock_charger: 'Ladestecker entriegeln',
  battery_preheat_off: 'Batterie-Vorheizen aus', steering_wheel_heat_on: 'Lenkradheizung an', steering_wheel_heat_off: 'Lenkradheizung aus',
  windows_close: 'Fenster schließen',
};

// Python-Interpreter: $PYTHON, sonst ./.venv im Projektordner, sonst python3
function pythonBin() {
  if (process.env.PYTHON) return process.env.PYTHON;
  for (const rel of ['.venv/bin/python3', '.venv/bin/python', 'venv/bin/python3']) {
    const f = path.join(__dirname, '..', rel);
    if (fs.existsSync(f)) return f;
  }
  return 'python3';
}

class Car extends EventEmitter {
  constructor(store, log) {
    super();
    this.store = store;
    this.log = log;
    this.status = null;
    this.error = '';
    this.proc = null;
    this.seq = 1;
    this.pending = new Map();
    this.stderr = [];
    this.timer = null;
  }

  get cfg() { return this.store.cfg.car; }

  spawnProc() {
    if (this.proc) return;
    const bin = Car.pythonBin();
    const p = spawn(bin, [path.join(__dirname, 'leap_bridge.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    this.stderr = [];
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      const w = this.pending.get(m.id);
      if (!w) return;
      this.pending.delete(m.id);
      clearTimeout(w.t);
      w.resolve(m);
    });
    readline.createInterface({ input: p.stderr }).on('line', (l) => { this.stderr.push(l); if (this.stderr.length > 10) this.stderr.shift(); });
    p.on('error', (e) => { if (this.proc === p) this.dead(e.code === 'ENOENT' ? `${bin} nicht gefunden` : e.message); });
    p.on('exit', (code) => { if (this.proc === p) this.dead((this.stderr.slice(-3).join(' | ') || 'Bridge beendet') + ` [Python: ${bin}, Exit ${code}]`); });
  }

  dead(msg) {
    this.proc = null;
    this.error = msg;
    for (const w of this.pending.values()) { clearTimeout(w.t); w.reject(new Error(msg)); }
    this.pending.clear();
  }

  send(cmd) {
    return new Promise((resolve, reject) => {
      this.spawnProc();
      if (!this.proc) return reject(new Error(this.error || 'Bridge nicht gestartet'));
      const id = this.seq++;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('Zeitüberschreitung')); }, 90000);
      this.pending.set(id, { resolve, reject, t });
      const c = this.cfg;
      this.proc.stdin.write(JSON.stringify({
        id, cmd,
        cfg: { username: c.username, password: c.password, pin: c.pin, certPath: c.certPath, keyPath: c.keyPath, vin: c.vin },
      }) + '\n');
    });
  }

  // Adresse zum Standort (OpenStreetMap/Nominatim, Ergebnis wird je ~10 m-Raster gemerkt)
  async reverse(lat, lon) {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (this.geo && this.geo.key === key) return this.geo.addr;
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=de&lat=${lat}&lon=${lon}`, {
      headers: { 'User-Agent': 'HomeLite/1.1 (private home automation)' }, signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const a = j.address || {};
    const street = [a.road || a.pedestrian || a.path || a.footway, a.house_number].filter(Boolean).join(' ');
    const town = [a.postcode, a.city || a.town || a.village || a.municipality].filter(Boolean).join(' ');
    const addr = [street, town].filter(Boolean).join(', ') || j.display_name || '';
    this.geo = { key, addr };
    return addr;
  }

  distanceHome(lat, lon) {
    const z = (this.store.cfg.geofence.zones || []).find((x) => x.home) || {};
    if (z.lat == null || z.lon == null) return null;
    const R = 6371;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(lat - z.lat);
    const dLon = rad(lon - z.lon);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(z.lat)) * Math.cos(rad(lat)) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 100) / 100;
  }

  async poll() {
    const c = this.cfg;
    if (!c.enabled) return;
    if (!c.username || !c.password) { this.error = 'E-Mail und Passwort fehlen'; this.emit('status'); return; }
    try {
      const r = await this.send('status');
      if (r.ok) {
        this.status = { ...r.status, vin: r.vin, ts: Date.now() };
        this.error = '';
        const { lat, lon } = this.status;
        if (typeof lat === 'number' && typeof lon === 'number') {
          this.status.distHome = this.distanceHome(lat, lon);
          try { this.status.address = await this.reverse(lat, lon); } catch (e) { this.status.address = (this.geo && this.geo.addr) || ''; this.log('debug', 'Adresse: ' + e.message); }
        }
      } else this.error = r.error;
    } catch (e) { this.error = e.message; }
    this.emit('status');
  }

  async command(name) {
    if (!COMMANDS[name]) throw new Error('Unbekannter Fahrzeugbefehl');
    if (!this.cfg.enabled) throw new Error('Leapmotor ist nicht aktiviert');
    const r = await this.send(name);
    if (!r.ok) throw new Error(r.error);
    this.log('info', `🚗 ${COMMANDS[name]} gesendet`);
    setTimeout(() => this.poll(), 8000);
  }

  start() {
    clearInterval(this.timer);
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; }
    if (!this.cfg.enabled) return;
    const min = Math.max(2, Number(this.cfg.pollMinutes) || 10);
    setTimeout(() => this.poll(), 1500);
    this.timer = setInterval(() => this.poll(), min * 60000);
  }

  stop() { clearInterval(this.timer); if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; } }

  snapshot() { return { enabled: !!this.cfg.enabled, name: this.cfg.name, status: this.status, error: this.error }; }
}

Car.COMMANDS = COMMANDS;
Car.pythonBin = pythonBin;
module.exports = Car;
