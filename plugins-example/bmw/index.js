// BMW CarData: Anmeldung (OAuth2 Gerätecode + PKCE), Live-Datenstrom per MQTT, tägliche REST-Stammdaten.
// Nur lesend. Zugangsdaten (Tokens) bleiben im Plugin-Speicher und werden nie ausgegeben oder protokolliert.
'use strict';
const crypto = require('crypto');

const AUTH = process.env.BMW_AUTH_BASE || 'https://customer.bmwgroup.com';
const REST = process.env.BMW_API_BASE || 'https://api-cardata.bmwgroup.com';
const STREAM = process.env.BMW_MQTT_URL || 'mqtts://customer.streaming-cardata.bmwgroup.com:9000';
const SCOPE = 'authenticate_user openid cardata:api:read cardata:streaming:read';
const MAX_KEYS = 1500;

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const form = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

// Werte aus den vielen Deskriptoren herausziehen (erste passende Regel, die einen Wert hat, gewinnt)
const PICK = {
  soc: [/batterymanagement\.header$/i, /stateofcharge|\.soc$/i, /electricengine\.charging\.level$/i],
  socTarget: [/charging.*target|target.*(soc|charge)/i],
  range: [/remainingelectricrange$/i, /electricrange/i, /lastremainingrange$/i, /remainingrange/i],
  mileage: [/travelleddistance$/i, /mileage|odometer/i],
  chargeStatus: [/charging\.status$/i, /chargingstatus/i, /charging\.method$/i],
  plug: [/chargingport\.status$/i, /plugstatus|connectorstatus|chargingconnection/i],
  power: [/charging\.power$/i, /chargingpower/i],
  timeToFull: [/timetofullycharged|chargingtimeremaining|timeremaining/i],
  energy: [/maxenergy$/i, /energycontent/i],
  fuel: [/remainingfuel$/i, /fuellevel/i],
  lat: [/currentlocation\.latitude$/i, /location.*latitude/i],
  lon: [/currentlocation\.longitude$/i, /location.*longitude/i],
  heading: [/currentlocation\.heading$/i],
  locked: [/doors?\.(lock|state|status)|centrallock|cabin\.door\.status/i],
  speed: [/vehicle\.speed$|currentspeed/i],
  moving: [/ismoving$/i],
};
const OPEN_RE = /(door|window|trunk|tailgate|hood|bonnet|sunroof|roof|flap)/i;

