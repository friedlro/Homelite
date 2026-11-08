// ---------- Wo ist? (Karte, iCloud Find My, Handy-Reporter) und Apple TV ----------
const WM = { lat: 47.07, lon: 15.45, z: 13, fitted: false, trail: null, showTrail: true };
const WCOL = ['#4c8dff', '#ff6b6b', '#3ecf8e', '#f5a524', '#b57bff', '#2dd4d4', '#ff7ac6', '#a3b83a'];
const personColor = (id) => WCOL[Math.max(0, S.geofence.persons.findIndex((p) => p.id === id)) % WCOL.length];

function mapPx(lat, lon, z) {
  const n = 256 * 2 ** z;
  const lr = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n];
}
function mapLL(x, y, z) {
  const n = 256 * 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lat, lon];
}

function fitMap(w, hgt) {
  const pts = [];
  for (const p of S.presence) if (p.lat != null) pts.push([p.lat, p.lon]);
  for (const z of S.geofence.zones) if (z.lat != null && z.home) pts.push([z.lat, z.lon]);
  if (!pts.length) return;
  const la = pts.map((x) => x[0]); const lo = pts.map((x) => x[1]);
  const minLa = Math.min(...la); const maxLa = Math.max(...la); const minLo = Math.min(...lo); const maxLo = Math.max(...lo);
  WM.lat = (minLa + maxLa) / 2; WM.lon = (minLo + maxLo) / 2;
  let z = 17;
  for (; z > 3; z--) {
    const a = mapPx(maxLa, minLo, z); const b = mapPx(minLa, maxLo, z);
    if (Math.abs(b[0] - a[0]) < w - 90 && Math.abs(b[1] - a[1]) < hgt - 90) break;
  }
  WM.z = z;
}

function whereMap() {
  const box = h('div', { class: 'wmap' });
  const NS = 'http://www.w3.org/2000/svg';
  function draw() {
    const w = box.clientWidth || 360; const hg = box.clientHeight || 360;
    if (!WM.fitted) { fitMap(w, hg); WM.fitted = true; }
    const z = WM.z;
    const [cx, cy] = mapPx(WM.lat, WM.lon, z);
    const ox = cx - w / 2; const oy = cy - hg / 2;
    const kids = [];
    const n = 2 ** z;
    for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + hg) / 256); ty++) {
      for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + w) / 256); tx++) {
        if (ty < 0 || ty >= n) continue;
        const xx = ((tx % n) + n) % n;
        kids.push(h('img', { src: `https://tile.openstreetmap.org/${z}/${xx}/${ty}.png`, alt: '', draggable: 'false', referrerpolicy: 'strict-origin-when-cross-origin', onerror: (e) => { e.target.style.visibility = 'hidden'; }, style: `left:${Math.round(tx * 256 - ox)}px;top:${Math.round(ty * 256 - oy)}px` }));
      }
    }
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'wsvg');
    const add = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.appendChild(e); return e; };
    for (const zo of S.geofence.zones) {
      if (zo.lat == null) continue;
      const [px, py] = mapPx(zo.lat, zo.lon, z);
      const mpp = (156543.03392 * Math.cos((zo.lat * Math.PI) / 180)) / 2 ** z;
      add('circle', { cx: px - ox, cy: py - oy, r: Math.max(3, zo.radius / mpp), fill: zo.home ? 'rgba(62,207,142,.18)' : 'rgba(76,141,255,.15)', stroke: zo.home ? '#3ecf8e' : '#4c8dff', 'stroke-width': 2 });
    }
    if (WM.showTrail && WM.trail) {
      for (const p of S.presence) {
        const t = WM.trail[p.id];
        if (!t || t.length < 2) continue;
        add('polyline', { points: t.map((q) => { const [px, py] = mapPx(q[1], q[2], z); return `${(px - ox).toFixed(1)},${(py - oy).toFixed(1)}`; }).join(' '), fill: 'none', stroke: personColor(p.id), 'stroke-width': 3, 'stroke-opacity': 0.65, 'stroke-linejoin': 'round' });
      }
    }
    kids.push(svg);
    for (const zo of S.geofence.zones) {
      if (zo.lat == null) continue;
      const [px, py] = mapPx(zo.lat, zo.lon, z);
      kids.push(h('div', { class: 'wzone', style: `left:${px - ox}px;top:${py - oy}px` }, zo.name));
    }
    for (const p of S.presence) {
      if (p.lat == null) continue;
      const [px, py] = mapPx(p.lat, p.lon, z);
      kids.push(h('div', { class: 'wpin', title: p.name, style: `left:${px - ox}px;top:${py - oy}px;background:${personColor(p.id)}` }, (p.name || '?').slice(0, 1).toUpperCase()));
    }
    kids.push(h('div', { class: 'wctl' }, h('button', { onclick: () => { WM.z = Math.min(19, WM.z + 1); draw(); } }, '+'), h('button', { onclick: () => { WM.z = Math.max(3, WM.z - 1); draw(); } }, '−'), h('button', { title: 'Alle zeigen', onclick: () => { WM.fitted = false; draw(); } }, '⌖')));
    kids.push(h('span', { class: 'attr' }, '© OpenStreetMap'));
    box.replaceChildren(...kids);
  }
  let drag = null;
  box.addEventListener('pointerdown', (e) => { if (e.target.closest('.wctl')) return; drag = { x: e.clientX, y: e.clientY, cx: mapPx(WM.lat, WM.lon, WM.z) }; box.setPointerCapture(e.pointerId); });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [la, lo] = mapLL(drag.cx[0] - (e.clientX - drag.x), drag.cx[1] - (e.clientY - drag.y), WM.z);
    WM.lat = Math.max(-80, Math.min(80, la)); WM.lon = lo;
    drag.moved = true;
    cancelAnimationFrame(drag.raf);
    drag.raf = requestAnimationFrame(draw);
  });
  const end = () => { drag = null; };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('wheel', (e) => { e.preventDefault(); WM.z = Math.max(3, Math.min(19, WM.z + (e.deltaY < 0 ? 1 : -1))); draw(); }, { passive: false });
  requestAnimationFrame(draw);
  box.redraw = draw;
  return box;
}

