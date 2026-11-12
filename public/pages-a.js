'use strict';
/* Seiten: Dashboard, Geräte, Einstellungen */

const ICON = { light: '💡', switch: '🔌', sensor: '📈', binary: '👁', thermostat: '🌡', event: '🔘', cover: '🪟', lock: '🔒' };
const TYPE_LABEL = { light: 'Licht', switch: 'Schalter', sensor: 'Sensor', binary: 'Binärsensor', thermostat: 'Thermostat', event: 'Taster/Ereignis', cover: 'Rollo/Markise', lock: 'Schloss' };

const act = (d, action, value) => api('POST', `/api/devices/${d.id}/action`, { action, value }).catch(fail);
const LOCK_DE = { locked: 'verriegelt', unlocked: 'offen', unlatched: 'Falle offen', jammed: 'klemmt' };
const COVER_DE = { open: 'offen', closed: 'geschlossen', opening: 'öffnet …', closing: 'schließt …', stopped: 'gestoppt' };


function tile(d) {
  const s = st(d.id);
  const offline = s.online === false;
  const base = (cls, onclick, sw, ...kids) => h('div', { class: `card tile ${cls} ${offline ? 'off-line' : ''} ${d.pending ? 'pending' : ''}`, onclick: d.pending ? null : onclick },
    h('div', { class: 'top' }, h('span', { class: 'ico' }, d.driver === 'dew' ? '💧' : (ICON[d.type] || '')),
      s.battery != null || s.batteryState ? h('span', { class: 'bat' + ((s.battery != null && s.battery <= 20) || s.batteryState === 'niedrig' ? ' low' : ''), title: 'Batterie' }, '🔋 ' + (s.battery != null ? s.battery + ' %' : s.batteryState)) : null,
      sw ? h('span', { class: 'sw' }) : null),
    h('div', { class: 'name', title: d.name }, d.name), ...kids);
  if (d.pending) {
    return base('', null, false, h('div', { class: 'sub' }, '⚠ nicht verbunden'), h('div', { class: 'sub', title: d.note || '' }, d.note ? d.note.slice(0, 48) : ''));
  }
  switch (d.type) {
    case 'switch':
    case 'light': {
      const known = s.on !== undefined;
      const sub = [];
      if (s.power !== undefined) sub.push(`${fmtNum(s.power, 0)} W`);
      if (offline) sub.push('offline');
      const dimmable = d.type === 'light' && d.paths && d.paths.brightness;
      return base(`click ${s.on ? 'on' : ''}`, () => act(d, 'toggle'), true,
        h('div', { class: 'val' }, known ? (s.on ? 'An' : 'Aus') : '–'),
        dimmable ? h('input', {
          type: 'range', min: 0, max: 100, value: s.brightness ?? (s.on ? 100 : 0),
          onclick: (e) => e.stopPropagation(), onchange: (e) => act(d, 'brightness', Number(e.target.value)),
        }) : null,
        h('div', { class: 'sub' }, sub.join(' · ') || (dimmable && s.brightness !== undefined ? `${s.brightness} %` : '')));
    }
    case 'lock': {
      const locked = s.state === 'locked';
      return base(`click ${s.state && !locked ? 'on' : ''}`, () => act(d, locked ? 'unlock' : 'lock'), false,
        h('div', { class: 'val' }, (locked ? '🔒 ' : '🔓 ') + (LOCK_DE[s.state] || '–')),
        h('div', { class: 'sub' }, locked ? 'Tippen zum Aufsperren' : s.state ? 'Tippen zum Zusperren' : ''));
    }
    case 'cover':
      return base(s.state === 'open' ? 'on' : '', null, false,
        h('div', { class: 'val', style: 'font-size:18px' }, s.state ? (COVER_DE[s.state] || s.state) : '–'),
        h('div', { class: 'cover-btns' },
          h('button', { class: 'sm', title: 'Öffnen', onclick: () => act(d, 'open') }, '▲'),
          h('button', { class: 'sm', title: 'Stopp', onclick: () => act(d, 'stop') }, '■'),
          h('button', { class: 'sm', title: 'Schließen', onclick: () => act(d, 'close') }, '▼')));
    case 'sensor':
      return base('', null, false, h('div', { class: 'val' }, s.value === undefined ? '–' : (typeof s.value === 'number' ? fmtNum(s.value, 1) : s.value), d.unit ? h('small', { class: 'sub' }, ' ' + d.unit) : null));
    case 'binary':
      return base(s.on ? 'on' : '', null, false, h('div', { class: 'val' }, s.on === undefined ? '–' : (s.on ? 'aktiv' : 'inaktiv')));
    case 'event':
      return base('', null, false, h('div', { class: 'val', style: 'font-size:17px' }, s.value ?? '–'), h('div', { class: 'sub' }, s.ts ? fmtTime(s.ts) : ''));
    case 'thermostat': {
      const sp = s.setpoint;
      const step = (dl) => (e) => { e.stopPropagation(); act(d, 'setpoint', Math.round(((sp ?? 20) + dl) * 2) / 2); };
      return base('', null, false,
        h('div', { class: 'val' }, s.current === undefined ? '–' : `${fmtNum(s.current)} °C`),
        h('div', { class: 'row sb' }, h('button', { class: 'sm', onclick: step(-0.5) }, '−'), h('span', { class: 'sub' }, `Soll ${sp === undefined ? '–' : fmtNum(sp)} °C`), h('button', { class: 'sm', onclick: step(0.5) }, '+')));
    }
    default: return base('', null, false);
  }
}

// ---------- Import aus Home Assistant ----------
async function importDialog() {
  let pv;
  try { pv = await api('GET', '/api/import/ha'); } catch (e) { return fail(e); }
  modal('Aus Home Assistant übernehmen', h('div', {},
    h('p', { style: 'margin-top:0' }, `Die Importdatei enthält ${pv.devices} Geräte und ${pv.automations} Automationen (davon neu: ${pv.newDevices} Geräte, ${pv.newAutomations} Automationen). Bereits importierte Einträge werden nicht doppelt angelegt.`),
    h('ul', { class: 'hint' }, [
      h('li', {}, 'Zigbee2MQTT-Geräte sind sofort einsatzbereit (Broker unter „Einstellungen“ eintragen).'),
      h('li', {}, 'Tasmota-Geräte verbinden sich automatisch, sobald ihre Discovery-Meldung über MQTT eintrifft.'),
      h('li', {}, 'Shelly-Geräte und Wind-Sensoren: nur die IP bzw. URL fehlt. Tuya-Geräte kommen über das Plugin „Tuya“ (Einstellungen → Erweiterungen → Plugins).'),
      ...(pv.notes || []).map((n) => h('li', {}, n)),
    ])),
  [{ label: 'Abbrechen' }, {
    label: 'Jetzt importieren', primary: true,
    onClick: async () => {
      const r = await api('POST', '/api/import/ha', {});
      await reload();
      modal('Import abgeschlossen', h('div', {},
        h('p', { style: 'margin-top:0' }, `${r.devicesAdded} Geräte und ${r.automationsAdded} Automationen angelegt.${r.homeSet ? ' Als Heimposition wurde die Region Leibnitz gesetzt – bitte unter „Geofence“ genauer eintragen (für Sonnenauf-/untergang reicht sie).' : ''}`),
        r.pending.length ? h('div', {}, h('b', {}, `${r.pending.length} Geräte warten noch auf eine Verbindung:`), h('div', { class: 'hint', style: 'max-height:40vh;overflow:auto;margin-top:6px' }, r.pending.map((p) => h('div', {}, `• ${p.name}${p.note ? ' – ' + p.note : ''}`)))) : null));
      return false; // Ergebnis-Dialog bleibt offen
    },
  }]);
}

