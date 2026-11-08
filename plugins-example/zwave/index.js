'use strict';
// Z-Wave über zwave-js-server (WebSocket, eingebauter WebSocket-Client von Node ≥ 22; keine Abhängigkeiten).
// Z-Wave JS UI / zwave-js-server verwaltet den USB-Stick; HomeLite bildet die Knoten als Geräte ab.

const CC = { BINARY_SWITCH: 37, MULTILEVEL_SWITCH: 38, BINARY_SENSOR: 48, MULTILEVEL_SENSOR: 49, METER: 50, THERMOSTAT_SETPOINT: 67, DOOR_LOCK: 98, NOTIFICATION: 113, BATTERY: 128, CENTRAL_SCENE: 91 };
const MAX_SCHEMA = 35;
const STRATEGY = { default: 0, insecure: 2, s0: 3 };
const SENSOR_DE = { 'Air temperature': 'Temperatur', Humidity: 'Luftfeuchte', Illuminance: 'Helligkeit', Power: 'Leistung', Voltage: 'Spannung', Current: 'Strom', 'Ultraviolet': 'UV', 'Carbon dioxide (CO₂) level': 'CO₂', 'Atmospheric pressure': 'Luftdruck', 'Soil temperature': 'Bodentemperatur', 'Dew point': 'Taupunkt' };
const UNIT = { Lux: 'lx', lux: 'lx', '% (percentage value)': '%' };
// Benachrichtigungen (CC 113) → Binärsensor
const NOTIF = [
  { type: 'Home Security', key: 'Motion sensor status', name: 'Bewegung', on: [7, 8] },
  { type: 'Home Security', key: 'Cover status', name: 'Sabotage', on: [3] },
  { type: 'Access Control', key: 'Door state (simple)', name: 'Tür/Fenster', on: [22] },
  { type: 'Smoke Alarm', key: 'Sensor status', name: 'Rauch', on: [1, 2] },
  { type: 'CO Alarm', key: 'Sensor status', name: 'CO', on: [1, 2] },
  { type: 'Water Alarm', key: 'Sensor status', name: 'Wasser', on: [1, 2] },
];
const SCENE = { 0: 'pressed', 1: 'released', 2: 'held', 3: 'double', 4: 'triple', 5: 'quadruple', 6: 'quintuple' };

