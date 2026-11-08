// Seite „Alarm“: Status und Tastenfeld. Sensoren, Sirenen, Zeiten und PIN: Einstellungen → Erweiterungen → Plugins → Alarmzentrale → ⚙
(() => {
  const { h, fill, toast, fail } = HL;
  let M = null, code = '', tick = null, shake = false;
  const call = (m, sub, body) => HL.api('alarmzentrale', m, sub, body);
  const box = () => document.getElementById('alarm-box');
  const time = (t) => new Date(t).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const COLOR = { disarmed: 'ok', arming: 'warn', armed_home: 'on', armed_away: 'on', pending: 'warn', triggered: 'bad' };
  const ICON = { disarmed: '🔓', arming: '⏳', armed_home: '🏠', armed_away: '🔒', pending: '⚠️', triggered: '🚨' };
  const take = (r) => { M = { ...M, ...r }; draw(); };
  const apply = (p) => p.then(take).catch(fail);

  // ---------- Seite: Status + Tastenfeld + Protokoll ----------
  const press = (k) => {
    if (k === 'C') code = '';
    else if (k === '⌫') code = code.slice(0, -1);
    else if (code.length < 12) code += k;
    drawDisplay();
  };
  function drawDisplay() {
    const d = document.getElementById('alarm-code');
    if (!d) return;
    d.textContent = code ? '●'.repeat(code.length) : (M && M.cfg && M.cfg.hasPin ? 'PIN eingeben' : 'kein PIN eingestellt');
    d.style.opacity = code ? 1 : .5;
  }
  function disarm() {
    const c = code; code = '';
    call('POST', 'disarm', { pin: c }).then(take).catch((e) => { shake = true; fail(e); draw(); });
  }
  function arm(mode) {
    code = '';
    call('POST', 'arm', { mode }).then((r) => { if (r.open && r.open.length) toast('Offen/umgangen: ' + r.open.join(', ')); take(r); }).catch(fail);
  }

  function draw() {
    const el = box();
    if (!el || !M) return;
    const m = M.mode, cd = M.exitEnds || M.entryEnds;
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];
    const keypad = h('div', { style: 'max-width:300px;margin:12px auto 0' },
      h('div', { id: 'alarm-code', style: 'text-align:center;font-size:1.6em;letter-spacing:6px;padding:10px;border-radius:12px;background:var(--panel2);border:1px solid var(--line);min-height:1.6em;' + (shake ? 'animation:alarmshake .35s' : '') }, ''),
      h('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px' },
        keys.map((k) => h('button', { style: 'font-size:1.5em;padding:14px 0;border-radius:14px' + (k === 'C' || k === '⌫' ? ';color:var(--muted)' : ''), onclick: () => press(k) }, k))),
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px' },
        h('button', { class: m === 'armed_home' ? 'primary' : '', style: 'padding:12px 0', onclick: () => arm('home') }, '🏠 Zuhause'),
        h('button', { class: m === 'armed_away' || m === 'arming' ? 'primary' : '', style: 'padding:12px 0', onclick: () => arm('away') }, '🔒 Abwesend')),
      h('button', { class: 'danger', style: 'width:100%;padding:14px 0;margin-top:8px;font-size:1.1em', disabled: m === 'disarmed', onclick: disarm }, '🔓 Unscharf'));
    shake = false;
    fill(el,
      h('div', { style: 'text-align:center;padding:10px 0' },
        h('div', { style: 'font-size:3em' }, ICON[m] || '🚨'),
        h('div', { class: 'pill ' + (COLOR[m] || ''), style: 'font-size:1.2em;padding:4px 16px;margin-top:6px' }, M.label),
        h('div', { class: 'hint', style: 'margin-top:6px' }, (M.trigger ? `Auslöser: ${M.trigger} · ` : '') + 'seit ' + time(M.since) + (M.by ? ' · ' + M.by : '')),
        cd ? h('div', { id: 'alarm-cd', style: 'font-size:1.6em;margin-top:6px' }, '') : null,
        M.bypass && M.bypass.length ? h('div', { class: 'hint', style: 'margin-top:6px' }, 'Umgangen (beim Scharfschalten offen): ' + M.bypass.map((id) => ((M.cfg.sensors.find((s) => s.id === id)) || {}).name || id).join(', ')) : null,
        !M.cfg.sensors.length ? h('div', { class: 'hint', style: 'margin-top:8px' }, 'Noch nicht eingerichtet: Einstellungen → Erweiterungen → Plugins → Alarmzentrale → ⚙ Einstellungen') : null),
      keypad,
      h('div', { class: 'card', style: 'padding:12px;margin-top:16px' }, h('div', { class: 'row sb' }, h('b', {}, '📜 Protokoll'), h('button', { class: 'sm', onclick: () => apply(call('DELETE', 'events')) }, 'Leeren')),
        M.events.length ? M.events.map((e) => h('div', { style: 'padding:4px 0;border-top:1px solid var(--line)' }, h('span', { class: 'hint' }, time(e.t) + '  '), h('span', { style: e.level === 'alarm' ? 'color:var(--bad);font-weight:700' : e.level === 'warn' ? 'color:var(--on)' : '' }, e.text))) : h('div', { class: 'empty' }, 'Noch keine Ereignisse.')));
    drawDisplay();
    clearInterval(tick);
    if (cd) tick = setInterval(() => { const n = document.getElementById('alarm-cd'); if (!n) return clearInterval(tick); n.textContent = Math.max(0, Math.ceil((cd - Date.now()) / 1000)) + ' s'; }, 500);
  }

  // Eingabe auch über die Tastatur (nur solange die Seite offen ist)
  document.addEventListener('keydown', (e) => {
    if (!box() || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '') || document.getElementById('overlay').classList.contains('show')) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Escape') press('C');
    else if (e.key === 'Enter' && code) disarm();
  });
  if (!document.getElementById('alarm-style')) document.head.append(h('style', { id: 'alarm-style' }, '@keyframes alarmshake{0%,100%{transform:translateX(0)}25%{transform:translateX(-8px)}75%{transform:translateX(8px)}}'));

  HL.on('alarmzentrale', (d) => { if (d.model && M) { M = { ...M, ...d.model }; draw(); } });
  HL.page('alarmzentrale', {
    label: 'Alarm', icon: '🚨',
    render(el) {
      code = '';
      el.append(h('h2', { class: 'page-title' }, '🚨 Alarmzentrale'), h('div', { class: 'card', id: 'alarm-box' }));
      call('GET', 'model').then(take).catch(fail);
    },
  });

  // ---------- Plugin-Einstellungen: Sensoren, Sirenen, Zeiten, PIN ----------
  HL.settings('alarmzentrale', {
    title: 'Alarmzentrale – Einstellungen',
    async render(body) {
      let R = await call('GET', 'model');
      const c = R.cfg;
      const draft = JSON.parse(JSON.stringify({ sensors: c.sensors, sirens: c.sirens, lights: c.lights, exitDelay: c.exitDelay, entryDelay: c.entryDelay, sirenSeconds: c.sirenSeconds, notify: c.notify }));
      const toggleId = (arr, id, on) => { const i = arr.indexOf(id); if (on && i < 0) arr.push(id); if (!on && i >= 0) arr.splice(i, 1); };
      const newPin = h('input', { type: 'password', inputmode: 'numeric', placeholder: c.hasPin ? 'neuen PIN setzen' : 'PIN setzen (optional, 4–12 Ziffern)', style: 'width:100%', autocomplete: 'new-password' });
      const save = (extra) => call('POST', 'config', { ...draft, ...extra }).then((r) => { toast('Gespeichert'); take(r); R = r; return r; }).then(() => { fill(body); return HL._settings.get('alarmzentrale').render(body); }).catch(fail);

      const view = () => {
        const byId = new Map(draft.sensors.map((s) => [s.id, s]));
        const sensorRows = R.candidates.length ? R.candidates.map((cd) => {
          const s = byId.get(cd.id);
          const cb = (key, label) => h('label', { style: 'margin-right:12px;white-space:nowrap' }, h('input', { type: 'checkbox', checked: !!(s && s[key]), onchange: (e) => { s[key] = e.target.checked; } }), ' ' + label);
          return h('div', { style: 'padding:8px 0;border-top:1px solid var(--line)' },
            h('label', { class: 'row', style: 'gap:8px' },
              h('input', { type: 'checkbox', checked: !!s, onchange: (e) => { if (e.target.checked) draft.sensors.push({ id: cd.id, name: cd.name, home: false, away: true, delay: false }); else draft.sensors = draft.sensors.filter((x) => x.id !== cd.id); redraw(); } }),
              h('b', {}, cd.name), cd.room ? h('span', { class: 'hint' }, cd.room) : null,
              h('span', { class: 'pill ' + (cd.on ? 'warn' : ''), style: 'margin-left:auto' }, cd.on ? 'aktiv/offen' : 'ruhig')),
            s ? h('div', { style: 'margin:4px 0 0 28px;font-size:.92em' }, cb('home', '🏠 Zuhause'), cb('away', '🔒 Abwesend'), cb('delay', '⏱ verzögert (Eingang)'), R.last[cd.id] ? h('span', { class: 'hint' }, 'zuletzt ' + time(R.last[cd.id])) : null) : null);
        }) : [h('div', { class: 'empty' }, 'Keine Sensoren (Geräte vom Typ „Binär“, z. B. Bewegung, Tür/Fenster, Rauch) gefunden.')];
        const actorList = (key, other, title, hint) => h('div', { style: 'margin-top:8px' }, h('b', {}, title), h('div', { class: 'hint' }, hint),
          R.actors.length ? R.actors.map((a) => h('label', { class: 'row', style: 'gap:8px;padding:5px 0' },
            h('input', { type: 'checkbox', checked: draft[key].includes(a.id), onchange: (e) => { toggleId(draft[key], a.id, e.target.checked); if (e.target.checked) toggleId(draft[other], a.id, false); redraw(); } }),
            a.name, a.room ? h('span', { class: 'hint' }, a.room) : null)) : h('div', { class: 'empty' }, 'Keine Schalter/Lichter vorhanden.'));
        const num = (key, label, hint) => h('label', { style: 'display:block;margin:8px 0' }, h('div', {}, label), h('input', { type: 'number', min: 0, value: draft[key], style: 'width:110px', onchange: (e) => { draft[key] = Number(e.target.value); } }), h('span', { class: 'hint' }, ' ' + hint));
        return [
          h('h2', {}, '📡 Sensoren'), h('div', { class: 'hint' }, 'Alle Geräte vom Typ „Binär“ stehen zur Auswahl. Zuhause = nur Außenhaut (z. B. Türen/Fenster), Abwesend = alles. „Verzögert“ = Eingangstür mit Zeit zum Unscharfschalten.'), sensorRows,
          h('h2', {}, '🔔 Sirenen & Licht'),
          actorList('sirens', 'lights', 'Sirenen', 'Gehen bei Alarm EIN und nach der Sirenendauer wieder AUS.'),
          actorList('lights', 'sirens', 'Licht bei Alarm', 'Gehen bei Alarm EIN und beim Unscharfschalten/Ende wieder AUS (nur wenn sie vorher aus waren).'),
          h('div', { style: 'margin-top:10px' }, h('button', { onclick: () => call('POST', 'test', {}).then(() => toast('Sirenentest (3 s)')).catch(fail) }, '🔊 Sirene testen (3 s)')),
          h('h2', {}, '⏱ Zeiten & Sicherheit'),
          num('exitDelay', 'Ausgangsverzögerung', 's (nur „Abwesend“)'), num('entryDelay', 'Eingangsverzögerung', 's (nur bei „verzögert“)'), num('sirenSeconds', 'Sirenendauer', 's (0 = bis Unscharf)'),
          h('label', { style: 'display:block;margin:8px 0' }, h('input', { type: 'checkbox', checked: draft.notify, onchange: (e) => { draft.notify = e.target.checked; } }), ' Benachrichtigung bei Alarm (Einstellungen → Benachrichtigung)'),
          h('div', { style: 'margin-top:8px' }, newPin),
          c.hasPin ? h('div', { style: 'margin-top:6px' }, h('button', { class: 'sm', onclick: () => save({ removePin: true }) }, 'PIN entfernen')) : null,
          h('div', { class: 'hint' }, 'Der PIN schützt „Unscharf“ am Tastenfeld (5 Fehlversuche = 60 s Sperre). Geräte-Schalter und Automationen schalten ohne PIN.'),
          h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'primary', onclick: () => save({ newPin: newPin.value }) }, 'Einstellungen speichern')),
        ];
      };
      const redraw = () => { const y = body.parentElement ? body.parentElement.scrollTop : 0; fill(body, view()); if (body.parentElement) body.parentElement.scrollTop = y; };
      fill(body, view());
    },
  });
})();
