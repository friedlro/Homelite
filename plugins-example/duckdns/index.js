'use strict';
// DuckDNS-Client: sendet regelmäßig ein Update und meldet das Ergebnis als Geräte und Live-Status.
module.exports = (api) => {
  let st = { ok: null, ip: '', ip6: '', result: '', error: '', last: 0, changed: 0, count: 0 };
  let busy = false;

  const domains = (cfg) => String(cfg.domains || '').split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/\.duckdns\.org$/, '')).filter((d) => /^[a-z0-9-]{1,63}$/.test(d));

  async function update() {
    if (busy) return;
    busy = true;
    const cfg = api.config();
    const list = domains(cfg);
    try {
      if (!list.length || !cfg.token) throw new Error('Domain und Token in den Plugin-Einstellungen eintragen');
      const u = new URL(cfg.endpoint || 'https://www.duckdns.org/update');
      u.searchParams.set('domains', list.join(','));
      u.searchParams.set('token', String(cfg.token));
      u.searchParams.set('ip', String(cfg.ip || '').trim());
      if (cfg.ipv6) u.searchParams.set('ipv6', '');
      u.searchParams.set('verbose', 'true');
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      const lines = (await r.text()).trim().split(/\r?\n/).map((x) => x.trim());
      if (!r.ok || lines[0] !== 'OK') throw new Error(lines[0] === 'KO' ? 'DuckDNS lehnt ab (Token oder Domain falsch)' : `Unerwartete Antwort (HTTP ${r.status})`);
      const ip = lines[1] || '';
      const ip6 = lines[2] || '';
      const res = lines[3] || '';
      const old = st.ip;
      st = { ok: true, ip, ip6, result: res, error: '', last: Date.now(), changed: st.changed, count: st.count + 1 };
      if (res === 'UPDATED' || (old && old !== ip)) {
        st.changed = Date.now();
        api.log('info', `IP aktualisiert: ${ip}${ip6 ? ' / ' + ip6 : ''}`);
        if (old && old !== ip) {
          if (cfg.notify) api.notify(`DuckDNS: neue öffentliche IP ${ip} (vorher ${old})`);
          api.fire('duckdns-ip-geaendert');
        }
      }
    } catch (e) {
      const msg = (e.cause && e.cause.code) || e.message;
      if (st.error !== msg) api.log('warn', 'Update fehlgeschlagen: ' + msg);
      st = { ...st, ok: false, error: msg, last: Date.now() };
    } finally { busy = false; }
    publish();
  }

  function publish() {
    api.devices.ensure({ key: 'ok', name: 'DuckDNS aktuell', type: 'binary' });
    api.devices.setState('ok', { on: st.ok === true });
    api.devices.ensure({ key: 'ip', name: 'DuckDNS öffentliche IP', type: 'sensor' });
    if (st.ip) api.devices.setState('ip', { value: st.ip });
    api.emit({ status: snap() });
  }
  const snap = () => ({ ...st, domains: domains(api.config()).map((d) => d + '.duckdns.org') });

  api.route('GET', 'status', () => ({ status: snap() }));
  api.route('POST', 'update', async () => { await update(); return { ok: st.ok === true, status: snap() }; });

  update();
  let stop = api.timer(update, Math.max(1, Number(api.config().interval) || 5) * 60000);
  api.onConfig((cfg) => { stop(); stop = api.timer(update, Math.max(1, Number(cfg.interval) || 5) * 60000); update(); });
  return {};
};
