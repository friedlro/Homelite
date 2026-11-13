'use strict';
// CoIoT-Empfang für Shelly Gen1 (CoAP über UDP, Port 5683).
// Die Geräte melden Zustandsänderungen sofort an den eingetragenen „CoIoT-Peer“ (HomeLite-IP:5683).
// HomeLite fragt das betroffene Gerät daraufhin sofort ab, statt bis zur nächsten Abfragerunde (10 s) zu warten.
const dgram = require('dgram');
const EventEmitter = require('events');

const MCAST = '224.0.1.187';
const OPT_DEVID = 3332; // „Global Device ID“: <Typ>#<MAC>#<Version>

// CoAP-Paket zerlegen (RFC 7252), nur was CoIoT braucht
function parseCoap(buf) {
  if (buf.length < 4 || buf[0] >> 6 !== 1) return null;
  const type = (buf[0] >> 4) & 3;
  const tkl = buf[0] & 15;
  const code = buf[1];
  const mid = buf.readUInt16BE(2);
  let p = 4 + tkl;
  if (tkl > 8 || p > buf.length) return null;
  const opts = [];
  let num = 0;
  while (p < buf.length && buf[p] !== 0xff) {
    let d = buf[p] >> 4;
    let l = buf[p] & 15;
    p++;
    if (d === 13) { d = buf[p++] + 13; } else if (d === 14) { d = buf.readUInt16BE(p) + 269; p += 2; } else if (d === 15) return null;
    if (l === 13) { l = buf[p++] + 13; } else if (l === 14) { l = buf.readUInt16BE(p) + 269; p += 2; } else if (l === 15) return null;
    if (p + l > buf.length) return null;
    num += d;
    opts.push([num, buf.subarray(p, p + l)]);
    p += l;
  }
  const payload = p < buf.length && buf[p] === 0xff ? buf.subarray(p + 1) : Buffer.alloc(0);
  return { type, code, mid, opts, payload };
}

class CoIoT extends EventEmitter {
  constructor({ store, devices, log }) {
    super();
    this.store = store;
    this.devices = devices;
    this.log = log;
    this.sock = null;
    this.bound = false;
    this.error = '';
    this.seen = new Map(); // IP -> { ts, devid, count, last }
    this.cfgs = new Map(); // IP -> { ok, enabled, peer, error, ts }
    this.timers = new Map();
    this.local = new Map(); // Ziel-IP -> eigene IP
    devices.coiot = this;
  }

  get conf() { return this.store.cfg.coiot; }

