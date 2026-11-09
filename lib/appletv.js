'use strict';
const path = require('path');
const EventEmitter = require('events');
const PyBridge = require('./pybridge');

// Apple TV (nur Status) über pyatv: Standby/an, laufende App, Wiedergabe, Titel.
// Geräte-Schlüssel (akey): power, playing, state, app, title, artist
const ITEMS = [
  ['power', 'Status', 'binary'],
  ['playing', 'Wiedergabe', 'binary'],
  ['app', 'App', 'sensor'],
  ['title', 'Titel', 'sensor'],
  ['artist', 'Künstler', 'sensor'],
  ['state', 'Wiedergabestatus', 'sensor'],
];
const STATE_DE = { playing: 'Spielt', paused: 'Pausiert', idle: 'Leerlauf', loading: 'Lädt', stopped: 'Gestoppt', seeking: 'Spult' };

class AppleTV extends EventEmitter {
  constructor({ store, devices, log }) {
    super();
    this.store = store;
    this.devices = devices;
    this.log = log;
    this.states = new Map(); // atvId -> letzter Zustand
    this.error = '';
    this.scanned = [];
    this.pairing = null;
    this.br = new PyBridge(process.env.HOMELITE_ATV_BRIDGE || path.join(__dirname, 'appletv_bridge.py'), {
      label: 'Apple-TV-Brücke',
      onEvent: (m) => this.onEvent(m),
      onDead: (msg) => { this.error = msg; this.states.clear(); this.emit('status'); if (this.cfg.devices.length) { clearTimeout(this.retry); this.retry = setTimeout(() => this.start(), 60000); } },
    });
  }

  get cfg() { return this.store.cfg.appletv; }

  onEvent(m) {
    if (m.event === 'found') {   // IP-Adresse oder Kennung hat sich geändert → merken (Kopplung bleibt gültig)
      const d = this.cfg.devices.find((x) => x.id === m.id);
      if (d) { if (d.address !== m.address) this.log('info', `Apple TV „${d.name}“: neue Adresse ${m.address}`); d.address = m.address; d.ids = m.ids; this.store.save(); }
      return;
    }
    if (m.event === 'error') { this.errors = this.errors || {}; this.errors[m.id] = m.msg; this.emit('status'); return; }
    if (m.event !== 'state') return;
    if (this.errors) delete this.errors[m.id];
    this.states.set(m.id, { ...m, ts: Date.now() });
    this.error = '';
    this.apply(m.id);
    this.emit('status');
  }

  // Wirksamer Einschaltzustand. Der Companion-Dienst meldet bei neueren tvOS-Versionen oft „unbekannt“ oder bleibt
  // auf „aus“ hängen, obwohl das Gerät läuft – dann zählt: wird etwas abgespielt (oder ist eine App aktiv), ist es an.
  powerOf(s) {
    const playing = ['playing', 'paused', 'loading', 'seeking'].includes(s.state);
    if (s.power === 'on') return 'on';
    if (playing) return 'on';
    if (s.power === 'off') return 'off';
    return s.online && s.app ? 'on' : 'unknown';
  }

  apply(atvId) {
    const s = this.states.get(atvId);
    if (!s) return;
    for (const dev of this.devices.list) {
      if (dev.driver !== 'appletv' || dev.atvId !== atvId) continue;
      const prev = { ...(this.devices.states.get(dev.id) || {}) };
      const st = { ...prev, online: !!s.online, ts: Date.now() };
      switch (dev.akey) {
        case 'power': { const pw = this.powerOf(s); if (pw === 'unknown') { delete st.on; } else st.on = pw === 'on'; break; }
        case 'playing': st.on = s.state === 'playing'; break;
        case 'app': st.value = this.powerOf(s) === 'off' ? '–' : (s.app || '–'); break;
        case 'title': st.value = s.title || '–'; break;
        case 'artist': st.value = s.artist || '–'; break;
        case 'state': st.value = this.powerOf(s) === 'off' ? 'Standby' : (STATE_DE[s.state] || s.state || '–'); break;
        default: continue;
      }
      this.devices.setState(dev, st, prev);
    }
  }

  async start() {
    clearTimeout(this.retry);
    if (!this.cfg.devices.length) { this.br.stop(); this.states.clear(); this.emit('status'); return; }
    try {
      const r = await this.br.send('connect', { devices: this.cfg.devices.map((d) => ({ id: d.id, address: d.address, creds: d.creds || {}, name: d.name, ids: d.ids || [] })) });
      if (!r.ok) throw new Error(r.error);
      this.error = '';
    } catch (e) { this.error = e.message; }
    this.emit('status');
  }

  async scan() {
    const r = await this.br.send('scan', {}, 40000);
    if (!r.ok) throw new Error(r.error);
    this.scanned = r.devices;
    return r.devices;
  }

  async pairBegin(id, protocol, address) {
    const r = await this.br.send('pair_begin', { atv: id, protocol, address }, 40000);
    if (!r.ok) throw new Error(r.error);
    this.pairing = { id, protocol, address };
    return r;
  }

  // PIN eingeben; bei Erfolg Zugangsdaten am Gerät speichern
  async pairPin(pin, name) {
    if (!this.pairing) throw new Error('Keine Kopplung gestartet');
    const r = await this.br.send('pair_pin', { pin }, 60000);
    if (!r.ok) throw new Error(r.error);
    const { id, address } = this.pairing;
    let d = this.cfg.devices.find((x) => x.id === id);
    if (!d) { d = { id, name: name || id, address: address || '', creds: {} }; this.cfg.devices.push(d); }
    d.creds = { ...(d.creds || {}), [r.protocol]: r.credentials };
    if (address) d.address = address;
    this.pairing = null;
    this.store.save();
    this.emit('status');
    return d;
  }

  stop() { clearTimeout(this.retry); this.br.stop(); this.states.clear(); this.emit('status'); }

  remove(id) {
    const i = this.cfg.devices.findIndex((d) => d.id === id);
    if (i < 0) return;
    this.cfg.devices.splice(i, 1);
    this.states.delete(id);
    this.store.save();
    this.start();
  }

  snapshot() {
    return {
      error: this.error,
      scanned: this.scanned,
      devices: this.cfg.devices.map((d) => {
        const s = this.states.get(d.id) || {};
        return {
          id: d.id, name: d.name, address: d.address, paired: Object.keys(d.creds || {}),
          online: !!s.online, error: (this.errors || {})[d.id] || '', power: this.powerOf(s), powerRaw: s.power || 'unknown', state: s.state || '', app: s.app || '', title: s.title || '', artist: s.artist || '',
          linked: this.devices.list.filter((x) => x.driver === 'appletv' && x.atvId === d.id).length,
        };
      }),
    };
  }
}

AppleTV.ITEMS = ITEMS;
module.exports = AppleTV;
