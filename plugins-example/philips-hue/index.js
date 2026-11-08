'use strict';
// Philips Hue (Bridge, lokale API v1 über HTTP). Koppeln per Link-Taste; Zustände werden regelmäßig abgefragt.
module.exports = (api) => {
  const st = { paired: false, bridge: '', name: '', online: null, error: '', last: 0, counts: { lights: 0, sensors: 0, groups: 0 } };
  let data = null; // letzte Antwort der Bridge
  const prevBtn = new Map(); // Sensor-ID -> lastupdated (Dimmer-Tasten)
  let first = true;
  let busy = false;

  const bridge = () => String(api.kv.get('bridge') || '').trim();
  const user = () => String(api.kv.get('user') || '');
  const cfg = () => api.config();

  async function call(method, p, body, ip) {
    const host = ip || bridge();
    if (!host) throw new Error('Keine Bridge-Adresse eingetragen');
    const r = await fetch(`http://${host}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const err = Array.isArray(j) ? j.find((x) => x.error) : null;
    if (err) { const e = new Error(err.error.description || 'Fehler'); e.hue = err.error.type; throw e; }
    return j;
  }
  const put = (p, body) => call('PUT', `/api/${user()}${p}`, body);

  const pct = (bri) => Math.round(Math.min(254, Math.max(0, bri)) / 254 * 100);
  const isPlug = (l) => /plug|on\/off/i.test(String(l.type || '')) && !('bri' in (l.state || {}));

  function publish(key, spec, state) {
    api.devices.ensure({ ...spec, key, room: cfg().room || '' });
    api.devices.setState(key, state);
  }

  async function poll() {
    if (busy || !user() || !bridge()) return;
    busy = true;
    try {
      const d = await call('GET', `/api/${user()}`);
      if (d.config === undefined) throw Object.assign(new Error('Zugriff verweigert – bitte neu koppeln'), { hue: 1 });
      data = d;
      st.online = true; st.error = ''; st.name = (d.config && d.config.name) || ''; st.last = Date.now();
      const seen = new Set();
      for (const [id, l] of Object.entries(d.lights || {})) {
        const key = 'l:' + id; seen.add(key);
        const s = l.state || {};
        const plug = isPlug(l);
        publish(key, { name: l.name, type: plug ? 'switch' : 'light' }, { on: !!s.on, ...(plug || s.bri === undefined ? {} : { brightness: s.on ? pct(s.bri) : 0 }), online: s.reachable !== false });
      }
      st.counts.lights = (Object.keys(d.lights || {})).length;
      if (cfg().groups) {
        for (const [id, g] of Object.entries(d.groups || {})) {
          if (!['Room', 'Zone', 'LightGroup'].includes(g.type)) continue;
          const key = 'g:' + id; seen.add(key);
          const a = g.action || {};
          publish(key, { name: `Gruppe ${g.name}`, type: 'light' }, { on: !!(g.state && g.state.any_on), ...(a.bri === undefined ? {} : { brightness: g.state && g.state.any_on ? pct(a.bri) : 0 }) });
        }
      }
      st.counts.groups = Object.keys(d.groups || {}).length;
      if (cfg().sensors !== false) {
        let n = 0;
        for (const [id, s] of Object.entries(d.sensors || {})) {
          const key = 's:' + id; const v = s.state || {};
          const online = !(s.config && s.config.reachable === false);
          if (s.type === 'ZLLPresence') { seen.add(key); n++; publish(key, { name: s.name, type: 'binary' }, { on: !!v.presence, online }); }
          else if (s.type === 'ZLLTemperature') { seen.add(key); n++; publish(key, { name: s.name, type: 'sensor', unit: '°C' }, { value: Math.round(v.temperature) / 100, online }); }
          else if (s.type === 'ZLLLightLevel') { seen.add(key); n++; publish(key, { name: s.name, type: 'sensor', unit: 'lx' }, { value: Math.round(10 ** ((Number(v.lightlevel) - 1) / 10000)), online }); }
          else if (s.type === 'ZLLSwitch' || s.type === 'ZGPSwitch') {
            seen.add(key); n++;
            api.devices.ensure({ key, name: s.name, type: 'event', room: cfg().room || '' });
            const old = prevBtn.get(id);
            if (v.lastupdated !== old) {
              prevBtn.set(id, v.lastupdated);
              if (!first && old !== undefined && v.buttonevent !== undefined) api.devices.setState(key, { value: String(v.buttonevent), online });
              else api.devices.setState(key, { online });
            }
          }
        }
        st.counts.sensors = n;
      }
      // Geräte entfernen, die es auf der Bridge nicht mehr gibt
      for (const dv of api.devices.list()) if (!seen.has(dv.key)) api.devices.remove(dv.key);
      first = false;
    } catch (e) {
      st.online = false;
      st.error = e.hue === 1 ? 'Zugriff verweigert – bitte neu koppeln' : ((e.cause && e.cause.code) || e.message);
      if (e.hue === 1) { /* Benutzer ungültig */ }
    } finally { busy = false; }
    api.emit({ status: snapshot() });
  }

  const snapshot = () => ({ ...st, paired: !!user(), bridge: bridge() });
  const scenes = () => Object.entries((data && data.scenes) || {}).map(([id, s]) => ({
    id, name: s.name, group: s.group || '0',
    groupName: s.group && data.groups && data.groups[s.group] ? data.groups[s.group].name : 'Alle Lampen',
  })).filter((s) => !/^[0-9a-f-]{20,}$/i.test(s.name)).sort((a, b) => a.groupName.localeCompare(b.groupName, 'de') || a.name.localeCompare(b.name, 'de', { numeric: true }));

  api.devices.onCommand(async (dev, action, value) => {
    const [kind, id] = String(dev.key).split(':');
    const path = kind === 'g' ? `/groups/${id}/action` : kind === 'l' ? `/lights/${id}/state` : null;
    if (!path) throw new Error('Dieses Gerät ist nicht steuerbar');
    let body;
    if (action === 'on') body = { on: true };
    else if (action === 'off') body = { on: false };
    else if (action === 'toggle') body = { on: !(dev.state_raw && dev.state_raw.on) };
    else if (action === 'brightness') { const v = Math.max(0, Math.min(100, Number(value))); body = v <= 0 ? { on: false } : { on: true, bri: Math.max(1, Math.round(v / 100 * 254)) }; }
    else throw new Error(`Aktion „${action}“ wird nicht unterstützt`);
    await put(path, body);
    api.after(poll, 700);
  });

  // ---------- Seite ----------
  api.route('GET', 'status', () => ({ status: snapshot(), scenes: scenes() }));
  api.route('POST', 'bridge', async ({ body }) => {
    const ip = String((body || {}).ip || '').trim();
    if (!/^[\w.:-]{1,253}$/.test(ip) || ip.startsWith('-')) throw new Error('Adresse ungültig');
    try { const j = await call('GET', '/api/config', null, ip); if (!j || !j.bridgeid) throw new Error('x'); } catch { throw new Error(`Unter ${ip} antwortet keine Hue-Bridge`); }
    if (ip !== bridge()) { api.kv.set('user', ''); api.kv.set('bridge', ip); }
    st.paired = false;
    return { status: snapshot() };
  });
  api.route('GET', 'discover', async () => {
    const r = await fetch('https://discovery.meethue.com', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('Suche bei Philips nicht erreichbar (HTTP ' + r.status + ')');
    return { bridges: (await r.json()).map((b) => ({ id: b.id, ip: b.internalipaddress })) };
  });
  api.route('POST', 'pair', async () => {
    if (!bridge()) throw new Error('Zuerst die Adresse der Bridge eintragen');
    try {
      const j = await call('POST', '/api', { devicetype: 'homelite#server' });
      const ok = j.find((x) => x.success);
      if (!ok) throw new Error('Unerwartete Antwort der Bridge');
      api.kv.set('user', ok.success.username);
    } catch (e) {
      if (e.hue === 101) throw new Error('Link-Taste an der Bridge noch nicht gedrückt – Taste drücken und innerhalb von 30 s erneut „Koppeln“ wählen');
      throw e;
    }
    first = true;
    api.log('info', 'Mit der Hue-Bridge gekoppelt');
    await poll();
    return { status: snapshot(), scenes: scenes() };
  });
  api.route('DELETE', 'pair', () => { api.kv.set('user', ''); data = null; st.online = null; st.error = ''; return { status: snapshot(), scenes: [] }; });
  api.route('POST', 'scene/:id', async ({ params }) => {
    const s = scenes().find((x) => x.id === params.id);
    if (!s) throw new Error('Szene nicht gefunden');
    await put(`/groups/${s.group}/action`, { scene: s.id });
    api.after(poll, 800);
    return { ok: true };
  });
  api.route('POST', 'refresh', async () => { await poll(); return { status: snapshot(), scenes: scenes() }; });

  const iv = () => Math.max(2, Number(cfg().interval) || 4) * 1000;
  let stop = api.timer(poll, iv());
  api.onConfig(() => { stop(); stop = api.timer(poll, iv()); first = true; poll(); });
  poll();
  return {};
};
