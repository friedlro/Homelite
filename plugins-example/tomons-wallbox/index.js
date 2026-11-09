'use strict';
// Tomons / Inateck Wallbox über die Tomons-Cloud (MQTT). Inoffiziell, nach Reverse-Engineering – siehe LIESMICH.md.
const crypto = require('crypto');
const P = require('./protocol');

const API = 'https://tomons-app.licheng-tech.com/api/';
const BROKER = 'mqtt://tomons-app.licheng-tech.com:1883';
const GEARS = [6, 8, 10, 13, 16, 20, 24, 32];
const ITEMS = [
  ['powerW', 'Leistung', 'sensor', 'W'], ['voltage', 'Spannung', 'sensor', 'V'], ['current', 'Strom', 'sensor', 'A'],
  ['totalKwh', 'Gesamtenergie', 'sensor', 'kWh'], ['sessionKwh', 'Ladeenergie (Vorgang)', 'sensor', 'kWh'], ['tempC', 'Temperatur', 'sensor', '°C'],
  ['limitA', 'Ladestrom-Grenze', 'sensor', 'A'], ['mode', 'Lademodus', 'sensor', ''], ['cable', 'Kabelstatus', 'sensor', ''],
  ['plugged', 'Fahrzeug angesteckt', 'binary', ''], ['charging', 'Lädt', 'binary', ''], ['online', 'Verbindung', 'binary', ''],
];

