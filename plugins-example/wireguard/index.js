// WireGuard-Server mit Benutzern, Rechten und Zugangspunkten (Geräten). Nutzt wg / wg-quick / iptables des Rechners.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DIR = process.env.WG_DIR || '/etc/wireguard';
const CHAIN = 'HL_WG';
const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const EXTRA_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?(:(tcp|udp):\d{1,5})?$/;
const HOST_RE = /^[A-Za-z0-9.\-]{1,200}(:\d{1,5})?$/;

const ip2n = (s) => { const m = IP_RE.exec(s); if (!m || m.slice(1).some((x) => Number(x) > 255)) return null; return ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0; };
const n2ip = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
function parseCidr(s) {
  s = String(s || '').trim(); if (!CIDR_RE.test(s)) return null;
  const [a, b] = s.split('/'); const base = ip2n(a), bits = Number(b); if (base == null || bits < 8 || bits > 30) return null;
  const mask = (0xffffffff << (32 - bits)) >>> 0; return { net: (base & mask) >>> 0, bits, mask, cidr: n2ip((base & mask) >>> 0) + '/' + bits };
}
// Schlüssel (Curve25519) ohne zusätzliche Programme
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
function pubFromPriv(privB64) {
  const k = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(privB64, 'base64')]), format: 'der', type: 'pkcs8' });
  return crypto.createPublicKey(k).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}
function genKey() {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64');
  return { priv, pub: pubFromPriv(priv) };
}
const genPsk = () => crypto.randomBytes(32).toString('base64');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'geraet';

