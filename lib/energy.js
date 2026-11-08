'use strict';
const fs = require('fs');
const path = require('path');

const DAY_KEEP = 400;
const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const r2 = (n) => Math.round(n * 1000) / 1000;

function createEnergy({ store, devices, log, sse }) {
  const FILE = path.join(store.DATA, 'energy.json');
  const sql = store.db; // SQLite (Tabellen energy_day / energy_series) oder JSON-Datei als Rückfall
  let db = { days: {}, series: {} };
  const touched = new Set();
  if (sql) {
    for (const r of sql.prepare('SELECT day,json FROM energy_day').all()) { try { db.days[r.day] = JSON.parse(r.json); } catch { /* ignorieren */ } }
    // einmalige Übernahme der alten energy.json
    try {
      if (!Object.keys(db.days).length) {
        const old = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        db.days = old.days || {};
        for (const k of Object.keys(db.days)) touched.add(k);
        const ins = sql.prepare('INSERT OR REPLACE INTO energy_series(ts,pv,grid,bat,house,soc) VALUES(?,?,?,?,?,?)');
        sql.exec('BEGIN');
        for (const arr of Object.values(old.series || {})) for (const r of arr) ins.run(r[0], r[1], r[2], r[3], r[4], r[5]);
        sql.exec('COMMIT');
        const up0 = sql.prepare('INSERT INTO energy_day(day,json) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET json=excluded.json');
        for (const k of Object.keys(db.days)) up0.run(k, JSON.stringify(db.days[k]));
        touched.clear();
        fs.renameSync(FILE, FILE + '.migrated');
      }
    } catch { try { sql.exec('ROLLBACK'); } catch { /* ignorieren */ } }
  } else {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* neu */ }
  }
  let last = 0;
  let lastSave = 0;
  let lastSeries = 0;
  let lastKeep = 0;
  let now = { pv: null, grid: null, bat: null, soc: null, house: null };
  let dirty = false;

  // ---- Viertelstunden-Leistung und kurze Spitzen (Netzbezug) ----
  const Q = 900000;
  if (sql) {
    sql.exec('CREATE TABLE IF NOT EXISTS energy_quarter (ts INTEGER PRIMARY KEY, imp REAL, exp REAL, peak INTEGER, cov INTEGER, pts INTEGER)');
    try { sql.exec('ALTER TABLE energy_quarter ADD COLUMN pts INTEGER'); } catch { /* Spalte vorhanden */ }
  }
  if (!db.quarters) db.quarters = {};
  let q = null;                                   // laufende Viertelstunde { ts, imp, exp, peak, pts, cov }
  const qStart = (t) => Math.floor(t / Q) * Q;
  function qSave(x) {
    if (!x || store.frozen) return;
    const row = [x.ts, r2(x.imp), r2(x.exp), Math.round(x.peak), Math.round(x.cov), x.pts || 0];
    if (sql) sql.prepare('INSERT OR REPLACE INTO energy_quarter(ts,imp,exp,peak,cov,pts) VALUES(?,?,?,?,?,?)').run(...row);
    else db.quarters[x.ts] = row.slice(1);
  }
  function qFor(t) {
    const ts = qStart(t);
    if (!q || q.ts !== ts) {
      qSave(q);
      let old = null;
      if (sql) old = sql.prepare('SELECT ts,imp,exp,peak,cov,pts FROM energy_quarter WHERE ts=?').get(ts);
      else if (db.quarters[ts]) { const a = db.quarters[ts]; old = { ts, imp: a[0], exp: a[1], peak: a[2], cov: a[3], pts: a[4] }; }
      q = old ? { ...old, pts: old.pts || 0 } : { ts, imp: 0, exp: 0, peak: 0, pts: 0, cov: 0 };
    }
    return q;
  }
  function qPeak(t, grid) {
    const x = qFor(t);
    if (grid > x.peak) { x.peak = grid; x.pts = t; dirty = true; }
  }
  function qAdd(t, dt, grid) {
    const x = qFor(t);
    x.imp += (Math.max(grid, 0) * dt) / 1000;
    x.exp += (Math.max(-grid, 0) * dt) / 1000;
    x.cov += dt * 3600;
    qPeak(t, grid);
  }
  // wird bei jeder Wertänderung eines Netz-Sensors aufgerufen, damit auch Spitzen unter 10 Sekunden erfasst werden
  function noteGrid() {
    if (!configured() || store.frozen) return;
    const c = cfg();
    let g = sum(c.grid);
    if (g === null) return;
    if (c.gridInvert) g = -g;
    qPeak(Date.now(), g);
  }
  const kwOf = (imp) => r2(imp * 4);            // kWh in 15 min → mittlere Leistung in kW
  function quarterRows(from, to) {
    let rows;
    if (sql) rows = sql.prepare('SELECT ts,imp,exp,peak,cov,pts FROM energy_quarter WHERE ts>=? AND ts<? ORDER BY ts').all(from, to);
    else rows = Object.entries(db.quarters).map(([ts, a]) => ({ ts: Number(ts), imp: a[0], exp: a[1], peak: a[2], cov: a[3], pts: a[4] })).filter((r) => r.ts >= from && r.ts < to).sort((a, b) => a.ts - b.ts);
    if (q && q.ts >= from && q.ts < to) { const i = rows.findIndex((r) => r.ts === q.ts); const cur = { ...q }; if (i >= 0) rows[i] = cur; else rows.push(cur); }
    return rows;
  }
  function peaks(range) {
    const lim = Number(cfg().peakLimit) || 0;
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const out = { limit: lim };
    // kw = Viertelstunden-Mittel, peakKw = kurze Spitze (höchster Momentanwert), peakTs = Zeitpunkt der Spitze
    const mk = (r) => ({ ts: r.ts, kw: kwOf(r.imp), expKw: kwOf(r.exp), peakKw: r2((r.peak || 0) / 1000), peakTs: r.pts || r.ts });
    if (range === 'today') out.quarters = quarterRows(d0.getTime(), Date.now() + Q).map(mk);
    const n = range === '30' ? 30 : 7;
    const from = range === 'today' ? d0.getTime() : d0.getTime() - (n - 1) * 86400000;
    const rows = quarterRows(from, Date.now() + Q);
    out.top = rows.filter((r) => r.imp > 0).sort((a, b) => b.imp - a.imp).slice(0, 10).map(mk);
    out.topShort = rows.filter((r) => r.peak > 0).sort((a, b) => b.peak - a.peak).slice(0, 10).map(mk);
    const byDay = {}; const byDayS = {};
    for (const r of rows) {
      const k = dayKey(r.ts);
      if (!byDay[k] || r.imp > byDay[k].imp) byDay[k] = r;
      if (!byDayS[k] || r.peak > byDayS[k].peak) byDayS[k] = r;
    }
    out.days = Object.keys(byDay).sort().map((k) => ({ day: k, ...mk(byDay[k]), peakKw: r2(((byDayS[k] || {}).peak || 0) / 1000), peakTs: (byDayS[k] || {}).pts || byDay[k].ts }));
    const m0 = new Date(); m0.setDate(1); m0.setHours(0, 0, 0, 0);
    const p0 = new Date(m0); p0.setMonth(p0.getMonth() - 1);
    const best = (a, b, f) => { const r = quarterRows(a, b).filter((x) => f(x) > 0).sort((x, y) => f(y) - f(x))[0]; return r ? mk(r) : null; };
    const avg = (r) => r.imp; const sho = (r) => r.peak;
    out.month = best(m0.getTime(), Date.now() + Q, avg); out.prevMonth = best(p0.getTime(), m0.getTime(), avg);
    out.monthShort = best(m0.getTime(), Date.now() + Q, sho); out.prevMonthShort = best(p0.getTime(), m0.getTime(), sho);
    return out;
  }

  const cfg = () => store.cfg.energy;
  const configured = () => { const c = cfg(); return !!(c.pv.length || c.grid.length || c.battery.length || c.house.length || c.soc); };

  // aktuelle Leistung eines Geräts in W (Sensor: Wert, Shelly/Tuya-Schalter: power)
  function watts(id) {
    const dev = devices.byId(id);
    if (!dev) return NaN;
    const s = devices.states.get(id);
    if (!s) return NaN;
    let v = dev.type === 'sensor' ? Number(s.value) : Number(s.power);
    if (!isFinite(v)) return NaN;
    if (/^kw$/i.test(dev.unit || '')) v *= 1000;
    return v;
  }
  function sum(ids) {
    let t = 0;
    let n = 0;
    for (const id of ids) { const v = watts(id); if (isFinite(v)) { t += v; n++; } }
    return n ? t : null;
  }

  function sample() {
    const c = cfg();
    let pv = sum(c.pv);
    if (pv !== null) pv = Math.max(0, pv);
    let grid = sum(c.grid);
    if (grid !== null && c.gridInvert) grid = -grid;
    let bat = sum(c.battery);
    if (bat !== null && c.batteryInvert) bat = -bat;
    let soc = null;
    if (c.soc) { const dev = devices.byId(c.soc); const s = dev && devices.states.get(c.soc); const v = s ? Number(s.value) : NaN; if (isFinite(v)) soc = v; }
    let house = c.house.length ? sum(c.house) : null;
    if (house === null && (pv !== null || grid !== null)) house = (pv || 0) + (grid || 0) - (bat || 0);
    if (house !== null) house = Math.max(0, house);
    now = { pv, grid, bat, soc, house };
    return now;
  }

  // Ansicht für einen Tag (back = 0 heute, 1 gestern …) oder die letzten `span` Tage zusammenhängend
  function peaksView(back, span) {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    let from; let to;
    if (span > 1) { from = d0.getTime() - (span - 1) * 86400000; to = d0.getTime() + 86400000; }
    else { from = d0.getTime() - back * 86400000; to = from + 86400000; }
    const mk = (r) => ({ ts: r.ts, kw: kwOf(r.imp), expKw: kwOf(r.exp), peakKw: r2((r.peak || 0) / 1000), peakTs: r.pts || r.ts });
    const rows = quarterRows(from, to);
    return {
      from, to, back, span, limit: Number(cfg().peakLimit) || 0,
      quarters: rows.map(mk),
      top: rows.filter((r) => r.imp > 0).sort((a, b) => b.imp - a.imp).slice(0, 10).map(mk),
      topShort: rows.filter((r) => r.peak > 0).sort((a, b) => b.peak - a.peak).slice(0, 10).map(mk),
    };
  }

  function day(k) {
    touched.add(k);
    return (db.days[k] = db.days[k] || { pv: 0, imp: 0, exp: 0, chg: 0, dis: 0, house: 0, cons: {} });
  }

  function tick() {
    const t = Date.now();
    const n = sample();
    const dt = last ? Math.min((t - last) / 3600000, 60 / 3600) : 0; // Stunden, Lücken > 60 s werden gekappt
    last = t;
    if (!configured()) return;
    const c = cfg();
    if (dt > 0) {
      const d = day(dayKey(t));
      if (n.pv !== null) d.pv += (n.pv * dt) / 1000;
      if (n.grid !== null) qAdd(t, dt, n.grid);
      if (n.grid !== null) { d.imp += (Math.max(n.grid, 0) * dt) / 1000; d.exp += (Math.max(-n.grid, 0) * dt) / 1000; }
      if (n.bat !== null) { d.chg += (Math.max(n.bat, 0) * dt) / 1000; d.dis += (Math.max(-n.bat, 0) * dt) / 1000; }
      if (n.house !== null) d.house += (n.house * dt) / 1000;
      for (const id of c.consumers) { const w = watts(id); if (isFinite(w) && w > 0) d.cons[id] = (d.cons[id] || 0) + (w * dt) / 1000; }
      dirty = true;
    }
    if (t - lastSeries >= 60000) {
      lastSeries = t;
      const k = dayKey(t);
      const q = (v) => (v === null ? null : Math.round(v));
      const row = [t, q(n.pv), q(n.grid), q(n.bat), q(n.house), n.soc === null ? null : Math.round(n.soc * 10) / 10];
      if (sql) {
        if (!store.frozen) sql.prepare('INSERT OR REPLACE INTO energy_series(ts,pv,grid,bat,house,soc) VALUES(?,?,?,?,?,?)').run(...row);
      } else (db.series[k] = db.series[k] || []).push(row);
      dirty = true;
    }
    if (t - lastKeep > 3600000) {
      lastKeep = t;
      const keys = Object.keys(db.days).sort();
      if (sql && !store.frozen) sql.prepare('DELETE FROM energy_quarter WHERE ts<?').run(t - DAY_KEEP * 86400000);
      for (const k of Object.keys(db.quarters).filter((x) => Number(x) < t - DAY_KEEP * 86400000)) delete db.quarters[k];
      for (const k of keys.slice(0, Math.max(0, keys.length - DAY_KEEP))) { delete db.days[k]; if (sql && !store.frozen) sql.prepare('DELETE FROM energy_day WHERE day=?').run(k); }
      if (sql) { if (!store.frozen) sql.prepare('DELETE FROM energy_series WHERE ts<?').run(t - 45 * 86400000); } else {
        const sk = Object.keys(db.series).sort();
        for (const k of sk.slice(0, Math.max(0, sk.length - 3))) delete db.series[k];
      }
    }
    if (dirty && t - lastSave > 60000) save();
    sse({ t: 'energy', energy: live() });
  }

  function save() {
    if (store.frozen) return;
    lastSave = Date.now();
    dirty = false;
    try {
      qSave(q);
      if (sql) {
        const up = sql.prepare('INSERT INTO energy_day(day,json) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET json=excluded.json');
        touched.add(dayKey());
        for (const k of touched) if (db.days[k]) up.run(k, JSON.stringify(db.days[k]));
        touched.clear();
        return;
      }
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, FILE);
    } catch (e) { log('error', 'Energie speichern: ' + e.message); }
  }

  function totals(d) {
    const x = d || { pv: 0, imp: 0, exp: 0, chg: 0, dis: 0, house: 0, cons: {} };
    const self = Math.max(0, x.pv - x.exp);
    return {
      pv: r2(x.pv), imp: r2(x.imp), exp: r2(x.exp), chg: r2(x.chg), dis: r2(x.dis), house: r2(x.house),
      autarky: x.house > 0.05 ? Math.max(0, Math.min(100, Math.round((1 - x.imp / x.house) * 100))) : null,
      selfUse: x.pv > 0.05 ? Math.max(0, Math.min(100, Math.round((self / x.pv) * 100))) : null,
    };
  }

  function live() {
    const c = cfg();
    return {
      configured: configured(), now,
      today: totals(db.days[dayKey()]),
      consumers: c.consumers.map((id) => {
        const dev = devices.byId(id);
        const w = watts(id);
        return { id, name: dev ? dev.name : id, w: isFinite(w) ? w : null, kwh: r2(((db.days[dayKey()] || {}).cons || {})[id] || 0) };
      }),
    };
  }

  function status(range = 'today') {
    const out = { ...live(), range, peaks: peaks(range) };
    if (range === 'today') {
      if (sql) {
        const d0 = new Date(); d0.setHours(0, 0, 0, 0);
        out.series = sql.prepare('SELECT ts,pv,grid,bat,house,soc FROM energy_series WHERE ts>=? ORDER BY ts').all(d0.getTime()).map((r) => [r.ts, r.pv, r.grid, r.bat, r.house, r.soc]);
      } else out.series = db.series[dayKey()] || [];
    } else {
      const n = range === '30' ? 30 : 7;
      const days = [];
      for (let i = n - 1; i >= 0; i--) {
        const k = dayKey(Date.now() - i * 86400000);
        days.push({ day: k, ...totals(db.days[k]) });
      }
      out.days = days;
    }
    return out;
  }

  return {
    tick() { try { tick(); } catch (e) { log('error', 'Energie: ' + e.message); } },
    status, live, save, configured, noteGrid, peaksView,
    flush() { if (dirty) save(); },
  };
}

module.exports = createEnergy;
