'use strict';
const { sunTimes } = require('./sun');

module.exports = function createEngine({ store, devices, presence, heating, car, notify, log }) {
  const timers = new Map();
  const runs = new Map(); // id -> { cancelled, wake }
  const queues = new Map(); // id -> [ctx]
  const lastRun = new Map();
  let lastMinute = '';
  let sunCache = { day: '', t: null };

  const hm = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const has = (v) => v !== '' && v !== undefined && v !== null;
  const tpl = (s, ctx) => String(s ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (ctx[k] ?? ''));
  const autos = () => store.cfg.automations;

  const numOf = (dev, s) => {
    if (!s) return NaN;
    const v = dev.type === 'thermostat' ? s.current : s.value;
    return v === undefined ? NaN : Number(v);
  };

  function holdsS(t, dev, s) {
    if (!s || !Object.keys(s).length) return false;
    const str = devices.stateString(dev, s);
    if (has(t.to) && str !== String(t.to)) return false;
    const n = numOf(dev, s);
    if (has(t.above) && !(n > Number(t.above))) return false;
    if (has(t.below) && !(n < Number(t.below))) return false;
    return true;
  }

  function matchDevice(t, dev, st, prev, force) {
    const crit = has(t.to) || has(t.above) || has(t.below);
    const old = devices.stateString(dev, prev);
    if (has(t.from) && old !== String(t.from)) return false;
    if (crit) {
      if (!holdsS(t, dev, st)) return false;
      return force || !holdsS(t, dev, prev);
    }
    return force || devices.stateString(dev, st) !== old;
  }

  function cond(c, ctx) {
    switch (c.type) {
      case 'trigger': { // ausgelöst durch einen Auslöser mit dieser Kennung
        const ids = String(c.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
        const hit = !!(ctx && ctx.trig && ids.includes(ctx.trig));
        return c.negate ? !hit : hit;
      }
      case 'any': return (c.conditions || []).some((x) => cond(x, ctx)); // ODER
      case 'all': return (c.conditions || []).every((x) => cond(x, ctx)); // UND
      case 'device': {
        const d = devices.byId(c.device);
        if (!d) return false;
        const s = devices.stateString(d);
        if (s === undefined) return false;
        return c.negate ? s !== String(c.equals) : s === String(c.equals);
      }
      case 'numeric': {
        const d = devices.byId(c.device);
        const n = d ? devices.numeric(d) : NaN;
        if (isNaN(n)) return false;
        if (has(c.above) && !(n > Number(c.above))) return false;
        if (has(c.below) && !(n < Number(c.below))) return false;
        return true;
      }
      case 'diff': { // Gerät A − Gerät B
        const a = devices.byId(c.device);
        const b = devices.byId(c.device2);
        const x = a ? devices.numeric(a) : NaN;
        const y = b ? devices.numeric(b) : NaN;
        if (isNaN(x) || isNaN(y)) return false;
        const d = x - y;
        if (has(c.min) && !(d >= Number(c.min))) return false;
        if (has(c.max) && !(d <= Number(c.max))) return false;
        return true;
      }
      case 'time': {
        const now = new Date();
        const n = now.getHours() * 60 + now.getMinutes();
        const a = hm(c.after);
        const b = hm(c.before);
        return a <= b ? n >= a && n < b : n >= a || n < b;
      }
      case 'weekday': return (c.days || []).includes(new Date().getDay());
      case 'presence':
        if (c.mode === 'anyone_home') return presence.anyoneHome();
        if (c.mode === 'nobody_home') return !presence.anyoneHome();
        if (c.mode === 'person_home') return presence.personHome(c.person);
        if (c.mode === 'person_away') return !presence.personHome(c.person);
        return true;
      default: return true;
    }
  }

  const allOk = (list, ctx) => (list || []).every((c) => cond(c, ctx));

  // abbrechbares Warten
  function sleep(ms, token) {
    return new Promise((resolve) => {
      if (token.cancelled) return resolve();
      const t = setTimeout(() => { token.wake = null; resolve(); }, ms);
      token.wake = () => { clearTimeout(t); token.wake = null; resolve(); };
    });
  }

  async function runList(list, a, ctx, token) {
    for (const act of Array.isArray(list) ? list : []) {
      if (token.cancelled) return false;
      try {
        const r = await doAction(act, ctx, token, a);
        if (r === false) return false;
      } catch (e) { log('error', `${a.name}: ${e.message}`); }
    }
    return true;
  }

  async function doAction(act, ctx, token, a) {
    switch (act.type) {
      case 'if': return runList(allOk(act.conditions, ctx) ? act.then : act.else, a, ctx, token);
      case 'device': {
        const d = devices.byId(act.device);
        if (!d) throw new Error('Gerät nicht gefunden');
        await devices.control(d, act.action, act.value, { k: 'auto', w: a.name, x: ctx && ctx.why });
        break;
      }
      case 'delay': await sleep(Math.min(Number(act.seconds) || 0, 86400) * 1000, token); break;
      case 'require': return allOk(act.conditions, ctx); // false = Ablauf beenden
      case 'notify': await notify(tpl(act.title || 'HomeLite', ctx), tpl(act.message, ctx)); break;
      case 'heating': heating.command(act); break;
      case 'car': await car.command(act.command); break;
      case 'mqtt': await devices.publish(tpl(act.topic, ctx), tpl(act.payload, ctx)); break;
      case 'http': {
        const url = tpl(act.url, ctx);
        if (!/^https?:\/\//i.test(url)) throw new Error('URL muss mit http(s):// beginnen');
        const method = (act.method || 'GET').toUpperCase();
        const r = await fetch(url, {
          method, signal: AbortSignal.timeout(10000),
          ...(method !== 'GET' && act.body ? { body: tpl(act.body, ctx), headers: { 'Content-Type': 'application/json' } } : {}),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        break;
      }
      default: throw new Error('Unbekannte Aktion: ' + act.type);
    }
    return true;
  }

  const execute = (a, ctx, token) => runList(a.actions, a, ctx, token);

  async function startRun(a, ctx) {
    const token = { cancelled: false, wake: null };
    runs.set(a.id, token);
    lastRun.set(a.id, Date.now());
    log('info', `▶ ${a.name}${ctx.why ? ` (${ctx.why})` : ''}`);
    try { await execute(a, ctx, token); } finally {
      if (runs.get(a.id) === token) runs.delete(a.id);
      const q = queues.get(a.id);
      if (q && q.length && !runs.has(a.id)) startRun(a, q.shift());
    }
  }

  function fire(a, ctx = {}) {
    if (!ctx.manual && !a.enabled) return;
    if (!ctx.manual && !allOk(a.conditions, ctx)) return;
    const mode = a.mode || 'single';
    const cur = runs.get(a.id);
    if (cur) {
      if (mode === 'restart') {
        cur.cancelled = true;
        if (cur.wake) cur.wake();
        runs.delete(a.id);
      } else if (mode === 'queued') {
        const q = queues.get(a.id) || [];
        if (q.length < 4) q.push(ctx);
        queues.set(a.id, q);
        return;
      } else {
        if (!a.silent) log('warn', `${a.name}: läuft noch – übersprungen`);
        return;
      }
    }
    startRun(a, ctx);
  }

  function onDeviceState(dev, st, prev, force) {
    for (const a of autos()) {
      if (!a.enabled) continue;
      (a.triggers || []).forEach((t, i) => {
        if (t.type !== 'device' || t.device !== dev.id) return;
        const ctx = { device: dev.name, state: devices.stateString(dev, st) ?? '', why: dev.name, trig: String(t.id || '') };
        const key = `${a.id}:${i}`;
        const secs = Number(t.forSeconds) || 0;
        if (secs > 0) {
          const nowHolds = holdsS(t, dev, st);
          const wasHolds = holdsS(t, dev, prev);
          if (!nowHolds) { clearTimeout(timers.get(key)); timers.delete(key); } else if (!wasHolds) {
            clearTimeout(timers.get(key));
            timers.set(key, setTimeout(() => {
              timers.delete(key);
              if (holdsS(t, dev, devices.states.get(dev.id))) fire(a, ctx);
            }, secs * 1000));
          }
        } else if (matchDevice(t, dev, st, prev, force)) fire(a, ctx);
      });
    }
  }

  function homeZone() {
    const z = store.cfg.geofence.zones.find((x) => x.home) || store.cfg.geofence.zones[0];
    return z && typeof z.lat === 'number' && typeof z.lon === 'number' ? z : null;
  }

  function sunToday(d) {
    const day = d.toDateString();
    const z = homeZone();
    const sig = z ? `${z.lat},${z.lon}` : '';
    if (sunCache.day !== day || sunCache.sig !== sig) sunCache = { day, sig, t: z ? sunTimes(d, z.lat, z.lon) : null };
    return sunCache.t;
  }

  const minuteOf = (date) => Math.floor(date.getTime() / 60000);

  function onTick() {
    const d = new Date();
    const key = `${d.toDateString()} ${d.getHours()}:${d.getMinutes()}`;
    if (key === lastMinute) return;
    lastMinute = key;
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const mins = d.getHours() * 60 + d.getMinutes();
    const sun = sunToday(d);
    let warned = false;
    for (const a of autos()) {
      if (!a.enabled) continue;
      for (const t of a.triggers || []) {
        if (t.type === 'time') {
          if (t.at !== hhmm) continue;
          if (t.days && t.days.length && !t.days.includes(d.getDay())) continue;
          fire(a, { why: 'Uhrzeit ' + hhmm });
        } else if (t.type === 'interval') {
          const n = Math.max(1, Number(t.everyMinutes) || 60);
          if (mins % n === 0) fire(a, { why: `alle ${n} Min.` });
        } else if (t.type === 'sun') {
          if (!sun) { if (!warned) { warned = true; log('warn', 'Sonnen-Trigger: Heimposition fehlt (Geofence → Zone „Zuhause“)'); } continue; }
          const ev = t.event === 'sunrise' ? sun.sunrise : sun.sunset;
          const at = new Date(ev.getTime() + (Number(t.offset) || 0) * 60000);
          if (minuteOf(at) !== minuteOf(d)) continue;
          if (t.days && t.days.length && !t.days.includes(d.getDay())) continue;
          fire(a, { why: `${t.event === 'sunrise' ? 'Sonnenaufgang' : 'Sonnenuntergang'}` });
        }
      }
    }
  }

  function onGeo(e) {
    for (const a of autos()) {
      if (!a.enabled) continue;
      for (const t of a.triggers || []) {
        if (t.type !== 'geofence' || t.event !== e.event) continue;
        if (e.event === 'enter' || e.event === 'leave') {
          if (t.person && t.person !== e.person) continue;
          if (t.zone && t.zone !== e.zone) continue;
        }
        fire(a, { person: e.personName || '', zone: e.zoneName || '', why: 'Geofence' });
      }
    }
  }

  // Start des Programms (z. B. „beim Systemstart prüfen“)
  function onStartup() {
    for (const a of autos()) {
      if (!a.enabled) continue;
      if ((a.triggers || []).some((t) => t.type === 'startup')) fire(a, { why: 'Start' });
    }
  }

  // Aufruf per URL (z. B. NFC-Tag über iPhone-Kurzbefehle)
  function webhook(name) {
    let n = 0;
    for (const a of autos()) {
      if (!a.enabled) continue;
      for (const t of a.triggers || []) {
        if (t.type === 'webhook' && t.name === name) { fire(a, { why: 'Webhook ' + name }); n++; }
      }
    }
    return n;
  }

  function run(id) {
    const a = autos().find((x) => x.id === id);
    if (!a) throw new Error('Automation nicht gefunden');
    fire(a, { manual: true, why: 'manuell' });
    return Promise.resolve();
  }

  return { onDeviceState, onTick, onGeo, onStartup, webhook, run, lastRun, sunToday };
};
