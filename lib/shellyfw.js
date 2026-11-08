'use strict';
const EventEmitter = require('events');
const TIMEOUT = Number(process.env.SHELLYFW_TIMEOUT_MS) || 8 * 60000;

// Shelly-Firmware: auf Updates prüfen, Update starten, Ergebnis verfolgen (Gen1 und Gen2/3 per HTTP).
// Zustände je IP: unknown | checking | current | available | updating | ok | failed | offline
class ShellyFw extends EventEmitter {
  constructor({ devices, log }) {
    super();
    this.devices = devices;
    this.log = log;
    this.s = new Map();
    this.timers = new Map();
  }

  targets() {
    const m = new Map();
    for (const d of this.devices.list) {
      if (d.driver !== 'shelly' || !d.ip) continue;
      const t = m.get(d.ip) || { ip: d.ip, dev: d, names: [] };
      t.names.push(d.name);
      m.set(d.ip, t);
    }
    return m;
  }

  set(ip, patch) {
    const cur = this.s.get(ip) || { state: 'unknown' };
    this.s.set(ip, { ...cur, ...patch, ts: Date.now() });
    this.emit('change');
  }

  async info(dev) {
    await this.devices.ensureGen(dev);
    const i = await this.devices.shellyFetch(dev, '/shelly');
    const gen = dev.gen === 2 ? 2 : 1;
    return { gen, ver: gen === 2 ? i.ver : i.fw, model: i.app || i.model || i.type || '', name: i.name || '' };
  }

  async check(ip) {
    const t = this.targets().get(ip);
    if (!t) throw new Error('Unbekannte Shelly-IP');
    if ((this.s.get(ip) || {}).state === 'updating') return;
    this.set(ip, { state: 'checking', msg: '' });
    try {
      const i = await this.info(t.dev);
      let newVer = '';
      let has = false;
      if (i.gen === 2) {
        const r = await this.devices.shellyFetch(t.dev, '/rpc/Shelly.CheckForUpdate');
        newVer = (r.stable && r.stable.version) || '';
        has = !!newVer;
      } else {
        const o = await this.devices.shellyFetch(t.dev, '/ota');
        has = !!o.has_update;
        newVer = has ? o.new_version || '' : '';
      }
      this.set(ip, { state: has ? 'available' : 'current', ver: i.ver, newVer, model: i.model, gen: i.gen, msg: '', checked: Date.now() });
    } catch (e) {
      this.set(ip, { state: 'offline', msg: this.errText(e) });
    }
  }

  errText(e) {
    const m = (e.cause && e.cause.code) || e.message || String(e);
    if (/401/.test(m)) return 'Zugriff verweigert (Benutzer/Passwort am Gerät eintragen; Digest-Auth wird nicht unterstützt)';
    if (e.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT/.test(m)) return 'Gerät antwortet nicht';
    if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND/.test(m)) return 'Gerät nicht erreichbar (' + m + ')';
    return m;
  }

  async checkAll() {
    const ips = [...this.targets().keys()];
    for (let i = 0; i < ips.length; i += 4) await Promise.all(ips.slice(i, i + 4).map((ip) => this.check(ip)));
  }

  async update(ip) {
    const t = this.targets().get(ip);
    if (!t) throw new Error('Unbekannte Shelly-IP');
    const cur = this.s.get(ip) || {};
    if (cur.state === 'updating') throw new Error('Update läuft bereits');
    if (cur.state !== 'available') throw new Error('Kein Update verfügbar – erst prüfen');
    const before = cur.ver;
    try {
      if (cur.gen === 2) await this.devices.shellyFetch(t.dev, '/rpc/Shelly.Update?stage=stable');
      else await this.devices.shellyFetch(t.dev, '/ota?update=true');
    } catch (e) {
      this.set(ip, { state: 'failed', msg: 'Update konnte nicht gestartet werden: ' + this.errText(e) });
      throw new Error(this.errText(e));
    }
    this.log('info', `Shelly ${ip}: Update ${before} → ${cur.newVer || '?'} gestartet`);
    const started = Date.now();
    this.set(ip, { state: 'updating', before, started, msg: 'Update läuft … (Gerät startet neu)' });
    clearInterval(this.timers.get(ip));
    const tm = setInterval(async () => {
      const el = Date.now() - started;
      let reachable = false;
      try {
        const i = await this.info(t.dev);
        reachable = true;
        if (i.ver !== before) {
          clearInterval(tm);
          const good = !cur.newVer || i.ver === cur.newVer;
          this.set(ip, { state: good ? 'ok' : 'failed', ver: i.ver, newVer: '', msg: good ? `Aktualisiert: ${before} → ${i.ver}` : `Version ${i.ver} statt ${cur.newVer}` });
          this.log(good ? 'info' : 'warn', `Shelly ${ip}: ${good ? 'Update erfolgreich' : 'Update unvollständig'} (${before} → ${i.ver})`);
          return;
        }
      } catch { /* Neustart: nicht erreichbar */ }
      if (el > TIMEOUT) {
        clearInterval(tm);
        this.set(ip, { state: 'failed', msg: reachable ? 'Nach ' + Math.round(TIMEOUT / 60000) + ' Minuten noch alte Version – Update fehlgeschlagen' : 'Nach ' + Math.round(TIMEOUT / 60000) + ' Minuten nicht erreichbar – bitte Gerät prüfen' });
        this.log('warn', `Shelly ${ip}: Update fehlgeschlagen`);
      } else if (!reachable && el > 30000) this.set(ip, { msg: 'Gerät startet neu …' });
    }, 5000);
    this.timers.set(ip, tm);
  }

  snapshot() {
    return [...this.targets().values()].map((t) => ({ ip: t.ip, names: t.names, ...(this.s.get(t.ip) || { state: 'unknown' }) }));
  }
}

module.exports = ShellyFw;
