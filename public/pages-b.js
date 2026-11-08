'use strict';
/* Seiten: Automationen, Heizung, Leapmotor, Geofence + Start */

// ---------- Automationen ----------
const CTRL = ['switch', 'light', 'thermostat', 'cover'];
const TRIG = {
  device: { label: 'Gerät ändert sich', icon: '🔌', f: [['device', 'Gerät', 'device'], ['to', 'Neuer Zustand (on/off/Wert – leer = jede Änderung)', 'text'], ['from', 'Vorheriger Zustand (optional)', 'text'], ['above', 'Steigt über', 'number'], ['below', 'Fällt unter', 'number'], ['forSeconds', 'Mindestdauer (Sek.)', 'number'], ['id', 'Kennung (optional, für die Bedingung „Ausgelöst durch“)', 'text']] },
  time: { label: 'Uhrzeit', icon: '⏰', f: [['at', 'Zeit', 'time'], ['days', 'Wochentage (leer = täglich)', 'days']] },
  sun: { label: 'Sonnenaufgang / -untergang', icon: '🌅', f: [['event', 'Ereignis', 'select', { sunrise: 'Sonnenaufgang', sunset: 'Sonnenuntergang' }], ['offset', 'Versatz in Minuten (− davor, + danach)', 'number'], ['days', 'Wochentage (leer = täglich)', 'days']] },
  interval: { label: 'Regelmäßig wiederholen', icon: '🔁', f: [['everyMinutes', 'Alle … Minuten (60 = zu jeder vollen Stunde)', 'number']] },
  startup: { label: 'Beim Start von HomeLite', icon: '🚀', f: [] },
  webhook: { label: 'Aufruf per URL (z. B. NFC-Tag)', icon: '🔗', f: [['name', 'Name', 'text'], ['name', '', 'hookurl']] },
  geofence: { label: 'Geofence / Anwesenheit', icon: '📍', f: [['event', 'Ereignis', 'select', { enter: 'Person betritt Zone', leave: 'Person verlässt Zone', all_left: 'Alle sind weg', first_home: 'Erste Person kommt heim' }], ['person', 'Person (leer = alle)', 'person'], ['zone', 'Zone (leer = alle)', 'zone']] },
};
const COND = {
  device: { label: 'Gerät hat Zustand', f: [['device', 'Gerät', 'device'], ['equals', 'Zustand (on/off/Wert)', 'text'], ['negate', 'Umkehren (Gerät hat NICHT diesen Zustand)', 'bool']] },
  numeric: { label: 'Messwert', f: [['device', 'Gerät', 'device'], ['above', 'über', 'number'], ['below', 'unter', 'number']] },
  diff: { label: 'Differenz zweier Messwerte (A − B)', f: [['device', 'Messwert A', 'device'], ['device2', 'Messwert B', 'device'], ['min', 'Differenz mindestens', 'number'], ['max', 'Differenz höchstens', 'number']] },
  time: { label: 'Zeitfenster', f: [['after', 'ab', 'time'], ['before', 'bis', 'time']] },
  weekday: { label: 'Wochentag', f: [['days', 'Tage', 'days']] },
  trigger: { label: 'Ausgelöst durch (Kennung des Auslösers)', f: [['ids', 'Kennung(en), durch Komma getrennt', 'text'], ['negate', 'Umkehren (NICHT durch diese ausgelöst)', 'bool']] },
  any: { label: 'ODER – mindestens eine davon trifft zu', f: [['conditions', 'Mindestens eine muss zutreffen.', 'conds']] },
  all: { label: 'UND – alle davon treffen zu', f: [['conditions', 'Alle müssen zutreffen.', 'conds']] },
  presence: { label: 'Anwesenheit', f: [['mode', 'Bedingung', 'select', { anyone_home: 'Jemand ist zuhause', nobody_home: 'Niemand ist zuhause', person_home: 'Person ist zuhause', person_away: 'Person ist unterwegs' }], ['person', 'Person', 'person']] },
};
const ACT = {
  device: { label: 'Gerät steuern', f: [['device', 'Gerät', 'device', [...CTRL, 'lock']], ['action', 'Aktion', 'select', { on: 'Einschalten', off: 'Ausschalten', toggle: 'Umschalten', lock: 'Zusperren (Schloss)', unlock: 'Aufsperren (Schloss)', brightness: 'Helligkeit (%)', setpoint: 'Solltemperatur (°C)', open: 'Öffnen (Rollo/Markise)', close: 'Schließen (Rollo/Markise)', stop: 'Stopp (Rollo/Markise)' }], ['value', 'Wert (Helligkeit / Soll)', 'text']] },
  delay: { label: 'Warten', f: [['seconds', 'Sekunden', 'number']] },
  require: { label: 'Nur weitermachen, wenn …', f: [['conditions', 'Trifft das nicht zu, wird der Rest der Automation abgebrochen.', 'conds']] },
  if: { label: 'Wenn … dann … sonst …', f: [['conditions', 'Wenn', 'conds'], ['then', 'Dann', 'acts'], ['else', 'Sonst', 'acts']] },
  notify: { label: 'Push-Nachricht (ntfy)', f: [['title', 'Titel', 'text'], ['message', 'Text ({{person}} {{zone}} {{device}} {{state}})', 'text']] },
  heating: { label: 'Heizung', f: [['room', 'Raum (leer = alle)', 'hroom'], ['mode', 'Modus', 'select', { auto: 'Auto', comfort: 'Komfort', eco: 'Absenkung', off: 'Aus / Frostschutz', boost: 'Boost (nur Raum)' }], ['temp', 'Temperatur (Boost)', 'number'], ['minutes', 'Dauer in Min. (0 = dauerhaft)', 'number']] },
  car: { label: 'Leapmotor', f: [['command', 'Befehl', 'carcmd']] },
  mqtt: { label: 'MQTT senden', f: [['topic', 'Topic', 'text'], ['payload', 'Payload', 'text']] },
  http: { label: 'HTTP-Aufruf', f: [['url', 'URL', 'text'], ['method', 'Methode', 'select', { GET: 'GET', POST: 'POST' }], ['body', 'Body (JSON, nur POST)', 'text']] },
};