  // ---------- Empfänger ----------
  start() {
    this.stop();
    if (!this.conf.enabled) { this.emit('change'); return; }
    const port = Number(this.conf.port) || 5683;
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', (e) => {
      this.error = e.code === 'EADDRINUSE' ? `Port ${port} ist belegt (läuft noch ein anderer CoIoT-Empfänger auf diesem Rechner?)` : e.code === 'EACCES' ? `Keine Berechtigung für Port ${port}` : e.message;
      this.log('warn', 'CoIoT: ' + this.error);
      try { s.close(); } catch { /* ignorieren */ }
      if (this.sock === s) { this.sock = null; this.bound = false; }
      this.emit('change');
    });
    s.on('message', (msg, rinfo) => { try { this.onPacket(msg, rinfo, s); } catch { /* kaputtes Paket ignorieren */ } });
    s.bind(port, () => {
      this.error = '';
      this.bound = true;
      try { s.addMembership(MCAST); } catch { /* Multicast optional (z. B. Container) */ }
      this.log('info', `CoIoT: lauscht auf UDP ${port}`);
      this.emit('change');
    });
    this.sock = s;
  }

  stop() {
    if (this.sock) { try { this.sock.close(); } catch { /* ignorieren */ } this.sock = null; }
    this.bound = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.error = '';
  }

  onPacket(msg, rinfo, sock) {
    const c = parseCoap(msg);
    if (!c) return;
    if (c.type === 0) { // CON: kurz bestätigen
      const ack = Buffer.from([0x60, 0x00, c.mid >> 8, c.mid & 255]);
      sock.send(ack, rinfo.port, rinfo.address);
    }
    const o = c.opts.find((x) => x[0] === OPT_DEVID);
    if (!o) return;
    const devid = o[1].toString('utf8');
    const path = c.opts.filter((x) => x[0] === 11).map((x) => x[1].toString('utf8')).join('/');
    if (path && path !== 'cit/s') return; // /cit/d (Beschreibung) brauchen wir nicht
    const ip = rinfo.address;
    const dm = /#([0-9A-Fa-f]{12})#/.exec(devid);   // z. B. SHSW-1#E8DB84A1B2C3#1
    if (dm) this.devices.shellyMoved(dm[1].toUpperCase(), ip);
    const payload = c.payload.toString('utf8');
    const rec = this.seen.get(ip) || { count: 0, last: '' };
    const first = !rec.ts;
    const changed = payload !== rec.last;
    Object.assign(rec, { ts: Date.now(), devid, count: rec.count + 1, last: payload });
    this.seen.set(ip, rec);
    if (first) this.emit('change');
    const known = this.devices.list.filter((d) => d.driver === 'shelly' && d.ip === ip);
    if (!known.length) return;
    // Zustand hat sich laut Meldung geändert -> betroffene Geräte sofort abfragen (kurz bündeln)
    if (changed) {
      clearTimeout(this.timers.get(ip));
      this.timers.set(ip, setTimeout(() => {
        this.timers.delete(ip);
        for (const d of known) this.devices.pollShelly(d).catch(() => {});
      }, 150));
    }
  }

  // Wurde das Gerät in letzter Zeit per CoIoT gehört? Dann reicht die seltene Sicherheitsabfrage.
  fresh(ip) {
    const r = this.seen.get(ip);
    return !!(r && this.sock && Date.now() - r.ts < 120000);
  }

  // ---------- Einrichtung auf den Shellys ----------
  targets() {
    const m = new Map();
    for (const d of this.devices.list) {
      if (d.driver !== 'shelly' || !d.ip) continue;
      const t = m.get(d.ip) || { ip: d.ip, dev: d, names: [] };
      t.names.push(d.name);
      m.set(d.ip, t);
    }
    return m;
  }

  // eigene IP, über die das Gerät erreichbar ist (richtige Netzwerkkarte)
  localFor(ip) {
    if (this.conf.host) return Promise.resolve(this.conf.host);
    if (this.local.has(ip)) return Promise.resolve(this.local.get(ip));
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      s.on('error', (e) => { try { s.close(); } catch { /* ignorieren */ } reject(e); });
      s.connect(80, ip, () => {
        try { const a = s.address().address; this.local.set(ip, a); resolve(a); } catch (e) { reject(e); } finally { try { s.close(); } catch { /* ignorieren */ } }
      });
    });
  }

  async read(ip) {
    const t = this.targets().get(ip);
    if (!t) throw new Error('Unbekannte Shelly-IP');
    try {
      await this.devices.ensureGen(t.dev);
      if (t.dev.gen === 2) { this.cfgs.set(ip, { gen: 2, ts: Date.now() }); return; }
      const j = await this.devices.shellyFetch(t.dev, '/settings');
      const c = j.coiot || {};
      this.cfgs.set(ip, { gen: 1, ok: true, enabled: !!c.enabled, peer: c.peer || '', period: c.update_period, ts: Date.now() });
    } catch (e) {
      this.cfgs.set(ip, { gen: t.dev.gen || 1, ok: false, error: (e.cause && e.cause.code) || e.message, ts: Date.now() });
    }
    this.emit('change');
  }

  async readAll() {
    await Promise.allSettled([...this.targets().keys()].map((ip) => this.read(ip)));
  }

  // CoIoT-Peer am Gerät auf HomeLite stellen und das Gerät neu starten (Shelly übernimmt die Einstellung erst danach)
  async setup(ip, { reboot = true } = {}) {
    const t = this.targets().get(ip);
    if (!t) throw new Error('Unbekannte Shelly-IP');
    await this.devices.ensureGen(t.dev);
    if (t.dev.gen === 2) throw new Error('Gen2/3-Geräte nutzen kein CoIoT');
    const port = Number(this.conf.port) || 5683;
    const me = await this.localFor(ip);
    const peer = `${me}:${port}`;
    await this.devices.shellyFetch(t.dev, `/settings?coiot_enable=true&coiot_peer=${encodeURIComponent(peer)}`);
    this.log('info', `CoIoT: „${t.names[0]}“ (${ip}) sendet jetzt an ${peer}`);
    if (reboot) { try { await this.devices.shellyFetch(t.dev, '/reboot'); } catch { /* Gerät startet neu, Antwort kann ausbleiben */ } }
    setTimeout(() => this.read(ip), reboot ? 12000 : 500);
    return peer;
  }

  snapshot() {
    const rows = [];
    for (const [ip, t] of this.targets()) {
      const r = this.seen.get(ip);
      const c = this.cfgs.get(ip);
      rows.push({
        ip, names: t.names, gen: (c && c.gen) || t.dev.gen || 0,
        cfg: c ? { ok: c.ok !== false, enabled: c.enabled, peer: c.peer, error: c.error, ts: c.ts } : null,
        last: r ? r.ts : 0, count: r ? r.count : 0, devid: r ? r.devid : '',
      });
    }
    return { enabled: !!this.conf.enabled, port: Number(this.conf.port) || 5683, host: this.conf.host || '', listening: this.bound && !this.error, error: this.error, devices: rows };
  }
}

module.exports = CoIoT;
module.exports.parseCoap = parseCoap;
