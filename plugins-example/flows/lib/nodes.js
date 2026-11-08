'use strict';
// Eingebaute Knoten. Aufbau eines Knotens (gilt auch für eigene Knoten):
//   { type, label, category, icon, desc, inputs, outputs, labels, fields:[…], run(ctx, msg), start(ctx) }
const expr = require('./expr');
const cron = require('./cron');
const { clone, isObj, uid } = require('./engine');

// ---------- Hilfsfunktionen ----------
function tokens(p) {
  const t = [];
  String(p).replace(/\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]|([^.[\]]+)/g, (_, a, b, c, d) => { t.push(a !== undefined ? Number(a) : b !== undefined ? b : c !== undefined ? c : d); return ''; });
  return t;
}
function getPath(o, p) { let x = o; for (const k of tokens(p)) { if (x === null || x === undefined) return undefined; x = x[k]; } return x; }
function setPath(o, p, v) {
  const t = tokens(p);
  if (!t.length || t.some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) throw new Error(`Ungültiger Pfad „${p}“`);
  let x = o;
  for (let i = 0; i < t.length - 1; i++) { if (x[t[i]] === null || typeof x[t[i]] !== 'object') x[t[i]] = typeof t[i + 1] === 'number' ? [] : {}; x = x[t[i]]; }
  x[t[t.length - 1]] = v;
}
function delPath(o, p) { const t = tokens(p); let x = o; for (let i = 0; i < t.length - 1; i++) { if (x === null || typeof x !== 'object') return; x = x[t[i]]; } if (x && typeof x === 'object') delete x[t[t.length - 1]]; }

const num = (x, d = 0) => { const n = Number(x); return x === '' || x === null || x === undefined || !isFinite(n) ? d : n; };
const truthy = (v) => (typeof v === 'string' ? !/^(|0|false|off|nein|no|aus)$/i.test(v.trim()) : !!v);
const toNum = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : NaN);
const parseMaybe = (s) => { if (typeof s !== 'string') return s; const t = s.trim(); if (!t) return undefined; try { return JSON.parse(t); } catch { return s; } };
const parseJson = (s, what) => { if (s === undefined || s === null || s === '') return undefined; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch (e) { throw new Error(`${what || 'JSON'} ungültig: ${e.message}`); } };
const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
const DAYS = { 1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa', 0: 'So' };
const daysOk = (days, d) => !Array.isArray(days) || !days.length || days.map(Number).includes(d.getDay());

function same(a, b) {
  if (a === b) return true;
  const x = toNum(a), y = toNum(b);
  if (!isNaN(x) && !isNaN(y)) return x === y;
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a).toLowerCase() === String(b).toLowerCase() || (typeof a === 'boolean' && String(b).toLowerCase() === (a ? 'on' : 'off'));
  if (a !== null && typeof a === 'object') return JSON.stringify(a) === (typeof b === 'string' ? b : JSON.stringify(b));
  return String(a) === String(b);
}
function compare(op, l, r) {
  switch (op) {
    case 'eq': return same(l, r);
    case 'neq': return !same(l, r);
    case 'gt': return toNum(l) > toNum(r);
    case 'gte': return toNum(l) >= toNum(r);
    case 'lt': return toNum(l) < toNum(r);
    case 'lte': return toNum(l) <= toNum(r);
    case 'between': { const [a, b] = String(r).split(/[;,\s]+/).map(Number); const v = toNum(l); return v >= Math.min(a, b) && v <= Math.max(a, b); }
    case 'in': return String(r).split(',').map((s) => s.trim()).some((s) => same(l, s));
    case 'contains': return Array.isArray(l) ? l.some((x) => same(x, r)) : String(l ?? '').toLowerCase().includes(String(r).toLowerCase());
    case 'notcontains': return !compare('contains', l, r);
    case 'starts': return String(l ?? '').toLowerCase().startsWith(String(r).toLowerCase());
    case 'ends': return String(l ?? '').toLowerCase().endsWith(String(r).toLowerCase());
    case 'regex': { try { return new RegExp(String(r), 'i').test(String(l ?? '')); } catch { throw new Error('Ungültiger regulärer Ausdruck'); } }
    case 'exists': return l !== undefined && l !== null;
    case 'notexists': return l === undefined || l === null;
    case 'empty': return l === undefined || l === null || l === '' || (Array.isArray(l) && !l.length) || (isObj(l) && !Object.keys(l).length);
    case 'notempty': return !compare('empty', l, r);
    case 'true': return truthy(l);
    case 'false': return !truthy(l);
    default: throw new Error('Unbekannter Vergleich: ' + op);
  }
}
const OPS = { eq: 'ist gleich', neq: 'ist nicht gleich', gt: 'größer als', gte: 'größer oder gleich', lt: 'kleiner als', lte: 'kleiner oder gleich', between: 'zwischen (a,b)', in: 'ist eines von (a,b,c)', contains: 'enthält', notcontains: 'enthält nicht', starts: 'beginnt mit', ends: 'endet mit', regex: 'passt auf Regex', exists: 'ist vorhanden', notexists: 'fehlt', empty: 'ist leer', notempty: 'ist nicht leer', true: 'ist wahr / an', false: 'ist falsch / aus' };
const NO_RIGHT = ['exists', 'notexists', 'empty', 'notempty', 'true', 'false'];
const unitMs = { ms: 1, s: 1000, min: 60000, h: 3600000 };

const refs = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
const pub = (d) => ({ id: d.id, name: d.name, room: d.room, type: d.type });

// ---------- Eingabefelder, die mehrfach vorkommen ----------
const F = {
  device: (extra) => ({ key: 'device', label: 'Gerät', type: 'device', ...extra }),
  rules: (n = 'rules') => ({
    key: n, label: 'Bedingungen', type: 'list', addLabel: '+ Bedingung', default: [{ left: 'payload', op: 'eq', right: '' }],
    item: [
      { key: 'left', label: 'Wert', type: 'text', raw: true, placeholder: 'payload  oder  {{ payload.temp }}', default: 'payload', w: 3 },
      { key: 'op', label: 'Vergleich', type: 'select', options: OPS, default: 'eq', w: 2 },
      { key: 'right', label: 'Vergleichswert', type: 'text', placeholder: '', showIf: { key: 'op', notIn: NO_RIGHT }, w: 3 },
    ],
  }),
};
const WEEK = { key: 'days', label: 'Wochentage', type: 'weekdays', default: [1, 2, 3, 4, 5, 6, 0] };

// ---------- Knoten ----------
const nodes = [];
const add = (d) => nodes.push(d);