function fieldEl(def, obj) {
  const [key, label, type, opt] = def;
  const set = (v) => { obj[key] = v; };
  let input;
  switch (type) {
    case 'text': input = h('input', { value: obj[key] ?? '', oninput: (e) => set(e.target.value) }); break;
    case 'number': input = h('input', { type: 'number', step: 'any', value: obj[key] ?? '', oninput: (e) => set(e.target.value === '' ? '' : Number(e.target.value)) }); break;
    case 'time': input = h('input', { type: 'time', value: obj[key] || '', oninput: (e) => set(e.target.value) }); break;
    case 'bool': return chk(label, !!obj[key], set);
    case 'select':
      if (obj[key] === undefined) obj[key] = Object.keys(opt)[0];
      input = sel(opt, obj[key], set); break;
    case 'device': {
      const list = S.devices.filter((d) => !opt || opt.includes(d.type));
      input = sel({ '': '– wählen –', ...Object.fromEntries(list.map((d) => [d.id, `${d.pending ? '⚠ ' : ''}${d.name}${d.room ? ' (' + d.room + ')' : ''}`])) }, obj[key] || '', set); break;
    }
    case 'person': input = sel({ '': '(alle / keine)', ...Object.fromEntries(S.geofence.persons.map((p) => [p.id, p.name])) }, obj[key] || '', set); break;
    case 'zone': input = sel({ '': '(alle)', ...Object.fromEntries(S.geofence.zones.map((z) => [z.id, z.name])) }, obj[key] || '', set); break;
    case 'hroom': input = sel({ '': '(alle Räume)', ...Object.fromEntries(S.heating.config.map((r) => [r.id, r.name])) }, obj[key] || '', set); break;
    case 'carcmd':
      if (obj[key] === undefined) obj[key] = Object.keys(S.car.commands)[0];
      input = sel(S.car.commands, obj[key], set); break;
    case 'days': {
      const cur = new Set(obj[key] || []);
      input = h('div', { class: 'days' }, [1, 2, 3, 4, 5, 6, 0].map((d) => h('label', {}, h('input', { type: 'checkbox', checked: cur.has(d), onchange: (e) => { if (e.target.checked) cur.add(d); else cur.delete(d); obj[key] = [...cur].sort(); } }), DAYS[d])));
      break;
    }
    case 'conds': case 'acts': {
      if (!Array.isArray(obj[key])) obj[key] = [];
      return h('div', { class: 'sub-ed' }, h('div', { class: 'hint' }, label), editorList('', type === 'conds' ? COND : ACT, obj[key]));
    }
    case 'hookurl': {
      const u = `${(localStorage.getItem('hl_base') || location.origin).replace(/\/+$/, '')}/trigger?key=${S.geofence.key}&name=${encodeURIComponent(obj.name || '')}`;
      return h('div', { class: 'full', style: 'grid-column:1/-1' }, h('div', { class: 'hint' }, 'Adresse zum Auslösen (z. B. in der iPhone-Kurzbefehle-App → „Inhalte von URL abrufen“, ausgelöst durch ein NFC-Tag):'), h('div', { class: 'row' }, h('code', {}, u), copyBtn(u)));
    }
    default: input = h('input');
  }
  return fld(label, input);
}

function editorList(title, defs, items) {
  const box = h('div');
  const labels = Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, v.label]));
  function draw() {
    fill(box, title ? h('h2', {}, title) : null,
      items.map((it, i) => (defs[it.type] ? h('div', { class: 'ed' },
        h('div', { class: 'head' }, sel(labels, it.type, (v) => { items[i] = { type: v }; draw(); }), h('button', { class: 'sm danger', onclick: () => { items.splice(i, 1); draw(); } }, '✕')),
        defs[it.type].f.length ? h('div', { class: 'form' }, defs[it.type].f.map((d) => fieldEl(d, it))) : null) : null)),
      sel({ '': '+ hinzufügen …', ...labels }, '', (v) => { if (v) { items.push({ type: v }); draw(); } }));
  }
  draw();
  return box;
}

