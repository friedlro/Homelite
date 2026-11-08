'use strict';
// Flows: Engine + Editor-Schnittstelle + KI-Werkzeuge + Erweiterungspunkte
const fs = require('fs');
const path = require('path');
const expr = require('./lib/expr');
const { createRegistry, CATS } = require('./lib/registry');
const { createEngine, clone, uid } = require('./lib/engine');
const { nodes: builtin, compare, getPath, setPath } = require('./lib/nodes');

const EXAMPLE = `'use strict';
// Eigener Knoten für Flows. Dateien in diesem Ordner (nicht mit _ beginnend) werden beim Start bzw. über
// „Erweiterungen neu laden“ geladen. Eine Datei darf einen Knoten oder eine Liste von Knoten exportieren.
//
// Aufbau:
//   type      eindeutige Kennung (a-z 0-9 . _ -), z. B. "meine-firma.preis"
//   label     Name in der Palette          category  Auslöser | Logik | Daten | Fluss | Aktion | Erweiterung
//   icon      Emoji                         desc      Beschreibung (Tooltip)
//   outputs   Anzahl Ausgänge (Standard 1)  labels    Beschriftung der Ausgänge, z. B. ["ja","nein"]
//   fields    Eingabefelder (siehe unten)   run(ctx, msg)  Verarbeitung; Rückgabe: msg | [msgA, msgB] (je Ausgang) | null
//   start(ctx)  nur für Auslöser: ctx.emit(msg) startet den Flow, Rückgabe = Aufräumfunktion
//
// Felder: { key, label, type, default, help, placeholder, options, showIf }
//   type: text | textarea | number | bool | select | combo | device | json | code | time | weekdays | list
//   Texte dürfen {{ Ausdrücke }} enthalten – ctx.cfg enthält sie schon ausgewertet.
//
// ctx: cfg, api (HomeLite-Plugin-API: devices, notify, mqtt, kv …), log(text), debug(wert), sleep(ms),
//      flowCtx / globalCtx (Speicher), state (bleibt zwischen Läufen), val(pfad|{{ausdruck}}), send(port,msg)
//
// module.exports = {
//   type: 'beispiel.verdoppeln', label: 'Verdoppeln', category: 'Daten', icon: '✖️',
//   fields: [{ key: 'faktor', label: 'Faktor', type: 'number', default: 2 }],
//   run(ctx, msg) { msg.payload = Number(msg.payload) * ctx.cfg.faktor; return msg; },
// };
`;