// ===== Auslöser =====
add({
  type: 'trigger-manual', label: 'Manuell', category: 'Auslöser', icon: '▶', desc: 'Startet den Flow per Knopfdruck (auch zum Testen) oder über die KI.',
  fields: [{ key: 'payload', label: 'Start-Wert (optional)', type: 'json', placeholder: '{"test": 1}  oder Text', help: 'Wird als msg.payload verwendet, wenn beim Start nichts mitgegeben wird.' }],
  run(c, msg) { if (msg.payload === undefined || msg.payload === null) { const v = parseMaybe(c.cfg.payload); msg.payload = v === undefined ? null : v; } msg.topic = msg.topic || 'manuell'; return msg; },
  start() { return () => {}; },
});

add({
  type: 'trigger-device', label: 'Gerät ändert sich', category: 'Auslöser', icon: '💡', desc: 'Löst aus, wenn sich ein Gerät oder ein Wert ändert – optional erst, wenn der Zustand eine Zeit lang anhält.',
  fields: [
    F.device({ help: 'Leer = jedes Gerät' }),
    { key: 'attr', label: 'Wert', type: 'combo', options: ['on', 'value', 'current', 'target', 'power', 'brightness', 'state', 'online'], placeholder: 'leer = ganzer Zustand', help: 'Name des Werts im Gerätezustand, z. B. on, power, value.' },
    { key: 'op', label: 'Bedingung', type: 'select', options: { any: 'jede Änderung', ...OPS }, default: 'any' },
    { key: 'val', label: 'Vergleichswert', type: 'text', showIf: { key: 'op', notIn: ['any', ...NO_RIGHT] } },
    { key: 'onlyChange', label: 'Nur bei tatsächlicher Änderung', type: 'bool', default: true },
    { key: 'forSec', label: 'Zustand muss … Sekunden anhalten', type: 'number', default: 0, help: 'Beispiel: Tür länger als 300 s offen. Wird die Bedingung vorher wieder falsch, passiert nichts.' },
  ],
  start(c) {
    const cfg = c.cfg; const timers = new Map();
    const attr = String(cfg.attr || '').trim();
    const cond = (v) => cfg.op === 'any' || !cfg.op || compare(cfg.op, v, cfg.val);
    const off = c.onDevice((dev, st, prev) => {
      if (cfg.device && dev.id !== cfg.device) return;
      const v = attr ? st[attr] : st; const pv = attr ? prev[attr] : prev;
      const strip = (o) => { if (!o || typeof o !== 'object') return o; const x = { ...o }; delete x.ts; delete x.online; return x; };
      const changed = attr ? !same(v, pv) : JSON.stringify(strip(v)) !== JSON.stringify(strip(pv));
      if (cfg.onlyChange !== false && !changed) return;
      let ok; try { ok = v !== undefined && cond(v); } catch (e) { c.log(e.message, 'warn'); return; }
      const key = dev.id;
      if (!ok) { if (timers.has(key)) { clearTimeout(timers.get(key)); timers.delete(key); } return; }
      const fire = () => c.emit({ payload: v, topic: dev.name, device: pub(dev), state: st, prev, attr: attr || null }, { why: `Gerät „${dev.name}“` });
      if (num(cfg.forSec) > 0) {
        if (timers.has(key)) return;
        timers.set(key, setTimeout(() => { timers.delete(key); fire(); }, num(cfg.forSec) * 1000));
      } else fire();
    });
    return () => { off(); for (const t of timers.values()) clearTimeout(t); };
  },
});

add({
  type: 'trigger-schedule', label: 'Zeitplan', category: 'Auslöser', icon: '⏰', desc: 'Zu festen Zeiten, im Takt, nach Cron-Ausdruck oder relativ zu Sonnenauf-/-untergang.',
  fields: [
    { key: 'mode', label: 'Art', type: 'select', options: { daily: 'Täglich zur Uhrzeit', interval: 'Alle … (Intervall)', cron: 'Cron-Ausdruck', sun: 'Sonnenauf-/-untergang' }, default: 'daily' },
    { key: 'time', label: 'Uhrzeit', type: 'time', default: '07:00', showIf: { key: 'mode', in: ['daily'] } },
    { key: 'every', label: 'Alle', type: 'number', default: 5, showIf: { key: 'mode', in: ['interval'] } },
    { key: 'unit', label: 'Einheit', type: 'select', options: { s: 'Sekunden', min: 'Minuten', h: 'Stunden' }, default: 'min', showIf: { key: 'mode', in: ['interval'] } },
    { key: 'cron', label: 'Cron (Minute Stunde Tag Monat Wochentag)', type: 'text', default: '*/15 * * * *', placeholder: '0 7 * * MON-FRI', showIf: { key: 'mode', in: ['cron'] } },
    { key: 'event', label: 'Ereignis', type: 'select', options: { sunrise: 'Sonnenaufgang', sunset: 'Sonnenuntergang' }, default: 'sunset', showIf: { key: 'mode', in: ['sun'] } },
    { key: 'offset', label: 'Versatz in Minuten (− = früher)', type: 'number', default: 0, showIf: { key: 'mode', in: ['sun'] } },
    { ...WEEK, showIf: { key: 'mode', in: ['daily', 'sun'] } },
  ],
  start(c) {
    const cfg = c.cfg; const mode = cfg.mode || 'daily';
    if (mode === 'interval') {
      const ms = Math.max(1, num(cfg.every, 1)) * ({ s: 1000, min: 60000, h: 3600000 }[cfg.unit] || 60000);
      c.timer(() => c.emit({ payload: Date.now(), topic: 'zeitplan' }, { why: 'Intervall' }), Math.max(1000, ms));
      return;
    }
    let cr = null;
    if (mode === 'cron') cr = cron.parse(cfg.cron);
    const t = hm(cfg.time);
    if (mode === 'daily' && t === null) throw new Error('Uhrzeit ungültig (HH:MM)');
    let last = '';
    c.timer(() => {
      const d = new Date();
      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
      if (k === last) return;
      last = k;
      let due = false;
      if (mode === 'cron') due = cron.matches(cr, d);
      else if (mode === 'daily') due = daysOk(cfg.days, d) && minutesOf(d) === t;
      else if (mode === 'sun') {
        const s = c.api.sun(d); if (!s) return;
        const at = new Date(s[cfg.event || 'sunset'].getTime() + num(cfg.offset) * 60000);
        due = daysOk(cfg.days, d) && minutesOf(at) === minutesOf(d);
      }
      if (due) c.emit({ payload: Date.now(), topic: 'zeitplan', time: d.toISOString() }, { why: 'Zeitplan' });
    }, 1000);
  },
});

