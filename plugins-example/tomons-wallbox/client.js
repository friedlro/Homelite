// Seite „Wallbox“: Messwerte, Kabelstatus, Ladestrom-Grenze, Freigabe-Verwaltung
(() => {
  const { h, fill, toast, fail } = HL;
  let M = null, SH = null, shOpen = false;
  const call = (m, sub, body) => HL.api('tomons-wallbox', m, sub, body);
  const n = (v, d, u) => (v == null ? '–' : `${Number(v).toFixed(d)} ${u}`);
  function shareCard() {
    const body = [];
    if (shOpen) {
      if (!SH) body.push(h('div', { class: 'hint' }, 'Lade …'));
      else {
        body.push(h('div', { style: 'margin-top:6px' }, h('b', {}, 'Mit anderen geteilt (meine Wallbox)'),
          (SH.users || []).length ? h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px;margin-top:4px' }, SH.users.map((u) => h('span', { class: 'pill' }, (u.name || u.email || u.user_id || '?') + ' ',
            h('button', { class: 'sm', style: 'margin-left:4px', onclick: (e) => { if (!confirm('Freigabe entfernen?')) return; e.target.disabled = true; call('POST', 'sharerevoke', { userId: u.user_id || u.id }).then(() => { toast('Entfernt'); return loadShare(); }).catch(fail).finally(draw); } }, '✕')))) : h('div', { class: 'hint' }, 'Niemand.')));
        body.push(h('div', { style: 'margin-top:10px' }, h('b', {}, 'Mit mir geteilt'),
          (SH.mine || []).length ? h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px;margin-top:4px' }, SH.mine.map((d) => h('span', { class: 'pill' }, d.name || d.device_name || d.auth_id || '?'))) : h('div', { class: 'hint' }, 'Keine.')));
        body.push(h('div', { style: 'margin-top:10px' }, h('button', { class: 'sm', onclick: (e) => { e.target.disabled = true; call('POST', 'sharegenerate').then((r) => { toast(r.code ? `Code: ${r.code}` : 'Code erzeugt – siehe Protokoll'); }).catch(fail).finally(() => { e.target.disabled = false; }); } }, '+ Freigabecode für diese Wallbox erzeugen')));
      }
    }
    return h('div', { class: 'card', style: 'margin-top:12px;padding:10px' }, h('div', { class: 'row sb' }, h('b', {}, 'Freigabe-Verwaltung'), h('button', { class: 'sm', onclick: () => { shOpen = !shOpen; if (shOpen && !SH) loadShare(); else draw(); } }, shOpen ? 'Schließen' : 'Anzeigen')), body);
  }
  function loadShare() { return call('GET', 'shareinfo').then((r) => { SH = r; draw(); }).catch((e) => { fail(e); draw(); }); }
  function draw() {
    const el = document.getElementById('tw-box'); if (!el || !M) return;
    const t = M.t || {};
    const CABLE = ['Nicht verbunden', 'Verbunden (wartet)', 'Lädt', 'Verbunden (pausiert/fertig)', 'Fehler'];
    const tile = (l, v) => h('div', { class: 'card', style: 'padding:10px;min-width:130px' }, h('div', { class: 'hint' }, l), h('div', { style: 'font-size:1.3em;font-weight:600' }, v));
    fill(el,
      h('div', {}, h('b', {}, M.device ? `${M.device.name} ${M.device.model || ''}` : 'Tomons Wallbox'), ' ', h('span', { class: 'pill ' + (M.status === 'Verbunden' ? 'ok' : M.status === 'Fehler' ? 'bad' : M.status === 'Nur in der App' ? 'warn' : '') }, M.status)),
      M.err ? h('div', { class: 'hint', style: 'color:var(--bad,#d33)' }, M.err) : null,
      h('div', { class: 'hint', style: 'margin:6px 0' }, 'Inoffizielle Anbindung über die Tomons-Cloud (Reverse-Engineering). Ohne Internet keine Werte.'),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' },
        tile('Kabel', t.cable != null ? CABLE[t.cable] : '–'), tile('Leistung', n(t.powerW, 0, 'W')), tile('Strom', n(t.current, 2, 'A')), tile('Spannung', n(t.voltage, 1, 'V')),
        tile('Ladestrom-Grenze', n(t.limitA, 0, 'A')), tile('Ladeenergie', n(t.sessionKwh, 2, 'kWh')), tile('Gesamt', n(t.totalKwh, 2, 'kWh')), tile('Temperatur', n(t.tempC, 0, '°C'))),
      h('div', { style: 'margin-top:12px' }, h('b', {}, 'Ladestrom-Grenze'),
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px;margin-top:6px' }, ...(M.gears || []).map((g) => h('button', { class: 'sm' + (t.limitA === g ? ' primary' : ''), onclick: (e) => { e.target.disabled = true; call('POST', 'limit', { amps: g }).then(() => toast(`${g} A gesendet`)).catch(fail).finally(() => { e.target.disabled = false; }); } }, `${g} A`)))),
      M.startStop ? h('div', { class: 'row', style: 'margin-top:12px;gap:6px' }, h('button', { class: 'sm', onclick: () => call('POST', 'charge', { on: true }).then(() => toast('Start gesendet')).catch(fail) }, '▶ Laden starten'), h('button', { class: 'sm', onclick: () => call('POST', 'charge', { on: false }).then(() => toast('Stopp gesendet')).catch(fail) }, '⏹ Stoppen'), h('span', { class: 'hint' }, 'experimentell')) : null,
      h('div', { class: 'card', style: 'margin-top:12px;padding:10px' }, h('b', {}, 'Freigabecode'),
        h('div', { class: 'hint', style: 'margin:4px 0' }, 'Damit sich App und HomeLite nicht gegenseitig abmelden: in HomeLite ein eigenes Tomons-Konto eintragen (Plugin-Einstellungen), in der App unter „Teilen-Management“ einen Freigabecode erzeugen und hier einlösen. Der Code ist 24 Stunden gültig und wird nicht gespeichert.'),
        (() => { const i = h('input', { placeholder: 'z. B. MKQQA8MW', maxlength: 12, style: 'text-transform:uppercase;max-width:200px', autocapitalize: 'characters' });
          return h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, i, h('button', { class: 'sm primary', onclick: (e) => { e.target.disabled = true; call('POST', 'redeem', { code: i.value }).then(() => { i.value = ''; toast('Freigabecode eingelöst'); }).catch(fail).finally(() => { e.target.disabled = false; }); } }, 'Einlösen')); })()),
      shareCard(),
      h('div', { class: 'row', style: 'margin-top:12px;gap:6px' }, h('button', { class: 'sm', onclick: () => call('POST', 'refresh').then(() => toast('Abfrage gesendet')).catch(fail) }, '↻ Jetzt abfragen'), h('button', { class: 'sm', onclick: () => call('POST', 'reconnect').then(() => toast('Verbinde neu …')).catch(fail) }, 'Neu verbinden')),
      (M.log || []).length ? h('details', { style: 'margin-top:12px' }, h('summary', { class: 'hint' }, 'Protokoll'), h('pre', { class: 'hint', style: 'white-space:pre-wrap' }, M.log.join('\n'))) : null);
  }
  HL.on('tomons-wallbox', (d) => { if (d && d.model) { M = d.model; draw(); } });
  HL.page('tomons-wallbox', {
    label: 'Wallbox', icon: '🔌',
    render(el) { el.append(h('h2', { class: 'page-title' }, '🔌 Wallbox'), h('div', { id: 'tw-box' }, 'Lade …')); call('GET', 'model').then((m) => { M = m; draw(); }).catch(fail); },
  });
})();
