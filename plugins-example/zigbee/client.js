// Seite „Zigbee direkt“: Dongle-Status, Anlernen, Geräte, Kanal, Backup/Restore, Installation
(() => {
  const { h, fill, toast, fail, modal } = HL;
  let M = null, tick = null, BK = null, scan = null, open = new Set(), fl = '';
  const call = (m, sub, body) => HL.api('zigbee', m, sub, body);
  const box = () => document.getElementById('zg-box');
  const when = (s) => (s ? new Date(s).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
  const ago = (ts) => { if (!ts) return '–'; const s = Math.max(0, Date.now() / 1000 - ts); return s < 90 ? 'gerade eben' : s < 5400 ? Math.round(s / 60) + ' min' : s < 172800 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' Tage'; };
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' kB');
  const saveFile = (name, mime, text) => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: mime })), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
  const STATES = { online: ['ok', 'verbunden'], starting: ['', 'verbindet …'], stopped: ['', 'angehalten'], error: ['bad', 'Fehler'], noenv: ['bad', 'nicht installiert'], config: ['bad', 'nicht konfiguriert'] };
  const POWER = (p) => String(p || '').replace(/^PowerSource\./, '').replace('Mains', 'Netz').replace('Battery', 'Batterie');
  const lqiPill = (v) => (v === null || v === undefined ? h('span', { class: 'hint' }, '–') : h('span', { class: 'pill ' + (v >= 100 ? 'ok' : v >= 50 ? '' : 'bad') }, 'LQI ' + v));

  // ---- Dongle ----
  function dongleCard() {
    const [cls, txt] = STATES[M.status] || ['', M.status];
    const I = M.info || {}, C = M.conn || {};
    const ziel = C.connection === 'usb' ? (C.device || 'USB-Pfad fehlt') : `${C.host || 'Adresse fehlt'}:${C.port}`;
    const online = M.status === 'online';
    const chSel = h('select', { style: 'max-width:90px' }, Array.from({ length: 16 }, (_, i) => 11 + i).map((c) => h('option', { value: c, selected: c === I.channel }, String(c))));
    return h('div', { class: 'card', style: 'padding:12px;margin:10px 0' },
      h('div', { class: 'row sb' }, h('b', {}, '📡 Funk-Dongle'), h('span', { class: 'pill ' + cls }, txt)),
      h('div', { class: 'hint', style: 'margin-top:6px' }, `${C.radio.toUpperCase()} · ${ziel}${C.connection === 'usb' ? '' : ' (Netzwerk)'} · ${C.baudrate} Baud`),
      online ? h('div', { class: 'hint', style: 'margin-top:4px' }, [`Kanal ${I.channel}`, I.pan_id ? `PAN ${I.pan_id}` : '', I.manufacturer || I.model ? [I.manufacturer, I.model].filter(Boolean).join(' ') : '', I.version ? 'Firmware ' + I.version : '', I.coordinator_ieee ? 'IEEE ' + I.coordinator_ieee : '', `${I.devices ?? M.devices.length} Geräte`].filter(Boolean).join(' · ')) : null,
      M.code === 'mismatch' && M.detail ? h('div', { style: 'margin-top:8px;padding:8px;border:1px solid var(--bad);border-radius:8px' },
        h('b', {}, 'Das Zigbee-Netz auf dem Dongle ist ein anderes als in der Datenbank des Plugins'),
        h('div', { class: 'hint', style: 'margin-top:4px' }, `Dongle jetzt: Kanal ${M.detail.dongle.channel}, PAN ${M.detail.dongle.pan_id}, Adresse ${M.detail.dongle.ieee}`),
        h('div', { class: 'hint' }, `Gespeichert (${when(M.detail.database.time)}): Kanal ${M.detail.database.channel}, PAN ${M.detail.database.pan_id}, Adresse ${M.detail.database.ieee}`),
        h('div', { class: 'hint', style: 'margin-top:4px' }, 'Das passiert z. B. nach einem anderen Dongle, einem Zurücksetzen oder wenn zwischendurch ein anderes Programm (Zigbee2MQTT …) ein Netz angelegt hat. Das Plugin überschreibt nichts, solange du nicht entscheidest:'),
        h('div', { class: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' },
          h('button', { class: 'sm primary', onclick: () => { if (confirm('Netz des Dongles übernehmen?\n\nDie bisherige Datenbank wird beiseitegelegt (zigbee.db.bak-…, nicht gelöscht). Geräte aus dem alten Netz sind danach nicht mehr in der Liste und müssen neu angelernt werden, falls sie nicht zum Netz des Dongles gehören.')) call('POST', 'mismatch', { mode: 'adopt' }).catch(fail); } }, 'Netz des Dongles übernehmen'),
          h('button', { class: 'sm danger', onclick: () => { if (confirm('Gespeichertes Netz auf den Dongle zurückschreiben?\n\nDas Netz auf dem Dongle (Kanal ' + M.detail.dongle.channel + ', PAN ' + M.detail.dongle.pan_id + ') wird überschrieben. Geräte, die dort angelernt sind, verlieren die Verbindung.')) call('POST', 'mismatch', { mode: 'restore' }).catch(fail); } }, 'Gespeichertes Netz auf Dongle schreiben'))) : null,
      !online && M.msg && M.code !== 'mismatch' ? h('div', { class: 'hint', style: 'margin-top:4px;color:' + (M.status === 'error' ? 'var(--bad)' : 'inherit') }, M.msg) : null,
      M.status === 'error' && M.code !== 'mismatch' ? h('div', { class: 'hint', style: 'margin-top:4px' }, 'Es wird alle 30 Sekunden neu versucht. Der Dongle kann nur von EINEM Programm gehalten werden: Zigbee2MQTT, Home Assistant/ZHA und das Zigbee2MQTT-Plugin müssen beendet sein. Dongle Max: Modus „Zigbee Coordinator“ (TCP), Port 6638.') : null,
      h('div', { class: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' },
        !online ? h('button', { class: 'sm primary', onclick: () => call('POST', 'start', {}).then(() => toast('Verbinde …')).catch(fail) }, '▶ Verbinden') : h('button', { class: 'sm', onclick: () => call('POST', 'stop', {}).then(() => toast('Angehalten')).catch(fail) }, '⏹ Trennen'),
        C.connection !== 'usb' ? h('button', { class: 'sm', onclick: () => call('POST', 'test', {}).then((r) => toast(r.msg, !r.ok)).catch(fail) }, '✔ Port testen') : null,
        online ? [h('span', { class: 'hint' }, 'Kanal wechseln:'), chSel,
          h('button', { class: 'sm', onclick: (e) => { const c = Number(chSel.value); if (c === I.channel) return toast('Schon auf Kanal ' + c); if (!confirm(`Funkkanal von ${I.channel} auf ${c} wechseln?\n\nGeräte folgen automatisch; batteriebetriebene Geräte brauchen manchmal Minuten bis Stunden, im Zweifel neu anlernen. Vorher wird ein Backup erstellt.`)) return; e.target.disabled = true; call('POST', 'channel', { channel: c }).then(() => toast('Kanal gewechselt')).catch(fail).finally(() => { e.target.disabled = false; }); } }, 'Wechseln'),
          h('button', { class: 'sm', onclick: (e) => { e.target.disabled = true; e.target.textContent = 'Scanne …'; call('POST', 'scan', {}).then((r) => { scan = r.scan; draw(); }).catch((x) => { fail(x); draw(); }); } }, '📶 Kanäle prüfen')] : null),
      scan ? h('div', { style: 'margin-top:8px' }, h('div', { class: 'hint' }, 'Funk-Auslastung je Kanal (weniger ist besser, 0–255):'),
        h('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap;margin-top:4px' }, Object.entries(scan).sort((a, b) => Number(a[0]) - Number(b[0])).map(([c, v]) => h('span', { class: 'pill ' + (v < 60 ? 'ok' : v < 140 ? '' : 'bad') }, `${c}: ${v}`)))) : null);
  }

  // ---- Installation ----
  function envCard() {
    const E = M.env || {};
    if (E.ready && !E.busy && E.ok !== false) return null;
    return h('div', { class: 'card', style: 'padding:12px;margin:10px 0' },
      h('div', { class: 'row sb' }, h('b', {}, '🧩 Zigbee-Software'), h('span', { class: 'pill ' + (E.ready ? 'ok' : 'bad') }, E.busy ? 'läuft …' : E.ready ? 'installiert' : 'fehlt')),
      h('div', { class: 'hint', style: 'margin-top:4px' }, 'Das Plugin braucht Python 3.12+ mit zigpy, bellows, zha und zha-quirks (Download von pypi.org, ca. 100 MB, einige Minuten). Es wird in einer eigenen Umgebung im Plugin-Ordner installiert und verändert das System nicht.'),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'sm primary', disabled: !!E.busy, onclick: () => call('POST', 'install', {}).then(() => toast('Installation gestartet')).catch(fail) }, E.busy ? 'Installiere …' : '⬇ Installieren')),
      E.log && E.log.length ? h('pre', { style: 'margin:8px 0 0;max-height:180px;overflow:auto;font-size:11px;white-space:pre-wrap' }, E.log.slice(-25).join('\n')) : null);
  }

  // ---- Anlernen ----
  function joinCard() {
    const joining = M.join && M.join > Date.now();
    return h('div', { class: 'card', style: 'padding:12px;margin:10px 0' },
      h('div', { class: 'row sb' }, h('b', {}, '➕ Gerät anlernen'), joining ? h('span', { class: 'pill ok' }, 'offen ', h('span', { id: 'zg-cd' }, Math.max(0, Math.ceil((M.join - Date.now()) / 1000)) + ' s')) : null),
      h('div', { class: 'hint', style: 'margin-top:4px' }, 'Anlernen öffnen, dann am Gerät den Pairing-Modus starten (bei den meisten Geräten Reset-Taste ca. 5 s drücken oder Gerät 5× ein-/ausschalten). Das Gerät erscheint danach automatisch.'),
      h('div', { class: 'row', style: 'gap:8px;margin-top:8px' },
        h('button', { class: 'sm primary', disabled: M.status !== 'online', onclick: () => call('POST', 'permit', { time: 120 }).then(() => toast('Anlernen für 2 Minuten offen')).catch(fail) }, '120 s öffnen'),
        joining ? h('button', { class: 'sm', onclick: () => call('POST', 'permit', { time: 0 }).catch(fail) }, 'Schließen') : null));
  }

  // ---- Geräte ----
  function entityRow(d, e) {
    const s = e.state || {};
    const v = s.native_value !== undefined ? s.native_value : s.is_on !== undefined ? (s.is_on ? 'an' : 'aus') : s.on !== undefined ? (s.on ? 'an' : 'aus') : s.current_position !== undefined ? s.current_position + ' %' : s.is_locked !== undefined ? (s.is_locked ? 'verriegelt' : 'offen') : s.current_temperature !== undefined ? s.current_temperature + ' °C' : s.state !== undefined ? s.state : s.current_option !== undefined ? s.current_option : '';
    const label = h('span', {}, `${e.platform} · ${e.name || e.device_class || e.uid.slice(-12)}`, e.category ? ` (${e.category})` : '');
    let ctl = null;
    if (e.platform === 'number') { const i = h('input', { type: 'number', value: s.state ?? s.native_value ?? v, min: e.min ?? '', max: e.max ?? '', step: e.step ?? 'any', style: 'width:90px' }); ctl = [i, h('button', { class: 'sm', onclick: () => call('POST', 'entity', { ieee: d.ieee, uid: e.uid, value: i.value }).then(() => toast('Gesetzt')).catch(fail) }, 'OK')]; }
    else if (e.platform === 'select') { const opts = e.options || s.options || []; const sl = h('select', {}, opts.map((o) => h('option', { value: o, selected: o === (s.current_option ?? s.state) }, o))); ctl = [sl, h('button', { class: 'sm', onclick: () => call('POST', 'entity', { ieee: d.ieee, uid: e.uid, value: sl.value }).then(() => toast('Gesetzt')).catch(fail) }, 'OK')]; }
    else if (e.platform === 'button') ctl = h('button', { class: 'sm', onclick: () => call('POST', 'entity', { ieee: d.ieee, uid: e.uid }).then(() => toast('Ausgeführt')).catch(fail) }, 'Auslösen');
    else if (e.platform === 'switch' && (e.category === 'config' || e.category === 'diagnostic')) ctl = h('button', { class: 'sm', onclick: () => call('POST', 'entity', { ieee: d.ieee, uid: e.uid, value: !s.is_on }).then(() => toast('Gesetzt')).catch(fail) }, s.is_on ? 'ausschalten' : 'einschalten');
    return h('div', { class: 'row sb', style: 'gap:6px;padding:3px 0;flex-wrap:wrap' }, h('div', { class: 'hint' }, label, ' ', h('span', { style: e.mapped ? 'color:var(--ok,#2a2)' : '' }, e.mapped ? '→ HomeLite-Gerät' : '')), h('div', { class: 'row', style: 'gap:6px' }, h('b', {}, v === null || v === undefined ? '' : String(v) + (e.unit ? ' ' + e.unit : '')), ctl));
  }
  function devCard(d) {
    const isOpen = open.has(d.ieee);
    const nameIn = h('input', { value: d.name }), roomIn = h('input', { value: d.room || '', placeholder: 'Raum' });
    return h('div', { class: 'card', style: 'padding:10px;margin:8px 0' },
      h('div', { class: 'row sb', style: 'gap:8px;flex-wrap:wrap;cursor:pointer', onclick: () => { if (isOpen) open.delete(d.ieee); else open.add(d.ieee); draw(); } },
        h('div', {}, h('b', {}, (d.available ? '' : '⚠ ') + d.name), ' ', h('span', { class: 'hint' }, `${d.manufacturer || '?'} ${d.model || '?'}`)),
        h('div', { class: 'row', style: 'gap:6px' }, d.battery !== null ? h('span', { class: 'pill ' + (d.battery < 20 ? 'bad' : '') }, '🔋 ' + Math.round(d.battery) + ' %') : null, lqiPill(d.lqi), h('span', { class: 'pill ' + (d.available ? 'ok' : 'bad') }, d.available ? 'erreichbar' : 'nicht erreichbar'))),
      isOpen ? h('div', { style: 'margin-top:8px' },
        h('div', { class: 'hint' }, [`IEEE ${d.ieee}`, `Adresse ${d.nwk}`, POWER(d.power), String(d.type || '').replace('DeviceType.', ''), d.sw ? 'FW ' + d.sw : '', `zuletzt gesehen ${ago(d.last_seen)}`].filter(Boolean).join(' · ')),
        h('div', { class: 'hint', style: 'margin-top:2px' }, d.quirk ? `Treiber (Quirk): ${d.quirk}` : 'Standard-Zigbee-Profil (kein Sonderfall nötig)'),
        h('div', { style: 'margin-top:8px' }, d.entities.length ? d.entities.map((e) => entityRow(d, e)) : h('div', { class: 'hint' }, 'Keine Entitäten erkannt – „Neu abfragen“ versuchen. Bei unbekannten Geräten hilft ein Hinweis mit Hersteller/Modell (siehe LIESMICH, „Gerät wird nicht unterstützt“).')),
        d.endpoints.length ? h('details', { style: 'margin-top:6px' }, h('summary', { class: 'hint' }, 'Technisch: Endpunkte und Cluster'), d.endpoints.map((p) => h('div', { class: 'hint', style: 'font-family:monospace;font-size:11px' }, `EP${p.ep} Profil 0x${(p.profile || 0).toString(16)} Typ ${p.device_type}  in: ${p.in.join(' ')}  out: ${p.out.join(' ')}`))) : null,
        h('div', { class: 'row', style: 'gap:6px;margin-top:8px;flex-wrap:wrap' }, nameIn, roomIn,
          h('button', { class: 'sm', onclick: () => call('POST', 'rename', { ieee: d.ieee, name: nameIn.value, room: roomIn.value }).then((r) => toast(r.note || 'Gespeichert')).catch(fail) }, 'Name/Raum'),
          h('button', { class: 'sm', onclick: () => call('POST', 'poll', { ieee: d.ieee }).then(() => toast('Abgefragt')).catch(fail) }, '↻ Werte abfragen'),
          h('button', { class: 'sm', onclick: (e) => { e.target.disabled = true; toast('Neu abfragen …'); call('POST', 'reinterview', { ieee: d.ieee }).then(() => toast('Fertig')).catch(fail).finally(() => { e.target.disabled = false; }); } }, '🔍 Neu abfragen'),
          h('button', { class: 'sm danger', onclick: () => { if (confirm(`„${d.name}“ aus dem Zigbee-Netz entfernen?\n(Batteriegeräte antworten nur, wenn sie wach sind – ggf. Taste am Gerät drücken. HomeLite-Geräte werden mit entfernt.)`)) call('POST', 'remove', { ieee: d.ieee }).then(() => toast('Entfernt')).catch(fail); } }, '🗑 Entfernen'))) : null);
  }

  // ---- Backup ----
  function restoreDialog(b) {
    modal('Backup einspielen (Restore)', h('div', {}, h('p', { class: 'hint', style: 'margin-top:0' }, 'Das Backup schreibt Netzwerkschlüssel, Kanal, PAN-ID und Koordinator-Adresse auf den angeschlossenen Dongle. So übernimmt ein neuer oder zurückgesetzter Dongle das bisherige Zigbee-Netz, und die angelernten Geräte verbinden sich wieder (ohne neu anlernen).'),
      h('p', { class: 'hint' }, 'Ablauf: Der aktuelle Zustand wird zuerst gesichert („vor Restore“), dann wird das Backup geschrieben und die Zigbee-Verbindung neu gestartet. Die Geräteliste selbst liegt in der Plugin-Datenbank und bleibt erhalten; bei einem frischen Plugin-Ordner müssen Geräte neu angelernt werden, wenn sie nicht von selbst wieder auftauchen.'),
      h('p', { class: 'hint', style: 'color:var(--bad)' }, 'Nur einspielen, wenn das Netz wirklich wiederhergestellt werden soll – ein laufendes Netz wird überschrieben.')),
    [{ label: 'Abbrechen' }, { label: 'Jetzt einspielen', primary: true, onClick: async () => { await call('POST', `restore/${b.name}`, {}); toast('Eingespielt, Verbindung wird neu aufgebaut'); } }]);
  }
  function backupCard() {
    if (!BK) return null;
    const pick = h('input', { type: 'file', accept: '.json', style: 'display:none', onchange: () => { const f = pick.files[0]; if (!f) return; if (f.size > 200 * 1024) return toast('Datei zu groß', true); const rd = new FileReader(); rd.onload = () => call('POST', 'backup-upload', { content: String(rd.result) }).then((r) => { BK.backups = r.backups; toast('Backup hochgeladen'); draw(); }).catch(fail); rd.readAsText(f); pick.value = ''; } });
    return h('div', { class: 'card', style: 'padding:12px;margin:10px 0' },
      h('div', { class: 'row sb' }, h('b', {}, '💾 Backup & Restore'), h('span', { class: 'pill' }, BK.auto ? 'automatisch täglich' : 'nur manuell')),
      h('div', { class: 'hint', style: 'margin-top:4px' }, 'Ein Backup enthält die Netzwerkdaten des Koordinators (Schlüssel, Kanal, PAN-ID) im Standardformat „Open Coordinator Backup“ (auch von Zigbee2MQTT/ZHA lesbar). Es ist geheim zu halten – wer die Datei hat, kann dem Netz beitreten.'),
      h('div', { class: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' },
        h('button', { class: 'sm primary', disabled: M.status !== 'online', onclick: (e) => { e.target.disabled = true; call('POST', 'backup', {}).then((r) => { BK.backups = r.backups; toast('Backup erstellt'); draw(); }).catch((x) => { fail(x); draw(); }); } }, '💾 Backup jetzt erstellen'),
        h('button', { class: 'sm', onclick: () => pick.click() }, '⬆ Backup-Datei hochladen'), pick),
      BK.backups.length ? h('div', { style: 'margin-top:8px' }, BK.backups.map((b) => h('div', { class: 'row sb', style: 'padding:6px 0;border-top:1px solid var(--line,#ddd);gap:6px;flex-wrap:wrap' },
        h('div', {}, h('b', {}, when(b.t)), ' ', h('span', { class: 'hint' }, `${kb(b.size)}${b.note ? ' · ' + b.note : ''}`)),
        h('div', { class: 'row', style: 'gap:6px' }, h('button', { class: 'sm', onclick: () => call('GET', `backup/${b.name}`).then((r) => saveFile(r.filename, 'application/json', r.content)).catch(fail) }, '⬇'),
          h('button', { class: 'sm primary', disabled: M.status !== 'online', onclick: () => restoreDialog(b) }, 'Restore'),
          h('button', { class: 'sm danger', onclick: () => { if (confirm('Dieses Backup löschen?')) call('DELETE', `backup/${b.name}`).then((r) => { BK.backups = r.backups; draw(); }).catch(fail); } }, '🗑'))))) : h('div', { class: 'hint', style: 'margin-top:8px' }, 'Noch kein Backup vorhanden.'));
  }

  function draw() {
    const el = box(); if (!el || !M) return;
    const list = M.devices.filter((d) => !fl || (d.name + ' ' + d.model + ' ' + d.manufacturer + ' ' + d.ieee).toLowerCase().includes(fl.toLowerCase()));
    const filt = h('input', { placeholder: 'Geräte filtern …', value: fl, style: 'max-width:240px', oninput: (e) => { fl = e.target.value; const pos = e.target.selectionStart; draw(); const n = box().querySelector('input[placeholder^="Geräte"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } } });
    fill(el,
      h('div', { class: 'hint' }, 'Zigbee direkt über den ZHA-Kern – ohne Zigbee2MQTT. Einstellungen (Anschluss, Funkchip, Kanal …) über das Zahnrad des Plugins.'),
      envCard(), dongleCard(), joinCard(),
      h('div', { class: 'row sb', style: 'margin-top:6px' }, h('b', {}, `Geräte (${M.devices.length})`), M.devices.length > 6 ? filt : null),
      list.length ? list.map(devCard) : h('div', { class: 'hint', style: 'margin:8px 0' }, M.status === 'online' ? 'Noch keine Geräte – oben „Anlernen“ öffnen.' : 'Erst den Dongle verbinden.'),
      backupCard(),
      M.events.length ? h('div', { style: 'margin-top:10px' }, h('b', {}, 'Ereignisse'), M.events.slice(0, 8).map((e) => h('div', { class: 'hint' }, `${when(e.t)} · ${e.txt}`))) : null,
      M.logs.length ? h('details', { style: 'margin-top:10px' }, h('summary', {}, 'Protokoll der Zigbee-Brücke'), M.logs.slice(0, 25).map((e) => h('div', { class: 'hint', style: e.level === 'error' ? 'color:var(--bad)' : '' }, `${when(e.t)} · ${e.msg}`))) : null);
    clearInterval(tick);
    if (M.join && M.join > Date.now()) tick = setInterval(() => { const n = document.getElementById('zg-cd'); if (!n) return clearInterval(tick); const s = Math.ceil((M.join - Date.now()) / 1000); if (s <= 0) { clearInterval(tick); M.join = 0; return draw(); } n.textContent = s + ' s'; }, 500);
  }

  HL.on('zigbee', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('zigbee', {
    label: 'Zigbee direkt', icon: '📡',
    render(el) {
      el.append(h('h2', { class: 'page-title' }, '📡 Zigbee direkt'), h('div', { class: 'card', id: 'zg-box' }));
      call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail);
      call('GET', 'backups').then((r) => { BK = r; draw(); }).catch(() => {});
    },
  });
})();