// ---------- Dashboard (frei bearbeitbar) ----------
const DASH_WIDGETS = { scenes: '▶ Szenen', presence: '👥 Anwesenheit', heating: '🌡 Heizung', energy: '⚡ Energie', weather: '🌤 Wetter', favs: '★ Favoriten', rest: '▦ Weitere Geräte' };
let dashEdit = false;
let dashDraft = null;

// gespeichertes Layout + Räume, die noch keinen Block haben (neu angelegte Räume dürfen nicht „verschwinden“)
function effectiveBlocks() {
  const base = S.dash ? S.dash.map((b) => ({ ...b })) : defaultBlocks();
  const miss = S.rooms.filter((r) => !base.some((b) => b.kind === 'room' && b.ref === r) && S.devices.some((d) => d.room === r && !d.hide)).map((r) => ({ id: 'i' + r, kind: 'room', ref: r }));
  if (miss.length) {
    const i = base.findIndex((b) => b.kind === 'rest');
    base.splice(i >= 0 ? i : base.length, 0, ...miss);
  }
  return base;
}

function defaultBlocks() {
  const b = ['scenes', 'presence', 'heating', 'energy', 'weather', 'favs'].map((kind) => ({ kind, ref: '' }));
  for (const r of S.rooms) b.push({ kind: 'room', ref: r });
  b.push({ kind: 'rest', ref: '' });
  return b.map((x, i) => ({ id: 'b' + i, ...x }));
}
const blockLabel = (b) => (b.kind === 'room' ? '🏷 ' + b.ref : b.kind === 'device' ? '▫ ' + ((dev(b.ref) || {}).name || 'Gerät (gelöscht)') : DASH_WIDGETS[b.kind] || b.kind);

// liefert { kind: 'widget'|'dev'|'section', el } oder null
function renderBlock(b, edit) {
  const sec = (title, ds) => (ds.length ? { kind: 'section', el: h('div', {}, h('h2', {}, title), h('div', { class: 'grid' }, ds.map(tile))) } : null);
  const vis = (d) => !d.hide;
  const BMOD = { presence: 'geo', heating: 'heating', energy: 'energy', weather: 'ecowitt' };
  if (BMOD[b.kind] && !modOn(BMOD[b.kind])) return null;
  switch (b.kind) {
    case 'scenes': {
      const sc = S.automations.filter((a) => a.dash && a.enabled);
      if (!sc.length) return null;
      return { kind: 'section', el: h('div', {}, h('h2', {}, 'Szenen'), h('div', { class: 'row' }, sc.map((a) => h('button', { onclick: () => api('POST', `/api/automations/${a.id}/run`, {}).then(() => toast(a.name + ' ausgeführt')).catch(fail) }, '▶ ' + a.name)))) };
    }
    case 'presence':
      if (!S.presence.length) return null;
      return { kind: 'widget', el: h('div', { class: 'card' }, h('h3', {}, 'Anwesenheit'), h('div', { class: 'kv' }, S.presence.flatMap((p) => [h('span', {}, p.name), h('span', {}, p.known ? (p.home ? '🏠 zuhause' : '🚶 unterwegs') : 'unbekannt')]))) };
    case 'heating':
      if (!S.heating.rooms.length) return null;
      return { kind: 'widget', el: h('div', { class: 'card tile click', onclick: () => go('heat') }, h('h3', {}, '🌡 Heizung'),
        h('div', { class: 'kv' }, S.heating.rooms.slice(0, 5).flatMap((r) => [h('span', {}, r.name), h('span', {}, `${fmtNum(r.current)} → ${fmtNum(r.target)} °C`)]))) };
    case 'energy': {
      const el = typeof energyCard === 'function' ? energyCard() : null;
      return el ? { kind: 'widget', el } : null;
    }
    case 'weather': {
      const el = typeof weatherCard === 'function' ? weatherCard() : null;
      return el ? { kind: 'widget', el } : null;
    }
    case 'favs': return sec('★ Favoriten', S.devices.filter((d) => d.fav));
    case 'room': return sec(b.ref, S.devices.filter((d) => d.room === b.ref && vis(d)));
    case 'rest': return sec('Weitere', S.devices.filter((d) => (!d.room || !S.rooms.includes(d.room)) && vis(d)));
    case 'device': { const d = dev(b.ref); return d ? { kind: 'dev', el: tile(d) } : null; }
    default: return null;
  }
}

async function saveDash(blocks) {
  await api('PUT', '/api/dash', { blocks });
  S.dash = blocks;
}

function addBlockDialog() {
  const have = new Set(dashDraft.map((b) => b.kind + ':' + b.ref));
  const opts = { '': '– wählen –' };
  for (const k of Object.keys(DASH_WIDGETS)) if (!have.has(k + ':')) opts['w:' + k] = DASH_WIDGETS[k];
  for (const r of S.rooms) if (!have.has('room:' + r)) opts['r:' + r] = '🏷 Raum ' + r;
  for (const d of S.devices) if (!have.has('device:' + d.id)) opts['d:' + d.id] = `▫ ${d.name}${d.room ? ' (' + d.room + ')' : ''}`;
  let v = '';
  const bx = h('div', {}, fld('Was soll auf dem Dashboard erscheinen?', sel(opts, '', (x) => { v = x; })),
    h('p', { class: 'hint' }, 'Räume und Bereiche zeigen mehrere Geräte, „Gerät“ eine einzelne Kachel.'));
  modal('Kachel hinzufügen', bx, [{ label: 'Abbrechen' }, {
    label: 'Hinzufügen', primary: true, onClick: () => {
      if (!v) { toast('Bitte etwas auswählen', true); return false; }
      const [t, ref] = [v[0], v.slice(2)];
      dashDraft.push(t === 'w' ? { id: 'n' + Date.now(), kind: ref, ref: '' } : t === 'r' ? { id: 'n' + Date.now(), kind: 'room', ref } : { id: 'n' + Date.now(), kind: 'device', ref });
      renderPage();
    },
  }]);
}

function dashEditView(el) {
  const move = (i, j) => { if (j < 0 || j >= dashDraft.length || i === j) return; const [b] = dashDraft.splice(i, 1); dashDraft.splice(j, 0, b); renderPage(); };
  el.append(h('div', { class: 'banner edit-bar' }, h('span', {}, '✎ Dashboard bearbeiten – Blöcke ziehen oder mit ▲▼ verschieben, ✕ entfernt sie.'),
    h('button', { class: 'sm', onclick: addBlockDialog }, '+ Kachel'),
    h('button', { class: 'sm', onclick: () => { if (confirm('Standard-Anordnung wiederherstellen?')) { dashDraft = defaultBlocks(); renderPage(); } } }, 'Standard'),
    h('button', { class: 'sm', onclick: () => { dashEdit = false; dashDraft = null; renderPage(); } }, 'Abbrechen'),
    h('button', { class: 'sm primary', onclick: async () => { try { await saveDash(dashDraft); dashEdit = false; dashDraft = null; toast('Dashboard gespeichert'); renderPage(); } catch (e) { fail(e); } } }, 'Fertig')));
  dashDraft.forEach((b, i) => {
    const r = renderBlock(b, true);
    el.append(h('div', {
      class: 'eblock', draggable: 'true',
      ondragstart: (ev) => { ev.dataTransfer.setData('text/plain', String(i)); ev.currentTarget.classList.add('drag'); },
      ondragend: (ev) => ev.currentTarget.classList.remove('drag'),
      ondragover: (ev) => { ev.preventDefault(); ev.currentTarget.classList.add('over'); },
      ondragleave: (ev) => ev.currentTarget.classList.remove('over'),
      ondrop: (ev) => { ev.preventDefault(); move(Number(ev.dataTransfer.getData('text/plain')), i); },
    },
    h('div', { class: 'ehead' }, h('span', { class: 'grip', title: 'Ziehen' }, '⠿'), h('b', {}, blockLabel(b)),
      h('span', { class: 'sp' }), h('button', { class: 'sm', title: 'Nach oben', onclick: () => move(i, i - 1) }, '▲'), h('button', { class: 'sm', title: 'Nach unten', onclick: () => move(i, i + 1) }, '▼'),
      h('button', { class: 'sm danger', title: 'Entfernen', onclick: () => { dashDraft.splice(i, 1); renderPage(); } }, '✕')),
    h('div', { class: 'eprev' }, r ? (r.kind === 'widget' ? h('div', { class: 'grid wide' }, r.el) : r.kind === 'dev' ? h('div', { class: 'grid' }, r.el) : r.el) : h('p', { class: 'hint', style: 'margin:6px 0' }, 'Zurzeit leer – erscheint automatisch, sobald es etwas anzuzeigen gibt.'))));
  });
  if (!dashDraft.length) el.append(h('div', { class: 'empty' }, 'Das Dashboard ist leer. Mit „+ Kachel“ etwas hinzufügen.'));
}

