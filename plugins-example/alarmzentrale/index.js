'use strict';
// Alarmzentrale: Sensoren (Geräte vom Typ „binary“: Bewegung, Tür, Fenster, Rauch …) und Sirenen frei wählbar.
// Zustände: disarmed → arming (Ausgangsverzögerung) → armed_home | armed_away → pending (Eingangsverzögerung) → triggered → zurück zu armed_*.
const crypto = require('crypto');

const DEF = {
  sensors: [],        // { id, name, home: bool, away: bool, delay: bool }
  sirens: [],         // Geräte-IDs (Schalter/Lichter), die bei Alarm EIN gehen
  lights: [],         // Geräte-IDs, die bei Alarm zusätzlich EIN gehen (Licht)
  exitDelay: 30,      // s, nur Modus „Abwesend“
  entryDelay: 20,     // s, nur für Sensoren mit „verzögert“
  sirenSeconds: 120,  // 0 = bis zum Unscharfschalten
  notify: true,
  pinHash: '',        // scrypt-Hash, leer = kein PIN
  pinSalt: '',
};
const LABEL = { disarmed: 'Unscharf', arming: 'Wird scharf …', armed_home: 'Scharf (Zuhause)', armed_away: 'Scharf (Abwesend)', pending: 'Eingangsverzögerung', triggered: 'ALARM' };

