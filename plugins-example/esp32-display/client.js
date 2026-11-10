// Seite „Displays“: Displays anlegen, Seiten und Kacheln zusammenstellen, Status und Einsparung sehen
(() => {
  const { h, fill, toast, fail, modal, fld } = HL;
  let M = null;
  const call = (m, sub, body) => HL.api('esp32-display', m, sub, body);
  const box = () => document.getElementById('ed-box');
  const ago = (t) => { if (!t) return 'noch nie'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `vor ${s} s` : s < 3600 ? `vor ${Math.round(s / 60)} min` : s < 86400 ? `vor ${Math.round(s / 3600)} h` : new Date(t).toLocaleDateString('de-AT'); };
  const KIND = { value: 'Wert', toggle: 'Schalter (Tippen)', state: 'Zustand (an/aus)' };

  function edit(src) {
    const d = JSON.parse(JSON.stringify(src || { id: '', name: '', brightness: 80, pages: [{ name: 'Start', tiles: [] }], night: { enabled: false, from: '22:00', to: '06:00', level: 10 } }));
    const orig = src ? src.id : '';
    const id = h('input', { value: d.id, placeholder: 'z. B. flur', disabled: !!src }), name = h('input', { value: d.name, placeholder: 'Flur-Display' });
    const br = h('input', { type: 'number', min: 1, max: 100, value: d.brightness });
    const nEn = h('input', { type: 'checkbox', checked: d.night.enabled }), nF = h('input', { type: 'time', value: d.night.from }), nT = h('input', { type: 'time', value: d.night.to }), nL = h('input', { type: 'number', min: 0, max: 100, value: d.night.level });
    const pagesEl = h('div', {});
    const devOpts = (sel) => [h('option', { value: '' }, '– Gerät wählen –'), ...M.devices.map((x) => h('option', { value: x.id, selected: x.id === sel }, `${x.room ? x.room + ': ' : ''}${x.name}`))];
    function drawPages() {
      fill(pagesEl, ...d.pages.map((p, pi) => h('div', { class: 'card', style: 'padding:8px;margin:8px 0' },
        h('div', { class: 'row', style: 'gap:6px' }, h('input', { value: p.name, style: 'flex:1', oninput: (e) => { p.name = e.target.value; } }),
          h('button', { class: 'sm danger', onclick: () => { d.pages.splice(pi, 1); drawPages(); } }, 'Seite löschen')),
        ...p.tiles.map((t, ti) => h('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap;margin-top:6px;align-items:center' },
          h('select', { onchange: (e) => { t.dev = e.target.value; const x = M.devices.find((v) => v.id === t.dev); if (x && !t.label) { t.label = x.name.slice(0, 20); drawPages(); } if (x && !t.unit && x.unit) t.unit = x.unit; if (x && ['switch', 'light'].includes(x.type)) t.kind = 'toggle'; } }, ...devOpts(t.dev)),
          h('input', { value: t.label, placeholder: 'Beschriftung', style: 'width:130px', oninput: (e) => { t.label = e.target.value; } }),
          h('select', { onchange: (e) => { t.kind = e.target.value; } }, ...Object.entries(KIND).map(([k, l]) => h('option', { value: k, selected: t.kind === k }, l))),
          h('input', { value: t.unit || '', placeholder: 'Einheit', style: 'width:60px', oninput: (e) => { t.unit = e.target.value; } }),
          h('input', { type: 'number', value: t.dec || 0, min: 0, max: 3, title: 'Nachkommastellen', style: 'width:52px', oninput: (e) => { t.dec = Number(e.target.value); } }),
          h('input', { type: 'number', value: t.delta || 0, min: 0, step: 'any', title: 'Mindeständerung: kleinere Änderungen werden nicht gesendet', placeholder: 'Δ', style: 'width:60px', oninput: (e) => { t.delta = Number(e.target.value); } }),
          h('button', { class: 'sm danger', onclick: () => { p.tiles.splice(ti, 1); drawPages(); } }, '✕'))),
        p.tiles.length < 12 ? h('button', { class: 'sm', style: 'margin-top:6px', onclick: () => { p.tiles.push({ tid: 0, dev: '', label: '', unit: '', kind: 'value', dec: 0, delta: 0 }); drawPages(); } }, '➕ Kachel') : h('span', { class: 'hint' }, 'Höchstens 12 Kacheln je Seite'))),
      d.pages.length < 8 ? h('button', { class: 'sm', onclick: () => { d.pages.push({ name: 'Seite ' + (d.pages.length + 1), tiles: [] }); drawPages(); } }, '➕ Seite') : null);
    }
    drawPages();
    const el = h('div', { class: 'form' }, fld('Display-ID (Buchstaben/Ziffern, wie in der ESP32-Firmware)', id), fld('Name', name), fld('Helligkeit (1–100 %)', br),
      h('div', { class: 'row', style: 'gap:6px;align-items:center;flex-wrap:wrap' }, nEn, ' Nachtabsenkung von', nF, 'bis', nT, 'auf', nL, '%'),
      h('div', { class: 'hint', style: 'margin-top:8px' }, 'Kacheln: Gerät, Beschriftung, Art, Einheit, Nachkommastellen und Mindeständerung (Δ). Nur Änderungen ab Δ werden gesendet.'), pagesEl);
    modal(src ? `Display „${src.name}“` : 'Display hinzufügen', el, [
      { label: 'Speichern', primary: true, onClick: async () => { d.id = id.value; d.name = name.value; d.brightness = Number(br.value); d.night = { enabled: nEn.checked, from: nF.value, to: nT.value, level: Number(nL.value) }; M = await call('POST', 'display', { ...d, origId: orig }); draw(); toast('Gespeichert'); } },
      ...(src ? [{ label: 'Löschen', danger: true, onClick: async () => { if (!confirm(`Display „${src.name}“ löschen?`)) return false; M = await call('POST', 'display-delete', { id: src.id }); draw(); } }] : []),
      { label: 'Abbrechen' }]);
  }
  function tile(d) {
    const kb = (d.bytes / 1024).toFixed(1);
    return h('div', { class: 'card', style: 'padding:12px;margin:8px 0' },
      h('div', {}, h('b', {}, `🖥️ ${d.name}`), ' ', h('span', { class: 'hint' }, `(${d.id})`), ' ', h('span', { class: 'pill ' + (d.online ? 'ok' : d.online === false ? 'bad' : '') }, d.online ? 'online' : d.online === false ? 'offline' : 'noch nie gemeldet')),
      h('div', { class: 'hint' }, `${d.pages.length} Seite(n), ${d.pages.reduce((a, p) => a + p.tiles.length, 0)} Kacheln · Helligkeit ${d.bright} % · zuletzt gehört ${ago(d.seen)}`),
      h('div', { class: 'hint' }, `Gesendet: ${d.msgs} Nachrichten (${kb} kB) · übersprungen (keine Änderung): ${d.saved} · Tippen: ${d.taps}`),
      h('div', { class: 'row', style: 'margin-top:8px;gap:6px' }, h('button', { class: 'sm', onclick: () => edit(d) }, 'Bearbeiten'), h('button', { class: 'sm', onclick: () => call('POST', 'resend', { id: d.id }).then(() => toast('Layout und Werte gesendet')).catch(fail) }, 'Alles neu senden')));
  }
  function draw() {
    const el = box(); if (!el || !M) return;
    fill(el, M.displays.length ? M.displays.map(tile) : h('div', { class: 'empty' }, 'Noch kein Display – unten hinzufügen.'),
      h('button', { class: 'primary', onclick: () => edit(null) }, '➕ Display hinzufügen'),
      h('div', { class: 'hint', style: 'margin-top:10px' }, `HomeLite sendet nur Änderungen an den ESP32 (MQTT-Präfix „${M.prefix}“). Protokoll und Firmware-Hinweise: LIESMICH des Plugins.`));
  }
  HL.on('esp32-display', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('esp32-display', {
    label: 'Displays', icon: '🖥️',
    render(el) { el.append(h('h2', { class: 'page-title' }, '🖥️ Displays'), h('div', { id: 'ed-box' })); call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail); },
  });
})();
