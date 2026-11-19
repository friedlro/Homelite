// Seite „Zigbee“: Status, Anlernen, Geräte, Einrichtungs-Assistent für den Dongle
(() => {
  const { h, fill, toast, fail, modal } = HL;
  let M = null, tick = null, found = null;
  const call = (m, sub, body) => HL.api('zigbee2mqtt', m, sub, body);
  const box = () => document.getElementById('zb-box');
  const when = (s) => (s ? new Date(s).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
  const copy = (t) => { try { navigator.clipboard.writeText(t); toast('Kopiert'); } catch { toast('Bitte manuell markieren und kopieren'); } };

  // Status des Funk-Dongles (Koordinator)
  function dongleCard() {
    const D = M.dongle || {};
    const ok = D.connected;
    const net = D.host ? (D.reachable === true ? `Port 6638 auf ${D.ip || D.host} antwortet` : D.reachable === false ? `Port 6638 auf ${D.ip || D.host} antwortet nicht${D.msg ? ' (' + D.msg + ')' : ''}` : 'wird geprüft …') : '';
    const hostIn = h('input', { value: D.host || '', placeholder: 'Netzwerk-Dongle: IP oder Name (optional)', style: 'max-width:260px' });
    return h('div', { class: 'card', style: 'padding:12px;margin:10px 0' },
      h('div', { class: 'row sb' }, h('b', {}, '📡 Funk-Dongle'), h('span', { class: 'pill ' + (ok ? 'ok' : 'bad') }, ok ? 'verbunden' : M.bridge === 'online' ? 'Zigbee2MQTT online, kein Koordinator gemeldet' : 'nicht verbunden')),
      ok ? h('div', { class: 'hint', style: 'margin-top:6px' }, [D.type, D.rev ? 'Firmware ' + D.rev : '', D.ieee ? 'IEEE ' + D.ieee : ''].filter(Boolean).join(' · '))
        : h('div', { class: 'hint', style: 'margin-top:6px' }, 'Zigbee2MQTT meldet keinen Koordinator – der Dongle ist nicht erreichbar oder Zigbee2MQTT läuft nicht.' + (net ? ' · ' + net : '')),
      !ok && D.error ? h('div', { class: 'hint', style: 'margin-top:4px;color:var(--bad)' }, `Letzte Meldung (${when(D.error.t)}): ${D.error.msg}`) : null,
      !ok && D.host && D.reachable === true ? h('div', { class: 'hint', style: 'margin-top:4px' }, 'Der Port ist offen: Zigbee2MQTT mit „port: tcp://…:6638, adapter: ember, baudrate: 115200, rtscts: false“ starten bzw. neu starten; es darf keine zweite Verbindung (ZHA/Home Assistant) bestehen.') : null,
      h('div', { class: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' }, hostIn,
        h('button', { class: 'sm', onclick: () => call('POST', 'donglehost', { host: hostIn.value }).then((r) => { M = r; draw(); }).catch(fail) }, 'Adresse speichern & prüfen'),
        h('button', { class: 'sm', onclick: () => call('POST', 'testdongle', { host: hostIn.value }).then((r) => toast(r.msg, !r.ok)).catch(fail) }, '✔ Verbindung testen'),
        h('button', { class: 'sm', onclick: (e) => { e.target.disabled = true; e.target.textContent = 'Suche …'; call('POST', 'finddongle', {}).then((r) => { found = r; draw(); }).catch((x) => { fail(x); draw(); }); } }, '🔎 Im Netzwerk suchen')),
      found ? h('div', { class: 'row', style: 'gap:6px;margin-top:6px;flex-wrap:wrap' }, found.found.length ? found.found.map((f) => h('button', { class: 'sm primary', onclick: () => { call('POST', 'donglehost', { host: f.ip }).then((r) => { M = r; found = null; draw(); }).catch(fail); } }, f.ip + (f.title ? ' · ' + f.title : ''))) : h('span', { class: 'hint' }, `Nichts auf Port 6638 gefunden (${found.subnets.join(', ')}.x).`)) : null);
  }

  // ---- Backup & Restore ----
  let BK = null;
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' kB');
  const saveFile = (name, mime, blob) => { const a = h('a', { href: URL.createObjectURL(new Blob([blob], { type: mime })), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const loadBackups = () => call('GET', 'backups').then((r) => { BK = r; draw(); }).catch(() => {});
  function restoreDialog(b) {
    call('GET', `restore-script/${b.name}`).then((r) => {
      modal('Backup einspielen (Restore)', h('div', {}, h('p', { class: 'hint', style: 'margin-top:0' }, 'Zigbee2MQTT bietet keine Schnittstelle zum Einspielen und überschreibt seine Dateien beim Beenden. Deshalb muss Zigbee2MQTT dafür kurz angehalten werden. Das Skript macht das auf dem Rechner, auf dem Zigbee2MQTT läuft:'),
        h('ol', { style: 'margin:6px 0 6px 18px;padding:0' }, h('li', {}, 'Backup-Datei (⬇) und Skript auf diesen Rechner kopieren.'), h('li', {}, 'Skript ausführen: ', h('code', {}, `bash restore-zigbee2mqtt.sh ${b.name}`)), h('li', {}, 'Nach etwa 30 Sekunden zeigt diese Seite wieder „online“.')),
        h('p', { class: 'hint' }, 'Das Skript hält den Container an, sichert den aktuellen Stand in einen Ordner „…vor-restore-…“, entpackt das Backup und startet neu. Ordner und Container-Name stehen in den Plugin-Einstellungen. Bei einem neuen Dongle stellt Zigbee2MQTT das Netz aus der Datei coordinator_backup.json wieder her.'),
        h('textarea', { readonly: true, rows: 12, style: 'width:100%;font-family:monospace;font-size:12px' }, r.content)),
      [{ label: 'Skript herunterladen', primary: true, onClick: () => { saveFile(r.filename, 'text/x-shellscript', r.content); return false; } },
        { label: 'Backup herunterladen', onClick: () => { dl(b); return false; } }, { label: 'Kopieren', onClick: () => { copy(r.content); return false; } }, { label: 'Schließen' }]);
    }).catch(fail);
  }
  function dl(b) { call('GET', `backup/${b.name}`).then((r) => saveFile(r.filename, 'application/zip', b64ToBytes(r.b64))).catch(fail); }
  function backupCard() {
    if (!BK) return null;
    const pick = h('input', { type: 'file', accept: '.zip', style: 'display:none', onchange: () => { const f = pick.files[0]; if (!f) return; if (f.size > 700 * 1024) return toast('Datei zu groß (maximal ca. 700 kB)', true); const rd = new FileReader(); rd.onload = () => { const b64 = String(rd.result).split(',')[1]; call('POST', 'backup-upload', { b64 }).then((r) => { BK.backups = r.backups; toast('Backup hochgeladen'); draw(); }).catch(fail); }; rd.readAsDataURL(f); pick.value = ''; } });
    return h('div', { class: 'card', style: 'padding:12px;margin:10px 0' },
      h('div', { class: 'row sb' }, h('b', {}, '💾 Backup & Restore'), h('span', { class: 'pill' }, BK.auto ? 'automatisch täglich' : 'nur manuell')),
      h('div', { class: 'hint', style: 'margin-top:4px' }, 'Ein Backup enthält die Zigbee2MQTT-Daten: Geräteliste, Konfiguration, Zustand und die Netzwerkdaten des Koordinators (Kanal, Schlüssel). Damit lässt sich das Netz auch auf einem neuen Dongle wiederherstellen.'),
      h('div', { class: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' },
        h('button', { class: 'sm primary', onclick: (e) => { e.target.disabled = true; e.target.textContent = 'Backup läuft …'; call('POST', 'backup', {}).then((r) => { BK.backups = r.backups; toast('Backup erstellt'); draw(); }).catch((x) => { fail(x); draw(); }); } }, '💾 Backup jetzt erstellen'),
        h('button', { class: 'sm', onclick: () => pick.click() }, '⬆ Backup-Datei hochladen'), pick),
      BK.backups.length ? h('div', { style: 'margin-top:8px' }, BK.backups.map((b) => h('div', { class: 'row sb', style: 'padding:6px 0;border-top:1px solid var(--line,#ddd);gap:6px;flex-wrap:wrap' },
        h('div', {}, h('b', {}, when(b.t)), ' ', h('span', { class: 'hint' }, `${kb(b.size)}${b.note ? ' · ' + b.note : ''}`)),
        h('div', { class: 'row', style: 'gap:6px' }, h('button', { class: 'sm', onclick: () => dl(b) }, '⬇'), h('button', { class: 'sm primary', onclick: () => restoreDialog(b) }, 'Restore'),
          h('button', { class: 'sm danger', onclick: () => { if (confirm('Dieses Backup löschen?')) call('DELETE', `backup/${b.name}`).then((r) => { BK.backups = r.backups; draw(); }).catch(fail); } }, '🗑'))))) : h('div', { class: 'hint', style: 'margin-top:8px' }, 'Noch kein Backup vorhanden.'));
  }

  // Funkkanal anzeigen und ändern
  function channelCard() {
    if (M.bridge !== 'online') return null;
    const cur = M.network && M.network.channel, cfgc = M.channelConfig;
    const sel = h('select', {}, Array.from({ length: 16 }, (_, i) => 11 + i).map((n) => h('option', { value: n, selected: n === (cfgc || cur) }, n + ([15, 20, 25].includes(n) ? ' (empfohlen)' : n === 11 ? ' (Standard)' : ''))));
    return h('div', { class: 'card', style: 'padding:12px;margin:10px 0' },
      h('div', { class: 'row sb' }, h('b', {}, '📶 Funkkanal'), h('span', { class: 'pill' }, cur ? 'aktuell ' + cur : 'unbekannt')),
      M.channelChange ? h('div', { class: 'hint', style: 'margin-top:6px;font-weight:600;' + (M.channelChange.step === 'failed' ? 'color:var(--bad)' : M.channelChange.step === 'done' ? 'color:var(--ok,#2a9d4a)' : '') }, (M.channelChange.step === 'done' ? '✅ ' : M.channelChange.step === 'failed' ? '⚠ ' : '⏳ ') + M.channelChange.msg) : null,
      M.channelLogs && M.channelLogs.length ? h('div', { class: 'hint', style: 'margin-top:4px' }, M.channelLogs.map((e) => h('div', {}, `${when(e.t)} · ${e.msg}`))) : null,
      M.restartRequired && !(M.channelChange && ['options', 'restart'].includes(M.channelChange.step)) ? h('div', { class: 'hint', style: 'margin-top:6px;color:var(--warn,#e8a317)' }, `Kanal ${cfgc} ist gespeichert, wird aber erst nach einem Neustart von Zigbee2MQTT verwendet.`) : null,
      h('div', { class: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center' }, sel,
        h('button', { class: 'sm primary', onclick: () => { const n = Number(sel.value); if (n === cur && !M.restartRequired) return toast('Das ist schon der aktuelle Kanal'); if (confirm(`Funkkanal auf ${n} ändern?\n\nZigbee2MQTT wird dabei neu gestartet (kurze Unterbrechung). Die Geräte wechseln danach mit. Batteriegeräte, die nicht folgen, müssen eventuell neu angelernt werden. Vorher am besten ein Backup in Zigbee2MQTT anlegen.`)) call('POST', 'channel', { channel: n, restart: true }).then(() => toast('Kanalwechsel gestartet – Zigbee2MQTT wird neu gestartet')).catch(fail); } }, 'Kanal ändern & neu starten'),
        h('button', { class: 'sm', onclick: () => { if (confirm('Zigbee2MQTT jetzt neu starten? Das Zigbee-Netz ist dabei kurz nicht erreichbar.')) call('POST', 'restart', {}).then(() => toast('Neustart angefordert')).catch(fail); } }, '↻ Zigbee2MQTT neu starten')),
      h('div', { class: 'hint', style: 'margin-top:6px' }, 'Tipp: Die Kanäle 15, 20 und 25 liegen zwischen den üblichen WLAN-Kanälen 1, 6 und 11 und stören sich am wenigsten.'));
  }

  function draw() {
    const el = box(); if (!el || !M) return;
    const joining = M.join && M.join > Date.now();
    const online = M.bridge === 'online';
    const cd = joining ? h('div', { class: 'card', style: 'padding:12px;margin:10px 0;text-align:center' }, h('b', {}, '➕ Anlernmodus aktiv'), h('div', { id: 'zb-cd', style: 'font-size:1.5em;margin:6px 0' }, ''), h('div', { class: 'hint' }, 'Jetzt am Gerät die Anlerntaste drücken bzw. es zurücksetzen (meist 5 s Taste halten oder 5× Ein/Aus).'), h('button', { style: 'margin-top:8px', onclick: () => call('POST', 'permit', { time: 0 }).catch(fail) }, 'Abbrechen'))
      : h('div', { class: 'card', style: 'padding:12px;margin:10px 0' }, h('b', {}, 'Geräte hinzufügen'), h('div', { class: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' }, h('button', { class: 'primary', disabled: !online, onclick: () => call('POST', 'permit', { time: 254 }).then(() => toast('Anlernmodus geöffnet')).catch(fail) }, '➕ Anlernen (254 s)'), h('button', { disabled: !online, onclick: () => call('POST', 'permit', { time: 60 }).catch(fail) }, '60 s')));
    const rows = M.devices.length ? M.devices.map((d) => {
      const st = d.disabled ? ['', 'deaktiviert'] : !d.supported ? ['bad', 'nicht unterstützt'] : d.interviewing ? ['', 'wird eingelesen'] : !d.interviewed ? ['bad', 'Einlesen fehlgeschlagen'] : d.online === false ? ['bad', 'offline'] : d.online === true ? ['ok', 'online'] : ['', d.type === 'EndDevice' ? 'Endgerät' : 'Router'];
      return h('div', { style: 'padding:10px 0;border-top:1px solid var(--line)' },
        h('div', { class: 'row sb' },
          h('div', { style: 'min-width:0' }, h('b', {}, d.name),
            h('div', { class: 'hint' }, [d.model || 'unbekanntes Modell', d.type === 'Router' ? 'Router' : null, d.battery != null ? `🔋 ${d.battery} %` : null, d.lqi !== undefined && d.lqi !== null ? `LQI ${d.lqi}` : null, `${d.count} Gerät${d.count === 1 ? '' : 'e'}`, d.lastSeen ? 'zuletzt ' + when(d.lastSeen) : null].filter(Boolean).join(' · '))),
          h('div', { class: 'row', style: 'gap:6px;flex:none' }, h('span', { class: 'pill ' + st[0] }, st[1]),
            !d.interviewed && !d.interviewing ? h('button', { class: 'sm', onclick: () => call('POST', 'interview', { name: d.name }).then(() => toast('Wird neu eingelesen')).catch(fail) }, '↻') : null,
            h('button', { class: 'sm', onclick: () => { const n = prompt('Neuer Name:', d.name); if (n && n.trim() && n !== d.name) call('POST', 'rename', { from: d.name, to: n.trim() }).then(() => toast('Umbenannt')).catch(fail); } }, '✎'),
            h('button', { class: 'sm danger', onclick: () => { if (confirm(`„${d.name}“ aus dem Zigbee-Netz entfernen? Die zugehörigen HomeLite-Geräte werden gelöscht.`)) call('POST', 'remove', { name: d.name, force: d.online === false || !d.interviewed }).then(() => toast('Wird entfernt')).catch(fail); } }, '🗑'))));
    }) : h('div', { class: 'empty' }, online ? 'Noch keine Geräte – oben ➕ Anlernen.' : 'Zigbee2MQTT ist nicht erreichbar.');
    fill(el,
      h('div', { class: 'row sb' },
        h('span', { class: 'pill ' + (online ? 'ok' : 'bad') }, online ? 'Zigbee2MQTT online' : M.mqtt ? 'Zigbee2MQTT nicht erreichbar' : 'MQTT getrennt'),
        h('span', { class: 'hint' }, [M.version ? 'Version ' + M.version : null, M.coordinator && M.coordinator.type, M.frontend ? null : null].filter(Boolean).join(' · '),
          M.frontend ? h('a', { href: M.frontend, target: '_blank', rel: 'noopener noreferrer', style: 'margin-left:8px' }, 'Oberfläche ↗') : null)),
      dongleCard(), channelCard(), backupCard(),
      !online ? h('div', { class: 'hint', style: 'margin-top:6px' }, `Es kommen keine Nachrichten unter „${M.base}/bridge/state“. Zigbee2MQTT starten und mit dem MQTT-Broker von HomeLite verbinden – siehe 🔧 Einrichtung.`) : null,
      cd, h('b', {}, 'Geräte'), rows,
      M.events.length ? h('div', { style: 'margin-top:10px' }, h('b', {}, 'Ereignisse'), M.events.slice(0, 8).map((e) => h('div', { class: 'hint' }, `${when(e.t)} · ${e.txt}`))) : null,
      M.logs.length ? h('details', { style: 'margin-top:10px' }, h('summary', {}, 'Zigbee2MQTT-Protokoll'), M.logs.slice(0, 20).map((e) => h('div', { class: 'hint', style: e.level === 'error' ? 'color:var(--bad)' : '' }, `${when(e.t)} · ${e.msg}`))) : null);
    clearInterval(tick);
    if (joining) tick = setInterval(() => { const n = document.getElementById('zb-cd'); if (!n) return clearInterval(tick); const s = Math.ceil((M.join - Date.now()) / 1000); if (s <= 0) { clearInterval(tick); M.join = 0; return draw(); } n.textContent = s + ' s'; }, 500);
  }

  HL.on('zigbee2mqtt', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('zigbee2mqtt', {
    label: 'Zigbee', icon: '🐝',
    render(el) {
      el.append(h('h2', { class: 'page-title' }, '🐝 Zigbee'), h('div', { class: 'card', id: 'zb-box' }));
      call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail); loadBackups();
    },
  });
})();
