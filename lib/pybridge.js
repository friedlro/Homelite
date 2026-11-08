'use strict';
const { spawn } = require('child_process');
const readline = require('readline');
const Car = require('./car');

// Gemeinsame Hilfe für Python-Brücken (JSON-Zeilen über stdin/stdout).
class PyBridge {
  constructor(script, { onEvent, onDead, label }) {
    this.script = script;
    this.onEvent = onEvent || (() => {});
    this.onDead = onDead || (() => {});
    this.label = label || 'Brücke';
    this.proc = null;
    this.seq = 1;
    this.pending = new Map();
    this.stderr = [];
  }

  spawn() {
    if (this.proc) return;
    const bin = Car.pythonBin();
    const p = spawn(bin, [this.script], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    this.stderr = [];
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.event) return this.onEvent(m);
      const w = this.pending.get(m.id);
      if (!w) return;
      this.pending.delete(m.id);
      clearTimeout(w.t);
      w.resolve(m);
    });
    readline.createInterface({ input: p.stderr }).on('line', (l) => { this.stderr.push(l); if (this.stderr.length > 10) this.stderr.shift(); });
    p.on('error', (e) => { if (this.proc === p) this.dead(e.code === 'ENOENT' ? `${bin} nicht gefunden` : e.message); });
    p.on('exit', (code) => { if (this.proc === p) this.dead((this.stderr.slice(-3).join(' | ') || `${this.label} beendet`) + ` [Python: ${bin}, Exit ${code}]`); });
  }

  dead(msg) {
    this.proc = null;
    for (const w of this.pending.values()) { clearTimeout(w.t); w.reject(new Error(msg)); }
    this.pending.clear();
    this.onDead(msg);
  }

  send(cmd, extra = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      this.spawn();
      if (!this.proc) return reject(new Error(this.label + ' nicht gestartet'));
      const id = this.seq++;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('Zeitüberschreitung')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n');
    });
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.kill(); } catch { /* ignorieren */ } }
    for (const w of this.pending.values()) { clearTimeout(w.t); w.reject(new Error('gestoppt')); }
    this.pending.clear();
  }
}

module.exports = PyBridge;
