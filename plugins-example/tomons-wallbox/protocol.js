'use strict';
// Tomons / Inateck Wallbox – Protokoll (AES-Rahmen, TLV-Tags), Node-Umsetzung.
// Quelle der Protokollbeschreibung und der Konstanten: Reverse-Engineering von Limo123123
// (https://github.com/Limo123123/tomons-reverse-engineering, MIT-Lizenz). Nicht vom Hersteller.
const crypto = require('crypto');

const KEYS = {
  0x10: ['9355afc5624eaf39d9695f3a1d5c41ca', '45c1723a412108d5b10404b22e5182d7'],
  0x12: ['004bda72a64bec6810793ebe710f4e7f', '34d459bf1cee85c8511d4931057b3be6'],
  0x14: ['bfaaead2082df4f18e8a65782202ddb5', '57f48923e74b169d60ca05b83fad7210'],
  0x16: ['65a2c006e19f06f9d5afd89d6b97c186', '8e48ee2d398e6e5bd22f0ae72fc94304'],
};
const rol = (x, n) => (n ? ((x << n) | (x >> (8 - n))) & 0xff : x & 0xff);

function derive(bk, biv, seed) {
  const w2 = (seed >> 8) & 0xff, w5 = seed & 0xff, t1 = Buffer.alloc(16), k = Buffer.alloc(16), iv = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) { const b = (i & 1) === 0 ? w2 : w5, o = (i & 1) === 0 ? w5 : w2; t1[i] = (rol((b ^ (i * 0x5a)) & 0xff, i & 3) ^ o) & 0xff; }
  for (let i = 0; i < 16; i++) { const x = bk[i] ^ t1[i]; k[i] = (rol(x, (t1[i] + i) & 7) ^ t1[(i + 7) & 15]) & 0xff; }
  for (let i = 0; i < 16; i++) { const tr = t1[15 - i], x = biv[i] ^ tr; iv[i] = (rol(x, (tr + i) & 7) ^ t1[(i + 11) & 15]) & 0xff; }
  return [k, iv];
}
function keyPair(id) { const e = KEYS[id]; return e ? [Buffer.from(e[0], 'hex'), Buffer.from(e[1], 'hex')] : null; }

function crc16(buf, crc = 0xffff) {
  for (const b of buf) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc;
}
function tlv(tag, value) {
  const t = tag > 0xff ? Buffer.from([tag >> 8, tag & 0xff]) : Buffer.from([tag]);
  return Buffer.concat([t, Buffer.from([value.length]), value]);
}
function encrypt(payload, keyId, ctrl, seq, token3) {
  const kp = keyPair(keyId); const seed = Date.now() & 0xffff;
  const [k, iv] = derive(kp[0], kp[1], seed);
  const pad = 16 - (payload.length % 16);
  const c = crypto.createCipheriv('aes-128-cbc', k, iv); c.setAutoPadding(false);
  const ct = Buffer.concat([c.update(Buffer.concat([payload, Buffer.alloc(pad, pad)])), c.final()]);
  const head = Buffer.from([0xa5, 9 + ct.length - 2, ctrl, seq & 0xff, token3[0], token3[1], (seed >> 8) & 0xff, seed & 0xff, keyId]);
  return Buffer.concat([head, ct]);
}
function decrypt(data) {
  if (data.length < 25 || data[0] !== 0xa5) return null;
  const kp = keyPair(data[8]); if (!kp) return null;
  const [k, iv] = derive(kp[0], kp[1], (data[6] << 8) | data[7]);
  const ct = data.subarray(9); if (!ct.length || ct.length % 16) return null;
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', k, iv); d.setAutoPadding(false);
    const pt = Buffer.concat([d.update(ct), d.final()]); const pad = pt[pt.length - 1];
    if (pad < 1 || pad > 16) return null;
    for (let i = 1; i <= pad; i++) if (pt[pt.length - i] !== pad) return null;
    return pt.subarray(0, pt.length - pad);
  } catch { return null; }
}