function whereDevices(el) {
  const F = S.findmy || {};
  const box = h('div', { class: 'card' });
  el.append(h('h2', {}, 'iCloud „Wo ist?“ (Find My)'), box);
  const persons = S.geofence.persons;
  if (!F.enabled) {
    const apple = h('input', { value: F.apple || '', placeholder: 'Apple-ID (E-Mail)', autocomplete: 'off' });
    const pass = h('input', { type: 'password', placeholder: 'Apple-ID-Passwort', autocomplete: 'off' });
    const iv = h('input', { type: 'number', min: 30, value: F.interval || 120 });
    fill(box,
      h('p', { class: 'hint', style: 'margin-top:0' }, 'HomeLite fragt die Standorte deiner iPhones (und Familienmitglieder in der Familienfreigabe) direkt bei iCloud ab – ohne App, auch im Hintergrund. Das ist eine inoffizielle Schnittstelle von Apple; Anmeldung mit Apple-ID und Bestätigungscode (2-Faktor). Tipp: ein eigenes Apple-ID-Konto in der Familienfreigabe verwenden, damit das Hauptkonto nicht betroffen ist.'),
      h('div', { class: 'form' }, fld('Apple-ID', apple), fld('Passwort', pass), fld('Abfrage alle … Sekunden', iv)),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: async (ev) => {
        ev.target.disabled = true;
        try { await api('POST', '/api/findmy', { apple: apple.value.trim(), password: pass.value, interval: Number(iv.value) }); toast('Melde an …'); } catch (e) { fail(e); }
        ev.target.disabled = false;
      } }, 'Anmelden')));
    return;
  }
  const pill = { ok: ['ok', 'verbunden'], login: ['warn', 'meldet an …'], '2fa': ['warn', 'Code erforderlich'], '2sa': ['warn', 'Code erforderlich'], error: ['bad', 'Fehler'], off: ['', 'aus'] }[F.state] || ['', F.state];
  const head = h('div', { class: 'row sb' }, h('div', {}, h('b', {}, F.apple), ' ', h('span', { class: 'pill ' + pill[0] }, pill[1]), F.lastPoll ? h('span', { class: 'hint' }, ' · zuletzt ' + fmtTime(F.lastPoll)) : null),
    h('div', { class: 'row' }, F.state === 'ok' ? h('button', { class: 'sm', onclick: () => api('POST', '/api/findmy/refresh', {}).then(() => toast('Aktualisiert')).catch(fail) }, '↻ Jetzt abfragen') : null,
      h('button', { class: 'sm danger', onclick: () => { if (confirm('iCloud-Anmeldung entfernen?')) api('DELETE', '/api/findmy').then(reload).catch(fail); } }, 'Abmelden')));
  const body = [head];
  if (F.error) body.push(h('p', { class: 'hint', style: 'color:var(--bad)' }, F.error));
  if (F.state === 'error') body.push(h('button', { class: 'sm', onclick: () => api('POST', '/api/findmy', { apple: F.apple, interval: F.interval }).catch(fail) }, 'Erneut versuchen'));
  if (F.state === '2fa' || F.state === '2sa') {
    const code = h('input', { placeholder: '6-stelliger Code', inputmode: 'numeric', autocomplete: 'one-time-code' });
    body.push(h('p', { class: 'hint' }, F.state === '2fa' ? 'Apple hat einen Code auf deinen vertrauenswürdigen Geräten angezeigt (iPhone/Mac: „Anmeldung erlauben“). Hier eingeben:' : 'Apple hat einen Code per SMS/Gerät gesendet. Hier eingeben:'),
      h('div', { class: 'row' }, code, h('button', { class: 'primary', onclick: async (ev) => {
        ev.target.disabled = true;
        try { await api('POST', '/api/findmy/verify', { code: code.value.trim() }); toast('Bestätigt'); } catch (e) { fail(e); }
        ev.target.disabled = false;
      } }, 'Bestätigen')));
  }
  if (F.state === 'ok') {
    const map = Object.fromEntries((F.mapping || []).map((m) => [m.id, m.person]));
    const sels = new Map();
    body.push(h('p', { class: 'hint' }, 'Ordne die Geräte den Personen zu, deren Standort für Geofence/Anwesenheit gelten soll (z. B. das iPhone von Roland → Roland). Mehrere Geräte pro Person: das zuletzt aktualisierte gewinnt.'));
    body.push(h('div', { style: 'overflow-x:auto' }, h('table', {}, h('thead', {}, h('tr', {}, ['Gerät', 'Standort', 'Akku', 'Person'].map((t) => h('th', {}, t)))),
      h('tbody', {}, (F.devices || []).map((d) => {
        const s = sel({ '': '– nicht verwenden –', ...Object.fromEntries(persons.map((p) => [p.name, p.name])) }, map[d.id] || '', () => {});
        sels.set(d.id, s);
        return h('tr', {}, h('td', {}, d.name, h('div', { class: 'hint' }, d.model)), h('td', {}, d.lat == null ? h('span', { class: 'hint' }, 'unbekannt') : `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`, d.ts ? h('div', { class: 'hint' }, fmtTime(d.ts)) : null), h('td', {}, d.battery == null ? '–' : d.battery + ' %'), h('td', {}, s));
      })))));
    body.push(h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: () => {
      const devices = (F.devices || []).filter((d) => sels.get(d.id).value).map((d) => ({ id: d.id, name: d.name, person: sels.get(d.id).value }));
      api('PUT', '/api/findmy/mapping', { devices }).then(() => toast('Gespeichert')).catch(fail);
    } }, 'Zuordnung speichern'), persons.length ? null : h('span', { class: 'hint' }, 'Lege zuerst Personen unter „Anwesenheit → Personen & Zonen“ an.')));
  }
  fill(box, body);
}

function whereReporter(el) {
  const G = S.geofence;
  const stored = (localStorage.getItem('hl_base') || location.origin).replace(/\/+$/, '');
  const pick = sel(Object.fromEntries((G.persons.length ? G.persons.map((p) => [p.name, p.name]) : [['Roland', 'Roland']])), localStorage.getItem('hl_rep') || (G.persons[0] && G.persons[0].name) || 'Roland', (v) => { localStorage.setItem('hl_rep', v); renderPage(); });
  const url = `${stored}/where.html#key=${G.key}&person=${encodeURIComponent(pick.value)}`;
  const q = qrcode(0, 'M');
  q.addData(url); q.make();
  el.append(h('h2', {}, 'Eigene „Wo ist?“-Seite fürs Handy'), h('div', { class: 'card' },
    h('p', { class: 'hint', style: 'margin-top:0' }, 'Öffne diese Adresse auf dem iPhone in Safari und wähle „Zum Home-Bildschirm“. Die Seite sendet deinen Standort an HomeLite, solange sie geöffnet ist (iOS erlaubt Webseiten keinen Hintergrund-Standort – für dauerhaftes Tracking nutze iCloud oben, OwnTracks oder die Kurzbefehle bei „Anwesenheit“). Das iPhone braucht eine HTTPS-Adresse zu deinem Server (z. B. Tailscale Serve/Funnel), sonst gibt Safari den Standort nicht frei.'),
    h('div', { class: 'form' }, fld('Person', pick)),
    h('div', { class: 'row', style: 'align-items:flex-start;margin-top:10px;gap:14px' }, h('img', { src: q.createDataURL(4, 6), alt: 'QR-Code', width: 140, height: 140, style: 'background:#fff;border-radius:10px;padding:4px' }),
      h('div', { style: 'min-width:0;flex:1' }, h('div', { class: 'row sb' }, h('b', {}, 'Adresse'), copyBtn(url)), h('code', { style: 'word-break:break-all' }, url)))));
}

