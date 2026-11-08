// Seite „Heizung (SIOCS)“: Messwerte, Betriebsart, Korrektur, Heizzeiten
(() => {
  const { h, fill, toast, fail } = HL;
  let M = null;
  const call = (m, sub, body) => HL.api('siocs-heizung', m, sub, body);
  const box = () => document.getElementById('siocs-box');
  const fmt = (v, u) => (v === undefined || v === null ? '–' : `${String(v).replace('.', ',')}${u ? ' ' + u : ''}`);
  const when = (s) => (s ? new Date(s).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
  const run = (p) => p.then((r) => { M = r.values !== undefined ? r : M; draw(); }).catch(fail);

  function draw() {
    const el = box();
    if (!el || !M) return;
    const v = M.values || {};
    if (!M.configured) return fill(el, h('div', { class: 'empty' }, 'Bitte unter Einstellungen → Erweiterungen → Plugins → SIOCS Heizung die Adresse, den Benutzer und das Passwort des Portals eintragen.'));
    const tile = (label, val, unit) => h('div', { class: 'card', style: 'padding:10px;text-align:center' }, h('div', { class: 'hint' }, label), h('b', { style: 'font-size:1.3em' }, fmt(val, unit)));
    const modeSel = h('select', { onchange: (e) => run(call('POST', 'mode', { mode: e.target.value })) },
      Object.entries(M.modes).map(([k, l]) => h('option', { value: k, selected: v.mode_selected === k }, l)));
    const off = h('input', { type: 'number', step: '0.1', min: '-5', max: '5', value: v.offset ?? 0, style: 'width:90px' });
    const sched = M.schedule ? h('table', { style: 'width:100%;margin-top:6px' }, M.days.map((d) => h('tr', {},
      h('td', {}, d), h('td', {}, ((M.schedule[d] || []).filter((p) => p[0] !== p[1]).map((p) => `${p[0]}–${p[1]}`).join(', ')) || '–')))) : h('div', { class: 'hint' }, 'Noch nicht gelesen (alle 6 Stunden).');
    fill(el,
      h('div', { class: 'row sb' },
        h('span', { class: 'pill ' + (M.ok ? 'ok' : 'bad') }, M.ok ? 'verbunden' : (M.running ? 'verbinde …' : 'getrennt')),
        h('span', { class: 'hint' }, 'Stand: ' + when(M.updated))),
      M.error ? h('div', { class: 'hint', style: 'color:var(--bad,#c00);margin-top:6px' }, M.error) : null,
      h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:10px 0' },
        tile('Raumtemperatur', v.room_temp, '°C'), tile('Raumsoll', v.room_setpoint, '°C'), tile('Korrektur', v.offset, 'K'),
        tile('Außen (Regelung)', v.outdoor_avg_control, '°C'), tile('Leistung', v.power_kw, 'kW'), tile('Spreizung', v.spread_k, 'K'),
        tile('Wärmemenge', v.energy_kwh, 'kWh'), tile('Volumen', v.volume_m3, 'm³'), tile('Status', v.mode_status, '')),
      h('div', { class: 'card', style: 'padding:10px' }, h('b', {}, 'Steuern'),
        h('div', { class: 'row', style: 'gap:10px;margin-top:8px;flex-wrap:wrap' },
          h('label', {}, 'Betriebsart ', modeSel),
          h('label', {}, 'Korrektur (K) ', off, ' ', h('button', { onclick: () => run(call('POST', 'offset', { value: off.value })) }, 'Setzen'))),
        h('div', { class: 'hint', style: 'margin-top:6px' }, 'Das Portal übernimmt Änderungen verzögert (10–30 s). Befehle wirken auf die echte Anlage; für den Normalbetrieb „Automatik“ wählen.')),
      h('div', { class: 'card', style: 'padding:10px;margin-top:8px' }, h('b', {}, 'Heizzeiten' + (M.scheduleCircuit ? ' – ' + M.scheduleCircuit : '')), sched));
  }

  HL.on('siocs-heizung', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('siocs-heizung', {
    label: 'Heizung (SIOCS)', icon: '🔥',
    render(el) {
      el.append(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, '🔥 Heizung (SIOCS)'),
        h('div', { class: 'row' },
          h('button', { onclick: () => call('POST', 'refresh', {}).then(() => toast('Abfrage angestoßen')).catch(fail) }, '↻ Jetzt lesen'),
          h('button', { onclick: () => run(call('POST', 'restart', {})) }, 'Neu verbinden'))),
        h('div', { class: 'card', id: 'siocs-box' }));
      call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail);
    },
  });
})();
