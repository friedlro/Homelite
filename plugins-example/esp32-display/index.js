'use strict';
// ESP32-Display: HomeLite schickt nur Änderungen an einen ESP32 mit Display (Textprotokoll über MQTT, siehe LIESMICH.md).
const crypto = require('crypto');

const MAXP = 8, MAXT = 12, MAXMSG = 480;
const KINDS = ['value', 'toggle', 'state'];
const clean = (s, n) => String(s == null ? '' : s).replace(/[\r\n|=]/g, ' ').trim().slice(0, n);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);

module.exports = (api) => {
  const cfg = () => api.config() || {};
  const pre = () => (String(cfg().prefix || 'hl').replace(/[^\w/-]/g, '') || 'hl');
  const batchMs = () => Math.min(5000, Math.max(100, Number(cfg().batchMs) || 500));
  const load = () => api.kv.get('displays') || [];
  const save = (l) => api.kv.set('displays', l);
  const rt = new Map();   // id -> { online, seen, msgs, bytes, lastTx, last: Map(tid->string), lastNum: Map, queue: Map, timer, hash, bright }
  const R = (id) => { if (!rt.has(id)) rt.set(id, { online: null, seen: 0, msgs: 0, bytes: 0, saved: 0, last: new Map(), lastNum: new Map(), queue: new Map(), timer: null, bright: null, taps: 0 }); return rt.get(id); };
  const topic = (id, sub) => `${pre()}/${id}/${sub}`;
  let pushT = null; const push = () => { clearTimeout(pushT); pushT = setTimeout(() => { try { api.emit({ model: model() }); } catch { /* egal */ } }, 300); };

  // ---------- Layout / Werte ----------
  function normalize(d) {
    const id = slug(d.id) || 'display1';
    const pages = (Array.isArray(d.pages) ? d.pages : []).slice(0, MAXP).map((p) => ({
      name: clean(p.name, 16) || 'Seite',
      tiles: (Array.isArray(p.tiles) ? p.tiles : []).slice(0, MAXT).map((t) => ({ tid: Number(t.tid) || 0, dev: String(t.dev || ''), label: clean(t.label, 20), unit: clean(t.unit, 6), kind: KINDS.includes(t.kind) ? t.kind : 'value', dec: Math.min(3, Math.max(0, Number(t.dec) || 0)), delta: Math.max(0, Number(t.delta) || 0) })),
    }));
    let next = Math.max(0, ...pages.flatMap((p) => p.tiles.map((t) => t.tid)));
    for (const p of pages) for (const t of p.tiles) if (!t.tid) t.tid = ++next;
    const n = d.night || {};
    return { id, name: clean(d.name, 30) || id, brightness: Math.min(100, Math.max(1, Number(d.brightness) || 80)), pages,
      night: { enabled: !!n.enabled, from: /^\d\d:\d\d$/.test(n.from) ? n.from : '22:00', to: /^\d\d:\d\d$/.test(n.to) ? n.to : '06:00', level: Math.min(100, Math.max(0, Number(n.level) || 10)) } };
  }
  const layoutOf = (d) => d.pages.map((p, i) => ({ i, text: `P|${i}|${p.name}\n` + p.tiles.map((t) => `T|${t.tid}|${t.kind}|${t.label}|${t.unit}`).join('\n') }));
  const hashOf = (d) => crypto.createHash('sha1').update(JSON.stringify(layoutOf(d)) ).digest('hex').slice(0, 8);
  const tilesOf = (d) => d.pages.flatMap((p) => p.tiles);

  function fmt(t, dv) {
    if (!dv) return '-';
    const s = dv.state_raw || {};
    if (dv.pending) return '-';
    if (t.kind === 'toggle' || t.kind === 'state') { if (s.on === undefined) return s.value !== undefined ? clean(s.value, 24) : '-'; return s.on ? '1' : '0'; }
    const v = s.value !== undefined ? s.value : s.temp !== undefined ? s.temp : s.on !== undefined ? (s.on ? 1 : 0) : undefined;
    if (v === undefined || v === null) return '-';
    if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)))) return Number(v).toFixed(t.dec);
    return clean(v, 24);
  }
  const num = (s) => (s !== '-' && s !== '' && !isNaN(Number(s)) ? Number(s) : null);

  // ---------- Senden ----------
  function pub(d, sub, text, opt) {
    const r = R(d.id);
    try { api.mqtt.publish(topic(d.id, sub), text, opt); r.msgs++; r.bytes += Buffer.byteLength(text); r.lastTx = Date.now(); } catch (e) { api.log('warn', `MQTT senden: ${e.message}`); }
  }
  function sendValues(d, entries) {   // entries: [[tid, string]] → in Nachrichten bis MAXMSG Bytes
    let buf = '';
    for (const [tid, v] of entries) {
      const line = `${tid}=${v}\n`;
      if (buf && Buffer.byteLength(buf + line) > MAXMSG) { pub(d, 'v', buf); buf = ''; }
      buf += line;
    }
    if (buf) pub(d, 'v', buf);
  }
  function flush(d) {
    const r = R(d.id); r.timer = null;
    const e = [...r.queue.entries()]; r.queue.clear();
    if (!e.length) return;
    for (const [tid, v] of e) { r.last.set(tid, v); const n = num(v); if (n !== null) r.lastNum.set(tid, n); }
    sendValues(d, e); push();
  }
  function offer(d, t, v) {       // nur bei echter Änderung (und Mindestschwelle) in die Warteschlange
    const r = R(d.id);
    if (r.last.get(t.tid) === v) { r.saved++; return; }
    const n = num(v), ln = r.lastNum.get(t.tid);
    if (t.delta && n !== null && ln !== undefined && Math.abs(n - ln) < t.delta) { r.saved++; return; }
    r.queue.set(t.tid, v);
    if (!r.timer) r.timer = api.after(() => flush(d), batchMs());
  }
  function sendCfg(d, force) {
    const r = R(d.id); const b = brightnessNow(d);
    if (!force && r.bright === b) return;
    r.bright = b; pub(d, 'cfg', `b=${b}`, { retain: true });
  }
  function sendAll(d, withLayout) {
    const r = R(d.id);
    if (withLayout) for (const p of layoutOf(d)) pub(d, 'layout/' + p.i, (p.i === 0 ? `H|${hashOf(d)}|${d.pages.length}\n` : '') + p.text);
    r.last.clear(); r.lastNum.clear(); r.queue.clear();
    const e = tilesOf(d).map((t) => [t.tid, fmt(t, api.devices.get(t.dev))]);
    for (const [tid, v] of e) { r.last.set(tid, v); const n = num(v); if (n !== null) r.lastNum.set(tid, n); }
    sendValues(d, e); sendCfg(d, true); push();
  }
  function brightnessNow(d) {
    const n = d.night; if (!n.enabled) return d.brightness;
    const now = new Date(); const m = now.getHours() * 60 + now.getMinutes(); const f = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    const a = f(n.from), b = f(n.to); const night = a <= b ? m >= a && m < b : m >= a || m < b;
    return night ? n.level : d.brightness;
  }

  // ---------- Empfangen ----------
  function onMsg(t, payload) {
    const m = new RegExp(`^${pre().replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}/([a-z0-9_-]+)/(hello|tap|status)$`).exec(t);
    if (!m) return;
    const d = load().find((x) => x.id === m[1]); if (!d) return;
    const r = R(d.id); const body = String(payload || '').trim(); r.seen = Date.now();
    if (m[2] === 'status') { r.online = /^online/i.test(body); push(); return; }
    r.online = true;
    if (m[2] === 'hello') { sendAll(d, body !== hashOf(d)); return; }   // ESP meldet seinen Layout-Hash; stimmt er, wird nur der Wertestand gesendet
    if (m[2] === 'tap') {
      const tile = tilesOf(d).find((x) => x.tid === Number(body)); if (!tile) return;
      r.taps++;
      if (tile.kind === 'toggle') api.devices.control(tile.dev, 'toggle').catch?.((e) => api.log('warn', `Tippen ${tile.label}: ${e.message}`));
      push();
    }
  }
  try {
    api.mqtt.subscribe(`${pre()}/+/hello`, onMsg); api.mqtt.subscribe(`${pre()}/+/tap`, onMsg); api.mqtt.subscribe(`${pre()}/+/status`, onMsg);
  } catch (e) { api.log('warn', 'MQTT nicht verfügbar: ' + e.message); }

  api.devices.onState((dev) => {
    for (const d of load()) for (const t of tilesOf(d)) if (t.dev === dev.id || (api.devices.get(t.dev) || {}).id === dev.id) { if (R(d.id).online) offer(d, t, fmt(t, api.devices.get(t.dev))); }
  });
  api.timer(() => { for (const d of load()) if (R(d.id).online) sendCfg(d, false); }, 60000);

  // ---------- Oberfläche ----------
  const view = (d) => { const r = R(d.id); return { ...d, hash: hashOf(d), online: r.online, seen: r.seen, msgs: r.msgs, bytes: r.bytes, saved: r.saved, taps: r.taps, bright: brightnessNow(d) }; };
  const devList = () => api.devices.all().filter((x) => x.plugin !== api.id).map((x) => ({ id: x.id, name: x.name, room: x.room, type: x.type, unit: (x.state_raw && x.state_raw.unit) || '' })).sort((a, b) => (a.room || '').localeCompare(b.room || '', 'de') || a.name.localeCompare(b.name, 'de', { numeric: true }));
  const model = () => ({ prefix: pre(), displays: load().map(view), devices: devList() });
  api.route('GET', 'model', () => model());
  api.route('POST', 'display', ({ body }) => {
    const d = normalize(body || {}); const l = load(); const i = l.findIndex((x) => x.id === (body.origId || d.id));
    if (i < 0 && l.some((x) => x.id === d.id)) throw new Error('Display-ID gibt es schon');
    if (i >= 0) l[i] = d; else l.push(d);
    save(l); const r = R(d.id); r.bright = null;
    if (r.online) sendAll(d, true);
    push(); return model();
  });
  api.route('POST', 'display-delete', ({ body }) => { save(load().filter((x) => x.id !== body.id)); rt.delete(body.id); return model(); });
  api.route('POST', 'resend', ({ body }) => { const d = load().find((x) => x.id === body.id); if (!d) throw new Error('Unbekannt'); sendAll(d, true); return { ok: true }; });
  try {
    api.mcp.tool({ name: 'esp32_displays', description: 'ESP32-Displays: Status, Seiten, gesendete/eingesparte Nachrichten', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => load().map((d) => { const v = view(d); return { id: v.id, name: v.name, online: v.online, seiten: v.pages.map((p) => p.name), gesendet: v.msgs, uebersprungen: v.saved }; }) });
  } catch { /* MCP nicht verfügbar */ }
  return { stop() { for (const r of rt.values()) clearTimeout(r.timer); } };
};
