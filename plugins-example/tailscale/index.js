'use strict';
// Tailscale: Status, Tailnet-Geräte, Serve-/Funnel-Prüfung (nur lesend – das Plugin ändert nichts an Tailscale).
const { execFile } = require('child_process');

module.exports = (api) => {
  const cfg = () => api.config();
  let model = { ok: false, error: 'Noch keine Abfrage', self: null, peers: [], serve: null, health: [], ts: 0 };
  let timer = null, lastFunnel = null, offline = new Set(), first = true;

  const run = (args) => new Promise((resolve, reject) => {
    execFile(String(cfg().bin || 'tailscale'), args, { timeout: 15000, maxBuffer: 8e6 }, (e, so, se) => {
      if (e) {
        const msg = e.code === 'ENOENT' ? 'tailscale ist nicht installiert (https://tailscale.com/download) oder der Pfad stimmt nicht'
          : /access denied|permission|operator/i.test(String(se)) ? 'Zugriff verweigert – HomeLite braucht Rechte auf Tailscale (als root laufen oder: sudo tailscale set --operator=<benutzer>)'
          : (String(se || e.message).trim().slice(0, 200) || 'Fehler');
        return reject(new Error(msg));
      }
      resolve(String(so));
    });
  });
  const ago = (iso) => { const t = Date.parse(iso); return t && t > 0 && t > Date.parse('2000-01-01') ? t : 0; };
  const norm = (n) => String(n || '').trim().toLowerCase();

  function peerView(p, isSelf) {
    return {
      name: p.HostName || (p.DNSName || '').split('.')[0], dns: String(p.DNSName || '').replace(/\.$/, ''), ips: (p.TailscaleIPs || []).slice(0, 2), os: p.OS || '',
      online: !!p.Online, lastSeen: ago(p.LastSeen), exitNode: !!p.ExitNode, exitOption: !!p.ExitNodeOption, tags: p.Tags || [],
      path: isSelf ? '' : (p.CurAddr ? 'direkt' : (p.Relay ? `Relay ${p.Relay}` : '')), rx: p.RxBytes || 0, tx: p.TxBytes || 0, self: !!isSelf,
    };
  }

  // Serve/Funnel aus „tailscale serve status --json“: AllowFunnel{host:port:true}, Web{host:port:{Handlers{pfad:…}}}
  function serveView(j) {
    const out = { active: false, funnel: [], serve: [] };
    if (!j || typeof j !== 'object') return out;
    const web = j.Web || {}, allow = j.AllowFunnel || {};
    for (const [hp, w] of Object.entries(web)) {
      const paths = Object.entries((w && w.Handlers) || {}).map(([p, h]) => ({ path: p, target: h.Proxy || h.Path || h.Text || (h.Redirect ? 'Weiterleitung' : '') }));
      (allow[hp] ? out.funnel : out.serve).push({ host: hp, paths });
    }
    for (const [hp, v] of Object.entries(allow)) if (v && !web[hp]) out.funnel.push({ host: hp, paths: [] });
    out.active = !!(out.funnel.length || out.serve.length);
    return out;
  }
  const funnelKey = (s) => JSON.stringify((s.funnel || []).map((f) => [f.host, f.paths.map((p) => p.path).sort()]).sort());

  async function refresh() {
    try {
      const j = JSON.parse(await run(['status', '--json']));
      let serve = null;
      try { serve = serveView(JSON.parse(await run(['serve', 'status', '--json']))); } catch (e) { serve = { active: false, funnel: [], serve: [], error: e.message }; }
      const peers = Object.values(j.Peer || {}).map((p) => peerView(p, false)).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
      model = {
        ok: true, error: '', ts: Date.now(), state: j.BackendState || '', version: j.Version || '', tailnet: (j.CurrentTailnet && j.CurrentTailnet.Name) || '',
        suffix: (j.MagicDNSSuffix || (j.CurrentTailnet && j.CurrentTailnet.MagicDNSSuffix) || ''), self: j.Self ? peerView(j.Self, true) : null, peers, serve,
        health: (j.Health || []).map(String).slice(0, 10),
      };
      sensors(); warnings();
    } catch (e) { model = { ...model, ok: false, error: e.message, ts: Date.now() }; }
    api.emit({ model });
  }

  function watched() {
    const w = String(cfg().watch || '').split(',').map(norm).filter(Boolean);
    if (w.includes('*')) return model.peers.map((p) => norm(p.name));
    return w;
  }
  function sensors() {
    for (const n of watched()) {
      const p = model.peers.find((x) => norm(x.name) === n); if (!p) continue;
      try {
        api.devices.ensure({ key: 'peer:' + n, name: `Tailscale ${p.name}`, type: 'binary' });
        api.devices.setState('peer:' + n, { on: p.online, online: true });
      } catch (e) { api.log('warn', `Sensor ${n}: ${e.message}`); }
    }
  }
  function warnings() {
    const s = model.serve || {};
    const key = funnelKey(s);
    if (lastFunnel !== null && key !== lastFunnel && cfg().notifyFunnel !== false && s.funnel && s.funnel.length) {
      const list = s.funnel.map((f) => `${f.host}: ${f.paths.map((p) => p.path).join(', ') || '–'}`).join('; ');
      api.log('warn', 'Funnel aktiv – aus dem Internet erreichbar: ' + list);
      Promise.resolve(api.notify('Tailscale Funnel aktiv', `Aus dem Internet erreichbar: ${list}`)).catch(() => {});
    }
    lastFunnel = key;
    if (cfg().notifyOffline) {
      const now = new Set(watched().filter((n) => { const p = model.peers.find((x) => norm(x.name) === n); return p && !p.online; }));
      if (!first) for (const n of now) if (!offline.has(n)) Promise.resolve(api.notify('Tailscale', `${n} ist offline`)).catch(() => {});
      offline = now;
    }
    first = false;
  }

  function start() {
    if (timer) { timer(); timer = null; }
    lastFunnel = null; first = true;
    refresh();
    timer = api.timer(refresh, Math.max(10, Math.min(600, Number(cfg().interval) || 30)) * 1000);
  }

  api.route('GET', 'model', () => model);
  api.route('POST', 'refresh', async () => { await refresh(); return model; });
  api.mcp.tool({ name: 'tailscale_status', description: 'Tailscale: Status dieses Rechners, Geräte im Tailnet (online/offline) und ob Funnel (Internet-Freigabe) aktiv ist.', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => model });
  api.onConfig(start);
  start();
  return { stop() { if (timer) timer(); } };
};
