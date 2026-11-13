'use strict';
// Flow-Engine: Nachrichten (msg) laufen von Knoten zu Knoten – mit Ausdrücken {{ }}, Fehlerbehandlung,
// Wiederholungen, parallelen Zweigen, Unterflows und Ausführungsverlauf.
const expr = require('./expr');

const MAX_STEPS = 5000;
const MAX_PARALLEL = 50;
class Abort extends Error {}
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clone = (o) => { if (o === undefined) return undefined; try { return JSON.parse(JSON.stringify(o)); } catch { return {}; } };
const preview = (v, n = 1200) => { let s; try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); } if (s === undefined) s = 'undefined'; return s.length > n ? s.slice(0, n) + '…' : s; };
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const nodeName = (n, def) => n.name || (def && def.label) || n.type;

// Rückgabe eines Knotens -> Liste je Ausgang, jeder Eintrag: Liste von Nachrichten
function normalizePorts(res) {
  if (res === undefined || res === null) return [];
  const arr = Array.isArray(res) ? res : [res];
  return arr.map((x) => (x === undefined || x === null ? [] : (Array.isArray(x) ? x : [x]).filter((m) => m !== undefined && m !== null).map((m) => (isObj(m) ? m : { payload: m }))));
}

function countOutputs(def, cfg) {
  if (!def) return 1;
  let n = def.outputs === undefined ? 1 : def.outputs;
  if (def.dyn && def.dyn.fixedKey) n = Math.max(1, Math.min(10, Number((cfg || {})[def.dyn.fixedKey]) || 1));
  else if (def.dyn) n = Math.max(1, ((cfg || {})[def.dyn.list] || []).length + ((cfg || {})[def.dyn.elseKey] ? 1 : 0));
  return n;
}

