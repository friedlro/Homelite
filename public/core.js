'use strict';
/* HomeLite – Kern: Helfer, Zustand, Navigation, Modal, Live-Updates */
const $ = (s, r = document) => r.querySelector(s);

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (k === 'selected') e.selected = !!v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch { /* leer */ }
  if (r.status === 401 && !url.includes('login')) { showLogin(); throw new Error('Nicht angemeldet'); }
  if (!r.ok) throw new Error(j.error || 'Fehler ' + r.status);
  return j;
}

function toast(msg, err) {
  const el = h('div', { class: err ? 'err' : '' }, msg);
  $('#toast').append(el);
  setTimeout(() => el.remove(), err ? 5000 : 2500);
}
const fail = (e) => toast(e.message || String(e), true);

// ---------- Modal ----------
function modal(title, body, buttons = [{ label: 'Schließen' }]) {
  const ov = $('#overlay');
  const close = () => { ov.classList.remove('show'); ov.replaceChildren(); };
  const foot = h('div', { class: 'foot' }, buttons.map((b) => h('button', {
    class: b.primary ? 'primary' : b.danger ? 'danger' : '',
    onclick: async (ev) => {
      ev.target.disabled = true;
      try { const r = b.onClick ? await b.onClick() : undefined; if (r !== false) close(); } catch (e) { fail(e); }
      ev.target.disabled = false;
    },
  }, b.label)));
  ov.replaceChildren(h('div', { class: 'modal' }, h('h3', {}, title), body, foot));
  ov.classList.add('show');
  ov.onclick = (e) => { if (e.target === ov) close(); };
  return { close };
}
const modalOpen = () => $('#overlay').classList.contains('show');

// ---------- Zustand ----------
let S = null;
const PAGES = {};
let page = localStorage.getItem('hl_page') || 'dash';
let logs = [];

const dev = (id) => S.devices.find((d) => d.id === id);
const st = (id) => S.states[id] || {};
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
const fmtNum = (n, d = 1) => (n === undefined || n === null || isNaN(n) ? '–' : Number(n).toLocaleString('de-AT', { maximumFractionDigits: d }));
const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

async function reload() {
  S = await api('GET', '/api/bootstrap');
  loadPluginAssets();
  renderAll();
}

function renderStatus() {
  if (!S) return;
  const chips = [];
  const m = S.mqtt;
  chips.push(h('span', { class: 'chip ' + (m.ok ? 'ok' : m.configured ? 'bad' : '') }, m.ok ? 'MQTT ✓' : m.configured ? 'MQTT ✗' : 'MQTT –'));
  for (const p of S.presence) chips.push(h('span', { class: 'chip ' + (p.home ? 'ok' : '') }, `${p.home ? '🏠' : '🚶'} ${p.name}`));
  const modes = { auto: 'Heizung Auto', comfort: 'Heizung Komfort', eco: 'Heizung Absenkung', off: 'Heizung Aus' };
  if (S.heating.rooms.length) chips.push(h('span', { class: 'chip' }, '🌡 ' + (modes[S.heating.mode] || S.heating.mode)));
  $('#status').replaceChildren(...chips);
}

// Erweiterungen: Seite -> Modul
const PAGE_MOD = { energy: 'energy', heat: 'heating', car: 'car', geo: 'geo', where: 'where' };
const modOn = (id) => !!(S && S.modules && S.modules[id]);
const pluginRunning = (id) => !!(S && (S.plugins || []).some((p) => p.id === id && p.running));
const pluginInMenu = (id) => !!(S && (S.plugins || []).some((p) => p.id === id && p.menu !== false));
const navVisible = (k) => pageVisible(k) && (!k.startsWith('p_') || pluginInMenu(k.slice(2)));
const pageVisible = (k) => (k.startsWith('p_') ? pluginRunning(k.slice(2)) : !PAGE_MOD[k] || modOn(PAGE_MOD[k]));

// ---------- Plugins: Schnittstelle für client.js der Plugins ----------
const HL = {
  _on: new Map(),
  // Seite im Menü: HL.page('meine-id', { label, icon, render(el) })
  page(pluginId, def) {
    PAGES['p_' + pluginId] = { live: false, short: def.short || def.label, ...def };
    const set = PAGES.set;
    if (set) { delete PAGES.set; PAGES.set = set; }
    if (S) renderNav();
  },
  on(pluginId, cb) { (this._on.get(pluginId) || this._on.set(pluginId, []).get(pluginId)).push(cb); },
  api: (pluginId, method, sub, body) => api(method, `/api/plugins/${pluginId}/x/${sub}`, body),
  h, fill, toast, fail, rawApi: api, fmtTime, fmtNum, dev, st, modal, fld, sel, get S() { return S; },
};
window.HL = HL;
const pluginLoaded = new Map(); // id -> Version, für die ein Skript geladen wurde
function loadPluginAssets() {
  for (const p of (S && S.plugins) || []) {
    if (!p.running || pluginLoaded.has(p.id)) continue;
    pluginLoaded.set(p.id, p.version);
    if (p.style) document.head.append(h('link', { rel: 'stylesheet', href: `/api/plugins/${p.id}/client.css?v=${p.version}` }));
    if (p.client) document.body.append(h('script', { src: `/api/plugins/${p.id}/client.js?v=${p.version}`, defer: true }));
  }
}