PAGES.dash = {
  label: 'Dashboard', short: 'Home', icon: '🏠', live: true,
  render(el) {
    if (dashEdit) { dashEditView(el); return; }
    if (!S.devices.length) {
      el.append(h('div', { class: 'empty', style: 'margin-top:16px' }, h('p', {}, 'Noch keine Geräte.'),
        h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'primary', onclick: () => go('dev') }, 'Geräte hinzufügen'), h('button', { onclick: importDialog }, 'Aus Home Assistant übernehmen'))));
      return;
    }
    const blocks = effectiveBlocks();
    // Raumfilter (nur für Raum-/Favoriten-/Weitere-Blöcke)
    const rooms = blocks.filter((b) => b.kind === 'room').map((b) => b.ref);
    const hasRest = blocks.some((b) => b.kind === 'rest');
    let filt = localStorage.getItem('hl_room') || '';
    if (filt && filt !== '__rest' && !rooms.includes(filt)) filt = '';
    if (filt === '__rest' && !hasRest) filt = '';
    const chips = [['', 'Alle'], ...rooms.map((r) => [r, r])];
    if (hasRest) chips.push(['__rest', 'Weitere']);
    const bar = h('div', { class: 'row sb', style: 'margin-bottom:8px' },
      rooms.length ? h('div', { class: 'chipbar roomchips', style: 'margin:0;flex:1' }, chips.map(([k, l]) => h('button', { class: 'fchip ' + (filt === k ? 'act' : ''), onclick: () => { localStorage.setItem('hl_room', k); renderPage(); } }, l))) : h('span'),
      rooms.length ? sel(Object.fromEntries(chips.map(([k, l]) => [k, k === '' ? '🏠 Alle Räume' : l])), filt, (v) => { localStorage.setItem('hl_room', v); renderPage(); }, { class: 'roomsel', 'aria-label': 'Raum wählen' }) : null,
      h('button', { class: 'sm', title: 'Dashboard anpassen', onclick: () => { dashDraft = JSON.parse(JSON.stringify(blocks)); dashEdit = true; renderPage(); } }, '✎ Bearbeiten'));
    el.append(bar);
    let grp = null;
    let grpKind = '';
    for (const b of blocks) {
      if (filt && ((b.kind === 'room' && b.ref !== filt) || b.kind === 'favs' || (b.kind === 'rest' && filt !== '__rest') || (b.kind === 'device'))) continue;
      if (filt === '__rest' && b.kind === 'room') continue;
      const r = renderBlock(b, false);
      if (!r) continue;
      if (r.kind === 'section') { grp = null; el.append(r.el); continue; }
      if (!grp || grpKind !== r.kind) { grp = h('div', { class: r.kind === 'widget' ? 'grid wide' : 'grid', style: 'margin-bottom:12px' }); grpKind = r.kind; el.append(grp); }
      grp.append(r.el);
    }
  },
};

// ---------- Geräte ----------
const MQTT_HELP = 'stateTopics: Topics, auf denen der Zustand kommt. paths: JSON-Pfade im Payload ("" = ganzer Payload). cmd: topic + Payloads (on/off, brightness/setpoint mit {{v}}). Beispiel Zigbee2MQTT-Steckdose siehe README.';

function deviceDialog(d, onSaved, initial) {
  const isNew = !d;
  const o = d ? JSON.parse(JSON.stringify(d)) : (initial || {
    driver: 'mqtt', type: 'switch', name: '', room: '', fav: false,
    stateTopics: ['mein/topic/state'], paths: { on: '' }, cmd: { topic: 'mein/topic/set', on: 'ON', off: 'OFF' }, onValue: '', unit: '',
  });
  const name = h('input', { value: o.name });
  const room = sel(['', ...S.rooms], o.room, (v) => { o.room = v; });
  const type = sel(Object.fromEntries(S.types.map((t) => [t, TYPE_LABEL[t] || t])), o.type, (v) => { o.type = v; });
  const driver = sel({ mqtt: 'MQTT', shelly: 'Shelly (HTTP)', http: 'HTTP-Sensor (JSON)', virtual: 'Virtueller Schalter' }, o.driver, (v) => { o.driver = v; if (v === 'http') { o.type = 'sensor'; type.value = 'sensor'; } if (v === 'virtual') { o.type = 'switch'; type.value = 'switch'; } draw(); }, { disabled: !isNew });
  const box = h('div', { class: 'form', style: 'margin-top:12px' });
  let adv;
  const f = {
    ip: h('input', { value: o.ip || '', placeholder: '192.168.1.50' }),
    user: h('input', { value: o.user || '', placeholder: 'optional' }),
    pass: h('input', { type: 'password', placeholder: o.hasPass ? '(unverändert)' : 'optional' }),
    ch: h('input', { type: 'number', min: 0, value: o.channel || 0 }),
    url: h('input', { value: o.url || '', placeholder: 'http://192.168.1.60/get_livedata_info' }),
    jsonPath: h('input', { value: o.jsonPath || '', placeholder: 'current.temperature' }),
    scale: h('input', { type: 'number', step: 'any', value: o.scale ?? 1 }),
    interval: h('input', { type: 'number', min: 10, value: o.interval ?? 60 }),
    unit: h('input', { value: o.unit || '' }),
  };
  const gen = sel({ 0: 'automatisch erkennen', 1: 'Gen 1', 2: 'Gen 2/3' }, o.gen ?? 0, (v) => { o.gen = Number(v); });
  function draw() {
    box.replaceChildren();
    if (o.driver === 'shelly') {
      box.append(fld('IP / Hostname', f.ip), fld('Generation', gen), fld('Kanal (0 = erster)', f.ch), fld('Benutzer', f.user), fld('Passwort', f.pass));
    } else if (o.driver === 'http') {
      box.append(fld('URL (liefert JSON)', f.url), fld('Wert-Pfad im JSON', f.jsonPath), fld('Faktor', f.scale), fld('Abfrage alle … Sek.', f.interval), fld('Einheit', f.unit),
        h('div', { class: 'hint full' }, 'Pfad-Beispiele: current.dew_point_2m · common_list[id=0x0B].val (Filter nach Feldwert) · data[0].temp'));
    } else if (o.driver === 'virtual') {
      box.append(h('div', { class: 'hint full' }, 'Ein Schalter ohne Hardware, z. B. als Merker („Windsperre aktiv“) für Automationen.'));
    } else {
      const keep = ['stateTopics', 'paths', 'cmd', 'get', 'onValue', 'unit', 'brightnessMax'];
      adv = h('textarea', { class: 'full', style: 'min-height:220px' }, JSON.stringify(Object.fromEntries(keep.filter((k) => o[k] !== undefined && o[k] !== '' && !(Array.isArray(o[k]) && !o[k].length)).map((k) => [k, o[k]])), null, 2));
      box.append(adv, h('div', { class: 'hint full' }, MQTT_HELP));
    }
  }
  draw();
  const body = h('div', {},
    o.pending || (d && d.pending) ? h('div', { class: 'banner' }, '⚠ Dieses Gerät ist noch nicht verbunden. ', o.note || '') : (o.note ? h('div', { class: 'hint', style: 'margin-bottom:10px' }, o.note) : null),
    h('div', { class: 'form' }, fld('Name', name), fld('Raum', room), fld('Typ', type), isNew ? fld('Treiber', driver) : null),
    h('div', { style: 'margin-top:10px' }, chk('Favorit (oben im Dashboard)', o.fav, (v) => { o.fav = v; })), box);
  modal(isNew ? 'Gerät manuell anlegen' : 'Gerät bearbeiten', body, [
    { label: 'Abbrechen' },
    {
      label: 'Speichern', primary: true,
      onClick: async () => {
        const payload = { ...o, name: name.value.trim() || 'Gerät' };
        delete payload.pending; delete payload.hasPass;
        if (o.driver === 'shelly') {
          Object.assign(payload, { ip: f.ip.value.trim(), channel: Number(f.ch.value) || 0, gen: o.gen ?? 0, user: f.user.value });
          if (f.pass.value) payload.pass = f.pass.value; else delete payload.pass;
          if (payload.ip && o.pending !== undefined) payload.pending = false;
        } else if (o.driver === 'http') {
          Object.assign(payload, { url: f.url.value.trim(), jsonPath: f.jsonPath.value.trim(), scale: Number(f.scale.value) || 1, interval: Number(f.interval.value) || 60, unit: f.unit.value });
        } else if (o.driver === 'mqtt') {
          let j;
          try { j = JSON.parse(adv.value); } catch { toast('JSON ungültig', true); return false; }
          Object.assign(payload, j);
          if (j.stateTopics && j.stateTopics.length) payload.pending = false;
        }
        if (d && d.pending && (payload.ip || payload.url || (payload.stateTopics && payload.stateTopics.length))) payload.pending = false; else if (d && d.pending) payload.pending = true;
        if (isNew) await api('POST', '/api/devices', payload); else await api('PUT', `/api/devices/${d.id}`, payload);
        await reload();
        if (onSaved) onSaved();
      },
    },
  ]);
}