// Prüft die Automation vor dem Speichern und nennt den ersten Fehler
function validateAuto(o) {
  const errs = [];
  const walk = (items, defs, where) => (items || []).forEach((it) => {
    const d = defs[it.type];
    if (!d) return;
    for (const [key, , type] of d.f) if (type === 'device' && !it[key]) errs.push(`${where} „${d.label}“: bitte ein Gerät wählen`);
    if (defs === TRIG && it.type === 'time' && !it.at) errs.push(`${where} „Uhrzeit“: bitte eine Zeit angeben`);
    if (defs === TRIG && it.type === 'interval' && !(Number(it.everyMinutes) > 0)) errs.push(`${where} „Regelmäßig“: Minuten angeben`);
    if (defs === TRIG && it.type === 'webhook' && !it.name) errs.push(`${where} „URL-Aufruf“: Name angeben`);
    if (defs === ACT && it.type === 'mqtt' && !it.topic) errs.push(`${where} „MQTT“: Topic angeben`);
    if (defs === ACT && it.type === 'http' && !it.url) errs.push(`${where} „HTTP“: URL angeben`);
    if (it.type === 'if') { walk(it.conditions, COND, 'Bedingung'); walk(it.then, ACT, 'Aktion'); walk(it.else, ACT, 'Aktion'); }
    if (it.type === 'require' || it.type === 'any' || it.type === 'all') walk(it.conditions, COND, 'Bedingung');
  });
  walk(o.triggers, TRIG, 'Auslöser');
  walk(o.conditions, COND, 'Bedingung');
  walk(o.actions, ACT, 'Aktion');
  return errs;
}

function automationDialog(a) {
  const o = a ? JSON.parse(JSON.stringify(a)) : { name: '', enabled: true, dash: false, mode: 'single', triggers: [], conditions: [], actions: [] };
  const name = h('input', { value: o.name, placeholder: 'z. B. Licht aus wenn alle weg' });
  const desc = h('input', { value: o.desc || '', placeholder: 'optional' });
  const mode = sel({ single: 'Einzeln – läuft sie noch, wird ein neuer Start ignoriert', restart: 'Neustart – ein neuer Start bricht den laufenden Ablauf ab', queued: 'Warteschlange – neue Starts werden nacheinander ausgeführt' }, o.mode || 'single', (v) => { o.mode = v; });
  const body = h('div', {},
    h('div', { class: 'form' }, fld('Name', name), fld('Beschreibung', desc), fld('Wenn sie erneut auslöst, während sie noch läuft', mode)),
    h('div', { class: 'row', style: 'margin-top:10px' }, chk('Aktiv', o.enabled, (v) => { o.enabled = v; }), chk('Als Szene-Knopf im Dashboard', o.dash, (v) => { o.dash = v; })),
    editorList('Auslöser (ohne Auslöser = nur manuell/Szene)', TRIG, o.triggers),
    editorList('Bedingungen (alle müssen zutreffen)', COND, o.conditions),
    editorList('Aktionen', ACT, o.actions));
  modal(a ? 'Automation bearbeiten' : 'Neue Automation', body, [
    { label: 'Abbrechen' },
    {
      label: 'Speichern', primary: true,
      onClick: async () => {
        if (!o.actions.length) { toast('Mindestens eine Aktion nötig', true); return false; }
        const errs = validateAuto(o);
        if (errs.length) { toast(errs[0] + (errs.length > 1 ? ` (+${errs.length - 1} weitere)` : ''), true); return false; }
        const payload = { ...o, name: name.value.trim() || 'Automation', desc: desc.value.trim() };
        if (a) await api('PUT', `/api/automations/${a.id}`, payload); else await api('POST', '/api/automations', payload);
        await reload();
      },
    },
  ]);
}

// Wie viele nicht verbundene Geräte kommen in der Automation vor?
function pendingRefs(a) {
  const ids = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if ((k === 'device' || k === 'device2') && typeof x === 'string') ids.add(x); else walk(x); }
  };
  walk([a.triggers, a.conditions, a.actions]);
  return [...ids].map((id) => dev(id)).filter((d) => d && d.pending);
}

const trigText = (t) => {
  const base = TRIG[t.type] ? `${TRIG[t.type].icon} ${TRIG[t.type].label}` : t.type;
  if (t.type === 'time') return `⏰ ${t.at || ''}${t.days && t.days.length ? ' · ' + t.days.map((d) => DAYS[d]).join(' ') : ''}`;
  if (t.type === 'sun') return `🌅 ${t.event === 'sunrise' ? 'Sonnenaufgang' : 'Sonnenuntergang'}${t.offset ? ` ${t.offset > 0 ? '+' : ''}${t.offset} Min.` : ''}`;
  if (t.type === 'device') { const d = dev(t.device); return `🔌 ${d ? d.name : '?'}${t.to ? ' → ' + t.to : ''}`; }
  return base;
};
const MODE_LABEL = { restart: 'Neustart', queued: 'Warteschlange' };

