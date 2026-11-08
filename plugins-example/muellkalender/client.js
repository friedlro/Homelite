// Müll-Seite: Anmeldung (CITIES-App), Gemeinde und Kalender per Dropdown, kommende Termine
(() => {
  const { h, fill } = HL;
  const API = (m, sub, body) => HL.api('muellkalender', m, sub, body);
  let s = null;
  let cities = null; // [{id,name}]
  let cals = null; // { v2, calendars }
  let cityPick = null;
  let editing = false;
  const day = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('de-AT', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const rel = (n) => (n === 0 ? 'heute' : n === 1 ? 'morgen' : n === 2 ? 'übermorgen' : `in ${n} Tagen`);
  const apply = (r) => { if (r.status) s = r.status; drawStatus(); drawSetup(); };

  const drawStatus = () => {
    const box = document.getElementById('muell-box');
    if (!box) return;
    if (!s) return fill(box, h('div', { class: 'empty' }, 'Lade …'));
    if (!s.configured) return fill(box, h('div', { class: 'empty' }, 'Noch nicht eingerichtet – unten Konto und Gemeinde eintragen.'));
    const groups = {};
    for (const e of s.upcoming) (groups[e.date] = groups[e.date] || []).push(e);
    fill(box,
      h('div', { class: 'row sb' }, h('div', {}, h('b', {}, `${s.selection.cityName} – ${s.selection.calendarName}`),
        h('div', { class: 'hint' }, s.last ? `Stand ${new Date(s.last).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'noch nicht geladen')),
        h('button', { onclick: () => API('POST', 'refresh', {}).then(apply).catch(HL.fail) }, '↻ Aktualisieren')),
      s.error ? h('div', { class: 'hint', style: 'color:var(--bad)' }, s.error) : null,
      Object.keys(groups).length ? Object.entries(groups).map(([d, l]) => h('div', { class: 'row sb', style: 'padding:8px 0;border-top:1px solid var(--line)' },
        h('div', {}, h('b', {}, [...new Set(l.map((x) => x.type))].join(', ')), h('div', { class: 'hint' }, day(d))),
        h('span', { class: 'pill ' + (l[0].days <= 1 ? 'ok' : '') }, rel(l[0].days)))) : h('div', { class: 'hint' }, 'Keine kommenden Termine.'));
  };

  const drawSetup = () => {
    const box = document.getElementById('muell-setup');
    if (!box || !s) return;
    const parts = [];
    const user = h('input', { value: s.username || '', placeholder: 'E-Mail oder Telefonnummer (+43…)', style: 'width:100%', autocomplete: 'off' });
    const pass = h('input', { type: 'password', placeholder: s.hasPassword ? '(gespeichert – leer lassen = unverändert)' : 'Passwort der CITIES-App', style: 'width:100%', autocomplete: 'new-password' });
    const login = () => API('POST', 'login', { username: user.value, password: pass.value }).then((r) => { apply(r); HL.toast('Angemeldet'); loadCities(); }).catch(HL.fail);
    parts.push(h('b', {}, '1. Konto der CITIES-App'),
      h('div', { class: 'hint' }, 'Der Müllkalender kommt aus der CITIES-App deiner Gemeinde. Dafür braucht es dein Konto aus der App (Gastzugang gibt es nicht mehr).'),
      h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin:8px 0' }, user, pass),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: login }, s.loggedIn ? 'Neu anmelden' : 'Anmelden'),
        s.loggedIn ? h('button', { class: 'danger', onclick: () => { if (confirm('Konto und Auswahl entfernen?')) API('DELETE', 'account').then((r) => { cities = null; cals = null; apply(r); }).catch(HL.fail); } }, 'Entfernen') : null));
    if (s.loggedIn) {
      parts.push(h('div', { style: 'height:14px' }), h('b', {}, '2. Gemeinde und Kalender'));
      if (!cities) parts.push(h('div', { class: 'hint' }, h('button', { onclick: loadCities }, 'Gemeinden laden')));
      else {
        const filter = h('input', { placeholder: 'Gemeinde suchen …', style: 'width:100%' });
        const citySel = h('select', { style: 'width:100%', onchange: (e) => { cityPick = cities.find((c) => c.id === e.target.value) || null; cals = null; if (cityPick) loadCals(); else drawSetup(); } });
        const fillCities = () => { const q = filter.value.trim().toLowerCase(); const l = cities.filter((c) => !q || c.name.toLowerCase().includes(q)); fill(citySel, h('option', { value: '' }, `Gemeinde wählen (${l.length})`), l.map((c) => h('option', { value: c.id, selected: cityPick && cityPick.id === c.id }, c.name))); };
        filter.oninput = fillCities; fillCities();
        parts.push(h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin:8px 0' }, filter, citySel));
        if (cityPick && cals) {
          const calSel = h('select', { style: 'width:100%' }, cals.calendars.map((c) => h('option', { value: c.id }, c.name)));
          if (s.selection && s.selection.cityId === cityPick.id) calSel.value = s.selection.calendarId;
          parts.push(h('div', { class: 'hint' }, cals.calendars.length ? 'Kalender (Abfuhrgebiet bzw. Straße):' : 'Diese Gemeinde bietet in der CITIES-App keinen Müllkalender an.'),
            cals.calendars.length ? h('div', { class: 'row', style: 'margin:6px 0' }, h('div', { style: 'flex:1' }, calSel),
              h('button', { class: 'primary', onclick: () => { const c = cals.calendars.find((x) => x.id === calSel.value); API('POST', 'select', { cityId: cityPick.id, cityName: cityPick.name, calendarId: c.id, calendarName: c.name }).then((r) => { apply(r); HL.toast('Gespeichert'); }).catch(HL.fail); } }, 'Speichern')) : null);
        } else if (cityPick) parts.push(h('div', { class: 'hint' }, 'Lade Kalender …'));
      }
    }
    fill(box, parts);
  };
  const loadCities = () => API('GET', 'cities').then((r) => { cities = r.cities; if (s && s.selection) cityPick = cities.find((c) => c.id === s.selection.cityId) || null; drawSetup(); if (cityPick && !cals) loadCals(); }).catch(HL.fail);
  const loadCals = () => { const p = cityPick; API('GET', 'calendars?city=' + encodeURIComponent(p.id)).then((r) => { if (cityPick === p) { cals = r; drawSetup(); } }).catch(HL.fail); };

  HL.on('muellkalender', (d) => { if (d.status) { s = d.status; drawStatus(); } });
  HL.page('muellkalender', {
    label: 'Müll', icon: '🗑',
    render(el) {
      el.append(h('h2', { class: 'page-title' }, '🗑 Müllkalender'), h('div', { class: 'card', id: 'muell-box' }), h('div', { class: 'card', id: 'muell-setup' }));
      drawStatus();
      API('GET', 'status').then((r) => { apply(r); if (s.loggedIn && !cities) loadCities(); }).catch(HL.fail);
    },
  });
})();
