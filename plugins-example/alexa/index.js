'use strict';
// Alexa über Hue-Emulation: SSDP-Erkennung (UDP 1900) + Hue-API v1 (HTTP, Port 80).
// Echo-Geräte (Echo, Echo Dot, Show …) koppeln HomeLite wie eine Philips-Hue-Bridge und steuern die freigegebenen Geräte.
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

module.exports = (api) => {
  let server = null, sock = null, notifyTimer = null;
  let st = { running: false, error: '', ip: '', port: 80, mac: '', bridgeId: '', hits: 0, lastHit: 0, lastCmd: '' };

  const kvExpose = () => api.kv.get('expose') || {};        // { deviceId: { name } }
  const kvIds = () => api.kv.get('ids') || { next: 1, map: {} }; // deviceId -> Hue-Nummer (stabil)
  const hueId = (devId) => {
    const k = kvIds();
    if (!k.map[devId]) { k.map[devId] = k.next++; api.kv.set('ids', k); }
    return k.map[devId];
  };
  const user = () => {
    let u = api.kv.get('user');
    if (!u) { u = crypto.randomBytes(16).toString('hex'); api.kv.set('user', u); }
    return u;
  };

  // --- Netzwerk ---
  function pickNet() {
    const want = String(api.config().ip || '').trim();
    const all = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      if (/^(lo|wg|tailscale|docker|br-|veth|lxc|virbr)/.test(name)) continue;
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) all.push({ ip: a.address, mac: a.mac, name });
    }
    return (want && all.find((x) => x.ip === want)) || (want ? { ip: want, mac: (all[0] || {}).mac || '00:17:88:00:00:01', name: '' } : all[0]) || null;
  }
  const bridgeIdOf = (mac) => { const m = mac.replace(/:/g, '').toUpperCase(); return (m.slice(0, 6) + 'FFFE' + m.slice(6)); };
  const uuidOf = (mac) => `2f402f80-da50-11e1-9b23-${mac.replace(/:/g, '').toLowerCase()}`;

  // --- Geräte → Hue-Lichter ---
  const exposable = () => api.devices.all().filter((d) => d.type === 'switch' || d.type === 'light');
  function lights() {
    const ex = kvExpose(), out = {};
    for (const d of exposable()) {
      const e = ex[d.id];
      if (!e) continue;
      const n = hueId(d.id);
      const raw = d.state_raw || {};
      const dim = d.type === 'light';
      const bri = dim ? Math.max(1, Math.min(254, Math.round(((raw.brightness != null ? Number(raw.brightness) : (raw.on ? 100 : 1)) / 100) * 254))) : undefined;
      const hex = (x) => x.toString(16).padStart(2, '0');
      out[n] = {
        state: { on: !!raw.on, ...(dim ? { bri } : {}), alert: 'none', reachable: raw.online !== false },
        swupdate: { state: 'noupdates', lastinstall: null },
        type: dim ? 'Dimmable light' : 'On/Off plug-in unit',
        name: String(e.name || d.name).slice(0, 32),
        modelid: dim ? 'LWB010' : 'LOM001',
        manufacturername: 'Philips',
        productname: dim ? 'Hue white lamp' : 'Hue smart plug',
        capabilities: { certified: true, control: {}, streaming: { renderer: false, proxy: false } },
        config: { archetype: dim ? 'classicbulb' : 'plug', function: 'functional', direction: 'omnidirectional' },
        uniqueid: `00:17:88:01:00:${hex((n >> 8) & 255)}:${hex(n & 255)}:01-0b`,
        swversion: '5.50.1.19085',
        _dev: d.id,
      };
    }
    return out;
  }
  const strip = (l) => { const { _dev, ...r } = l; return r; };

  // --- Hue-API ---
  const cfgObj = () => ({
    name: 'HomeLite', datastoreversion: '126', swversion: '1935144040', apiversion: '1.41.0',
    mac: st.mac, bridgeid: st.bridgeId, factorynew: false, replacesbridgeid: null, modelid: 'BSB002',
    starterkitid: '', ipaddress: st.ip, netmask: '255.255.255.0', gateway: st.ip, dhcp: true, proxyaddress: 'none', proxyport: 0,
    UTC: new Date().toISOString().slice(0, 19), localtime: new Date().toISOString().slice(0, 19), timezone: 'Europe/Vienna',
    zigbeechannel: 25, linkbutton: true, portalservices: false, portalconnection: 'disconnected',
    whitelist: { [user()]: { 'last use date': new Date().toISOString().slice(0, 19), 'create date': '2020-01-01T00:00:00', name: 'Echo' } },
  });
  const fullState = () => {
    const L = {}; for (const [n, l] of Object.entries(lights())) L[n] = strip(l);
    return { lights: L, groups: {}, config: cfgObj(), schedules: {}, scenes: {}, rules: {}, sensors: {}, resourcelinks: {} };
  };

  async function setLight(n, body) {
    const l = lights()[n];
    if (!l) return [{ error: { type: 3, address: `/lights/${n}`, description: 'resource, /lights/' + n + ', not available' } }];
    const res = [], put = (k, v) => res.push({ success: { [`/lights/${n}/state/${k}`]: v } });
    try {
      if (body.bri !== undefined || body.bri_inc !== undefined) {
        const cur = l.state.bri || 1;
        const bri = body.bri !== undefined ? Number(body.bri) : cur + Number(body.bri_inc);
        const pct = Math.max(1, Math.min(100, Math.round((bri / 254) * 100)));
        if (l.type === 'Dimmable light') { await api.devices.control(l._dev, 'brightness', pct); put('bri', Math.max(1, Math.min(254, bri))); }
        if (body.on === undefined && bri > 0 && !l.state.on) await api.devices.control(l._dev, 'on');
      }
      if (body.on !== undefined) { await api.devices.control(l._dev, body.on ? 'on' : 'off'); put('on', !!body.on); }
      st.lastCmd = `${l.name}: ${JSON.stringify(body)}`;
      api.log('info', `Alexa → ${st.lastCmd}`);
    } catch (e) {
      res.push({ error: { type: 901, address: `/lights/${n}/state`, description: e.message } });
      api.log('warn', `Alexa-Befehl für ${l.name} fehlgeschlagen: ${e.message}`);
    }
    return res.length ? res : [{ success: {} }];
  }

  async function handle(req, res) {
    const chunks = [];
    for await (const c of req) { chunks.push(c); if (chunks.length > 64) break; }
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* leer */ }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    const m = req.method;
    st.hits++; st.lastHit = Date.now();
    const json = (o, code = 200) => { const s = JSON.stringify(o); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' }); res.end(s); };

    if (p[0] === 'description.xml') {
      const x = `<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>
<URLBase>http://${st.ip}:${st.port}/</URLBase>
<device><deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType>
<friendlyName>HomeLite (${st.ip})</friendlyName><manufacturer>Royal Philips Electronics</manufacturer>
<manufacturerURL>http://www.philips.com</manufacturerURL><modelDescription>Philips hue Personal Wireless Lighting</modelDescription>
<modelName>Philips hue bridge 2015</modelName><modelNumber>BSB002</modelNumber><modelURL>http://www.meethue.com</modelURL>
<serialNumber>${st.mac.replace(/:/g, '').toLowerCase()}</serialNumber><UDN>uuid:${uuidOf(st.mac)}</UDN>
<presentationURL>index.html</presentationURL></device></root>`;
      res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(x);
    }
    if (p[0] !== 'api') { res.writeHead(404); return res.end(); }
    if (m === 'POST' && p.length === 1) return json([{ success: { username: user() } }]);
    if (p[1] === 'config' && p.length === 2) return json(cfgObj());
    const u = p[1];
    if (u !== user() && p.length >= 2) {
      // Unbekannter Benutzer: wie echte Bridge → „unauthorized“ (Echo koppelt dann neu per POST /api)
      return json([{ error: { type: 1, address: '/' + p.slice(1).join('/'), description: 'unauthorized user' } }]);
    }
    const sec = p[2];
    if (!sec) return json(fullState());
    if (sec === 'config') return json(cfgObj());
    if (sec === 'lights') {
      const L = lights();
      if (p.length === 3 && m === 'GET') { const o = {}; for (const [n, l] of Object.entries(L)) o[n] = strip(l); return json(o); }
      if (p.length === 3 && m === 'POST') return json([{ success: { '/lights': 'Searching for new devices' } }]);
      const n = p[3];
      if (p.length === 4 && m === 'GET') return L[n] ? json(strip(L[n])) : json([{ error: { type: 3, address: '/lights/' + n, description: 'resource, /lights/' + n + ', not available' } }]);
      if (p[4] === 'state' && m === 'PUT') return json(await setLight(n, body));
    }
    if (['groups', 'scenes', 'schedules', 'rules', 'sensors', 'resourcelinks'].includes(sec) && m === 'GET') {
      if (sec === 'groups' && p.length === 4 && p[3] === '0') return json({ name: 'Group 0', lights: Object.keys(lights()), type: 'LightGroup', state: { all_on: false, any_on: false }, action: { on: false } });
      return json({});
    }
    if (sec === 'groups' && p[3] === '0' && p[4] === 'action' && m === 'PUT') {
      const out = []; for (const n of Object.keys(lights())) out.push(...await setLight(n, body)); return json(out);
    }
    return json([{ error: { type: 4, address: req.url, description: 'method, ' + m + ', not available for resource, ' + req.url } }]);
  }

  // --- SSDP ---
  function ssdpReply(ip, st2) {
    const usn = `uuid:${uuidOf(st.mac)}${st2 === `uuid:${uuidOf(st.mac)}` ? '' : '::' + st2}`;
    return Buffer.from(['HTTP/1.1 200 OK', 'HOST: 239.255.255.250:1900', 'EXT:', 'CACHE-CONTROL: max-age=100',
      `LOCATION: http://${st.ip}:${st.port}/description.xml`, 'SERVER: Linux/3.14.0 UPnP/1.0 IpBridge/1.41.0',
      `hue-bridgeid: ${st.bridgeId}`, `ST: ${st2}`, `USN: ${usn}`, '', ''].join('\r\n'));
  }
  const STS = () => ['upnp:rootdevice', `uuid:${uuidOf(st.mac)}`, 'urn:schemas-upnp-org:device:basic:1'];
  function startSsdp() {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => { st.error = 'SSDP: ' + e.message; api.log('warn', st.error); publish(); });
    sock.on('message', (msg, rinfo) => {
      const t = msg.toString();
      if (!/^M-SEARCH/i.test(t)) return;
      const m = /^ST:\s*(.+)$/im.exec(t);
      const want = m ? m[1].trim() : 'ssdp:all';
      const targets = want === 'ssdp:all' ? STS() : STS().filter((x) => x.toLowerCase() === want.toLowerCase());
      if (/MAN:\s*"ssdp:discover"/i.test(t) || targets.length) for (const s of targets) setTimeout(() => sock && sock.send(ssdpReply(rinfo.address, s), rinfo.port, rinfo.address), Math.random() * 400);
    });
    sock.bind(1900, () => {
      try { sock.addMembership('239.255.255.250', st.ip); sock.setMulticastInterface(st.ip); sock.setMulticastTTL(2); } catch (e) { st.error = 'SSDP: ' + e.message; api.log('warn', st.error); }
    });
    const notify = () => {
      if (!sock) return;
      for (const s of STS()) {
        const b = Buffer.from(['NOTIFY * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'CACHE-CONTROL: max-age=100', `LOCATION: http://${st.ip}:${st.port}/description.xml`,
          'SERVER: Linux/3.14.0 UPnP/1.0 IpBridge/1.41.0', `NTS: ssdp:alive`, `NT: ${s}`, `USN: uuid:${uuidOf(st.mac)}${s.startsWith('uuid:') ? '' : '::' + s}`, `hue-bridgeid: ${st.bridgeId}`, '', ''].join('\r\n'));
        try { sock.send(b, 1900, '239.255.255.250'); } catch { /* ignorieren */ }
      }
    };
    notifyTimer = setInterval(notify, 60000); setTimeout(notify, 3000);
  }

  // --- Start / Stop ---
  function stop() {
    if (notifyTimer) clearInterval(notifyTimer); notifyTimer = null;
    try { sock && sock.close(); } catch { /* */ } sock = null;
    try { server && server.close(); } catch { /* */ } server = null;
  }
  function start() {
    stop();
    const net = pickNet();
    const port = Number(api.config().port) || 80;
    if (!net) { st = { ...st, running: false, error: 'Keine Heimnetz-Adresse gefunden – IP in den Plugin-Einstellungen eintragen' }; return publish(); }
    st = { ...st, ip: net.ip, port, mac: net.mac, bridgeId: bridgeIdOf(net.mac), error: '', running: false };
    server = http.createServer((req, res) => handle(req, res).catch((e) => { try { res.writeHead(500); res.end(); } catch { /* */ } api.log('warn', 'Anfrage: ' + e.message); }));
    server.on('error', (e) => {
      st.running = false;
      st.error = e.code === 'EADDRINUSE' ? `Port ${port} ist belegt – andere Bridge/Webserver beenden` : e.code === 'EACCES' ? `Keine Berechtigung für Port ${port}` : e.message;
      api.log('error', st.error); publish();
    });
    server.listen(port, '0.0.0.0', () => { st.running = true; api.log('info', `Hue-Bridge „HomeLite“ auf ${net.ip}:${port} (Bridge-ID ${st.bridgeId})`); startSsdp(); publish(); });
  }

  const snap = () => ({
    ...st,
    devices: exposable().map((d) => ({ id: d.id, name: d.name, room: d.room, type: d.type, on: !!(d.state_raw || {}).on, exposed: !!kvExpose()[d.id], alias: (kvExpose()[d.id] || {}).name || '' })),
  });
  const publish = () => { try { api.emit({ model: snap() }); } catch { /* */ } };

  api.route('GET', 'model', () => snap());
  api.route('PUT', 'expose', ({ body }) => {
    const ex = kvExpose();
    const d = exposable().find((x) => x.id === body.id);
    if (!d) throw new Error('Gerät nicht gefunden');
    if (body.exposed === false) delete ex[d.id];
    else ex[d.id] = { name: String(body.alias || (ex[d.id] || {}).name || d.name).replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 32) || d.name };
    api.kv.set('expose', ex);
    publish();
    return snap();
  });
  api.onConfig(() => start());
  start();
  return { stop };
};
