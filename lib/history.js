'use strict';
// Verlauf: wann und wie wurden Schalter, Lichter, Rollos, Schlösser und Taster betätigt.
// Quelle (k): ui (HomeLite-Oberfläche), auto (Automation/Szene), mcp (KI), heat (Heizung),
//             sys (System/Sonstiges), ext (am Gerät / Wandschalter / Hersteller-App – nicht von HomeLite ausgelöst)
const MAX = 5000;
const MAX_AGE = 120 * 86400e3;
const TYPES = new Set(['switch', 'light', 'cover', 'lock', 'event']);

module.exports = function createHistory({ store, devices, sse }) {
  let list = [];
  try { const v = store.kvGet('history'); if (Array.isArray(v)) list = v; } catch { /* leer */ }
  const marks = new Map(); // Geräte-ID -> { by, until }
  let timer = null;

  function trim() {
    const min = Date.now() - MAX_AGE;
    while (list.length && (list.length > MAX || list[0].ts < min)) list.shift();
  }
  trim();

  function flush() {
    clearTimeout(timer);
    timer = null;
    try { trim(); store.kvSet('history', list); } catch { /* Verlauf ist nicht kritisch */ }
  }
  function saveSoon() { if (!timer) timer = setTimeout(flush, 3000); }

  // Vor einer Steuerung aufrufen: der nächste Zustandswechsel des Geräts gehört dann zu dieser Quelle.
  function mark(dev, by) {
    if (!dev || !TYPES.has(dev.type)) return;
    marks.set(dev.id, { by: by || { k: 'sys' }, until: Date.now() + (dev.type === 'cover' ? 180e3 : 20e3) });
  }

  function take(dev) {
    const m = marks.get(dev.id);
    if (!m) return null;
    if (m.until < Date.now()) { marks.delete(dev.id); return null; }
    m.until = Math.min(m.until, Date.now() + 4000); // Echos desselben Befehls noch zuordnen, dann freigeben
    return m.by;
  }

  function push(dev, a, v, by, st) {
    const e = { ts: Date.now(), id: dev.id, n: dev.name, r: dev.room || '', ty: dev.type, a };
    if (v !== undefined && v !== null && v !== '') e.v = v;
    e.k = (by && by.k) || 'ext';
    if (by && by.w) e.w = String(by.w).slice(0, 120);
    if (by && by.x) e.x = String(by.x).slice(0, 120);
    // Dimm-Verläufe zusammenfassen: gleiche Quelle, gleiches Gerät, wenige Sekunden
    const last = list[list.length - 1];
    if (a === 'brightness' && last && last.id === e.id && last.a === 'brightness' && last.k === e.k && last.w === e.w && e.ts - last.ts < 5000) {
      Object.assign(last, e);
      sse({ t: 'history', e, replace: true });
    } else {
      list.push(e);
      sse({ t: 'history', e });
    }
    saveSoon();
  }

  function onState(dev, st, prev, force) {
    if (!dev || !TYPES.has(dev.type) || dev.driver === 'dew' || dev.driver === 'appletv') return;
    prev = prev || {};
    if (dev.type === 'event') {
      if (st.value !== undefined && st.value !== '') push(dev, 'press', String(st.value), { k: 'ext' }, st);
      return;
    }
    if (dev.type === 'switch' || dev.type === 'light') {
      if (st.on === undefined || prev.on === undefined) return; // erste Meldung nach dem Start ist keine Betätigung
      if (st.on !== prev.on) { push(dev, st.on ? 'on' : 'off', undefined, take(dev), st); return; }
      if (dev.type === 'light' && st.on && st.brightness !== undefined && prev.brightness !== undefined && Math.round(st.brightness) !== Math.round(prev.brightness)) {
        push(dev, 'brightness', Math.round(st.brightness), take(dev), st);
      }
      return;
    }
    // cover / lock
    if (st.state === undefined || prev.state === undefined || st.state === prev.state) return;
    push(dev, st.state, undefined, take(dev), st);
  }

  function query({ dev, k, before, limit, q } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 300, 1), 2000);
    const needle = String(q || '').toLowerCase();
    const out = [];
    for (let i = list.length - 1; i >= 0 && out.length < lim; i--) {
      const e = list[i];
      if (before && e.ts >= before) continue;
      if (dev && e.id !== dev) continue;
      if (k && e.k !== k) continue;
      if (needle && !`${e.n} ${e.r} ${e.w || ''} ${e.x || ''}`.toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    return out;
  }

  function clear() { list = []; flush(); }

  return { mark, onState, query, clear, flush, count: () => list.length };
};

// „Quelle“ aus der Browser-Kennung ableiten (nur grob, für die Anzeige)
module.exports.clientName = (ua) => {
  const s = String(ua || '');
  if (/iPhone/.test(s)) return 'iPhone';
  if (/iPad/.test(s)) return 'iPad';
  if (/Android/.test(s)) return 'Android';
  if (/Macintosh|Mac OS/.test(s)) return 'Mac';
  if (/Windows/.test(s)) return 'Windows';
  if (/Linux/.test(s)) return 'Linux';
  return '';
};