module.exports = (api) => {
  const registry = createRegistry();
  for (const d of builtin) registry.add(d, 'eingebaut');
  const engine = createEngine({ api, registry });
  const nodesDir = path.join(api.dataDir, 'nodes');
  try { fs.mkdirSync(nodesDir, { recursive: true }); if (!fs.existsSync(path.join(nodesDir, '_beispiel.js'))) fs.writeFileSync(path.join(nodesDir, '_beispiel.js'), EXAMPLE); } catch (e) { api.log('warn', 'Ordner für eigene Knoten nicht anlegbar: ' + e.message); }
  const helpers = { api, expr, compare, getPath, setPath, uid, clone };
  const loadFiles = () => registry.loadDir(nodesDir, helpers);
  loadFiles();

  // ---------- Speicher ----------
  let flows = (() => { const v = api.kv.get('flows'); return Array.isArray(v) ? v : []; })();
  const save = () => api.kv.set('flows', flows);
  const byId = (id) => flows.find((f) => f.id === id);
  const bad = (m) => { throw new Error(m); };

  function sanitize(inp, old) {
    if (!inp || typeof inp !== 'object') bad('Flow fehlt');
    const f = {
      id: old ? old.id : (/^[a-z0-9]{6,24}$/.test(String(inp.id || '')) && !byId(inp.id) ? inp.id : uid()),
      name: String(inp.name || 'Neuer Flow').slice(0, 80).trim() || 'Neuer Flow',
      enabled: !!inp.enabled,
      settings: { concurrency: ['parallel', 'skip', 'queue'].includes(inp.settings && inp.settings.concurrency) ? inp.settings.concurrency : 'parallel', notifyOnError: !!(inp.settings && inp.settings.notifyOnError) },
      note: String(inp.note || '').slice(0, 2000),
      nodes: [], edges: [], updated: Date.now(),
    };
    const ids = new Set();
    if (!Array.isArray(inp.nodes) || inp.nodes.length > 500) bad('Ungültige Knotenliste (max. 500 Knoten)');
    for (const n of inp.nodes) {
      const id = String(n && n.id || '');
      if (!/^[\w-]{1,40}$/.test(id) || ids.has(id)) bad(`Knoten-ID „${id}“ ungültig oder doppelt`);
      ids.add(id);
      const type = String(n.type || ''); if (!/^[a-z0-9][a-z0-9._-]{1,48}$/.test(type)) bad(`Knotentyp „${type}“ ungültig`);
      const cfg = n.cfg && typeof n.cfg === 'object' && !Array.isArray(n.cfg) ? clone(n.cfg) : {};
      f.nodes.push({
        id, type, name: String(n.name || '').slice(0, 80), x: Math.round(Number(n.x) || 0), y: Math.round(Number(n.y) || 0), cfg,
        disabled: !!n.disabled, onError: ['continue', 'port'].includes(n.onError) ? n.onError : '', retries: Math.max(0, Math.min(5, Number(n.retries) || 0)),
        retryDelay: Math.max(0, Math.min(600000, Number(n.retryDelay) || 1000)), timeout: n.timeout === undefined || n.timeout === '' ? '' : Math.max(0, Math.min(86400, Number(n.timeout) || 0)), note: String(n.note || '').slice(0, 500),
      });
    }
    if (Array.isArray(inp.edges)) {
      if (inp.edges.length > 2000) bad('Zu viele Verbindungen');
      const seen = new Set();
      for (const e of inp.edges) {
        if (!ids.has(e.from) || !ids.has(e.to)) continue;
        const k = `${e.from}:${Number(e.out) || 0}>${e.to}`; if (seen.has(k)) continue; seen.add(k);
        f.edges.push({ from: e.from, out: Math.max(0, Math.min(30, Number(e.out) || 0)), to: e.to });
      }
    }
    if (JSON.stringify(f).length > 3e6) bad('Flow ist zu groß');
    return f;
  }

  function putFlow(def, { fromAi } = {}) {
    const old = def.id ? byId(def.id) : null;
    const f = sanitize(def, old);
    if (fromAi) {
      if (!api.config().mcpCreate) bad('Die KI darf in den Plugin-Einstellungen keine Flows ändern');
      for (const n of f.nodes) { const d = registry.get(n.type); if (!d) bad(`Unbekannter Knotentyp „${n.type}“`); if (d.noMcp) bad(`Knoten „${d.label}“ darf nur von dir selbst angelegt werden`); }
      f.enabled = false;                   // die KI schaltet nie ein
    }
    if (old) {
      const rev = api.kv.get('rev:' + f.id) || []; rev.unshift({ ts: Date.now(), def: old, by: fromAi ? 'KI' : 'Editor' }); api.kv.set('rev:' + f.id, rev.slice(0, 10));
      flows[flows.indexOf(old)] = f;
    } else flows.push(f);
    save(); engine.upsert(f);
    return f;
  }

  // ---------- Erweiterungspunkte für andere Plugins ----------
  api.expose({
    version: 1,
    registerNode(def, owner) { registry.add(def, 'plugin:' + (owner || 'unbekannt')); api.emit({ t: 'catalog' }); },
    unregisterNodes(owner) { registry.removeOwner('plugin:' + (owner || 'unbekannt')); api.emit({ t: 'catalog' }); },
    run: (flowId, msg) => engine.run(flowId, { msg, why: 'Plugin' }).done.then((e) => ({ status: e.status, result: e.result })),
    list: () => flows.map((f) => ({ id: f.id, name: f.name, enabled: f.enabled })),
  });

  // ---------- Geräte-Ereignisse + Webhooks ----------
  api.devices.onState((dev, st, prev) => engine.onDeviceState(dev, st, prev));
  api.http.on((req) => engine.handleHook(req));
  api.devices.onCommand((dev, action) => {
    if (action === 'on' || action === 'off' || action === 'toggle') { const on = action === 'toggle' ? !(dev.state_raw && dev.state_raw.on) : action === 'on'; api.devices.setState(dev.key, { on }); return; }
    throw new Error('Aktion nicht unterstützt: ' + action);
  });

  engine.loadAll(flows);

  // ---------- Oberfläche ----------
  const q = (ctx, k) => ctx.url.searchParams.get(k);
  const dynCatalog = () => {
    const cat = registry.catalog();
    let core = [];
    try { core = api.core ? api.core.tools().map((t) => t.name) : []; } catch { /* ignorieren */ }
    for (const c of cat) for (const f of c.fields || []) if (f.dynOptions === 'coretools') f.options = core;
    return cat;
  };
  api.route('GET', 'catalog', () => ({ nodes: dynCatalog(), categories: CATS, fileErrors: registry.errors, nodesDir, core: !!api.core }));
  api.route('GET', 'flows', () => ({ flows, status: engine.status() }));
  api.route('POST', 'flow', (ctx) => { const f = putFlow(ctx.body && ctx.body.flow); return { flow: f }; });
  api.route('DELETE', 'flow/:id', (ctx) => { const f = byId(ctx.params.id); if (!f) bad('Flow nicht gefunden'); engine.remove(f.id); flows = flows.filter((x) => x !== f); save(); api.kv.set('rev:' + f.id, []); });
  api.route('POST', 'flow/:id/enable', (ctx) => { const f = byId(ctx.params.id); if (!f) bad('Flow nicht gefunden'); f.enabled = !!(ctx.body && ctx.body.enabled); save(); engine.upsert(f); return { enabled: f.enabled, errors: engine.status().find((s) => s.id === f.id).errors }; });
  api.route('POST', 'flow/:id/run', async (ctx) => {
    const b = ctx.body || {}; const ex = engine.run(ctx.params.id, { nodeId: b.node, msg: b.msg, why: 'Testlauf' });
    await Promise.race([ex.done, new Promise((r) => setTimeout(r, 20000))]);
    return { id: ex.id, status: ex.status, ms: ex.ms, errors: ex.errors };
  });
  api.route('POST', 'flow/:id/node/:nid/test', async (ctx) => engine.testNode(ctx.params.id, ctx.params.nid, (ctx.body && ctx.body.msg) || { payload: null }));
  api.route('GET', 'flow/:id/revisions', (ctx) => ({ revisions: (api.kv.get('rev:' + ctx.params.id) || []).map((r, i) => ({ i, ts: r.ts, by: r.by, name: r.def.name, nodes: r.def.nodes.length })) }));
  api.route('POST', 'flow/:id/restore', (ctx) => { const rev = (api.kv.get('rev:' + ctx.params.id) || [])[Number(ctx.body && ctx.body.i)]; if (!rev) bad('Version nicht gefunden'); const d = clone(rev.def); d.enabled = false; return { flow: putFlow(d) }; });
  api.route('GET', 'history', (ctx) => ({ history: engine.history(q(ctx, 'flow'), Number(q(ctx, 'n')) || 60) }));
  api.route('GET', 'history/:id', (ctx) => { const e = engine.execById(ctx.params.id); if (!e) bad('Lauf nicht mehr vorhanden'); return { exec: { id: e.id, flow: e.flow, flowName: e.flowName, trigger: e.trigger, t0: e.t0, ms: e.ms, status: e.status, steps: e.steps, errors: e.errors, why: e.why, trace: e.trace, truncated: e.truncated } }; });
  api.route('DELETE', 'history', (ctx) => { engine.clearHistory(q(ctx, 'flow')); });
  api.route('GET', 'debug', () => ({ list: engine.debugList() }));
  api.route('DELETE', 'debug', () => { engine.clearDebug(); });
  api.route('GET', 'context', () => engine.contexts());
  api.route('POST', 'context', (ctx) => { const b = ctx.body || {}; if (!['global', 'flow'].includes(b.scope) || !String(b.key || '').trim()) bad('Angaben unvollständig'); engine.setContext(b.scope, b.flow, String(b.key), b.delete ? undefined : b.value); });
  api.route('POST', 'expr', (ctx) => {
    const b = ctx.body || {}; const sc = engine.scopeOf({ id: b.flow || '', def: { name: '' } }, null, b.msg && typeof b.msg === 'object' ? b.msg : { payload: b.msg });
    try { const v = expr.interpolate(String(b.expr || ''), sc); return { ok: true, value: v === undefined ? null : v, type: typeof v }; } catch (e) { return { ok: false, error: e.message }; }
  });
  api.route('GET', 'info', () => ({ hook: api.http.url().path, nodesDir, mqtt: api.mqtt.connected(), core: !!api.core, revision: 1 }));
  api.route('POST', 'hook/regenerate', () => api.http.regenerate());
  api.route('POST', 'reload-nodes', () => { loadFiles(); engine.reactivateAll(); api.emit({ t: 'catalog' }); return { errors: registry.errors }; });
  api.route('POST', 'import', (ctx) => {
    const b = ctx.body || {}; let d = b.flow; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { bad('Kein gültiges JSON'); } }
    if (!d || !Array.isArray(d.nodes)) bad('Das ist kein HomeLite-Flow (Feld „nodes“ fehlt)');
    d = clone(d); delete d.id; d.enabled = false; d.name = d.name || 'Importierter Flow';
    return { flow: putFlow(d) };
  });

  // ---------- KI-Werkzeuge (nur am eigenen Endpunkt und im MCP von HomeLite) ----------
  const summary = (f) => ({ id: f.id, name: f.name, enabled: f.enabled, nodes: f.nodes.length, triggers: f.nodes.filter((n) => (registry.get(n.type) || {}).trigger || (registry.get(n.type) || {}).start).map((n) => n.type) });
  try {
    api.mcp.tool({ name: 'flows_node_types', description: 'Flows: Liste aller Knotentypen mit Feldern (key/type/default), Ausgängen und Beschreibung. Vor flows_save aufrufen.', readOnly: true, inputSchema: { type: 'object', properties: {} },
      run: () => dynCatalog().filter((n) => !n.noMcp).map((n) => ({ type: n.type, label: n.label, category: n.category, desc: n.desc, outputs: n.outputs, labels: n.labels, dyn: n.dyn, fields: (n.fields || []).filter((f) => f.type !== 'hookurl').map((f) => ({ key: f.key, type: f.type, label: f.label, default: f.default, options: f.options, item: f.item && f.item.map((i) => ({ key: i.key, type: i.type, options: i.options, default: i.default })) })) })) });
    api.mcp.tool({ name: 'flows_list', description: 'Flows: alle Flows (Name, an/aus, Auslöser).', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => flows.map(summary) });
    api.mcp.tool({ name: 'flows_get', description: 'Flows: kompletten Flow lesen (Knoten, Verbindungen).', readOnly: true, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, run: (a) => byId(a.id) || bad('Flow nicht gefunden') });
    api.mcp.tool({
      name: 'flows_save', description: 'Flows: Flow anlegen oder ändern (mit id = ändern). nodes: [{id,type,name,x,y,cfg}], edges: [{from,out,to}] (out = Nummer des Ausgangs ab 0). Neue/geänderte Flows sind IMMER ausgeschaltet; der Nutzer schaltet sie selbst ein. Ausdrücke in Feldern: {{ payload.x }}.', control: true,
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, nodes: { type: 'array', items: { type: 'object' } }, edges: { type: 'array', items: { type: 'object' } }, settings: { type: 'object' }, note: { type: 'string' } }, required: ['name', 'nodes'] },
      run: (a) => summary(putFlow(a, { fromAi: true })),
    });
    api.mcp.tool({ name: 'flows_run', description: 'Flows: einen Flow einmal ausführen (Testlauf) und das Ergebnis lesen. Führt echte Aktionen aus!', control: true, inputSchema: { type: 'object', properties: { id: { type: 'string' }, payload: {} }, required: ['id'] },
      run: async (a) => { const ex = engine.run(a.id, { msg: { payload: a.payload === undefined ? null : a.payload }, why: 'KI' }); await Promise.race([ex.done, new Promise((r) => setTimeout(r, 15000))]); return { id: ex.id, status: ex.status, ms: ex.ms, errors: ex.errors }; } });
    api.mcp.tool({ name: 'flows_history', description: 'Flows: letzte Läufe (optional eines Flows) mit Fehlern; mit exec_id den Ablauf je Knoten.', readOnly: true, inputSchema: { type: 'object', properties: { flow: { type: 'string' }, exec_id: { type: 'string' } } },
      run: (a) => { if (a.exec_id) { const e = engine.execById(a.exec_id); return e ? { id: e.id, status: e.status, errors: e.errors, trace: e.trace.map((t) => ({ node: t.name, ms: t.ms, in: t.in, out: t.out, err: t.err })) } : 'nicht gefunden'; } return engine.history(a.flow, 20); } });
  } catch (e) { api.log('warn', 'KI-Werkzeuge nicht registriert: ' + e.message); }

  return {
    stop() { engine.stopAll(); engine.stopTimers(); },
  };
};