module.exports = (api) => {
  const cfg = () => api.config() || {};
  const key = (k) => `tomons:${k}`;
  let mq = null, token = '', dev = null, seq = 1, askT = null, watchT = null, stopped = false, retryT = null;
  const S = { status: 'Nicht konfiguriert', err: '', device: null, t: {}, ts: 0, log: [] };
  const lg = (m) => { S.log.unshift(new Date().toLocaleTimeString('de-AT') + ' ' + m); S.log.length = Math.min(S.log.length, 25); };
  const clean = (s) => String(s || '').split(cfg().password || '\u0000').join('***').split(cfg().mqttPassword || '\u0000').join('***');
  let pushT = null; const push = () => { clearTimeout(pushT); pushT = setTimeout(() => { try { api.emit({ model: model() }); } catch { /* egal */ } }, 200); };
  const model = () => ({ status: S.status, err: S.err, device: S.device, t: S.t, ts: S.ts, log: S.log, gears: GEARS.filter((g) => g <= (Number(cfg().maxA) || 16)), startStop: !!cfg().allowStartStop });

  // ---------- Cloud ----------
  async function req(method, path, body) {
    const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'HomeLite', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  }
  async function login() {
    const c = cfg(); if (!c.email || !c.password) throw new Error('E-Mail und Passwort fehlen');
    const md5 = /^[0-9a-f]{32}$/i.test(c.password) ? c.password.toLowerCase() : crypto.createHash('md5').update(c.password).digest('hex');
    const { status, j } = await req('POST', 'auth/login', { account: c.email, password: md5, login_type: 'EMAIL' });
    if (status !== 200 || j.code !== 200) throw new Error('Anmeldung fehlgeschlagen' + (j.message ? ': ' + j.message : ` (HTTP ${status})`));
    token = (j.data && j.data.token) || '';
    const u = (j.data && j.data.user) || {};
    const ui = (j.data && j.data.userInfo) || {};
    const id = String(u.id || '').replace(/-/g, '').slice(0, 25);
    return { user: ui.mqttUsername || (id ? 'user_' + id : ''), pass: ui.mqttPassword || '' };
  }
  async function pickDevice() {
    let { status, j } = await req('GET', 'device/list');
    if (status === 401) throw new Error('Sitzung abgelaufen');
    const list = ((j && j.data) || []).map((x) => (x && typeof x.device === 'object' ? x.device : x)).filter(Boolean);
    if (!list.length) throw new Error('Keine Wallbox im Konto gefunden');
    const want = cfg().deviceId;
    const d = (want && list.find((x) => [x.auth_id, x.device_identifier, x.id].includes(want))) || list[0];
    const id = d.auth_id || d.device_identifier;
    if (!id) throw new Error('Geräte-ID fehlt in der Antwort der Cloud');
    return { id: String(id), name: d.name || d.device_name || 'Wallbox', model: d.product_model_code || '', mac: d.mac_address || '' };
  }

  // ---------- Geräte ----------
  function ensureDevices() {
    for (const [k, label, type, unit] of ITEMS) {
      try { api.devices.ensure({ key: key(k), name: `Wallbox ${label}`, room: cfg().room || '', type, ...(unit ? { unit } : {}) }); } catch (e) { api.log('warn', `Gerät ${k}: ${e.message}`); }
    }
    try { api.devices.ensure({ key: key('switch'), name: 'Wallbox Laden', room: cfg().room || '', type: 'switch' }); } catch { /* egal */ }
  }
  function apply(t) {
    const set = (k, patch) => { try { api.devices.setState(key(k), { online: true, ...patch }); } catch { /* egal */ } };
    for (const k of ['powerW', 'voltage', 'current', 'totalKwh', 'sessionKwh', 'tempC', 'limitA']) if (t[k] != null) set(k, { value: t[k] });
    if (t.mode != null) set('mode', { value: P.MODE[t.mode] });
    if (t.cable != null) { set('cable', { value: P.CABLE[t.cable] }); set('plugged', { on: t.cable !== 0 }); }
    if (t.charging != null || t.cable != null) { const on = t.cable != null ? t.cable === 2 || (t.charging && t.cable !== 0) : !!t.charging; set('charging', { on }); set('switch', { on }); }
  }
  function setOnline(on) {
    try { api.devices.setState(key('online'), { on, online: true }); } catch { /* egal */ }
    if (!on) for (const [k] of ITEMS) if (k !== 'online') { try { api.devices.setState(key(k), { online: false }); } catch { /* egal */ } }
  }

  // ---------- MQTT ----------
  const pub = (buf, qos = 0, twice = false) => {
    if (!mq || !mq.connected || !dev) throw new Error('Nicht mit der Cloud verbunden');
    const topic = `device/${dev.id}/send`;
    mq.publish(topic, buf, { qos });
    if (twice) setTimeout(() => { try { mq.publish(topic, buf, { qos }); } catch { /* egal */ } }, 80);
  };
  const ask = () => { try { seq = (seq + 1) & 0xff; pub(P.statusRequest(seq)); } catch { /* offline */ } };

  async function start() {
    clearTimeout(retryT);
    if (stopped) return;
    const c = cfg();
    if (!c.email || !c.password) { S.status = 'Nicht konfiguriert'; S.err = 'E-Mail und Passwort in den Plugin-Einstellungen eintragen.'; push(); return; }
    let mqtt; try { mqtt = require('mqtt'); } catch { S.status = 'Fehler'; S.err = 'Paket „mqtt“ fehlt'; push(); return; }
    try {
      S.status = 'Melde an …'; S.err = ''; push();
      const m = await login();
      const pass = m.pass || c.mqttPassword;
      if (!pass) throw new Error('MQTT-Passwort fehlt (Plugin-Einstellungen, siehe LIESMICH)');
      dev = await pickDevice(); S.device = dev; ensureDevices();
      if (mq) { try { mq.end(true); } catch { /* egal */ } }
      mq = mqtt.connect(BROKER, { username: m.user, password: pass, clientId: 'homelite_' + crypto.randomBytes(4).toString('hex'), reconnectPeriod: 5000, keepalive: 60, connectTimeout: 15000 });
      mq.on('connect', () => { S.status = 'Verbunden'; S.err = ''; lg('Cloud verbunden'); mq.subscribe(`device/${dev.id}/#`); ask(); clearInterval(askT); askT = setInterval(ask, 30000); push(); });
      mq.on('close', () => { S.status = 'Getrennt'; push(); });
      mq.on('error', (e) => { S.err = clean(e.message); push(); });
      mq.on('message', (topic, buf) => {
        let t; try { t = P.parse(buf); } catch { t = null; }
        if (!t) return;
        Object.assign(S.t, t); S.ts = Date.now();
        if (t.cable != null) S.t.plugged = t.cable !== 0;
        setOnline(true); apply(t); push();
      });
      clearInterval(watchT);
      watchT = setInterval(() => { if (S.ts && Date.now() - S.ts > 150000 && S.t.online !== false) { S.t.online = false; setOnline(false); lg('Keine Daten seit 2,5 min – Wallbox offline/Standby?'); push(); } else if (S.ts && Date.now() - S.ts <= 150000) S.t.online = true; }, 20000);
    } catch (e) {
      S.status = 'Fehler'; S.err = clean(e.message); lg('Fehler: ' + S.err); push();
      retryT = setTimeout(start, 120000);
    }
  }

  // ---------- Befehle ----------
  function setLimit(a) {
    a = Number(a); const max = Number(cfg().maxA) || 16;
    if (!GEARS.includes(a)) throw new Error('Erlaubt: ' + GEARS.join(', ') + ' A');
    if (a > max) throw new Error(`Höchstens ${max} A (Plugin-Einstellung)`);
    seq = (seq + 1) & 0xff; pub(P.setCurrent(a, seq), 1, true); lg(`Ladestrom-Grenze ${a} A gesendet`);
    setTimeout(ask, 1500); return { ok: true, limitA: a };
  }
  function charge(on) {
    if (!cfg().allowStartStop) throw new Error('Start/Stopp ist in den Plugin-Einstellungen nicht freigegeben (experimentell)');
    seq = (seq + 1) & 0xff; pub(P.startStop(on, seq), 1, true); lg(`${on ? 'Start' : 'Stopp'} gesendet (experimentell)`);
    setTimeout(ask, 2000); return { ok: true };
  }
  api.devices.onCommand((d, action, value) => {
    if (d.key !== key('switch')) throw new Error('Nicht steuerbar');
    const on = action === 'toggle' ? !(S.t.charging) : action === 'on' || (action === 'set' && !!value);
    charge(on);
  });

  api.route('GET', 'model', () => model());
  api.route('POST', 'limit', ({ body }) => setLimit(body.amps));
  api.route('POST', 'charge', ({ body }) => charge(!!body.on));
  api.route('POST', 'refresh', () => { ask(); return { ok: true }; });
  api.route('POST', 'reconnect', () => { clearInterval(askT); if (mq) { try { mq.end(true); } catch { /* egal */ } mq = null; } start(); return { ok: true }; });

  try {
    api.mcp.tool({ name: 'wallbox', description: 'Tomons Wallbox: Leistung, Kabelstatus, Energie, Ladestrom-Grenze', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => ({ status: S.status, ...S.t, kabel: P.CABLE[S.t.cable], modus: P.MODE[S.t.mode] }) });
    api.mcp.tool({ name: 'wallbox_ladestrom', description: 'Ladestrom-Grenze der Tomons Wallbox setzen (6, 8, 10, 13, 16, 20, 24, 32 A)', control: true, inputSchema: { type: 'object', properties: { ampere: { type: 'number' } }, required: ['ampere'] }, run: ({ ampere }) => setLimit(ampere) });
  } catch { /* MCP nicht verfügbar */ }

  start();
  return { stop() { stopped = true; clearInterval(askT); clearInterval(watchT); clearTimeout(retryT); if (mq) { try { mq.end(true); } catch { /* egal */ } mq = null; } } };
};
