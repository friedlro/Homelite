'use strict';
// Müllkalender über die CITIES-App (citiesapps.com), nach dem Vorbild der Quelle „citiesapps_com“ aus
// mampfes/hacs_waste_collection_schedule. Anmeldung mit dem Konto der CITIES-App (Gastzugang gibt es nicht mehr).
module.exports = (api) => {
  const cfg = () => api.config();
  const V2 = () => String(cfg().apiV2 || 'https://api.v2.citiesapps.com').replace(/\/+$/, '');
  const V1 = () => String(cfg().apiV1 || 'https://api.citiesapps.com').replace(/\/+$/, '');
  const HEAD = { 'user-agent': 'cities/100.100.100/Android', 'requesting-app': 'user-android' };

  let token = '';
  let cities = null; let citiesTs = 0;
  let busy = false;
  const state = { last: 0, error: '' };

  const acct = () => api.kv.get('account') || {}; // { username, password }
  const sel = () => api.kv.get('selection') || null; // { cityId, cityName, calendarId, calendarName }
  const data = () => api.kv.get('plan') || []; // [{ date:'YYYY-MM-DD', type }]

  async function http(url, opt = {}) {
    const r = await fetch(url, { ...opt, headers: { ...HEAD, ...(token ? { authorization: token } : {}), ...(opt.json ? { 'content-type': 'application/json' } : {}), ...(opt.headers || {}) }, body: opt.json ? JSON.stringify(opt.json) : opt.body, signal: AbortSignal.timeout(20000) });
    return r;
  }

  async function login(force) {
    if (token && !force) return;
    const a = acct();
    if (!a.username || !a.password) throw new Error('Nicht angemeldet – Zugangsdaten der CITIES-App eintragen');
    const email = a.username.includes('@');
    const r = await http(`${V2()}/auth`, { method: 'POST', json: { method: email ? 'email' : 'phoneNumber', emailOrPhoneNumber: a.username, password: a.password } });
    if (r.status === 400 || r.status === 401) throw new Error('Anmeldung bei der CITIES-App fehlgeschlagen – E-Mail/Telefon und Passwort prüfen');
    if (!r.ok) throw new Error(`CITIES-App: HTTP ${r.status}`);
    token = r.headers.get('access-token') || '';
    if (!token) throw new Error('CITIES-App lieferte kein Zugangstoken');
  }

  // GET mit automatischer Neuanmeldung und Wiederholung bei 429
  async function get(url) {
    await login();
    for (let i = 0; i < 4; i++) {
      let r = await http(url);
      if (r.status === 401) { await login(true); r = await http(url); }
      if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
      if (!r.ok) throw new Error(`CITIES-App: HTTP ${r.status} (${new URL(url).pathname})`);
      return r.json();
    }
    throw new Error('CITIES-App: zu viele Anfragen (429)');
  }

  async function getCities() {
    if (cities && Date.now() - citiesTs < 86400e3) return cities;
    const out = [];
    let next = '/cities?pagination=limit:100';
    for (let i = 0; next && i < 60; i++) {
      const j = await get(V2() + next);
      out.push(...(j.data || []));
      next = j.nextUrl;
    }
    cities = out.map((c) => ({ id: c._id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
    citiesTs = Date.now();
    return cities;
  }

  async function isV2(cityId) {
    const j = await get(`${V1()}/entities/${encodeURIComponent(cityId)}/services`);
    return !!(j.essentials && j.essentials.garbage_calendar_v2);
  }

  // Kalender (Abfuhrgebiete) einer Gemeinde; v2 mit Hausnummern-Unterpunkten
  async function getCalendars(cityId) {
    if (await isV2(cityId)) {
      const list = [];
      let next = `/waste-management/by-city/${encodeURIComponent(cityId)}/areas?pagination=limit:100`;
      for (let i = 0; next && i < 60; i++) {
        const j = await get(V2() + next);
        list.push(...(j.data || []));
        next = j.nextUrl;
      }
      const out = [];
      for (const c of list) {
        const pn = String(c.displayName || c.name || c.street || '').trim();
        out.push({ id: c._id, name: pn || c._id });
        for (const a of c.addressNumbers || []) {
          const cn = String(a.name || a.addressNumber || a.street || '').trim();
          if (a._id && cn) out.push({ id: a._id, name: pn ? `${pn} - ${cn}` : cn });
        }
      }
      return { v2: true, calendars: out };
    }
    const filter = encodeURIComponent(JSON.stringify({ entityid: { $in: [cityId] } })).replace(/%3A/gi, ':').replace(/%24/g, '$');
    const j = await get(`${V1()}/garbagecalendars/filter?filter=${filter}`);
    return { v2: false, calendars: (j.garbage_calendars || []).map((c) => ({ id: c._id, name: c.name })) };
  }

  async function fetchPlan(s) {
    const v2 = await isV2(s.cityId);
    const out = [];
    if (v2) {
      const j = await get(`${V2()}/waste-management/areas/${encodeURIComponent(s.calendarId)}/calendar`);
      for (const d of j.garbageCollectionDays || []) {
        const type = d.garbageTypeSettings && d.garbageTypeSettings.displayName;
        if (type && /^\d{4}-\d{2}-\d{2}/.test(String(d.date))) out.push({ date: String(d.date).slice(0, 10), type: String(type) });
      }
    } else {
      const j = await get(`${V1()}/garbagecalendars/?full=true&ids=${encodeURIComponent(s.calendarId)}`);
      for (const cal of j || []) for (const p of cal.garbage_plans || []) {
        const type = p.garbage_type && p.garbage_type.name;
        for (const d of p.dates || []) if (type && /^\d{4}-\d{2}-\d{2}$/.test(d)) out.push({ date: d, type: String(type) });
      }
    }
    return out;
  }

  // ---------- Auswertung ----------
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dayDiff = (iso) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(); return Math.round((new Date(y, m - 1, d) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400e3); };
  const slug = (t) => t.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  const rel = (n) => (n === 0 ? 'heute' : n === 1 ? 'morgen' : n === 2 ? 'übermorgen' : `in ${n} Tagen`);

  function upcoming() {
    return data().map((e) => ({ ...e, days: dayDiff(e.date) })).filter((e) => e.days >= 0).sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type, 'de'));
  }

  function publish() {
    if (!sel()) { for (const dv of api.devices.list()) api.devices.remove(dv.key); api.emit({ status: snapshot() }); return; }
    const up = upcoming();
    const room = cfg().room || '';
    const dev = (key, name, type, unit) => api.devices.ensure({ key, name, type, unit, room });
    const wanted = new Set();
    const mk = (key, name, type, unit, patch) => { wanted.add(key); dev(key, name, type, unit); api.devices.setState(key, patch); };
    const first = up[0];
    const nextTypes = first ? up.filter((e) => e.date === first.date).map((e) => e.type) : [];
    const fmt = first ? new Date(first.date + 'T12:00:00').toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit' }) : '';
    mk('next', 'Müll nächste Abholung', 'sensor', '', { value: first ? `${nextTypes.join(', ')} (${fmt})` : 'keine Termine' });
    mk('today', 'Müllabholung heute', 'binary', '', { on: up.some((e) => e.days === 0) });
    mk('tomorrow', 'Müllabholung morgen', 'binary', '', { on: up.some((e) => e.days === 1) });
    const types = [...new Set(data().map((e) => e.type))];
    for (const t of types) {
      const n = up.find((e) => e.type === t);
      mk('t:' + slug(t), `Müll ${t}`, 'sensor', 'Tage', n ? { value: n.days } : { value: '' });
    }
    for (const dv of api.devices.list()) if (!wanted.has(dv.key)) api.devices.remove(dv.key);
    api.emit({ status: snapshot() });
  }

  const snapshot = () => ({
    configured: !!(acct().username && sel()), loggedIn: !!acct().username, username: acct().username || '', hasPassword: !!acct().password,
    selection: sel(), last: state.last, error: state.error, upcoming: upcoming().slice(0, 40),
  });

  async function refresh() {
    const s = sel();
    if (busy || !s) return;
    busy = true;
    try {
      const plan = await fetchPlan(s);
      if (!plan.length) throw new Error('Die CITIES-App liefert für diesen Kalender keine Termine');
      api.kv.set('plan', plan);
      state.last = Date.now(); state.error = '';
      api.log('info', `${plan.length} Termine geladen (${s.cityName} – ${s.calendarName})`);
    } catch (e) {
      state.error = (e.cause && e.cause.code) || e.message;
      api.log('warn', 'Abruf fehlgeschlagen: ' + state.error);
    } finally { busy = false; }
    publish();
  }

  // Erinnerung am Vorabend
  async function remind() {
    const c = cfg();
    if (!c.notify || !sel()) return;
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(c.notifyTime || '18:00').trim());
    const now = new Date();
    const at = m ? Number(m[1]) * 60 + Number(m[2]) : 18 * 60;
    if (now.getHours() * 60 + now.getMinutes() < at || api.kv.get('lastNotify') === ymd(now)) return;
    if (!data().length) return;
    api.kv.set('lastNotify', ymd(now));
    const tom = upcoming().filter((e) => e.days === 1).map((e) => e.type);
    if (tom.length) { api.notify('Müllabholung morgen', [...new Set(tom)].join(', ')); api.log('info', 'Erinnerung gesendet: ' + tom.join(', ')); }
  }

  // ---------- Seite ----------
  api.route('GET', 'status', () => ({ status: snapshot() }));
  api.route('POST', 'login', async ({ body }) => {
    const b = body || {};
    const username = String(b.username || '').trim();
    const old = acct();
    const password = b.password ? String(b.password) : (old.username === username ? old.password : '');
    if (!username || !password) throw new Error('E-Mail/Telefonnummer und Passwort eingeben');
    api.kv.set('account', { username, password });
    token = ''; cities = null;
    try { await login(true); } catch (e) { api.kv.set('account', old); throw e; }
    return { status: snapshot() };
  });
  api.route('GET', 'cities', async () => ({ cities: await getCities() }));
  api.route('GET', 'calendars', async ({ url }) => {
    const id = url.searchParams.get('city');
    if (!id) throw new Error('Gemeinde fehlt');
    return await getCalendars(id);
  });
  api.route('POST', 'select', async ({ body }) => {
    const b = body || {};
    if (!b.cityId || !b.calendarId) throw new Error('Gemeinde und Kalender wählen');
    api.kv.set('selection', { cityId: String(b.cityId), cityName: String(b.cityName || ''), calendarId: String(b.calendarId), calendarName: String(b.calendarName || '') });
    await refresh();
    if (state.error) throw new Error(state.error);
    return { status: snapshot() };
  });
  api.route('POST', 'refresh', async () => { await refresh(); return { status: snapshot() }; });
  api.route('DELETE', 'account', () => { api.kv.set('account', {}); api.kv.set('selection', null); api.kv.set('plan', []); token = ''; cities = null; publish(); return { status: snapshot() }; });

  const iv = () => Math.max(1, Number(cfg().hours) || 6) * 3600e3;
  let stop = api.timer(refresh, iv());
  api.onConfig(() => { stop(); stop = api.timer(refresh, iv()); publish(); });
  api.timer(() => { publish(); remind(); }, 60000);
  if (sel()) { publish(); refresh(); }
  return {};
};