module.exports = (api) => {
  let cfg = { ...DEF, ...(api.kv.get('cfg') || {}) };
  let S = { mode: 'disarmed', since: Date.now(), by: '', trigger: '', ...(api.kv.get('state') || {}) };
  let bypass = new Set();           // Sensoren, die beim Scharfschalten schon offen waren
  let offs = { exit: null, entry: null, siren: null, test: null };
  let events = api.kv.get('events') || [];
  let last = api.kv.get('last') || {}; // Sensor-ID -> letzte Auslösung (ms)
  const stopped = { v: false };

  const save = () => api.kv.set('cfg', cfg);
  const persist = () => api.kv.set('state', { mode: S.mode, since: S.since, by: S.by, trigger: S.trigger });
  const clear = (k) => { if (offs[k]) { offs[k](); offs[k] = null; } };
  const lbl = () => LABEL[S.mode] || S.mode;

  function log(text, level) {
    events.unshift({ t: Date.now(), text, level: level || 'info' });
    events = events.slice(0, 150);
    api.kv.set('events', events);
    api.log(level === 'alarm' ? 'warn' : 'info', text);
  }
  const say = (title, msg) => { if (cfg.notify) { try { api.notify(title, msg); } catch (e) { api.log('warn', 'Benachrichtigung: ' + e.message); } } };

  // ---------- Hilfen ----------
  const dev = (id) => api.devices.get(id);
  const isOn = (d) => !!(d && d.state_raw && d.state_raw.on === true);
  const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
  const pinOk = (pin) => {
    if (!cfg.pinHash) return true;
    const a = Buffer.from(hashPin(pin || '', cfg.pinSalt), 'hex'), b = Buffer.from(cfg.pinHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  async function act(ids, action) {
    for (const id of ids) {
      try { await api.devices.control(id, action); } catch (e) { api.log('warn', `${id} ${action}: ${e.message}`); }
    }
  }
  const armedIn = (s, mode) => mode === 'armed_home' ? s.home : mode === 'armed_away' ? s.away : false;

  // ---------- Geräte ----------
  function ensureDevices() {
    api.devices.ensure({ key: 'alarm:status', name: 'Alarm Status', type: 'sensor', unit: '' });
    api.devices.ensure({ key: 'alarm:zuhause', name: 'Alarm Zuhause', type: 'switch' });
    api.devices.ensure({ key: 'alarm:abwesend', name: 'Alarm Abwesend', type: 'switch' });
    api.devices.ensure({ key: 'alarm:ausgeloest', name: 'Alarm ausgelöst', type: 'binary' });
  }
  function publish() {
    try {
      api.devices.setState('alarm:status', { value: lbl() });
      api.devices.setState('alarm:zuhause', { on: S.mode === 'armed_home' });
      api.devices.setState('alarm:abwesend', { on: S.mode === 'armed_away' || S.mode === 'arming' });
      api.devices.setState('alarm:ausgeloest', { on: S.mode === 'triggered' || S.mode === 'pending' });
    } catch (e) { api.log('warn', 'Zustand: ' + e.message); }
    api.emit({ model: model() });
  }
  function set(mode, by, trigger) {
    S = { mode, since: Date.now(), by: by || '', trigger: trigger || '' };
    persist(); publish();
  }

  // ---------- Zustandswechsel ----------
  function openSensors(mode) {
    return cfg.sensors.filter((s) => armedIn(s, mode) && isOn(dev(s.id))).map((s) => s.name);
  }
  function arm(kind, by) {
    if (!['home', 'away'].includes(kind)) throw new Error('Modus: home oder away');
    if (!cfg.sensors.length) throw new Error('Noch keine Sensoren ausgewählt');
    clear('exit'); clear('entry'); clear('siren');
    const mode = kind === 'home' ? 'armed_home' : 'armed_away';
    bypass = new Set(cfg.sensors.filter((s) => armedIn(s, mode) && isOn(dev(s.id))).map((s) => s.id));
    const open = openSensors(mode);
    const after = () => {
      set(mode, by);
      log(`Scharf (${kind === 'home' ? 'Zuhause' : 'Abwesend'}) – ${by || 'unbekannt'}` + (open.length ? `; offen/umgangen: ${open.join(', ')}` : ''));
      if (open.length) say('Alarmzentrale', `Scharf mit offenen Sensoren (werden ignoriert, bis sie schließen): ${open.join(', ')}`);
    };
    if (kind === 'away' && Number(cfg.exitDelay) > 0) {
      set('arming', by);
      log(`Ausgangsverzögerung ${cfg.exitDelay} s – ${by || 'unbekannt'}`);
      offs.exit = api.after(after, Number(cfg.exitDelay) * 1000);
    } else after();
    return open;
  }
  async function disarm(by) {
    clear('exit'); clear('entry'); clear('siren');
    const was = S.mode;
    bypass = new Set();
    if (was === 'disarmed') return;
    await act([...cfg.sirens, ...cfg.lights.filter((id) => alarmLights.has(id))], 'off');
    alarmLights.clear();
    set('disarmed', by);
    log(`Unscharf – ${by || 'unbekannt'}` + (was === 'triggered' || was === 'pending' ? ' (Alarm beendet)' : ''));
  }
  const alarmLights = new Set();
  async function trigger(s) {
    clear('entry');
    set('triggered', '', s.name);
    log(`ALARM: ${s.name}`, 'alarm');
    say('🚨 ALARM', `${s.name} hat ausgelöst (${new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })})`);
    try { api.fire('alarm_ausgeloest'); } catch { /* kein Webhook-Auslöser vorhanden */ }
    for (const id of cfg.lights) { const d = dev(id); if (d && !isOn(d)) alarmLights.add(id); }
    await act([...cfg.sirens, ...cfg.lights], 'on');
    if (Number(cfg.sirenSeconds) > 0) {
      offs.siren = api.after(async () => {
        offs.siren = null;
        await act([...cfg.sirens, ...cfg.lights.filter((id) => alarmLights.has(id))], 'off');
        alarmLights.clear();
        const back = S.trigger;
        // zurück in den scharfen Zustand (Modus vor dem Alarm bleibt über kv erhalten)
        set(prevArmed || 'armed_away', '', '');
        log(`Sirene beendet, wieder scharf (Auslöser war: ${back})`);
      }, Number(cfg.sirenSeconds) * 1000);
    }
  }
  let prevArmed = S.mode.startsWith('armed') ? S.mode : 'armed_away';

  function onSensor(s, mode) {
    if (S.mode === 'triggered') return;               // läuft schon
    last[s.id] = Date.now(); api.kv.set('last', last);
    if (S.mode === 'pending') { return; }              // wartet bereits
    if (s.delay && Number(cfg.entryDelay) > 0) {
      prevArmed = mode;
      set('pending', '', s.name);
      log(`Eingangsverzögerung ${cfg.entryDelay} s – ${s.name}`, 'warn');
      say('Alarmzentrale', `${s.name} – bitte innerhalb von ${cfg.entryDelay} s unscharf schalten`);
      offs.entry = api.after(() => { offs.entry = null; trigger(s); }, Number(cfg.entryDelay) * 1000);
    } else { prevArmed = mode; trigger(s); }
  }

  api.devices.onState((d, st) => {
    if (st.on === undefined) return;
    const s = cfg.sensors.find((x) => x.id === d.id);
    if (!s) return;
    if (st.on !== true) { bypass.delete(s.id); return; }   // geschlossen/Ruhe: wieder scharf
    const mode = S.mode === 'pending' || S.mode === 'triggered' ? prevArmed : S.mode;
    if (!['armed_home', 'armed_away', 'pending', 'triggered'].includes(S.mode)) return; // unscharf / Ausgangsverzögerung: ignorieren
    if (!armedIn(s, mode) || bypass.has(s.id)) return;
    onSensor(s, mode);
  });

  api.devices.onCommand(async (d, action) => {
    const kind = d.key === 'alarm:zuhause' ? 'home' : d.key === 'alarm:abwesend' ? 'away' : null;
    if (!kind) throw new Error('Nicht schaltbar');
    const mode = kind === 'home' ? 'armed_home' : 'armed_away';
    const on = action === 'toggle' ? !(S.mode === mode || (kind === 'away' && S.mode === 'arming')) : action === 'on';
    if (action !== 'on' && action !== 'off' && action !== 'toggle') throw new Error('Aktion nicht unterstützt');
    if (on) arm(kind, `Gerät „${d.name}“`); else await disarm(`Gerät „${d.name}“`);
    return { on };
  });

  // ---------- Oberfläche ----------
  const candidates = () => api.devices.all().filter((d) => d.type === 'binary' && d.plugin !== api.id)
    .map((d) => ({ id: d.id, name: d.name, room: d.room, on: d.state_raw && d.state_raw.on === true }))
    .sort((a, b) => (a.room || '').localeCompare(b.room || '', 'de') || a.name.localeCompare(b.name, 'de', { numeric: true }));
  const actors = () => api.devices.all().filter((d) => ['switch', 'light'].includes(d.type) && d.plugin !== api.id)
    .map((d) => ({ id: d.id, name: d.name, room: d.room, type: d.type }))
    .sort((a, b) => (a.room || '').localeCompare(b.room || '', 'de') || a.name.localeCompare(b.name, 'de', { numeric: true }));
  const model = () => ({
    mode: S.mode, label: lbl(), since: S.since, by: S.by, trigger: S.trigger,
    exitEnds: S.mode === 'arming' ? S.since + Number(cfg.exitDelay) * 1000 : null,
    entryEnds: S.mode === 'pending' ? S.since + Number(cfg.entryDelay) * 1000 : null,
    cfg: { ...cfg, pinHash: undefined, pinSalt: undefined, hasPin: !!cfg.pinHash },
    last, events: events.slice(0, 60), bypass: [...bypass],
  });

  api.route('GET', 'model', () => ({ ...model(), candidates: candidates(), actors: actors() }));
  api.route('POST', 'arm', ({ body }) => { const open = arm(body && body.mode, 'Oberfläche'); return { ...model(), open }; });
  api.route('POST', 'disarm', async ({ body }) => {
    if (!pinOk(body && body.pin)) { log('Unscharf-Versuch mit falschem PIN', 'warn'); throw new Error('PIN falsch'); }
    await disarm('Oberfläche'); return model();
  });
  api.route('POST', 'config', ({ body }) => {
    const b = body || {};
    const ids = (a) => [...new Set((Array.isArray(a) ? a : []).map(String))].slice(0, 100);
    const num = (v, lo, hi, d) => { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d; };
    const known = new Map(candidates().map((c) => [c.id, c.name]));
    cfg.sensors = (Array.isArray(b.sensors) ? b.sensors : []).filter((s) => s && known.has(String(s.id))).slice(0, 100)
      .map((s) => ({ id: String(s.id), name: known.get(String(s.id)), home: !!s.home, away: s.away !== false, delay: !!s.delay }));
    cfg.sirens = ids(b.sirens); cfg.lights = ids(b.lights).filter((i) => !cfg.sirens.includes(i));
    cfg.exitDelay = num(b.exitDelay, 0, 300, 30); cfg.entryDelay = num(b.entryDelay, 0, 300, 20); cfg.sirenSeconds = num(b.sirenSeconds, 0, 3600, 120);
    cfg.notify = b.notify !== false;
    if (b.newPin !== undefined && b.newPin !== null && b.newPin !== '') {
      if (!/^\d{4,12}$/.test(String(b.newPin))) throw new Error('PIN: 4–12 Ziffern');
      cfg.pinSalt = crypto.randomBytes(16).toString('hex'); cfg.pinHash = hashPin(b.newPin, cfg.pinSalt);
    }
    if (b.removePin) { cfg.pinHash = ''; cfg.pinSalt = ''; }
    save(); log('Einstellungen gespeichert'); publish();
    return { ...model(), candidates: candidates(), actors: actors() };
  });
  api.route('POST', 'test', async ({ body }) => {
    if (S.mode === 'triggered') throw new Error('Alarm läuft');
    if (!cfg.sirens.length) throw new Error('Keine Sirene ausgewählt');
    clear('test');
    await act(cfg.sirens, 'on'); log('Sirenentest (3 s)');
    offs.test = api.after(() => { offs.test = null; act(cfg.sirens, 'off'); }, 3000);
    return { ok: true };
  });
  api.route('DELETE', 'events', () => { events = []; api.kv.set('events', events); publish(); return model(); });

  api.mcp.tool({ name: 'alarm_status', description: 'Status der Alarmzentrale (unscharf/scharf/Alarm) und die letzten Ereignisse.', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => ({ status: lbl(), seit: new Date(S.since).toISOString(), ausgeloest_durch: S.trigger || null, sensoren: cfg.sensors.map((s) => s.name), ereignisse: events.slice(0, 10) }) });
  api.mcp.tool({ name: 'alarm_scharf', description: 'Alarmanlage scharf schalten: mode = home (Zuhause, nur Außenhaut) oder away (Abwesend). Unscharf schalten ist aus Sicherheitsgründen nur in der Oberfläche möglich.', control: true,
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['home', 'away'] } }, required: ['mode'] }, run: ({ mode }) => { const open = arm(mode, 'KI-Zugriff'); return { ok: true, offene_sensoren: open }; } });

  ensureDevices();
  // Nach Neustart: Zustand wiederherstellen. Ein laufender Alarm/Verzögerung fällt auf „scharf“ zurück.
  if (['pending', 'triggered', 'arming'].includes(S.mode)) { const m = S.mode === 'arming' ? 'armed_away' : prevArmed; S = { mode: m, since: Date.now(), by: '', trigger: '' }; persist(); }
  if (S.mode.startsWith('armed')) bypass = new Set(cfg.sensors.filter((s) => armedIn(s, S.mode) && isOn(dev(s.id))).map((s) => s.id));
  publish();
  return { stop() { stopped.v = true; } };
};