module.exports = (api) => {
  const cfg = () => api.config() || {};
  const lg = (m) => { try { api.log(m); } catch { /* egal */ } };
  const clean = (s) => String(s || '').replace(/[A-Za-z0-9_\-.]{40,}/g, '…');

  const S = { status: 'Nicht angemeldet', err: '', login: null, quota: { day: '', n: 0 }, stream: false, lastMsg: 0 };
  let tok = api.kv.get('tok') || null;          // { access, refresh, id, gcid, exp }
  let vals = api.kv.get('vals') || {};          // { vin: { descriptor: { v, t, u } } }
  let basic = api.kv.get('basic') || {};        // { vin: {…Stammdaten…} }
  let mq = null, stopped = false, pollT = null, saveT = null, pushT = null, loginT = null, restT = null, tickT = null;
  const known = new Set();

  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { api.kv.set('vals', vals); api.kv.set('basic', basic); } catch { /* egal */ } }, 4000); };
  const saveTok = () => { try { api.kv.set('tok', tok); } catch { /* egal */ } };

  // ---------- Auswertung ----------
  const pick = (m, rules) => { for (const re of rules) for (const k of Object.keys(m)) if (re.test(k) && m[k] && m[k].v != null && m[k].v !== '') return { k, ...m[k] }; return null; };
  const num = (x) => { if (!x) return null; const n = Number(x.v); return Number.isFinite(n) ? n : null; };
  const up = (x) => String(x && x.v != null ? x.v : '').toUpperCase();
  function summarize(vin) {
    const m = vals[vin] || {}; const o = {};
    for (const [name, rules] of Object.entries(PICK)) o[name] = pick(m, rules);
    const s = {
      soc: num(o.soc), socTarget: num(o.socTarget), range: num(o.range), rangeUnit: (o.range && o.range.u) || 'km', mileage: num(o.mileage),
      fuel: num(o.fuel), power: num(o.power), energy: num(o.energy), timeToFull: num(o.timeToFull),
      lat: num(o.lat), lon: num(o.lon), heading: num(o.heading), speed: num(o.speed),
      chargeStatus: o.chargeStatus ? up(o.chargeStatus) : null, plug: o.plug ? up(o.plug) : null,
    };
    s.charging = s.chargeStatus ? /ACTIVE|CHARGING$/.test(s.chargeStatus) && !/NO|END|PAUS|ERR|INACTIVE/.test(s.chargeStatus) : null;
    s.plugged = s.plug ? /CONNECTED|PLUGGED|LOCKED|ON/.test(s.plug) && !/DISCONN|NOT|UNPLUG|NO/.test(s.plug) : (s.charging ? true : null);
    if (o.locked) { const v = up(o.locked); s.locked = /SECURED|LOCKED/.test(v) && !/UNLOCK/.test(v); }
    const opens = []; let anyKnown = false;
    for (const [k, x] of Object.entries(m)) {
      if (!OPEN_RE.test(k) || x.v == null) continue;
      const v = String(x.v).toUpperCase();
      if (/^(OPEN|OPENED|TRUE|AJAR|INTERMEDIATE|TILT|TILTED)$/.test(v) && /(status|isopen|open)/i.test(k)) { anyKnown = true; opens.push(k); }
      else if (/^(CLOSED|FALSE|SECURED|LOCKED)$/.test(v)) anyKnown = true;
    }
    s.openParts = opens; s.anyOpen = anyKnown ? opens.length > 0 : null;
    s.moving = o.moving ? /TRUE|1|MOVING/.test(up(o.moving)) : (s.speed != null ? s.speed > 3 : null);
    return s;
  }

  function vinList() {
    const want = String(cfg().vin || '').trim().toUpperCase();
    const all = [...new Set([...Object.keys(vals), ...Object.keys(basic)])];
    return want ? all.filter((v) => v === want) : all;
  }
  function model() {
    const cars = vinList().map((vin) => {
      const m = vals[vin] || {};
      const keys = Object.keys(m).sort();
      const last = keys.reduce((a, k) => Math.max(a, m[k].t || 0), 0);
      return { vin, basic: basic[vin] || {}, summary: summarize(vin), values: keys.map((k) => ({ k, v: m[k].v, t: m[k].t, u: m[k].u })), updated: last };
    });
    return { status: S.status, err: S.err, login: S.login ? { user_code: S.login.user_code, url: S.login.url, expires: S.login.expires } : null,
      loggedIn: !!(tok && tok.refresh), stream: S.stream, lastMsg: S.lastMsg, quota: S.quota, configured: !!String(cfg().clientId || '').trim(),
      zoom: Math.max(10, Math.min(18, Number(cfg().mapZoom) || 15)), cars, ts: Date.now() };
  }
  const push = () => { clearTimeout(pushT); pushT = setTimeout(() => { try { api.emit({ model: model() }); } catch { /* egal */ } }, 400); };

  // ---------- Geräte (Sensoren für Automationen) ----------
  function label(vin) { const b = basic[vin] || {}; return String(b.modelName || b.series || b.brand || 'BMW') + (vinList().length > 1 ? ' …' + vin.slice(-4) : ''); }
  function sync(vin) {
    const s = summarize(vin); const L = label(vin);
    const set = (key, name, type, patch, unit) => {
      if (patch.value == null && patch.on == null) return;
      const k = vin + ':' + key;
      if (!known.has(k)) { api.devices.ensure({ key: k, name: `${L} ${name}`, type, unit }); known.add(k); }
      api.devices.setState(k, { ...patch, online: true });
    };
    set('soc', 'Ladestand', 'sensor', { value: s.soc }, '%');
    set('range', 'Reichweite', 'sensor', { value: s.range }, s.rangeUnit);
    set('mileage', 'Kilometerstand', 'sensor', { value: s.mileage }, 'km');
    set('fuel', 'Tank', 'sensor', { value: s.fuel }, 'l');
    set('power', 'Ladeleistung', 'sensor', { value: s.power }, 'kW');
    set('charging', 'lädt', 'binary', { on: s.charging });
    set('plugged', 'Stecker', 'binary', { on: s.plugged });
    set('locked', 'verriegelt', 'binary', { on: s.locked });
    set('open', 'Tür/Klappe offen', 'binary', { on: s.anyOpen });
    set('moving', 'fährt', 'binary', { on: s.moving });
  }

  // ---------- Daten übernehmen ----------
  function flatten(data, out, prefix) {
    if (!data || typeof data !== 'object') return;
    for (const [k, x] of Object.entries(data)) {
      if (x && typeof x === 'object' && !Array.isArray(x) && 'value' in x) out.push([k, x]);
      else if (x && typeof x === 'object' && x.children) flatten(x.children, out, k);
    }
  }
  function ingest(msg) {
    if (!msg || typeof msg !== 'object') return;
    const vin = String(msg.vin || '').toUpperCase(); if (!vin) return;
    const items = []; flatten(msg.data, items);
    if (!items.length) return;
    const m = vals[vin] = vals[vin] || {};
    const now = Date.now();
    for (const [k, x] of items) {
      const t = x.timestamp ? Date.parse(x.timestamp) || now : now;
      const old = m[k];
      if (old && old.t > t) continue;
      m[k] = { v: x.value, t, u: x.unit || (old && old.u) || undefined };
    }
    const ks = Object.keys(m);
    if (ks.length > MAX_KEYS) for (const k of ks.sort((a, b) => (m[a].t || 0) - (m[b].t || 0)).slice(0, ks.length - MAX_KEYS)) delete m[k];
    S.lastMsg = now; save(); try { sync(vin); } catch (e) { lg('Geräte: ' + clean(e.message)); } push();
  }

  // ---------- Anmeldung ----------
  async function post(path, body) {
    const r = await fetch(AUTH + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form(body), signal: AbortSignal.timeout(20000) });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch { /* kein JSON */ }
    return { status: r.status, j, t };
  }
  function takeTokens(j) {
    tok = { access: j.access_token, refresh: j.refresh_token || (tok && tok.refresh), id: j.id_token || (tok && tok.id), gcid: j.gcid || (tok && tok.gcid) || idClaim(j.id_token, 'gcid'), exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    saveTok();
  }
  function idClaim(idt, name) { try { return JSON.parse(Buffer.from(String(idt).split('.')[1], 'base64').toString())[name]; } catch { return undefined; } }

  async function startLogin() {
    const clientId = String(cfg().clientId || '').trim();
    if (!clientId) throw new Error('Erst die Client-ID in den Plugin-Einstellungen eintragen');
    clearTimeout(loginT);
    const verifier = b64u(crypto.randomBytes(48));
    const r = await post('/gcdm/oauth/device/code', { client_id: clientId, response_type: 'device_code', scope: SCOPE, code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
    if (r.status >= 400 || !r.j.device_code) throw new Error(`BMW lehnt die Anmeldung ab (${r.status}): ${clean(r.j.error_description || r.j.error || r.t).slice(0, 200)}`);
    const exp = Date.now() + (Number(r.j.expires_in) || 300) * 1000;
    S.login = { user_code: r.j.user_code, url: r.j.verification_uri_complete || r.j.verification_uri, expires: exp };
    S.status = 'Warte auf Bestätigung bei BMW'; S.err = ''; push();
    let every = Math.max(3, Number(r.j.interval) || 5) * 1000;
    const poll = async () => {
      if (stopped) return;
      if (Date.now() > exp) { S.login = null; S.status = 'Anmeldung abgelaufen'; S.err = 'Der Code ist abgelaufen – bitte neu anmelden.'; push(); return; }
      try {
        const t = await post('/gcdm/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: r.j.device_code, client_id: clientId, code_verifier: verifier });
        if (t.status === 200 && t.j.access_token) { takeTokens(t.j); S.login = null; S.err = ''; S.status = 'Angemeldet'; lg('Bei BMW angemeldet'); push(); connect(); restOnce(true); return; }
        const e = t.j.error;
        if (e === 'slow_down') every += 5000;
        else if (e && e !== 'authorization_pending') { S.login = null; S.status = 'Anmeldung fehlgeschlagen'; S.err = clean(t.j.error_description || e); push(); return; }
      } catch (e) { lg('Anmeldung: ' + clean(e.message)); }
      loginT = setTimeout(poll, every);
    };
    loginT = setTimeout(poll, every);
    return S.login;
  }

  let refreshing = null;
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const clientId = String(cfg().clientId || '').trim();
      if (!tok || !tok.refresh || !clientId) throw new Error('nicht angemeldet');
      const t = await post('/gcdm/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.refresh, client_id: clientId });
      if (t.status !== 200 || !t.j.access_token) {
        if (t.status === 400 || t.status === 401) { tok = null; saveTok(); S.status = 'Abgemeldet'; S.err = 'BMW hat die Anmeldung beendet (Token abgelaufen) – bitte neu anmelden.'; push(); }
        throw new Error(`Token-Erneuerung ${t.status}: ${clean(t.j.error_description || t.j.error || '')}`);
      }
      takeTokens(t.j);
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  // ---------- Datenstrom ----------
  function disconnect() { S.stream = false; if (mq) { try { mq.removeAllListeners(); mq.on('error', () => {}); mq.end(true); } catch { /* egal */ } mq = null; } }
  let retryT = null, backoff = 5000;
  async function connect() {
    clearTimeout(retryT);
    if (stopped || !tok || !tok.refresh) return;
    let mqtt; try { mqtt = require('mqtt'); } catch { S.err = 'Paket „mqtt“ fehlt'; push(); return; }
    try {
      if (!tok.id || !tok.gcid || tok.exp - Date.now() < 120000) await refresh();
      disconnect();
      const gcid = tok.gcid;
      mq = mqtt.connect(STREAM, { username: gcid, password: tok.id, clientId: gcid + '-' + crypto.randomBytes(3).toString('hex'), keepalive: 30, reconnectPeriod: 0, connectTimeout: 20000, clean: true, rejectUnauthorized: true });
      mq.on('connect', () => { S.stream = true; S.status = 'Verbunden'; S.err = ''; backoff = 5000; lg('Datenstrom verbunden'); mq.subscribe(gcid + '/+', { qos: 1 }, (e) => { if (e) { S.err = 'Abo: ' + clean(e.message); push(); } }); push(); });
      mq.on('message', (_t, buf) => { try { ingest(JSON.parse(buf.toString())); } catch { /* kein JSON */ } });
      mq.on('error', (e) => { S.err = clean(e.message); push(); });
      mq.on('close', () => { S.stream = false; if (!stopped && tok) { S.status = 'Getrennt'; retryT = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 300000); } push(); });
    } catch (e) {
      S.err = clean(e.message); S.status = 'Fehler'; push();
      if (tok) { retryT = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 300000); }
    }
  }

  // ---------- REST (höchstens 2 Abfragen pro Tag, Kontingent 50/24 h) ----------
  function quota() { const d = new Date().toISOString().slice(0, 10); if (S.quota.day !== d) S.quota = { day: d, n: 0 }; return S.quota; }
  async function rest(path) {
    const q = quota(); if (q.n >= 40) throw new Error('REST-Kontingent fast aufgebraucht (50 pro Tag)');
    if (!tok || tok.exp - Date.now() < 60000) await refresh();
    q.n++; api.kv.set('quota', q);
    const r = await fetch(REST + path, { headers: { authorization: 'Bearer ' + tok.access, 'x-version': 'v1', accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (r.status === 429) throw new Error('BMW: zu viele Abfragen (429)');
    if (!r.ok) throw new Error(`BMW REST ${r.status}`);
    return r.json();
  }
  async function restOnce(force) {
    try {
      if (!tok || !tok.refresh || (!force && cfg().restDaily === false)) return;
      const last = api.kv.get('restAt') || 0;
      if (!force && Date.now() - last < 20 * 3600 * 1000) return;
      const map = await rest('/customers/vehicles/mappings');
      const list = Array.isArray(map) ? map : (map.vehicles || map.mappings || []);
      for (const x of list) {
        const vin = String(x.vin || x.VIN || '').toUpperCase(); if (!vin) continue;
        basic[vin] = { ...(basic[vin] || {}), mappingType: x.mappingType };
        try { const b = await rest(`/customers/vehicles/${vin}/basicData`); basic[vin] = { ...basic[vin], ...pickBasic(b) }; } catch (e) { lg('basicData: ' + clean(e.message)); }
      }
      api.kv.set('restAt', Date.now()); save(); push();
    } catch (e) { lg('REST: ' + clean(e.message)); S.err = clean(e.message); push(); }
  }
  function pickBasic(b) {
    const o = {}; const keep = ['brand', 'modelName', 'modelRange', 'series', 'seriesDevt', 'bodyType', 'driveTrain', 'fuelType', 'colourCodeRaw', 'colourName', 'constructionYear', 'countryCodeISO', 'steering', 'puStep', 'hasNavi'];
    for (const k of keep) if (b && b[k] != null) o[k] = b[k];
    return o;
  }

  // ---------- Start / Stopp ----------
  function start() {
    if (stopped) return;
    const c = cfg();
    if (!String(c.clientId || '').trim()) { S.status = 'Nicht konfiguriert'; S.err = 'CarData-Client-ID in den Plugin-Einstellungen eintragen (siehe LIESMICH).'; push(); return; }
    if (!tok || !tok.refresh) { S.status = 'Nicht angemeldet'; S.err = ''; push(); return; }
    S.status = 'Verbinde …'; push(); connect();
  }
  S.quota = api.kv.get('quota') || S.quota;
  for (const vin of vinList()) { try { sync(vin); } catch { /* egal */ } }
  tickT = api.timer(async () => {
    try { if (tok && tok.refresh && tok.exp - Date.now() < 300000) { await refresh(); if (mq) connect(); } } catch (e) { lg('Erneuerung: ' + clean(e.message)); }
  }, 60000);
  restT = api.timer(() => restOnce(false), 6 * 3600 * 1000);
  api.after(start, 1500); api.after(() => restOnce(false), 20000);

  api.route('GET', 'model', () => model());
  api.route('POST', 'login', async () => { await startLogin(); return model(); });
  api.route('POST', 'logout', () => { clearTimeout(loginT); disconnect(); tok = null; saveTok(); S.login = null; S.status = 'Abgemeldet'; S.err = ''; push(); return model(); });
  api.route('POST', 'reconnect', async () => { await connect(); return model(); });
  api.route('POST', 'rest', async () => { await restOnce(true); return model(); });
  api.route('POST', 'forget', () => { vals = {}; basic = {}; api.kv.set('vals', vals); api.kv.set('basic', basic); push(); return model(); });
  api.onConfig(() => { disconnect(); start(); push(); });
  api.mcp.tool({
    name: 'bmw_status', readOnly: true,
    description: 'BMW-Fahrzeug(e): Ladestand, Reichweite, Kilometerstand, Laden/Stecker, Verriegelung, offene Türen/Klappen, Standort, Tank und alle zuletzt empfangenen Rohwerte (nur lesend, über BMW CarData).',
    inputSchema: { type: 'object', properties: { raw: { type: 'boolean', description: 'auch alle Rohwerte ausgeben' } } },
    run: (a) => { const m = model(); return { status: m.status, stream: m.stream, cars: m.cars.map((c) => ({ vin: c.vin, model: c.basic.modelName, updated: c.updated ? new Date(c.updated).toISOString() : null, ...c.summary, values: a && a.raw ? c.values : undefined })) }; },
  });
  return { stop() { stopped = true; clearTimeout(loginT); clearTimeout(retryT); clearTimeout(saveT); clearTimeout(pushT); disconnect(); try { api.kv.set('vals', vals); api.kv.set('basic', basic); } catch { /* egal */ } } };
};