add({
  type: 'trigger-webhook', label: 'Webhook', category: 'Auslöser', icon: '🌐', desc: 'Startet den Flow, wenn die Webhook-Adresse aufgerufen wird (z. B. von Handy-Kurzbefehlen, IFTTT, Skripten).',
  fields: [
    { key: 'method', label: 'Methode', type: 'select', options: { POST: 'POST', GET: 'GET', PUT: 'PUT', DELETE: 'DELETE', ANY: 'beliebig' }, default: 'POST' },
    { key: 'path', label: 'Pfad', type: 'text', default: 'mein-hook', placeholder: 'mein-hook', help: 'Nur Kleinbuchstaben, Ziffern, - _ / – die vollständige Adresse steht unten.' },
    { key: 'respond', label: 'Antwort', type: 'select', options: { immediate: 'sofort „ok“ senden', wait: 'erst nach dem Ablauf (Antwort-Knoten möglich)' }, default: 'immediate' },
    { key: 'secret', label: 'Zusätzliches Passwort (optional)', type: 'text', help: 'Wird als ?secret=… oder Header x-flow-secret erwartet.' },
    { key: 'hookurl', type: 'hookurl' },
  ],
  start(c) {
    const cfg = c.cfg; const p = String(cfg.path || '').replace(/^\/+|\/+$/g, '');
    if (!/^[a-z0-9][a-z0-9_\-/]{0,80}$/.test(p)) throw new Error('Webhook-Pfad ungültig (a–z, 0–9, - _ /)');
    c.hook(cfg.method || 'POST', p, async (req) => {
      if (cfg.secret && req.query.secret !== cfg.secret && req.headers['x-flow-secret'] !== cfg.secret) return { status: 401, body: { error: 'Passwort falsch' } };
      const msg = { payload: req.body, topic: p, http: { method: req.method, query: req.query, headers: { 'content-type': req.headers['content-type'], 'user-agent': req.headers['user-agent'] }, ip: req.ip } };
      const exec = c.emit(msg, { why: 'Webhook /' + p });
      if (cfg.respond === 'wait') return exec.respondP;
      return { status: 200, body: { ok: true, exec: exec.id } };
    });
  },
});

add({
  type: 'trigger-mqtt', label: 'MQTT-Nachricht', category: 'Auslöser', icon: '📡', desc: 'Startet bei einer MQTT-Nachricht (über die MQTT-Verbindung von HomeLite).',
  fields: [
    { key: 'topic', label: 'Topic (Filter)', type: 'text', default: 'haus/#', placeholder: 'haus/+/temperatur', help: '+ = eine Ebene, # = alles darunter' },
    { key: 'parse', label: 'Inhalt als JSON lesen', type: 'bool', default: true },
  ],
  start(c) {
    if (!String(c.cfg.topic || '').trim()) throw new Error('Topic fehlt');
    c.mqtt(String(c.cfg.topic).trim(), (topic, payload) => {
      let v = payload;
      if (c.cfg.parse !== false) { try { v = JSON.parse(payload); } catch { /* Text */ } }
      c.emit({ payload: v, topic, raw: payload }, { why: 'MQTT ' + topic });
    });
  },
});

add({
  type: 'trigger-startup', label: 'HomeLite startet', category: 'Auslöser', icon: '🚀', desc: 'Läuft einmal, wenn HomeLite (bzw. das Plugin) gestartet wird.',
  fields: [{ key: 'delay', label: 'Verzögerung (Sekunden)', type: 'number', default: 20, help: 'Wartet, bis Geräte verbunden sind.' }],
  start(c) { if (c.boot) c.after(() => c.emit({ payload: Date.now(), topic: 'start' }, { why: 'Start' }), Math.max(1, num(c.cfg.delay, 20)) * 1000); },
});

add({
  type: 'flow-in', label: 'Unterflow-Eingang', category: 'Auslöser', icon: '⤵', desc: 'Einstieg, wenn dieser Flow von einem anderen Flow aufgerufen wird („Flow aufrufen“).',
  fields: [], start() { return () => {}; },
});

add({
  type: 'catch', label: 'Fehler abfangen', category: 'Auslöser', icon: '🛟', desc: 'Läuft, wenn in diesem Flow ein Knoten fehlschlägt. msg.error enthält Knoten und Meldung.',
  fields: [{ key: 'only', label: 'Nur bei Knoten … (Name/Typ, Komma-getrennt)', type: 'text', placeholder: 'leer = alle' }],
  start() { return () => {}; },
});

// ===== Logik =====
add({
  type: 'if', label: 'Wenn', category: 'Logik', icon: '🔀', desc: 'Verzweigt: Ausgang 1 wenn die Bedingungen zutreffen, sonst Ausgang 2.', outputs: 2, labels: ['ja', 'nein'],
  fields: [{ key: 'combine', label: 'Verknüpfung', type: 'select', options: { and: 'alle müssen zutreffen (UND)', or: 'eine genügt (ODER)' }, default: 'and' }, F.rules()],
  run(c, msg) {
    const res = (c.cfg.rules || []).map((r) => compare(r.op, c.val(r.left), r.right));
    const ok = !res.length ? true : c.cfg.combine === 'or' ? res.some(Boolean) : res.every(Boolean);
    return ok ? [msg, null] : [null, msg];
  },
});

add({
  type: 'switch', label: 'Weiche', category: 'Logik', icon: '🚦', desc: 'Leitet je nach Wert auf verschiedene Ausgänge (wie Node-RED „switch“).', outputs: 1, dyn: { list: 'rules', elseKey: 'else' },
  fields: [
    { key: 'prop', label: 'Wert', type: 'text', raw: true, default: 'payload', placeholder: 'payload  oder  {{ payload.modus }}' },
    { key: 'rules', label: 'Ausgänge', type: 'list', addLabel: '+ Ausgang', default: [{ op: 'eq', right: '' }], item: [
      { key: 'op', label: 'Vergleich', type: 'select', options: OPS, default: 'eq', w: 2 },
      { key: 'right', label: 'Vergleichswert', type: 'text', showIf: { key: 'op', notIn: NO_RIGHT }, w: 3 },
    ] },
    { key: 'else', label: 'Zusätzlicher Ausgang „sonst“', type: 'bool', default: true },
    { key: 'stopFirst', label: 'Nach erstem Treffer aufhören', type: 'bool', default: true },
  ],
  run(c, msg) {
    const rules = c.cfg.rules || []; const v = c.val(c.cfg.prop);
    const out = new Array(rules.length + (c.cfg.else ? 1 : 0)).fill(null);
    let hit = false;
    for (let i = 0; i < rules.length; i++) {
      if (compare(rules[i].op, v, rules[i].right)) { out[i] = msg; hit = true; if (c.cfg.stopFirst !== false) break; }
    }
    if (!hit && c.cfg.else) out[rules.length] = msg;
    return out;
  },
});