module.exports = (api) => {
  const cfg = () => api.config() || {};
  const lg = (m) => { try { api.log(m); } catch { /* egal */ } };
  let db = api.kv.get('db') || null;
  let stopped = false, timer = null, dry = false;
  const S = { applied: false, err: '', up: false, tools: {}, live: {}, ts: 0, cmds: [] };
  const saveDb = () => api.kv.set('db', db);

  // ---------- Einstellungen ----------
  function opts() {
    const c = cfg();
    const iface = /^[a-z0-9_-]{1,15}$/.test(String(c.iface || 'wg0')) ? String(c.iface || 'wg0') : 'wg0';
    const sn = parseCidr(c.subnet || '10.8.0.0/24') || parseCidr('10.8.0.0/24');
    const lan = parseCidr(c.lan || '') || null;
    const port = Math.max(1, Math.min(65535, Number(c.port) || 51820));
    const mtu = Math.max(1280, Math.min(1500, Number(c.mtu) || 1380));
    const dns = String(c.dns || '').split(/[\s,;]+/).filter((x) => IP_RE.test(x)).join(', ');
    return { iface, sn, lan, port, mtu, dns, wan: /^[a-zA-Z0-9_.-]{1,15}$/.test(String(c.wan || '')) ? String(c.wan) : '', serverIp: n2ip(sn.net + 1) };
  }
  function endpoints() {
    const out = []; const o = opts();
    let dd = null; try { dd = api.use('duckdns'); } catch { /* nicht da */ }
    try { for (const d of (dd && dd.domains ? dd.domains() : [])) out.push(d.includes(':') ? d : `${d}:${o.port}`); } catch { /* egal */ }
    for (const e of String(cfg().endpoints || '').split(/[\s,;]+/).filter(Boolean)) if (HOST_RE.test(e)) out.push(e.includes(':') ? e : `${e}:${o.port}`);
    return [...new Set(out)];
  }

  // ---------- Datenbank ----------
  function ensureDb() {
    if (!db || !db.server) { db = { server: genKey(), users: [], peers: [] }; saveDb(); }
    db.users = db.users || []; db.peers = db.peers || [];
  }
  const userOf = (id) => db.users.find((u) => u.id === id);
  const peerOf = (id) => db.peers.find((p) => p.id === id);
  const cleanName = (s, max = 40) => String(s || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max);
  function cleanPerms(p) {
    p = p || {}; const extra = [];
    for (const x of (Array.isArray(p.extra) ? p.extra : String(p.extra || '').split(/[\s,;]+/)).map((v) => String(v).trim()).filter(Boolean)) {
      if (!EXTRA_RE.test(x)) throw new Error(`Ziel „${x}“ ungültig (Beispiele: 192.168.50.10, 192.168.50.0/24, 192.168.50.10:tcp:8123)`);
      extra.push(x);
    }
    return { lan: !!p.lan, internet: !!p.internet, peers: !!p.peers, extra };
  }
  function nextIp() {
    const o = opts(); const used = new Set(db.peers.map((p) => p.ip)); used.add(o.serverIp);
    for (let n = o.sn.net + 2; n < (o.sn.net | (~o.sn.mask >>> 0)) >>> 0; n++) { const a = n2ip(n); if (!used.has(a)) return a; }
    throw new Error('Keine freie Adresse im VPN-Netz mehr');
  }

  // ---------- Befehle ----------
  function run(cmd, args, input) {
    S.cmds.push([cmd, ...args].join(' ')); if (S.cmds.length > 200) S.cmds.shift();
    if (dry) return Promise.resolve('');
    return new Promise((res, rej) => {
      const p = execFile(cmd, args, { timeout: 20000, maxBuffer: 1 << 20 }, (e, out, err) => { if (e) { e.message = `${cmd}: ${String(err || e.message).trim().split('\n')[0]}`; rej(e); } else res(String(out)); });
      if (input != null) { p.stdin.on('error', () => {}); p.stdin.end(input); }
    });
  }
  const has = async (bin) => { try { await run('which', [bin]); return true; } catch { return false; } };
  async function wanIf(o) {
    if (o.wan) return o.wan;
    try { const r = await run('ip', ['-4', 'route', 'show', 'default']); const m = /dev (\S+)/.exec(r); if (m) return m[1]; } catch { /* egal */ }
    return '';
  }

  // ---------- Server-Konfiguration ----------
  function serverConf() {
    const o = opts();
    const L = ['# Von HomeLite (Plugin WireGuard) erzeugt – Änderungen gehen verloren.', '[Interface]', `PrivateKey = ${db.server.priv}`, `Address = ${o.serverIp}/${o.sn.bits}`, `ListenPort = ${o.port}`, `MTU = ${o.mtu}`];
    for (const p of db.peers) {
      const u = userOf(p.userId); if (!p.enabled || !u || !u.enabled) continue;
      L.push('', `# ${u.name} – ${p.name}`, '[Peer]', `PublicKey = ${p.pub}`, `PresharedKey = ${p.psk}`, `AllowedIPs = ${p.ip}/32`);
    }
    return L.join('\n') + '\n';
  }
  function destsFor(u) {
    const o = opts(); const d = [];
    if (u.perms.internet) return ['0.0.0.0/0'];
    d.push(o.sn.cidr);
    if (u.perms.lan && o.lan) d.push(o.lan.cidr);
    for (const x of u.perms.extra) d.push(x.split(':')[0].includes('/') ? x.split(':')[0] : x.split(':')[0] + '/32');
    return [...new Set(d)];
  }
  async function firewall(o) {
    const ipt = (...a) => run('iptables', a);
    const quiet = async (...a) => { try { await ipt(...a); } catch { /* egal */ } };
    await quiet('-N', CHAIN);
    try { await ipt('-C', 'FORWARD', '-j', CHAIN); } catch { await ipt('-I', 'FORWARD', '1', '-j', CHAIN); }
    await ipt('-F', CHAIN);
    await ipt('-A', CHAIN, '-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-j', 'ACCEPT');
    for (const p of db.peers) {
      const u = userOf(p.userId); if (!p.enabled || !u || !u.enabled) continue;
      const src = ['-s', p.ip + '/32'];
      for (const x of u.perms.extra) { const [a, pr, po] = x.split(':'); const d = a.includes('/') ? a : a + '/32'; await ipt('-A', CHAIN, ...src, '-d', d, ...(pr ? ['-p', pr, '--dport', po] : []), '-j', 'ACCEPT'); }
      if (!u.perms.lan && o.lan) await ipt('-A', CHAIN, ...src, '-d', o.lan.cidr, '-j', 'DROP');
      if (!u.perms.peers) await ipt('-A', CHAIN, ...src, '-d', o.sn.cidr, '-j', 'DROP');
      if (u.perms.internet) await ipt('-A', CHAIN, ...src, '-j', 'ACCEPT');
      else {
        if (u.perms.lan && o.lan) await ipt('-A', CHAIN, ...src, '-d', o.lan.cidr, '-j', 'ACCEPT');
        if (u.perms.peers) await ipt('-A', CHAIN, ...src, '-d', o.sn.cidr, '-j', 'ACCEPT');
        await ipt('-A', CHAIN, ...src, '-j', 'DROP');
      }
    }
    // Alles andere aus dem VPN-Netz wird verworfen
    await ipt('-A', CHAIN, '-s', o.sn.cidr, '-j', 'DROP');
    // NAT: Antworten aus dem Heimnetz/Internet müssen zum Server zurückfinden
    const nat = ['-t', 'nat'];
    await quiet(...nat, '-N', CHAIN + '_NAT');
    try { await ipt(...nat, '-C', 'POSTROUTING', '-j', CHAIN + '_NAT'); } catch { await ipt(...nat, '-I', 'POSTROUTING', '1', '-j', CHAIN + '_NAT'); }
    await ipt(...nat, '-F', CHAIN + '_NAT');
    await ipt(...nat, '-A', CHAIN + '_NAT', '-s', o.sn.cidr, '!', '-o', o.iface, '-j', 'MASQUERADE');
  }
  async function apply() {
    ensureDb(); const o = opts(); S.err = '';
    try {
      S.tools = { wg: await has('wg'), wgQuick: await has('wg-quick'), iptables: await has('iptables') };
      if (!dry && (!S.tools.wg || !S.tools['wgQuick'])) throw new Error('WireGuard ist nicht installiert (Linux: sudo apt install wireguard)');
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      const file = path.join(DIR, o.iface + '.conf');
      const conf = serverConf();
      fs.writeFileSync(file, conf, { mode: 0o600 }); try { fs.chmodSync(file, 0o600); } catch { /* egal */ }
      let up = false;
      try { await run('wg', ['show', o.iface]); up = true; } catch { /* nicht aktiv */ }
      if (up) {
        const strip = await run('wg-quick', ['strip', o.iface]);
        const tmp = path.join(DIR, '.' + o.iface + '.sync'); fs.writeFileSync(tmp, strip, { mode: 0o600 });
        try { await run('wg', ['syncconf', o.iface, tmp]); } finally { try { fs.unlinkSync(tmp); } catch { /* egal */ } }
      } else await run('wg-quick', ['up', o.iface]);
      try { await run('sysctl', ['-w', 'net.ipv4.ip_forward=1']); } catch (e) { lg('ip_forward: ' + e.message); }
      if (S.tools.iptables || dry) await firewall(o); else S.err = 'iptables fehlt – Rechte der Benutzer werden nicht durchgesetzt (sudo apt install iptables)';
      S.wanIf = await wanIf(o); S.applied = true; S.up = true;
      lg(`Schnittstelle ${o.iface} eingerichtet (${db.peers.filter((p) => p.enabled).length} Geräte)`);
    } catch (e) { S.err = String(e.message || e).slice(0, 300); S.applied = false; lg('Fehler: ' + S.err); }
    await poll(); push();
    return S.err ? { ok: false, error: S.err } : { ok: true };
  }
  async function teardown() {
    const o = opts();
    try { await run('wg-quick', ['down', o.iface]); } catch { /* war nicht aktiv */ }
    try { await run('iptables', ['-D', 'FORWARD', '-j', CHAIN]); } catch { /* egal */ }
    try { await run('iptables', ['-F', CHAIN]); await run('iptables', ['-X', CHAIN]); } catch { /* egal */ }
    try { await run('iptables', ['-t', 'nat', '-D', 'POSTROUTING', '-j', CHAIN + '_NAT']); await run('iptables', ['-t', 'nat', '-F', CHAIN + '_NAT']); await run('iptables', ['-t', 'nat', '-X', CHAIN + '_NAT']); } catch { /* egal */ }
    S.up = false; S.applied = false; push();
  }

  // ---------- Status ----------
  async function poll() {
    const o = opts(); S.live = {};
    try {
      const out = await run('wg', ['show', o.iface, 'dump']); S.up = true;
      for (const line of out.trim().split('\n').slice(1)) {
        const f = line.split('\t'); if (f.length < 8) continue;
        S.live[f[0]] = { endpoint: f[2] === '(none)' ? '' : f[2], hs: Number(f[4]) * 1000, rx: Number(f[5]), tx: Number(f[6]) };
      }
    } catch { S.up = false; }
    S.ts = Date.now();
    for (const p of db ? db.peers : []) {
      const l = S.live[p.pub]; const on = !!(l && l.hs && Date.now() - l.hs < 180000);
      try { api.devices.ensure({ key: 'peer:' + p.id, name: `VPN ${p.name}`, type: 'binary' }); api.devices.setState('peer:' + p.id, { on }); } catch { /* egal */ }
    }
  }
  let pt = null; const push = () => { clearTimeout(pt); pt = setTimeout(() => { try { api.emit({ model: model() }); } catch { /* egal */ } }, 300); };

  function model() {
    ensureDb(); const o = opts();
    return {
      iface: o.iface, port: o.port, subnet: o.sn.cidr, lan: o.lan ? o.lan.cidr : '', serverIp: o.serverIp, serverPub: db.server.pub, dns: o.dns,
      endpoints: endpoints(), up: S.up, applied: S.applied, err: S.err, tools: S.tools, wan: S.wanIf || '', ts: S.ts,
      users: db.users.map((u) => ({ ...u, peers: db.peers.filter((p) => p.userId === u.id).length })),
      peers: db.peers.map((p) => { const l = S.live[p.pub] || {}; return { id: p.id, userId: p.userId, name: p.name, ip: p.ip, enabled: p.enabled, endpoint: p.endpoint, created: p.created, online: !!(l.hs && Date.now() - l.hs < 180000), lastHandshake: l.hs || 0, from: l.endpoint || '', rx: l.rx || 0, tx: l.tx || 0 }; }),
    };
  }

  // ---------- Client-Konfiguration ----------
  function clientConf(p) {
    const o = opts(); const u = userOf(p.userId); if (!u) throw new Error('Benutzer fehlt');
    const eps = endpoints(); const ep = p.endpoint && eps.includes(p.endpoint) ? p.endpoint : eps[0];
    if (!ep) throw new Error('Kein Zugangspunkt: DuckDNS-Plugin einrichten oder in den WireGuard-Einstellungen eine Adresse eintragen');
    const L = ['[Interface]', `# ${u.name} – ${p.name}`, `PrivateKey = ${p.priv}`, `Address = ${p.ip}/32`];
    if (o.dns) L.push(`DNS = ${o.dns}`);
    L.push(`MTU = ${o.mtu}`, '', '[Peer]', `PublicKey = ${db.server.pub}`, `PresharedKey = ${p.psk}`, `Endpoint = ${ep}`, `AllowedIPs = ${destsFor(u).join(', ')}`, 'PersistentKeepalive = 25');
    return { filename: `${slug(u.name)}-${slug(p.name)}.conf`, content: L.join('\n') + '\n' };
  }

  // ---------- Routen ----------
  api.route('GET', 'model', () => model());
  api.route('POST', 'apply', async () => { const r = await apply(); return { ...r, model: model() }; });
  api.route('POST', 'stop', async () => { await teardown(); return model(); });
  api.route('POST', 'user', async ({ body }) => {
    ensureDb(); const b = body || {}; const name = cleanName(b.name); if (!name) throw new Error('Name fehlt');
    let u = b.id ? userOf(b.id) : null;
    if (b.id && !u) throw new Error('Benutzer nicht gefunden');
    if (db.users.some((x) => x.name.toLowerCase() === name.toLowerCase() && (!u || x.id !== u.id))) throw new Error('Diesen Benutzer gibt es schon');
    const perms = cleanPerms(b.perms);
    if (!u) { u = { id: crypto.randomBytes(4).toString('hex'), name, enabled: true, perms, note: cleanName(b.note, 120) }; db.users.push(u); }
    else { u.name = name; u.perms = perms; u.note = cleanName(b.note, 120); if (b.enabled !== undefined) u.enabled = !!b.enabled; }
    saveDb(); await apply(); return model();
  });
  api.route('DELETE', 'user/:id', async ({ params }) => {
    ensureDb(); if (!userOf(params.id)) throw new Error('Benutzer nicht gefunden');
    for (const p of db.peers.filter((x) => x.userId === params.id)) { try { api.devices.remove('peer:' + p.id); } catch { /* egal */ } }
    db.peers = db.peers.filter((p) => p.userId !== params.id); db.users = db.users.filter((u) => u.id !== params.id);
    saveDb(); await apply(); return model();
  });
  api.route('POST', 'peer', async ({ body }) => {
    ensureDb(); const b = body || {}; const u = userOf(b.userId); if (!u) throw new Error('Benutzer nicht gefunden');
    const name = cleanName(b.name); if (!name) throw new Error('Name des Geräts fehlt');
    if (db.peers.some((p) => p.userId === u.id && p.name.toLowerCase() === name.toLowerCase())) throw new Error('Dieses Gerät gibt es bei dem Benutzer schon');
    const k = genKey();
    const p = { id: crypto.randomBytes(4).toString('hex'), userId: u.id, name, ip: nextIp(), priv: k.priv, pub: k.pub, psk: genPsk(), enabled: true, endpoint: endpoints().includes(b.endpoint) ? b.endpoint : '', created: Date.now() };
    db.peers.push(p); saveDb(); await apply(); return { ...model(), created: p.id };
  });
  api.route('PUT', 'peer/:id', async ({ params, body }) => {
    ensureDb(); const p = peerOf(params.id); if (!p) throw new Error('Gerät nicht gefunden'); const b = body || {};
    if (b.name !== undefined) { const n = cleanName(b.name); if (!n) throw new Error('Name fehlt'); p.name = n; }
    if (b.enabled !== undefined) p.enabled = !!b.enabled;
    if (b.endpoint !== undefined) p.endpoint = endpoints().includes(b.endpoint) ? b.endpoint : '';
    if (b.rekey) { const k = genKey(); p.priv = k.priv; p.pub = k.pub; p.psk = genPsk(); }
    saveDb(); await apply(); return model();
  });
  api.route('DELETE', 'peer/:id', async ({ params }) => {
    ensureDb(); if (!peerOf(params.id)) throw new Error('Gerät nicht gefunden');
    try { api.devices.remove('peer:' + params.id); } catch { /* egal */ }
    db.peers = db.peers.filter((p) => p.id !== params.id); saveDb(); await apply(); return model();
  });
  api.route('GET', 'peer/:id/config', ({ params }) => { ensureDb(); const p = peerOf(params.id); if (!p) throw new Error('Gerät nicht gefunden'); return clientConf(p); });
  api.route('POST', 'poll', async () => { await poll(); return model(); });

  api.mcp.tool({
    name: 'wireguard_status', readOnly: true,
    description: 'WireGuard-VPN: Benutzer mit Rechten, Geräte (verbunden/offline, letzte Verbindung, Datenmenge) und Server-Zustand. Enthält keine Schlüssel.',
    inputSchema: { type: 'object', properties: {} },
    run: () => { const m = model(); return { up: m.up, port: m.port, subnet: m.subnet, endpoints: m.endpoints, users: m.users.map((u) => ({ name: u.name, enabled: u.enabled, perms: u.perms })), peers: m.peers.map((p) => ({ name: p.name, user: (m.users.find((u) => u.id === p.userId) || {}).name, ip: p.ip, enabled: p.enabled, online: p.online, lastHandshake: p.lastHandshake ? new Date(p.lastHandshake).toISOString() : null })) }; },
  });

  // ---------- Start ----------
  dry = process.env.WG_DRY === '1';
  ensureDb();
  api.after(() => { if (cfg().autostart !== false) apply(); else poll().then(push); }, 3000);
  timer = api.timer(() => poll().then(push), 20000);
  api.onConfig(() => { if (cfg().autostart !== false) apply(); else push(); });
  return { stop() { stopped = true; clearTimeout(pt); if (timer) timer(); } };
};
module.exports._test = { genKey, pubFromPriv, parseCidr, ip2n, n2ip };
