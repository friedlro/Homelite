'use strict';
// Erreichbarkeit: prüft per TCP, ob Geräte (HomeLite-Geräte mit IP, der Router oder eigene Adressen) antworten.
const net = require('net');
const fs = require('fs');

module.exports = (api) => {
  const status = new Map(); // key -> { name, target, up, ms, since, last }

  // Standard-Gateway (Router) aus /proc/net/route lesen
  function gateway() {
    try {
      for (const l of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
        const f = l.trim().split(/\s+/);
        if (f[1] === '00000000' && f[2] && f[2] !== '00000000') return f[2].match(/../g).reverse().map((h) => parseInt(h, 16)).join('.');
      }
    } catch { /* kein Linux */ }
    return '';
  }

  const keyOf = (name) => 'h:' + (name.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x');
  const parsePorts = (v) => String(v || '').split(/[\s,;]+/).map(Number).filter((p) => p >= 1 && p <= 65535).slice(0, 8);
  const stored = () => { const v = api.kv.get('targets'); return Array.isArray(v) ? v : []; };

  // Ziele: auf der Seite angelegte + (optional) Textliste aus den Einstellungen
  function targets() {
    const out = stored().map((t) => ({ ...t, key: keyOf(t.name) }));
    for (const l of String(api.config().hosts || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
      const i = l.indexOf('=');
      const name = i > 0 ? l.slice(0, i).trim() : l;
      const m = /^(.+):(\d{1,5})$/.exec(i > 0 ? l.slice(i + 1).trim() : l);
      if (m && !out.some((t) => t.name.toLowerCase() === name.toLowerCase())) out.push({ name, host: m[1], ports: [Number(m[2])], key: keyOf(name), text: true });
    }
    return out;
  }

  function probe(host, port, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const s = net.connect({ host, port });
      const done = (ok) => { s.destroy(); resolve(ok ? Date.now() - t0 : -1); };
      s.setTimeout(timeoutMs, () => done(false));
      s.once('connect', () => done(true));
      // „Verbindung abgelehnt“ heißt: das Gerät ist da, nur der Port ist zu
      s.once('error', (e) => done(e && e.code === 'ECONNREFUSED'));
    });
  }

  async function probeAny(host, ports, timeoutMs) {
    for (const p of ports) { const ms = await probe(host, p, timeoutMs); if (ms >= 0) return { ms, port: p }; }
    return { ms: -1 };
  }

  async function check() {
    const cfg = api.config();
    const list = targets();
    const wanted = new Set(list.map((x) => x.key));
    for (const key of [...status.keys()]) if (!wanted.has(key)) { api.devices.remove(key); status.delete(key); }
    await Promise.all(list.map(async (h) => { try {
      const r = await probeAny(h.host, h.ports && h.ports.length ? h.ports : [80], (Number(cfg.timeout) || 2) * 1000);
      const up = r.ms >= 0;
      api.devices.ensure({ key: h.key, name: `${h.name} erreichbar`, type: 'binary', room: cfg.room || '' });
      api.devices.setState(h.key, { on: up });
      const old = status.get(h.key);
      const e = { key: h.key, name: h.name, target: `${h.host}:${(h.ports || [80]).join(',')}`, up, ms: up ? r.ms : null, since: old && old.up === up ? old.since : Date.now(), last: Date.now(), text: !!h.text };
      status.set(h.key, e);
      if (!old || old.up !== up) api.log('info', `${h.name} ist ${up ? 'erreichbar' : 'NICHT erreichbar'}`);
    } catch (e) { api.log('warn', `${h.name}: ${e.message}`); } }));
    api.emit({ status: [...status.values()] });
  }

  // Auswahl für das Dropdown: Router, HomeLite-Geräte mit IP-Adresse
  function candidates() {
    const seen = new Set();
    const out = [];
    const gw = gateway();
    if (gw) { out.push({ id: 'router', label: `Router (${gw})`, name: 'Router', host: gw, ports: [80, 443] }); seen.add(gw); }
    const byIp = new Map();
    for (const d of api.devices.all()) {
      if (!d.ip || d.plugin === api.id) continue;
      if (!byIp.has(d.ip)) byIp.set(d.ip, d);
    }
    for (const [ip, d] of [...byIp].sort((a, b) => String(a[1].name).localeCompare(String(b[1].name), 'de', { numeric: true }))) {
      if (seen.has(ip)) continue;
      out.push({ id: 'dev:' + d.id, label: `${d.name} (${ip})`, name: d.name, host: ip, ports: [80] });
    }
    return out;
  }

  const view = () => ({ status: [...status.values()], candidates: candidates() });

  api.route('GET', 'status', () => view());
  api.route('POST', 'check', async () => { await check(); return { ok: true, ...view() }; });
  // Ziel anlegen/ändern: { name, host, ports, original? }
  api.route('POST', 'targets', async ({ body }) => {
    const b = body || {};
    const name = String(b.name || '').trim();
    const host = String(b.host || '').trim();
    const ports = parsePorts(b.ports);
    if (!/^[\w äöüÄÖÜß.()-]{1,40}$/.test(name)) throw new Error('Name: 1–40 Zeichen');
    if (!/^[\w.:-]{1,253}$/.test(host) || host.startsWith('-')) throw new Error('Adresse ungültig');
    if (!ports.length) throw new Error('Mindestens ein Port (z. B. 80 oder 80,443)');
    const l = stored().filter((t) => t.name.toLowerCase() !== String(b.original || '').toLowerCase());
    if (l.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new Error('Name existiert schon');
    l.push({ name, host, ports });
    api.kv.set('targets', l);
    await check();
    return { ok: true, ...view() };
  });
  api.route('DELETE', 'targets/:name', async ({ params }) => {
    api.kv.set('targets', stored().filter((t) => t.name.toLowerCase() !== params.name.toLowerCase()));
    await check();
    return { ok: true, ...view() };
  });
  api.onConfig(() => { check(); });

  check();
  let stopTimer = api.timer(check, Math.max(10, Number(api.config().interval) || 60) * 1000);
  api.onConfig((cfg) => { stopTimer(); stopTimer = api.timer(check, Math.max(10, Number(cfg.interval) || 60) * 1000); });

  return { stop() { /* Zeitgeber und Routen räumt HomeLite selbst auf */ } };
};
