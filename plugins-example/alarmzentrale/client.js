// Seite „Alarm“: Status, Scharf-/Unscharf-Schaltflächen, Sensoren und Sirenen konfigurieren, Protokoll
(() => {
  const { h, fill, toast, fail } = HL;
  let M = null, draft = null, tick = null;
  const call = (m, sub, body) => HL.api('alarmzentrale', m, sub, body);
  const box = () => document.getElementById('alarm-box');
  const time = (t) => new Date(t).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const COLOR = { disarmed: 'ok', arming: 'warn', armed_home: 'on', armed_away: 'on', pending: 'warn', triggered: 'bad' };
  const ICON = { disarmed: '🔓', arming: '⏳', armed_home: '🏠', armed_away: '🔒', pending: '⚠️', triggered: '🚨' };

  function take(r) {
    M = r;
    if (!draft || r.cfg) {
      const c = r.cfg;
      if (!draft) draft = JSON.parse(JSON.stringify({ sensors: c.sensors, sirens: c.sirens, lights: c.lights, exitDelay: c.exitDelay, entryDelay: c.entryDelay, sirenSeconds: c.sirenSeconds, notify: c.notify }));
    }
    draw();
  }
  const apply = (p) => p.then(take).catch(fail);
  const toggleId = (arr, id, on) => { const i = arr.indexOf(id); if (on && i < 0) arr.push(id); if (!on && i >= 0) arr.splice(i, 1); };

  function pin(then, text) {
    if (!M.cfg.hasPin) return then('');
    const inp = h('input', { type: 'password', inputmode: 'numeric', placeholder: 'PIN', style: 'width:100%;text-align:center;font-size:1.4em', autocomplete: 'off' });
    HL.modal(text || 'PIN eingeben', inp, [{ label: 'Abbrechen' }, { label: 'OK', primary: true, onClick: () => { then(inp.value); } }]);
    setTimeout(() => inp.focus(), 50);
  }

  function draw() {
    const el = box();
    if (!el || !M) return;
    const m = M.mode, c = M.cfg;
    const cd = M.exitEnds || M.entryEnds;
    const big = h('div', { style: 'text-align:center;padding:14px 0' },
      h('div', { style: 'font-size:3em' }, ICON[m] || '🚨'),
      h('div', { class: 'pill ' + (COLOR[m] || ''), style: 'font-size:1.2em;padding:4px 16px;margin-top:6px' }, M.label),
      h('div', { class: 'hint', id: 'alarm-sub', style: 'margin-top:6px' }, (M.trigger ? `Auslöser: ${M.trigger} · ` : '') + 'seit ' + time(M.since) + (M.by ? ' · ' + M.by : '')),
      cd ? h('div', { id: 'alarm-cd', style: 'font-size:1.6em;margin-top:6px' }, '') : null);
    const arm = (mode) => apply(call('POST', 'arm', { mode }).then((r) => { if (r.open && r.open.length) toast('Offen/umgangen: ' + r.open.join(', ')); return r; }));
    const buttons = h('div', { class: 'row', style: 'gap:8px;justify-content:center;flex-wrap:wrap' },
      h('button', { class: m === 'armed_home' ? 'primary' : '', onclick: () => arm('home') }, '🏠 Zuhause scharf'),
      h('button', { class: m === 'armed_away' || m === 'arming' ? 'primary' : '', onclick: () => arm('away') }, '🔒 Abwesend scharf'),
      h('button', { class: 'danger', disabled: m === 'disarmed', onclick: () => pin((p) => apply(call('POST', 'disarm', { pin: p })), 'Unscharf schalten') }, '🔓 Unscharf'));

    // Sensoren
    const byId = new Map(draft.sensors.map((s) => [s.id, s]));
    const sensorRows = M.candidates.length ? M.candidates.map((cd2) => {
      const s = byId.get(cd2.id);
      const cb = (key, label, def) => h('label', { style: 'margin-right:10px;white-space:nowrap' }, h('input', { type: 'checkbox', checked: !!(s && s[key]), disabled: !s, onchange: (e) => { s[key] = e.target.checked; } }), ' ' + label);
      return h('div', { style: 'padding:8px 0;border-top:1px solid var(--line)' },
        h('label', { class: 'row', style: 'gap:8px' },
          h('input', { type: 'checkbox', checked: !!s, onchange: (e) => { if (e.target.checked) draft.sensors.push({ id: cd2.id, name: cd2.name, home: false, away: true, delay: false }); else draft.sensors = draft.sensors.filter((x) => x.id !== cd2.id); draw(); } }),
          h('b', {}, cd2.name), cd2.room ? h('span', { class: 'hint' }, cd2.room) : null,
          h('span', { class: 'pill ' + (cd2.on ? 'warn' : ''), style: 'margin-left:auto' }, cd2.on ? 'aktiv/offen' : 'ruhig')),
        s ? h('div', { style: 'margin:4px 0 0 28px;font-size:.92em' }, cb('home', '🏠 Zuhause'), cb('away', '🔒 Abwesend'), cb('delay', '⏱ verzögert (Eingang)'),
          M.last[cd2.id] ? h('span', { class: 'hint' }, 'zuletzt ' + time(M.last[cd2.id])) : null) : null);
    }) : [h('div', { class: 'empty' }, 'Keine Sensoren (Geräte vom Typ „Binär“, z. B. Bewegung, Tür/Fenster, Rauch) gefunden.')];

    // Sirenen und Licht
    const actorList = (key, title, hint) => h('div', { style: 'margin-top:8px' }, h('b', {}, title), h('div', { class: 'hint' }, hint),
      M.actors.length ? M.actors.map((a) => h('label', { class: 'row', style: 'gap:8px;padding:5px 0' },
        h('input', { type: 'checkbox', checked: draft[key].includes(a.id), onchange: (e) => { toggleId(draft[key], a.id, e.target.checked); if (e.target.checked) toggleId(draft[key === 'sirens' ? 'lights' : 'sirens'], a.id, false); draw(); } }),
        a.name, a.room ? h('span', { class: 'hint' }, a.room) : null)) : h('div', { class: 'empty' }, 'Keine Schalter/Lichter vorhanden.'));

    const num = (key, label, hint) => h('label', { style: 'display:block;margin:8px 0' }, h('div', {}, label), h('input', { type: 'number', min: 0, value: draft[key], style: 'width:110px', onchange: (e) => { draft[key] = Number(e.target.value); } }), h('span', { class: 'hint' }, ' ' + (hint || '')));
    const newPin = h('input', { type: 'password', inputmode: 'numeric', placeholder: c.hasPin ? 'neuen PIN setzen' : 'PIN setzen (optional)', style: 'width:200px', autocomplete: 'off' });
    const save = (extra) => apply(call('POST', 'config', { ...draft, ...extra }).then((r) => { draft = null; toast('Gespeichert'); return r; }));

    fill(el,
      big, buttons,
      M.bypass.length ? h('div', { class: 'hint', style: 'text-align:center;margin-top:8px' }, 'Umgangen (waren beim Scharfschalten offen): ' + M.bypass.map((id) => (byId.get(id) || {}).name || id).join(', ')) : null,
      h('div', { class: 'card', style: 'padding:12px;margin-top:14px' }, h('b', {}, '📡 Sensoren'), h('div', { class: 'hint' }, 'Alle Geräte vom Typ „Binär“ stehen zur Auswahl. Zuhause = nur Außenhaut (z. B. Türen/Fenster), Abwesend = alles. „Verzögert“ = Eingangstür mit Zeit zum Unscharfschalten.'), sensorRows),
      h('div', { class: 'card', style: 'padding:12px;margin-top:10px' }, h('b', {}, '🔔 Sirenen & Licht'),
        actorList('sirens', 'Sirenen', 'Gehen bei Alarm EIN und nach der Sirenendauer wieder AUS.'),
        actorList('lights', 'Licht bei Alarm', 'Gehen bei Alarm EIN und beim Unscharfschalten/Ende wieder AUS (nur wenn sie vorher aus waren).'),
        h('div', { style: 'margin-top:10px' }, h('button', { onclick: () => call('POST', 'test', {}).then(() => toast('Sirenentest (3 s)')).catch(fail) }, '🔊 Sirene testen'))),
      h('div', { class: 'card', style: 'padding:12px;margin-top:10px' }, h('b', {}, '⏱ Zeiten & Sicherheit'),
        num('exitDelay', 'Ausgangsverzögerung', 's (nur „Abwesend“)'), num('entryDelay', 'Eingangsverzögerung', 's (nur bei „verzögert“)'), num('sirenSeconds', 'Sirenendauer', 's (0 = bis Unscharf)'),
        h('label', { style: 'display:block;margin:8px 0' }, h('input', { type: 'checkbox', checked: draft.notify, onchange: (e) => { draft.notify = e.target.checked; } }), ' Benachrichtigung bei Alarm (Einstellungen → Benachrichtigung)'),
        h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin-top:8px' }, newPin, c.hasPin ? h('button', { class: 'sm', onclick: () => save({ removePin: true }) }, 'PIN entfernen') : null),
        h('div', { class: 'hint' }, 'Der PIN schützt „Unscharf“ in dieser Oberfläche. Geräte-Schalter und Automationen schalten ohne PIN.')),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'primary', onclick: () => save({ newPin: newPin.value }) }, 'Einstellungen speichern')),
      h('div', { class: 'card', style: 'padding:12px;margin-top:14px' }, h('div', { class: 'row sb' }, h('b', {}, '📜 Protokoll'), h('button', { class: 'sm', onclick: () => apply(call('DELETE', 'events')) }, 'Leeren')),
        M.events.length ? M.events.map((e) => h('div', { style: 'padding:4px 0;border-top:1px solid var(--line)' }, h('span', { class: 'hint' }, time(e.t) + '  '), h('span', { style: e.level === 'alarm' ? 'color:var(--bad);font-weight:700' : e.level === 'warn' ? 'color:var(--on)' : '' }, e.text))) : h('div', { class: 'empty' }, 'Noch keine Ereignisse.')));
    clearInterval(tick);
    if (cd) tick = setInterval(() => { const n = document.getElementById('alarm-cd'); if (!n) return clearInterval(tick); n.textContent = Math.max(0, Math.ceil((cd - Date.now()) / 1000)) + ' s'; }, 500);
  }

  HL.on('alarmzentrale', (d) => { if (d.model) { M = { ...M, ...d.model, candidates: M ? M.candidates : [], actors: M ? M.actors : [] }; if (M.cfg) draw(); } });
  HL.page('alarmzentrale', {
    label: 'Alarm', icon: '🚨',
    render(el) {
      draft = null;
      el.append(h('h2', { class: 'page-title' }, '🚨 Alarmzentrale'), h('div', { class: 'card', id: 'alarm-box' }));
      call('GET', 'model').then(take).catch(fail);
    },
  });
})();
