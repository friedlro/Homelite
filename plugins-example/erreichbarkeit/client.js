// Oberfläche: Liste der überwachten Geräte, Auswahl per Dropdown (Router, HomeLite-Geräte) oder eigene Adresse.
(() => {
  const { h, fill } = HL;
  let list = [];
  let cands = [];
  const draw = () => {
    const box = document.getElementById('erreichbarkeit-box');
    if (!box) return;
    fill(box, list.length ? list.map((x) => h('div', { class: 'row sb', style: 'padding:10px 0;border-top:1px solid var(--line)' },
      h('div', {}, h('b', {}, x.name), h('div', { class: 'hint' }, x.target)),
      h('div', { class: 'row' },
        h('div', { style: 'text-align:right' }, h('span', { class: 'pill ' + (x.up ? 'ok' : 'bad') }, x.up ? `erreichbar · ${x.ms} ms` : 'nicht erreichbar'),
          h('div', { class: 'hint' }, 'seit ' + new Date(x.since).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))),
        x.text ? null : h('button', { class: 'sm danger', onclick: () => HL.api('erreichbarkeit', 'DELETE', 'targets/' + encodeURIComponent(x.name)).then(apply).catch(HL.fail) }, '✕')))) : h('div', { class: 'empty' }, 'Noch nichts überwacht – unten ein Gerät auswählen.'));
  };
  const apply = (r) => { list = r.status || []; cands = r.candidates || cands; draw(); drawForm(); };
  const drawForm = () => {
    const box = document.getElementById('erreichbarkeit-form');
    if (!box) return;
    const taken = new Set(list.map((x) => x.name.toLowerCase()));
    const free = cands.filter((c) => !taken.has(c.name.toLowerCase()));
    const name = h('input', { placeholder: 'Name', style: 'width:100%' });
    const host = h('input', { placeholder: 'Adresse (IP oder Name)', style: 'width:100%' });
    const ports = h('input', { placeholder: 'Port(s), z. B. 80,443', value: '80', style: 'width:100%' });
    const pick = h('select', { style: 'width:100%', onchange: (e) => {
      const c = free.find((x) => x.id === e.target.value);
      if (c) { name.value = c.name; host.value = c.host; ports.value = c.ports.join(','); host.readOnly = true; } else { name.value = ''; host.value = ''; host.readOnly = false; ports.value = '80'; }
    } }, h('option', { value: '' }, '✎ Eigene Adresse …'), free.map((c) => h('option', { value: c.id }, c.label)));
    const add = () => HL.api('erreichbarkeit', 'POST', 'targets', { name: name.value, host: host.value, ports: ports.value }).then((r) => { HL.toast('Hinzugefügt'); apply(r); }).catch(HL.fail);
    fill(box, h('b', {}, 'Gerät hinzufügen'),
      h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin:8px 0' }, pick, name, host, ports),
      h('div', { class: 'hint' }, 'Geprüft wird per Verbindung zu einem offenen Port (bei mehreren Ports genügt einer). Router: meist 80 oder 443.'),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: add }, 'Hinzufügen')));
  };
  HL.on('erreichbarkeit', (d) => { list = d.status || []; draw(); });
  HL.page('erreichbarkeit', {
    label: 'Erreichbarkeit', icon: '📶',
    render(el) {
      el.append(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, '📶 Erreichbarkeit'),
        h('button', { onclick: () => HL.api('erreichbarkeit', 'POST', 'check', {}).then(apply).catch(HL.fail) }, '↻ Jetzt prüfen')),
        h('div', { class: 'card', id: 'erreichbarkeit-box' }), h('div', { class: 'card', id: 'erreichbarkeit-form' }));
      draw();
      HL.api('erreichbarkeit', 'GET', 'status').then(apply).catch(HL.fail);
    },
  });
})();
