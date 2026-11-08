'use strict';
const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');

// Eingebauter MQTT-Broker (MQTT 3.1 / 3.1.1): QoS 0/1 (QoS 2 wird angenommen und als QoS 1 weitergegeben),
// Retained-Nachrichten (persistent), Last-Will, Benutzer/Passwort, Wildcards + und #.
const MAX_PACKET = 1024 * 1024;

const hashPw = (pass, salt) => crypto.scryptSync(String(pass), salt, 32, { N: 1024, r: 8, p: 1 }).toString('hex');
const safeEq = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function matches(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  if (topic.startsWith('$') && (f[0] === '#' || f[0] === '+')) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}
const validFilter = (s) => s.length > 0 && s.split('/').every((p, i, a) => (p === '#' ? i === a.length - 1 : p === '+' || !/[#+]/.test(p)));

function varint(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
const packet = (first, body) => Buffer.concat([Buffer.from([first]), varint(body.length), body]);
const str = (s) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };

class Broker extends EventEmitter {
  constructor({ store, log }) {
    super();
    this.store = store;
    this.log = log;
    this.server = null;
    this.port = 0;
    this.error = '';
    this.clients = new Set();
    this.retained = new Map();
    this.stats = { in: 0, out: 0 };
    this.saveTimer = null;
    const saved = store.kvGet('broker_retained') || {};
    for (const [t, v] of Object.entries(saved)) this.retained.set(t, { payload: Buffer.from(v.p, 'base64'), qos: v.q });
  }

  get cfg() { return this.store.cfg.broker; }

  // ---------- Benutzer ----------
  setUser(name, pass) {
    const salt = crypto.randomBytes(8).toString('hex');
    const u = this.cfg.users.find((x) => x.name === name);
    const rec = { name, salt, hash: hashPw(pass, salt) };
    if (u) Object.assign(u, rec); else this.cfg.users.push(rec);
    this.store.save();
  }

  removeUser(name) {
    this.cfg.users = this.cfg.users.filter((x) => x.name !== name);
    this.store.save();
    for (const c of [...this.clients]) if (c.user === name) c.close();
  }

  auth(user, pass) {
    const c = this.cfg;
    if (user === undefined) return c.allowAnonymous ? 0 : 5;
    const u = c.users.find((x) => x.name === user);
    if (!u || pass === undefined) return 4;
    return safeEq(hashPw(pass, u.salt), u.hash) ? 0 : 4;
  }

  // ---------- Start/Stop ----------
  start() {
    const port = Number(this.cfg.port) || 1883;
    if (this.server && this.port === port) return;
    this.stop();
    this.port = port;
    this.error = '';
    const srv = net.createServer((sock) => this.accept(sock));
    srv.on('error', (e) => {
      this.error = e.code === 'EADDRINUSE' ? `Port ${port} ist belegt (läuft schon ein Mosquitto? Dann dort stoppen oder anderen Port wählen)` : e.code === 'EACCES' ? `Keine Berechtigung für Port ${port}` : e.message;
      this.log('warn', 'MQTT-Broker: ' + this.error);
      if (this.server === srv) this.server = null;
      this.emit('status');
    });
    srv.listen(port, '0.0.0.0', () => { this.log('info', `MQTT-Broker läuft auf Port ${port}`); this.emit('status'); });
    this.server = srv;
  }

  stop() {
    for (const c of [...this.clients]) c.close(true);
    if (this.server) { try { this.server.close(); } catch { /* ignorieren */ } }
    this.server = null;
    this.saveRetained(true);
    this.emit('status');
  }

  saveRetained(now) {
    const go = () => {
      this.saveTimer = null;
      if (this.store.frozen) return;
      const o = {};
      let n = 0;
      for (const [t, v] of this.retained) { if (++n > 5000) break; o[t] = { p: v.payload.toString('base64'), q: v.qos }; }
      try { this.store.kvSet('broker_retained', o); } catch { /* ignorieren */ }
    };
    if (now) { clearTimeout(this.saveTimer); go(); } else if (!this.saveTimer) this.saveTimer = setTimeout(go, 5000);
  }

  // ---------- Verbindungen ----------
  accept(sock) {
    const c = { sock, id: '', user: undefined, subs: new Map(), buf: Buffer.alloc(0), will: null, ok: false, pid: 1, since: Date.now(), ip: (sock.remoteAddress || '').replace('::ffff:', ''), ka: 0, timer: null, clean: false };
    c.close = (silent) => { c.clean = c.clean || !!silent; try { sock.destroy(); } catch { /* ignorieren */ } };
    sock.setNoDelay(true);
    sock.setTimeout(15000, () => { if (!c.ok) c.close(true); }); // ohne CONNECT schnell trennen
    sock.on('data', (d) => {
      c.buf = Buffer.concat([c.buf, d]);
      try { this.parse(c); } catch (e) { c.close(true); }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearInterval(c.timer);
      if (this.clients.delete(c)) {
        if (c.will && !c.clean) this.publish(c.will.topic, c.will.payload, c.will.qos, c.will.retain, c);
        this.log('debug', `MQTT-Broker: ${c.id} getrennt`);
        this.emit('status');
      }
    });
  }

  parse(c) {
    for (;;) {
      if (c.buf.length < 2) return;
      let mul = 1; let len = 0; let i = 1; let b;
      do {
        if (i >= c.buf.length) return;
        b = c.buf[i++];
        len += (b & 127) * mul;
        mul *= 128;
        if (mul > 128 ** 4) throw new Error('Paket ungültig');
      } while (b & 128);
      if (len > MAX_PACKET) throw new Error('Paket zu groß');
      if (c.buf.length < i + len) return;
      const first = c.buf[0];
      const body = c.buf.subarray(i, i + len);
      c.buf = c.buf.subarray(i + len);
      if (!c.ok && first >> 4 !== 1) throw new Error('CONNECT erwartet');
      this.packet(c, first, body);
    }
  }

  packet(c, first, body) {
    const type = first >> 4;
    const rd = { p: 0 };
    const u16 = () => { const v = body.readUInt16BE(rd.p); rd.p += 2; return v; };
    const rstr = () => { const l = u16(); const s = body.toString('utf8', rd.p, rd.p + l); rd.p += l; return s; };
    const rbin = () => { const l = u16(); const s = body.subarray(rd.p, rd.p + l); rd.p += l; return Buffer.from(s); };
    const send = (buf) => { if (!c.sock.destroyed) c.sock.write(buf); };
    switch (type) {
      case 1: { // CONNECT
        const proto = rstr();
        const level = body[rd.p++];
        const flags = body[rd.p++];
        const ka = u16();
        if (!['MQTT', 'MQIsdp'].includes(proto) || ![3, 4].includes(level)) { send(Buffer.from([0x20, 2, 0, 1])); c.close(true); return; }
        let id = rstr();
        let will = null;
        if (flags & 4) { const topic = rstr(); const payload = rbin(); will = { topic, payload, qos: (flags >> 3) & 3, retain: !!(flags & 32) }; }
        const user = flags & 128 ? rstr() : undefined;
        const pass = flags & 64 ? rbin().toString('utf8') : undefined;
        const rc = this.auth(user, pass);
        if (rc) { send(Buffer.from([0x20, 2, 0, rc])); this.log('warn', `MQTT-Broker: Anmeldung abgelehnt (${user || 'anonym'} von ${c.ip})`); c.close(true); return; }
        if (!id) id = 'hl-' + crypto.randomBytes(5).toString('hex');
        for (const o of this.clients) if (o.id === id) { o.clean = true; o.close(true); }
        Object.assign(c, { id, user, will, ok: true, ka });
        c.sock.setTimeout(0);
        if (ka) { c.sock.setTimeout(ka * 1500, () => c.close()); }
        this.clients.add(c);
        send(Buffer.from([0x20, 2, 0, 0]));
        this.log('debug', `MQTT-Broker: ${id} verbunden (${c.ip}${user ? ', ' + user : ''})`);
        this.emit('status');
        break;
      }
      case 3: { // PUBLISH
        const qos = (first >> 1) & 3;
        const retain = !!(first & 1);
        const topic = rstr();
        if (!topic || /[#+]/.test(topic)) throw new Error('Topic ungültig');
        let pid = 0;
        if (qos > 0) pid = u16();
        const payload = Buffer.from(body.subarray(rd.p));
        if (qos === 1) send(Buffer.from([0x40, 2, pid >> 8, pid & 255]));
        else if (qos === 2) send(Buffer.from([0x50, 2, pid >> 8, pid & 255]));
        this.publish(topic, payload, qos, retain, c);
        break;
      }
      case 6: { const pid = u16(); send(Buffer.from([0x70, 2, pid >> 8, pid & 255])); break; } // PUBREL -> PUBCOMP
      case 5: { const pid = u16(); send(Buffer.from([0x62, 2, pid >> 8, pid & 255])); break; } // PUBREC -> PUBREL
      case 4: case 7: break; // PUBACK / PUBCOMP
      case 8: { // SUBSCRIBE
        const pid = u16();
        const codes = [];
        const added = [];
        while (rd.p < body.length) {
          const f = rstr();
          const q = body[rd.p++] & 3;
          if (!validFilter(f)) { codes.push(0x80); continue; }
          c.subs.set(f, Math.min(q, 1));
          codes.push(Math.min(q, 1));
          added.push(f);
        }
        send(packet(0x90, Buffer.concat([Buffer.from([pid >> 8, pid & 255]), Buffer.from(codes)])));
        for (const f of added) {
          for (const [t, m] of this.retained) if (matches(f, t)) this.deliver(c, t, m.payload, Math.min(m.qos, c.subs.get(f)), true);
        }
        break;
      }
      case 10: { // UNSUBSCRIBE
        const pid = u16();
        while (rd.p < body.length) c.subs.delete(rstr());
        send(Buffer.from([0xb0, 2, pid >> 8, pid & 255]));
        break;
      }
      case 12: send(Buffer.from([0xd0, 0])); break; // PINGREQ
      case 14: c.will = null; c.clean = true; c.close(true); break; // DISCONNECT
      default: throw new Error('Pakettyp nicht unterstützt');
    }
  }

  deliver(c, topic, payload, qos, retain) {
    if (c.sock.destroyed) return;
    const q = Math.min(qos, 1);
    let pid = 0;
    if (q > 0) { pid = c.pid; c.pid = c.pid % 65535 + 1; }
    const head = q > 0 ? Buffer.concat([str(topic), Buffer.from([pid >> 8, pid & 255])]) : str(topic);
    c.sock.write(packet(0x30 | (q << 1) | (retain ? 1 : 0), Buffer.concat([head, payload])));
    this.stats.out++;
  }

  publish(topic, payload, qos, retain, from) {
    this.stats.in++;
    if (retain) {
      if (!payload.length) this.retained.delete(topic); else this.retained.set(topic, { payload, qos: Math.min(qos, 1) });
      this.saveRetained();
    }
    for (const c of this.clients) {
      let best = -1;
      for (const [f, q] of c.subs) if (q > best && matches(f, topic)) best = q;
      if (best < 0) continue;
      this.deliver(c, topic, payload, Math.min(qos, best), false);
    }
    this.emit('message', topic, payload, from);
  }

  snapshot() {
    const c = this.cfg;
    return {
      running: !!this.server && !this.error, port: Number(c.port) || 1883, error: this.error, allowAnonymous: !!c.allowAnonymous,
      users: c.users.map((u) => u.name), internal: c.internal ? c.internal.user : '',
      retained: this.retained.size, msgIn: this.stats.in, msgOut: this.stats.out,
      clients: [...this.clients].map((x) => ({ id: x.id, ip: x.ip, user: x.user || '', since: x.since, subs: x.subs.size })),
    };
  }
}

Broker.matches = matches;
module.exports = Broker;
