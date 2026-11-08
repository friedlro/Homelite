'use strict';
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const PyBridge = require('./pybridge');

// iCloud „Wo ist?“: fragt die Standorte von iPhones/Familie bei Apple ab (inoffiziell, pyicloud)
// und speist sie als Personen-Standort in die Geofence-Logik ein.
class FindMy extends EventEmitter {
  constructor({ store, presence, log }) {
    super();
    this.store = store;
    this.presence = presence;
    this.log = log;
    this.state = 'off';   // off | login | 2fa | 2sa | ok | error
    this.error = '';
    this.trusted = [];
    this.devices = [];    // letzte Abfrage (alle Geräte des Kontos)
    this.lastPoll = 0;
    this.timer = null;
    this.br = new PyBridge(process.env.HOMELITE_ICLOUD_BRIDGE || path.join(__dirname, 'icloud_bridge.py'), {
      label: 'iCloud-Brücke',
      onDead: (msg) => { this.fail(msg); },
    });
  }

  get cfg() { return this.store.cfg.findmy; }
  get dir() { return path.join(this.store.DATA, 'icloud'); }

  fail(msg) {
    this.state = 'error';
    this.error = msg;
    clearInterval(this.timer); this.timer = null;
    this.emit('status');
    if (this.cfg.enabled && this.cfg.apple) { clearTimeout(this.retry); this.retry = setTimeout(() => this.start(), 300000); }
  }

  async start() {
    clearTimeout(this.retry);
    clearInterval(this.timer); this.timer = null;
    const c = this.cfg;
    if (!c.enabled || !c.apple) { this.state = 'off'; this.br.stop(); this.emit('status'); return; }
    this.state = 'login'; this.error = ''; this.emit('status');
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const r = await this.br.send('login', { apple: c.apple, password: c.password, cookie_dir: this.dir, china: c.china }, 90000);
      if (!r.ok) throw new Error(r.error);
      this.state = r.state;
      this.trusted = r.trusted || [];
      this.emit('status');
      if (r.state === 'ok') this.begin();
      else this.log('info', `iCloud: ${r.state === '2fa' ? '2-Faktor-Code' : 'Bestätigungscode'} erforderlich`);
    } catch (e) { this.fail(e.message); }
  }

  stop() { clearTimeout(this.retry); clearInterval(this.timer); this.timer = null; this.br.stop(); this.state = 'off'; this.emit('status'); }

  async verify(code, device = 0) {
    const r = await this.br.send('verify', { code, device }, 60000);
    if (!r.ok) throw new Error(r.error);
    this.state = r.state;
    this.emit('status');
    if (r.state === 'ok') this.begin();
    return r.state;
  }

  begin() {
    this.error = '';
    this.log('info', 'iCloud „Wo ist?“ verbunden');
    this.poll();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), Math.max(30, Number(this.cfg.interval) || 120) * 1000);
  }

  async poll() {
    if (this.state !== 'ok') return;
    try {
      const r = await this.br.send('poll', {}, 90000);
      if (!r.ok) {
        if (r.relogin) { this.state = 'login'; clearInterval(this.timer); this.timer = null; this.emit('status'); return this.start(); }
        throw new Error(r.error);
      }
      this.apply(r.devices);
    } catch (e) {
      this.error = e.message;
      this.log('warn', 'iCloud: ' + e.message);
      this.emit('status');
    }
  }

  apply(list) {
    this.devices = list;
    this.lastPoll = Date.now();
    this.error = '';
    for (const m of this.cfg.devices) {
      const d = list.find((x) => x.id === m.id);
      if (!d || d.lat == null || d.lon == null || !m.person) continue;
      this.presence.location(m.person, d.lat, d.lon, { ts: d.ts, acc: d.acc, battery: d.battery, src: 'iCloud' });
    }
    this.emit('status');
  }

  async logout() {
    clearInterval(this.timer); this.timer = null;
    try { await this.br.send('logout', {}, 10000); } catch { /* ignorieren */ }
    this.br.stop();
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignorieren */ }
    this.state = 'off'; this.devices = []; this.trusted = []; this.error = '';
    Object.assign(this.cfg, { enabled: false, apple: '', password: '', devices: [] });
    this.store.save();
    this.emit('status');
  }

  snapshot() {
    const c = this.cfg;
    return {
      enabled: !!c.enabled, apple: c.apple, hasPass: !!c.password, china: !!c.china, interval: c.interval,
      state: this.state, error: this.error, trusted: this.trusted, lastPoll: this.lastPoll || null,
      devices: this.devices, mapping: c.devices,
    };
  }
}

module.exports = FindMy;
