'use strict';

// Taupunkt als eigene Sensoren: zu jedem Temperatur-/Feuchte-Paar desselben Geräts legt HomeLite
// automatisch einen berechneten Sensor „<Name> Taupunkt“ an (Magnus-Formel, driver 'dew').
const NAME_WORDS = /(luft)?(temperatur|temperature|temp)\b/gi;
const TH_WORDS = /(außen|innen)?\s*(luft)?\s*(temperatur|temperature|temp|feuchtigkeit|feuchte|humidity|hum)\b/gi;

function dewPoint(t, rh) {
  if (!isFinite(t) || !isFinite(rh) || rh <= 0 || rh > 100) return null;
  const a = 17.62; const b = 243.12;
  const g = Math.log(rh / 100) + (a * t) / (b + t);
  return Math.round(((b * g) / (a - g)) * 10) / 10;
}

function group(d) {
  if (d.driver === 'dew' || d.type !== 'sensor') return null;
  const n = String(d.name || '');
  if (d.driver === 'ecowitt' && d.ekey) {
    const m = d.ekey;
    if (m === 'common.0x02') return { kind: 't', keys: ['ew:out'] };
    if (m === 'common.0x07') return { kind: 'h', keys: ['ew:out'] };
    if (m === 'common.0x03') return { kind: 'd', keys: ['ew:out'] };
    const g = /^(wh25|aisle\.\d+)\.(temp|hum)$/.exec(m);
    return g ? { kind: g[2] === 'temp' ? 't' : 'h', keys: ['ew:' + g[1]] } : null;
  }
  if (/taupunkt|dew/i.test(n)) return { kind: 'd', key: 'any:' + (d.ekey || n) };
  if (/boden|soil|windchill|gefühlt|hitzeindex/i.test(n)) return null;
  let kind = null;
  if (/°\s*C|celsius/i.test(d.unit || '') || /temperatur|temperature/i.test(n)) kind = 't';
  if (d.unit === '%' && /feucht|humid/i.test(n)) kind = 'h';
  if (!kind) return null;
  const topic = d.stateTopics && d.stateTopics[0];
  const keys = [];
  if (d.matter && d.matter.peer) keys.push('mt:' + d.matter.peer);
  else if (d.driver === 'shelly' && d.ip) keys.push('sh:' + d.ip);
  else if (d.driver === 'mqtt' && topic && !/\/(set|get)$/.test(topic)) keys.push('tp:' + topic);
  keys.push('nm:' + d.driver + ':' + n.toLowerCase().replace(TH_WORDS, '').replace(/[^a-z0-9äöüß]/g, ''));
  return { kind, keys };
}

function createDew({ store, devices, log, enabled }) {
  let byT = new Map(); // Temperatur-Geräte-ID -> [dew-Geräte]
  let byH = new Map();

  function pairs() {
    const groups = new Map();
    for (const d of devices.list) {
      if (devices.isPending(d)) continue;
      const g = group(d);
      if (!g) continue;
      for (const k of g.keys || [g.key]) { const e = groups.get(k) || {}; if (!e[g.kind]) e[g.kind] = d; groups.set(k, e); }
    }
    const out = new Map();
    for (const e of groups.values()) if (e.t && e.h && !e.d) out.set(e.t.id + '|' + e.h.id, [e.t, e.h]);
    return [...out.values()];
  }

  function nameFor(t) {
    const base = String(t.name).replace(NAME_WORDS, '').replace(/\s+/g, ' ').trim();
    return base ? `${base} Taupunkt` : 'Taupunkt';
  }

  function index() {
    byT = new Map(); byH = new Map();
    for (const d of devices.list) {
      if (d.driver !== 'dew') continue;
      (byT.get(d.dewT) || byT.set(d.dewT, []).get(d.dewT)).push(d);
      (byH.get(d.dewH) || byH.set(d.dewH, []).get(d.dewH)).push(d);
    }
  }

  function compute(dev) {
    const t = devices.states.get(dev.dewT);
    const h = devices.states.get(dev.dewH);
    const prev = { ...(devices.states.get(dev.id) || {}) };
    const v = dewPoint(Number(t && t.value), Number(h && h.value));
    if (v === null) return;
    devices.setState(dev, { ...prev, value: v, ts: Date.now(), online: !(t && t.online === false) && !(h && h.online === false) }, prev);
  }

  // legt fehlende Taupunkt-Sensoren an, entfernt verwaiste; Rückgabe: Anzahl Änderungen
  function sync() {
    const c = store.cfg;
    let changed = 0;
    if (!enabled()) {
      const keep = c.devices.filter((d) => d.driver !== 'dew');
      if (keep.length !== c.devices.length) { for (const d of c.devices) if (d.driver === 'dew') devices.states.delete(d.id); c.devices = keep; changed++; }
    } else {
      const want = pairs();
      const ign = new Set(c.dewIgnore || []);
      const have = new Map(c.devices.filter((d) => d.driver === 'dew').map((d) => [d.dewT + '|' + d.dewH, d]));
      for (const [t, h] of want) {
        const k = t.id + '|' + h.id;
        if (have.has(k) || ign.has(k)) continue;
        c.devices.push({
          id: store.id(), name: nameFor(t), room: t.room || '', fav: false, type: 'sensor', driver: 'dew', src: 'dew:' + k, unit: '°C',
          dewT: t.id, dewH: h.id, ...(t.hide && h.hide ? { hide: false } : {}),
        });
        changed++;
      }
      const alive = new Set(want.map(([t, h]) => t.id + '|' + h.id));
      const gone = c.devices.filter((d) => d.driver === 'dew' && !alive.has(d.dewT + '|' + d.dewH));
      if (gone.length) { const ids = new Set(gone.map((d) => d.id)); c.devices = c.devices.filter((d) => !ids.has(d.id)); for (const id of ids) devices.states.delete(id); changed += gone.length; }
    }
    if (changed) { store.save(); log('info', `Taupunkt-Sensoren aktualisiert (${changed} Änderung${changed === 1 ? '' : 'en'})`); }
    index();
    for (const d of devices.list) if (d.driver === 'dew') compute(d);
    return changed;
  }

  function onState(dev) {
    for (const d of byT.get(dev.id) || []) compute(d);
    for (const d of byH.get(dev.id) || []) compute(d);
  }

  return { sync, onState, dewPoint };
}

createDew.dewPoint = dewPoint;
module.exports = createDew;