PAGES.auto = {
  label: 'Automationen', short: 'Regeln', icon: '⚡',
  render(el) {
    let q = '';
    const box = h('div');
    function draw() {
      const list = S.automations.filter((a) => !q || `${a.name} ${a.desc || ''}`.toLowerCase().includes(q));
      box.replaceChildren(list.length ? h('div', { class: 'grid wide' }, list.map((a) => {
        const pend = pendingRefs(a);
        return h('div', { class: 'card auto-card ' + (a.enabled ? '' : 'disabled') },
          h('div', { class: 'row sb', style: 'flex-wrap:nowrap' }, h('h3', { style: 'margin:0' }, a.name), toggle(a.enabled, (v) => api('PUT', `/api/automations/${a.id}`, { enabled: v }).then(reload).catch(fail))),
          h('div', { class: 'tags' }, a.triggers.length ? a.triggers.slice(0, 3).map((t) => h('span', { class: 'pill' }, trigText(t))) : h('span', { class: 'pill' }, '▶ manuell'),
            a.triggers.length > 3 ? h('span', { class: 'pill' }, `+${a.triggers.length - 3}`) : null,
            MODE_LABEL[a.mode] ? h('span', { class: 'pill' }, MODE_LABEL[a.mode]) : null,
            pend.length ? h('span', { class: 'pill warn', title: pend.map((d) => d.name).join(', ') }, `⚠ ${pend.length} Gerät(e) nicht verbunden`) : null),
          a.desc ? h('div', { class: 'desc' }, a.desc) : null,
          h('div', { class: 'hint' }, `${a.actions.length} Aktion(en)${a.conditions.length ? ` · ${a.conditions.length} Bedingung(en)` : ''} · zuletzt: ${fmtTime(a.lastRun)}`),
          h('div', { class: 'row', style: 'margin-top:auto' },
            h('button', { class: 'sm', onclick: () => api('POST', `/api/automations/${a.id}/run`, {}).then(() => toast('Ausgeführt')).catch(fail) }, '▶ Ausführen'),
            h('button', { class: 'sm', onclick: () => automationDialog(a) }, 'Bearbeiten'),
            h('button', { class: 'sm danger', onclick: () => { if (confirm(`„${a.name}“ löschen?`)) api('DELETE', `/api/automations/${a.id}`).then(reload).catch(fail); } }, 'Löschen')));
      })) : h('div', { class: 'empty' }, 'Keine Automationen gefunden.'));
    }
    el.append(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, `Automationen (${S.automations.length})`), h('button', { class: 'primary', onclick: () => automationDialog(null) }, '+ Neu')));
    if (!S.automations.length) { el.append(h('div', { class: 'empty', style: 'margin-top:12px' }, 'Noch keine Automationen.')); return; }
    el.append(h('div', { style: 'margin:14px 0' }, h('input', { class: 'search', placeholder: 'Suchen …', oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } })), box);
    draw();
  },
};

// ---------- Heizung ----------
const HMODES = { auto: 'Auto (Zeitplan)', comfort: 'Komfort', eco: 'Absenkung', off: 'Aus' };
const heatCmd = (body) => api('POST', '/api/heating/command', body).catch(fail);