function addDialog() {
  let tab = 'disc';
  let shellyItems = [];
  const picked = new Set();
  let roomSel = '';
  const wrap = h('div');

  async function rescan() {
    try { await api('POST', '/api/discovery/scan', {}); } catch (e) { return fail(e); }
    toast('Suche läuft …');
    setTimeout(async () => { try { S.discovery = await api('GET', '/api/discovery'); draw(); } catch (e) { fail(e); } }, 1800);
  }

  async function submit(items) {
    const sel2 = items.filter((c) => picked.has(c.key)).map(({ key, added, ...c }) => ({ ...c, src: key, room: roomSel }));
    if (!sel2.length) { toast('Nichts ausgewählt', true); return false; }
    const r = await api('POST', '/api/devices', { items: sel2 });
    toast(`${r.added.length} Gerät(e) hinzugefügt`);
    await reload();
    return true;
  }

  function candList(items) {
    if (!items.length) return h('div', { class: 'empty' }, 'Nichts gefunden.');
    return h('div', { class: 'list' }, items.map((c) => h('label', { class: 'item' },
      h('input', { type: 'checkbox', disabled: c.added, checked: picked.has(c.key), onchange: (e) => { if (e.target.checked) picked.add(c.key); else picked.delete(c.key); } }),
      h('span', { class: 'grow' }, c.name), h('span', { class: 'pill' }, TYPE_LABEL[c.type] || c.type), c.added ? h('span', { class: 'pill ok' }, 'vorhanden') : null)));
  }

  let current = [];
  function draw() {
    const tabs = h('div', { class: 'tabs' }, [['disc', 'Entdeckt (Zigbee2MQTT / Tasmota / Shelly)'], ['shelly', 'Shelly per IP'], ['manual', 'Manuell']].map(([k, l]) => h('button', { class: 'seg ' + (tab === k ? 'act' : ''), onclick: () => { tab = k; picked.clear(); draw(); } }, l)));
    const roomPick = fld('Raum für neue Geräte', sel(['', ...S.rooms], roomSel, (v) => { roomSel = v; }));
    let content;
    if (tab === 'disc') {
      const d = S.discovery;
      current = [...d.z2m, ...d.tasmota, ...(d.shelly || [])];
      content = h('div', {},
        !d.mqtt ? h('div', { class: 'hint' }, 'MQTT ist nicht verbunden – bitte zuerst unter „Einstellungen“ den Broker eintragen.') : null,
        h('div', { class: 'row', style: 'margin:8px 0' }, h('button', { onclick: rescan }, '↻ Neu suchen'), h('span', { class: 'hint' }, `${d.z2m.length} aus Zigbee2MQTT, ${d.tasmota.length} Tasmota-Kanäle, ${(d.shelly || []).length} Shelly-Motion-Werte`)),
        candList(current), roomPick);
    } else if (tab === 'shelly') {
      const ip = h('input', { placeholder: '192.168.1.50' });
      const user = h('input', { placeholder: 'optional' });
      const pass = h('input', { type: 'password', placeholder: 'optional (nur Gen 1)' });
      current = shellyItems;
      content = h('div', {},
        h('div', { class: 'form' }, fld('IP / Hostname', ip), fld('Benutzer', user), fld('Passwort', pass)),
        h('div', { class: 'row', style: 'margin:8px 0' }, h('button', {
          onclick: async () => {
            try { shellyItems = (await api('POST', '/api/shelly/probe', { ip: ip.value.trim(), user: user.value, pass: pass.value })).items; picked.clear(); shellyItems.forEach((c) => picked.add(c.key)); draw(); } catch (e) { fail(e); }
          },
        }, 'Suchen')),
        shellyItems.length ? candList(shellyItems) : h('div', { class: 'hint' }, 'Shelly Gen 1 und Gen 2/3 ohne Digest-Auth werden unterstützt. Der Shelly Motion (2) schläft – Reset-Taste kurz drücken und sofort suchen, oder unten per MQTT-ID einbinden.'), roomPick,
        (() => {
          const mid = h('input', { placeholder: 'shellymotion2-AABBCCDDEEFF oder 12-stellige MAC' });
          return h('div', { class: 'card', style: 'margin-top:12px' }, h('b', {}, 'Shelly Motion / Batteriegerät per MQTT'),
            h('p', { class: 'hint' }, 'Am Sensor (Reset-Taste drücken, dann http://<IP>/ öffnen) unter Internet & Sicherheit → MQTT den Broker von HomeLite eintragen. Der Sensor meldet sich danach unter „Entdeckt“ von selbst, sobald er sendet – oder hier direkt mit der ID (steht in der Geräteinfo, „shellymotion2-“ + MAC) hinzufügen.'),
            h('div', { class: 'row' }, mid, h('button', { class: 'primary', onclick: async () => { try { const r = await api('POST', '/api/shelly/motion', { id: mid.value.trim(), room: roomSel }); toast(`${r.added.length} Sensor-Werte hinzugefügt`); await reload(); } catch (e) { fail(e); } } }, 'Hinzufügen')));
        })());
    } else {
      content = h('div', {}, h('p', { class: 'hint' }, 'Für beliebige MQTT-Geräte oder Shelly mit fester IP.'), h('button', { onclick: () => deviceDialog(null) }, 'Formular öffnen …'));
    }
    wrap.replaceChildren(tabs, content);
  }
  draw();
  modal('Geräte hinzufügen', wrap, [
    { label: 'Schließen' },
    { label: 'Ausgewählte hinzufügen', primary: true, onClick: async () => { if (tab === 'manual') return true; return submit(current); } },
  ]);
}

