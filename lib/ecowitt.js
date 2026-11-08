'use strict';
/* Ecowitt-Gateway (GW1100/GW1000/GW2000 …): lokale HTTP-API /get_livedata_info, ohne Cloud */

const COMMON = {
  '0x02': ['Außentemperatur', 'temp'], '0x03': ['Taupunkt', 'temp'], '0x04': ['Windchill', 'temp'], '0x05': ['Hitzeindex', 'temp'],
  '3': ['Gefühlte Temperatur', 'temp'], '5': ['Dampfdruckdefizit', 'kPa'], '0x07': ['Außenluftfeuchte', '%'],
  '0x0A': ['Windrichtung', '°'], '0x6D': ['Windrichtung Ø10 min', '°'], '0x0B': ['Windgeschwindigkeit', 'speed'], '0x0C': ['Windböen', 'speed'], '0x19': ['Max. Böe heute', 'speed'],
  '0x15': ['Sonnenstrahlung', 'W/m²'], '0x17': ['UV-Index', ''],
};
const RAIN = {
  '0x0D': ['Regen Ereignis', 'rain'], '0x0E': ['Regenrate', 'rainrate'], '0x7C': ['Regen 24 h', 'rain'], '0x10': ['Regen heute', 'rain'],
  '0x11': ['Regen Woche', 'rain'], '0x12': ['Regen Monat', 'rain'], '0x13': ['Regen Jahr', 'rain'],
};

// "12.3 km/h", "45%", "21.5" + unit → { v: Zahl, u: Einheit }
function parseVal(val, unit) {
  const s = String(val ?? '').trim();
  const m = /^(-?\d+(?:[.,]\d+)?)\s*(.*)$/.exec(s);
  if (!m) return null;
  return { v: Number(m[1].replace(',', '.')), u: (unit || m[2] || '').trim() };
}
const r = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// auf metrische Einheiten umrechnen
function metric(kind, p) {
  if (!p || !isFinite(p.v)) return null;
  const u = p.u.toLowerCase().replace(/\/hr$|\/h$/, '/h');
  switch (kind) {
    case 'temp': return { v: r(/f/.test(u) ? ((p.v - 32) * 5) / 9 : p.v), unit: '°C' };
    case 'speed': {
      let v = p.v;
      if (/mph/.test(u)) v *= 1.609344; else if (/m\/s/.test(u)) v *= 3.6; else if (/knot|kts/.test(u)) v *= 1.852; else if (/ft\/s/.test(u)) v *= 1.09728;
      return { v: r(v), unit: 'km/h' };
    }
    case 'rain': return { v: r(/in/.test(u) ? p.v * 25.4 : p.v), unit: 'mm' };
    case 'rainrate': return { v: r(/in/.test(u) ? p.v * 25.4 : p.v), unit: 'mm/h' };
    case 'pressure': return { v: r(/inhg/.test(u) ? p.v * 33.8639 : /mmhg/.test(u) ? p.v * 1.33322 : /kpa/.test(u) ? p.v * 10 : p.v), unit: 'hPa' };
    default: return { v: r(p.v, 2), unit: kind || p.u };
  }
}

// liefert [{ key, name, value, unit }]
function readings(j) {
  const out = [];
  const add = (key, name, kind, val, unit) => { const m = metric(kind, parseVal(val, unit)); if (m) out.push({ key, name, value: m.v, unit: m.unit }); };
  for (const e of (j && j.common_list) || []) { const d = COMMON[e.id]; if (d) add('common.' + e.id, d[0], d[1], e.val, e.unit); }
  for (const e of (j && j.rain) || []) { const d = RAIN[e.id]; if (d) add('rain.' + e.id, d[0], d[1], e.val, e.unit); }
  for (const e of (j && j.piezoRain) || []) { const d = RAIN[e.id]; if (d) add('piezo.' + e.id, d[0] + ' (Piezo)', d[1], e.val, e.unit); }
  for (const w of (j && j.wh25) || []) {
    add('wh25.temp', 'Innentemperatur', 'temp', w.intemp, w.unit);
    add('wh25.hum', 'Innenluftfeuchte', '%', w.inhumi);
    add('wh25.abs', 'Luftdruck absolut', 'pressure', w.abs);
    add('wh25.rel', 'Luftdruck relativ', 'pressure', w.rel);
  }
  for (const c of (j && j.ch_aisle) || []) {
    const n = c.name || `Kanal ${c.channel}`;
    add(`aisle.${c.channel}.temp`, `${n} Temperatur`, 'temp', c.temp, c.unit);
    add(`aisle.${c.channel}.hum`, `${n} Feuchte`, '%', c.humidity);
  }
  for (const c of (j && j.ch_soil) || []) add(`soil.${c.channel}`, `${c.name || 'Bodenfeuchte ' + c.channel}`, '%', c.humidity);
  for (const c of (j && j.ch_pm25) || []) add(`pm25.${c.channel}`, `PM2.5 Kanal ${c.channel}`, 'µg/m³', c.PM25);
  for (const c of (j && j.ch_leak) || []) { const bad = /leak|alarm|wet/i.test(String(c.status)); out.push({ key: `leak.${c.channel}`, name: `${c.name || 'Leckage ' + c.channel}`, value: bad ? 1 : 0, unit: '' }); }
  for (const l of (j && j.lightning) || []) { add('lightning.distance', 'Blitz Entfernung', 'km', l.distance); add('lightning.count', 'Blitze heute', '', l.count); }
  return out;
}

function createEcowitt({ store, devices, log, onStatus }) {
  let timer = null;
  let key = '';
  let ok = false;
  let error = '';
  let ts = 0;
  let raw = null;
  const conf = () => store.cfg.ecowitt;

  async function fetchRaw(ip) {
    const r0 = await fetch(`http://${ip}/get_livedata_info`, { signal: AbortSignal.timeout(8000) });
    if (!r0.ok) throw new Error('HTTP ' + r0.status);
    return r0.json();
  }

  function apply(j) {
    raw = j;
    const list = readings(j);
    const byKey = new Map(list.map((x) => [x.key, x]));
    for (const dev of devices.list) {
      if (dev.driver !== 'ecowitt') continue;
      const x = byKey.get(dev.ekey);
      if (!x) continue;
      const prev = { ...(devices.states.get(dev.id) || {}) };
      devices.setState(dev, { ...prev, value: x.value, ts: Date.now() }, prev);
    }
    return list;
  }

  async function poll() {
    const c = conf();
    if (!c.ip) return;
    try {
      apply(await fetchRaw(c.ip));
      ts = Date.now();
      if (!ok || error) log('info', 'Ecowitt verbunden');
      ok = true; error = '';
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? 'Gateway antwortet nicht' : (e.cause && e.cause.code) || e.message;
      if (ok || error !== msg) log('warn', 'Ecowitt: ' + msg);
      ok = false; error = msg;
    }
    onStatus();
  }

  function start() {
    const c = conf();
    const k = JSON.stringify([c.ip, c.interval]);
    if (k === key && timer) return;
    key = k;
    clearInterval(timer);
    timer = null;
    ok = false; error = '';
    if (!c.ip) { onStatus(); return; }
    poll();
    timer = setInterval(poll, Math.max(10, Number(c.interval) || 60) * 1000);
  }

  return {
    start, stop() { clearInterval(timer); timer = null; key = ''; ok = false; error = ''; onStatus(); }, poll, fetchRaw, apply, readings,
    raw: () => raw,
    status: () => ({ ok, error, ts, configured: !!conf().ip }),
  };
}

createEcowitt.readings = readings;
module.exports = createEcowitt;
