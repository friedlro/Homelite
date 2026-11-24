// Seite „EV-Charger“: Zustand, Laden starten/stoppen, Ladestrom, Messwerte
(() => {
  const { h, fill, toast, fail } = HL;
  let M = null, timer = null;
  const call = (m, sub, body) => HL.api('shelly-topac', m, sub, body);
  const host = () => document.getElementById('topac-box');
  const reload = () => call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail);
  const f1 = (x, d = 1) => (x == null || isNaN(x) ? '–' : Number(x).toLocaleString('de-AT', { maximumFractionDigits: d, minimumFractionDigits: d }));

  function draw() {
    const el = host();
    if (!el) { clearInterval(timer); return; }
    if (!M) return fill(el, h('div', { class: 'empty' }, 'Lade …'));
    const act = async (fn) => { try { M = await fn(); draw(); } catch (e) { fail(e); } };
    const slider = h('input', { type: 'range', min: M.minA, max: M.maxA, step: 1, value: M.limit || M.minA, style: 'width:100%' });
    const lab = h('b', {}, `${M.limit || M.minA} A`);
    slider.addEventListener('input', () => { lab.textContent = `${slider.value} A`; });
    slider.addEventListener('change', () => act(() => call('POST', 'limit', { amps: Number(slider.value) })).then(() => toast('Ladestrom gesetzt')));
    const kw = M.power != null ? M.power / 1000 : null;
    const nodes = [
      h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, '🚗 EV-Charger'), h('span', { class: 'pill ' + (M.ok ? 'ok' : 'bad') }, M.ok ? 'verbunden' : 'getrennt')),
      M.error ? h('div', { class: 'card', style: 'border-color:var(--bad)' }, h('b', { style: 'color:var(--bad)' }, 'Fehler: '), M.error) : null,
      h('div', { class: 'card' },
        h('div', { class: 'row sb' },
          h('div', {}, h('div', { class: 'hint' }, 'Zustand'), h('div', { style: 'font-size:1.4em;font-weight:600' }, M.stateText || '–'),
            h('div', { class: 'hint' }, M.plugged ? 'Fahrzeug verbunden' : 'Kein Fahrzeug verbunden')),
          h('div', { style: 'text-align:right' }, h('div', { class: 'hint' }, 'Leistung'), h('div', { style: 'font-size:1.4em;font-weight:600' }, kw == null ? '–' : f1(kw, 2) + ' kW'), h('div', { class: 'hint' }, f1(M.current) + ' A'))),
        h('div', { class: 'row', style: 'margin-top:12px;gap:8px' },
          h('button', { class: M.charging ? 'danger' : 'primary', onclick: () => act(() => call('POST', 'charge', { on: !M.charging })) }, M.charging ? '⏸ Laden stoppen' : '▶ Laden starten'),
          h('button', { onclick: () => act(() => call('POST', 'refresh', {})) }, '↻ Aktualisieren')),
        h('div', { style: 'margin-top:14px' }, h('div', { class: 'row sb' }, h('span', {}, 'Ladestrom'), lab), slider,
          h('div', { class: 'hint' }, `${M.minA}–${M.maxA} A (einphasig ca. ${f1(M.minA * 0.23, 1)}–${f1(M.maxA * 0.23, 1)} kW, dreiphasig ca. ${f1(M.minA * 0.69, 1)}–${f1(M.maxA * 0.69, 1)} kW)`)
        )),
      h('div', { class: 'card' }, h('table', {}, h('tbody', {},
        [['Sitzung', M.session == null ? '–' : f1(M.session, 2) + ' kWh'], ['Gesamtzähler', M.total == null ? '–' : f1(M.total, 2) + ' kWh'],
          ['Spannung L1 / L2 / L3', (M.volt || []).map((v) => (v == null ? '–' : Math.round(v))).join(' / ') + ' V'],
          ['Strom L1 / L2 / L3', (M.phase || []).map((p) => f1(p.current)).join(' / ') + ' A'],
          ['Gerät', M.info ? `${M.info.name || ''} ${M.info.model || ''} · Firmware ${M.info.fw || '?'} · ${M.config.host}` : M.config.host || '–']]
          .map(([k, v]) => h('tr', {}, h('td', { class: 'hint' }, k), h('td', {}, v)))))),
      h('p', { class: 'hint' }, 'Die Leistung fließt automatisch in den Energiefluss („EV-Charger“) und in die Wallbox-Kosten ein. Für Automationen (z. B. Überschussladen) stehen „EV-Charger“ (ein/aus, Ladestrom als Helligkeit) und die Sensoren unter Geräte bereit.'),
    ];
    fill(el, ...nodes.filter(Boolean));
  }

  HL.on('shelly-topac', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('shelly-topac', {
    label: 'EV-Charger', icon: '🚗',
    render(el) { clearInterval(timer); el.append(h('div', { id: 'topac-box' })); draw(); reload(); timer = setInterval(() => { if (host()) reload(); else clearInterval(timer); }, 10000); },
  });
})();