add({
  type: 'time-gate', label: 'Zeitfenster', category: 'Logik', icon: '🕒', desc: 'Lässt Nachrichten nur zu bestimmten Zeiten (oder nur bei Dunkelheit/Tageslicht) durch.', outputs: 2, labels: ['im Fenster', 'außerhalb'],
  fields: [
    { key: 'mode', label: 'Art', type: 'select', options: { time: 'Uhrzeit von – bis', dark: 'nur wenn es dunkel ist', light: 'nur bei Tageslicht' }, default: 'time' },
    { key: 'from', label: 'von', type: 'time', default: '06:00', showIf: { key: 'mode', in: ['time'] } },
    { key: 'to', label: 'bis', type: 'time', default: '22:00', showIf: { key: 'mode', in: ['time'] }, help: 'Über Mitternacht möglich (z. B. 22:00 – 06:00).' },
    WEEK,
  ],
  run(c, msg) {
    const d = new Date(); let ok = daysOk(c.cfg.days, d);
    if (ok) {
      if (c.cfg.mode === 'dark' || c.cfg.mode === 'light') {
        const s = c.api.sun(d); if (!s) throw new Error('Sonnenstand unbekannt – Heimatzone mit Koordinaten fehlt');
        const day = d >= s.sunrise && d < s.sunset;
        ok = c.cfg.mode === 'light' ? day : !day;
      } else {
        const a = hm(c.cfg.from), b = hm(c.cfg.to), n = minutesOf(d);
        if (a === null || b === null) throw new Error('Zeit ungültig (HH:MM)');
        ok = a <= b ? n >= a && n < b : n >= a || n < b;
      }
    }
    return ok ? [msg, null] : [null, msg];
  },
});

add({
  type: 'loop', label: 'Schleife', category: 'Logik', icon: '🔁', desc: 'Wiederholt: Ausgang 1 = nächste Runde (zurück an den Eingang verdrahten), Ausgang 2 = fertig.', outputs: 2, labels: ['Runde', 'fertig'],
  fields: [
    { key: 'max', label: 'Höchstens … Runden', type: 'number', default: 5 },
    { key: 'cond', label: 'Weiter solange (optional)', type: 'text', placeholder: '{{ payload < 100 }}', help: 'Leer = nur die Rundenzahl zählt. msg.loop.i ist die laufende Runde (ab 0).' },
  ],
  run(c, msg) {
    const i = msg.loop && Number.isFinite(msg.loop.i) ? msg.loop.i + 1 : 0;
    const max = Math.min(1000, num(c.cfg.max, 5));
    const go = i < max && (c.cfg.cond === '' || c.cfg.cond === undefined || truthy(c.cfg.cond));
    if (go) { msg.loop = { i, max }; return [msg, null]; }
    delete msg.loop; return [null, msg];
  },
});

add({
  type: 'rbe', label: 'Nur Änderungen', category: 'Logik', icon: '🧮', desc: 'Lässt nur durch, wenn sich der Wert gegenüber dem letzten geändert hat (optional mit Toleranz).',
  fields: [
    { key: 'prop', label: 'Wert', type: 'text', raw: true, default: 'payload' },
    { key: 'dead', label: 'Toleranz (nur Zahlen)', type: 'number', default: 0 },
  ],
  run(c, msg) {
    const v = c.val(c.cfg.prop); const last = c.state.has ? c.state.last : c.state.last;
    const d = num(c.cfg.dead);
    const first = !('last' in c.state);
    const diff = first || (d > 0 && !isNaN(toNum(v)) && !isNaN(toNum(last)) ? Math.abs(toNum(v) - toNum(last)) > d : JSON.stringify(v) !== JSON.stringify(last));
    if (!diff) return null;
    c.state.last = v; return msg;
  },
});

// ===== Daten =====
add({
  type: 'set', label: 'Werte setzen', category: 'Daten', icon: '✏️', desc: 'Setzt, kopiert oder löscht Felder von msg, flow oder global. Werte dürfen {{ Ausdrücke }} enthalten.',
  fields: [{ key: 'rows', label: 'Zuweisungen', type: 'list', addLabel: '+ Zuweisung', default: [{ action: 'set', target: 'payload', value: '', vtype: 'auto' }], item: [
    { key: 'action', label: 'Aktion', type: 'select', options: { set: 'setzen', copy: 'kopieren von', delete: 'löschen' }, default: 'set', w: 2 },
    { key: 'target', label: 'Feld', type: 'text', placeholder: 'payload.temp  /  flow.zaehler  /  global.name', default: 'payload', w: 3 },
    { key: 'value', label: 'Wert / Quelle', type: 'text', placeholder: '{{ payload * 2 }}', showIf: { key: 'action', notIn: ['delete'] }, w: 3 },
    { key: 'vtype', label: 'Typ', type: 'select', options: { auto: 'automatisch', string: 'Text', number: 'Zahl', boolean: 'Ja/Nein', json: 'JSON', date: 'Zeitstempel (ms)', iso: 'Datum (ISO)' }, default: 'auto', showIf: { key: 'action', in: ['set'] }, w: 2 },
  ] }],
  run(c, msg) {
    const put = (target, v) => {
      const t = String(target || '').trim().replace(/^msg\./, '');
      if (/^flow\./.test(t)) setPath(c.flowCtx, t.slice(5), v);
      else if (/^global\./.test(t)) setPath(c.globalCtx, t.slice(7), v);
      else setPath(msg, t, v);
    };
    const get = (src) => { const t = String(src).trim().replace(/^msg\./, ''); return /^flow\./.test(t) ? getPath(c.flowCtx, t.slice(5)) : /^global\./.test(t) ? getPath(c.globalCtx, t.slice(7)) : getPath(msg, t); };
    for (const r of c.cfg.rows || []) {
      if (!String(r.target || '').trim()) continue;
      if (r.action === 'delete') {
        const t = String(r.target).trim().replace(/^msg\./, '');
        if (/^flow\./.test(t)) delPath(c.flowCtx, t.slice(5)); else if (/^global\./.test(t)) delPath(c.globalCtx, t.slice(7)); else delPath(msg, t);
      } else if (r.action === 'copy') put(r.target, clone({ v: get(r.value) }).v);
      else {
        let v = r.value;
        switch (r.vtype) {
          case 'string': v = typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''); break;
          case 'number': v = Number(v); if (isNaN(v)) throw new Error(`„${r.value}“ ist keine Zahl`); break;
          case 'boolean': v = typeof v === 'string' ? /^(true|1|on|an|ja|yes)$/i.test(v.trim()) : !!v; break;
          case 'json': v = parseJson(v, 'JSON-Wert'); break;
          case 'date': v = Date.now(); break;
          case 'iso': v = new Date().toISOString(); break;
          default: if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) && v.trim().length < 16) v = Number(v);
        }
        put(r.target, v);
      }
    }
    return msg;
  },
});

