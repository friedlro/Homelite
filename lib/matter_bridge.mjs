// HomeLite Matter-Controller (Kindprozess). Spricht per JSON-Zeilen über stdin/stdout mit lib/matter.js.
// Benötigt Node >= 22.13 und das npm-Paket @matter/main (Button „Matter-Paket installieren“ in HomeLite).
import { createInterface } from 'node:readline';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const log = (m) => send({ t: 'log', msg: String(m) });

let M;
try {
  M = {
    main: await import('@matter/main'),
    onoff: await import('@matter/main/behaviors/on-off'),
    level: await import('@matter/main/behaviors/level-control'),
    lock: await import('@matter/main/behaviors/door-lock'),
    temp: await import('@matter/main/behaviors/temperature-measurement'),
    hum: await import('@matter/main/behaviors/relative-humidity-measurement'),
    lux: await import('@matter/main/behaviors/illuminance-measurement'),
    bool: await import('@matter/main/behaviors/boolean-state'),
    occ: await import('@matter/main/behaviors/occupancy-sensing'),
    pwr: await import('@matter/main/behaviors/power-source'),
    basic: await import('@matter/main/behaviors/basic-information'),
    bridged: await import('@matter/main/behaviors/bridged-device-basic-information'),
    cover: await import('@matter/main/behaviors/window-covering'),
    desc: await import('@matter/main/behaviors/descriptor'),
  };
} catch (e) {
  send({ t: 'fatal', error: 'Matter-Paket fehlt oder ist inkompatibel: ' + e.message });
  process.exit(2);
}

const dataDir = process.argv[2];
const { Environment, ServerNode } = M.main;
const env = Environment.default;
try { env.vars.set('path.root', dataDir); } catch { /* ignorieren */ }
process.env.MATTER_PATH_ROOT = dataDir;

let controller;
try {
  controller = await ServerNode.create(ServerNode.RootEndpointWithoutGroupcast, { id: 'homelite' });
  await controller.start();
} catch (e) {
  send({ t: 'fatal', error: 'Matter-Start fehlgeschlagen: ' + e.message });
  process.exit(2);
}
send({ t: 'ready' });

const maybe = (ep, client) => { try { return ep.maybeStateOf(client); } catch { return undefined; } };
const peers = () => { const a = []; try { for (const p of controller.peers) a.push(p); } catch { /* ignorieren */ } return a; };

function* walk(ep) {
  let parts = [];
  try { parts = [...ep.parts]; } catch { /* ignorieren */ }
  for (const p of parts) { yield p; yield* walk(p); }
}
const epNum = (ep) => { try { return ep.number; } catch { return undefined; } };

// Endpunkte ohne bekannte Funktion einmal im Protokoll nennen (Hinweis, warum ein Gerät fehlt)
const noted = new Set();
function deviceTypes(ep) {
  try { const d = maybe(ep, M.desc.DescriptorClient); return (d && d.deviceTypeList ? d.deviceTypeList : []).map((x) => '0x' + Number(x.deviceType).toString(16)); } catch { return []; }
}
function clusterNames(ep) { try { return Object.keys(ep.behaviors.supported || {}); } catch { return []; } }
function noteUnsupported(peer, ep, n, base) {
  const k = `${peer.id}/${n}`;
  if (noted.has(k)) return;
  const cl = clusterNames(ep).filter((c) => !['descriptor', 'identify', 'groups', 'bridgedDeviceBasicInformation', 'basicInformation', 'fixedLabel', 'userLabel'].includes(c));
  if (!cl.length) return;
  noted.add(k);
  log(`Endpunkt ${n} „${base}“ (Gerätetyp ${deviceTypes(ep).join(',') || '?'}) hat keine unterstützte Funktion: ${cl.join(', ')}`);
}