module.exports = (api) => {
  let ws = null, retry = null, stopped = false, backoff = 3000;
  let connected = false, ready = false, error = '', info = {};
  let msgId = 0; const pending = new Map();
  const nodes = new Map();           // nodeId -> { id, name, location, status, ready, label, lastSeen, values: Map }
  const specs = new Map();           // Geräte-Schlüssel -> { nodeId, write(action, value) }
  let mode = { kind: '', ends: 0, strategy: '' };   // inclusion / exclusion
  let modeOff = null;

  const vkey = (v) => `${v.commandClass}|${v.endpoint || 0}|${v.property}|${v.propertyKey === undefined || v.propertyKey === null ? '' : v.propertyKey}`;
  const vget = (n, cc, ep, prop, pk) => { const r = n.values.get(`${cc}|${ep}|${prop}|${pk === undefined ? '' : pk}`); return r; };
  const room = (n) => (n.location || api.config().room || '');
  const baseName = (n) => n.name || `${n.label || 'Z-Wave'} ${n.id}`;
  const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) * 100 / 99)));

  // ---------- Knoten → Geräte ----------
  function build(n) {
    const out = [];
    const eps = [...new Set([...n.values.values()].map((v) => v.endpoint || 0))].sort((a, b) => a - b);
    for (const ep of eps) {
      const sfx = ep > 0 ? ` ${ep}` : '';
      const base = baseName(n) + sfx;
      const k = (s) => `zw:${n.id}:${ep}:${s}`;
      const online = () => n.status !== 'Dead';
      const send = (cc, prop, pk, val) => setValue(n.id, { commandClass: cc, endpoint: ep, property: prop, ...(pk !== undefined ? { propertyKey: pk } : {}) }, val);
      const has = (cc, prop, pk) => vget(n, cc, ep, prop, pk);

      // Schalter / Dimmer
      const ml = has(CC.MULTILEVEL_SWITCH, 'currentValue');
      const bs = has(CC.BINARY_SWITCH, 'currentValue');
      const mlT = has(CC.MULTILEVEL_SWITCH, 'targetValue');
      const bsT = has(CC.BINARY_SWITCH, 'targetValue');
      if (ml && mlT && mlT.metadata && mlT.metadata.writeable !== false) {
        out.push({
          key: k('light'), name: base, type: 'light',
          state: () => { const v = ml.value; if (v === undefined || v === null) return null; return { on: Number(v) > 0, brightness: pct(v) }; },
          write: async (action, value) => {
            if (action === 'on') { await send(CC.MULTILEVEL_SWITCH, 'targetValue', undefined, 255); return { on: true }; }
            if (action === 'off') { await send(CC.MULTILEVEL_SWITCH, 'targetValue', undefined, 0); return { on: false, brightness: 0 }; }
            if (action === 'brightness') { const b = Math.max(0, Math.min(100, Number(value))); await send(CC.MULTILEVEL_SWITCH, 'targetValue', undefined, b === 0 ? 0 : Math.max(1, Math.round(b * 99 / 100))); return { on: b > 0, brightness: b }; }
            throw new Error('Aktion nicht unterstützt: ' + action);
          },
        });
      } else if (bs && bsT && bsT.metadata && bsT.metadata.writeable !== false) {
        out.push({
          key: k('switch'), name: base, type: 'switch',
          state: () => (bs.value === undefined || bs.value === null ? null : { on: !!bs.value }),
          write: async (action) => {
            if (action !== 'on' && action !== 'off') throw new Error('Aktion nicht unterstützt: ' + action);
            await send(CC.BINARY_SWITCH, 'targetValue', undefined, action === 'on'); return { on: action === 'on' };
          },
        });
      }
      // Türschloss
      const lock = has(CC.DOOR_LOCK, 'currentMode');
      if (lock) {
        out.push({
          key: k('lock'), name: base, type: 'lock',
          state: () => (lock.value === undefined || lock.value === null ? null : { state: lock.value === 255 ? 'locked' : lock.value === 0 ? 'unlocked' : 'unknown', on: lock.value === 255 }),
          write: async (action) => {
            const lockIt = action === 'lock' || action === 'on' ? true : action === 'unlock' || action === 'off' ? false : action === 'toggle' ? lock.value !== 255 : null;
            if (lockIt === null) throw new Error('Aktion nicht unterstützt: ' + action);
            await send(CC.DOOR_LOCK, 'targetMode', undefined, lockIt ? 255 : 0);
            return { state: lockIt ? 'locked' : 'unlocked', on: lockIt };
          },
        });
      }
      // Thermostat (Heizen-Sollwert)
      const sp = has(CC.THERMOSTAT_SETPOINT, 'setpoint', 1);
      if (sp) {
        const cur = has(CC.MULTILEVEL_SENSOR, 'Air temperature');
        out.push({
          key: k('thermostat'), name: base, type: 'thermostat',
          state: () => ({ ...(typeof sp.value === 'number' ? { setpoint: sp.value } : {}), ...(cur && typeof cur.value === 'number' ? { current: cur.value } : {}) }),
          write: async (action, value) => {
            if (action !== 'setpoint') throw new Error('Aktion nicht unterstützt: ' + action);
            const v = Number(value); if (!isFinite(v)) throw new Error('Zahl erwartet');
            await send(CC.THERMOSTAT_SETPOINT, 'setpoint', 1, v); return { setpoint: v };
          },
        });
      }
      // Multilevel-Sensoren
      for (const r of n.values.values()) {
        if ((r.endpoint || 0) !== ep || !r.metadata || r.metadata.readable === false) continue;
        if (r.commandClass === CC.MULTILEVEL_SENSOR && typeof r.value !== 'object') {
          const nm = SENSOR_DE[r.propertyName] || r.propertyName || r.metadata.label;
          const u = r.metadata.unit || '';
          out.push({ key: k('s:' + r.property), name: `${base} ${nm}`, type: 'sensor', unit: UNIT[u] || u, state: () => (r.value === undefined || r.value === null ? null : { value: r.value }) });
        } else if (r.commandClass === CC.METER && r.property === 'value') {
          const u = r.metadata.unit || '';
          const nm = (r.metadata.label || 'Zähler').replace(/\s*\[.*\]\s*$/, '').replace('Electric Consumption', 'Verbrauch').replace('Electric', '');
          out.push({ key: k('m:' + r.propertyKey), name: `${base} ${nm}${u ? ' (' + u + ')' : ''}`, type: 'sensor', unit: UNIT[u] || u, state: () => (typeof r.value === 'number' ? { value: Math.round(r.value * 1000) / 1000 } : null) });
        } else if (r.commandClass === CC.BINARY_SENSOR && typeof r.value === 'boolean') {
          const any = has(CC.BINARY_SENSOR, 'Any');
          if (any && r !== any) continue;
          out.push({ key: k('b:' + r.property), name: `${base} ${r.property === 'Any' ? 'Sensor' : r.propertyName}`, type: 'binary', state: () => (typeof r.value === 'boolean' ? { on: r.value } : null) });
        } else if (r.commandClass === CC.NOTIFICATION) {
          const def = NOTIF.find((x) => x.type === r.propertyName && x.key === r.propertyKeyName);
          if (def) out.push({ key: k('n:' + def.type + ':' + def.key), name: `${base} ${def.name}`, type: 'binary', state: () => (typeof r.value === 'number' ? { on: def.on.includes(r.value) } : null) });
        } else if (r.commandClass === CC.BATTERY && r.property === 'level' && api.config().batteries !== false) {
          out.push({ key: k('battery'), name: `${base} Batterie`, type: 'sensor', unit: '%', state: () => (typeof r.value === 'number' ? { value: r.value === 255 ? 1 : r.value } : null) });
        }
      }
      if (has(CC.CENTRAL_SCENE, 'scene', '001') || [...n.values.values()].some((r) => r.commandClass === CC.CENTRAL_SCENE && (r.endpoint || 0) === ep)) {
        out.push({ key: k('scene'), name: `${base} Taster`, type: 'event', state: () => null });
      }
    }
    return out;
  }

  function publish(n) {
    let list;
    try { list = build(n); } catch (e) { api.log('warn', `Knoten ${n.id}: ${e.message}`); return; }
    for (const s of list) {
      try {
        api.devices.ensure({ key: s.key, name: s.name, type: s.type, unit: s.unit, room: room(n) });
        specs.set(s.key, { nodeId: n.id, write: s.write });
        const st = s.state();
        if (st) api.devices.setState(s.key, { ...st, online: n.status !== 'Dead' });
        else if (s.type !== 'event') api.devices.setState(s.key, { online: n.status !== 'Dead' });
      } catch (e) { api.log('warn', `${s.key}: ${e.message}`); }
    }
  }
  function fromState(ns) {
    const prev = nodes.get(ns.nodeId);
    const n = { id: ns.nodeId, name: ns.name || '', location: ns.location || '', status: ns.status === undefined ? (prev && prev.status) : statusName(ns.status), ready: !!ns.ready, label: ns.label || (ns.deviceClass && ns.deviceClass.generic && ns.deviceClass.generic.label) || '', lastSeen: ns.lastSeen || (prev && prev.lastSeen) || null, values: new Map(), isController: !!ns.isControllerNode, battery: undefined };
    for (const v of ns.values || []) n.values.set(vkey(v), { ...v });
    const bat = [...n.values.values()].find((v) => v.commandClass === CC.BATTERY && v.property === 'level');
    if (bat && typeof bat.value === 'number') n.battery = bat.value;
    nodes.set(n.id, n);
    return n;
  }
  const statusName = (s) => (typeof s === 'number' ? ['Unknown', 'Asleep', 'Awake', 'Dead', 'Alive'][s] || 'Unknown' : s);

  function removeNode(id) {
    for (const [key, sp] of [...specs]) if (sp.nodeId === id) { try { api.devices.remove(key); } catch { /* weg */ } specs.delete(key); }
    nodes.delete(id);
  }

  // ---------- Verbindung ----------
  function send(command, args) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) return reject(new Error('Nicht mit dem Z-Wave-Server verbunden'));
      const id = String(++msgId);
      const t = setTimeout(() => { pending.delete(id); reject(new Error('Zeitüberschreitung (' + command + ')')); }, 30000);
      pending.set(id, { resolve, reject, t });
      ws.send(JSON.stringify({ messageId: id, command, ...args }));
    });
  }
  async function setValue(nodeId, valueId, value) {
    const r = await send('node.set_value', { nodeId, valueId, value });
    const res = r && r.result;
    if (res && typeof res.status === 'number' && [0, 2, 3, 4, 5].includes(res.status)) {
      throw new Error(['Gerät unterstützt den Befehl nicht', '', 'Gerät hat den Befehl abgelehnt', 'Kanal nicht gefunden', 'nicht implementiert', 'ungültiger Wert'][res.status] || 'Befehl fehlgeschlagen');
    }
    if (res && res.success === false) throw new Error('Befehl fehlgeschlagen');
    return r;
  }

  function connect() {
    clearTimeout(retry); retry = null;
    const url = String(api.config().url || '').trim();
    if (!/^wss?:\/\//i.test(url)) { error = 'Adresse fehlt oder ungültig (ws://host:3000)'; push(); return; }
    if (typeof WebSocket === 'undefined') { error = 'Node.js 22 oder neuer erforderlich (WebSocket)'; push(); return; }
    let sock;
    try { sock = new WebSocket(url); } catch (e) { error = e.message; push(); return schedule(); }
    ws = sock;
    sock.onopen = () => { api.log('info', 'Verbunden mit ' + url); backoff = 3000; };
    sock.onmessage = (ev) => { try { handle(JSON.parse(String(ev.data))); } catch (e) { api.log('warn', 'Nachricht: ' + e.message); } };
    sock.onerror = () => { if (!connected) error = 'Keine Verbindung zu ' + url; };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null; const was = connected; connected = false; ready = false;
      for (const [, p] of pending) { clearTimeout(p.t); p.reject(new Error('Verbindung getrennt')); }
      pending.clear();
      if (was) { error = 'Verbindung getrennt'; for (const n of nodes.values()) for (const [key, sp] of specs) if (sp.nodeId === n.id) { try { api.devices.setState(key, { online: false }); } catch { /* egal */ } } }
      push(); schedule();
    };
  }
  function schedule() { if (stopped) return; clearTimeout(retry); retry = setTimeout(connect, backoff); backoff = Math.min(60000, backoff * 2); }

  async function handle(m) {
    if (m.type === 'version') {
      info = { server: m.serverVersion, driver: m.driverVersion, homeId: m.homeId };
      const schema = Math.max(m.minSchemaVersion || 0, Math.min(m.maxSchemaVersion || MAX_SCHEMA, MAX_SCHEMA));
      try {
        await send('set_api_schema', { schemaVersion: schema });
        const r = await send('start_listening', {});
        const state = (r.result && r.result.state) || {};
        connected = true; ready = true; error = '';
        nodes.clear();
        for (const ns of state.nodes || []) { const n = fromState(ns); if (!n.isController) publish(n); }
        api.log('info', `${nodes.size} Knoten (Server ${info.server}, Schema ${schema})`);
        push();
      } catch (e) { error = 'Start fehlgeschlagen: ' + e.message; push(); }
      return;
    }
    if (m.type === 'result' || m.messageId) {
      const p = pending.get(String(m.messageId));
      if (!p) return;
      pending.delete(String(m.messageId)); clearTimeout(p.t);
      if (m.success === false) p.reject(new Error(m.errorCode ? `${m.errorCode}${m.zwaveErrorMessage ? ': ' + m.zwaveErrorMessage : ''}` : 'Befehl fehlgeschlagen'));
      else p.resolve(m);
      return;
    }
    if (m.type === 'event' && m.event) onEvent(m.event);
  }

  function onEvent(e) {
    const a = e.args || {};
    if (e.source === 'node') {
      const n = nodes.get(e.nodeId);
      switch (e.event) {
        case 'value updated': case 'value added': {
          if (!n) return;
          const key = vkey(a);
          const old = n.values.get(key) || {};
          n.values.set(key, { ...old, ...a, ...(a.newValue !== undefined ? { value: a.newValue } : {}), metadata: a.metadata || old.metadata });
          if (a.commandClass === CC.BATTERY && a.property === 'level' && typeof a.newValue === 'number') n.battery = a.newValue;
          n.lastSeen = new Date().toISOString();
          publish(n); push(); break;
        }
        case 'value removed': if (n) { n.values.delete(vkey(a)); } break;
        case 'metadata updated': if (n) { const r = n.values.get(vkey(a)); if (r) r.metadata = a.metadata || r.metadata; } break;
        case 'ready': { const ns = e.nodeState || a.nodeState; if (ns) { const nn = fromState(ns); publish(nn); push(); } break; }
        case 'dead': case 'alive': case 'wake up': case 'sleep': {
          if (!n) return;
          n.status = e.event === 'dead' ? 'Dead' : e.event === 'sleep' ? 'Asleep' : e.event === 'wake up' ? 'Awake' : 'Alive';
          publish(n); push(); break;
        }
        case 'value notification': {
          if (!n || a.commandClass !== CC.CENTRAL_SCENE) return;
          const key = `zw:${n.id}:${a.endpoint || 0}:scene`;
          const sc = String(parseInt(a.propertyKey, 10) || a.propertyKey);
          const kind = SCENE[a.value] || String(a.value);
          try { api.devices.setState(key, { value: `${sc}_${kind}` }); } catch { /* Gerät noch nicht angelegt */ }
          break;
        }
        case 'notification': break;
        default: break;
      }
    } else if (e.source === 'controller') {
      switch (e.event) {
        case 'node added': { const ns = a.node; if (ns) { const n = fromState(ns); api.log('info', `Knoten ${n.id} hinzugefügt`); publish(n); } push(); break; }
        case 'node removed': { const id = a.node && a.node.nodeId; if (id) { api.log('info', `Knoten ${id} entfernt`); removeNode(id); } push(); break; }
        case 'inclusion started': mode = { ...mode, kind: 'include' }; push(); break;
        case 'exclusion started': mode = { ...mode, kind: 'exclude' }; push(); break;
        case 'inclusion stopped': case 'exclusion stopped': mode = { kind: '', ends: 0, strategy: '' }; if (modeOff) { modeOff(); modeOff = null; } push(); break;
        default: break;
      }
    }
  }

  // ---------- Befehle von HomeLite ----------
  api.devices.onCommand(async (dev, action, value) => {
    const sp = specs.get(dev.key);
    if (!sp || !sp.write) throw new Error('Nicht steuerbar');
    return sp.write(action, value);
  });

  // ---------- Oberfläche ----------
  const model = () => ({
    connected, ready, error, info, url: api.config().url || '', mode: { ...mode },
    nodes: [...nodes.values()].filter((n) => !n.isController).sort((a, b) => a.id - b.id).map((n) => ({
      id: n.id, name: baseName(n), location: n.location, label: n.label, status: n.status || '', ready: n.ready, battery: n.battery ?? null, lastSeen: n.lastSeen,
      devices: [...specs].filter(([, s]) => s.nodeId === n.id).length,
    })),
  });
  const push = () => api.emit({ model: model() });
  const need = () => { if (!connected) throw new Error(error || 'Nicht mit dem Z-Wave-Server verbunden'); };

  api.route('GET', 'model', () => model());
  api.route('POST', 'include', async ({ body }) => {
    need();
    const st = String((body && body.strategy) || 'insecure');
    if (!(st in STRATEGY)) throw new Error('Strategie: ' + Object.keys(STRATEGY).join(', '));
    await send('controller.begin_inclusion', { options: { strategy: STRATEGY[st] } });
    mode = { kind: 'include', ends: Date.now() + 60000, strategy: st };
    if (modeOff) modeOff();
    modeOff = api.after(() => { send('controller.stop_inclusion', {}).catch(() => {}); mode = { kind: '', ends: 0, strategy: '' }; push(); }, 62000);
    push(); return model();
  });
  api.route('POST', 'exclude', async () => {
    need();
    await send('controller.begin_exclusion', {});
    mode = { kind: 'exclude', ends: Date.now() + 60000, strategy: '' };
    if (modeOff) modeOff();
    modeOff = api.after(() => { send('controller.stop_exclusion', {}).catch(() => {}); mode = { kind: '', ends: 0, strategy: '' }; push(); }, 62000);
    push(); return model();
  });
  api.route('POST', 'cancel', async () => {
    need();
    if (mode.kind === 'include') await send('controller.stop_inclusion', {}).catch(() => {});
    if (mode.kind === 'exclude') await send('controller.stop_exclusion', {}).catch(() => {});
    if (modeOff) { modeOff(); modeOff = null; }
    mode = { kind: '', ends: 0, strategy: '' }; push(); return model();
  });
  const nodeId = (b) => { const id = Number(b && b.nodeId); if (!Number.isInteger(id) || !nodes.has(id)) throw new Error('Knoten unbekannt'); return id; };
  api.route('POST', 'ping', async ({ body }) => { need(); const id = nodeId(body); const r = await send('node.ping', { nodeId: id }); return { ok: true, result: r.result }; });
  api.route('POST', 'refresh', async ({ body }) => { need(); const id = nodeId(body); await send('node.refresh_info', { nodeId: id }); return { ok: true }; });
  api.route('POST', 'remove-failed', async ({ body }) => { need(); const id = nodeId(body); await send('controller.remove_failed_node', { nodeId: id }); removeNode(id); push(); return model(); });
  api.route('POST', 'reconnect', () => { try { if (ws) ws.close(); } catch { /* egal */ } backoff = 1000; connect(); return { ok: true }; });

  api.mcp.tool({ name: 'zwave_geraete', description: 'Liste der Z-Wave-Knoten (ID, Name, Status, Batterie).', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => model().nodes });

  api.onConfig(() => { try { if (ws) { const s = ws; ws = null; s.close(); } } catch { /* egal */ } connected = false; backoff = 1000; connect(); });
  connect();
  return { stop() { stopped = true; clearTimeout(retry); try { if (ws) { const s = ws; ws = null; s.close(); } } catch { /* egal */ } } };
};
