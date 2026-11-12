// Seite „BMW“: Fahrzeugübersicht wie in der App + alle Rohwerte
(() => {
  const { h, fill, toast, fail, fmtTime } = HL;
  let M = null, sel = null;
  const box = () => document.getElementById('bmw-box');
  const call = (m, sub) => HL.api('bmw', m, sub, {});

  const EN = { CLOSED: 'geschlossen', OPEN: 'offen', OPENED: 'offen', AJAR: 'angelehnt', TILT: 'gekippt', INTERMEDIATE: 'teilweise offen', LOCKED: 'verriegelt', SECURED: 'gesichert', UNLOCKED: 'entriegelt', SELECTIVELOCKED: 'teilw. verriegelt',
    CHARGINGACTIVE: 'lädt', CHARGING: 'lädt', CHARGINGENDED: 'beendet', CHARGINGPAUSED: 'pausiert', NOCHARGING: 'lädt nicht', CHARGINGERROR: 'Fehler', CHARGINGCOMPLETED: 'abgeschlossen', CHARGINGINITIALIZED: 'startet', CHARGINGINTERRUPTED: 'unterbrochen',
    CONNECTED: 'angesteckt', DISCONNECTED: 'nicht angesteckt', PLUGGEDIN: 'angesteckt', TRUE: 'ja', FALSE: 'nein', ON: 'an', OFF: 'aus', ACTIVE: 'aktiv', INACTIVE: 'inaktiv', OK: 'in Ordnung', NO_ERROR: 'kein Fehler' };
  const tr = (v) => { if (v == null) return '–'; const k = String(v).toUpperCase(); return EN[k] || String(v); };
  const nf = (n, d = 0) => (n == null ? '–' : Number(n).toLocaleString('de-AT', { maximumFractionDigits: d }));
  const short = (k) => k.replace(/^vehicle\./, '');
  const GROUPS = [
    ['🔋 Batterie & Laden', /charg|battery|electricengine|stateofcharge|\.soc|energy/i],
    ['⛽ Tank & Verbrauch', /fuel|consumption/i],
    ['🚪 Türen, Fenster & Schloss', /door|window|trunk|tailgate|hood|bonnet|sunroof|roof|lock|flap/i],
    ['🛞 Reifen & Fahrwerk', /tire|tyre|wheel|axle|chassis/i],
    ['🌡️ Klima & Innenraum', /climat|hvac|preconditi|temperature|heating|ventilation|cabin/i],
    ['📍 Standort & Fahrt', /location|navigation|speed|trip|travelled|distance|drive|heading/i],
    ['🔧 Service & Zustand', /service|cbs|checkcontrol|maintenance|brake|oil|inspection|warning|status/i],
  ];
  const groupOf = (k) => { for (const [n, re] of GROUPS) if (re.test(k)) return n; return '📋 Sonstiges'; };
  const fmtVal = (x) => { const v = typeof x.v === 'object' ? JSON.stringify(x.v) : tr(x.v); return x.u && !isNaN(Number(x.v)) ? `${nf(x.v, 2)} ${x.u}` : v; };

  function bar(p, color) { return h('div', { style: 'height:10px;border-radius:5px;background:var(--line,#ddd);overflow:hidden;margin:6px 0' }, h('div', { style: `height:100%;width:${Math.max(0, Math.min(100, p || 0))}%;background:${color}` })); }
  const kv = (rows) => h('div', { class: 'card kv' }, rows.filter((r) => r[1] != null && r[1] !== '–').flatMap((r) => [h('span', {}, r[0]), h('span', {}, r[1])]));
  const lastOf = (c, re) => c.values.find((x) => re.test(x.k));

  function map(s, z) {
    const n = Math.pow(2, z), x = (s.lon + 180) / 360 * n, lr = s.lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n;
    const tx = Math.floor(x), ty = Math.floor(y), ox = (x - tx) * 256, oy = (y - ty) * 256;
    const tiles = [];
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) tiles.push(h('img', { src: `https://tile.openstreetmap.org/${z}/${tx + i}/${ty + j}.png`, loading: 'lazy', referrerpolicy: 'no-referrer', style: `position:absolute;left:${(i + 1) * 256}px;top:${(j + 1) * 256}px;width:256px;height:256px` }));
    const pin = h('div', { style: `position:absolute;left:${256 + ox - 14}px;top:${256 + oy - 30}px;font-size:28px;line-height:28px;transform:rotate(0deg)` }, '📍');
    return h('div', { style: 'width:100%;height:220px;overflow:hidden;border-radius:10px;position:relative;background:#ddd' },
      h('div', { style: `position:absolute;width:768px;height:768px;left:50%;top:50%;margin-left:${-(256 + ox)}px;margin-top:${-(256 + oy)}px` }, tiles, pin),
      h('div', { style: 'position:absolute;right:4px;bottom:2px;font-size:10px;background:#fffc;padding:0 4px;border-radius:3px;color:#333' }, '© OpenStreetMap'));
  }

  function car(c) {
    const s = c.summary, b = c.basic, out = [];
    const title = [b.brand, b.modelName || b.series].filter(Boolean).join(' ') || 'BMW';
    out.push(h('div', { class: 'card' }, h('div', { class: 'row sb' }, h('div', {}, h('b', { style: 'font-size:1.2em' }, title), h('div', { class: 'hint' }, c.vin, b.constructionYear ? ` · Baujahr ${b.constructionYear}` : '', b.driveTrain ? ` · ${b.driveTrain}` : '')),
      h('div', { style: 'text-align:right' }, h('div', { style: 'font-size:1.4em;font-weight:600' }, s.mileage != null ? `${nf(s.mileage)} km` : '–'), h('div', { class: 'hint' }, c.updated ? 'Stand ' + fmtTime(c.updated) : 'noch keine Daten')))));
    if (s.soc != null || s.range != null || s.charging != null) {
      const col = s.soc == null ? '#888' : s.soc < 20 ? 'var(--bad,#d33)' : s.soc < 40 ? 'var(--warn,#e8a317)' : 'var(--good,#2a9d4a)';
      out.push(h('h2', {}, '🔋 Batterie & Laden'), h('div', { class: 'card' },
        h('div', { class: 'row sb' }, h('b', { style: 'font-size:1.6em' }, s.soc != null ? `${nf(s.soc)} %` : '–'), h('div', { style: 'text-align:right' }, h('b', {}, s.range != null ? `${nf(s.range)} ${s.rangeUnit}` : '–'), h('div', { class: 'hint' }, 'Reichweite'))),
        s.soc != null ? bar(s.soc, col) : null,
        h('div', { class: 'hint' }, [s.charging ? '⚡ lädt' + (s.power != null ? ` mit ${nf(s.power, 1)} kW` : '') : null, s.plugged === true ? '🔌 angesteckt' : s.plugged === false ? 'nicht angesteckt' : null, s.timeToFull != null ? `voll in ${nf(s.timeToFull)} min` : null, s.socTarget != null ? `Ziel ${nf(s.socTarget)} %` : null, s.energy != null ? `Kapazität ${nf(s.energy, 1)} kWh` : null].filter(Boolean).join(' · ') || tr(s.chargeStatus))));
    }
    if (s.fuel != null) out.push(h('h2', {}, '⛽ Tank'), kv([['Tankinhalt', `${nf(s.fuel, 1)} l`], ['Reichweite', s.range != null ? `${nf(s.range)} ${s.rangeUnit}` : null]]));
    const sec = [['Fahrzeug', s.locked == null ? null : s.locked ? '🔒 verriegelt' : '🔓 entriegelt'], ['Türen/Klappen/Fenster', s.anyOpen == null ? null : s.anyOpen ? '⚠ offen: ' + s.openParts.map((k) => short(k).replace(/\.(status|isOpen)$/i, '').split('.').slice(-3).join(' ')).join(', ') : '✅ alles geschlossen'], ['Unterwegs', s.moving == null ? null : s.moving ? '🚗 in Fahrt' : 'geparkt']];
    if (sec.some((r) => r[1])) out.push(h('h2', {}, '🚪 Sicherheit'), kv(sec));
    const tires = c.values.filter((x) => /tire|tyre/i.test(x.k) && /pressure|press/i.test(x.k));
    if (tires.length) out.push(h('h2', {}, '🛞 Reifendruck'), h('div', { class: 'card kv' }, tires.flatMap((x) => [h('span', {}, short(x.k).replace(/.*axle\./i, '').replace(/\.tire.*/i, '').replace(/\./g, ' ')), h('span', {}, fmtVal(x))])));
    if (s.lat != null && s.lon != null) {
      out.push(h('h2', {}, '📍 Standort'), h('div', { class: 'card' }, map(s, M.zoom || 15), h('div', { class: 'row sb', style: 'margin-top:8px' }, h('span', { class: 'hint' }, `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}${s.heading != null ? ` · Richtung ${nf(s.heading)}°` : ''}`), h('a', { href: `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`, target: '_blank', rel: 'noopener noreferrer' }, 'Karte öffnen'))));
    }
    const svc = c.values.filter((x) => /service|cbs|checkcontrol|maintenance|inspection/i.test(x.k));
    if (svc.length) out.push(h('h2', {}, '🔧 Service'), h('div', { class: 'card kv' }, svc.flatMap((x) => [h('span', {}, short(x.k)), h('span', {}, fmtVal(x))])));
    const grp = {};
    for (const x of c.values) (grp[groupOf(x.k)] = grp[groupOf(x.k)] || []).push(x);
    out.push(h('h2', {}, `Alle Werte (${c.values.length})`));
    if (!c.values.length) out.push(h('div', { class: 'card hint' }, 'Noch nichts empfangen. Der BMW-Datenstrom liefert Werte nur, wenn sich im Fahrzeug etwas ändert (Fahrt, Laden, Türen). Im BMW-Portal müssen die gewünschten Datenpunkte ausgewählt sein.'));
    for (const [name, list] of Object.entries(grp).sort()) out.push(h('details', { class: 'card', style: 'margin-top:8px' }, h('summary', {}, h('b', {}, name), ` (${list.length})`),
      h('table', {}, h('tbody', {}, list.map((x) => h('tr', {}, h('td', { style: 'word-break:break-all' }, h('code', {}, short(x.k))), h('td', {}, fmtVal(x)), h('td', { class: 'hint' }, x.t ? fmtTime(x.t) : '')))))));
    return out;
  }

  function draw() {
    const el = box(); if (!el || !M) return;
    const p = [];
    const state = h('div', { class: 'card kv' }, h('span', {}, 'Status'), h('span', {}, `${M.stream ? '🟢' : '⚪'} ${M.status}`), M.lastMsg ? h('span', {}, 'Letzte Nachricht') : null, M.lastMsg ? h('span', {}, fmtTime(M.lastMsg)) : null, h('span', {}, 'REST heute'), h('span', {}, `${M.quota.n} von 50`));
    if (M.err) p.push(h('div', { class: 'card', style: 'border-color:var(--bad)' }, h('b', { style: 'color:var(--bad)' }, 'Hinweis: '), M.err));
    if (!M.configured) p.push(h('div', { class: 'card' }, 'Zuerst in den Plugin-Einstellungen die ', h('b', {}, 'CarData-Client-ID'), ' eintragen (Anleitung: LIESMICH.md des Plugins).'));
    if (M.login) p.push(h('div', { class: 'card', style: 'border-color:var(--accent,#39f)' }, h('b', {}, 'Bei BMW bestätigen'), h('p', {}, 'Öffne ', h('a', { href: M.login.url, target: '_blank', rel: 'noopener noreferrer' }, 'die BMW-Anmeldeseite'), ' und gib diesen Code ein:'), h('div', { style: 'font-size:2em;letter-spacing:.2em;font-weight:700' }, M.login.user_code), h('p', { class: 'hint' }, 'Gültig bis ' + fmtTime(M.login.expires))));
    p.push(h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin:8px 0' },
      !M.loggedIn || M.login ? h('button', { class: 'primary', disabled: !M.configured, onclick: () => call('POST', 'login').then((r) => { M = r; draw(); }).catch(fail) }, 'Bei BMW anmelden') : null,
      M.loggedIn ? h('button', { onclick: () => call('POST', 'reconnect').then((r) => { M = r; draw(); toast('Neu verbunden'); }).catch(fail) }, '↻ Neu verbinden') : null,
      M.loggedIn ? h('button', { onclick: () => call('POST', 'rest').then((r) => { M = r; draw(); toast('Stammdaten geladen'); }).catch(fail) }, 'Modell/Stammdaten laden') : null,
      M.loggedIn ? h('button', { class: 'danger', onclick: () => { if (confirm('Von BMW abmelden?')) call('POST', 'logout').then((r) => { M = r; draw(); }).catch(fail); } }, 'Abmelden') : null));
    if (M.cars.length > 1) p.push(h('div', { class: 'row', style: 'gap:6px;margin-bottom:8px' }, M.cars.map((c) => h('button', { class: c.vin === (sel || M.cars[0].vin) ? 'primary' : '', onclick: () => { sel = c.vin; draw(); } }, (c.basic.modelName || 'BMW') + ' …' + c.vin.slice(-4)))));
    const c = M.cars.find((x) => x.vin === sel) || M.cars[0];
    if (c) p.push(...car(c)); else if (M.loggedIn) p.push(h('div', { class: 'card hint' }, 'Noch kein Fahrzeug erkannt – sobald der Datenstrom die erste Nachricht liefert, erscheint es hier.'));
    p.push(h('h2', {}, 'Verbindung'), state);
    fill(el, ...p);
  }
  HL.on('bmw', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('bmw', {
    label: 'BMW', icon: '🚙',
    render(el) {
      el.append(h('h2', { class: 'page-title' }, '🚙 BMW'), h('div', { id: 'bmw-box' }));
      call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail);
    },
  });
})();