add({
  type: 'code', label: 'Code (JavaScript)', category: 'Daten', icon: '🧑‍💻', noMcp: true, desc: 'Eigene Logik in JavaScript. Verfügbar: msg, flow, global, send(port,msg), log(), $device(), $fmt() …',
  outputs: 1, fields: [
    { key: 'code', label: 'Code', type: 'code', default: '// msg ändern und zurückgeben – oder null für „nichts weitergeben“\nmsg.payload = msg.payload;\nreturn msg;' },
    { key: 'outs', label: 'Anzahl Ausgänge', type: 'number', default: 1, help: 'Mit send(2, msg) oder return [msgA, msgB] auf mehrere Ausgänge.' },
  ],
  run(c, msg) {
    const sc = c.scope(msg);
    const r = expr.run('code', String(c.cfg.code || ''), sc, 1500);
    const sync = (live, next) => { if (JSON.stringify(live) === JSON.stringify(next)) return; for (const k of Object.keys(live)) delete live[k]; Object.assign(live, next); };
    sync(c.flowCtx, r.flow); sync(c.globalCtx, r.global);
    for (const l of r.logs) c.log(l);
    const base = r.value === undefined ? [] : Array.isArray(r.value) ? r.value : [r.value];
    const ports = base.map((x) => (x === null || x === undefined ? [] : Array.isArray(x) ? x : [x]));
    for (const [p, m] of r.out) { ports[p] = (ports[p] || []).concat(m); }
    return ports.map((l) => (l || []));
  },
});
nodes[nodes.length - 1].dyn = { list: null, fixedKey: 'outs' };

add({
  type: 'template', label: 'Text-Vorlage', category: 'Daten', icon: '📝', desc: 'Baut einen Text mit {{ Platzhaltern }} und legt ihn in ein Feld (Standard: payload).',
  fields: [
    { key: 'target', label: 'Ziel-Feld', type: 'text', default: 'payload', raw: true },
    { key: 'template', label: 'Vorlage', type: 'textarea', default: 'Temperatur: {{ payload }} °C', rows: 4 },
  ],
  run(c, msg) { setPath(msg, String(c.cfg.target || 'payload').replace(/^msg\./, ''), c.cfg.template); return msg; },
});

add({
  type: 'json', label: 'JSON', category: 'Daten', icon: '{ }', desc: 'Wandelt Text in Objekt (parse) oder Objekt in Text (stringify).',
  fields: [{ key: 'mode', label: 'Aktion', type: 'select', options: { auto: 'automatisch', parse: 'Text → Objekt', stringify: 'Objekt → Text' }, default: 'auto' }, { key: 'prop', label: 'Feld', type: 'text', default: 'payload', raw: true }],
  run(c, msg) {
    const p = String(c.cfg.prop || 'payload').replace(/^msg\./, ''); const v = getPath(msg, p);
    const m = c.cfg.mode === 'auto' ? (typeof v === 'string' ? 'parse' : 'stringify') : c.cfg.mode;
    setPath(msg, p, m === 'parse' ? parseJson(v, 'Text') : JSON.stringify(v));
    return msg;
  },
});

add({
  type: 'split', label: 'Aufteilen', category: 'Daten', icon: '✂️', desc: 'Zerlegt eine Liste (oder Objekt/Text) in einzelne Nachrichten – eine pro Element.',
  fields: [
    { key: 'sep', label: 'Trennzeichen (für Text)', type: 'text', default: '\\n', help: '\\n = neue Zeile' },
    { key: 'sequential', label: 'Nacheinander abarbeiten (nächstes Element erst nach Ende des vorherigen)', type: 'bool', default: false },
  ],
  async run(c, msg) {
    const p = msg.payload; let items; let type = 'array';
    if (Array.isArray(p)) items = p.map((v) => ({ v }));
    else if (isObj(p)) { items = Object.entries(p).map(([key, v]) => ({ v, key })); type = 'object'; }
    else if (typeof p === 'string') { items = p.split(String(c.cfg.sep ?? '\\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t')).map((v) => ({ v })); type = 'string'; }
    else items = [{ v: p }];
    const id = uid();
    const out = items.map((it, index) => { const m = { ...clone(msg), payload: it.v, parts: { id, index, count: items.length, type } }; if (it.key !== undefined) m.key = it.key; return m; });
    if (c.cfg.sequential) { for (const m of out) await c.send(0, m); return null; }
    return [out];
  },
});

add({
  type: 'join', label: 'Zusammenführen', category: 'Daten', icon: '🧲', desc: 'Sammelt die Nachrichten eines „Aufteilen“ (oder N Stück) wieder zu einer Liste/einem Objekt.',
  fields: [
    { key: 'mode', label: 'Wann fertig', type: 'select', options: { auto: 'wenn alle Teile da sind (nach „Aufteilen“)', count: 'nach einer festen Anzahl' }, default: 'auto' },
    { key: 'count', label: 'Anzahl', type: 'number', default: 2, showIf: { key: 'mode', in: ['count'] } },
    { key: 'as', label: 'Ergebnis', type: 'select', options: { array: 'Liste', object: 'Objekt (nach msg.key)', sum: 'Summe', text: 'Text (Zeilen)' }, default: 'array' },
    { key: 'timeout', label: 'Spätestens nach … Sekunden ausgeben (0 = warten)', type: 'number', default: 0 },
  ],
  run(c, msg) {
    const sc = c.scratch; const key = c.cfg.mode === 'count' ? '_' : (msg.parts && msg.parts.id) || '_';
    const g = sc[key] = sc[key] || { items: [], msgs: [], release: null, timer: null };
    g.items.push({ idx: msg.parts ? msg.parts.index : g.items.length, v: msg.payload, k: msg.key }); g.last = msg;
    const need = c.cfg.mode === 'count' ? num(c.cfg.count, 2) : (msg.parts ? msg.parts.count : 1);
    const finish = () => {
      if (g.timer) clearTimeout(g.timer);
      delete sc[key];
      const list = g.items.sort((a, b) => a.idx - b.idx);
      let payload;
      if (c.cfg.as === 'object') { payload = {}; for (const it of list) payload[it.k ?? it.idx] = it.v; }
      else if (c.cfg.as === 'sum') payload = list.reduce((s, it) => s + num(it.v), 0);
      else if (c.cfg.as === 'text') payload = list.map((it) => (typeof it.v === 'object' ? JSON.stringify(it.v) : it.v)).join('\n');
      else payload = list.map((it) => it.v);
      const out = { ...clone(g.last), payload }; delete out.parts; delete out.key;
      return out;
    };
    if (g.items.length >= need) { const out = finish(); const rel = g.release; if (rel) { rel(); } return out; }
    if (num(c.cfg.timeout) > 0 && !g.timer) {
      g.release = c.hold();
      g.timer = setTimeout(async () => { try { if (sc[key] === g) { const out = finish(); await c.send(0, out); } } finally { g.release(); } }, num(c.cfg.timeout) * 1000);
    }
    return null;
  },
});

