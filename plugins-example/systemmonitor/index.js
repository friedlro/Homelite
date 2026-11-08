'use strict';
// Systemüberwachung: liest /proc (Linux) bzw. das os-Modul, legt Sensoren an, speichert 24 h Verlauf, warnt bei Grenzwerten.
const fs = require('fs');
const os = require('os');

module.exports = (api) => {
  const HIST_MAX = 1440;                       // 24 h bei einem Punkt pro Minute
  let hist = (() => { const v = api.kv.get('hist'); return Array.isArray(v) ? v : []; })();
  let prevCpu = null;
  let cur = {};
  let lastHist = 0;
  const alarm = {};                            // key -> { since, active }

  const rd = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

  function cpuTimes() {
    const l = rd('/proc/stat').split('\n')[0];
    if (l.startsWith('cpu ')) {
      const n = l.trim().split(/\s+/).slice(1).map(Number);
      const idle = (n[3] || 0) + (n[4] || 0);
      return { idle, total: n.reduce((a, b) => a + b, 0) };
    }
    let idle = 0, total = 0;
    for (const c of os.cpus()) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; }
    return { idle, total };
  }

  function mem() {
    const m = {};
    for (const line of rd('/proc/meminfo').split('\n')) { const x = line.match(/^(\w+):\s+(\d+)/); if (x) m[x[1]] = Number(x[2]) * 1024; }
    const total = m.MemTotal || os.totalmem();
    const avail = m.MemAvailable != null ? m.MemAvailable : os.freemem();
    const swT = m.SwapTotal || 0, swF = m.SwapFree || 0;
    return { total, used: total - avail, pct: total ? (100 * (total - avail)) / total : 0, swapTotal: swT, swapPct: swT ? (100 * (swT - swF)) / swT : 0 };
  }

  function temp() {
    for (let i = 0; i < 6; i++) {
      const t = rd(`/sys/class/thermal/thermal_zone${i}/temp`).trim();
      if (t && Number(t) > 0) return Number(t) / 1000;
    }
    return null;
  }

  function disk() {
    try {
      const p = String(api.config().path || '').trim() || api.dataDir;
      const s = fs.statfsSync(p);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      return { total, used: total - free, pct: total ? (100 * (total - free)) / total : 0, path: p };
    } catch { return null; }
  }

  const r1 = (x) => Math.round(x * 10) / 10;

  function sample() {
    const t = cpuTimes();
    let cpu = cur.cpu != null ? cur.cpu : 0;
    if (prevCpu && t.total > prevCpu.total) cpu = 100 * (1 - (t.idle - prevCpu.idle) / (t.total - prevCpu.total));
    prevCpu = t;
    const m = mem();
    const d = disk();
    const tp = temp();
    const [l1, l5, l15] = os.loadavg();
    cur = {
      time: Date.now(),
      cpu: r1(Math.max(0, Math.min(100, cpu))),
      ram: r1(m.pct), ramUsed: m.used, ramTotal: m.total,
      swap: r1(m.swapPct), swapTotal: m.swapTotal,
      temp: tp == null ? null : r1(tp),
      disk: d ? r1(d.pct) : null, diskUsed: d ? d.used : 0, diskTotal: d ? d.total : 0, diskPath: d ? d.path : '',
      load1: r1(l1), load5: r1(l5), load15: r1(l15), cores: os.cpus().length || 1,
      uptime: Math.round(os.uptime()),
      proc: process.memoryUsage().rss,
      host: os.hostname(), platform: `${os.type()} ${os.release()} ${os.arch()}`,
    };
    if (Date.now() - lastHist >= 60000) {
      lastHist = Date.now();
      hist.push({ t: cur.time, cpu: cur.cpu, ram: cur.ram, temp: cur.temp, disk: cur.disk, load: cur.load1 });
      if (hist.length > HIST_MAX) hist = hist.slice(-HIST_MAX);
      api.kv.set('hist', hist);
    }
    return cur;
  }

  const SENSORS = [
    ['cpu', 'System CPU', '%'], ['ram', 'System Arbeitsspeicher', '%'], ['temp', 'System Temperatur', '°C'],
    ['disk', 'System Datenträger', '%'], ['load1', 'System Last (1 Min)', ''],
  ];

  function publish() {
    const cfg = api.config();
    if (cfg.sensors !== false) {
      for (const [k, name, unit] of SENSORS) {
        if (cur[k] == null) continue;
        api.devices.ensure({ key: k, name, type: 'sensor', unit });
        api.devices.setState(k, { value: cur[k] });
      }
    }
    api.emit({ now: cur, alarms: activeAlarms() });
  }

  function check() {
    const c = api.config();
    const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
    const rules = [
      ['cpu', 'CPU', cur.cpu, num(c.cpuMax, 90), '%', num(c.cpuMin, 5) * 60000],
      ['ram', 'Arbeitsspeicher', cur.ram, num(c.ramMax, 90), '%', 120000],
      ['temp', 'Temperatur', cur.temp, num(c.tempMax, 75), '°C', 60000],
      ['disk', 'Datenträger', cur.disk, num(c.diskMax, 90), '%', 0],
    ];
    for (const [k, label, val, max, unit, hold] of rules) {
      const a = alarm[k] || (alarm[k] = { since: 0, active: false });
      if (val != null && val > max) {
        if (!a.since) a.since = Date.now();
        if (!a.active && Date.now() - a.since >= hold) {
          a.active = true;
          api.log('warn', `${label} ${val}${unit} über Grenzwert ${max}${unit}`);
          if (c.notify !== false) api.notify(`Systemwarnung: ${label} bei ${val}${unit} (Grenzwert ${max}${unit})`);
          api.fire('system-' + k + '-hoch');
        }
      } else {
        if (a.active) { api.log('info', `${label} wieder normal`); api.fire('system-' + k + '-normal'); }
        a.since = 0; a.active = false;
      }
    }
  }
  const activeAlarms = () => Object.entries(alarm).filter(([, a]) => a.active).map(([k]) => k);

  function tick() { sample(); check(); publish(); }

  api.route('GET', 'status', () => ({ now: cur, alarms: activeAlarms() }));
  api.route('GET', 'history', () => ({ hist }));

  api.mcp.tool({
    name: 'system_status', description: 'Aktuelle Auslastung des HomeLite-Rechners: CPU, Arbeitsspeicher, Temperatur, Datenträger, Last, Laufzeit.',
    inputSchema: { type: 'object', properties: {} }, readOnly: true,
    run: () => ({ ...cur, alarme: activeAlarms() }),
  });

  const every = () => Math.min(300, Math.max(5, Number(api.config().interval) || 15)) * 1000;
  prevCpu = cpuTimes();
  setTimeout(tick, 1500).unref?.();
  let stop = api.timer(tick, every());
  api.onConfig(() => { stop(); stop = api.timer(tick, every()); tick(); });
  return { stop() { api.kv.set('hist', hist); } };
};