function renderNav() {
  $('#nav').replaceChildren(
    h('div', { class: 'brand-side' }, h('span', { class: 'logo' }, '⌂'), 'HomeLite'),
    ...Object.entries(PAGES).filter(([k]) => navVisible(k) || k === page).map(([k, p]) => h('button', { class: k === page ? 'act' : '', onclick: () => go(k), title: p.label },
      h('span', { class: 'ni' }, p.icon || '•'), h('span', { class: 'nl' }, p.short || p.label))));
}

function renderPage() {
  if (!PAGES[page] || !pageVisible(page)) page = 'dash';
  const main = $('#main');
  main.replaceChildren();
  PAGES[page].render(main);
}

function renderAll() { renderStatus(); renderNav(); renderPage(); }

function go(name) {
  page = name;
  localStorage.setItem('hl_page', name);
  renderNav();
  renderPage();
  window.scrollTo(0, 0);
}

let liveTimer = null;
function live() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    renderStatus();
    if (!PAGES[page] || !PAGES[page].live) return;
    const a = document.activeElement;
    if (modalOpen() || (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && $('#main').contains(a))) return;
    renderPage();
  }, 250);
}

// ---------- Live-Verbindung ----------
let es = null;
function connect() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.onmessage = (m) => {
    let d;
    try { d = JSON.parse(m.data); } catch { return; }
    if (!S) return;
    switch (d.t) {
      case 'state': S.states[d.id] = d.st; break;
      case 'presence': S.presence = d.presence; break;
      case 'heating': S.heating = { ...S.heating, ...d.heating }; break;
      case 'car': S.car = { ...S.car, ...d.car }; break;
      case 'energy': S.energy = d.energy; break;
      case 'victron': S.victron = d.victron; break;
      case 'ecowitt': S.ecowitt = d.ecowitt; break;
      case 'matter': S.matter = d.matter; break;
      case 'broker': S.broker = d.broker; if (typeof brokerDraw === 'function' && brokerDraw()) return; break;
      case 'plugins': S.plugins = d.plugins; loadPluginAssets(); renderNav(); if (typeof pluginsDraw === 'function' && pluginsDraw()) return; break;
      case 'plugin': for (const cb of HL._on.get(d.id) || []) { try { cb(d.data); } catch (e) { console.error(e); } } return;
      case 'devices': clearTimeout(HL._rl); HL._rl = setTimeout(() => reload().catch(() => {}), 400); return;
      case 'coiot': S.coiot = d.coiot; if (typeof coiotDraw === 'function') coiotDraw(); return;
      case 'shellyfw': S.shellyfw = d.shellyfw; if (typeof shellyFwDraw === 'function') shellyFwDraw(); return;
      case 'appletv': S.appletv = d.appletv; break;
      case 'findmy': S.findmy = d.findmy; break;
      case 'mqtt': S.mqtt = { ...S.mqtt, ...d.mqtt }; S.discovery = d.discovery; break;
      case 'history': if (typeof histPush === 'function') histPush(d); return;
      case 'log': logs.push(d.e); if (logs.length > 200) logs.shift(); if (page === 'set') { const el = $('#loglist'); if (el) el.prepend(logLine(d.e)); } return;
      default: return;
    }
    live();
  };
  es.onerror = () => { if (es.readyState === 2) setTimeout(boot, 3000); };
}

const logLine = (e) => h('div', { class: e.level }, `${new Date(e.ts).toLocaleTimeString('de-AT')}  ${e.msg}`);

// ---------- Login ----------
function showLogin() {
  if (es) { es.close(); es = null; }
  S = null;
  document.body.classList.add('loggedout');
  $('#nav').replaceChildren();
  $('#status').replaceChildren();
  const pw = h('input', { type: 'password', placeholder: 'Passwort', autocomplete: 'current-password', autofocus: true });
  const go = async () => {
    try { await api('POST', '/api/login', { password: pw.value }); await boot(); } catch (e) { fail(e); }
  };
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('#main').replaceChildren(h('div', { class: 'card login' }, h('div', { class: 'logo big-logo' }, '⌂'), h('h3', {}, 'HomeLite'), h('p', { class: 'hint', style: 'margin:0 0 12px' }, 'Bitte anmelden'), pw, h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'primary', style: 'width:100%', onclick: go }, 'Anmelden'))));
  pw.focus();
}

async function boot() {
  try {
    S = await api('GET', '/api/bootstrap');
  } catch { return; }
  document.body.classList.remove('loggedout');
  loadPluginAssets();
  try { logs = await api('GET', '/api/log'); } catch { /* ignorieren */ }
  if (!PAGES[page]) page = 'dash';
  renderAll();
  connect();
}

// Hilfsfunktionen für Formulare
function fld(label, input) { return h('label', { class: 'f' }, label, input); }
function chk(label, checked, onchange) { return h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), label); }
// wie replaceChildren, aber mit verschachtelten Listen und ohne null/false
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}
function toggle(checked, onchange) {
  return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }));
}
function sel(options, value, onchange, extra) {
  const entries = Array.isArray(options) ? options.map((o) => [o, o]) : Object.entries(options);
  return h('select', { ...extra, onchange: (e) => onchange(e.target.value) }, entries.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
}
function copyBtn(text) {
  return h('button', { class: 'sm', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Kopiert'); } catch { toast('Kopieren nicht möglich – bitte manuell markieren', true); } } }, 'Kopieren');
}