add({
  type: 'merge', label: 'Zweige vereinen', category: 'Daten', icon: '⛙', desc: 'Wartet, bis ALLE verbundenen Eingänge eine Nachricht geliefert haben, und gibt sie gemeinsam aus (wie n8n „Merge“).',
  fields: [
    { key: 'as', label: 'Ergebnis', type: 'select', options: { object: 'Objekt (Name des Quell-Knotens → Wert)', array: 'Liste (in Ankunftsreihenfolge)', first: 'nur die erste Nachricht' }, default: 'object' },
    { key: 'timeout', label: 'Spätestens nach … Sekunden mit dem Vorhandenen weitermachen (0 = nur vollständig)', type: 'number', default: 0 },
  ],
  run(c, msg) {
    const sc = c.scratch; const expected = new Set(c.sources);
    const g = sc.g = sc.g || { got: new Map(), done: false, release: null, timer: null };
    if (g.done) return null;
    g.got.set(c.from, msg);
    const build = () => {
      g.done = true; if (g.timer) clearTimeout(g.timer);
      const entries = [...g.got.entries()];
      let payload;
      if (c.cfg.as === 'array') payload = entries.map(([, m]) => m.payload);
      else if (c.cfg.as === 'first') payload = entries[0][1].payload;
      else { payload = {}; for (const [id, m] of entries) { const nm = (c.exec.trace.find((t) => t.node === id) || {}).name || id; payload[nm] = m.payload; } }
      return { ...clone(entries[entries.length - 1][1]), payload };
    };
    if ([...expected].every((s) => g.got.has(s))) { const out = build(); if (g.release) g.release(); return out; }
    if (num(c.cfg.timeout) > 0 && !g.timer) {
      g.release = c.hold();
      g.timer = setTimeout(async () => { try { if (!g.done) await c.send(0, build()); } finally { g.release(); } }, num(c.cfg.timeout) * 1000);
    }
    return null;
  },
});

// ===== Fluss =====
add({
  type: 'delay', label: 'Warten', category: 'Fluss', icon: '⏳', noTimeout: true, desc: 'Hält die Nachricht für eine Zeit zurück (bis 48 h; geht bei Neustart verloren).',
  fields: [{ key: 'amount', label: 'Dauer', type: 'text', default: '5', help: 'Zahl oder {{ Ausdruck }}' }, { key: 'unit', label: 'Einheit', type: 'select', options: { ms: 'Millisekunden', s: 'Sekunden', min: 'Minuten', h: 'Stunden' }, default: 's' }],
  async run(c, msg) {
    const ms = num(c.cfg.amount) * (unitMs[c.cfg.unit] || 1000);
    if (!(ms >= 0) || ms > 48 * 3600000) throw new Error('Dauer ungültig (0 bis 48 h)');
    await c.sleep(ms); return msg;
  },
});

add({
  type: 'debounce', label: 'Entprellen', category: 'Fluss', icon: '🫧', noTimeout: true, desc: 'Gibt erst weiter, wenn für eine Zeit nichts Neues kam (nur die letzte Nachricht). Ideal für flackernde Sensoren.',
  fields: [{ key: 'ms', label: 'Ruhezeit (Sekunden)', type: 'number', default: 5 }, { key: 'lead', label: 'Stattdessen sofort die erste weitergeben, dann sperren', type: 'bool', default: false }],
  run(c, msg) {
    const st = c.state; const ms = num(c.cfg.ms, 5) * 1000;
    if (c.cfg.lead) { if (st.until && Date.now() < st.until) { st.until = Date.now() + ms; return null; } st.until = Date.now() + ms; return msg; }
    if (st.timer) { clearTimeout(st.timer); st.release && st.release(); }
    st.release = c.hold();
    st.timer = setTimeout(async () => { const rel = st.release; st.timer = null; try { await c.send(0, msg); } finally { rel(); } }, ms);
    return null;
  },
});

add({
  type: 'throttle', label: 'Drosseln', category: 'Fluss', icon: '🚰', desc: 'Lässt höchstens eine Nachricht pro Zeitraum durch, der Rest wird verworfen.',
  fields: [{ key: 'ms', label: 'Mindestabstand (Sekunden)', type: 'number', default: 60 }],
  run(c, msg) { const now = Date.now(); if (c.state.last && now - c.state.last < num(c.cfg.ms, 60) * 1000) return null; c.state.last = now; return msg; },
});

add({
  type: 'wait-event', label: 'Auf Gerät warten', category: 'Fluss', icon: '⌛', noTimeout: true, desc: 'Hält an, bis ein Gerät einen Zustand erreicht (oder die Zeit abläuft). Ausgang 1 = erreicht, Ausgang 2 = Zeit abgelaufen.', outputs: 2, labels: ['erreicht', 'Zeit um'],
  fields: [
    F.device(),
    { key: 'attr', label: 'Wert', type: 'combo', options: ['on', 'value', 'current', 'power', 'state'], default: 'on' },
    { key: 'op', label: 'Bedingung', type: 'select', options: OPS, default: 'eq' },
    { key: 'val', label: 'Vergleichswert', type: 'text', default: 'false', showIf: { key: 'op', notIn: NO_RIGHT } },
    { key: 'now', label: 'Sofort weiter, wenn die Bedingung schon erfüllt ist', type: 'bool', default: true },
    { key: 'timeout', label: 'Höchstens warten (Sekunden, 0 = ewig)', type: 'number', default: 600 },
  ],
  async run(c, msg) {
    const d = c.api.devices.get(c.cfg.device); if (!d) throw new Error('Gerät nicht gefunden');
    const attr = String(c.cfg.attr || '').trim(); const test = (st) => { const v = attr ? st[attr] : st; return v !== undefined && compare(c.cfg.op, v, c.cfg.val); };
    const ok = (st) => ({ ...msg, payload: attr ? st[attr] : st, device: pub(d), state: st });
    if (c.cfg.now !== false && test(d.state_raw || {})) return [ok(d.state_raw || {}), null];
    const r = await c.cancellable((resolve) => {
      const off = c.onDevice((dev, st) => { if (dev.id === d.id && test(st)) resolve({ hit: st }); });
      const t = num(c.cfg.timeout) > 0 ? setTimeout(() => resolve({ timeout: true }), num(c.cfg.timeout) * 1000) : null;
      return () => { off(); if (t) clearTimeout(t); };
    });
    return r.hit ? [ok(r.hit), null] : [null, msg];
  },
});