// Zustand aller Entitäten aus dem lokalen Cache lesen
function collect() {
  const out = [];
  for (const peer of peers()) {
    const root = maybe(peer, M.basic.BasicInformationClient) || {};
    const rootName = root.nodeLabel || root.productName || peer.id;
    for (const ep of walk(peer)) {
      const n = epNum(ep);
      if (n === undefined || n === 0) continue;
      const br = maybe(ep, M.bridged.BridgedDeviceBasicInformationClient) || {};
      const base = br.nodeLabel || br.productName || rootName;
      const key = (k) => `${peer.id}/${n}/${k}`;
      const before = out.length;
      const add = (kind, label, value, extra) => out.push({ key: key(kind), peer: peer.id, endpoint: n, kind, name: `${base} ${label}`.trim(), value, ...extra });
      const lock = maybe(ep, M.lock.DoorLockClient);
      if (lock) add('lock', '', ({ 0: 'unlatched', 1: 'locked', 2: 'unlocked', 3: 'unlatched' })[lock.lockState] ?? null, { raw: lock.lockState });
      const onoff = maybe(ep, M.onoff.OnOffClient);
      const level = maybe(ep, M.level.LevelControlClient);
      if (onoff) add(level ? 'light' : 'switch', '', onoff.onOff, level ? { level: level.currentLevel == null ? null : Math.round((level.currentLevel / 254) * 100) } : {});
      const wc = maybe(ep, M.cover.WindowCoveringClient);
      if (wc) {
        const op = wc.operationalStatus && wc.operationalStatus.lift ? wc.operationalStatus.lift : (wc.operationalStatus && wc.operationalStatus.tilt) || 0;
        const pos = wc.currentPositionLiftPercent100ths ?? wc.currentPositionTiltPercent100ths;
        add('cover', '', op === 1 ? 'opening' : op === 2 ? 'closing' : pos == null ? null : pos >= 9500 ? 'closed' : 'open', { pos: pos == null ? null : Math.round(100 - pos / 100) });
      }
      const t = maybe(ep, M.temp.TemperatureMeasurementClient);
      if (t) add('temperature', 'Temperatur', t.measuredValue == null ? null : Math.round(t.measuredValue) / 100);
      const hu = maybe(ep, M.hum.RelativeHumidityMeasurementClient);
      if (hu) add('humidity', 'Feuchte', hu.measuredValue == null ? null : Math.round(hu.measuredValue) / 100);
      const lx = maybe(ep, M.lux.IlluminanceMeasurementClient);
      if (lx) add('illuminance', 'Helligkeit', lx.measuredValue == null || lx.measuredValue < 1 ? null : Math.round(10 ** ((lx.measuredValue - 1) / 10000)));
      const bs = maybe(ep, M.bool.BooleanStateClient);
      if (bs) add('contact', 'Kontakt', bs.stateValue ?? null);
      const oc = maybe(ep, M.occ.OccupancySensingClient);
      if (oc) add('occupancy', 'Anwesenheit', oc.occupancy == null ? null : !!(typeof oc.occupancy === 'number' ? oc.occupancy & 1 : oc.occupancy.occupied));
      const pw = maybe(ep, M.pwr.PowerSourceClient);
      if (pw && pw.batPercentRemaining != null) add('battery', 'Batterie', Math.round(pw.batPercentRemaining / 2));
      if (out.length === before) noteUnsupported(peer, ep, n, base);
    }
  }
  return out;
}

let last = new Map();
let lastKeys = '';
function publish(force) {
  let list;
  try { list = collect(); } catch (e) { log('collect: ' + e.message); return; }
  const keys = list.map((x) => x.key).join('|');
  if (force || keys !== lastKeys) { lastKeys = keys; send({ t: 'entities', entities: list }); last = new Map(list.map((x) => [x.key, JSON.stringify([x.value, x.level])])); return; }
  const changed = list.filter((x) => last.get(x.key) !== JSON.stringify([x.value, x.level]));
  if (changed.length) { for (const x of changed) last.set(x.key, JSON.stringify([x.value, x.level])); send({ t: 'values', values: changed.map((x) => ({ key: x.key, value: x.value, level: x.level, raw: x.raw })) }); }
}
setInterval(() => publish(false), 2000);
setTimeout(() => publish(true), 3000);

