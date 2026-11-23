// Seite „Alexa“: Bridge-Status, Geräte für Alexa freigeben, Sprachnamen vergeben
(() => {
  const { h, fill, toast, fail } = HL;
  let M = null;
  const call = (m, sub, body) => HL.api('alexa', m, sub, body);
  const host = () => document.getElementById('alexa-box');
  const reload = () => call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail);

  function draw() {
    const el = host();
    if (!el) return;
    if (!M) return fill(el, h('div', { class: 'empty' }, 'Lade …'));
    const ago = M.lastHit ? Math.round((Date.now() - M.lastHit) / 60000) + ' min' : '–';
    const nodes = [
      h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, '🗣 Alexa'), h('span', { class: 'pill ' + (M.running ? 'ok' : 'bad') }, M.running ? 'Bridge läuft' : 'Bridge aus')),
      M.error ? h('div', { class: 'card', style: 'border-color:var(--bad)' }, h('b', { style: 'color:var(--bad)' }, 'Fehler: '), M.error) : null,
      h('div', { class: 'card' },
        h('div', { class: 'hint' }, M.running ? `HomeLite meldet sich als Hue-Bridge auf ${M.ip}:${M.port} (ID ${M.bridgeId}). Anfragen bisher: ${M.hits}, letzte vor ${ago}.${M.lastCmd ? ' Letzter Befehl: ' + M.lastCmd : ''}` : 'Die Bridge startet, sobald eine Heimnetz-Adresse gefunden ist.'),
        h('ol', { class: 'hint', style: 'margin:8px 0 0 18px' },
          h('li', {}, 'Unten die Geräte freigeben, die Alexa steuern soll (Namen nach Wunsch ändern).'),
          h('li', {}, 'In der Alexa-App: Geräte → + → Gerät hinzufügen → Licht → Philips Hue. Oder sagen: „Alexa, suche neue Geräte“.'),
          h('li', {}, 'Falls nach dem Link-Button gefragt wird: nichts drücken, HomeLite bestätigt automatisch.'))),
    ];
    const devs = M.devices || [];
    if (!devs.length) nodes.push(h('div', { class: 'empty' }, 'Keine Lichter oder Schalter vorhanden.'));
    else nodes.push(h('div', { class: 'card', style: 'overflow-x:auto;padding:6px 14px' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Freigeben', 'Gerät', 'Raum', 'Name für Alexa'].map((x) => h('th', {}, x)))),
      h('tbody', {}, devs.map((d) => {
        const alias = h('input', { value: d.alias || d.name, disabled: !d.exposed, style: 'min-width:160px', maxlength: 32 });
        const save = () => call('PUT', 'expose', { id: d.id, exposed: true, alias: alias.value }).then((r) => { M = r; toast('Gespeichert – in der Alexa-App erneut suchen'); draw(); }).catch(fail);
        alias.addEventListener('change', save);
        return h('tr', {},
          h('td', {}, h('input', { type: 'checkbox', checked: d.exposed, onchange: (e) => call('PUT', 'expose', { id: d.id, exposed: e.target.checked, alias: alias.value }).then((r) => { M = r; draw(); }).catch(fail) })),
          h('td', {}, d.name + (d.type === 'light' ? ' 💡' : ' 🔌')), h('td', { class: 'hint' }, d.room || '–'), h('td', {}, alias));
      })))));
    nodes.push(h('p', { class: 'hint' }, 'Hinweis: Alexa schaltet und dimmt über diese Emulation. Sensoren, Thermostate und Rollos sind damit nicht möglich. Namen ohne Sonderzeichen wählen (z. B. „Stehlampe“), dann klappt die Sprachsteuerung am besten.'));
    fill(el, ...nodes.filter(Boolean));
  }

  HL.on('alexa', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('alexa', {
    label: 'Alexa', icon: '🗣',
    render(el) { el.append(h('div', { id: 'alexa-box' })); draw(); reload(); },
  });
})();