add({
  type: 'call-flow', label: 'Flow aufrufen', category: 'Fluss', icon: '📞', noTimeout: true, desc: 'Ruft einen anderen Flow (Unterflow) auf und wartet auf sein Ergebnis („Unterflow-Ergebnis“-Knoten).',
  fields: [{ key: 'flow', label: 'Flow', type: 'flowref' }, { key: 'wait', label: 'Auf das Ende warten und Ergebnis übernehmen', type: 'bool', default: true }],
  async run(c, msg) {
    if (!c.cfg.flow) throw new Error('Kein Flow gewählt');
    if (c.cfg.wait === false) { c.runFlow(c.cfg.flow, msg).catch((e) => c.log(e.message, 'warn')); return msg; }
    return c.runFlow(c.cfg.flow, msg);
  },
});

add({
  type: 'flow-out', label: 'Unterflow-Ergebnis', category: 'Fluss', icon: '⤴', outputs: 0, desc: 'Gibt die Nachricht als Ergebnis an den aufrufenden Flow zurück.',
  fields: [], run(c, msg) { c.setResult(msg); return null; },
});

add({
  type: 'stop', label: 'Fehler auslösen', category: 'Fluss', icon: '⛔', outputs: 0, desc: 'Bricht diesen Zweig mit einer Fehlermeldung ab (wird von „Fehler abfangen“ behandelt).',
  fields: [{ key: 'message', label: 'Meldung', type: 'text', default: 'Abgebrochen' }], run(c) { throw new Error(String(c.cfg.message || 'Abgebrochen')); },
});

add({ type: 'comment', label: 'Notiz', category: 'Fluss', icon: '🗒', inputs: 0, outputs: 0, passive: true, desc: 'Kommentar im Flow (ohne Funktion).', fields: [{ key: 'text', label: 'Text', type: 'textarea', rows: 5, default: '' }] });

