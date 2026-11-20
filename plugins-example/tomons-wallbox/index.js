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

  // Entschlüsselung von mqtt_credentials (AES-256-CBC): der Schlüssel steckt in der App und ist nicht dokumentiert.
  // Es werden nur naheliegende Ableitungen aus Werten der eigenen Anmeldung probiert; gelingt eine, wird sie gemerkt.
  function tryDecrypt(raw, ctx) {
    const buf = Buffer.from(raw, 'base64');
    const sha = (x) => crypto.createHash('sha256').update(x).digest();
    const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');
    const vals = {}; // Name -> Text
    for (const [n, v] of Object.entries(ctx)) if (v !== undefined && v !== null && String(v) !== '') vals[n] = String(v);
    const keys = [];
    for (const [n, v] of Object.entries(vals)) { keys.push([`sha256(${n})`, sha(v)], [`md5hex(${n})`, Buffer.from(md5(v))], [`utf8(${n}) 32`, Buffer.from(v.padEnd(32, '\0').slice(0, 32))]); }
    const names = Object.keys(vals);
    for (const a of names) for (const b of names) if (a !== b) { keys.push([`sha256(${a}+${b})`, sha(vals[a] + vals[b])], [`sha256(${a}:${b})`, sha(vals[a] + ':' + vals[b])]); }
    const ivs = [['IV=Anfang des Textes', buf.subarray(0, 16), buf.subarray(16)], ['IV=0', Buffer.alloc(16), buf]];
    for (const [kn, k] of keys) for (const [iname, iv, ct] of ivs) {
      if (k.length !== 32 || iv.length !== 16 || ct.length % 16 || !ct.length) continue;
      try {
        const d = crypto.createDecipheriv('aes-256-cbc', k, iv); const o = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
        if (o && typeof o === 'object') return { o, how: `${kn}, ${iname}` };
      } catch { /* falsch */ }
    }
    return null;
  }
  async function login() {
    const c = cfg(); if (!c.email || !c.password) throw new Error('E-Mail und Passwort fehlen');
    const md5 = /^[0-9a-f]{32}$/i.test(c.password) ? c.password.toLowerCase() : crypto.createHash('md5').update(c.password).digest('hex');
    const { status, j } = await req('POST', 'auth/login', { account: c.email, password: md5, login_type: 'EMAIL' });
    if (status !== 200 || j.code !== 200) throw new Error('Anmeldung fehlgeschlagen' + (j.message ? ': ' + j.message : ` (HTTP ${status})`));
    token = (j.data && j.data.token) || '';
    const u = (j.data && j.data.user) || {};
    // Die Cloud liefert die Broker-Zugangsdaten je nach Version unter mqtt_credentials oder userInfo
    const d0 = (j.data && typeof j.data === 'object') ? j.data : {};
    // mqtt_credentials kann ein Text sein (JSON, Base64 oder Hex von JSON); sonst ist er verschlüsselt (siehe _encryption)
    let mc = d0.mqtt_credentials || d0.mqttCredentials || {};
    const enc = d0._encryption && typeof d0._encryption === 'object' ? d0._encryption : null;
    let how = '';
    if (typeof mc === 'string') {
      const raw = mc, tries = [['JSON', () => raw], ['Base64', () => Buffer.from(raw, 'base64').toString('utf8')], ['Hex', () => Buffer.from(raw, 'hex').toString('utf8')]];
      mc = {};
      for (const [n, f] of tries) { try { const o = JSON.parse(f()); if (o && typeof o === 'object') { mc = o; how = n; break; } } catch { /* nächster */ } }
      if (!how && enc && /aes-256-cbc/i.test(String(enc.algorithm))) {
        const r = tryDecrypt(raw, { timestamp: enc.timestamp, token, md5pw: md5, password: c.password, email: c.email, userid: u.id, userid_nodash: String(u.id || '').replace(/-/g, '') });
        if (r) { mc = r.o; how = 'AES (' + r.how + ')'; }
      }
      if (!how) lg(`mqtt_credentials ist verschlüsselt/unbekannt: ${raw.length} Zeichen, ${/^[A-Za-z0-9+/=]+$/.test(raw) ? 'Base64-artig' : /^[0-9a-f]+$/i.test(raw) ? 'Hex' : 'sonstiges Format'} · Verfahren laut Cloud: ${enc ? JSON.stringify({ algorithm: enc.algorithm, fields: enc.fields, timestamp: enc.timestamp }).slice(0, 200) : '–'}`);
      else lg('mqtt_credentials gelesen als ' + how);
    }
    const ui = { ...(d0.userInfo || {}), ...mc };
    const pick = (...ks) => { for (const k of ks) if (ui[k] !== undefined && ui[k] !== null && ui[k] !== '') return ui[k]; return ''; };
    const id = String(u.id || '').replace(/-/g, '').slice(0, 25);
    const mk = (o) => (o && typeof o === 'object' ? Object.keys(o).join(',') : typeof o);
    const mask = (v) => (v ? `${String(v).length} Zeichen` : 'leer');
    const user = pick('mqttUsername', 'mqtt_username', 'username', 'user', 'userName', 'client_id', 'clientId');
    const pass = pick('mqttPassword', 'mqtt_password', 'password', 'pass', 'pwd', 'secret');
    const host = pick('mqttBroker', 'mqtt_broker', 'broker', 'host', 'server', 'url');
    const port = Number(pick('mqttPort', 'mqtt_port', 'port')) || 0;
    lg(`Anmeldung ok · data: ${mk(d0)} · mqtt_credentials: ${mk(d0.mqtt_credentials || d0.mqttCredentials)} · _encryption: ${mk(d0._encryption)} · Benutzer ${mask(user)}${user ? ' (' + String(user).slice(0, 5) + '…)' : ''}, Passwort ${mask(pass)}, Broker ${host || '–'}:${port || '–'}`);
    return { user: user || (id ? 'user_' + id : ''), pass: String(pass || ''), host: String(host || ''), port };
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
      const pass = m.pass || c.mqttPassword; if (!m.pass) lg('Die Cloud hat kein MQTT-Passwort geliefert – benutze das Feld aus den Plugin-Einstellungen');
      if (!pass) throw new Error('MQTT-Passwort fehlt (Plugin-Einstellungen, siehe LIESMICH)');
      dev = await pickDevice(); S.device = dev; ensureDevices();
      if (mq) { try { mq.end(true); } catch { /* egal */ } }
      const url = m.host ? `mqtt://${m.host.replace(/^\w+:\/\//, '')}:${m.port || 1883}` : BROKER;
      if (url !== BROKER) lg('Broker aus der Anmeldung: ' + url.replace(/^mqtt:\/\//, ''));
      mq = mqtt.connect(url, { username: m.user, password: pass, clientId: 'homelite_' + crypto.randomBytes(4).toString('hex'), reconnectPeriod: 5000, keepalive: 60, connectTimeout: 15000 });
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
      // nicht alle 2 min neu anmelden: jede Anmeldung kann die App (gleiches Konto) abmelden
      retryT = setTimeout(start, /Bad username|Anmeldung fehlgeschlagen/i.test(S.err) ? 30 * 60000 : 5 * 60000);
    }
  }


  // ---------- Freigabecode einlösen (zweites Konto für HomeLite) ----------
  // Die Cloud-Schnittstelle zum Einlösen ist nicht öffentlich dokumentiert: es werden mögliche Pfade nacheinander versucht,
  // jede Antwort steht im Protokoll. Alternativ den Code in der Tomons-App mit dem HomeLite-Konto einlösen.
  // Route und Feldname aus der Tomons-App (Version 1.1.5) entnommen: device/add-by-share-code mit share_code.
  async function redeem(code) {
    code = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6,10}$/.test(code)) throw new Error('Freigabecode erwartet (6–10 Zeichen, Buchstaben/Ziffern)');
    await login();
    const paths = cfg().sharePath ? [String(cfg().sharePath).replace(/^\/+/, '')] : ['device/add-by-share-code'];
    for (const p of paths) for (const body of [{ share_code: code }, { shareCode: code }, { code }]) {
      let r; try { r = await req('POST', p, body); } catch (e) { lg(`Freigabe ${p}: ${clean(e.message)}`); continue; }
      const ok = r.status === 200 && r.j && (r.j.code === 200 || r.j.success === true);
      lg(`Freigabe ${p} ${Object.keys(body)[0]} → HTTP ${r.status}${r.j && r.j.message ? ' ' + clean(String(r.j.message).slice(0, 80)) : ''}`);
      if (ok) { lg('Freigabecode eingelöst'); push(); start(); return { ok: true, path: p }; }
    }
    push();
    throw new Error('Die Cloud hat den Code nicht angenommen – Details im Protokoll. Löse den Code stattdessen in der Tomons-App mit dem HomeLite-Konto ein (siehe LIESMICH).');
  }


  // ---------- Freigabe-Verwaltung (Routen aus der Tomons-App 1.1.5 entnommen) ----------
  // Eigene Geräte-Kennung (auth_id) wird als device_id übergeben, wie bei device/nfc-cards?device_id=…
  async function shareInfo() {
    if (!dev) throw new Error('Noch nicht mit der Wallbox verbunden');
    await login();
    const [mine, users] = await Promise.all([
      req('GET', 'device/my-shared-devices').then((r) => (r.status === 200 && r.j && r.j.data) || []).catch((e) => { lg('my-shared-devices: ' + clean(e.message)); return []; }),
      req('GET', `device/share-users/${dev.id}`).then((r) => (r.status === 200 && r.j && r.j.data) || []).catch((e) => { lg('share-users: ' + clean(e.message)); return []; }),
    ]);
    return { mine, users };
  }
  async function shareGenerate() {
    if (!dev) throw new Error('Noch nicht mit der Wallbox verbunden');
    await login();
    const r = await req('POST', 'device/share-code/generate', { device_id: dev.id });
    if (r.status !== 200 || !r.j || (r.j.code !== undefined && r.j.code !== 200)) throw new Error('Freigabecode erzeugen fehlgeschlagen' + (r.j && r.j.message ? ': ' + clean(r.j.message) : ` (HTTP ${r.status})`));
    const code = (r.j.data && (r.j.data.share_code || r.j.data.code || r.j.data)) || '';
    lg('Freigabecode erzeugt' + (code ? ': ' + code : ''));
    return { ok: true, code: String(code) };
  }
  async function shareRevoke(userId) {
    if (!dev) throw new Error('Noch nicht mit der Wallbox verbunden');
    await login();
    const r = await req('POST', 'device/delete-share', { device_id: dev.id, user_id: userId });
    const ok = r.status === 200 && r.j && (r.j.code === 200 || r.j.success === true);
    lg(`Freigabe entfernen (${userId}) → HTTP ${r.status}${r.j && r.j.message ? ' ' + clean(String(r.j.message).slice(0, 80)) : ''}`);
    if (!ok) throw new Error('Entfernen fehlgeschlagen – Details im Protokoll');
    return { ok: true };
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
  api.route('POST', 'redeem', ({ body }) => redeem(body.code));
  api.route('GET', 'shareinfo', () => shareInfo());
  api.route('POST', 'sharegenerate', () => shareGenerate());
  api.route('POST', 'sharerevoke', ({ body }) => shareRevoke(body.userId));
  api.route('POST', 'refresh', () => { ask(); return { ok: true }; });
  api.route('POST', 'reconnect', () => { clearInterval(askT); if (mq) { try { mq.end(true); } catch { /* egal */ } mq = null; } start(); return { ok: true }; });

  try {
    api.mcp.tool({ name: 'wallbox', description: 'Tomons Wallbox: Leistung, Kabelstatus, Energie, Ladestrom-Grenze', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => ({ status: S.status, ...S.t, kabel: P.CABLE[S.t.cable], modus: P.MODE[S.t.mode] }) });
    api.mcp.tool({ name: 'wallbox_ladestrom', description: 'Ladestrom-Grenze der Tomons Wallbox setzen (6, 8, 10, 13, 16, 20, 24, 32 A)', control: true, inputSchema: { type: 'object', properties: { ampere: { type: 'number' } }, required: ['ampere'] }, run: ({ ampere }) => setLimit(ampere) });
  } catch { /* MCP nicht verfügbar */ }

  start();
  return { stop() { stopped = true; clearInterval(askT); clearInterval(watchT); clearTimeout(retryT); if (mq) { try { mq.end(true); } catch { /* egal */ } mq = null; } } };
};
