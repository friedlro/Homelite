'use strict';
// TP-Link Tapo (und andere ONVIF-Kameras) lokal: ONVIF für Ereignisse und Schwenken, RTSP + ffmpeg für Bilder.
// Kamerakonto: in der Tapo-App → Kamera → Einstellungen → Erweitert → Kamerakonto (nicht das TP-Link-Konto).
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const NS = 'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"';
const KINDS = { IsMotion: ['motion', 'Bewegung'], IsPeople: ['person', 'Person'], IsPerson: ['person', 'Person'], IsVehicle: ['vehicle', 'Fahrzeug'], IsPet: ['pet', 'Tier'], IsDogCat: ['pet', 'Tier'], IsTamper: ['tamper', 'Sabotage'], IsLineCross: ['line', 'Linie überschritten'], IsBabyCry: ['cry', 'Schreien'], IsCry: ['cry', 'Schreien'] };
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const tag = (x, n) => { const m = new RegExp(`<(?:\\w+:)?${n}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${n}>`).exec(x || ''); return m ? m[1].trim() : ''; };
const attr = (x, a) => { const m = new RegExp(`\\b${a}="([^"]*)"`).exec(x || ''); return m ? m[1] : ''; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = (api) => {
  const rt = new Map();                 // id -> Laufzeitdaten
  const cams = () => api.kv.get('cams') || [];
  const saveCams = (l) => api.kv.set('cams', l);
  const cfg = () => api.config() || {};
  const camOf = (id) => cams().find((c) => c.id === id);
  const R = (id) => { if (!rt.has(id)) rt.set(id, { online: false, err: '', info: null, urls: {}, profile: '', ptz: false, skew: 0, stop: false, events: {}, snap: null, snapT: 0, ff: null, liveUntil: 0, frame: null, frameT: 0, lastEvent: null }); return rt.get(id); };
  const clean = (c, s) => String(s || '').split(c.pass || '\u0000').join('***');

  // ---------- SOAP ----------
  function post(url, xml, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST', timeout, headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml) } }, (res) => {
        const ch = []; res.on('data', (d) => ch.push(d));
        res.on('end', () => { const body = Buffer.concat(ch).toString('utf8'); if (res.statusCode >= 400 && !/Fault/.test(body)) return reject(new Error(res.statusCode === 401 ? 'Anmeldung abgelehnt (Kamerakonto prüfen)' : `HTTP ${res.statusCode}`)); if (/<(?:\w+:)?Fault\b/.test(body)) { const reason = tag(body, 'Text') || tag(body, 'Subcode') || 'Fehler'; return reject(new Error(/NotAuthorized|Sender not|Authority/i.test(body) ? 'Anmeldung abgelehnt (Kamerakonto prüfen)' : reason)); } resolve(body); });
      });
      req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
      req.on('error', (e) => reject(e));
      req.end(xml);
    });
  }
  function envelope(c, body, authed = true) {
    let head = '';
    if (authed) {
      const r = R(c.id); const nonce = crypto.randomBytes(16); const created = new Date(Date.now() + (r.skew || 0)).toISOString().replace(/\.\d+Z$/, 'Z');
      const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(c.pass || '')])).digest('base64');
      head = `<s:Header><wsse:Security s:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>${esc(c.user)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
    }
    return `<?xml version="1.0" encoding="utf-8"?><s:Envelope ${NS}>${head}<s:Body>${body}</s:Body></s:Envelope>`;
  }
  const base = (c) => `http://${c.host}:${Number(c.port) || 2020}`;
  const fixUrl = (c, u, dflt) => { try { const x = new URL(u); return `http://${c.host}:${x.port || Number(c.port) || 2020}${x.pathname}`; } catch { return dflt; } };
  const call = (c, url, body, timeout) => post(url, envelope(c, body), timeout);

  async function connect(c) {
    const r = R(c.id);
    const dev = `${base(c)}/onvif/device_service`;
    try {   // Kamerauhr für die Anmeldung (ohne Anmeldung abrufbar)
      const t = await post(dev, envelope(c, '<tds:GetSystemDateAndTime/>', false), 5000);
      const u = tag(t, 'UTCDateTime');
      if (u) { const ms = Date.UTC(+tag(tag(u, 'Date'), 'Year'), +tag(tag(u, 'Date'), 'Month') - 1, +tag(tag(u, 'Date'), 'Day'), +tag(tag(u, 'Time'), 'Hour'), +tag(tag(u, 'Time'), 'Minute'), +tag(tag(u, 'Time'), 'Second')); if (isFinite(ms)) r.skew = ms - Date.now(); }
    } catch (e) { throw new Error(/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|Zeitüberschreitung/.test(e.message) ? `Kamera nicht erreichbar (${c.host}:${Number(c.port) || 2020})` : e.message); }
    const di = await call(c, dev, '<tds:GetDeviceInformation/>');
    r.info = { model: tag(di, 'Model'), fw: tag(di, 'FirmwareVersion'), serial: tag(di, 'SerialNumber'), vendor: tag(di, 'Manufacturer') };
    let caps = ''; try { caps = await call(c, dev, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>'); } catch { /* Standardpfade */ }
    const x = (name, dflt) => fixUrl(c, tag(tag(caps, name), 'XAddr'), dflt);
    r.urls = { events: x('Events', `${base(c)}/onvif/service`), media: x('Media', `${base(c)}/onvif/service`), ptz: x('PTZ', `${base(c)}/onvif/service`) };
    const pr = await call(c, r.urls.media, '<trt:GetProfiles/>');
    const m = /<(?:\w+:)?Profiles\b[^>]*\btoken="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?Profiles>/.exec(pr);
    r.profile = m ? m[1] : 'profile_1'; r.ptz = m ? /PTZConfiguration/.test(m[2]) : false;
    r.online = true; r.err = '';
  }

  // ---------- Ereignisse ----------
  function setEvent(c, kind, label, on) {
    const r = R(c.id); const key = `tapo:${c.id}:${kind}`;
    try { api.devices.ensure({ key, name: `${c.name} ${label}`, room: c.room || '', type: 'binary' }); api.devices.setState(key, { on, online: true }); } catch (e) { api.log('warn', `Gerät ${key}: ${e.message}`); }
    r.events[kind] = { label, on, t: Date.now() };
    if (on) {
      r.lastEvent = { kind, label, t: Date.now() };
      if (kind === 'person' && cfg().notifyPerson) api.notify('Kamera', `${c.name}: Person erkannt`);
      if (cfg().snapOnEvent !== false && Date.now() - r.snapT > 20000) snapshot(c).catch(() => {});
    }
    push();
  }
  function handleMessages(c, xml) {
    for (const part of xml.split(/<(?:\w+:)?NotificationMessage\b/).slice(1)) {
      const topic = tag(part, 'Topic');
      const data = tag(part, 'Data') || part;
      const re = /<(?:\w+:)?SimpleItem\b([^>]*?)\/?>/g; let m;
      while ((m = re.exec(data))) {
        const name = attr(m[1], 'Name'), val = attr(m[1], 'Value');
        let k = KINDS[name];
        if (!k && name === 'State' && /Motion/i.test(topic)) k = KINDS.IsMotion;
        if (!k) continue;
        setEvent(c, k[0], k[1], val === 'true' || val === '1');
      }
    }
  }
  async function eventLoop(c) {
    const r = R(c.id); let backoff = 3000;
    while (!r.stop) {
      let sub = '';
      try {
        if (!r.online) await connect(c);
        const s = await call(c, r.urls.events, '<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT90S</tev:InitialTerminationTime></tev:CreatePullPointSubscription>');
        sub = fixUrl(c, tag(tag(s, 'SubscriptionReference'), 'Address'), r.urls.events);
        backoff = 3000; let n = 0;
        while (!r.stop) {
          const x = await call(c, sub, '<tev:PullMessages><tev:Timeout>PT10S</tev:Timeout><tev:MessageLimit>20</tev:MessageLimit></tev:PullMessages>', 20000);
          handleMessages(c, x);
          if (++n % 4 === 0) await call(c, sub, '<wsnt:Renew><wsnt:TerminationTime>PT90S</wsnt:TerminationTime></wsnt:Renew>').catch(() => { throw new Error('erneuern'); });
        }
      } catch (e) {
        if (r.stop) break;
        const was = r.online; r.online = false; r.err = clean(c, e.message);
        if (was) api.log('warn', `[${c.name}] ${r.err}`);
        for (const k of Object.keys(r.events)) { try { api.devices.setState(`tapo:${c.id}:${k}`, { online: false }); } catch { /* egal */ } }
        push(); await sleep(backoff); backoff = Math.min(backoff * 2, 60000);
      }
    }
  }
  function startCam(c) {
    const r = R(c.id); r.stop = false;
    for (const k of ['motion']) { try { api.devices.ensure({ key: `tapo:${c.id}:${k}`, name: `${c.name} Bewegung`, room: c.room || '', type: 'binary' }); } catch { /* egal */ } }
    eventLoop(c).catch((e) => api.log('warn', e.message));
  }
  function stopCam(id) { const r = rt.get(id); if (!r) return; r.stop = true; killFf(r); }

  // ---------- Bilder (ffmpeg) ----------
  const rtsp = (c) => { if (/^rtsps?:\/\//i.test(c.url || '')) return c.url; return `rtsp://${encodeURIComponent(c.user)}:${encodeURIComponent(c.pass)}@${c.host}:554/${c.stream === 'sd' ? 'stream2' : 'stream1'}`; };
  const ffArgs = (c, extra) => ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', rtsp(c), ...extra];
  function ffmpegMissing(e) { return e && e.code === 'ENOENT' ? new Error('ffmpeg nicht gefunden – auf dem Server installieren: sudo apt install ffmpeg') : e; }
  function snapshot(c) {
    const r = R(c.id); r.snapT = Date.now();
    return new Promise((resolve, reject) => {
      const p = spawn(cfg().ffmpeg || 'ffmpeg', ffArgs(c, ['-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '5', '-f', 'image2', 'pipe:1']), { stdio: ['ignore', 'pipe', 'pipe'] });
      const out = [], er = []; const t = setTimeout(() => p.kill('SIGKILL'), 20000);
      p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => er.push(d));
      p.on('error', (e) => { clearTimeout(t); reject(ffmpegMissing(e)); });
      p.on('close', () => { clearTimeout(t); const b = Buffer.concat(out); if (b.length < 500) return reject(new Error(clean(c, Buffer.concat(er).toString().trim().split('\n').pop()) || 'Kein Bild erhalten')); r.snap = { img: 'data:image/jpeg;base64,' + b.toString('base64'), t: Date.now() }; push(); resolve(r.snap); });
    });
  }
  function killFf(r) { if (r.ff) { try { r.ff.kill('SIGKILL'); } catch { /* egal */ } r.ff = null; } }
  function startLive(c) {
    const r = R(c.id); if (r.ff) return;
    const w = Math.max(320, Math.min(1280, Number(cfg().quality) || 640));
    const p = spawn(cfg().ffmpeg || 'ffmpeg', ffArgs(c, ['-vf', `fps=2,scale=${w}:-2`, '-q:v', '7', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']), { stdio: ['ignore', 'pipe', 'pipe'] });
    r.ff = p; r.liveErr = ''; let buf = Buffer.alloc(0);
    p.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const s = buf.indexOf(Buffer.from([0xff, 0xd8])), e = s >= 0 ? buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2) : -1;
        if (s < 0 || e < 0) break;
        r.frame = 'data:image/jpeg;base64,' + buf.subarray(s, e + 2).toString('base64'); r.frameT = Date.now(); buf = buf.subarray(e + 2);
      }
      if (buf.length > 4e6) buf = Buffer.alloc(0);
    });
    let er = ''; p.stderr.on('data', (d) => { er = (er + d).slice(-300); });
    p.on('error', (e) => { r.liveErr = ffmpegMissing(e).message; r.ff = null; });
    p.on('close', () => { if (r.ff === p) { r.ff = null; if (!r.frame || Date.now() - r.frameT > 5000) r.liveErr = clean(c, er.trim().split('\n').pop()) || 'Stream beendet'; } });
  }
  setInterval(() => { for (const [id, r] of rt) if (r.ff && Date.now() > r.liveUntil) { killFf(r); r.frame = null; } }, 5000).unref();

  // ---------- PTZ ----------
  async function ptz(c, fn) { const r = R(c.id); if (!r.online) await connect(c); if (!r.ptz) throw new Error('Diese Kamera kann nicht schwenken'); return fn(r); }
  const move = (c, x, y, z) => ptz(c, async (r) => {
    await call(c, r.urls.ptz, `<tptz:ContinuousMove><tptz:ProfileToken>${esc(r.profile)}</tptz:ProfileToken><tptz:Velocity><tt:PanTilt x="${+x || 0}" y="${+y || 0}"/>${z ? `<tt:Zoom x="${+z}"/>` : ''}</tptz:Velocity></tptz:ContinuousMove>`);
    clearTimeout(r.stopT); r.stopT = setTimeout(() => stopMove(c).catch(() => {}), 600);
  });
  const stopMove = (c) => ptz(c, (r) => call(c, r.urls.ptz, `<tptz:Stop><tptz:ProfileToken>${esc(r.profile)}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`));
  const presets = (c) => ptz(c, async (r) => { const x = await call(c, r.urls.ptz, `<tptz:GetPresets><tptz:ProfileToken>${esc(r.profile)}</tptz:ProfileToken></tptz:GetPresets>`); return [...x.matchAll(/<(?:\w+:)?Preset\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Preset>/g)].map((m) => ({ token: attr(m[1], 'token'), name: tag(m[2], 'Name') || attr(m[1], 'token') })); });
  const gotoPreset = (c, token) => ptz(c, (r) => call(c, r.urls.ptz, `<tptz:GotoPreset><tptz:ProfileToken>${esc(r.profile)}</tptz:ProfileToken><tptz:PresetToken>${esc(token)}</tptz:PresetToken></tptz:GotoPreset>`));

  // ---------- Oberfläche ----------
  const view = (c) => { const r = R(c.id); return { id: c.id, name: c.name, host: c.host, port: Number(c.port) || 2020, user: c.user, room: c.room || '', stream: c.stream || 'hd', url: c.url ? c.url.replace(/\/\/[^@/]*@/, '//***@') : '', online: r.online, err: r.err, info: r.info, ptz: r.ptz, events: r.events, lastEvent: r.lastEvent, snap: r.snap }; };
  const model = () => ({ cams: cams().map(view) });
  let pushT = null; const push = () => { clearTimeout(pushT); pushT = setTimeout(() => { try { api.emit({ model: { cams: cams().map((c) => ({ ...view(c), snap: R(c.id).snap ? { t: R(c.id).snap.t } : null })) } }); } catch { /* egal */ } }, 200); };
  const need = (id) => { const c = camOf(id); if (!c) throw new Error('Kamera unbekannt'); return c; };
  const bodyCam = (b, old) => {
    const c = { id: old ? old.id : crypto.randomBytes(4).toString('hex'), name: String(b.name || '').trim().slice(0, 60), host: String(b.host || '').trim(), port: Math.max(1, Math.min(65535, Number(b.port) || 2020)), user: String(b.user || '').slice(0, 64), pass: b.pass ? String(b.pass).slice(0, 128) : (old ? old.pass : ''), room: String(b.room || '').trim().slice(0, 60), stream: b.stream === 'sd' ? 'sd' : 'hd', url: /^rtsps?:\/\//i.test(String(b.url || '')) ? String(b.url).trim().slice(0, 300) : (b.url && old && /\*\*\*/.test(b.url) ? old.url : '') };
    if (!c.name) throw new Error('Name fehlt'); if (!/^[\w.\-]{1,100}$/.test(c.host)) throw new Error('IP-Adresse oder Hostname ungültig'); if (!c.user || !c.pass) throw new Error('Kamerakonto (Benutzer und Passwort) fehlt');
    return c;
  };
  api.route('GET', 'model', () => model());
  api.route('POST', 'cam', async ({ body }) => {
    const list = cams(); const old = body.id ? list.find((x) => x.id === body.id) : null;
    const c = bodyCam(body, old); const r = R(c.id);
    if (old) { stopCam(old.id); rt.delete(old.id); list[list.indexOf(old)] = c; } else list.push(c);
    saveCams(list); startCam(c); push(); return model();
  });
  api.route('POST', 'cam-delete', ({ body }) => {
    const c = need(body.id); stopCam(c.id); rt.delete(c.id); saveCams(cams().filter((x) => x.id !== c.id));
    for (const k of ['motion', 'person', 'vehicle', 'pet', 'tamper', 'line', 'cry']) { try { api.devices.remove(`tapo:${c.id}:${k}`); } catch { /* war nicht angelegt */ } }
    push(); return model();
  });
  api.route('POST', 'test', async ({ body }) => {
    const old = body.id ? camOf(body.id) : null; const c = bodyCam(body, old); c.id = 'test-' + c.id;
    const r = R(c.id);
    try { await connect(c); return { ok: true, info: r.info, ptz: r.ptz, profile: r.profile }; } finally { rt.delete(c.id); }
  });
  api.route('GET', 'frame/:id', async ({ params }) => {
    const c = need(params.id); const r = R(c.id); r.liveUntil = Date.now() + 12000; startLive(c);
    for (let i = 0; i < 40 && !r.frame && !r.liveErr; i++) await sleep(250);
    if (r.liveErr && !r.frame) throw new Error(r.liveErr);
    return { img: r.frame, t: r.frameT };
  });
  api.route('POST', 'snapshot', async ({ body }) => { const c = need(body.id); const s = await snapshot(c); return { img: s.img, t: s.t }; });
  api.route('GET', 'snap/:id', ({ params }) => { const r = R(need(params.id).id); return r.snap ? { img: r.snap.img, t: r.snap.t } : { img: null }; });
  api.route('POST', 'move', async ({ body }) => { await move(need(body.id), body.x, body.y, body.z); return { ok: true }; });
  api.route('POST', 'stop', async ({ body }) => { await stopMove(need(body.id)); return { ok: true }; });
  api.route('GET', 'presets/:id', async ({ params }) => ({ presets: await presets(need(params.id)) }));
  api.route('POST', 'preset', async ({ body }) => { await gotoPreset(need(body.id), String(body.token || '')); return { ok: true }; });
  api.route('POST', 'reconnect', ({ body }) => { const c = need(body.id); stopCam(c.id); const o = R(c.id); rt.delete(c.id); setTimeout(() => startCam(c), 500); return { ok: true }; });

  try {
    api.mcp.tool({ name: 'kameras', description: 'Tapo-Kameras: Name, Erreichbarkeit, letzte Ereignisse (Bewegung, Person …)', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => cams().map((c) => { const v = view(c); return { name: v.name, online: v.online, modell: v.info && v.info.model, letztes_ereignis: v.lastEvent, ereignisse: v.events }; }) });
    api.mcp.tool({ name: 'kamera_position', description: 'Kamera auf gespeicherte Position (Preset) schwenken', control: true, inputSchema: { type: 'object', properties: { kamera: { type: 'string' }, position: { type: 'string', description: 'Name oder Token der Position' } }, required: ['kamera', 'position'] }, run: async ({ kamera, position }) => { const c = cams().find((x) => x.name.toLowerCase() === String(kamera).toLowerCase()); if (!c) throw new Error('Kamera unbekannt'); const l = await presets(c); const p = l.find((x) => x.name.toLowerCase() === String(position).toLowerCase() || x.token === position); if (!p) throw new Error('Position unbekannt: ' + l.map((x) => x.name).join(', ')); await gotoPreset(c, p.token); return { ok: true }; } });
  } catch { /* MCP nicht verfügbar */ }

  for (const c of cams()) startCam(c);
  return { stop() { for (const id of [...rt.keys()]) stopCam(id); } };
};