PAGES.dev = {
  label: 'Geräte', icon: '🔌',
  render(el) {
    let q = '';
    let filt = localStorage.getItem('hl_devfilter') || 'all';
    const pend = S.devices.filter((d) => d.pending).length;
    const tableBox = h('div');
    const stateOf = (d, s) => {
      if (d.pending) return h('span', { class: 'pill warn' }, '⚠ nicht verbunden');
      if (d.type === 'sensor') return `${s.value ?? '–'} ${d.unit || ''}`;
      if (d.type === 'thermostat') return `${fmtNum(s.current)} °C / Soll ${fmtNum(s.setpoint)}`;
      if (d.type === 'event') return s.value ?? '–';
      if (d.type === 'cover') return COVER_DE[s.state] || s.state || '–';
      if (d.type === 'lock') return LOCK_DE[s.state] || s.state || '–';
      return s.on === undefined ? '–' : s.on ? 'an' : 'aus';
    };
    const sourceOf = (d) => (d.driver === 'shelly' ? h('code', {}, d.ip ? `shelly ${d.ip}#${d.channel}` : 'shelly (IP fehlt)')
      : d.driver === 'http' ? h('code', {}, d.url ? 'http' : 'http (URL fehlt)') : d.driver === 'virtual' ? h('code', {}, 'virtuell') : d.driver === 'plugin' ? h('code', {}, 'plugin ' + d.plugin) : h('code', {}, (d.stateTopics || [])[0] || (d.tasmota ? `tasmota ${d.tasmota.mac}` : '–')));
    function drawTable() {
      const list = S.devices.filter((d) => (filt === 'pending' ? d.pending : true) && (!q || `${d.name} ${d.room} ${d.note || ''}`.toLowerCase().includes(q)));
      tableBox.replaceChildren(list.length ? h('div', { class: 'card', style: 'overflow-x:auto;padding:6px 14px' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Name', 'Raum', 'Typ', 'Quelle', 'Zustand', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, list.map((d) => {
          const s = st(d.id);
          return h('tr', {}, h('td', {}, (d.fav ? '★ ' : '') + d.name), h('td', {}, d.room || '–'), h('td', {}, TYPE_LABEL[d.type] || d.type),
            h('td', {}, sourceOf(d)), h('td', {}, stateOf(d, s)), h('td', {}, h('div', { class: 'row', style: 'flex-wrap:nowrap' },
              h('button', { class: 'sm', onclick: () => deviceDialog(d) }, 'Bearbeiten'),
              h('button', { class: 'sm danger', onclick: () => { if (confirm(`„${d.name}“ löschen?`)) api('DELETE', `/api/devices/${d.id}`).then(reload).catch(fail); } }, 'Löschen'))));
        })))) : h('div', { class: 'empty' }, 'Keine Treffer.'));
    }
    el.append(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, `Geräte (${S.devices.length})`),
      h('div', { class: 'row' }, h('button', { onclick: importDialog }, '⇪ Aus Home Assistant'), h('button', { class: 'primary', onclick: addDialog }, '+ Hinzufügen'))));
    if (!S.devices.length) { el.append(h('div', { class: 'empty', style: 'margin-top:12px' }, 'Noch keine Geräte.')); return; }
    if (pend) el.append(h('div', { class: 'banner', style: 'margin-top:12px' }, h('span', {}, `⚠ ${pend} Geräte sind noch nicht verbunden.`), filt === 'pending' ? null : h('button', { class: 'sm', onclick: () => { localStorage.setItem('hl_devfilter', 'pending'); renderPage(); } }, 'Nur diese anzeigen')));
    el.append(h('div', { class: 'row', style: 'margin:14px 0' },
      h('input', { class: 'search', placeholder: 'Suchen …', oninput: (e) => { q = e.target.value.toLowerCase(); drawTable(); } }),
      h('button', { class: 'fchip ' + (filt === 'all' ? 'act' : ''), onclick: () => { localStorage.setItem('hl_devfilter', 'all'); renderPage(); } }, 'Alle'),
      h('button', { class: 'fchip ' + (filt === 'pending' ? 'act' : ''), onclick: () => { localStorage.setItem('hl_devfilter', 'pending'); renderPage(); } }, `Nicht verbunden (${pend})`)));
    el.append(tableBox);
    drawTable();
    coiotSection(el);
    shellyFwSection(el);
  },
};

// ---------- MQTT-Monitor ----------
function flatJson(o, prefix = '', out = []) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatJson(v, key, out); else out.push([key, v]);
  }
  return out;
}

function mqttMonitor(el) {
  const radar = S.devices.find((d) => /radar/i.test(d.name) && (d.stateTopics || [])[0]);
  const topic = h('input', { value: localStorage.getItem('hl_peek') || (radar ? radar.stateTopics[0] : `${S.mqtt.z2mBase}/#`), placeholder: 'zigbee2mqtt/Radar Küche' });
  const out = h('div', { style: 'margin-top:12px' });
  async function listen() {
    localStorage.setItem('hl_peek', topic.value.trim());
    fill(out, h('p', { class: 'hint' }, 'Höre mit … (bis zu 20 Sekunden – bei einem Präsenzmelder kurz vor dem Sensor bewegen)'));
    try {
      const { messages } = await api('POST', '/api/mqtt/peek', { topic: topic.value.trim(), seconds: 20 });
      if (!messages.length) { fill(out, h('p', { class: 'hint' }, 'Keine Nachricht empfangen. Entweder sendet das Gerät gerade nichts (Zigbee2MQTT prüfen: Gerät online? Batterie/Strom?) oder der Topic-Name stimmt nicht – in Zigbee2MQTT steht er als „Friendly name“.')); return; }
      fill(out, messages.map((m) => {
        let parsed;
        try { parsed = JSON.parse(m.payload); } catch { parsed = null; }
        const rows = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? flatJson(parsed) : [];
        return h('div', { class: 'card', style: 'margin-bottom:10px' },
          h('div', { class: 'row sb' }, h('code', {}, m.topic), h('span', { class: 'hint' }, fmtTime(m.ts))),
          rows.length ? h('table', { style: 'margin-top:8px' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, String(v)),
            h('td', {}, typeof v === 'boolean' || typeof v === 'number' ? h('button', { class: 'sm', onclick: () => addValue(m.topic, k, v) }, '+ als Gerät') : null)))))
            : h('pre', { style: 'white-space:pre-wrap;margin:8px 0 0' }, m.payload));
      }));
    } catch (e) { fill(out, h('p', { class: 'hint' }, e.message)); }
  }
  async function addValue(t, key, v) {
    const base = t.split('/').pop();
    const bool = typeof v === 'boolean';
    const name = h('input', { value: `${base} ${key}` });
    modal('Als Gerät übernehmen', h('div', { class: 'form' }, fld('Name', name), h('p', { class: 'hint' }, `${bool ? 'Ein/Aus-Sensor' : 'Messwert'} aus „${key}“ von ${t}`)), [{ label: 'Abbrechen' }, {
      label: 'Übernehmen', primary: true,
      onClick: async () => {
        const dev = bool ? { type: 'binary', paths: { on: key }, onValue: 'true' } : { type: 'sensor', paths: { value: key } };
        await api('POST', '/api/devices', { name: name.value.trim() || key, driver: 'mqtt', stateTopics: [t], ...dev });
        toast('Gerät angelegt');
        S = await api('GET', '/api/bootstrap'); // ohne Neuzeichnen, damit die Messwerte sichtbar bleiben
        renderStatus();
      },
    }]);
  }
  el.append(h('h2', {}, 'MQTT-Monitor'), h('div', { class: 'card' },
    h('p', { class: 'hint', style: 'margin-top:0' }, 'Zeigt, was ein Gerät wirklich per MQTT sendet – z. B. alle Werte eines Radar-/Präsenzmelders. Einzelne Werte lassen sich direkt als Gerät übernehmen. Auch Filter wie zigbee2mqtt/# funktionieren.'),
    h('div', { class: 'form' }, fld('Topic', topic)),
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: listen }, '👂 Mithören')), out));
}

