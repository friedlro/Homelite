'use strict';
const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const BRIDGE = process.env.HOMELITE_MATTER_BRIDGE || path.join(__dirname, 'matter_bridge.mjs'); // Umgebungsvariable nur für Tests

const nodeOk = () => {
  const [a, b] = process.versions.node.split('.').map(Number);
  return a > 22 || (a === 22 && b >= 13) || (a === 20 && b >= 19);
};
const installed = () => !!process.env.HOMELITE_MATTER_BRIDGE || fs.existsSync(path.join(APP, 'node_modules', '@matter', 'main', 'package.json'));

class Matter extends EventEmitter {
  constructor({ store, devices, log }) {
    super();
    this.store = store;
    this.devices = devices;
    this.log = log;
    this.proc = null;
    this.ready = false;
    this.error = '';
    this.entities = [];
    this.nodes = [];
    this.pending = new Map();
    this.seq = 1;
    this.timer = null;
    this.installing = false;
    this.installLog = '';
  }

  get cfg() { return this.store.cfg.matter; }
  status() {
    return {
      enabled: !!this.cfg.enabled, nodeOk: nodeOk(), nodeVersion: process.versions.node, installed: installed(), running: !!this.proc, ready: this.ready,
      error: this.error, installing: this.installing, installLog: this.installLog.slice(-1500), nodes: this.nodes, entities: this.entities.length,
    };
  }

  start() {
    clearTimeout(this.timer);
    if (!this.cfg.enabled || this.proc) return;
    if (!nodeOk()) { this.error = `Node ${process.versions.node} ist zu alt (benötigt ≥ 22.13)`; this.emit('status'); return; }
    if (!installed()) { this.error = 'Matter-Paket nicht installiert'; this.emit('status'); return; }
    const dir = path.join(this.store.DATA, 'matter');
    fs.mkdirSync(dir, { recursive: true });
    this.error = '';
    const p = spawn(process.execPath, ['--max-old-space-size=160', BRIDGE, dir], { cwd: APP, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); this.onLine(line); }
    });
    let errbuf = '';
    p.stderr.on('data', (d) => { errbuf = (errbuf + d).slice(-2000); });
    p.on('exit', (code) => {
      this.proc = null;
      this.ready = false;
      for (const [, w] of this.pending) w.reject(new Error('Matter-Prozess beendet'));
      this.pending.clear();
      if (code !== 2 && !this.error && errbuf) this.log('warn', 'Matter: ' + errbuf.trim().split('\n').slice(-2).join(' '));
      this.log(code === 0 ? 'info' : 'warn', `Matter-Prozess beendet (Code ${code})`);
      this.emit('status');
      if (this.cfg.enabled && code !== 2) this.timer = setTimeout(() => this.start(), 10000);
    });
    p.on('error', (e) => { this.error = e.message; this.proc = null; this.emit('status'); });
    this.emit('status');
  }

  stop() {
    clearTimeout(this.timer);
    if (this.proc) { try { this.proc.stdin.end(); this.proc.kill(); } catch { /* ignorieren */ } }
    this.proc = null;
    this.ready = false;
  }

  onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id) {
      const w = this.pending.get(m.id);
      if (!w) return;
      this.pending.delete(m.id);
      clearTimeout(w.t);
      if (m.ok) w.resolve(m.result); else w.reject(new Error(m.error || 'Fehler'));
      return;
    }
    switch (m.t) {
      case 'ready': this.ready = true; this.error = ''; this.log('info', 'Matter-Controller bereit'); this.refreshNodes(); this.emit('status'); break;
      case 'fatal': this.error = m.error; this.log('error', 'Matter: ' + m.error); this.emit('status'); break;
      case 'log': this.log('info', 'Matter: ' + m.msg); break;
      case 'entities': this.entities = m.entities; this.refreshNodes(); this.emit('entities', m.entities); this.emit('status'); break;
      case 'values': this.emit('values', m.values); break;
      default: break;
    }
  }

  call(cmd, args = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.ready) return reject(new Error('Matter-Controller läuft nicht' + (this.error ? ': ' + this.error : '')));
      const id = this.seq++;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('Zeitüberschreitung')); }, timeout);
      this.pending.set(id, { resolve, reject, t });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  diag() { return this.call('diag', {}, 30000); }
  refreshNodes() { this.call('nodes').then((n) => { this.nodes = n; this.emit('status'); }).catch(() => {}); }
  commission(code) { return this.call('commission', { code }, 120000); }
  async remove(peer) { await this.call('remove', { peer }, 60000); this.refreshNodes(); }

  // Zustand eines Matter-Geräts übernehmen
  applyValue(dev, x) {
    const prev = { ...(this.devices.states.get(dev.id) || {}) };
    const st = { ...prev, ts: Date.now(), online: true };
    switch (dev.matter.kind) {
      case 'lock': if (x.value == null) return; st.state = x.value; st.on = x.value === 'locked'; break;
      case 'switch': st.on = !!x.value; break;
      case 'light': st.on = !!x.value; if (x.level != null) st.brightness = x.level; break;
      case 'cover': if (x.value == null) return; st.state = x.value; break;
      case 'contact': case 'occupancy': if (x.value == null) return; st.on = !!x.value; break;
      default: if (x.value == null) return; st.value = x.value;
    }
    this.devices.setState(dev, st, prev);
  }

  applyAll(list) {
    for (const x of list) {
      const dev = this.devices.list.find((d) => d.driver === 'matter' && d.matter && `${d.matter.peer}/${d.matter.endpoint}/${d.matter.kind}` === x.key);
      if (dev) this.applyValue(dev, x);
    }
  }

  async control(dev, action, value) {
    const m = dev.matter || {};
    const st = this.devices.states.get(dev.id) || {};
    let a = action;
    if (m.kind === 'lock') {
      if (a === 'toggle') a = st.state === 'locked' ? 'unlock' : 'lock';
      if (a === 'on') a = 'lock';
      if (a === 'off') a = 'unlock';
    }
    if (m.kind === 'cover' && a === 'toggle') a = st.state === 'closed' ? 'open' : st.state === 'opening' || st.state === 'closing' ? 'stop' : 'close';
    await this.call('invoke', { peer: m.peer, endpoint: m.endpoint, kind: m.kind, action: a, value }, 40000);
  }

  install() {
    if (this.installing) return Promise.reject(new Error('Installation läuft bereits'));
    if (!nodeOk()) return Promise.reject(new Error(`Node ${process.versions.node} ist zu alt (benötigt ≥ 22.13)`));
    this.installing = true;
    this.installLog = '';
    this.emit('status');
    return new Promise((resolve, reject) => {
      const p = spawn('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', '--include=optional'], { cwd: APP });
      const add = (d) => { this.installLog = (this.installLog + d).slice(-6000); };
      p.stdout.on('data', add);
      p.stderr.on('data', add);
      p.on('error', (e) => { this.installing = false; this.emit('status'); reject(new Error('npm nicht gefunden: ' + e.message)); });
      p.on('exit', (code) => {
        this.installing = false;
        this.emit('status');
        if (code === 0 && installed()) { this.log('info', 'Matter-Paket installiert'); resolve(); } else reject(new Error('npm install fehlgeschlagen – Details im Protokoll der Installation'));
      });
    });
  }
}

module.exports = Matter;