function createEngine({ api, registry }) {
  const log = (lvl, m) => api.log(lvl, m);
  const rts = new Map();
  const hist = [];                 // neueste zuerst
  const debugBuf = [];
  const cancels = new Set();       // laufende Wartezustände (für Abbruch)
  let ctxData = (() => { const v = api.kv.get('ctx'); return v && typeof v === 'object' ? { global: v.global || {}, flows: v.flows || {} } : { global: {}, flows: {} }; })();
  let ctxSaved = JSON.stringify(ctxData);
  let nodeEvents = [];
  let nodeTimer = null;
  let booting = true;
  const deviceListeners = new Set();
  const hooks = new Map();         // "METHOD pfad" -> { handler, rt }
  let devCache = { t: 0, list: [] };
  const settings = () => api.config();

  for (const h of (api.kv.get('history') || [])) hist.push(h);

  // ---------- Kontext (flow / global) ----------
  const flowCtx = (id) => (ctxData.flows[id] = ctxData.flows[id] || {});
  const globalCtx = () => ctxData.global;
  function saveCtx() {
    const s = JSON.stringify(ctxData);
    if (s !== ctxSaved && s.length < 2e6) { api.kv.set('ctx', ctxData); ctxSaved = s; }
  }
  const ctxTimer = api.timer(saveCtx, 10000);
  let histDirty = false;
  const histTimer = api.timer(() => { if (histDirty) { histDirty = false; api.kv.set('history', hist.slice(0, 40).map(slim)); } }, 5000);
  const slim = (e) => ({ ...e, trace: (e.trace || []).slice(0, 150) });

  // ---------- Hilfen ----------
  function devices() {
    if (Date.now() - devCache.t > 1000) devCache = { t: Date.now(), list: api.devices.all().map((d) => ({ id: d.id, name: d.name, room: d.room, type: d.type, state: d.state_raw, text: d.state })) };
    return devCache.list;
  }
  function scopeOf(rt, exec, msg) {
    return {
      msg, flow: flowCtx(rt.id), global: globalCtx(), exec: { id: exec ? exec.id : '', flow: rt.id }, flowName: rt.def.name,
      devices, sun: () => { const s = api.sun(); return s ? { sunrise: s.sunrise.toISOString(), sunset: s.sunset.toISOString() } : null; },
      node: () => { const o = {}; if (exec) for (const [name, v] of Object.entries(exec.outByName)) o[name] = v; return o; },
    };
  }

  function resolveFields(fields, raw, scope) {
    const out = { ...raw };
    for (const f of fields || []) {
      let v = raw[f.key];
      if (v === undefined) v = f.default;
      if (f.raw || f.type === 'code') { out[f.key] = v; continue; }
      if (f.type === 'list') {
        out[f.key] = (Array.isArray(v) ? v : []).map((row) => resolveFields(f.item, row || {}, scope));
      } else if (typeof v === 'string' && ['text', 'textarea', 'json', 'combo', 'device'].includes(f.type)) out[f.key] = expr.interpolate(v, scope);
      else out[f.key] = v;
    }
    return out;
  }

  function sleepFor(rt, ms) {
    return cancellable(rt, (resolve) => { const t = setTimeout(resolve, Math.max(0, ms)); return () => clearTimeout(t); });
  }
  // Wartezustand, der beim Stoppen des Flows abgebrochen wird. setup(resolve, reject) -> Aufräumfunktion
  function cancellable(rt, setup) {
    return new Promise((resolve, reject) => {
      let off = () => {};
      const c = { cancel: () => { off(); reject(new Abort()); }, rt };
      const done = (fn) => (v) => { cancels.delete(c); off(); fn(v); };
      off = setup(done(resolve), done(reject)) || (() => {});
      cancels.add(c);
    });
  }

  // ---------- Status-/Ereignisse an die Oberfläche ----------
  function nodeEvent(rt, nodeId, s, ms) {
    nodeEvents.push({ f: rt.id, n: nodeId, s, ms });
    if (!nodeTimer) nodeTimer = api.after(() => { nodeTimer = null; const l = nodeEvents; nodeEvents = []; api.emit({ t: 'nodes', list: l.slice(-300) }); }, 120);
  }
  function debug(rt, exec, node, def, value, label) {
    const e = { ts: Date.now(), flow: rt.id, flowName: rt.def.name, node: node.id, name: nodeName(node, def), label: label || '', value: preview(value, 4000), exec: exec ? exec.id : '' };
    debugBuf.push(e); if (debugBuf.length > 200) debugBuf.shift();
    api.emit({ t: 'debug', e });
  }

  // ---------- Ausführung ----------
  function newExec(rt, startNode, opts) {
    return {
      id: uid(), flow: rt.id, flowName: rt.def.name, gen: rt.gen, trigger: { id: startNode.id, name: nodeName(startNode, registry.get(startNode.type)) }, t0: Date.now(), ms: 0,
      status: 'running', steps: 0, trace: [], outByName: {}, scratch: new Map(), holds: 0, waiters: [], depth: opts.depth || 0, parent: opts.parent || '', why: opts.why || '',
      errors: [], failed: false, handled: false, result: undefined, lastMsg: undefined, dry: !!opts.dry, dryOut: [], truncated: false,
      respondP: null, respond: null,
    };
  }
  const summary = (e) => ({ id: e.id, flow: e.flow, flowName: e.flowName, trigger: e.trigger, t0: e.t0, ms: e.ms, status: e.status, steps: e.steps, errors: e.errors, why: e.why, parent: e.parent });

  function start(rt, node, msg, opts = {}) {
    const conc = (rt.def.settings && rt.def.settings.concurrency) || 'parallel';
    const exec = newExec(rt, node, opts);
    exec.respondP = new Promise((r) => { exec.respond = (v) => { exec.respond = () => {}; r(v); }; });
    if (opts.dry) { exec.done = runExec(rt, exec, node, msg, opts); return exec; }
    if (conc === 'skip' && rt.running + rt.queued > 0) { exec.status = 'skipped'; exec.done = Promise.resolve(exec); finishRecord(rt, exec); return exec; }
    if (rt.running + rt.queued >= MAX_PARALLEL) { exec.status = 'error'; exec.errors.push({ node: '', name: '', message: 'Zu viele gleichzeitige Läufe' }); exec.done = Promise.resolve(exec); finishRecord(rt, exec); return exec; }
    const gate = conc === 'queue' ? rt.tail : Promise.resolve();
    rt.queued++;
    exec.done = gate.then(() => { rt.queued--; return runExec(rt, exec, node, msg, opts); });
    rt.tail = exec.done.catch(() => {});
    return exec;
  }

  async function runExec(rt, exec, node, msg, opts) {
    rt.running++;
    exec.t0 = Date.now();
    if (!exec.dry) api.emit({ t: 'exec', e: summary(exec) });
    try { await walk(rt, exec, node, msg, null, false); } catch (e) { if (!(e instanceof Abort)) { exec.failed = true; exec.errors.push({ node: '', name: '', message: e.message }); } else exec.aborted = true; }
    while (exec.holds > 0) await new Promise((r) => exec.waiters.push(r));
    rt.running--;
    exec.ms = Date.now() - exec.t0;
    exec.status = exec.aborted && !exec.failed ? 'stopped' : exec.failed ? (exec.handled ? 'handled' : 'error') : 'ok';
    if (exec.respond) exec.respond(exec.failed && !exec.handled ? { status: 500, body: { error: (exec.errors[0] || {}).message || 'Fehler' } } : { status: 200, body: { ok: true } });
    if (!exec.dry) finishRecord(rt, exec);
    return exec;
  }

  function finishRecord(rt, exec) {
    hist.unshift(exec);
    if (hist.length > 200) hist.length = 200;
    for (let i = 40; i < hist.length; i++) if (hist[i].trace && hist[i].trace.length) hist[i].trace = [];
    histDirty = true;
    api.emit({ t: 'exec', e: summary(exec) });
    if (exec.status === 'error') {
      log('warn', `Flow „${rt.def.name}“: ${(exec.errors[0] || {}).message || 'Fehler'}`);
      if (rt.def.settings && rt.def.settings.notifyOnError) { try { api.notify(`Flow „${rt.def.name}“ fehlgeschlagen`, `${(exec.errors[0] || {}).name ? exec.errors[0].name + ': ' : ''}${(exec.errors[0] || {}).message || ''}`); } catch { /* ignorieren */ } }
    }
  }

  async function walk(rt, exec, node, msg, from, inCatch) {
    if (rt.gen !== exec.gen || exec.aborted) throw new Abort();
    if (++exec.steps > MAX_STEPS) { exec.aborted = true; throw new Error(`Mehr als ${MAX_STEPS} Schritte in einem Lauf – Endlosschleife?`); }
    const def = registry.get(node.type);
    const entry = { i: exec.trace.length, node: node.id, name: nodeName(node, def), type: node.type, t: Date.now() - exec.t0, ms: 0, in: preview(msg, 700), out: [], err: '' };
    if (exec.trace.length < 400) exec.trace.push(entry); else exec.truncated = true;
    nodeEvent(rt, node.id, 'run');
    const t0 = Date.now();
    let res, err = null;
    if (node.disabled) res = msg;
    else if (!def) err = new Error(`Unbekannter Knotentyp „${node.type}“ (Erweiterung nicht installiert?)`);
    else {
      const tries = 1 + Math.min(5, Math.max(0, Number(node.retries) || 0));
      for (let a = 1; a <= tries; a++) {
        try {
          const c = makeCtx(rt, exec, node, def, msg, from, inCatch);
          const p = def.run ? def.run(c, msg) : msg;
          const lim = def.noTimeout ? 0 : (node.timeout !== undefined && node.timeout !== '' ? Number(node.timeout) * 1000 : 60000);
          res = lim > 0 ? await Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error(`Zeitüberschreitung nach ${lim / 1000} s`)), lim); if (p && p.finally) p.finally(() => clearTimeout(t)); })]) : await p;
          err = null; break;
        } catch (e) {
          if (e instanceof Abort) throw e;
          err = e; entry.retries = a - 1;
          if (a < tries) { entry.err = `Versuch ${a}: ${e.message}`; await sleepFor(rt, Math.max(0, Number(node.retryDelay) || 1000)); }
        }
      }
    }
    entry.ms = Date.now() - t0;
    if (err) {
      entry.err = err.message || String(err);
      nodeEvent(rt, node.id, 'err', entry.ms);
      const info = { node: node.id, name: entry.name, type: node.type, message: entry.err };
      if (node.onError === 'continue') res = { ...msg, error: info };
      else if (node.onError === 'port') { const port = countOutputs(def, resolveCount(node)); res = new Array(port).fill(null); res.push({ ...msg, error: info }); }
      else {
        exec.failed = true; exec.errors.push(info);
        if (!inCatch) await raise(rt, exec, node, def, info, msg);
        return;
      }
    } else nodeEvent(rt, node.id, 'ok', entry.ms);
    const ports = normalizePorts(res);
    const kids = [];
    ports.forEach((list, p) => {
      for (const m of list) {
        entry.out.push(`${p + 1}: ${preview(m, 500)}`);
        exec.lastMsg = m;
        exec.outByName[entry.name] = { payload: m.payload, msg: clone(m) };
        kids.push(dispatch(rt, exec, node, p, m, inCatch));
      }
    });
    const rs = await Promise.allSettled(kids);
    for (const r of rs) if (r.status === 'rejected' && r.reason instanceof Abort) throw r.reason;
  }
  const resolveCount = (node) => node.cfg || {};

  function dispatch(rt, exec, node, port, msg, inCatch) {
    const targets = rt.edges.get(node.id + ':' + port) || [];
    if (exec.dry) { exec.dryOut.push({ port, msg: clone(msg) }); return Promise.resolve(); }
    return Promise.all(targets.map((tid, i) => {
      const t = rt.nodes.get(tid);
      return t ? walk(rt, exec, t, targets.length > 1 || i > 0 ? clone(msg) : msg, node.id, inCatch) : null;
    }));
  }

  async function raise(rt, exec, node, def, info, msg) {
    const hay = `${info.name} ${info.type}`.toLowerCase();
    const catches = [...rt.nodes.values()].filter((n) => n.type === 'catch' && !n.disabled && (!(n.cfg && n.cfg.only) || String(n.cfg.only).toLowerCase().split(',').some((s) => s.trim() && hay.includes(s.trim()))));
    if (!catches.length) return;
    exec.handled = true;
    for (const c of catches) {
      try { await walk(rt, exec, c, { payload: msg && msg.payload, topic: msg && msg.topic, error: info, original: clone(msg) }, node.id, true); } catch (e) { if (e instanceof Abort) throw e; }
    }
  }

  function makeCtx(rt, exec, node, def, msg, from, inCatch) {
    const scope = scopeOf(rt, exec, msg);
    const st = rt.state.get(node.id) || rt.state.set(node.id, {}).get(node.id);
    const cfg = resolveFields(def.fields, node.cfg || {}, scope);
    const c = {
      api, cfg, raw: node.cfg || {}, node, def, exec, flow: { id: rt.id, name: rt.def.name }, from, state: st,
      sources: rt.incoming.get(node.id) || [], settings: settings(),
      get scratch() { return exec.scratch.get(node.id) || exec.scratch.set(node.id, {}).get(node.id); },
      log: (m, lvl) => log(lvl || 'info', `Flow „${rt.def.name}“ · ${nodeName(node, def)}: ${m}`),
      debug: (v, label) => debug(rt, exec, node, def, v, label),
      scope: (m) => scopeOf(rt, exec, m || msg),
      val: (s, m) => expr.value(s, scopeOf(rt, exec, m || msg)),
      expr: (s, m) => expr.evalExpr(s, scopeOf(rt, exec, m || msg)),
      interp: (s, m) => expr.interpolate(s, scopeOf(rt, exec, m || msg)),
      flowCtx: flowCtx(rt.id), globalCtx: globalCtx(),
      sleep: (ms) => sleepFor(rt, ms),
      cancellable: (setup) => cancellable(rt, setup),
      hold: () => { exec.holds++; let done = false; return () => { if (done) return; done = true; exec.holds--; if (exec.holds <= 0) { const w = exec.waiters.splice(0); w.forEach((r) => r()); } }; },
      send: (port, m) => dispatch(rt, exec, node, port, isObj(m) ? m : { payload: m }, inCatch),
      onDevice: (fn) => { deviceListeners.add(fn); return () => deviceListeners.delete(fn); },
      respond: (r) => exec.respond && exec.respond(r),
      setResult: (m) => { exec.result = m; },
      runFlow: (flowId, m) => callFlow(exec, flowId, m),
      devices,
    };
    return c;
  }

  async function callFlow(parent, flowId, msg) {
    const rt2 = rts.get(flowId);
    if (!rt2) throw new Error('Unterflow nicht gefunden');
    if (parent.depth >= 8) throw new Error('Unterflows zu tief verschachtelt (max. 8)');
    const inp = [...rt2.nodes.values()].filter((n) => n.type === 'flow-in' && !n.disabled);
    if (!inp.length) throw new Error(`Flow „${rt2.def.name}“ hat keinen „Unterflow-Eingang“`);
    const execs = inp.map((n) => start(rt2, n, clone(msg), { parent: parent.id, depth: parent.depth + 1, why: `Aufruf aus „${parent.flowName}“` }));
    await Promise.all(execs.map((e) => e.done));
    const bad = execs.find((e) => e.failed && !e.handled);
    if (bad) throw new Error(`Unterflow „${rt2.def.name}“: ${(bad.errors[0] || {}).message || 'Fehler'}`);
    const withRes = execs.find((e) => e.result !== undefined);
    return withRes ? withRes.result : msg;
  }

  // ---------- Flows laden/aktivieren ----------
  function build(def) {
    const rt = { id: def.id, def, nodes: new Map(), edges: new Map(), incoming: new Map(), state: new Map(), stops: [], active: false, gen: 0, running: 0, queued: 0, tail: Promise.resolve(), errors: new Map() };
    for (const n of def.nodes || []) rt.nodes.set(n.id, n);
    for (const e of def.edges || []) {
      if (!rt.nodes.has(e.from) || !rt.nodes.has(e.to)) continue;
      const k = e.from + ':' + (e.out || 0);
      (rt.edges.get(k) || rt.edges.set(k, []).get(k)).push(e.to);
      (rt.incoming.get(e.to) || rt.incoming.set(e.to, []).get(e.to)).push(e.from);
    }
    return rt;
  }

  function triggerCtx(rt, node, def) {
    const stop = (fn) => rt.stops.push(fn);
    const st = rt.state.get(node.id) || rt.state.set(node.id, {}).get(node.id);
    const c = {
      api, cfg: node.cfg || {}, node, flow: { id: rt.id, name: rt.def.name }, state: st, boot: booting,
      log: (m, lvl) => log(lvl || 'info', `Flow „${rt.def.name}“ · ${nodeName(node, def)}: ${m}`),
      emit: (msg, opts) => start(rt, node, isObj(msg) ? msg : { payload: msg }, opts || {}),
      timer: (fn, ms) => { const off = api.timer(fn, ms); stop(off); return off; },
      after: (fn, ms) => { const off = api.after(fn, ms); stop(off); return off; },
      onDevice: (fn) => { deviceListeners.add(fn); const off = () => deviceListeners.delete(fn); stop(off); return off; },
      mqtt: (filter, cb) => { const off = api.mqtt.subscribe(filter, cb); stop(off); return off; },
      hook: (method, path, handler) => {
        const p = String(path || '').replace(/^\/+|\/+$/g, '');
        const k = `${String(method || 'POST').toUpperCase()} ${p}`;
        if (hooks.has(k) && hooks.get(k).rt !== rt) throw new Error(`Webhook-Pfad „${p}“ wird bereits von einem anderen Flow verwendet`);
        hooks.set(k, { handler, rt });
        stop(() => { if (hooks.get(k) && hooks.get(k).rt === rt) hooks.delete(k); });
      },
      devices,
    };
    return c;
  }

  function activate(rt) {
    if (rt.active) return;
    rt.active = true;
    for (const node of rt.nodes.values()) {
      const def = registry.get(node.type);
      if (!def || !def.start || node.disabled) continue;
      try { def.start(triggerCtx(rt, node, def)); } catch (e) { rt.errors.set(node.id, e.message); log('warn', `Flow „${rt.def.name}“: Auslöser „${nodeName(node, def)}“ nicht gestartet – ${e.message}`); }
    }
  }
  function deactivate(rt) {
    rt.active = false;
    rt.gen++;
    for (const f of rt.stops.splice(0)) { try { f(); } catch { /* ignorieren */ } }
    for (const c of [...cancels]) if (c.rt === rt) c.cancel();
  }

  function upsert(def) {
    const old = rts.get(def.id);
    if (old) deactivate(old);
    const rt = build(def);
    if (old) rt.gen = old.gen + 1;
    rts.set(def.id, rt);
    if (def.enabled) activate(rt);
    return rt;
  }
  function remove(id) {
    const rt = rts.get(id);
    if (rt) deactivate(rt);
    rts.delete(id);
    delete ctxData.flows[id];
  }
  function loadAll(defs) { for (const d of defs) upsert(d); booting = false; }
  function reactivateAll() { for (const rt of rts.values()) if (rt.def.enabled) { deactivate(rt); activate(rt); } }
  function stopAll() { for (const rt of rts.values()) deactivate(rt); saveCtx(); api.kv.set('history', hist.slice(0, 40).map(slim)); }

  // ---------- Externe Aufrufe ----------
  function run(flowId, { nodeId, msg, why } = {}) {
    const rt = rts.get(flowId);
    if (!rt) throw new Error('Flow nicht gefunden');
    let node = nodeId ? rt.nodes.get(nodeId) : [...rt.nodes.values()].find((n) => n.type === 'trigger-manual' && !n.disabled);
    if (!node) node = [...rt.nodes.values()].find((n) => (registry.get(n.type) || {}).start && !n.disabled);
    if (!node) throw new Error('Der Flow hat keinen Auslöser, der gestartet werden kann');
    return start(rt, node, isObj(msg) ? msg : { payload: msg === undefined ? null : msg }, { why: why || 'Manuell' });
  }
  async function testNode(flowId, nodeId, msg) {
    const rt = rts.get(flowId);
    const node = rt && rt.nodes.get(nodeId);
    if (!node) throw new Error('Knoten nicht gefunden');
    const exec = start(rt, node, isObj(msg) ? msg : { payload: msg }, { dry: true, why: 'Test' });
    await exec.done;
    return { ms: exec.ms, outputs: exec.dryOut, error: exec.errors[0] || null, trace: exec.trace[0] || null };
  }

  function onDeviceState(dev, st, prev) { for (const fn of [...deviceListeners]) { try { fn(dev, st, prev); } catch (e) { log('warn', 'Geräte-Auslöser: ' + e.message); } } }
  async function handleHook(req) {
    const p = String(req.sub || '').replace(/^\/+|\/+$/g, '');
    const h = hooks.get(`${req.method} ${p}`) || hooks.get(`ANY ${p}`);
    if (!h) return { status: 404, body: { error: 'Kein Flow lauscht auf diesem Pfad' } };
    return h.handler(req);
  }

  const status = () => [...rts.values()].map((rt) => ({ id: rt.id, active: rt.active, running: rt.running, errors: Object.fromEntries(rt.errors) }));
  function history(flow, n) { return hist.filter((e) => !flow || e.flow === flow).slice(0, n || 60).map(summary); }
  const execById = (id) => hist.find((e) => e.id === id);
  function clearHistory(flow) { for (let i = hist.length - 1; i >= 0; i--) if (!flow || hist[i].flow === flow) hist.splice(i, 1); api.kv.set('history', hist.slice(0, 40).map(slim)); }
  const debugList = () => debugBuf.slice(-200);
  const clearDebug = () => { debugBuf.length = 0; };
  function contexts() { return { global: ctxData.global, flows: ctxData.flows }; }
  function setContext(scope, flowId, key, value) { const o = scope === 'global' ? ctxData.global : flowCtx(flowId); if (value === undefined) delete o[key]; else o[key] = value; saveCtx(); }

  function stopTimers() { ctxTimer(); histTimer(); }

  return { upsert, remove, loadAll, reactivateAll, stopAll, stopTimers, run, testNode, onDeviceState, handleHook, status, history, execById, clearHistory, debugList, clearDebug, contexts, setContext, rts, scopeOf, countOutputs, normalizePorts, clone, preview, Abort, uid, saveCtx };
}

module.exports = { createEngine, normalizePorts, countOutputs, clone, preview, isObj, uid, Abort };