// ---------- Backup & Wiederherstellung ----------
const fmtSize = (b) => (b == null ? '–' : b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');

function backupSection(el) {
  const box = h('div', { class: 'card' });
  el.append(h('h2', {}, 'Backup & Wiederherstellung'), box);
  async function draw() {
    let b;
    try { b = await api('GET', '/api/backup'); } catch (e) { fill(box, h('p', { class: 'hint' }, e.message)); return; }
    const o = { auto: b.auto, allowSameDisk: b.allowSameDisk };
    const dir = h('input', { value: b.dir, placeholder: '/mnt/backup/homelite' });
    const keep = h('input', { type: 'number', min: 1, max: 100, value: b.keep });
    const time = h('input', { type: 'time', value: b.time || '03:00' });
    const save = () => api('PUT', '/api/backup', { dir: dir.value.trim(), keep: Number(keep.value) || 10, auto: o.auto, time: time.value, allowSameDisk: o.allowSameDisk });
    const rs = (res) => waitForRestart({ ...res, title: 'Backup wiederhergestellt', message: `Wiederhergestellt: ${res.devices} Geräte, ${res.automations} Automationen${res.ts ? ' (Backup vom ' + fmtTime(res.ts) + ')' : ''}.` });
    const up = h('input', {
      type: 'file', accept: '.tgz,.gz,application/gzip', style: 'display:none',
      onchange: async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f || !confirm('Alle aktuellen Einstellungen, Geräte und Automationen werden durch dieses Backup ersetzt (vorher wird automatisch eine Sicherung angelegt). Fortfahren?')) return;
        try { rs(await api('POST', '/api/backup/restore-upload', { data: await readB64(f) })); } catch (err) { fail(err); }
      },
    });
    const p = b.path;
    const state = !b.dir ? null : !p.exists ? h('span', { class: 'pill warn' }, 'Ordner nicht gefunden – Platte angeschlossen und eingehängt?')
      : !p.writable ? h('span', { class: 'pill bad' }, 'nicht beschreibbar')
        : p.sameDisk ? h('span', { class: 'pill warn' }, 'gleiche Festplatte wie HomeLite (keine externe Platte?)') : h('span', { class: 'pill ok' }, `bereit · ${fmtSize(p.free)} frei`);
    fill(box,
      h('p', { class: 'hint', style: 'margin-top:0' }, 'Sichert Geräte, Automationen, Einstellungen, Zugangsdaten und Anwesenheit (Ordner data/) als .tgz in einen Ordner deiner Wahl, z. B. auf einer angeschlossenen USB-Festplatte. Die Datei enthält auch Passwörter – Platte entsprechend aufbewahren.'),
      b.mounts.length ? h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span', { class: 'hint' }, 'Erkannte Laufwerke:'), b.mounts.map((m) => h('button', { class: 'sm', title: `${m.device} · ${m.type} · ${fmtSize(m.free)} frei`, onclick: () => { dir.value = m.path.replace(/\/$/, '') + '/homelite-backup'; } }, `${m.path} (${fmtSize(m.free)} frei)`)))
        : h('p', { class: 'hint' }, 'Kein externes Laufwerk erkannt. Platte anschließen und einhängen (z. B. „mount /dev/sdb1 /mnt/backup“), dann Seite neu laden. Der Ordner kann auch von Hand eingetragen werden.'),
      h('div', { class: 'form' }, fld('Zielordner', dir), fld('Backups behalten', keep), fld('Uhrzeit (täglich)', time)),
      h('div', { class: 'row', style: 'margin-top:8px' }, chk('Täglich automatisch sichern', o.auto, (v) => { o.auto = v; }), chk('Auch auf derselben Festplatte erlauben', o.allowSameDisk, (v) => { o.allowSameDisk = v; })),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { onclick: async () => { try { await save(); toast('Gespeichert'); await draw(); } catch (e) { fail(e); } } }, 'Speichern'),
        h('button', { class: 'primary', onclick: async () => { try { await save(); toast('Sichere …'); const r = await api('POST', '/api/backup/run', {}); toast('Backup erstellt (' + fmtSize(r.size) + ')'); await draw(); } catch (e) { fail(e); } } }, '💾 Backup jetzt erstellen'),
        h('button', { onclick: () => up.click() }, '⬆ Backup-Datei hochladen …'), up, state),
      b.last ? h('p', { class: 'hint' }, b.last.ok ? `Letztes Backup: ${fmtTime(b.last.ts)}${b.last.auto ? ' (automatisch)' : ''}` : `Letztes Backup fehlgeschlagen (${fmtTime(b.last.ts)}): ${b.last.error}`) : null,
      b.files.length ? h('div', { class: 'card', style: 'overflow-x:auto;padding:6px 14px;margin-top:10px' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Backup', 'Größe', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, b.files.map((f) => h('tr', {}, h('td', {}, h('div', {}, fmtTime(f.ts)), h('div', { class: 'hint' }, f.file)), h('td', {}, fmtSize(f.size)),
          h('td', {}, h('div', { class: 'row', style: 'flex-wrap:nowrap' },
            h('button', { class: 'sm', onclick: async () => { if (!confirm(`Backup vom ${fmtTime(f.ts)} wiederherstellen?\n\nAlle aktuellen Einstellungen, Geräte und Automationen werden ersetzt (vorher wird automatisch eine Sicherung angelegt) und HomeLite startet neu.`)) return; try { rs(await api('POST', '/api/backup/restore', { file: f.file })); } catch (e) { fail(e); } } }, 'Wiederherstellen'),
            h('a', { class: 'btn sm', href: '/api/backup/download?file=' + encodeURIComponent(f.file), download: f.file, style: 'text-decoration:none' }, 'Download'),
            h('button', { class: 'sm danger', onclick: async () => { if (confirm('Backup-Datei löschen?')) { try { await api('POST', '/api/backup/delete', { file: f.file }); await draw(); } catch (e) { fail(e); } } } }, 'Löschen')))))))) : (b.dir && p.exists ? h('p', { class: 'hint' }, 'Noch keine Backups in diesem Ordner.') : null));
  }
  draw();
}

// ---------- Software-Update ----------
const readB64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
  r.readAsDataURL(file);
});