function heatingDialog() {
  const rooms = JSON.parse(JSON.stringify(S.heating.config));
  const frost = h('input', { type: 'number', step: '0.5', value: S.heating.frost ?? 7 });
  const list = h('div');
  const heaters = S.devices.filter((d) => CTRL.includes(d.type));
  const sensors = S.devices.filter((d) => d.type === 'sensor' || d.type === 'thermostat');
  function draw() {
    fill(list, rooms.map((r, i) => h('div', { class: 'ed' },
      h('div', { class: 'head' }, h('input', { value: r.name, placeholder: 'Raumname', oninput: (e) => { r.name = e.target.value; } }), h('button', { class: 'sm danger', onclick: () => { rooms.splice(i, 1); draw(); } }, '✕')),
      h('div', { class: 'form' },
        fld('Heizgerät (Thermostat oder Schalter)', sel({ '': '– wählen –', ...Object.fromEntries(heaters.map((d) => [d.id, d.name])) }, r.device, (v) => { r.device = v; })),
        fld('Temperatursensor (nötig bei Schalter)', sel({ '': '(Thermostat selbst)', ...Object.fromEntries(sensors.map((d) => [d.id, d.name])) }, r.sensor, (v) => { r.sensor = v; })),
        fld('Komfort °C', h('input', { type: 'number', step: '0.5', value: r.comfort, oninput: (e) => { r.comfort = Number(e.target.value); } })),
        fld('Absenkung °C', h('input', { type: 'number', step: '0.5', value: r.eco, oninput: (e) => { r.eco = Number(e.target.value); } }))),
      h('div', { style: 'margin-top:8px' }, chk('Absenken wenn niemand zuhause (Geofence)', r.awayEco !== false, (v) => { r.awayEco = v; })),
      h('div', { class: 'hint', style: 'margin:8px 0 4px' }, 'Komfort-Zeitfenster:'),
      r.schedule.map((s, j) => h('div', { class: 'row', style: 'margin-bottom:6px' },
        h('div', { class: 'days' }, [1, 2, 3, 4, 5, 6, 0].map((d) => h('label', {}, h('input', { type: 'checkbox', checked: s.days.includes(d), onchange: (e) => { s.days = e.target.checked ? [...new Set([...s.days, d])] : s.days.filter((x) => x !== d); } }), DAYS[d]))),
        h('input', { type: 'time', value: s.from, style: 'width:auto', oninput: (e) => { s.from = e.target.value; } }), '–',
        h('input', { type: 'time', value: s.to, style: 'width:auto', oninput: (e) => { s.to = e.target.value; } }),
        h('button', { class: 'sm danger', onclick: () => { r.schedule.splice(j, 1); draw(); } }, '✕'))),
      h('button', { class: 'sm', onclick: () => { r.schedule.push({ days: [1, 2, 3, 4, 5], from: '06:00', to: '22:00' }); draw(); } }, '+ Zeitfenster'))),
    h('button', { onclick: () => { rooms.push({ id: '', name: '', device: '', sensor: '', comfort: 21, eco: 17, awayEco: true, schedule: [{ days: [1, 2, 3, 4, 5], from: '06:00', to: '22:00' }, { days: [0, 6], from: '07:00', to: '23:00' }] }); draw(); } }, '+ Raum'));
  }
  draw();
  modal('Heizung konfigurieren', h('div', {}, h('div', { class: 'form' }, fld('Frostschutz °C (Modus „Aus“)', frost)), list), [
    { label: 'Abbrechen' },
    { label: 'Speichern', primary: true, onClick: async () => { await api('PUT', '/api/heating', { frost: Number(frost.value), rooms }); await reload(); } },
  ]);
}

PAGES.heat = {
  label: 'Heizung', icon: '🌡', live: true,
  render(el) {
    const H = S.heating;
    el.append(h('div', { class: 'row sb' }, h('div', { class: 'row' }, Object.entries(HMODES).map(([k, l]) => h('button', { class: 'seg ' + (H.mode === k ? 'act' : ''), onclick: () => heatCmd({ mode: k }) }, l))), h('button', { onclick: heatingDialog }, '⚙ Konfigurieren')));
    if (!H.rooms.length) { el.append(h('div', { class: 'empty', style: 'margin-top:14px' }, 'Noch keine Heizräume. Thermostate/Schalter zuerst unter „Geräte“ hinzufügen, dann hier konfigurieren.')); return; }
    el.append(h('div', { class: 'grid wide', style: 'margin-top:14px' }, H.rooms.map((r) => {
      const bump = (d) => heatCmd({ room: r.id, mode: 'boost', temp: Math.round(((r.target ?? 20) + d) * 2) / 2, minutes: 120 });
      return h('div', { class: 'card' },
        h('div', { class: 'row sb' }, h('h3', { style: 'margin:0' }, r.name), r.boost ? h('span', { class: 'pill on' }, 'Manuell') : null),
        h('div', { class: 'big', style: 'margin:8px 0' }, r.current === undefined ? '– °C' : `${fmtNum(r.current)} °C`),
        h('div', { class: 'hint' }, r.error ? r.error : `Soll ${fmtNum(r.target)} °C · ${r.why || ''}${r.setpoint !== undefined ? ` (Gerät: ${fmtNum(r.setpoint)})` : ''}`),
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'sm', onclick: () => bump(-0.5) }, '−'), h('button', { class: 'sm', onclick: () => bump(0.5) }, '+'),
          r.boost ? h('button', { class: 'sm', onclick: () => heatCmd({ room: r.id, mode: 'auto' }) }, 'Zurück zu Auto') : h('span', { class: 'hint' }, '± gilt 2 Std.')));
    })));
  },
};