async function findEndpoint(peerId, n) {
  const peer = controller.peers.get(peerId);
  if (!peer) throw new Error('Matter-Knoten nicht gefunden');
  for (const ep of walk(peer)) if (epNum(ep) === n) return ep;
  throw new Error('Endpunkt nicht gefunden');
}

const handlers = {
  async commission({ code }) {
    const id = 'n' + Date.now().toString(36);
    await controller.peers.commission({ id, pairingCode: String(code).replace(/[\s-]/g, '') });
    publish(true);
    return { id };
  },
  async remove({ peer: id }) {
    const peer = controller.peers.get(id);
    if (!peer) return {};
    try { await peer.start(); await peer.decommission(); } catch (e) { log('decommission: ' + e.message); try { await peer.delete(); } catch { /* ignorieren */ } }
    publish(true);
    return {};
  },
  async nodes() {
    return peers().map((p) => { const b = maybe(p, M.basic.BasicInformationClient) || {}; return { id: p.id, name: b.nodeLabel || b.productName || p.id, vendor: b.vendorName || '', product: b.productName || '' }; });
  },
  // Gesamte Struktur aller Knoten (für die Fehlersuche: welche Endpunkte/Cluster meldet das Gerät/der Hub?)
  async diag() {
    const out = [];
    for (const peer of peers()) {
      const root = maybe(peer, M.basic.BasicInformationClient) || {};
      const eps = [];
      for (const ep of walk(peer)) {
        const n = epNum(ep);
        const br = maybe(ep, M.bridged.BridgedDeviceBasicInformationClient) || {};
        let parent;
        try { parent = ep.owner && ep.owner.number; } catch { /* ignorieren */ }
        eps.push({ endpoint: n, parent, name: br.nodeLabel || br.productName || '', deviceTypes: deviceTypes(ep), clusters: clusterNames(ep) });
      }
      let online;
      try { online = peer.lifecycle && peer.lifecycle.isOnline; } catch { /* ignorieren */ }
      out.push({ id: peer.id, vendor: root.vendorName || '', product: root.productName || '', label: root.nodeLabel || '', software: root.softwareVersionString || '', online, endpoints: eps });
    }
    return { nodes: out, entities: lastKeys ? lastKeys.split('|').length : 0, matter: process.versions.node };
  },
  async invoke({ peer, endpoint, kind, action, value }) {
    const ep = await findEndpoint(peer, endpoint);
    if (kind === 'lock') {
      const c = ep.commandsOf(M.lock.DoorLockClient);
      if (action === 'lock') await c.lockDoor({}); else if (action === 'unlock') await c.unlockDoor({});
      else throw new Error('Aktion nicht unterstützt: ' + action);
    } else if (kind === 'switch' || kind === 'light') {
      const c = ep.commandsOf(M.onoff.OnOffClient);
      if (action === 'on') await c.on(); else if (action === 'off') await c.off(); else if (action === 'toggle') await c.toggle();
      else if (action === 'brightness') await ep.commandsOf(M.level.LevelControlClient).moveToLevelWithOnOff({ level: Math.max(1, Math.min(254, Math.round((Number(value) / 100) * 254))), transitionTime: 0, optionsMask: {}, optionsOverride: {} });
      else throw new Error('Aktion nicht unterstützt: ' + action);
    } else if (kind === 'cover') {
      const c = ep.commandsOf(M.cover.WindowCoveringClient);
      if (action === 'open') await c.upOrOpen(); else if (action === 'close') await c.downOrClose(); else if (action === 'stop') await c.stopMotion();
      else throw new Error('Aktion nicht unterstützt: ' + action);
    } else throw new Error('Gerät kann nicht gesteuert werden');
    setTimeout(() => publish(false), 800);
    return {};
  },
};

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  try {
    const h = handlers[m.cmd];
    if (!h) throw new Error('Unbekannter Befehl');
    send({ id: m.id, ok: true, result: await h(m) });
  } catch (e) { send({ id: m.id, ok: false, error: e && e.message ? e.message : String(e) }); }
});
rl.on('close', () => process.exit(0));
