'use strict';
// Ausdrücke und Code in einer abgeschotteten VM: es werden NUR Daten (als JSON) hineingegeben,
// keine Funktionen/Objekte des Hosts – so kommt Flow-Code nicht an process/require.
const vm = require('vm');

const PRELUDE = `
const I = JSON.parse(__in);
const msg = I.msg || {}; const payload = msg.payload; const topic = msg.topic;
const error = msg.error; const device = msg.device; const state = msg.state; const prev = msg.prev; const parts = msg.parts; const http = msg.http;
const flow = I.flow || {}; const global = I.global || {};
const $now = new Date(I.now); const $exec = I.exec || {}; const $flowName = I.flowName || '';
const $devices = I.devices || []; const $node = I.node || {}; const $sun = I.sun || null;
const __out = []; const __logs = [];
const send = (port, m) => { __out.push([Number(port) || 0, m]); };
const log = (...a) => { __logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
const $device = (r) => { r = String(r).toLowerCase(); const d = $devices.find((x) => x.id === r || String(x.name).toLowerCase() === r); return d ? Object.assign({}, d.state, { id: d.id, name: d.name, room: d.room, type: d.type, text: d.text }) : undefined; };
const $num = (x, def) => { const n = Number(x); return isFinite(n) && x !== '' && x !== null ? n : (def === undefined ? 0 : def); };
const $round = (x, d) => { const f = Math.pow(10, d || 0); return Math.round(Number(x) * f) / f; };
const $sum = (a) => (a || []).reduce((s, x) => s + Number(x || 0), 0);
const $avg = (a) => (a && a.length ? $sum(a) / a.length : 0);
const $min = (a) => Math.min.apply(null, a || []); const $max = (a) => Math.max.apply(null, a || []);
const $fmt = (t, p) => { const d = t instanceof Date ? t : new Date(t === undefined ? $now : t); const z = (n, l) => String(n).padStart(l || 2, '0');
  return String(p || 'YYYY-MM-DD HH:mm:ss').replace(/YYYY|MM|DD|HH|mm|ss/g, (k) => ({ YYYY: d.getFullYear(), MM: z(d.getMonth() + 1), DD: z(d.getDate()), HH: z(d.getHours()), mm: z(d.getMinutes()), ss: z(d.getSeconds()) })[k]); };
const $minutes = (t) => { const d = t instanceof Date ? t : new Date(t === undefined ? $now : t); return d.getHours() * 60 + d.getMinutes(); };
`;

const cache = new Map();
function compile(kind, code) {
  const key = kind + '\0' + code;
  let s = cache.get(key);
  if (s) return s;
  const body = kind === 'expr'
    ? `return (${code}\n);`
    : code;
  const src = `(function(){ ${PRELUDE}
    const __ret = (function(){ ${body} })();
    return JSON.stringify({ r: __ret === undefined ? null : __ret, u: __ret === undefined, flow, global, out: __out, logs: __logs, msg: kind_msg });
  })()`.replace('kind_msg', kind === 'code' ? 'msg' : 'undefined');
  s = new vm.Script(src, { filename: kind === 'expr' ? 'ausdruck' : 'code' });
  if (cache.size > 500) cache.clear();
  cache.set(key, s);
  return s;
}

// scope: { msg, flow, global, exec, flowName, devices, node, sun, now }
function run(kind, code, scope, timeout) {
  const input = {
    msg: scope.msg || {}, flow: scope.flow || {}, global: scope.global || {}, exec: scope.exec || {}, flowName: scope.flowName || '',
    devices: /\$device/.test(code) ? (scope.devices ? scope.devices() : []) : [], node: /\$node/.test(code) ? (scope.node ? scope.node() : {}) : {},
    sun: /\$sun/.test(code) ? (scope.sun ? scope.sun() : null) : null, now: scope.now || Date.now(),
  };
  const box = Object.create(null); box.__in = JSON.stringify(input);
  const ctx = vm.createContext(box, { codeGeneration: { strings: false, wasm: false } });
  const res = compile(kind, code).runInContext(ctx, { timeout: timeout || (kind === 'expr' ? 300 : 1500) });
  const o = JSON.parse(res);
  return { value: o.u ? undefined : o.r, flow: o.flow, global: o.global, out: o.out || [], logs: o.logs || [], msg: o.msg };
}

const evalExpr = (code, scope) => run('expr', String(code), scope).value;

const FULL = /^\s*\{\{([\s\S]+?)\}\}\s*$/;
function interpolate(str, scope) {
  if (typeof str !== 'string' || !str.includes('{{')) return str;
  const m = FULL.exec(str);
  if (m && !m[1].includes('{{')) return evalExpr(m[1], scope);
  return str.replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => {
    const v = evalExpr(e, scope);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// Eingabe wie „payload.temp“ (Eigenschaftspfad) oder „{{ … }}“ oder ein fester Wert
const PATH = /^(msg\.)?[A-Za-z_$][\w$]*(\.[\w$]+|\[\d+\]|\['[^']*'\]|\["[^"]*"\])*$/;
function value(str, scope) {
  if (typeof str !== 'string') return str;
  if (str.includes('{{')) return interpolate(str, scope);
  const t = str.trim();
  if (PATH.test(t) && /^(msg\.|payload|topic|flow|global|device|state|prev|error|parts|http)/.test(t)) return evalExpr(t.replace(/^msg\./, ''), scope);
  return str;
}

module.exports = { run, evalExpr, interpolate, value };
