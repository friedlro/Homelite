// Seite „Kameras“: Kacheln mit letztem Bild und Ereignissen, Live-Ansicht mit Schwenken, Kamera hinzufügen
(() => {
  const { h, fill, toast, fail, modal, fld } = HL;
  let M = null; const imgs = new Map(); const asked = new Map();
  const call = (m, sub, body) => HL.api('tapo-kamera', m, sub, body);
  const box = () => document.getElementById('tp-box');
  const ago = (t) => { if (!t) return ''; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `vor ${s} s` : s < 3600 ? `vor ${Math.round(s / 60)} min` : s < 86400 ? `vor ${Math.round(s / 3600)} h` : new Date(t).toLocaleDateString('de-AT'); };

  function loadSnap(c) {
    if (!c.snap || asked.get(c.id) === c.snap.t) return;
    asked.set(c.id, c.snap.t);
    call('GET', 'snap/' + c.id).then((r) => { if (r.img) { imgs.set(c.id, r.img); const el = document.getElementById('tp-img-' + c.id); if (el) el.src = r.img; } }).catch(() => {});
  }
  function snapshot(c, btn) {
    if (btn) btn.disabled = true;
    call('POST', 'snapshot', { id: c.id }).then((r) => { imgs.set(c.id, r.img); asked.set(c.id, r.t); const el = document.getElementById('tp-img-' + c.id); if (el) el.src = r.img; }).catch(fail).finally(() => { if (btn) btn.disabled = false; });
  }

  function form(c) {
    const v = c || { name: '', host: '', port: 2020, user: '', room: '', stream: 'hd', url: '' };
    const f = { name: h('input', { value: v.name, placeholder: 'z. B. Garten' }), host: h('input', { value: v.host, placeholder: '192.168.50.x' }), port: h('input', { type: 'number', value: v.port }),
      user: h('input', { value: v.user, autocomplete: 'off' }), pass: h('input', { type: 'password', placeholder: c ? 'unverändert' : '', autocomplete: 'new-password' }), room: h('input', { value: v.room, placeholder: 'optional' }),
      stream: h('select', {}, [['hd', 'Hauptstream (HD)'], ['sd', 'Zweitstream (SD, spart Rechenleistung)']].map(([k, l]) => h('option', { value: k, selected: v.stream === k }, l))), url: h('input', { value: v.url, placeholder: 'nur bei Sonderfällen: rtsp://…' }) };
    const body = () => ({ id: c && c.id, name: f.name.value, host: f.host.value, port: f.port.value, user: f.user.value, pass: f.pass.value, room: f.room.value, stream: f.stream.value, url: f.url.value });
    const res = h('div', { class: 'hint', style: 'margin-top:6px' });
    const el = h('div', { class: 'form' }, h('div', { class: 'hint' }, 'Benutzer und Passwort sind das „Kamerakonto“ aus der Tapo-App (Kamera → Einstellungen → Erweitert → Kamerakonto) – nicht dein TP-Link-Konto. Zusätzlich in den Kameraeinstellungen „ONVIF“ bzw. „Kamerakonto“ aktivieren.'),
      fld('Name', f.name), fld('IP-Adresse der Kamera', f.host), fld('Benutzer (Kamerakonto)', f.user), fld('Passwort', f.pass), fld('Raum', f.room), fld('Bildqualität', f.stream), fld('ONVIF-Port', f.port), fld('RTSP-Adresse (optional)', f.url), res);
    return { el, body, res };
  }
  function edit(c) {
    const fm = form(c);
    modal(c ? `Kamera „${c.name}“ bearbeiten` : 'Kamera hinzufügen', fm.el, [
      { label: 'Verbindung testen', onClick: async () => { fm.res.textContent = 'Teste …'; try { const r = await call('POST', 'test', fm.body()); fm.res.textContent = `✓ Verbunden: ${r.info.vendor || ''} ${r.info.model} (Firmware ${r.info.fw})${r.ptz ? ', schwenkbar' : ''}`; } catch (e) { fm.res.textContent = '✗ ' + e.message; } return false; } },
      ...(c ? [{ label: 'Löschen', danger: true, onClick: async () => { if (!confirm(`Kamera „${c.name}“ und ihre Geräte löschen?`)) return false; M = await call('POST', 'cam-delete', { id: c.id }); draw(); } }] : []),
      { label: 'Speichern', primary: true, onClick: async () => { M = await call('POST', 'cam', fm.body()); draw(); toast('Gespeichert'); } },
      { label: 'Abbrechen' }]);
  }

  function live(c) {
    const img = h('img', { style: 'width:100%;border-radius:8px;background:#000;min-height:180px', src: imgs.get(c.id) || '' });
    const msg = h('div', { class: 'hint' }, 'Verbinde …');
    const sel = h('select', { style: 'max-width:160px' }, h('option', { value: '' }, 'Position …'));
    let run = true;
    const loop = async () => {
      while (run && document.body.contains(img)) {
        try { const r = await call('GET', 'frame/' + c.id); if (r.img) { img.src = r.img; msg.textContent = 'Live (2 Bilder/s)'; } } catch (e) { msg.textContent = e.message; await new Promise((r) => setTimeout(r, 3000)); }
        await new Promise((r) => setTimeout(r, 500));
      }
    };
    const pad = (txt, x, y) => { const b = h('button', { style: 'width:52px;height:44px;font-size:1.2em' }, txt); const go = (e) => { e.preventDefault(); call('POST', 'move', { id: c.id, x, y }).catch(fail); }; b.addEventListener('pointerdown', go); b.addEventListener('pointerup', () => call('POST', 'stop', { id: c.id }).catch(() => {})); return b; };
    const ctrl = c.ptz ? h('div', {}, h('div', { style: 'display:grid;grid-template-columns:repeat(3,52px);gap:6px;justify-content:center;margin:10px 0' }, h('span'), pad('▲', 0, 0.5), h('span'), pad('◀', -0.5, 0), pad('▼', 0, -0.5), pad('▶', 0.5, 0)), h('div', { class: 'row', style: 'justify-content:center;gap:8px' }, sel)) : null;
    if (c.ptz) { call('GET', 'presets/' + c.id).then((r) => { r.presets.forEach((p) => sel.append(h('option', { value: p.token }, p.name))); sel.onchange = () => { if (sel.value) call('POST', 'preset', { id: c.id, token: sel.value }).catch(fail); }; }).catch(() => {}); }
    modal(c.name, h('div', {}, img, msg, ctrl), [{ label: 'Schließen', onClick: () => { run = false; } }]);
    loop();
  }

  function tile(c) {
    loadSnap(c);
    const ev = Object.values(c.events || {}).filter((e) => e.on).map((e) => e.label);
    const pill = !c.online ? h('span', { class: 'pill bad', title: c.err }, c.err ? 'getrennt' : 'verbinde …') : ev.length ? h('span', { class: 'pill', style: 'background:var(--warn,#f5a623);color:#000' }, ev.join(' · ')) : h('span', { class: 'pill ok' }, 'bereit');
    return h('div', { class: 'card', style: 'padding:10px;margin:10px 0' },
      h('div', { class: 'row sb' }, h('div', { style: 'min-width:0' }, h('b', {}, c.name), h('div', { class: 'hint' }, [c.info && c.info.model, c.room, c.lastEvent ? `${c.lastEvent.label} ${ago(c.lastEvent.t)}` : null].filter(Boolean).join(' · '))), pill),
      !c.online && c.err ? h('div', { class: 'hint', style: 'color:var(--bad);margin-top:4px' }, c.err) : null,
      h('div', { style: 'margin:8px 0;position:relative;background:#0002;border-radius:8px;min-height:90px;overflow:hidden' }, h('img', { id: 'tp-img-' + c.id, src: imgs.get(c.id) || '', style: 'width:100%;display:block' + (imgs.get(c.id) ? '' : ';height:0'), onclick: () => live(c) }),
        imgs.get(c.id) ? null : h('div', { class: 'hint', style: 'padding:30px;text-align:center' }, 'Noch kein Bild – „Standbild“ oder „Live“.')),
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, h('button', { class: 'primary', onclick: () => live(c) }, '▶ Live'), h('button', { onclick: (e) => snapshot(c, e.target) }, '📷 Standbild'), h('button', { onclick: () => edit(c) }, '⚙'), h('button', { onclick: () => call('POST', 'reconnect', { id: c.id }).then(() => toast('Verbinde neu …')).catch(fail) }, '↻')));
  }

  function draw() {
    const el = box(); if (!el || !M) return;
    fill(el, M.cams.length ? M.cams.map(tile) : h('div', { class: 'empty' }, 'Noch keine Kamera – unten hinzufügen.'),
      h('button', { class: 'primary', onclick: () => edit(null) }, '➕ Kamera hinzufügen'),
      h('div', { class: 'hint', style: 'margin-top:10px' }, 'Bewegung, Person, Fahrzeug, Tier und Sabotage erscheinen automatisch als Geräte (je Kamera). Für Standbild und Live-Ansicht muss auf dem Server ffmpeg installiert sein (sudo apt install ffmpeg).'));
  }

  HL.on('tapo-kamera', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('tapo-kamera', {
    label: 'Kameras', icon: '📹',
    render(el) { el.append(h('h2', { class: 'page-title' }, '📹 Kameras'), h('div', { id: 'tp-box' })); call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail); },
  });
})();
