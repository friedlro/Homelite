// Seite „Zigbee“: Status, Anlernen, Geräte, Einrichtungs-Assistent für den Dongle
(() => {
  const { h, fill, toast, fail } = HL;
  let M = null, tick = null, S = null, setup = { adapter: 'ember', port: '', host: location.hostname, user: '', pass: '', channel: 11 }, out = null, open = false;
  const call = (m, sub, body) => HL.api('zigbee2mqtt', m, sub, body);
  const box = () => document.getElementById('zb-box');
  const when = (s) => (s ? new Date(s).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
  const copy = (t) => { try { navigator.clipboard.writeText(t); toast('Kopiert'); } catch { toast('Bitte manuell markieren und kopieren'); } };

  function wizard() {
    const sel = h('select', { onchange: (e) => { setup.adapter = e.target.value; } }, Object.entries((S && S.adapters) || {}).map(([k, l]) => h('option', { value: k, selected: setup.adapter === k }, l)));
    const ports = ((S && S.dongles) || []);
    const port = h('input', { value: setup.port, list: 'zb-ports', placeholder: '/dev/serial/by-id/…', style: 'min-width:0;width:100%', oninput: (e) => { setup.port = e.target.value; } });
    const dl = h('datalist', { id: 'zb-ports' }, ports.map((p) => h('option', { value: p.port }, p.hint)));
    const inp = (k, ph, type) => h('input', { value: setup[k], placeholder: ph, type: type || 'text', oninput: (e) => { setup[k] = e.target.value; } });
    return h('div', { class: 'card', style: 'padding:12px;margin:10px 0' },
      h('div', { class: 'row sb' }, h('b', {}, '🔧 Einrichtung (Zigbee2MQTT + Dongle)'), h('button', { class: 'sm', onclick: () => { open = !open; draw(); } }, open ? 'Schließen' : 'Öffnen')),
      !open ? h('div', { class: 'hint' }, 'Zigbee2MQTT läuft als eigener Dienst und steuert den USB-Dongle (Sonoff ZBDongle-E/-P, ConBee II …). Hier erzeugst du die passende Konfiguration.') : h('div', {},
        ports.length ? h('div', { class: 'hint', style: 'margin:6px 0' }, 'Am Server erkannt: ' + ports.map((p) => `${p.hint || 'unbekannt'} (${p.port.split('/').pop()})`).join(' · ')) : h('div', { class: 'hint', style: 'margin:6px 0' }, 'Kein USB-Dongle am HomeLite-Server erkannt (läuft Zigbee2MQTT auf einem anderen Gerät, Port von dort eintragen).'),
        h('div', { class: 'form' },
          h('label', {}, 'Dongle-Typ', sel), h('label', {}, 'Anschluss', port, dl),
          h('label', {}, 'HomeLite-Server (MQTT)', inp('host', 'IP des HomeLite-Servers')),
          h('label', {}, 'MQTT-Benutzer', inp('user', 'Benutzer aus Einstellungen → MQTT-Broker')), h('label', {}, 'MQTT-Passwort', inp('pass', 'wird nicht gespeichert', 'password')),
          h('label', {}, 'Zigbee-Funkkanal', h('select', { onchange: (e) => { setup.channel = Number(e.target.value); } }, [11, 15, 20, 25].map((c) => h('option', { value: c, selected: setup.channel === c }, c + (c === 11 ? ' (Standard)' : '')))))),
        h('button', { class: 'primary', style: 'margin-top:8px', onclick: () => call('POST', 'setup', setup).then((r) => { out = r; draw(); }).catch(fail) }, 'Konfiguration erzeugen'),
        out ? h('div', {},
          out.note ? h('div', { class: 'hint', style: 'color:var(--bad);margin-top:6px' }, out.note) : null,
          h('div', { class: 'row sb', style: 'margin-top:10px' }, h('b', {}, 'data/configuration.yaml'), h('button', { class: 'sm', onclick: () => copy(out.yaml) }, 'Kopieren')),
          h('pre', { style: 'overflow:auto;padding:8px;background:var(--bg2,#0001);border-radius:6px' }, out.yaml),
          h('div', { class: 'row sb' }, h('b', {}, 'docker-compose.yml (empfohlen)'), h('button', { class: 'sm', onclick: () => copy(out.compose) }, 'Kopieren')),
          h('pre', { style: 'overflow:auto;padding:8px;background:var(--bg2,#0001);border-radius:6px' }, out.compose),
          h('div', { class: 'hint' }, 'Ablauf: Ordner anlegen (z. B. ~/zigbee2mqtt), die zwei Dateien speichern (configuration.yaml in den Unterordner data), dann „docker compose up -d“. Nach ca. 30 Sekunden erscheint hier „online“. Ohne Docker: siehe LIESMICH des Plugins.')) : null));
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
      !online ? h('div', { class: 'hint', style: 'margin-top:6px' }, `Es kommen keine Nachrichten unter „${M.base}/bridge/state“. Zigbee2MQTT starten und mit dem MQTT-Broker von HomeLite verbinden – siehe 🔧 Einrichtung.`) : null,
      cd, h('b', {}, 'Geräte'), rows, wizard(),
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
      call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail);
      call('GET', 'dongles').then((r) => { S = r; if (!setup.port && r.dongles[0]) { setup.port = r.dongles[0].port; if (r.dongles[0].adapter) setup.adapter = r.dongles[0].adapter; } draw(); }).catch(() => {});
    },
  });
})();
