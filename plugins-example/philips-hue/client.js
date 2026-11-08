// Hue-Seite: Bridge verbinden, Status, Szenen
(() => {
  const { h, fill } = HL;
  let s = null; let scenes = [];
  const apply = (r) => { if (r.status) s = r.status; if (r.scenes) scenes = r.scenes; draw(); };
  const draw = () => {
    const box = document.getElementById('hue-box');
    if (!box) return;
    if (!s) return fill(box, h('div', { class: 'empty' }, 'Lade …'));
    const ip = h('input', { value: s.bridge || '', placeholder: 'IP der Bridge, z. B. 192.168.1.2', style: 'flex:1;min-width:200px' });
    const find = h('button', { onclick: () => HL.api('philips-hue', 'GET', 'discover').then((r) => { if (r.bridges[0]) { ip.value = r.bridges[0].ip; HL.toast(`Bridge gefunden: ${r.bridges[0].ip}`); } else HL.toast('Keine Bridge gefunden – IP bitte von Hand eintragen'); }).catch(HL.fail) }, 'Bridge suchen');
    const save = () => HL.api('philips-hue', 'POST', 'bridge', { ip: ip.value }).then((r) => { apply(r); HL.toast('Bridge gefunden'); }).catch(HL.fail);
    const pair = () => HL.api('philips-hue', 'POST', 'pair', {}).then((r) => { apply(r); HL.toast('Gekoppelt'); }).catch(HL.fail);
    const parts = [h('div', { class: 'row sb' }, h('b', {}, s.paired ? (s.name ? `Bridge „${s.name}“` : 'Bridge') : 'Nicht gekoppelt'),
      s.paired ? h('span', { class: 'pill ' + (s.online ? 'ok' : s.online === false ? 'bad' : '') }, s.online ? 'verbunden' : s.online === false ? 'Fehler' : '…') : null)];
    if (s.error) parts.push(h('div', { class: 'hint', style: 'color:var(--bad)' }, s.error));
    if (!s.paired) {
      parts.push(h('div', { class: 'hint' }, '1. Adresse der Bridge eintragen (oder „Bridge suchen“) und „Speichern“.  2. Die runde Link-Taste an der Bridge drücken.  3. Innerhalb von 30 Sekunden „Koppeln“ wählen.'),
        h('div', { class: 'row', style: 'flex-wrap:wrap;margin:8px 0' }, ip, find, h('button', { onclick: save }, 'Speichern'), h('button', { class: 'primary', onclick: pair, disabled: !s.bridge }, 'Koppeln')));
    } else {
      parts.push(h('div', { class: 'hint' }, `${s.bridge} · ${s.counts.lights} Lampen/Steckdosen · ${s.counts.sensors} Sensoren/Schalter · ${s.counts.groups} Gruppen · letzte Abfrage ${s.last ? new Date(s.last).toLocaleTimeString('de-AT') : '–'}`),
        h('div', { class: 'row', style: 'margin:8px 0' }, h('button', { onclick: () => HL.api('philips-hue', 'POST', 'refresh', {}).then(apply).catch(HL.fail) }, '↻ Jetzt abfragen'),
          h('button', { class: 'danger', onclick: () => { if (confirm('Verbindung zur Bridge trennen? Die Geräte bleiben, werden aber nicht mehr aktualisiert.')) HL.api('philips-hue', 'DELETE', 'pair').then(apply).catch(HL.fail); } }, 'Trennen')));
      if (scenes.length) {
        parts.push(h('b', {}, 'Szenen'));
        const groups = {};
        for (const sc of scenes) (groups[sc.groupName] = groups[sc.groupName] || []).push(sc);
        for (const [g, l] of Object.entries(groups)) parts.push(h('div', { style: 'margin:8px 0 2px' }, h('span', { class: 'hint' }, g)),
          h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' }, l.map((sc) => h('button', { class: 'sm', onclick: () => HL.api('philips-hue', 'POST', 'scene/' + encodeURIComponent(sc.id), {}).then(() => HL.toast(`„${sc.name}“ aktiviert`)).catch(HL.fail) }, sc.name))));
      }
    }
    fill(box, parts);
  };
  HL.on('philips-hue', (d) => { if (d.status) { s = d.status; draw(); } });
  HL.page('philips-hue', {
    label: 'Hue', icon: '💡',
    render(el) {
      el.append(h('h2', { class: 'page-title' }, '💡 Philips Hue'), h('div', { class: 'card', id: 'hue-box' }));
      draw();
      HL.api('philips-hue', 'GET', 'status').then(apply).catch(HL.fail);
    },
  });
})();