add({
  type: 'debug', label: 'Ausgabe / Debug', category: 'Fluss', icon: '🐞', desc: 'Zeigt Werte in der Debug-Leiste an (und gibt die Nachricht unverändert weiter).',
  fields: [
    { key: 'what', label: 'Anzeigen', type: 'select', options: { payload: 'msg.payload', msg: 'ganze Nachricht', expr: 'Ausdruck' }, default: 'payload' },
    { key: 'expr', label: 'Ausdruck', type: 'text', placeholder: '{{ payload.temp }}', showIf: { key: 'what', in: ['expr'] } },
    { key: 'label', label: 'Beschriftung', type: 'text' },
    { key: 'toLog', label: 'Auch ins HomeLite-Protokoll schreiben', type: 'bool', default: false },
  ],
  run(c, msg) {
    const v = c.cfg.what === 'msg' ? msg : c.cfg.what === 'expr' ? c.cfg.expr : msg.payload;
    c.debug(v, c.cfg.label);
    if (c.cfg.toLog) c.log(`${c.cfg.label ? c.cfg.label + ': ' : ''}${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return msg;
  },
});

// ===== Aktionen =====
const ACTIONS = ['on', 'off', 'toggle', 'brightness', 'setpoint', 'open', 'close', 'stop'];
add({
  type: 'device-control', label: 'Gerät steuern', category: 'Aktion', icon: '🎛', desc: 'Schaltet ein Gerät (an/aus/umschalten, Helligkeit, Solltemperatur, Rollo …).',
  fields: [
    F.device({ help: 'Mehrere: Komma-getrennt oder {{ Liste }}' }),
    { key: 'action', label: 'Aktion', type: 'combo', options: ACTIONS, default: 'on' },
    { key: 'value', label: 'Wert (optional)', type: 'text', placeholder: '{{ payload }}  /  50', help: 'z. B. Helligkeit in % oder Solltemperatur.' },
  ],
  async run(c, msg) {
    const list = refs(c.cfg.device); if (!list.length) throw new Error('Kein Gerät gewählt');
    const v = c.cfg.value === '' || c.cfg.value === undefined ? undefined : isNaN(toNum(c.cfg.value)) ? c.cfg.value : toNum(c.cfg.value);
    const action = String(c.cfg.action || '').trim(); if (!action) throw new Error('Keine Aktion gewählt');
    const res = await Promise.all(list.map((r) => c.api.devices.control(r, action, v)));
    msg.result = res.length === 1 ? res[0] : res; return msg;
  },
});

add({
  type: 'device-read', label: 'Gerät lesen', category: 'Aktion', icon: '🔎', desc: 'Liest den aktuellen Zustand eines Geräts in die Nachricht.',
  fields: [F.device(), { key: 'attr', label: 'Wert (leer = ganzer Zustand)', type: 'combo', options: ['on', 'value', 'current', 'target', 'power', 'brightness', 'online'] }],
  run(c, msg) {
    const d = c.api.devices.get(c.cfg.device); if (!d) throw new Error('Gerät nicht gefunden');
    const a = String(c.cfg.attr || '').trim();
    msg.payload = a ? d.state_raw[a] : d.state_raw; msg.device = pub(d); msg.state = d.state_raw; return msg;
  },
});

add({
  type: 'virtual-device', label: 'Virtuelles Gerät', category: 'Aktion', icon: '🧩', desc: 'Legt ein eigenes Gerät (Schalter/Sensor) an und setzt seinen Wert – erscheint in HomeLite wie jedes andere Gerät.',
  fields: [
    { key: 'key', label: 'Kennung', type: 'text', default: 'mein-wert', help: 'Eindeutig, a–z 0–9 -' },
    { key: 'name', label: 'Name', type: 'text', default: 'Mein Wert' },
    { key: 'dtype', label: 'Typ', type: 'select', options: { sensor: 'Sensor (Zahl/Text)', switch: 'Schalter (an/aus)', binary: 'Binärsensor (ja/nein)' }, default: 'sensor' },
    { key: 'unit', label: 'Einheit', type: 'text', showIf: { key: 'dtype', in: ['sensor'] } },
    { key: 'value', label: 'Wert', type: 'text', default: '{{ payload }}' },
  ],
  run(c, msg) {
    const key = String(c.cfg.key || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test('flow-' + key) || !key) throw new Error('Kennung ungültig');
    const type = c.cfg.dtype || 'sensor';
    c.api.devices.ensure({ key: 'flow-' + key, name: c.cfg.name || key, type, unit: c.cfg.unit || '' });
    const v = c.cfg.value;
    c.api.devices.setState('flow-' + key, type === 'sensor' ? { value: isNaN(toNum(v)) ? v : toNum(v) } : { on: truthy(v) });
    return msg;
  },
});

add({
  type: 'notify', label: 'Benachrichtigen', category: 'Aktion', icon: '🔔', desc: 'Sendet eine Benachrichtigung über die in HomeLite eingerichteten Wege (Push/Telegram …).',
  fields: [{ key: 'title', label: 'Titel', type: 'text', default: 'HomeLite' }, { key: 'message', label: 'Nachricht', type: 'textarea', rows: 3, default: '{{ payload }}' }],
  run(c, msg) { c.api.notify(String(c.cfg.title), typeof c.cfg.message === 'object' ? JSON.stringify(c.cfg.message) : String(c.cfg.message ?? '')); return msg; },
});

add({
  type: 'mqtt-out', label: 'MQTT senden', category: 'Aktion', icon: '📤', desc: 'Veröffentlicht eine MQTT-Nachricht.',
  fields: [{ key: 'topic', label: 'Topic', type: 'text', placeholder: 'haus/licht/set' }, { key: 'payload', label: 'Inhalt', type: 'textarea', rows: 3, default: '{{ payload }}' }, { key: 'retain', label: 'Retain', type: 'bool', default: false }],
  async run(c, msg) {
    if (!String(c.cfg.topic || '').trim()) throw new Error('Topic fehlt');
    if (!c.api.mqtt.connected()) throw new Error('MQTT ist nicht verbunden');
    await c.api.mqtt.publish(String(c.cfg.topic).trim(), c.cfg.payload ?? '', { retain: !!c.cfg.retain }); return msg;
  },
});

add({
  type: 'http-request', label: 'HTTP-Anfrage', category: 'Aktion', icon: '🌍', desc: 'Ruft eine Web-Adresse/API ab (GET, POST …). Antwort landet in msg.payload, Status in msg.http.',
  fields: [
    { key: 'method', label: 'Methode', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
    { key: 'url', label: 'Adresse', type: 'text', placeholder: 'https://api.example.com/x?id={{ payload }}' },
    { key: 'headers', label: 'Header (JSON, optional)', type: 'json', placeholder: '{"Authorization": "Bearer …"}' },
    { key: 'body', label: 'Inhalt (bei POST/PUT)', type: 'textarea', rows: 4, placeholder: '{{ payload }}', showIf: { key: 'method', notIn: ['GET', 'DELETE'] } },
    { key: 'timeout', label: 'Zeitlimit (Sekunden)', type: 'number', default: 15 },
    { key: 'ignore', label: 'Auch bei Fehlerstatus (4xx/5xx) weitermachen', type: 'bool', default: false },
  ],
  async run(c, msg) {
    const url = String(c.cfg.url || '').trim(); if (!/^https?:\/\//i.test(url)) throw new Error('Adresse muss mit http:// oder https:// beginnen');
    const method = c.cfg.method || 'GET'; const headers = { ...(parseJson(c.cfg.headers, 'Header') || {}) };
    let body;
    if (!['GET', 'HEAD', 'DELETE'].includes(method) && c.cfg.body !== '' && c.cfg.body !== undefined) {
      if (typeof c.cfg.body === 'string') { body = c.cfg.body; if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type') && /^\s*[[{]/.test(body)) headers['Content-Type'] = 'application/json'; }
      else { body = JSON.stringify(c.cfg.body); headers['Content-Type'] = headers['Content-Type'] || 'application/json'; }
    }
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), Math.max(1, num(c.cfg.timeout, 15)) * 1000);
    let r, text;
    try { r = await fetch(url, { method, headers, body, signal: ac.signal, redirect: 'follow' }); text = (await r.text()).slice(0, 5e6); }
    catch (e) { throw new Error(ac.signal.aborted ? 'Zeitlimit überschritten' : `Anfrage fehlgeschlagen: ${e.cause && e.cause.code ? e.cause.code : e.message}`); }
    finally { clearTimeout(t); }
    let payload = text; try { if (/json/i.test(r.headers.get('content-type') || '') || /^\s*[[{]/.test(text)) payload = JSON.parse(text); } catch { /* Text */ }
    msg.payload = payload; msg.http = { status: r.status, ok: r.ok, type: r.headers.get('content-type') || '' };
    if (!r.ok && !c.cfg.ignore) throw new Error(`HTTP ${r.status} ${r.statusText}${typeof payload === 'string' && payload ? ': ' + payload.slice(0, 120) : ''}`);
    return msg;
  },
});

add({
  type: 'webhook-response', label: 'Webhook-Antwort', category: 'Aktion', icon: '↩', desc: 'Antwortet dem Aufrufer des Webhooks (Webhook-Auslöser muss auf „erst nach dem Ablauf“ stehen).',
  fields: [
    { key: 'status', label: 'Status', type: 'number', default: 200 },
    { key: 'body', label: 'Inhalt', type: 'textarea', rows: 4, default: '{{ payload }}' },
    { key: 'headers', label: 'Header (JSON, optional)', type: 'json' },
  ],
  run(c, msg) { c.respond({ status: num(c.cfg.status, 200), body: c.cfg.body === '' ? { ok: true } : c.cfg.body, headers: parseJson(c.cfg.headers, 'Header') }); return msg; },
});

add({
  type: 'core-call', label: 'HomeLite-Werkzeug', category: 'Aktion', icon: '🏠', noMcp: true, desc: 'Ruft ein HomeLite-Werkzeug auf (Energie, Heizung, Automationen, Protokoll …) – dasselbe, was die KI nutzt.',
  fields: [
    { key: 'tool', label: 'Werkzeug', type: 'combo', options: [], dynOptions: 'coretools', placeholder: 'z. B. get_energy' },
    { key: 'args', label: 'Parameter (JSON)', type: 'json', placeholder: '{"id": "{{ payload }}"}' },
  ],
  async run(c, msg) {
    if (!c.api.core) throw new Error('Dem Plugin fehlt die Berechtigung „core“');
    const tool = String(c.cfg.tool || '').trim(); if (!tool) throw new Error('Werkzeug fehlt');
    msg.payload = await c.api.core.call(tool, parseJson(c.cfg.args, 'Parameter') || {}); return msg;
  },
});

add({
  type: 'fire-automation', label: 'Automation starten', category: 'Aktion', icon: '⚡', desc: 'Löst Automationen mit dem Auslöser „Webhook“ und diesem Namen aus.',
  fields: [{ key: 'name', label: 'Webhook-Name der Automation', type: 'text' }],
  run(c, msg) { if (!String(c.cfg.name || '').trim()) throw new Error('Name fehlt'); c.api.fire(String(c.cfg.name).trim()); return msg; },
});

module.exports = { nodes, compare, getPath, setPath, OPS };