// Befehle
function statusRequest(seq) {
  const pl = tlv(0xce01, Buffer.from([1]));
  const pkt = Buffer.concat([Buffer.from([0xa5, 1, 0, 0, seq & 0xff, 0, 1, 0, pl.length]), pl]);
  const c = Buffer.alloc(2); c.writeUInt16BE(crc16(pkt)); return Buffer.concat([pkt, c]);
}
function setCurrent(amps, seq) {
  const v = amps * 100, s = Date.now() & 0xffff;
  const pl = Buffer.from([0x53, 0x79, s >> 8, s & 0xff, 0x5e, 0x00, 0xc2, 0x0a, (v >> 8) & 0xff, v & 0xff]);
  return encrypt(pl, 0x10, 0x68, seq, [0x8d, 0x4b]);
}
function startStop(on, seq) {   // EXPERIMENTELL: Aufbau wie in der Referenzbibliothek, ohne Bestätigung an echter Hardware
  const t = (Date.now() & 0xffff);
  return encrypt(tlv(0x0002, Buffer.from([on ? 1 : 0])), 0x12, 0x68, seq, [t >> 8, t & 0xff]);
}

// Telemetrie aus entschlüsselter Nutzlast
const CABLE = { 0: 'Nicht verbunden', 1: 'Verbunden (wartet)', 2: 'Lädt', 3: 'Verbunden (pausiert/fertig)', 4: 'Fehler' };
const MODE = { 0: 'Sofort', 1: 'Zeitplan', 2: 'PV-Überschuss' };
function parse(raw) {
  const p = decrypt(raw); if (!p || p.subarray(0, 2).equals(Buffer.from([0x53, 0x79]))) return null;
  const out = {}; let i;
  if ((i = p.indexOf(Buffer.from([0xc3, 0x02]))) >= 0 && p[i + 2] >= 14 && i + 17 <= p.length) {
    const s = i + 3, w = (n) => p.readUInt16BE(s + n * 2);
    const st = w(0), dur = w(1), pw = w(2), v = w(3), a = w(4), e = w(6);
    out.durationS = dur;
    if (pw <= 35000) out.powerW = pw;
    if (v >= 1000 && v <= 5000) out.voltage = v / 10;
    if (a <= 5000) out.current = a / 100;
    if (e > 0 && e < 35000) out.sessionKwh = e / 1000;
    if (st === 0) { out.powerW = 0; out.current = 0; }
    out.charging = st === 0x0400 || (st >> 8) === 4 || (pw > 100 && a > 100);
  }
  if ((i = p.indexOf(Buffer.from([0xc2, 0x0a]))) >= 0 && i + 4 <= p.length) { const v = p.readUInt16BE(i + 2); if (v >= 600 && v <= 3200) out.limitA = Math.round(v / 100); }
  if ((i = p.indexOf(Buffer.from([0xc2, 0x12, 0x00, 0x00, 0x2a]))) >= 0 && i + 6 <= p.length) { const t = p[i + 5]; if (t <= 80) out.tempC = t; }
  if ((i = p.indexOf(Buffer.from([0xc2, 0x10, 0x05]))) >= 0 && i + 8 <= p.length) { const v = p.readUIntBE(i + 3, 5); if (v > 0) out.totalKwh = v / 100; }
  if ((i = p.indexOf(Buffer.from([0xc3, 0x0a]))) >= 0 && i + 3 < p.length && p[i + 2] >= 1) {
    const c = p[i + 3]; if (CABLE[c] !== undefined) out.cable = c;
    if (c === 0) { out.current = 0; out.powerW = 0; out.charging = false; }
  }
  if ((i = p.indexOf(Buffer.from([0xc3, 0x14]))) >= 0 && i + 2 < p.length && MODE[p[i + 2]] !== undefined) out.mode = p[i + 2];
  return Object.keys(out).length ? out : null;
}
module.exports = { statusRequest, setCurrent, startStop, parse, CABLE, MODE, derive, decrypt, encrypt, crc16 };
