// Seite „Auto“ (Leapmotor): Ladestand, Reichweite, Reifendruck, Standort mit Karte, Fernbefehle
(() => {
  const { h, fill, toast, fail, fmtNum, fmtTime } = HL;
  let M = null;
  const call = (m, sub, body) => HL.api('leapmotor', m, sub, body);
  const box = () => document.getElementById('leap-box');

  // Kleine OpenStreetMap-Karte aus Kacheln (ohne Bibliothek)
  function tileMap(lat, lon, z = 16) {
    const n = 2 ** z, x = ((lon + 180) / 360) * n, lr = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n;
    const tx = Math.floor(x), ty = Math.floor(y), tiles = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) {
      tiles.push(h('img', {
        src: `https://tile.openstreetmap.org/${z}/${tx + dx}/${ty + dy}.png`, alt: '', width: 256, height: 256, draggable: 'false', onerror: (e) => { e.target.style.visibility = 'hidden'; }, referrerpolicy: 'strict-origin-when-cross-origin',
        style: `left:calc(50% + ${Math.round((dx - (x - tx)) * 256)}px);top:calc(50% + ${Math.round((dy - (y - ty)) * 256)}px)`,
      }));
    }
    return h('a', { class: 'map', href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`, target: '_blank', rel: 'noopener noreferrer', title: 'In OpenStreetMap öffnen' },
      tiles, h('span', { class: 'pin' }, '📍'), h('span', { class: 'attr' }, '© OpenStreetMap'));
  }
  function tireView(s) {
    const cell = (k, label) => {
      const v = s.tires[k];
      const bad = (s.tireAlarms && s.tireAlarms[k]) || (v != null && v < 2.0);
      return h('div', { class: 'tire' + (bad ? ' bad' : '') }, h('div', { class: 'hint' }, label), h('b', {}, v == null ? '–' : fmtNum(v, 2) + ' bar'), bad ? h('div', { class: 'hint' }, '⚠ prüfen') : null);
    };
    return h('div', { class: 'tires' }, cell('fl', 'vorn links'), cell('fr', 'vorn rechts'), cell('rl', 'hinten links'), cell('rr', 'hinten rechts'));
  }

  function draw() {
    const el = box();
    if (!el || !M) return;
    if (!M.configured) return fill(el, h('div', { class: 'empty' }, 'Bitte unter Einstellungen → Erweiterungen → Plugins → Leapmotor → ⚙ Einstellungen die E-Mail-Adresse und das Passwort der Leapmotor-App (und für Fernbefehle die Fahrzeug-PIN) eintragen.'));
    const parts = [];
    if (!M.certs) parts.push(h('div', { class: 'card', style: 'border-color:var(--warn,#f5a623)' },
      h('b', {}, 'App-Zertifikate fehlen. '), 'Sie stammen aus dem öffentlichen Repository markoceri/leapmotor-certs und können von dort geladen werden.', ' ',
      h('button', { class: 'sm', onclick: () => call('POST', 'certs', {}).then((r) => { M = r; draw(); toast('Zertifikate geladen'); }).catch(fail) }, 'Zertifikate laden')));
    if (M.error) parts.push(h('div', { class: 'card', style: 'margin-top:12px;border-color:var(--bad)' }, h('b', { style: 'color:var(--bad)' }, 'Fehler: '), M.error));
    const s = M.status;
    if (!s) parts.push(h('div', { class: 'empty', style: 'margin-top:12px' }, 'Noch keine Daten …'));
    else parts.push(h('div', { class: 'grid wide', style: 'margin-top:12px' },
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
    parts.push(h('h2', {}, 'Fernsteuerung'), h('div', { class: 'row' }, Object.entries(M.commands).map(([k, l]) => h('button', {
      onclick: () => { if (['unlock', 'open_trunk', 'unlock_charger'].includes(k) && !confirm(`„${l}“ wirklich senden?`)) return; call('POST', 'command', { command: k }).then(() => toast(l + ' gesendet')).catch(fail); },
    }, l))));
    fill(el, ...parts);
  }

  HL.on('leapmotor', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('leapmotor', {
    label: 'Auto', icon: '🚗',
    render(el) {
      el.append(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, '🚗 ' + ((M && M.name) || 'Leapmotor')),
        h('button', { onclick: () => call('POST', 'refresh', {}).then(() => toast('Aktualisiere …')).catch(fail) }, '↻ Aktualisieren')),
        h('div', { id: 'leap-box' }));
      call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail);
    },
  });
})();
