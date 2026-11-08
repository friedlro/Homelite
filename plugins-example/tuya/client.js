// Tuya-Seite: Anmeldung per QR-Code, Geräteliste, Übernehmen, lokale Verbindung
(() => {
  const { h, fill, toast, fail, modal, fld, sel } = HL;
  let M = null, poll = null;
  const stopPoll = () => { clearInterval(poll); poll = null; };
  const call = (m, sub, body) => HL.api('tuya', m, sub, body);
  const reload = () => call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail);
  const host = () => document.getElementById('tuya-box');

  const catLabel = (c) => ({ dj: 'Licht', dd: 'LED-Streifen', xdd: 'Deckenlicht', fwd: 'Stimmungslicht', cz: 'Steckdose', kg: 'Schalter', pc: 'Steckerleiste', wsdcg: 'Temperatur/Feuchte', wk: 'Thermostat', mcs: 'Kontakt', pir: 'Bewegung' })[c] || c || '–';
  const summary = (t) => Object.entries(t.status || {}).filter(([, v]) => typeof v !== 'object').slice(0, 4).map(([k, v]) => {
    const r = (t.ranges || {})[k] || {};
    return `${k}: ${typeof v === 'number' && r.scale ? v / 10 ** r.scale : v}`;
  }).join(' · ') || '–';

  function linkDialog(t) {
    const status = t.status || {};
    const boolCodes = Object.keys(status).filter((k) => typeof status[k] === 'boolean');
    const numCodes = Object.keys(status).filter((k) => typeof status[k] === 'number');
    const o = { type: t.guess && t.guess.brightness ? 'light' : boolCodes.length ? 'switch' : 'sensor', deviceId: '', code: (t.guess && t.guess.on) || boolCodes[0] || numCodes[0] || '' };
    const holders = { '': '➕ Neues Gerät anlegen' };
    const ph = (M.placeholders || []);
    for (const d of ph) holders[d.id] = `Platzhalter: ${d.name}`;
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
    const sug = ph.find((p) => { const a = norm(p.name), b = norm(t.name); return a && b && (a === b || a.includes(b) || b.includes(a)); });
    if (sug) o.deviceId = sug.id;
    const name = h('input', { value: sug ? sug.name : t.name });
    const room = h('input', { placeholder: 'Raum', value: sug ? sug.room || '' : '' });
    const codeBox = h('div');
    const drawCode = () => {
      const codes = o.type === 'sensor' ? numCodes : boolCodes;
      if (!codes.includes(o.code)) o.code = codes[0] || '';
      fill(codeBox, fld(o.type === 'sensor' ? 'Messwert (Code)' : 'Schalt-Code', sel(codes.length ? codes : ['–'], o.code, (v) => { o.code = v; })));
    };
    drawCode();
    const typeSel = sel({ light: 'Licht (dimmbar)', switch: 'Schalter', sensor: 'Sensor' }, o.type, (v) => { o.type = v; drawCode(); });
    modal(`„${t.name}“ übernehmen`, h('div', { class: 'form' },
      fld('Als', sel(holders, o.deviceId, (v) => { o.deviceId = v; const d = ph.find((x) => x.id === v); if (d) { name.value = d.name; room.value = d.room || ''; } })),
      fld('Name', name), fld('Raum', room), fld('Typ', typeSel), codeBox,
      h('p', { class: 'hint' }, `Gerät: ${t.product || t.category} · ${t.online ? 'online' : 'offline'}. Mehrere Werte (z. B. Temperatur und Feuchte) übernimmst du einzeln als Sensor.`)),
    [{ label: 'Abbrechen' }, { label: 'Übernehmen', primary: true, onClick: async () => {
      await call('POST', 'link', { tuyaId: t.id, deviceId: o.deviceId || undefined, name: name.value.trim(), room: room.value.trim(), type: o.type, code: o.code });
      toast('Übernommen'); await reload();
    } }]);
  }

  function connCell(t, L) {
    const l = t.local;
    if (L.enabled === false || L.available === false) return h('span', { class: 'hint' }, 'Cloud');
    if (l && l.state === 'ok') return h('span', { class: 'pill ok', title: `${l.ip} · Protokoll ${l.version}` }, 'lokal');
    const man = (L.manual || {})[t.id];
    return h('span', {}, h('span', { class: 'hint', title: (l && l.reason) || 'Noch nicht gefunden' }, 'Cloud'), ' ',
      h('button', { class: 'sm', title: 'IP-Adresse von Hand eintragen', onclick: async () => {
        const ip = prompt(`IP-Adresse von „${t.name}“ im Heimnetz (leer = automatisch suchen):`, man ? man.ip : (l && l.ip) || '');
        if (ip === null) return;
        const ver = ip.trim() ? prompt('Protokollversion (3.3, 3.4 oder 3.5):', man ? man.version : '3.3') : null;
        const devs = { ...(L.manual || {}) };
        if (ip.trim()) devs[t.id] = { ip: ip.trim(), version: Number(ver) || 3.3 }; else delete devs[t.id];
        try { M = await call('PUT', 'local', { devices: devs }); toast('Gespeichert'); draw(); } catch (e) { fail(e); }
      } }, 'IP'));
  }

  function loginCard() {
    const code = h('input', { value: M.userCode, placeholder: 'z. B. AB12CD34', autocomplete: 'off' });
    const box = h('div');
    async function start() {
      stopPoll();
      try {
        const { qr } = await call('POST', 'qr', { userCode: code.value.trim() });
        const q = qrcode(0, 'M'); q.addData(qr); q.make();
        fill(box, h('div', { class: 'qr' }, h('img', { src: q.createDataURL(6, 8), alt: 'QR-Code', width: 220, height: 220, style: 'background:#fff;border-radius:12px;padding:6px' })),
          h('p', { class: 'hint' }, 'In der Smart-Life-App: Ich → oben rechts „Scannen“ → diesen Code scannen und bestätigen. Wartet auf Bestätigung …'));
        let n = 0;
        poll = setInterval(async () => {
          if (++n > 100 || !host()) return stopPoll();
          try { const r = await call('POST', 'qrpoll', {}); if (r.done) { stopPoll(); toast('Angemeldet'); reload(); } } catch (e) { stopPoll(); fail(e); }
        }, 3000);
      } catch (e) { fail(e); }
    }
    return h('div', { class: 'card' }, h('div', { class: 'form' },
      fld('Benutzercode (Smart-Life-App → Ich → Einstellungen → Konto und Sicherheit → Benutzercode)', code),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: start }, 'QR-Code erzeugen'))), box);
  }

  function draw() {
    const el = host();
    if (!el) return;
    if (!M) return fill(el, h('div', { class: 'empty' }, 'Lade …'));
    const L = M.local || {};
    const nodes = [];
    nodes.push(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, '☁ Tuya / Smart Life'), M.loggedIn ? h('div', { class: 'row' },
      h('button', { onclick: () => call('POST', 'refresh', {}).then(() => { toast('Aktualisiert'); return reload(); }).catch(fail) }, '↻ Geräte neu laden'),
      h('button', { class: 'danger', onclick: () => { if (confirm('Tuya-Konto trennen? Verknüpfte Geräte bleiben als nicht verbunden bestehen.')) call('POST', 'logout', {}).then(reload).catch(fail); } }, 'Abmelden')) : null));
    if (!M.loggedIn) { nodes.push(loginCard()); return fill(el, ...nodes); }
    nodes.push(h('div', { class: 'row', style: 'margin:8px 0' }, h('span', { class: 'chip ' + (M.connected ? 'ok' : 'bad') }, M.connected ? 'verbunden' : 'getrennt'), M.username ? h('span', { class: 'hint' }, M.username) : null));
    const nLocal = (M.devices || []).filter((t) => t.local && t.local.state === 'ok').length;
    nodes.push(h('div', { class: 'card' },
      h('div', { class: 'row sb' },
        h('label', { style: 'display:flex;align-items:center;gap:8px' },
          h('input', { type: 'checkbox', checked: L.enabled !== false, onchange: (e) => call('PUT', 'local', { enabled: e.target.checked }).then((r) => { M = r; toast(e.target.checked ? 'Lokaler Modus an' : 'Lokaler Modus aus'); draw(); }).catch(fail) }),
          h('b', {}, 'Lokal im Heimnetz verbinden')),
        h('button', { class: 'sm', onclick: () => call('POST', 'scan', {}).then(() => toast('Suche läuft – Ergebnis in etwa 15 Sekunden')).catch(fail) }, '↻ Netzwerk durchsuchen')),
      h('div', { class: 'hint' }, L.available === false ? 'Das Python-Paket „tinytuya“ fehlt: /opt/homelite/.venv/bin/pip install tinytuya – danach HomeLite neu starten.'
        : L.enabled === false ? 'Aus: alle Geräte laufen über die Tuya-Cloud.'
        : `${nLocal} von ${(M.devices || []).length} Geräten lokal verbunden. Schalten geht dann direkt im Heimnetz (schneller, ohne Internet); die Cloud bleibt Ersatz. Batteriegeräte (Sensoren, Türkontakte) bleiben bei der Cloud.`)));
    if (M.error) nodes.push(h('div', { class: 'card', style: 'border-color:var(--bad)' }, h('b', { style: 'color:var(--bad)' }, 'Fehler: '), M.error));
    if (!M.devices.length) nodes.push(h('div', { class: 'empty', style: 'margin-top:12px' }, M.connected ? 'Keine Geräte im Konto gefunden.' : 'Verbinde …'));
    else {
      const ph = new Set((M.placeholders || []).map((p) => p.name));
      nodes.push(h('div', { class: 'card', style: 'overflow-x:auto;padding:6px 14px' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Gerät', 'Art', 'Zustand', 'Verbindung', 'In HomeLite', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, M.devices.map((t) => h('tr', {},
          h('td', {}, h('span', { style: `display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${t.online ? 'var(--ok)' : 'var(--muted)'}` }), t.name),
          h('td', {}, catLabel(t.category)), h('td', { class: 'hint' }, summary(t)), h('td', {}, connCell(t, L)),
          h('td', {}, t.linked.length ? t.linked.map((id) => (HL.dev(id) || {}).name).filter(Boolean).join(', ') : ph.has(t.name) ? h('span', { class: 'pill warn' }, 'Platzhalter vorhanden') : '–'),
          h('td', {}, h('button', { class: 'sm', onclick: () => linkDialog(t) }, t.linked.length ? '+ weiterer Wert' : 'Übernehmen'))))))));
      nodes.push(h('p', { class: 'hint' }, 'Tipp: Platzhalter aus der Home-Assistant-Übernahme werden mit gleichnamigen Tuya-Geräten vorbelegt – deine Automationen funktionieren danach sofort.'));
    }
    fill(el, ...nodes);
  }

  HL.on('tuya', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('tuya', {
    label: 'Tuya', icon: '☁',
    render(el) { stopPoll(); el.append(h('div', { id: 'tuya-box' })); draw(); reload(); },
  });
})();
