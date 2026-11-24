'use strict';
// Shelly TopAC Portable EV Charger (EVE01, Gen3-XT1-Dienst) – lokale HTTP-RPC-Schnittstelle.
// Komponenten (Rollen): start_charging (boolean, schreibbar), current_limit (number, 6–16 A, schreibbar),
// work_state (enum), phase_info (object), energy_charge / time_charge (number).
module.exports = (api) => {
  const STATES = {
    charger_free: 'Frei', charger_insert: 'Fahrzeug eingesteckt', charger_free_fault: 'Frei (Fehler)', charger_wait: 'Wartet',
    charger_charging: 'Lädt', charger_pause: 'Pausiert', charger_end: 'Beendet', charger_fault: 'Fehler',
  };
  const PLUGGED = new Set(['charger_insert', 'charger_wait', 'charger_charging', 'charger_pause', 'charger_end']);
  const DEF = { start_charging: ['boolean', 200], current_limit: ['number', 200], energy_charge: ['number', 201], time_charge: ['number', 202], work_state: ['enum', 200], phase_info: ['object', 200] };
  let ids = { ...DEF };
  let minA = 6, maxA = 16;
  let st = { ok: false, error: '', host: '', last: 0, info: null, state: '', charging: false, limit: null, power: null, current: null, volt: [], phase: [], total: null, session: null, duration: null };
  let busy = false, mapped = false;

  const host = () => String(api.config().host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  async function rpc(method, params) {
    const h = host();
    if (!h) throw new Error('IP-Adresse der Wallbox in den Plugin-Einstellungen eintragen');
    const q = Object.entries(params || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? encodeURIComponent(JSON.stringify(v)) : encodeURIComponent(String(v))}`).join('&');
    const headers = {}; const pw = api.config().password;
    if (pw) headers.Authorization = 'Basic ' + Buffer.from('admin:' + pw).toString('base64');
    const r = await fetch(`http://${h}/rpc/${method}${q ? '?' + q : ''}`, { headers, signal: AbortSignal.timeout(6000) });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}${txt ? ': ' + txt.slice(0, 120) : ''}`);
    try { return JSON.parse(txt); } catch { return txt; }
  }
  const stat = (role) => rpc(`${ids[role][0][0].toUpperCase() + ids[role][0].slice(1)}.GetStatus`, { id: ids[role][1] });
  const set = (role, value) => rpc(`${DEF[role][0][0].toUpperCase() + DEF[role][0].slice(1)}.Set`, { owner: 'service:0', role, value });

  // Rollen → Komponenten-Nummern (falls eine Firmware andere IDs nutzt)
  async function mapComponents() {
    let off = 0; const found = {};
    for (let i = 0; i < 6; i++) {
      const r = await rpc('Shelly.GetComponents', { offset: off });
      for (const c of r.components || []) {
        const role = c.attrs && c.attrs.role; const m = /^(boolean|number|enum|object):(\d+)$/.exec(c.key || '');
        if (role && m && DEF[role]) found[role] = [m[1], Number(m[2])];
        if (role === 'current_limit' && c.config) { if (c.config.min > 0) minA = c.config.min; if (c.config.max > minA) maxA = c.config.max; }
      }
      off += (r.components || []).length;
      if (!r.components || !r.components.length || off >= (r.total || 0)) break;
    }
    ids = { ...DEF, ...found }; mapped = true;
  }

  async function poll() {
    if (busy) return; busy = true;
    try {
      if (!mapped) { try { await mapComponents(); } catch (e) { if (/HTTP 4|IP-Adresse/.test(e.message)) throw e; } }
      if (!st.info) { try { const i = await rpc('Shelly.GetDeviceInfo'); st.info = { name: i.name, model: i.model, fw: i.ver, mac: i.mac }; } catch { /* optional */ } }
      const [sw, work, lim, pi, en, tm] = await Promise.all(['start_charging', 'work_state', 'current_limit', 'phase_info', 'energy_charge', 'time_charge'].map((r) => stat(r).catch(() => null)));
      if (!work && !pi) throw new Error('Keine Antwort von der Wallbox (Adresse prüfen)');
      const v = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : null);
      const p = v(pi) || {};
      const ph = ['phase_a', 'phase_b', 'phase_c'].map((k) => p[k] || {});
      const calc = ph.reduce((a, x) => a + (Number(x.voltage) || 0) * (Number(x.current) || 0), 0);
      let power = Number(p.total_power);
      if (!isFinite(power)) power = calc;
      if (power > 0 && calc > 0 && Math.abs(power * 1000 - calc) < Math.abs(power - calc)) power *= 1000; // Gerät meldet kW
      st = { ...st, ok: true, error: '', host: host(), last: Date.now(), state: String(v(work) || ''), charging: v(sw) === true, limit: v(lim), power: Math.round(power), current: p.total_current != null ? Math.round(Number(p.total_current) * 10) / 10 : null, volt: ph.map((x) => x.voltage ?? null), phase: ph, total: p.total_act_energy != null ? Math.round(Number(p.total_act_energy) * 100) / 100 : null, session: v(en), duration: v(tm) };
      publish();
    } catch (e) {
      const msg = (e.cause && e.cause.code) || e.message;
      if (st.error !== msg) api.log('warn', 'Wallbox: ' + msg);
      st = { ...st, ok: false, error: msg, last: Date.now() };
      try { for (const k of ['wb', 'powerW', 'stateText', 'plugged', 'currentA', 'totalKwh', 'sessionKwh']) api.devices.setState(k, { online: false }); } catch { /* noch nicht angelegt */ }
      api.emit({ model: snap() });
    } finally { busy = false; }
  }

  function ensure() {
    api.devices.ensure({ key: 'wb', name: 'EV-Charger', type: 'light', caps: ['brightness'] });
    api.devices.ensure({ key: 'powerW', name: 'EV-Charger Leistung', type: 'sensor', unit: 'W' });
    api.devices.ensure({ key: 'currentA', name: 'EV-Charger Strom', type: 'sensor', unit: 'A' });
    api.devices.ensure({ key: 'stateText', name: 'EV-Charger Zustand', type: 'sensor' });
    api.devices.ensure({ key: 'plugged', name: 'EV-Charger Fahrzeug verbunden', type: 'binary' });
    api.devices.ensure({ key: 'sessionKwh', name: 'EV-Charger Sitzung', type: 'sensor', unit: 'kWh' });
    api.devices.ensure({ key: 'totalKwh', name: 'EV-Charger Zählerstand', type: 'sensor', unit: 'kWh' });
  }
  const pct = (a) => (a == null ? 0 : Math.max(0, Math.min(100, Math.round((a / maxA) * 100))));
  function publish() {
    ensure();
    const S = api.devices.setState;
    S('wb', { on: st.charging, brightness: pct(st.limit) });
    S('powerW', { value: st.power });
    if (st.current != null) S('currentA', { value: st.current });
    S('stateText', { value: STATES[st.state] || st.state });
    S('plugged', { on: PLUGGED.has(st.state) });
    if (st.session != null) S('sessionKwh', { value: Math.round(Number(st.session) * 100) / 100 });
    if (st.total != null) S('totalKwh', { value: st.total });
    api.emit({ model: snap() });
  }
  const snap = () => ({ ...st, stateText: STATES[st.state] || st.state, plugged: PLUGGED.has(st.state), minA, maxA, config: { host: host() } });

  api.devices.onCommand(async (dev, action, value) => {
    if (dev.key !== 'wb') throw new Error('Nur der EV-Charger selbst ist steuerbar');
    if (action === 'toggle') action = st.charging ? 'off' : 'on';
    if (action === 'on' || action === 'off') {
      await set('start_charging', action === 'on');
      st.charging = action === 'on'; setTimeout(poll, 1500);
      return { on: st.charging };
    }
    if (action === 'brightness') {
      const a = Math.max(minA, Math.min(maxA, Math.round((Number(value) / 100) * maxA)));
      await set('current_limit', a);
      st.limit = a; setTimeout(poll, 1500);
      return { on: st.charging, brightness: pct(a) };
    }
    throw new Error('Aktion nicht unterstützt: ' + action);
  });

  api.route('GET', 'model', () => snap());
  api.route('POST', 'charge', async ({ body }) => { await set('start_charging', !!body.on); st.charging = !!body.on; await poll(); return snap(); });
  api.route('POST', 'limit', async ({ body }) => {
    const a = Math.round(Number(body.amps));
    if (!(a >= minA && a <= maxA)) throw new Error(`Ladestrom zwischen ${minA} und ${maxA} A wählen`);
    await set('current_limit', a); await poll(); return snap();
  });
  api.route('POST', 'refresh', async () => { mapped = false; st.info = null; await poll(); return snap(); });

  api.onConfig(() => { mapped = false; st.info = null; poll(); });
  ensure();
  poll();
  api.timer(poll, Math.max(2, Number(api.config().interval) || 5) * 1000);
};