PAGES.where = {
  label: 'Wo ist?', short: 'Karte', icon: '🗺️', live: true,
  render(el) {
    el.append(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, '🗺️ Wo ist?'), h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: WM.showTrail, onchange: (e) => { WM.showTrail = e.target.checked; renderPage(); } }), 'Verlauf')));
    const map = whereMap();
    el.append(h('div', { class: 'card mapcard', style: 'margin-top:10px' }, map));
    if (!WM.trail) api('GET', '/api/trail').then((t) => { WM.trail = t || {}; if (map.isConnected) map.redraw(); }).catch(() => { WM.trail = {}; });
    else api('GET', '/api/trail').then((t) => { WM.trail = t || {}; if (map.isConnected) map.redraw(); }).catch(() => {});
    if (!S.presence.length) el.append(h('div', { class: 'empty', style: 'margin-top:12px' }, 'Noch keine Personen. Unten iCloud verbinden oder die Handy-Seite öffnen – Personen entstehen automatisch.'));
    else {
      el.append(h('div', { class: 'grid wide', style: 'margin-top:12px' }, S.presence.map((p) => h('div', { class: 'card' },
        h('div', { class: 'row sb' }, h('h3', { style: 'margin:0' }, h('span', { class: 'dot', style: `background:${personColor(p.id)}` }), ' ', p.name), h('span', { class: 'pill ' + (p.home ? 'ok' : '') }, p.known ? (p.home ? '🏠 zuhause' : '🚶 unterwegs') : 'unbekannt')),
        h('div', { class: 'hint', style: 'margin:6px 0' }, p.zones.length ? 'In: ' + p.zones.join(', ') : 'Keine Zone', ' · ', fmtTime(p.locTs || p.ts)),
        h('div', { class: 'hint' }, p.lat == null ? 'Noch keine Position' : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`, p.acc != null ? ` · ±${p.acc} m` : '', p.battery != null ? ` · 🔋 ${p.battery} %` : '', p.src ? ` · ${p.src}` : ''),
        p.lat != null ? h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'sm', onclick: () => { WM.lat = p.lat; WM.lon = p.lon; WM.z = 16; WM.fitted = true; renderPage(); window.scrollTo(0, 0); } }, 'Auf Karte zeigen')) : null))));
    }
    whereDevices(el);
    whereReporter(el);
  },
};

// ---------- Apple TV (Status) ----------
function appletvPair(dev, protocol) {
  const pin = h('input', { placeholder: 'PIN vom Fernseher', inputmode: 'numeric', autocomplete: 'off' });
  const box = h('div', {}, h('p', {}, `Apple TV „${dev.name}“ zeigt jetzt einen ${protocol === 'companion' ? '4-stelligen' : ''} PIN auf dem Bildschirm. Bitte hier eingeben:`), fld('PIN', pin));
  api('POST', '/api/appletv/pair/begin', { id: dev.id, protocol, address: dev.address })
    .then((r) => { if (!r.pin) box.append(h('p', { class: 'hint' }, 'Das Gerät zeigt keinen PIN – einfach „Koppeln“ drücken.')); })
    .catch((e) => { fail(e); });
  modal(`Apple TV koppeln (${protocol === 'companion' ? 'Companion' : 'AirPlay'})`, box, [{ label: 'Abbrechen' }, { label: 'Koppeln', primary: true, onClick: async () => {
    await api('POST', '/api/appletv/pair/pin', { pin: pin.value.trim(), name: dev.name });
    toast('Gekoppelt');
    await reload();
  } }]);
}

function appletvSection(el) {
  const A = S.appletv || { devices: [], scanned: [] };
  const box = h('div', { class: 'card' });
  el.append(h('h2', {}, 'Apple TV (Status)'), box);
  const scanBtn = h('button', { onclick: async (ev) => {
    ev.target.disabled = true; ev.target.textContent = 'Suche …';
    try { await api('POST', '/api/appletv/scan', {}); await reload(); } catch (e) { fail(e); }
    ev.target.disabled = false; ev.target.textContent = 'Apple TV suchen';
  } }, 'Apple TV suchen');
  const paired = new Set(A.devices.map((d) => d.id));
  fill(box,
    h('p', { class: 'hint', style: 'margin-top:0' }, 'Liest den Status deines Apple TV (an/Standby, laufende App, Titel, Wiedergabe) als Sensoren für Automationen. Benötigt das Python-Paket pyatv auf dem Server (pip install pyatv "srptools<2"). Koppeln: erst „Companion“ (Standby/App), dann „AirPlay“ (Titel/Wiedergabe) – jeweils PIN vom Fernseher eingeben.'),
    A.error ? h('p', { class: 'hint', style: 'color:var(--bad)' }, A.error) : null,
    A.devices.map((d) => h('div', { class: 'ed' },
      h('div', { class: 'row sb' }, h('b', {}, d.name), h('span', { class: 'pill ' + (d.online ? 'ok' : 'bad') }, d.online ? (d.power === 'off' ? 'Standby' : d.power === 'on' ? 'an' : 'online') : 'offline')),
      h('div', { class: 'hint', style: 'margin:4px 0' }, `${d.address || ''} · gekoppelt: ${d.paired.join(', ') || '–'}`, (d.online && d.power !== 'off' ? ` · ${d.app || '–'}${d.title ? ' · ' + d.title : ''}${d.state ? ' (' + d.state + ')' : ''}` : '') + ` · Meldung des Geräts: ${({ on: 'an', off: 'Standby', unknown: 'unbekannt' })[d.powerRaw] || d.powerRaw}`),
      h('div', { class: 'row' },
        ['companion', 'airplay'].map((pr) => h('button', { class: 'sm', onclick: () => appletvPair(d, pr) }, (d.paired.includes(pr) ? '↻ ' : '') + (pr === 'companion' ? 'Companion' : 'AirPlay') + ' koppeln')),
        h('button', { class: 'sm primary', onclick: () => api('POST', '/api/appletv/link', { id: d.id }).then((r) => { toast(r.created ? `${r.created} Sensoren angelegt` : 'Sensoren sind schon angelegt'); return reload(); }).catch(fail) }, d.linked ? `Sensoren ergänzen (${d.linked})` : 'Sensoren anlegen'),
        h('button', { class: 'sm danger', onclick: () => { if (confirm(`„${d.name}“ und seine Sensoren entfernen?`)) api('DELETE', '/api/appletv/' + encodeURIComponent(d.id)).then(reload).catch(fail); } }, 'Entfernen')))),
    h('div', { class: 'row', style: 'margin-top:10px' }, scanBtn),
    A.scanned.filter((d) => !paired.has(d.id)).map((d) => h('div', { class: 'row sb', style: 'padding:6px 0' }, h('span', {}, `${d.name} · ${d.address}`, h('span', { class: 'hint' }, ` (${d.model || d.protocols.join('/')})`)),
      h('button', { class: 'sm', onclick: () => appletvPair(d, 'companion') }, 'Koppeln'))));
}

// ---------- Erweiterungen ein-/ausschalten ----------
function modulesSection(el) {
  const info = S.moduleInfo || {};
  el.append(h('h2', {}, 'Erweiterungen'), h('div', { class: 'card' },
    h('p', { class: 'hint', style: 'margin-top:0' }, 'Schalte nur ein, was du brauchst. Ausgeschaltete Erweiterungen verschwinden aus Menü, Dashboard und Einstellungen und laufen nicht im Hintergrund. Deine Einstellungen und Geräte bleiben erhalten.'),
    Object.entries(info).map(([id, m]) => h('div', { class: 'row sb', style: 'padding:8px 0;border-top:1px solid var(--line, rgba(128,128,128,.2))' },
      h('div', {}, h('b', {}, m.label), h('div', { class: 'hint' }, m.desc)),
      toggle(modOn(id), async (v) => { try { await api('PUT', '/api/modules', { id, on: v }); await reload(); } catch (e) { fail(e); } })))));
}

// ---------- Shelly-Firmware ----------
const FW_STATE = {
  unknown: ['', 'nicht geprüft'], checking: ['warn', 'prüft …'], current: ['ok', '✓ aktuell'], available: ['warn', '⬆ Update verfügbar'],
  updating: ['warn', '⏳ Update läuft'], ok: ['ok', '✓ Update erfolgreich'], failed: ['bad', '✕ Update fehlgeschlagen'], offline: ['bad', 'nicht erreichbar'],
};
function shellyFwDraw() {
  const box = document.getElementById('shellyfw');
  if (!box) return;
  const L = S.shellyfw || [];
  const avail = L.filter((x) => x.state === 'available').length;
  const busy = L.some((x) => x.state === 'checking' || x.state === 'updating');
  box.replaceChildren(
    h('div', { class: 'row sb' }, h('h2', { style: 'margin:0' }, 'Shelly-Firmware'),
      h('div', { class: 'row' },
        h('button', { disabled: busy, onclick: () => api('POST', '/api/shelly/fw/check', {}).catch(fail) }, '↻ Auf Updates prüfen'),
        avail > 1 ? h('button', { class: 'primary', disabled: busy, onclick: () => { if (confirm(`${avail} Shelly-Geräte aktualisieren? Sie starten dabei kurz neu.`)) api('POST', '/api/shelly/fw/update', { all: true }).catch(fail); } }, `Alle aktualisieren (${avail})`) : null)),
    h('div', { class: 'card', style: 'margin-top:10px;overflow-x:auto' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Gerät', 'IP', 'Version', 'Status', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, L.map((x) => {
        const [cls, label] = FW_STATE[x.state] || ['', x.state];
        return h('tr', {},
          h('td', {}, x.names.join(', '), x.model ? h('div', { class: 'hint' }, x.model) : null),
          h('td', {}, h('a', { href: 'http://' + x.ip, target: '_blank', rel: 'noopener noreferrer' }, x.ip)),
          h('td', {}, x.ver || '–', x.state === 'available' && x.newVer ? h('div', { class: 'hint' }, '→ ' + x.newVer) : null),
          h('td', {}, h('span', { class: 'pill ' + cls }, label), x.msg ? h('div', { class: 'hint' }, x.msg) : null, x.ts && x.state !== 'unknown' ? h('div', { class: 'hint' }, fmtTime(x.ts)) : null),
          h('td', {}, x.state === 'available' ? h('button', { class: 'sm primary', onclick: () => { if (confirm(`„${x.names[0]}“ (${x.ip}) jetzt aktualisieren? Das Gerät startet dabei kurz neu.`)) api('POST', '/api/shelly/fw/update', { ip: x.ip }).catch(fail); } }, 'Update') : null));
      })))));
}
function shellyFwSection(el) {
  if (!(S.shellyfw || []).length) return;
  el.append(h('div', { id: 'shellyfw', style: 'margin-top:24px' }));
  shellyFwDraw();
}

// ---------- System (Neustart) ----------
async function systemSection(el) {
  const box = h('div', { class: 'card' });
  el.append(h('h2', {}, 'System'), box);
  let info = {};
  try { info = await api('GET', '/api/system'); } catch { /* ignorieren */ }
  const d = (s) => { const days = Math.floor(s / 86400); const hh = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); return (days ? days + ' d ' : '') + hh + ' h ' + m + ' min'; };
  fill(box,
    h('div', { class: 'kv' }, h('span', {}, 'Server'), h('span', {}, info.host || '–'), h('span', {}, 'Laufzeit Server'), h('span', {}, info.uptime ? d(info.uptime) : '–'), h('span', {}, 'Laufzeit HomeLite'), h('span', {}, info.proc ? d(info.proc) : '–'), h('span', {}, 'Node.js'), h('span', {}, info.node || '–')),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { onclick: async () => { if (!confirm('HomeLite jetzt neu starten?')) return; try { waitForRestart(await api('POST', '/api/system/restart', {})); } catch (e) { fail(e); } } }, '↻ HomeLite neu starten'),
      h('button', { class: 'danger', onclick: () => {
        const pw = h('input', { type: 'password', placeholder: 'HomeLite-Passwort', autocomplete: 'current-password' });
        modal('Server neu starten', h('div', {}, h('p', { style: 'margin-top:0' }, `Der komplette Server „${info.host || ''}“ wird neu gestartet. HomeLite und alle Dienste sind danach einige Minuten nicht erreichbar.`), fld('Zur Bestätigung Passwort eingeben', pw)),
          [{ label: 'Abbrechen' }, { label: 'Server neu starten', danger: true, onClick: async () => { const r = await api('POST', '/api/system/reboot', { password: pw.value }); setTimeout(() => waitForRestart(r), 200); } }]);
      } }, '⏻ Server neu starten')),
    info.systemd === false ? h('p', { class: 'hint' }, 'HomeLite läuft nicht unter systemd – „HomeLite neu starten“ ist dann nicht möglich; bitte manuell neu starten.') : null,
    info.root === false ? h('p', { class: 'hint' }, 'HomeLite läuft ohne Root-Rechte. Für „Server neu starten“ ist ein sudoers-Eintrag nötig (siehe README).') : null);
}

// ---------- KI-Zugriff (MCP) ----------
function mcpSection(el) {
  const M = S.mcp || {};
  const base = (localStorage.getItem('hl_base') || location.origin).replace(/\/+$/, '');
  const url = `${base}/mcp/${M.token}`;
  const baseIn = h('input', { value: base, onchange: (e) => { localStorage.setItem('hl_base', e.target.value.trim()); renderPage(); } });
  const row = (label, text) => h('div', { style: 'margin:10px 0' }, h('div', { class: 'row sb' }, h('b', {}, label), copyBtn(text)), h('code', { style: 'word-break:break-all' }, text));
  el.append(h('h2', {}, 'KI-Zugriff (MCP)'), h('div', { class: 'card' },
    h('p', { class: 'hint', style: 'margin-top:0' }, 'Mit dieser Adresse kann Claude HomeLite abfragen (Geräte, Energie, Heizung, Auto, Anwesenheit, Protokoll) und – wenn erlaubt – steuern. Die Adresse enthält ein geheimes Token: wie ein Passwort behandeln. Von außerhalb muss sie per HTTPS erreichbar sein (z. B. Tailscale Funnel oder Cloudflare Tunnel; am besten nur den Pfad /mcp freigeben).'),
    fld('Basis-Adresse deines Servers (so, wie Claude ihn erreicht, mit https://)', baseIn),
    row('claude.ai → Einstellungen → Konnektoren → „Benutzerdefinierten Konnektor hinzufügen“', url),
    row('Claude Code (Terminal)', `claude mcp add --transport http homelite ${url}`),
    h('div', { class: 'row', style: 'margin-top:8px;gap:16px' },
      chk('Steuern erlauben (Geräte schalten, Szenen ausführen)', !!M.allowControl, (v) => api('PUT', '/api/mcp', { allowControl: v }).then(reload).catch(fail)),
      chk('Auch Schlösser aufsperren', !!M.allowUnlock, (v) => api('PUT', '/api/mcp', { allowUnlock: v }).then(reload).catch(fail)),
      chk('Automationen anlegen/ändern erlauben', !!M.allowAutomations, (v) => api('PUT', '/api/mcp', { allowAutomations: v }).then(reload).catch(fail))),
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'sm danger', onclick: () => { if (confirm('Neues Token erzeugen? Die bisherige Adresse funktioniert dann nicht mehr.')) api('PUT', '/api/mcp', { regenerate: true }).then(reload).catch(fail); } }, 'Neues Token erzeugen'))));
}

// ---------- Eingebauter MQTT-Broker ----------
function brokerDraw() {
  const box = document.getElementById('brokerbox');
  if (!box || modalOpen() || (document.activeElement && box.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName))) return !!box;
  const B = S.broker || {};
  const mq = S.mqtt || {};
  const host = location.hostname;
  const newName = h('input', { placeholder: 'Benutzername', autocomplete: 'off' });
  const newPass = h('input', { type: 'password', placeholder: 'Passwort (min. 6 Zeichen)', autocomplete: 'new-password' });
  const port = h('input', { type: 'number', min: 1, max: 65535, value: B.port || 1883 });
  const self = mq.url === `mqtt://127.0.0.1:${B.port}`;
  fill(box,
    h('div', { class: 'row sb' }, h('span', { class: 'pill ' + (B.running ? 'ok' : 'bad') }, B.running ? `läuft · Port ${B.port}` : (B.error || 'gestoppt')),
      h('span', { class: 'hint' }, `${(B.clients || []).length} Clients · ${B.retained || 0} gespeicherte Werte · ${B.msgIn || 0} empfangen / ${B.msgOut || 0} gesendet`)),
    h('p', { class: 'hint' }, `Geräte (Zigbee2MQTT, Shelly, Tasmota …) verbinden sich mit „${host}“, Port ${B.port || 1883} und einem der Benutzer unten. Ändere dazu im jeweiligen Gerät/Add-on die MQTT-Server-Adresse.`),
    h('div', { class: 'row', style: 'margin:8px 0' }, self ? h('span', { class: 'pill ok' }, '✓ HomeLite nutzt diesen Broker') : h('button', { class: 'primary', onclick: () => { if (confirm('HomeLite-eigene MQTT-Verbindung (oben) auf diesen eingebauten Broker umstellen? Die bisherigen Broker-Daten werden ersetzt.')) api('POST', '/api/broker/connect-self', {}).then(() => { toast('Verbunden'); return reload(); }).catch(fail); } }, 'HomeLite mit diesem Broker verbinden')),
    h('h3', { style: 'margin:14px 0 6px' }, 'Benutzer'),
    (B.users || []).length ? (B.users || []).map((u) => h('div', { class: 'row sb', style: 'padding:3px 0' }, h('span', {}, u, u === B.internal ? h('span', { class: 'hint' }, ' (HomeLite intern)') : null), h('button', { class: 'sm danger', onclick: () => { if (confirm(`Benutzer „${u}“ löschen?`)) api('DELETE', '/api/broker/user/' + encodeURIComponent(u)).then(reload).catch(fail); } }, '✕'))) : h('div', { class: 'hint' }, 'Noch keine Benutzer – ohne Benutzer kann sich niemand verbinden (außer „anonym“ ist erlaubt).'),
    h('div', { class: 'row', style: 'margin-top:8px' }, newName, newPass, h('button', { class: 'sm', onclick: () => api('POST', '/api/broker/user', { name: newName.value.trim(), pass: newPass.value }).then(() => { toast('Benutzer gespeichert'); return reload(); }).catch(fail) }, '+ Benutzer')),
    h('div', { class: 'row', style: 'margin-top:12px;gap:16px' }, fld('Port', port), h('button', { class: 'sm', onclick: () => api('PUT', '/api/broker', { port: Number(port.value) }).then(() => toast('Port gespeichert')).catch(fail) }, 'Port übernehmen'),
      chk('Anonyme Verbindungen erlauben (unsicher)', !!B.allowAnonymous, (v) => { if (v && !confirm('Ohne Anmeldung kann jedes Gerät im Netzwerk mitlesen und schalten. Wirklich erlauben?')) { renderPage(); return; } api('PUT', '/api/broker', { allowAnonymous: v }).then(reload).catch(fail); })),
    (B.clients || []).length ? h('div', { style: 'margin-top:12px;overflow-x:auto' }, h('table', {}, h('thead', {}, h('tr', {}, ['Client', 'Adresse', 'Benutzer', 'Abos', 'seit'].map((t) => h('th', {}, t)))),
      h('tbody', {}, B.clients.map((c) => h('tr', {}, h('td', {}, c.id), h('td', {}, c.ip), h('td', {}, c.user || 'anonym'), h('td', {}, c.subs), h('td', {}, fmtTime(c.since))))))) : null);
  return true;
}
function brokerSection(el) {
  el.append(h('h2', {}, 'Eingebauter MQTT-Broker'), h('div', { class: 'card', id: 'brokerbox' }));
  brokerDraw();
}

// ---------- Verlauf: wann und wie wurden Schalter betätigt ----------
const HIST = { items: [], total: 0, f: { q: '', k: '', dev: '' }, more: false, loading: false };
const HIST_SRC = { '': 'Alle Quellen', ui: 'App (HomeLite)', auto: 'Automation / Szene', mcp: 'KI (Claude)', heat: 'Heizung', ext: 'Am Gerät / extern', sys: 'System' };
const HIST_ACT = {
  on: 'ein', off: 'aus', open: 'offen', closed: 'zu', opening: 'öffnet', closing: 'schließt', stopped: 'gestoppt',
  locked: 'verriegelt', unlocked: 'entriegelt', locking: 'verriegelt …', unlocking: 'entriegelt …',
};
const HIST_ICON = { ui: '👆', auto: '⚙️', mcp: '🤖', heat: '🌡', ext: '🔘', sys: '🖥' };

function histAction(e) {
  if (e.a === 'brightness') return `Helligkeit ${e.v} %`;
  if (e.a === 'press') return `Taste „${e.v}“`;
  return HIST_ACT[e.a] || e.a;
}
function histSource(e) {
  switch (e.k) {
    case 'ui': return 'App' + (e.w ? ' · ' + e.w : '');
    case 'auto': return 'Automation: ' + (e.w || '?') + (e.x === 'manuell' ? ' (manuell gestartet)' : e.x && e.x !== e.w ? ` (ausgelöst durch ${e.x})` : '');
    case 'mcp': return 'KI (Claude)';
    case 'heat': return 'Heizung' + (e.w ? ' · ' + e.w : '');
    case 'sys': return 'System';
    default: return e.ty === 'event' ? 'Fernbedienung / Taster' : 'Am Gerät / extern';
  }
}
function histRow(e) {
  const d = new Date(e.ts);
  const on = e.a === 'on' || e.a === 'open' || e.a === 'opening' || e.a === 'unlocked';
  return h('div', { class: 'hrow' },
    h('div', { class: 'ht' }, d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
    h('div', { class: 'hi', title: HIST_SRC[e.k] || '' }, HIST_ICON[e.k] || '•'),
    h('div', { class: 'hm' },
      h('div', {}, h('b', {}, e.n), ' ', h('span', { class: 'pill ' + (on ? 'on' : '') }, histAction(e)), e.r ? h('span', { class: 'hint' }, '  ' + e.r) : null),
      h('div', { class: 'hint' }, histSource(e))));
}
function histDraw() {
  const box = $('#histlist');
  if (!box) return;
  const kids = [];
  let day = '';
  for (const e of HIST.items) {
    const d = new Date(e.ts);
    const key = d.toDateString();
    if (key !== day) {
      day = key;
      const today = new Date().toDateString();
      const yest = new Date(Date.now() - 86400e3).toDateString();
      kids.push(h('div', { class: 'hday' }, key === today ? 'Heute' : key === yest ? 'Gestern' : d.toLocaleDateString('de-AT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })));
    }
    kids.push(histRow(e));
  }
  if (!kids.length) kids.push(h('div', { class: 'empty' }, HIST.loading ? 'Lade …' : 'Noch keine Betätigungen aufgezeichnet.'));
  else if (HIST.more) kids.push(h('div', { class: 'row', style: 'justify-content:center;margin:12px 0' }, h('button', { onclick: () => histLoad(true) }, 'Ältere laden')));
  fill(box, kids);
}
function histMatch(e) {
  const f = HIST.f;
  if (f.k && e.k !== f.k) return false;
  if (f.dev && e.id !== f.dev) return false;
  if (f.q && !`${e.n} ${e.r} ${e.w || ''} ${e.x || ''}`.toLowerCase().includes(f.q.toLowerCase())) return false;
  return true;
}
async function histLoad(older) {
  const f = HIST.f;
  const p = new URLSearchParams({ limit: '200' });
  if (f.q) p.set('q', f.q);
  if (f.k) p.set('k', f.k);
  if (f.dev) p.set('dev', f.dev);
  if (older && HIST.items.length) p.set('before', String(HIST.items[HIST.items.length - 1].ts));
  HIST.loading = true;
  try {
    const r = await api('GET', '/api/history?' + p);
    HIST.items = older ? HIST.items.concat(r.items) : r.items;
    HIST.more = r.items.length >= 200;
    HIST.total = r.total;
  } catch (e) { fail(e); }
  HIST.loading = false;
  histDraw();
}
// Live: neuer Eintrag über die Server-Verbindung
function histPush(d) {
  if (d.replace) { const i = HIST.items.findIndex((x) => x.id === d.e.id && x.a === 'brightness'); if (i >= 0 && histMatch(d.e)) { HIST.items[i] = d.e; if (page === 'hist') histDraw(); return; } }
  if (!histMatch(d.e)) return;
  HIST.items.unshift(d.e);
  HIST.total++;
  if (HIST.items.length > 1000) HIST.items.length = 1000;
  if (page === 'hist') histDraw();
}

PAGES.hist = {
  label: 'Verlauf', short: 'Verlauf', icon: '🕘',
  render(el) {
    let t = null;
    const q = h('input', { type: 'search', placeholder: 'Suchen (Gerät, Raum, Automation)', value: HIST.f.q, oninput: (e) => { HIST.f.q = e.target.value; clearTimeout(t); t = setTimeout(() => histLoad(false), 300); } });
    const devs = { '': 'Alle Geräte' };
    for (const d of [...S.devices].filter((x) => ['switch', 'light', 'cover', 'lock', 'event'].includes(x.type)).sort((a, b) => a.name.localeCompare(b.name, 'de'))) devs[d.id] = d.name + (d.room ? ` (${d.room})` : '');
    el.append(
      h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, '🕘 Verlauf'),
        h('div', { class: 'row' },
          h('button', { onclick: () => histLoad(false) }, '↻ Aktualisieren'),
          h('button', { class: 'danger', onclick: () => { if (confirm('Gesamten Verlauf löschen?')) api('DELETE', '/api/history').then(() => { HIST.items = []; HIST.more = false; histDraw(); toast('Verlauf gelöscht'); }).catch(fail); } }, 'Löschen'))),
      h('div', { class: 'hfilter' }, q,
        sel(HIST_SRC, HIST.f.k, (v) => { HIST.f.k = v; histLoad(false); }),
        sel(devs, HIST.f.dev, (v) => { HIST.f.dev = v; histLoad(false); })),
      h('div', { class: 'card hcard', id: 'histlist' }),
      h('p', { class: 'hint' }, 'Aufgezeichnet werden Schalter, Lichter, Rollos, Schlösser und Taster der letzten 120 Tage (maximal 5000 Einträge). „Am Gerät / extern“ heißt: Der Zustand hat sich geändert, ohne dass HomeLite etwas gesendet hat – z. B. Wandschalter, Taster am Gerät oder Hersteller-App.'));
    histDraw();
    histLoad(false);
  },
};

// ---------- Shelly CoIoT (Sofort-Meldungen der Gen1-Geräte) ----------
function coiotAgo(ts) {
  if (!ts) return 'noch nie';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 90 ? `vor ${s} s` : s < 5400 ? `vor ${Math.round(s / 60)} Min.` : fmtTime(ts);
}
function coiotDraw() {
  const box = document.getElementById('coiot');
  if (!box) return;
  const C = S.coiot;
  const gen1 = C.devices.filter((x) => x.gen !== 2);
  const todo = gen1.filter((x) => !(x.cfg && x.cfg.enabled && x.cfg.peer && !/mcast/i.test(x.cfg.peer)));
  const host = h('input', { placeholder: 'automatisch', value: C.host, style: 'max-width:200px' });
  fill(box,
    h('div', { class: 'row sb' }, h('h2', { style: 'margin:0' }, 'Shelly CoIoT (Sofort-Meldungen)'),
      h('div', { class: 'row' }, h('span', { class: 'chip ' + (C.listening ? 'ok' : C.enabled ? 'bad' : '') }, C.listening ? `lauscht auf UDP ${C.port}` : C.enabled ? 'nicht aktiv' : 'aus'),
        toggle(C.enabled, (v) => api('PUT', '/api/coiot', { enabled: v }).catch(fail)))),
    C.error ? h('div', { class: 'card', style: 'border-color:var(--bad);margin-top:10px' }, h('b', { style: 'color:var(--bad)' }, 'Fehler: '), C.error) : null,
    h('p', { class: 'hint' }, 'Shelly Gen1 melden Schaltvorgänge (auch am Wandschalter) sofort an HomeLite, statt dass HomeLite nur alle 10 Sekunden nachfragt. Dazu muss im Shelly der „CoIoT-Peer“ auf diesen Rechner zeigen (Port 5683). Der Knopf stellt das für dich ein und startet das Gerät neu. Gen2/Gen3-Geräte brauchen das nicht.'),
    gen1.length ? h('div', { class: 'card', style: 'overflow-x:auto' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Gerät', 'IP', 'Peer im Shelly', 'Letzte Meldung', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, gen1.map((x) => {
        const c = x.cfg;
        const okPeer = c && c.enabled && c.peer && !/mcast/i.test(c.peer);
        return h('tr', {},
          h('td', {}, x.names.join(', ')),
          h('td', {}, h('a', { href: 'http://' + x.ip, target: '_blank', rel: 'noopener noreferrer' }, x.ip)),
          h('td', {}, !c ? h('span', { class: 'hint' }, 'nicht geprüft') : c.ok === false ? h('span', { class: 'pill bad' }, 'nicht erreichbar') : okPeer ? h('span', { class: 'pill ok' }, c.peer) : h('span', { class: 'pill warn' }, c.enabled ? (c.peer || 'Multicast') : 'CoIoT aus')),
          h('td', {}, x.last ? coiotAgo(x.last) : h('span', { class: 'hint' }, 'noch nie'), x.count ? h('div', { class: 'hint' }, x.count + (x.count === 1 ? ' Meldung' : ' Meldungen')) : null),
          h('td', {}, h('button', { class: 'sm', onclick: () => { if (confirm(`CoIoT-Peer von „${x.names[0]}“ auf HomeLite stellen? Das Gerät startet dabei kurz neu.`)) api('POST', '/api/coiot/setup', { ip: x.ip }).then((r) => toast(r.errors.length ? r.errors.join(' · ') : 'Eingestellt – Gerät startet neu')).catch(fail); } }, okPeer ? 'Neu setzen' : 'Einrichten')));
      })))) : h('div', { class: 'empty' }, 'Keine Shelly-Gen1-Geräte gefunden.'),
    h('div', { class: 'row', style: 'margin-top:10px;flex-wrap:wrap' },
      h('button', { onclick: () => api('POST', '/api/coiot/read', {}).catch(fail) }, '↻ Einstellungen der Shellys lesen'),
      todo.length ? h('button', { class: 'primary', onclick: () => { if (confirm(`${todo.length} Shelly-Gerät(e) auf HomeLite einstellen? Sie starten dabei kurz neu.`)) api('POST', '/api/coiot/setup', { all: true }).then((r) => toast(`${r.done} eingestellt${r.errors.length ? ' · ' + r.errors.join(' · ') : ''}`)).catch(fail); } }, `Alle einrichten (${todo.length})`) : null,
      h('label', { class: 'hint row', style: 'gap:6px' }, 'HomeLite-Adresse', host,
        h('button', { class: 'sm', onclick: () => api('PUT', '/api/coiot', { host: host.value.trim() }).then(() => toast('Gespeichert')).catch(fail) }, 'Speichern'))));
}
function coiotSection(el) {
  if (!S.coiot || !S.coiot.devices.length) return;
  el.append(h('div', { id: 'coiot', style: 'margin-top:24px' }));
  coiotDraw();
  api('POST', '/api/coiot/read', {}).catch(() => {});
}

// ---------- Plugins (ohne Systemupdate nachinstallierbar) ----------
function b64(buf) {
  let s = '';
  const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
}
async function pluginInstalled(r) {
  await reload();
  if (!r.enabled && confirm(`Plugin „${r.name}“ ${r.version} ${r.updated ? 'aktualisiert' : 'installiert'}. Jetzt aktivieren?`)) {
    await api('PUT', `/api/plugins/${r.id}`, { enabled: true });
    await reload();
  } else toast(`Plugin „${r.name}“ ${r.version} ${r.updated ? 'aktualisiert' : 'installiert'}`);
  if (r.updated && (S.plugins.find((p) => p.id === r.id) || {}).client) toast('Seite neu laden, damit die neue Oberfläche des Plugins erscheint');
}
const PLUGIN_WARN = 'Plugins laufen mit allen Rechten im HomeLite-Prozess (Geräte, Zugangsdaten, Netzwerk). Nur Pakete aus vertrauenswürdiger Quelle installieren. Fortfahren?';
function pluginConfigDialog(p) {
  const vals = {};
  const rows = p.config.map((f) => {
    vals[f.key] = f.value;
    let input;
    if (f.type === 'bool') return chk(f.label, !!f.value, (v) => { vals[f.key] = v; });
    if (f.type === 'textarea') input = h('textarea', { rows: 5, value: f.value ?? '', placeholder: f.placeholder || '', oninput: (e) => { vals[f.key] = e.target.value; } });
    else if (f.type === 'select') input = sel(f.options || {}, f.value, (v) => { vals[f.key] = v; });
    else if (f.type === 'number') input = h('input', { type: 'number', step: 'any', value: f.value ?? '', oninput: (e) => { vals[f.key] = e.target.value; } });
    else if (f.type === 'password') { vals[f.key] = ''; input = h('input', { type: 'password', autocomplete: 'new-password', placeholder: f.hasValue ? '(gespeichert – leer lassen = unverändert)' : f.placeholder || '', oninput: (e) => { vals[f.key] = e.target.value; } }); }
    else input = h('input', { value: f.value ?? '', placeholder: f.placeholder || '', oninput: (e) => { vals[f.key] = e.target.value; } });
    return h('div', {}, fld(f.label, input), f.help ? h('div', { class: 'hint', style: 'margin:-4px 0 8px' }, f.help) : null);
  });
  modal(`${p.icon} ${p.name} – Einstellungen`, h('div', { class: 'form' }, rows), [{ label: 'Abbrechen' }, {
    label: 'Speichern', primary: true,
    onClick: async () => { await api('PUT', `/api/plugins/${p.id}`, { config: vals }); toast('Gespeichert'); await reload(); },
  }]);
}
function pluginCustomSettings(p) {
  const def = HL._settings.get(p.id);
  const body = h('div', { class: 'form' });
  modal(`${p.icon} ${def.title || p.name + ' – Einstellungen'}`, body, [{ label: 'Schließen' }]);
  Promise.resolve(def.render(body)).catch(fail);
}
function pluginsDraw(boxEl) {
  const box = boxEl || document.getElementById('pluginbox');
  if (!box) return false;
  const L = S.plugins || [];
  const file = h('input', { type: 'file', accept: '.tgz,.tar.gz,application/gzip,application/x-gzip', style: 'display:none', onchange: async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f || !confirm(PLUGIN_WARN)) return;
    try { toast('Installiere …'); const r = await api('POST', '/api/plugins/upload', { data: b64(await f.arrayBuffer()) }); await pluginInstalled(r); } catch (err) { fail(err); }
  } });
  const url = h('input', { placeholder: 'https://github.com/…/mein-plugin  oder  https://…/plugin.tar.gz', style: 'flex:1;min-width:200px' });
  fill(box,
    L.length ? L.map((p) => h('div', { class: 'row sb', style: 'padding:10px 0;border-top:1px solid var(--line)' },
      h('div', { style: 'min-width:0;flex:1' },
        h('div', {}, h('b', {}, `${p.icon} ${p.name}`), h('span', { class: 'hint' }, `  ${p.version}${p.author ? ' · ' + p.author : ''}`), ' ',
          h('span', { class: 'pill ' + (p.error ? 'bad' : p.running ? 'ok' : '') }, p.error ? 'Fehler' : p.running ? 'läuft' : 'aus')),
        p.description ? h('div', { class: 'hint' }, p.description) : null,
        (p.perms || []).includes('core') ? h('div', { class: 'hint', style: 'color:var(--warn,#d9a400)' }, '🔑 Recht: Zugriff auf Geräte, Automationen und Protokoll von HomeLite (wie der KI-Zugriff)') : null,
        p.error ? h('div', { class: 'hint', style: 'color:var(--bad)' }, p.error) : null,
        p.devices ? h('div', { class: 'hint' }, `${p.devices} Gerät${p.devices === 1 ? '' : 'e'}`) : null),
      h('div', { class: 'row', style: 'flex:none' },
        p.page && p.running ? h('label', { class: 'hint', style: 'display:flex;align-items:center;gap:6px' }, 'Im Menü', toggle(p.menu !== false, async (v) => { try { await api('PUT', `/api/plugins/${p.id}`, { menu: v }); await reload(); } catch (e) { fail(e); } })) : null,
        p.page && p.running && p.menu === false ? h('button', { class: 'sm', onclick: () => go('p_' + p.id) }, 'Öffnen') : null,
        p.config.length || (window.HL && HL._settings.has(p.id)) ? h('button', { class: 'sm', onclick: () => (window.HL && HL._settings.has(p.id) ? pluginCustomSettings(p) : pluginConfigDialog(p)) }, '⚙ Einstellungen') : null,
        h('button', { class: 'sm danger', onclick: () => { if (confirm(`Plugin „${p.name}“ entfernen?${p.devices ? ` Seine ${p.devices} Geräte werden ebenfalls gelöscht.` : ''}`)) api('DELETE', `/api/plugins/${p.id}`).then(reload).catch(fail); } }, 'Entfernen'),
        toggle(p.enabled, async (v) => { try { await api('PUT', `/api/plugins/${p.id}`, { enabled: v }); await reload(); } catch (e) { fail(e); } })))) : h('div', { class: 'hint' }, 'Noch keine Plugins installiert.'),
    h('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:12px' },
      h('button', { onclick: () => file.click() }, '⬆ Plugin-Datei wählen (.tar.gz)'), file, url,
      h('button', { onclick: async () => { if (!url.value.trim() || !confirm(PLUGIN_WARN)) return; try { toast('Lade und installiere …'); const r = await api('POST', '/api/plugins/url', { url: url.value.trim() }); await pluginInstalled(r); } catch (e) { fail(e); } } }, 'Von Adresse installieren')));
  return true;
}
function pluginsSection(el) {
  el.append(h('h2', {}, 'Plugins'), h('div', { class: 'card' },
    h('p', { class: 'hint', style: 'margin-top:0' }, 'Weitere Erweiterungen als Plugin: einfach installieren, ohne HomeLite zu aktualisieren oder neu zu starten. Plugins bringen eigene Geräte, Einstellungen und bei Bedarf eine eigene Seite im Menü mit. Sie bleiben bei Systemupdates erhalten.'),
    h('div', { id: 'pluginbox' })));
  pluginsDraw(el.querySelector('#pluginbox'));
}
