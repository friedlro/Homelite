'use strict';
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const slug = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

function dist(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

class Presence extends EventEmitter {
  constructor(store, log) {
    super();
    this.store = store;
    this.log = log;
    this.p = store.kvGet('presence') || {};
    this.trail = store.kvGet('trail') || {};
    this.trailDirty = false;
    setInterval(() => this.saveTrail(), 30000).unref();
  }

  saveTrail() {
    if (!this.trailDirty || this.store.frozen) return;
    this.trailDirty = false;
    try { this.store.kvSet('trail', this.trail); } catch (e) { this.log('error', 'Verlauf speichern: ' + e.message); }
  }

  // Verlauf je Person (max. 400 Punkte, ~7 Tage): nur wenn bewegt (>25 m) oder älter als 10 min
  addTrail(id, lat, lon, ts) {
    const t = (this.trail[id] = this.trail[id] || []);
    const last = t[t.length - 1];
    if (last && dist(last[1], last[2], lat, lon) < 25 && ts - last[0] < 600000) return;
    if (last && ts < last[0]) return;
    t.push([ts, Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6]);
    const cut = ts - 7 * 86400000;
    while (t.length > 400 || (t.length && t[0][0] < cut)) t.shift();
    this.trailDirty = true;
  }

  save() {
    if (this.store.frozen) return;
    try {
      this.store.kvSet('presence', this.p);
    } catch (e) { this.log('error', 'Presence speichern: ' + e.message); }
  }

  get persons() { return this.store.cfg.geofence.persons; }
  get zones() { return this.store.cfg.geofence.zones; }
  st(id) { return (this.p[id] = this.p[id] || { zones: [], known: false, home: false }); }

  ensurePerson(ref) {
    const id = slug(ref);
    let p = this.persons.find((x) => x.id === id || x.name.toLowerCase() === String(ref).toLowerCase());
    if (!p) {
      p = { id, name: String(ref) };
      this.persons.push(p);
      this.store.save();
      this.log('info', `Person "${p.name}" automatisch angelegt`);
    }
    return p;
  }

  zoneFor(ref) {
    const r = String(ref || '').toLowerCase().trim();
    let z = this.zones.find((x) => x.id === r || x.name.toLowerCase() === r);
    if (!z && /^(home|zuhause|daheim)$/.test(r)) z = this.zones.find((x) => x.home);
    return z || { id: slug(ref), name: String(ref), adhoc: true };
  }

  anyoneHome() { return this.persons.some((p) => this.p[p.id] && this.p[p.id].home); }
  nobodyHome() { return this.persons.length > 0 && this.persons.every((p) => this.p[p.id] && this.p[p.id].known && !this.p[p.id].home); }
  personHome(id) { return !!(this.p[id] && this.p[id].home); }

  recomputeHome(st) {
    st.home = st.zones.some((id) => { const z = this.zones.find((x) => x.id === id); return z && z.home; });
  }

  transition(personRef, zoneRef, event) {
    const person = this.ensurePerson(personRef);
    const zone = this.zoneFor(zoneRef);
    const st = this.st(person.id);
    const before = { anyone: this.anyoneHome(), nobody: this.nobodyHome() };
    const has = st.zones.includes(zone.id);
    if (event === 'enter' && !has) st.zones.push(zone.id);
    else if (event === 'leave' && has) st.zones = st.zones.filter((z) => z !== zone.id);
    else if (st.known) return false;
    st.known = true;
    st.ts = Date.now();
    this.recomputeHome(st);
    this.log('info', `📍 ${person.name} ${event === 'enter' ? 'betritt' : 'verlässt'} ${zone.name}`);
    this.emit('event', { person: person.id, personName: person.name, zone: zone.id, zoneName: zone.name, event });
    this.derived(before);
    this.save();
    this.emit('change');
    return true;
  }

  derived(before) {
    if (!before.nobody && this.nobodyHome()) this.emit('event', { event: 'all_left', person: '', zone: '' });
    if (!before.anyone && this.anyoneHome()) this.emit('event', { event: 'first_home', person: '', zone: '' });
  }

  // meta: { ts (ms, Zeitpunkt der Messung), acc (m), battery (%), src }
  location(personRef, lat, lon, meta = {}) {
    lat = Number(lat); lon = Number(lon);
    if (!isFinite(lat) || !isFinite(lon)) return;
    const person = this.ensurePerson(personRef);
    const st = this.st(person.id);
    const ts = Number(meta.ts) > 0 ? Number(meta.ts) : Date.now();
    if (st.locTs && ts < st.locTs) return; // ältere Messung ignorieren
    st.lat = lat; st.lon = lon; st.ts = Date.now(); st.locTs = ts;
    st.acc = meta.acc != null && isFinite(Number(meta.acc)) ? Math.round(Number(meta.acc)) : null;
    if (meta.battery != null && isFinite(Number(meta.battery))) st.battery = Math.round(Number(meta.battery));
    st.src = meta.src || st.src || '';
    this.addTrail(person.id, lat, lon, ts);
    const before = { anyone: this.anyoneHome(), nobody: this.nobodyHome() };
    let any = false;
    for (const z of this.zones) {
      if (z.lat == null || z.lon == null) continue;
      any = true;
      const d = dist(lat, lon, Number(z.lat), Number(z.lon));
      const inside = st.zones.includes(z.id);
      if (!inside && d <= z.radius) this.transition(person.id, z.id, 'enter');
      else if (inside && d > z.radius * 1.15) this.transition(person.id, z.id, 'leave');
    }
    if (any && !st.known) {
      st.known = true;
      this.recomputeHome(st);
      this.derived(before);
    }
    this.save();
    this.emit('change');
  }

  setHome(personRef, home) { return this.transition(personRef, 'home', home ? 'enter' : 'leave'); }

  snapshot() {
    return this.persons.map((p) => {
      const s = this.p[p.id] || {};
      return {
        id: p.id, name: p.name, known: !!s.known, home: !!s.home, ts: s.ts || null,
        lat: s.lat ?? null, lon: s.lon ?? null, acc: s.acc ?? null, battery: s.battery ?? null, src: s.src || '', locTs: s.locTs || null,
        zones: (s.zones || []).map((id) => (this.zones.find((z) => z.id === id) || { name: id }).name),
      };
    });
  }
}

module.exports = Presence;