function waitForRestart(res) {
  const what = res.message || `Version ${res.version} ist installiert.`;
  const limit = res.timeout || 90000;
  const body = h('div', {}, h('p', { style: 'margin-top:0' }, res.restart ? `${what} HomeLite startet neu – die Seite lädt danach automatisch …` : `${what} HomeLite läuft nicht unter systemd und muss manuell neu gestartet werden (z. B. „systemctl restart homelite“ oder Prozess neu starten).`), res.note ? h('p', { class: 'hint' }, res.note) : null);
  modal(res.title || 'Update installiert', body, res.restart ? [] : [{ label: 'Schließen' }]);
  if (!res.restart) return;
  const t0 = Date.now();
  const tick = async () => {
    try {
      const r = await fetch('/api/update', { cache: 'no-store' });
      if (r.ok && (await r.json()).version === res.version) { location.reload(); return; }
    } catch { /* Server startet neu */ }
    if (Date.now() - t0 > limit) { fill(body, h('p', {}, 'HomeLite antwortet noch nicht. Bitte Seite in einer Minute neu laden und ggf. „journalctl -u homelite -n 50“ prüfen.')); return; }
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 3000);
}

function confirmUpdate(r) {
  modal(r.newer ? 'Update gefunden' : r.same ? 'Gleiche Version' : 'Ältere Version', h('div', {},
    h('p', { style: 'margin-top:0' }, `Installiert: ${r.current} · Paket: ${r.version}`),
    r.notes && r.notes.length ? h('div', {}, h('b', {}, 'Neuerungen'), h('ul', { style: 'padding-left:18px;margin:6px 0 12px' }, r.notes.map((n) => h('li', {}, h('b', {}, n.version + ' – '), n.text)))) : null,
    h('p', { class: 'hint' }, 'Vor dem Austausch wird automatisch eine Sicherung angelegt (unter „Zurücksetzen“ erreichbar). Konfiguration und Geräte bleiben unverändert.')),
  [{ label: 'Abbrechen' }, {
    label: r.newer ? 'Jetzt installieren' : 'Trotzdem installieren', primary: true,
    onClick: async () => { waitForRestart(await api('POST', '/api/update/install', { id: r.id })); return false; },
  }]);
}

function updateSection(el) {
  const box = h('div', { class: 'card' });
  el.append(h('h2', {}, 'Software-Update'), box);
  async function draw() {
    let u;
    try { u = await api('GET', '/api/update'); } catch (e) { fill(box, h('p', { class: 'hint' }, e.message)); return; }
    const url = h('input', { value: u.url, placeholder: 'https://…/homelite.tar.gz oder https://github.com/friedlro/homelite' });
    const file = h('input', {
      type: 'file', accept: '.tgz,.gz,application/gzip', style: 'display:none',
      onchange: async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        try { toast('Prüfe Datei …'); confirmUpdate(await api('POST', '/api/update/upload', { data: await readB64(f) })); } catch (err) { fail(err); }
      },
    });
    fill(box,
      h('div', { class: 'row sb' }, h('b', {}, 'Installierte Version: ' + u.version),
        h('button', { class: 'sm', onclick: async () => { try { toast('Prüfe …'); await api('POST', '/api/update/check-now', {}); await draw(); S.updateInfo = (await api('GET', '/api/update')).check; renderStatus(); } catch (e) { fail(e); } } }, 'Jetzt prüfen')),
      h('p', { class: 'hint' }, u.check.error ? `Letzte Prüfung fehlgeschlagen: ${u.check.error}` : u.check.checked ? `Zuletzt geprüft ${fmtTime(u.check.checked)} · neueste Version ${u.check.latest || '?'}${u.check.newer ? ' – Update verfügbar!' : ' – aktuell'}` : 'Noch nicht geprüft.'),
      u.check.newer && u.check.notes.length ? h('ul', { style: 'padding-left:18px' }, u.check.notes.map((n) => h('li', {}, h('b', {}, n.version + ' – '), n.text))) : null,
      chk('Täglich automatisch nach Updates suchen und hinweisen (GitLite-/GitHub-Quelle)', u.check.auto, (v) => api('PUT', '/api/update', { url: u.url, auto: v }).then(() => toast(v ? 'Tägliche Prüfung an' : 'Tägliche Prüfung aus')).catch(fail)),
      h('p', { class: 'hint' }, 'Standard-Quelle ist das GitHub-Repository friedlro/homelite (leer lassen; ein GitLite-Repository geht ebenfalls, dann muss git installiert sein). Entweder die Update-Datei (homelite.tar.gz) hier auswählen – oder eine eigene Update-Quelle eintragen (Link zu einer .tar.gz, ein GitLite- oder ein GitHub-Repository) und „Nach Update suchen“ klicken.'),
      h('div', { class: 'form' }, fld('Update-Quelle (optional)', url)),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'primary', onclick: async () => { try { await api('PUT', '/api/update', { url: url.value.trim() }); toast('Prüfe Quelle …'); confirmUpdate(await api('POST', '/api/update/check', {})); } catch (e) { fail(e); } } }, '⟳ Nach Update suchen'),
        h('button', { onclick: () => file.click() }, '⬆ Update-Datei wählen …'), file,
        h('button', { onclick: () => api('PUT', '/api/update', { url: url.value.trim() }).then(() => toast('Gespeichert')).catch(fail) }, 'Quelle speichern')),
      u.systemd ? null : h('p', { class: 'hint' }, 'Hinweis: HomeLite läuft nicht unter systemd – nach einem Update ist ein manueller Neustart nötig.'),
      u.backups.length ? h('details', { style: 'margin-top:12px' }, h('summary', {}, `Sicherungen (${u.backups.length}) – Zurücksetzen`),
        u.backups.map((b) => h('div', { class: 'row sb', style: 'margin-top:6px' }, h('span', { class: 'hint' }, `Version ${b.version} · ${fmtTime(b.ts)} · ${(b.size / 1024).toFixed(0)} KB`),
          h('button', { class: 'sm', onclick: async () => { if (!confirm(`Auf Version ${b.version} zurücksetzen?`)) return; try { waitForRestart(await api('POST', '/api/update/rollback', { file: b.file })); } catch (e) { fail(e); } } }, 'Zurücksetzen')))) : null);
  }
  draw();
}

