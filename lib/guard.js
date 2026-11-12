'use strict';
// Schutz vor Zugriffen von außen (Internet, z. B. über Tailscale Funnel, Cloudflare Tunnel, Portfreigabe).
// Anfragen aus privaten Netzen (LAN, Tailnet, lokal) bleiben unberührt. Von außen sind – solange „lockExternal“ gilt –
// nur Pfade erreichbar, die ohnehin per geheimem Schlüssel geschützt sind (KI-Zugriff, Webhooks, Geofence-Hook, Handy-Seite).
const PATHS = [
  /^\/mcp(\/|$)/, /^\/mcp-plugin\//, /^\/hook(\/|$)/, /^\/trigger$/,
  /^\/where\.(html|js|css)$/,
];

function v4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return m ? m.slice(1).map(Number) : null;
}
// Privat = LAN, Loopback, Link-Local, Tailscale (CGNAT 100.64/10), IPv6-ULA
function isPrivate(ip) {
  ip = String(ip || '').trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '').replace(/%.*$/, '');
  const a = v4(ip);
  if (a) {
    if (a.some((x) => x > 255)) return false;
    return a[0] === 10 || a[0] === 127 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168) || (a[0] === 169 && a[1] === 254) || (a[0] === 100 && a[1] >= 64 && a[1] <= 127) || ip === '0.0.0.0';
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || /^f[cd][0-9a-f]{2}:/.test(l) || /^fe[89ab][0-9a-f]:/.test(l);
}

module.exports = function createGuard({ cfg, clientIp }) {
  const hits = new Map(); // IP -> { n, t }
  let blocked = 0, lastBlocked = null;
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 60000) hits.delete(k); }, 60000).unref();

  const sec = () => Object.assign({ lockExternal: true, allowFunnel: true, extraPaths: [] }, cfg().security || {});
  const isLoop = (ra) => /^(::1|127\.|::ffff:127\.)/.test(ra || '');

  function classify(req) {
    const ip = clientIp(req);
    const viaProxyFunnel = isLoop(req.socket.remoteAddress) && /^\?1$|^true$/i.test(String(req.headers['tailscale-funnel-request'] || ''));
    // Tailscale Funnel: vom eigenen tailscaled (lokal) weitergereicht; mit „allowFunnel“ gilt das als vertrauenswürdiger Zugang
    const funnel = viaProxyFunnel;
    const external = funnel ? sec().allowFunnel === false : !isPrivate(ip);
    return { ip, external, funnel };
  }
  function allowedPath(p) {
    if (PATHS.some((r) => r.test(p))) return true;
    return (sec().extraPaths || []).some((x) => typeof x === 'string' && x.startsWith('/') && (p === x || (x.endsWith('/') && p.startsWith(x))));
  }
  // Rate-Limit nur für externe Anfragen: 120 pro Minute und Adresse
  function rateExceeded(ip) {
    const now = Date.now(); const h = hits.get(ip) || { n: 0, t: now };
    if (now - h.t > 60000) { h.n = 0; h.t = now; }
    h.n++; hits.set(ip, h);
    return h.n > 120;
  }
  function noteBlocked(ip, p) { blocked++; lastBlocked = { ip, path: String(p).slice(0, 80), ts: Date.now() }; }
  const status = () => ({ lockExternal: sec().lockExternal !== false && process.env.HOMELITE_ALLOW_EXTERNAL !== '1', allowFunnel: sec().allowFunnel !== false, envOverride: process.env.HOMELITE_ALLOW_EXTERNAL === '1', extraPaths: sec().extraPaths || [], blocked, lastBlocked });
  const locked = () => status().lockExternal;
  return { classify, allowedPath, rateExceeded, noteBlocked, status, locked, isPrivate };
};
module.exports.isPrivate = isPrivate;
