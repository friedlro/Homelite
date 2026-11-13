'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'import');
// Neuer Dateiname; der frühere Name wird weiterhin gelesen, damit bestehende Installationen nichts ändern müssen.
const FILES = ['migration.json', 'ha-migration.json'].map((n) => path.join(DIR, n));
const FILE = FILES.find((f) => fs.existsSync(f)) || FILES[0];
const REF_KEYS = new Set(['device', 'device2']);

module.exports = function createImporter({ store, devices, log }) {
  function load() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
      const err = new Error(e.code === 'ENOENT' ? 'Importdatei import/migration.json fehlt' : 'Importdatei ungültig: ' + e.message);
      err.status = 400;
      throw err;
    }
  }

  // Platzhalter ersetzen: @z2m/ -> Basis-Topic, @lat/@lon -> Heimposition
  function subst(v, ctx) {
    if (typeof v === 'string') {
      return v.replace(/^@z2m\//, ctx.z2m + '/').replace(/@lat/g, ctx.lat ?? '').replace(/@lon/g, ctx.lon ?? '');
    }
    if (Array.isArray(v)) return v.map((x) => subst(x, ctx));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, ctx)]));
    return v;
  }

  // Referenz -> Geräte-ID: erst über die Importdatei (ref), dann über die ID selbst, dann über den exakten Gerätenamen
  function mapRefs(v, ids, miss) {
    const c = store.cfg;
    const resolve = (x) => {
      if (ids.has(x)) return ids.get(x);
      if (c.devices.some((d) => d.id === x)) return x;
      const byName = c.devices.find((d) => d.name.toLowerCase() === x.toLowerCase());
      if (byName) return byName.id;
      miss.add(x);
      return x;
    };
    if (Array.isArray(v)) return v.map((x) => mapRefs(x, ids, miss));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = REF_KEYS.has(k) && typeof x === 'string' && x ? resolve(x) : mapRefs(x, ids, miss);
      return o;
    }
    return v;
  }

  function preview() {
    const j = load();
    const c = store.cfg;
    const haveD = new Set(c.devices.map((d) => d.src));
    const haveA = new Set(c.automations.map((a) => a.src));
    return {
      devices: j.devices.length, automations: j.automations.length,
      newDevices: j.devices.filter((d) => !haveD.has(d.src)).length,
      newAutomations: j.automations.filter((a) => !haveA.has(a.src)).length,
      notes: j.notes || [],
    };
  }

  function run() {
    const j = load();
    const c = store.cfg;
    const zone = c.geofence.zones.find((z) => z.home) || c.geofence.zones[0];
    let homeSet = false;
    if (zone && j.home && (zone.lat == null || zone.lon == null)) {
      zone.lat = j.home.lat;
      zone.lon = j.home.lon;
      homeSet = true;
    }
    const ctx = { z2m: c.mqtt.z2mBase || 'zigbee2mqtt', lat: zone && zone.lat != null ? zone.lat : j.home && j.home.lat, lon: zone && zone.lon != null ? zone.lon : j.home && j.home.lon };

    for (const r of j.rooms || []) if (!c.rooms.includes(r)) c.rooms.push(r);

    const ids = new Map();
    const report = { devicesAdded: 0, devicesExisting: 0, automationsAdded: 0, automationsExisting: 0, pending: [], homeSet };
    for (const spec of j.devices) {
      const existing = c.devices.find((d) => d.src === spec.src);
      if (existing) { ids.set(spec.ref, existing.id); report.devicesExisting++; continue; }
      const { ref, ...rest } = spec;
      const d = { id: store.id(), fav: false, ...subst(rest, ctx) };
      ids.set(ref, d.id);
      c.devices.push(d);
      report.devicesAdded++;
    }
    for (const spec of j.automations) {
      if (c.automations.some((a) => a.src === spec.src)) { report.automationsExisting++; continue; }
      const miss = new Set();
      const { replaces, ...a } = mapRefs(subst(spec, ctx), ids, miss);
      if (miss.size) { (report.skipped = report.skipped || []).push(`${spec.name}: Gerät fehlt (${[...miss].join(', ')})`); continue; }
      // ersetzt frühere, feiner aufgeteilte Übernahmen derselben Automation
      if (Array.isArray(replaces)) c.automations = c.automations.filter((x) => !replaces.includes(x.src));
      c.automations.push({
        id: store.id(), enabled: true, dash: false, mode: 'single', silent: false, conditions: [], ...a,
      });
      report.automationsAdded++;
    }
    store.save();
    devices.rebuild();
    devices.requestStates();
    report.pending = c.devices.filter((d) => d.src && d.src.startsWith('ha:') && devices.isPending(d)).map((d) => ({ name: d.name, note: d.note || '' }));
    log('info', `Import: ${report.devicesAdded} Geräte, ${report.automationsAdded} Automationen`);
    return report;
  }

  return { preview, run };
};