// ---------- Leapmotor ----------
function carDialog() {
  const c = S.car.config;
  const o = { enabled: c.enabled };
  const f = {
    name: h('input', { value: c.name }), username: h('input', { value: c.username, autocomplete: 'off' }),
    password: h('input', { type: 'password', placeholder: c.hasPassword ? '(unverändert)' : '', autocomplete: 'new-password' }),
    pin: h('input', { type: 'password', placeholder: c.hasPin ? '(unverändert)' : 'Fahrzeug-PIN', autocomplete: 'new-password' }),
    certPath: h('input', { value: c.certPath, placeholder: 'leer = mitgeliefertes' }), keyPath: h('input', { value: c.keyPath, placeholder: 'leer = mitgelieferter' }),
    vin: h('input', { value: c.vin, placeholder: 'leer = erstes Fahrzeug' }), pollMinutes: h('input', { type: 'number', min: 2, value: c.pollMinutes }),
  };
  modal('Leapmotor konfigurieren', h('div', {},
    h('p', { class: 'hint', style: 'margin-top:0' }, 'Nutzt die Leapmotor-Cloud (inoffiziell, Client nach kerniger/leapmotor-ha). Die App-Zertifikate aus markoceri/leapmotor-certs sind bereits enthalten – nur E-Mail, Passwort und für Fernbefehle die Fahrzeug-PIN eintragen. Zugangsdaten bleiben auf deinem Server. Benötigt python3 mit „requests“ und „cryptography“ sowie curl.'),
    chk('Leapmotor aktivieren', o.enabled, (v) => { o.enabled = v; }),
    h('div', { class: 'form', style: 'margin-top:10px' }, fld('Anzeigename', f.name), fld('Leapmotor-App E-Mail', f.username), fld('Passwort', f.password), fld('Fahrzeug-PIN (Fernsteuerung)', f.pin), fld('Eigenes Zertifikat (optional, Pfad)', f.certPath), fld('Eigener Schlüssel (optional, Pfad)', f.keyPath), fld('VIN (optional)', f.vin), fld('Abfrage alle … Min.', f.pollMinutes))),
  [{ label: 'Abbrechen' }, {
    label: 'Speichern', primary: true,
    onClick: async () => {
      await api('PUT', '/api/car', { enabled: o.enabled, name: f.name.value, username: f.username.value.trim(), password: f.password.value, pin: f.pin.value, certPath: f.certPath.value.trim(), keyPath: f.keyPath.value.trim(), vin: f.vin.value.trim(), pollMinutes: Number(f.pollMinutes.value) || 10 });
      toast('Gespeichert – Abfrage startet');
      await reload();
    },
  }]);
}

