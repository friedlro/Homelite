'use strict';
const crypto = require('crypto');

// MCP-Server (Model Context Protocol, Streamable HTTP, zustandslos) – damit Claude HomeLite abfragen und steuern kann.
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(String(a.name || ''), String(b.name || ''));
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function createMcp(ctx) {
  const { store, devices, engine, presence, energy, heating, logs, version, log, saveAutomation } = ctx;
  const conf = () => store.cfg.mcp;

  const devView = (d) => {
    const s = devices.states.get(d.id) || {};
    return { id: d.id, name: d.name, room: d.room || '', type: d.type, state: devices.stateString(d, s) ?? null, unit: d.unit || undefined, online: s.online === false ? false : undefined, brightness: s.brightness, power: s.power, setpoint: s.setpoint, current: s.current };
  };
  const findDev = (ref) => {
    const r = String(ref || '').toLowerCase();
    return devices.list.find((d) => d.id === ref) || devices.list.find((d) => d.name.toLowerCase() === r)
      || (devices.list.filter((d) => d.name.toLowerCase().includes(r)).length === 1 ? devices.list.find((d) => d.name.toLowerCase().includes(r)) : null);
  };

  const AUTO_HELP = `Automation-Aufbau (JSON). triggers (ODER-verknüpft): {type:'device',device,to?,from?,above?,below?,forSeconds?,id?} | {type:'time',at:'HH:MM',days?:[0-6]} | {type:'sun',event:'sunrise'|'sunset',offset?:Minuten} | {type:'interval',everyMinutes} | {type:'geofence',event:'enter'|'leave'|'first_home'|'all_left',person?,zone?} | {type:'webhook',name} | {type:'startup'}. conditions (UND): {type:'device',device,equals,negate?} | {type:'numeric',device,above?,below?} | {type:'diff',device,device2,min?,max?} | {type:'time',after:'HH:MM',before:'HH:MM'} | {type:'weekday',days:[0-6]} | {type:'presence',mode:'anyone_home'|'nobody_home'|'person_home'|'person_away',person?} | {type:'trigger',ids:'kennung1,kennung2',negate?} (ausgelöst durch Auslöser mit dieser id) | {type:'any',conditions:[…]} (ODER) | {type:'all',conditions:[…]} (UND). actions (nacheinander): {type:'device',device,action:'on'|'off'|'toggle'|'brightness'|'setpoint'|'open'|'close'|'stop'|'lock',value?} | {type:'delay',seconds} | {type:'notify',title?,message} | {type:'if',conditions,then:[…],else:[…]} | {type:'require',conditions} | {type:'heating',…} | {type:'car',command} | {type:'mqtt',topic,payload} | {type:'http',url,method?,body?}. Geräte dürfen per ID oder exaktem Namen angegeben werden (Zustände: on/off, Sensorwert als Zahl). Tage: 0=Sonntag.`;
  const AUTO_SCHEMA = (create) => ({ type: 'object', properties: {
    ...(create ? {} : { automation: { type: 'string', description: 'ID oder Name der Automation' } }),
    name: { type: 'string' }, desc: { type: 'string' }, enabled: { type: 'boolean', description: 'Standard: true' },
    mode: { type: 'string', enum: ['single', 'restart', 'queued'] }, scene: { type: 'boolean', description: 'Als Szene-Knopf im Dashboard anzeigen' },
    triggers: { type: 'array', items: { type: 'object' } }, conditions: { type: 'array', items: { type: 'object' } }, actions: { type: 'array', items: { type: 'object' } },
  }, required: create ? ['name', 'triggers', 'actions'] : ['automation'] });
  const TRIG = ['device', 'time', 'sun', 'interval', 'geofence', 'webhook', 'startup'];
  const COND = ['device', 'numeric', 'diff', 'time', 'weekday', 'presence', 'trigger', 'any', 'all'];
  const ACT = ['device', 'delay', 'notify', 'if', 'require', 'heating', 'car', 'mqtt', 'http'];
  // Gerätenamen -> IDs auflösen und Typen prüfen (rekursiv)
  function norm(list, allowed, what) {
    if (list === undefined) return undefined;
    if (!Array.isArray(list)) throw new Error(`${what} muss eine Liste sein`);
    return list.map((x) => {
      if (!x || typeof x !== 'object' || !allowed.includes(x.type)) throw new Error(`${what}: unbekannter Typ „${x && x.type}“ (erlaubt: ${allowed.join(', ')})`);
      const o = { ...x };
      for (const k of ['device', 'device2']) if (o[k] !== undefined) { const d = findDev(o[k]); if (!d) throw new Error(`${what}: Gerät „${o[k]}“ nicht gefunden`); o[k] = d.id; }
      if (o.type === 'if') { o.conditions = norm(o.conditions || [], COND, 'Bedingung'); o.then = norm(o.then || [], ACT, 'Aktion'); o.else = norm(o.else || [], ACT, 'Aktion'); }
      if (o.type === 'require' || o.type === 'any' || o.type === 'all') o.conditions = norm(o.conditions || [], COND, 'Bedingung');
      if (o.type === 'device' && what === 'Aktion' && !o.action) throw new Error('Aktion: „action“ fehlt');
      return o;
    });
  }
  function writeAuto(a, ref) {
    if (!conf().allowAutomations) throw new Error('Automationen anlegen/ändern ist für den KI-Zugriff ausgeschaltet (HomeLite → Einstellungen → KI-Zugriff).');
    const old = ref ? store.cfg.automations.find((x) => x.id === ref || x.name.toLowerCase() === String(ref).toLowerCase()) : null;
    if (ref && !old) throw new Error('Automation nicht gefunden');
    const body = {};
    for (const k of ['name', 'desc', 'mode']) if (a[k] !== undefined) body[k] = a[k];
    if (a.enabled !== undefined) body.enabled = !!a.enabled; else if (!old) body.enabled = true;
    if (a.scene !== undefined) body.dash = !!a.scene;
    body.triggers = norm(a.triggers, TRIG, 'Auslöser');
    body.conditions = norm(a.conditions, COND, 'Bedingung');
    body.actions = norm(a.actions, ACT, 'Aktion');
    for (const k of ['triggers', 'conditions', 'actions']) if (body[k] === undefined) delete body[k];
    if (!old) {
      if (!body.name) throw new Error('name fehlt');
      if (!(body.triggers || []).length) throw new Error('Mindestens ein Auslöser nötig');
      if (!(body.actions || []).length) throw new Error('Mindestens eine Aktion nötig');
    }
    const r = saveAutomation(body, old ? old.id : null);
    log('info', `🤖 KI: Automation „${r.name}“ ${old ? 'geändert' : 'angelegt'}`);
    return { ok: true, id: r.id, name: r.name, enabled: r.enabled, triggers: r.triggers.length, actions: r.actions.length };
  }

  const TOOLS = [
    { name: 'list_devices', description: 'Alle Geräte mit aktuellem Zustand (optional nach Raum oder Typ filtern). Typen: switch, light, sensor, binary, thermostat, cover, lock, event.',
      inputSchema: { type: 'object', properties: { room: { type: 'string' }, type: { type: 'string' }, query: { type: 'string', description: 'Teil des Namens' } } }, annotations: { readOnlyHint: true },
      run: ({ room, type, query }) => [...devices.list].sort(byName).filter((d) => (!room || (d.room || '').toLowerCase() === String(room).toLowerCase()) && (!type || d.type === type) && (!query || d.name.toLowerCase().includes(String(query).toLowerCase()))).map(devView) },
    { name: 'get_device', description: 'Detailzustand eines Geräts (ID oder Name).', inputSchema: { type: 'object', properties: { device: { type: 'string' } }, required: ['device'] }, annotations: { readOnlyHint: true },
      run: ({ device }) => { const d = findDev(device); if (!d) throw new Error('Gerät nicht gefunden'); return { ...devView(d), raw: devices.states.get(d.id) || {} }; } },
    { name: 'control_device', description: 'Gerät steuern. action: on, off, toggle, brightness (value 0-100), setpoint (value °C), open, close, stop, lock, unlock.',
      inputSchema: { type: 'object', properties: { device: { type: 'string', description: 'ID oder Name' }, action: { type: 'string' }, value: { type: 'number' } }, required: ['device', 'action'] }, annotations: { destructiveHint: false },
      run: async ({ device, action, value }) => {
        if (!conf().allowControl) throw new Error('Steuern ist für den KI-Zugriff ausgeschaltet (HomeLite → Einstellungen → KI-Zugriff).');
        const d = findDev(device);
        if (!d) throw new Error('Gerät nicht gefunden');
        if (action === 'unlock' && !conf().allowUnlock) throw new Error('Aufsperren ist für den KI-Zugriff nicht erlaubt (in den Einstellungen freigeben).');
        await devices.control(d, String(action), value, { k: 'mcp' });
        log('info', `🤖 KI: ${d.name} → ${action}${value !== undefined ? ' ' + value : ''}`);
        return { ok: true, device: devView(d) };
      } },
    { name: 'list_rooms', description: 'Räume mit Anzahl Geräte.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
      run: () => store.cfg.rooms.map((r) => ({ room: r, devices: devices.list.filter((d) => d.room === r).length })) },
    { name: 'list_automations', description: 'Automationen/Szenen mit Status und letzter Ausführung.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
      run: () => [...store.cfg.automations].sort(byName).map((a) => ({ id: a.id, name: a.name, enabled: a.enabled, scene: !!a.dash, lastRun: engine.lastRun.get(a.id) || null, desc: a.desc || '' })) },
    { name: 'get_automation', description: 'Vollständige Definition einer Automation (Auslöser, Bedingungen, Aktionen, Modus) lesen – ID oder Name. Geräte erscheinen mit Namen und ID.', inputSchema: { type: 'object', properties: { automation: { type: 'string' } }, required: ['automation'] }, annotations: { readOnlyHint: true },
      run: ({ automation }) => {
        const r = String(automation).toLowerCase();
        const a = store.cfg.automations.find((x) => x.id === automation || x.name.toLowerCase() === r);
        if (!a) throw new Error('Automation nicht gefunden');
        const nm = (id) => { const d = devices.byId(id); return d ? { id, name: d.name } : id; };
        const walk = (x) => Array.isArray(x) ? x.map(walk) : x && typeof x === 'object'
          ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, (k === 'device' || k === 'device2') && typeof v === 'string' ? nm(v) : walk(v)])) : x;
        return { ...walk(a), lastRun: engine.lastRun.get(a.id) || null };
      } },
    { name: 'run_automation', description: 'Automation/Szene ausführen (ID oder Name).', inputSchema: { type: 'object', properties: { automation: { type: 'string' } }, required: ['automation'] }, annotations: { destructiveHint: false },
      run: async ({ automation }) => {
        if (!conf().allowControl) throw new Error('Steuern ist für den KI-Zugriff ausgeschaltet.');
        const r = String(automation).toLowerCase();
        const a = store.cfg.automations.find((x) => x.id === automation || x.name.toLowerCase() === r);
        if (!a) throw new Error('Automation nicht gefunden');
        await engine.run(a.id);
        log('info', `🤖 KI: Automation „${a.name}“ ausgeführt`);
        return { ok: true, name: a.name };
      } },
    { name: 'create_automation', description: AUTO_HELP + ' Legt eine neue Automation an.',
      inputSchema: AUTO_SCHEMA(true), annotations: { destructiveHint: false },
      run: (a) => writeAuto(a, null) },
    { name: 'update_automation', description: 'Bestehende Automation ändern (ID oder Name in „automation“); nur übergebene Felder werden ersetzt (triggers/conditions/actions komplett). Aufbau siehe create_automation. Auch zum Aktivieren/Deaktivieren (enabled).',
      inputSchema: AUTO_SCHEMA(false), annotations: { destructiveHint: false },
      run: (a) => writeAuto(a, a.automation) },
    { name: 'get_presence', description: 'Anwesenheit: Personen, zuhause/unterwegs, Zonen, Position.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, run: () => presence.snapshot() },
    { name: 'get_energy', description: 'Energie: aktuelle Leistung (PV, Netz, Batterie, Haus) und Tageswerte.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, run: () => energy.live() },
    { name: 'get_heating', description: 'Heizung: Räume mit Ist-/Solltemperatur und Modus.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, run: () => heating.status() },
    { name: 'get_logs', description: 'Letzte Protokolleinträge von HomeLite.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }, annotations: { readOnlyHint: true },
      run: ({ limit }) => logs.slice(-Math.max(1, Math.min(200, Number(limit) || 40))).map((e) => `${new Date(e.ts).toISOString()} ${e.level} ${e.msg}`) },
  ];

  // Werkzeuge von Plugins: { name, description, inputSchema, readOnly, control, run(args) }
  const extra = new Map(); // name -> { owner, tool }
  function addTool(owner, t) {
    if (!t || !/^[a-z][a-z0-9_]{1,40}$/.test(String(t.name || ''))) throw new Error('MCP-Tool: Name muss ^[a-z][a-z0-9_]{1,40}$ entsprechen');
    if (typeof t.run !== 'function') throw new Error('MCP-Tool: run(args) fehlt');
    if (TOOLS.some((x) => x.name === t.name) || (extra.has(t.name) && extra.get(t.name).owner !== owner)) throw new Error(`MCP-Tool „${t.name}“ existiert bereits`);
    extra.set(t.name, { owner, tool: t });
  }
  function removeTools(owner) { for (const [k, v] of [...extra]) if (v.owner === owner) extra.delete(k); }
  // eigener Endpunkt eines Plugins: nur dessen Werkzeuge, ohne globalen „Steuern“-Schalter (der Token des Plugins genügt)
  const scopeTools = (owner) => [...extra.values()].filter((x) => x.owner === owner).map(({ tool: t }) => ({
    name: t.name, description: String(t.description || ''), inputSchema: t.inputSchema || { type: 'object', properties: {} },
    annotations: t.readOnly ? { readOnlyHint: true } : { destructiveHint: !!t.control }, run: t.run,
  }));
  const allTools = () => [...TOOLS, ...[...extra.values()].filter((x) => !x.tool.scopeOnly).map(({ tool: t }) => ({
    name: t.name, description: String(t.description || ''), inputSchema: t.inputSchema || { type: 'object', properties: {} },
    annotations: t.readOnly ? { readOnlyHint: true } : { destructiveHint: !!t.control },
    run: t.control ? (a) => { if (!conf().allowControl) throw new Error('Steuern ist für den KI-Zugriff ausgeschaltet (HomeLite → Einstellungen → KI-Zugriff).'); return t.run(a); } : t.run,
  }))];

  async function rpc(m, scope) {
    const id = m.id;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (m.id === undefined) return null; // Notification
    switch (m.method) {
      case 'initialize': {
        const want = m.params && m.params.protocolVersion;
        return ok({ protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: scope ? 'homelite-' + scope : 'homelite', version: version() },
          instructions: scope ? `HomeLite-Plugin „${scope}“.` : 'HomeLite Hausautomatisierung. Erst list_devices bzw. list_rooms aufrufen, dann control_device mit ID oder Namen.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: (scope ? scopeTools(scope) : allTools()).map(({ run, ...t }) => t) });
      case 'tools/call': {
        const t = (scope ? scopeTools(scope) : allTools()).find((x) => x.name === (m.params || {}).name);
        if (!t) return err(-32602, 'Unbekanntes Tool');
        try {
          const out = await t.run((m.params && m.params.arguments) || {});
          return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: 'Fehler: ' + e.message }], isError: true });
        }
      }
      default: return err(-32601, 'Methode nicht unterstützt');
    }
  }

  const fails = new Map();
  // Rückgabe: true, wenn behandelt
  async function handle(req, res, url, readBody, enabled) {
    const p = url.pathname;
    const pm = /^\/mcp-plugin\/([a-z0-9-]+)\/([\w-]+)\/?$/.exec(p);
    const m = pm ? null : /^\/mcp(?:\/([\w-]+))?\/?$/.exec(p);
    if (!m && !pm) return false;
    const send = (st, obj, extra) => { res.writeHead(st, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }); res.end(obj === undefined ? '' : JSON.stringify(obj)); return true; };
    const scope = pm ? pm[1] : null;
    const pt = pm && ctx.pluginEndpoint ? ctx.pluginEndpoint(scope) : null;
    if (pm ? !pt : !enabled) return send(404, { error: pm ? 'Plugin-Endpunkt nicht aktiv' : 'KI-Zugriff ist ausgeschaltet' });
    const ip = req.socket.remoteAddress;
    const f = fails.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 20) return send(429, { error: 'Zu viele Versuche' });
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    const given = (pm ? pm[2] : m[1]) || (bearer && bearer[1]) || '';
    const expect = pm ? pt : conf().token;
    if (!expect || !safeEq(given, expect)) { f.n++; fails.set(ip, f); return send(401, { error: 'Token ungültig' }, { 'WWW-Authenticate': 'Bearer' }); }
    const origin = req.headers.origin;
    if (origin) { let oh = ''; try { oh = new URL(origin).host; } catch { /* ungültig */ } if (oh !== req.headers.host) return send(403, { error: 'Origin nicht erlaubt' }); }
    if (req.method === 'GET' || req.method === 'DELETE') return send(405, { error: 'Nur POST' }, { Allow: 'POST' });
    if (req.method !== 'POST') return send(405, { error: 'Nur POST' });
    let body;
    try { body = await readBody(req); } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Ungültiges JSON' } }); }
    const batch = Array.isArray(body);
    const out = (await Promise.all((batch ? body : [body]).map((x) => rpc(x || {}, scope)))).filter(Boolean);
    if (!out.length) { res.writeHead(202); res.end(); return true; }
    return send(200, batch ? out : out[0]);
  }

  // Zugriff für Plugins mit Recht „core“: nur Kern-Werkzeuge; die KI-Zugriff-Schalter (Steuern/Automationen) gelten weiter
  const coreList = () => TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, readOnly: !!(t.annotations && t.annotations.readOnlyHint) }));
  const coreCall = async (name, args) => { const t = TOOLS.find((x) => x.name === name); if (!t) throw new Error('Unbekanntes Werkzeug: ' + name); return t.run(args || {}); };
  return { handle, tools: TOOLS, addTool, removeTools, coreList, coreCall };
}

createMcp.newToken = () => crypto.randomBytes(24).toString('hex');
module.exports = createMcp;
