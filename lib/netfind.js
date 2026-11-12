'use strict';
// Shelly nach Router-Neustart (neue DHCP-Adresse) wiederfinden: Geräte werden an der MAC-Adresse erkannt.
// Ablauf: eigenes IPv4-Netz (max. /22) auf Port 80 absuchen und jedes antwortende Gerät nach /shelly fragen (liefert die MAC).
const os = require('os');
const net = require('net');

const normMac = (m) => String(m || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 12);
const ipNum = (ip) => ip.split('.').reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0);
const numIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

function hosts(extra = []) {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) {
    if (i.family !== 'IPv4' || i.internal) continue;
    const mask = ipNum(i.netmask), addr = ipNum(i.address);
    const bits = 32 - Math.log2((~mask >>> 0) + 1);
    if (bits < 22) { // sehr große Netze: nur das /24 des Servers
      const base = (addr & 0xffffff00) >>> 0; for (let k = 1; k < 255; k++) out.add(numIp(base + k));
    } else {
      const base = (addr & mask) >>> 0, size = (~mask >>> 0) + 1;
      for (let k = 1; k < size - 1; k++) out.add(numIp(base + k));
    }
    out.delete(i.address);
  }
  for (const e of extra) out.add(e);
  return [...out];
}
const open80 = (ip, ms = 700) => new Promise((resolve) => {
  const s = net.connect({ host: ip, port: 80 });
  const done = (v) => { try { s.destroy(); } catch { /* egal */ } resolve(v); };
  s.setTimeout(ms, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false));
});

// → Map MAC → { ip, gen, model }
async function scan({ concurrency = 48 } = {}) {
  const list = hosts(), found = new Map();
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const ip = list[i++];
      if (!(await open80(ip))) continue;
      try {
        const r = await fetch(`http://${ip}/shelly`, { signal: AbortSignal.timeout(2500) });
        if (!r.ok) continue;
        const j = await r.json();
        const mac = normMac(j.mac);
        if (mac.length === 12) found.set(mac, { ip, gen: Number(j.gen) >= 2 ? 2 : 1, model: String(j.model || j.type || '') });
      } catch { /* kein Shelly */ }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found;
}

module.exports = { scan, normMac, hosts };