// Kleine OpenStreetMap-Karte aus Kacheln (ohne Bibliothek)
function tileMap(lat, lon, z = 16) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const lr = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const tiles = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      tiles.push(h('img', {
        src: `https://tile.openstreetmap.org/${z}/${tx + dx}/${ty + dy}.png`, alt: '', width: 256, height: 256, draggable: 'false', onerror: (e) => { e.target.style.visibility = 'hidden'; }, referrerpolicy: 'strict-origin-when-cross-origin',
        style: `left:calc(50% + ${Math.round((dx - (x - tx)) * 256)}px);top:calc(50% + ${Math.round((dy - (y - ty)) * 256)}px)`,
      }));
    }
  }
  return h('a', { class: 'map', href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`, target: '_blank', rel: 'noopener noreferrer', title: 'In OpenStreetMap öffnen' },
    tiles, h('span', { class: 'pin' }, '📍'), h('span', { class: 'attr' }, '© OpenStreetMap'));
}

// Reifendruck in bar; Warnung bei Alarm des Fahrzeugs oder < 2,0 bar
function tireView(s) {
  const cell = (k, label) => {
    const v = s.tires[k];
    const bad = (s.tireAlarms && s.tireAlarms[k]) || (v != null && v < 2.0);
    return h('div', { class: 'tire' + (bad ? ' bad' : '') }, h('div', { class: 'hint' }, label), h('b', {}, v == null ? '–' : fmtNum(v, 2) + ' bar'), bad ? h('div', { class: 'hint' }, '⚠ prüfen') : null);
  };
  return h('div', { class: 'tires' }, cell('fl', 'vorn links'), cell('fr', 'vorn rechts'), cell('rl', 'hinten links'), cell('rr', 'hinten rechts'));
}

PAGES.car = {
  label: 'Leapmotor', short: 'Auto', icon: '🚗', live: true,
  render(el) {
    const C = S.car;
    el.append(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, '🚗 ' + C.name), h('div', { class: 'row' }, C.enabled ? h('button', { onclick: () => api('POST', '/api/car/refresh', {}).then(() => toast('Aktualisiere …')).catch(fail) }, '↻ Aktualisieren') : null, h('button', { onclick: carDialog }, '⚙ Konfigurieren'))));
    if (!C.enabled) { el.append(h('div', { class: 'empty', style: 'margin-top:14px' }, 'Leapmotor ist nicht eingerichtet.')); return; }
    if (C.error) el.append(h('div', { class: 'card', style: 'margin-top:12px;border-color:var(--bad)' }, h('b', { style: 'color:var(--bad)' }, 'Fehler: '), C.error));
    const s = C.status;
    if (!s) { el.append(h('div', { class: 'empty', style: 'margin-top:12px' }, 'Noch keine Daten …')); }
    else {
      el.append(h('div', { class: 'grid wide', style: 'margin-top:12px' },
        h('div', { class: 'card' }, h('div', { class: 'big' }, s.soc == null ? '–' : `${fmtNum(s.soc, 0)} %`), h('div', { class: 'bar', style: 'margin:8px 0' }, h('i', { style: `width:${Math.max(0, Math.min(100, s.soc || 0))}%` })),
          h('div', { class: 'hint' }, `Reichweite ${s.range == null ? '–' : fmtNum(s.range, 0) + ' km'}`), s.charging ? h('div', { class: 'pill on', style: 'margin-top:6px' }, `lädt${s.chargePower ? ' · ' + fmtNum(s.chargePower) + ' kW' : ''}`) : null),
        h('div', { class: 'card kv' },
          h('span', {}, 'Verriegelung'), h('span', {}, s.locked == null ? '–' : s.locked ? '🔒 verriegelt' : '🔓 offen'),
          h('span', {}, 'Klima'), h('span', {}, s.acOn == null ? '–' : s.acOn ? 'an' : 'aus'),
          h('span', {}, 'Innen / Außen'), h('span', {}, `${fmtNum(s.interiorTemp)} / ${fmtNum(s.outdoorTemp)} °C`),
          h('span', {}, 'Kilometerstand'), h('span', {}, s.odometer == null ? '–' : `${fmtNum(s.odometer, 0)} km`),
          h('span', {}, 'Ladestecker'), h('span', {}, s.pluggedIn == null ? '–' : s.pluggedIn ? 'angesteckt' + (s.chargeLimit ? ` · Limit ${s.chargeLimit} %` : '') : 'nicht angesteckt'),
          h('span', {}, 'Reifen'), h('span', {}, s.tiresOk == null ? '–' : s.tiresOk ? 'OK' : '⚠ prüfen'),
          h('span', {}, 'Standort'), h('span', {}, s.address || (s.lat != null && s.lon != null ? `${fmtNum(s.lat, 5)}, ${fmtNum(s.lon, 5)}` : '–')),
          s.distHome != null ? h('span', {}, 'Von Zuhause') : null, s.distHome != null ? h('span', {}, s.distHome < 0.15 ? 'zuhause' : `${fmtNum(s.distHome, 1)} km`) : null,
          h('span', {}, 'Stand'), h('span', {}, fmtTime(s.ts))),
        s.tires && Object.values(s.tires).some((v) => v != null) ? h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 8px' }, 'Reifendruck'), tireView(s)) : null,
        s.lat != null && s.lon != null ? h('div', { class: 'card mapcard' }, tileMap(s.lat, s.lon), s.address ? h('div', { class: 'hint', style: 'margin-top:8px' }, '📍 ' + s.address) : null) : null));
    }
    el.append(h('h2', {}, 'Fernsteuerung'), h('div', { class: 'row' }, Object.entries(C.commands).map(([k, l]) => h('button', {
      onclick: () => { if (['unlock', 'open_trunk'].includes(k) && !confirm(`„${l}“ wirklich senden?`)) return; api('POST', '/api/car/command', { command: k }).then(() => toast(l + ' gesendet')).catch(fail); },
    }, l))));
  },
};

// ---------- Geofence ----------
function geoDialog() {
  const persons = JSON.parse(JSON.stringify(S.geofence.persons));
  const zones = JSON.parse(JSON.stringify(S.geofence.zones));
  const box = h('div');
  function draw() {
    fill(box, h('h2', {}, 'Personen'),
      persons.map((p, i) => h('div', { class: 'row', style: 'margin-bottom:6px' }, h('input', { value: p.name, placeholder: 'Name', oninput: (e) => { p.name = e.target.value; } }), h('button', { class: 'sm danger', onclick: () => { persons.splice(i, 1); draw(); } }, '✕'))),
      h('button', { class: 'sm', onclick: () => { persons.push({ id: '', name: '' }); draw(); } }, '+ Person'),
      h('h2', {}, 'Zonen'),
      zones.map((z, i) => h('div', { class: 'ed' },
        h('div', { class: 'head' }, h('input', { value: z.name, placeholder: 'Zonenname (z. B. Zuhause)', oninput: (e) => { z.name = e.target.value; } }), h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'homez', checked: z.home, onchange: () => { zones.forEach((x) => { x.home = x === z; }); } }), 'Zuhause'), h('button', { class: 'sm danger', onclick: () => { zones.splice(i, 1); draw(); } }, '✕')),
        h('div', { class: 'form' },
          fld('Breitengrad', h('input', { type: 'number', step: 'any', value: z.lat ?? '', oninput: (e) => { z.lat = e.target.value; } })),
          fld('Längengrad', h('input', { type: 'number', step: 'any', value: z.lon ?? '', oninput: (e) => { z.lon = e.target.value; } })),
          fld('Radius (m)', h('input', { type: 'number', min: 20, value: z.radius, oninput: (e) => { z.radius = Number(e.target.value); } }))),
        h('button', {
          class: 'sm', style: 'margin-top:8px',
          onclick: () => navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => { z.lat = p.coords.latitude.toFixed(6); z.lon = p.coords.longitude.toFixed(6); draw(); }, () => toast('Standort nicht verfügbar (Browser braucht HTTPS oder Freigabe)', true)) : toast('Keine Standortfunktion', true),
        }, '📍 Meinen Standort übernehmen'))),
      h('button', { class: 'sm', onclick: () => { zones.push({ id: '', name: '', lat: '', lon: '', radius: 150, home: false }); draw(); } }, '+ Zone'));
  }
  draw();
  modal('Personen & Zonen', box, [{ label: 'Abbrechen' }, { label: 'Speichern', primary: true, onClick: async () => { await api('PUT', '/api/geofence', { persons, zones }); await reload(); } }]);
}

PAGES.geo = {
  label: 'Geofence', short: 'Ort', icon: '📍', live: true,
  render(el) {
    const G = S.geofence;
    el.append(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, 'Anwesenheit'), h('button', { onclick: geoDialog }, '⚙ Personen & Zonen')));
    if (!S.presence.length) el.append(h('div', { class: 'empty', style: 'margin-top:12px' }, 'Noch keine Personen. Lege sie über „Personen & Zonen“ an (oder sie werden beim ersten Geofence-Aufruf automatisch erstellt).'));
    else {
      el.append(h('div', { class: 'grid wide', style: 'margin-top:12px' }, S.presence.map((p) => h('div', { class: 'card' },
        h('div', { class: 'row sb' }, h('h3', { style: 'margin:0' }, p.name), h('span', { class: 'pill ' + (p.home ? 'ok' : '') }, p.known ? (p.home ? '🏠 zuhause' : '🚶 unterwegs') : 'unbekannt')),
        h('div', { class: 'hint', style: 'margin:6px 0' }, p.zones.length ? 'In: ' + p.zones.join(', ') : 'Keine Zone', ' · ', fmtTime(p.ts)),
        h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => api('POST', `/api/presence/${p.id}`, { home: true }).catch(fail) }, 'Manuell: zuhause'), h('button', { class: 'sm', onclick: () => api('POST', `/api/presence/${p.id}`, { home: false }).catch(fail) }, 'Manuell: weg'))))));
    }
    el.append(h('h2', {}, 'Zonen'), h('div', { class: 'card', style: 'overflow-x:auto' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Position', 'Radius', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, G.zones.map((z) => h('tr', {}, h('td', {}, z.name), h('td', {}, z.lat == null ? h('span', { class: 'pill bad' }, 'Position fehlt') : `${z.lat}, ${z.lon}`), h('td', {}, z.radius + ' m'), h('td', {}, z.home ? h('span', { class: 'pill ok' }, 'Zuhause') : '')))))));

    // Anbindung iPhone
    const stored = localStorage.getItem('hl_base') || location.origin;
    const base = h('input', { value: stored, onchange: (e) => { localStorage.setItem('hl_base', e.target.value.trim()); renderPage(); } });
    const pName = encodeURIComponent((G.persons[0] && G.persons[0].name) || 'Roland');
    const hz = G.zones.find((z) => z.home) || { name: 'Zuhause' };
    const mk = (extra) => `${stored.replace(/\/+$/, '')}/hook?key=${G.key}&person=${pName}${extra || ''}`;
    const urlRow = (label, url, note) => h('div', { style: 'margin:10px 0' }, h('div', { class: 'row sb' }, h('b', {}, label), copyBtn(url)), h('code', {}, url), note ? h('div', { class: 'hint', style: 'margin-top:4px' }, note) : null);
    el.append(h('h2', {}, 'iPhone anbinden (kostenlos)'), h('div', { class: 'card' },
      h('p', { class: 'hint', style: 'margin-top:0' }, 'Das iPhone ruft beim Betreten/Verlassen einer Zone diese Adresse auf. Von unterwegs muss sie aus dem Internet erreichbar sein (z. B. Tailscale Funnel, Cloudflare Tunnel oder Reverse-Proxy mit HTTPS) – am besten nur den Pfad /hook freigeben.'),
      fld('Basis-Adresse deines Servers (so, wie das iPhone ihn erreicht)', base),
      urlRow('Option A · Kurzbefehle-App (bereits auf dem iPhone, am einfachsten)', mk(`&zone=${encodeURIComponent(hz.name)}&event=enter`), 'Kurzbefehle → Automation → „Ankunft“ → Ort wählen → „Inhalte von URL abrufen“ mit dieser Adresse. Zweite Automation „Verlassen“ mit event=leave. „Vor Ausführen fragen“ ausschalten.'),
      urlRow('Option B · OwnTracks (kostenlos, genauer)', mk(), 'OwnTracks → Einstellungen → Verbindung → Modus „HTTP“ → URL eintragen. Regionen in der App anlegen und exakt wie die Zonen benennen – oder Standort-Modus „Signifikant/Bewegung“ nutzen: dann berechnet der Server die Zonen selbst.'),
      urlRow('Option C · Geofency (Webhook, JSON)', mk(), 'Geofency → Einstellungen → Webhook → URL eintragen, Methode POST/JSON; Ortsnamen = Zonennamen.'),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'hint' }, 'Geheimer Schlüssel: '), h('code', {}, G.key), h('button', { class: 'sm', onclick: () => { if (confirm('Neuen Schlüssel erzeugen? Alle iPhone-Einträge müssen dann angepasst werden.')) api('POST', '/api/geofence/regenerate-key', {}).then(reload).catch(fail); } }, 'Neu erzeugen'))));
  },
};

// Reihenfolge der Navigation
for (const k of ['dash', 'dev', 'auto', 'heat', 'car', 'geo', 'set']) { const p = PAGES[k]; delete PAGES[k]; PAGES[k] = p; }