// ---------- Einstellungen ----------
PAGES.set = {
  label: 'Einstellungen', short: 'Mehr', icon: '⚙️',
  render(el) {
    const root = el;
    const content = h('div', { class: 'setcontent' });
    const groups = [];
    const grp = (id, label, icon) => { const d = h('div', { class: 'setgrp', id: 'setgrp-' + id }); content.append(d); groups.push({ id, label, icon, d }); return d; };
    const m = S.mqtt;
    const url = h('input', { value: m.url, placeholder: 'mqtt://192.168.1.10:1883' });
    const user = h('input', { value: m.user });
    const pass = h('input', { type: 'password', placeholder: m.hasPass ? '(unverändert)' : '' });
    const z2m = h('input', { value: m.z2mBase });
    const tas = h('input', { value: m.tasmotaGroup });
    el = grp('erw', 'Erweiterungen', '🧩');
    modulesSection(el);
    pluginsSection(el);
    el = grp('mqtt', 'MQTT & Broker', '📡');
    el.append(h('h2', {}, 'MQTT-Broker'), h('div', { class: 'card' },
      h('div', { class: 'form' }, fld('Broker-URL', url), fld('Benutzer', user), fld('Passwort', pass), fld('Zigbee2MQTT Base-Topic', z2m), fld('Tasmota Gruppen-Topic', tas)),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'primary', onclick: () => api('PUT', '/api/mqtt', { url: url.value.trim(), user: user.value, pass: pass.value, z2mBase: z2m.value.trim(), tasmotaGroup: tas.value.trim() }).then(() => { toast('Gespeichert'); setTimeout(reload, 1500); }).catch(fail) }, 'Speichern & verbinden'),
        h('span', { class: 'pill ' + (m.ok ? 'ok' : 'bad') }, m.ok ? 'verbunden' : (m.error || 'nicht verbunden')))));

    mqttMonitor(el);
    if (modOn('broker')) brokerSection(el);
    el = grp('int', 'Integrationen', '🔌');
    if (modOn('ecowitt')) ecowittSection(el);
    if (modOn('matter')) matterSection(el);
    if (modOn('appletv')) appletvSection(el);
    if (modOn('mcp')) mcpSection(el);
    el = grp('sys', 'System & Wartung', '🛠');
    systemSection(el);
    backupSection(el);
    updateSection(el);
    el = grp('allg', 'Allgemein', '⚙️');

    el.append(h('h2', {}, 'Import'), h('div', { class: 'card' },
      h('p', { class: 'hint', style: 'margin-top:0' }, 'Übernimmt die vorbereiteten Geräte und Automationen aus Home Assistant (Datei import/ha-migration.json). Mehrfaches Ausführen legt nichts doppelt an.'),
      h('button', { onclick: importDialog }, '⇪ Aus Home Assistant übernehmen …')));

    const nu = h('input', { value: S.notify.url });
    const nt = h('input', { value: S.notify.topic, placeholder: 'mein-geheimes-topic' });
    el.append(h('h2', {}, 'Benachrichtigungen (ntfy)'), h('div', { class: 'card' },
      h('p', { class: 'hint', style: 'margin-top:0' }, 'Push aufs iPhone über die kostenlose ntfy-App: dort dasselbe Topic abonnieren. Ein schwer zu erratendes Topic wählen oder ntfy selbst hosten.'),
      h('div', { class: 'form' }, fld('Server', nu), fld('Topic', nt)),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'primary', onclick: () => api('PUT', '/api/notify', { url: nu.value.trim(), topic: nt.value.trim() }).then(() => { toast('Gespeichert'); return reload(); }).catch(fail) }, 'Speichern'),
        h('button', { onclick: () => api('POST', '/api/notify/test', {}).then(() => toast('Gesendet')).catch(fail) }, 'Test senden'))));

    const rooms = h('textarea', { style: 'min-height:90px' }, S.rooms.join('\n'));
    el.append(h('h2', {}, 'Räume'), h('div', { class: 'card' }, h('p', { class: 'hint', style: 'margin-top:0' }, 'Ein Raum pro Zeile – bestimmt die Gruppierung im Dashboard.'), rooms,
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: () => api('PUT', '/api/rooms', { rooms: rooms.value.split('\n') }).then(() => { toast('Gespeichert'); return reload(); }).catch(fail) }, 'Speichern'))));

    const cur = h('input', { type: 'password', autocomplete: 'current-password' });
    const nw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'mind. 8 Zeichen' });
    el.append(h('h2', {}, 'Passwort'), h('div', { class: 'card' }, h('div', { class: 'form' }, fld('Aktuell', cur), fld('Neu', nw)),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'primary', onclick: () => api('PUT', '/api/password', { current: cur.value, password: nw.value }).then(() => { toast('Passwort geändert'); showLogin(); }).catch(fail) }, 'Ändern'),
        h('button', { onclick: () => api('POST', '/api/logout', {}).then(showLogin) }, 'Abmelden'), ' ',
        h('button', { title: 'Meldet alle Geräte und Browser ab (z. B. nach Verlust eines Handys)', onclick: () => { if (confirm('Wirklich alle Geräte und Browser abmelden?')) api('POST', '/api/logout-all', {}).then(showLogin).catch(fail); } }, 'Überall abmelden'))));

    { // Schutz vor Zugriffen von außen
      const sec = S.security || { lockExternal: true, extraPaths: [], blocked: 0 };
      const lock = h('input', { type: 'checkbox', checked: sec.lockExternal });
      const extra = h('textarea', { style: 'min-height:60px', placeholder: '/meinpfad/' }, (sec.extraPaths || []).join('\n'));
      el.append(h('h2', {}, 'Schutz vor Zugriffen von außen'), h('div', { class: 'card' },
        h('p', { class: 'hint', style: 'margin-top:0' }, 'Anfragen aus dem Internet (z. B. über Tailscale Funnel, Cloudflare Tunnel oder Portfreigabe) erreichen nur die per Schlüssel geschützten Pfade /mcp, /hook, /trigger und die Handy-Seite /where.html. Oberfläche und API sind nur im Heimnetz, Tailnet oder lokal erreichbar. Zusätzlich: höchstens 120 Anfragen pro Minute und Adresse, Sperre für Scanner, Meldung bei Anmeldung von außen.'),
        h('label', { class: 'row' }, lock, ' Von außen nur Schlüssel-Pfade erlauben (empfohlen)'),
        sec.envOverride ? h('p', { class: 'hint' }, '⚠ Per Umgebungsvariable HOMELITE_ALLOW_EXTERNAL=1 ausgeschaltet.') : null,
        h('label', { class: 'hint', style: 'display:block;margin-top:10px' }, 'Weitere von außen erlaubte Pfade (einer pro Zeile, Ordner mit / am Ende, z. B. /hook-meinplugin/)'), extra,
        h('p', { class: 'hint' }, `Abgewiesene Anfragen seit Start: ${sec.blocked || 0}` + (sec.lastBlocked ? ` · zuletzt ${sec.lastBlocked.ip} → ${sec.lastBlocked.path}` : '')),
        h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: () => api('PUT', '/api/security', { lockExternal: lock.checked, extraPaths: extra.value.split('\n').map((x) => x.trim()).filter(Boolean) }).then((r) => { S.security = r; toast('Gespeichert'); }).catch(fail) }, 'Speichern'))));
    }

    el.append(h('h2', {}, 'HomeLite unterstützen'), h('div', { class: 'card' },
      h('p', { class: 'hint', style: 'margin-top:0' }, 'HomeLite ist kostenlos und ohne Werbung. Wenn es dir gefällt, freut sich der Entwickler über eine kleine Spende – freiwillig.'),
      h('a', { class: 'btn primary', href: 'https://paypal.me/RolandFriedl', target: '_blank', rel: 'noopener noreferrer', style: 'display:inline-block;text-decoration:none' }, '☕ Spenden via PayPal')));

    el = grp('log', 'Protokoll', '📜');
    el.append(h('h2', {}, 'Protokoll'), h('div', { class: 'card' }, h('div', { class: 'loglist', id: 'loglist' }, [...logs].reverse().map(logLine))));

    // Menü: Desktop Seitenleiste, Handy Dropdown
    const items = groups.filter((g) => g.d.childElementCount > 0);
    let curG = localStorage.getItem('hl_setgrp') || items[0].id;
    if (!items.some((g) => g.id === curG)) curG = items[0].id;
    const show = (id) => {
      localStorage.setItem('hl_setgrp', id);
      for (const g of items) g.d.style.display = g.id === id ? '' : 'none';
      menu.querySelectorAll('button').forEach((b) => b.classList.toggle('act', b.dataset.g === id));
      dd.value = id;
    };
    const menu = h('div', { class: 'setmenu' }, items.map((g) => h('button', { class: 'fchip', 'data-g': g.id, onclick: () => { show(g.id); window.scrollTo(0, 0); } }, h('span', {}, g.icon), ' ', g.label)));
    const dd = sel(Object.fromEntries(items.map((g) => [g.id, `${g.icon} ${g.label}`])), curG, (v) => show(v), { class: 'setsel', 'aria-label': 'Bereich wählen' });
    root.append(h('h2', { class: 'page-title' }, '⚙️ Einstellungen'), h('div', { class: 'setlayout' }, h('div', { class: 'setnav' }, menu, dd), content));
    show(curG);
  },
};
