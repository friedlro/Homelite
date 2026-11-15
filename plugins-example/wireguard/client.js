// Seite „WireGuard“: Benutzer, Rechte, Geräte (Zugangspunkte), Download der Client-Konfiguration
(() => {
  const { h, fill, toast, fail, modal, fld } = HL;
  let M = null;
  const box = () => document.getElementById('wg-box');
  const call = (m, sub, body) => HL.api('wireguard', m, sub, m === 'GET' ? undefined : (body || {}));
  const bytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? (n / 1e3).toFixed(0) + ' kB' : n + ' B');
  const ago = (t) => { if (!t) return 'noch nie'; const s = Math.round((Date.now() - t) / 1000); return s < 90 ? `vor ${s} s` : s < 5400 ? `vor ${Math.round(s / 60)} min` : s < 172800 ? `vor ${Math.round(s / 3600)} h` : `vor ${Math.round(s / 86400)} Tagen`; };
  const act = (p) => p.then((r) => { if (r && r.users) { M = r; draw(); } return r; }).catch(fail);
  const permText = (u) => [u.perms.lan ? 'Heimnetz' : null, u.perms.internet ? 'Internet über Heimanschluss' : null, u.perms.peers ? 'andere VPN-Geräte' : null, ...u.perms.extra].filter(Boolean).join(', ') || 'nur der Server selbst';

  function download(name, text) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function getConf(p) { return call('GET', `peer/${p.id}/config`); }

  function userDialog(u) {
    const name = h('input', { value: u ? u.name : '', placeholder: 'z. B. Roland' });
    const note = h('input', { value: u ? u.note || '' : '', placeholder: 'Notiz (optional)' });
    const cb = (k, t, v) => h('label', { class: 'row', style: 'gap:8px;align-items:center;margin:6px 0' }, h('input', { type: 'checkbox', checked: v }), t);
    const lan = cb('lan', M.lan ? `Heimnetz (${M.lan})` : 'Heimnetz (erst in den Einstellungen eintragen)', u ? u.perms.lan : true);
    const net = cb('internet', 'Internet über den Heimanschluss (gesamter Datenverkehr läuft durchs VPN)', u ? u.perms.internet : false);
    const prs = cb('peers', 'andere VPN-Geräte erreichen', u ? u.perms.peers : false);
    const extra = h('input', { value: u ? u.perms.extra.join(', ') : '', placeholder: '192.168.50.10, 192.168.50.20:tcp:8123' });
    modal(u ? `Benutzer „${u.name}“` : 'Benutzer hinzufügen', h('div', { class: 'form' }, fld('Name', name), fld('Notiz', note),
      h('b', {}, 'Rechte'), lan, net, prs, fld('Einzelne Ziele (auch ohne Heimnetz-Recht): Adresse, Netz oder Adresse:tcp|udp:Port, kommagetrennt', extra),
      h('div', { class: 'hint' }, 'Rechte werden am Server mit Firewall-Regeln durchgesetzt, nicht nur in der Client-Datei. Änderungen gelten sofort für alle Geräte des Benutzers; die Client-Datei (Zielnetze) ggf. neu herunterladen.')),
    [{ label: 'Speichern', primary: true, onClick: async () => {
      const r = await call('POST', 'user', { id: u && u.id, name: name.value, note: note.value, perms: { lan: lan.querySelector('input').checked, internet: net.querySelector('input').checked, peers: prs.querySelector('input').checked, extra: extra.value } });
      M = r; draw(); toast('Gespeichert');
    } },
    ...(u ? [{ label: u.enabled ? 'Sperren' : 'Entsperren', onClick: async () => { M = await call('POST', 'user', { id: u.id, name: u.name, note: u.note, perms: u.perms, enabled: !u.enabled }); draw(); } },
      { label: 'Löschen', danger: true, onClick: async () => { if (!confirm(`„${u.name}“ mit allen Geräten löschen? Die Geräte verlieren sofort den Zugang.`)) return false; M = await call('DELETE', `user/${u.id}`); draw(); } }] : []),
    { label: 'Abbrechen' }]);
  }
  function peerDialog(u) {
    const name = h('input', { placeholder: 'z. B. iPhone, Laptop' });
    const ep = h('select', {}, h('option', { value: '' }, M.endpoints[0] ? `${M.endpoints[0]} (Standard)` : 'kein Zugangspunkt vorhanden'), M.endpoints.slice(1).map((e) => h('option', { value: e }, e)));
    modal(`Gerät für „${u.name}“`, h('div', { class: 'form' }, fld('Name des Geräts', name), fld('Zugangspunkt (Adresse, mit der sich das Gerät verbindet)', ep),
      h('div', { class: 'hint' }, 'Schlüssel werden automatisch erzeugt. Danach die Konfiguration herunterladen und im WireGuard-Programm importieren.')),
    [{ label: 'Anlegen', primary: true, onClick: async () => { const r = await call('POST', 'peer', { userId: u.id, name: name.value, endpoint: ep.value }); M = r; draw(); const p = r.peers.find((x) => x.id === r.created); if (p) show(p); } }, { label: 'Abbrechen' }]);
  }
  async function show(p) {
    let c; try { c = await getConf(p); } catch (e) { return fail(e); }
    modal(`Konfiguration „${p.name}“`, h('div', {}, h('p', { class: 'hint', style: 'margin-top:0' }, 'Enthält den privaten Schlüssel des Geräts – nur an dieses Gerät weitergeben.'), h('textarea', { readonly: true, rows: 14, style: 'width:100%;font-family:monospace;font-size:12px' }, c.content)),
      [{ label: 'Herunterladen', primary: true, onClick: () => { download(c.filename, c.content); return false; } },
        { label: 'Kopieren', onClick: async () => { try { await navigator.clipboard.writeText(c.content); toast('Kopiert'); } catch { toast('Bitte manuell markieren', true); } return false; } }, { label: 'Schließen' }]);
  }

  function peerRow(p) {
    return h('div', { class: 'row sb', style: 'padding:8px 0;border-top:1px solid var(--line,#ddd);gap:8px;flex-wrap:wrap' },
      h('div', {}, h('b', {}, p.name), ' ', h('span', { class: 'pill ' + (p.online ? 'ok' : '') }, p.enabled ? (p.online ? 'verbunden' : 'offline') : 'gesperrt'), ' ',
        h('div', { class: 'hint' }, `${p.ip} · zuletzt ${ago(p.lastHandshake)}${p.from ? ' von ' + p.from : ''} · ↓ ${bytes(p.tx)} ↑ ${bytes(p.rx)}${p.endpoint ? ' · ' + p.endpoint : ''}`)),
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
        h('button', { class: 'sm primary', onclick: () => getConf(p).then((c) => download(c.filename, c.content)).catch(fail) }, '⬇ Konfiguration'),
        h('button', { class: 'sm', onclick: () => show(p) }, 'Anzeigen'),
        h('button', { class: 'sm', onclick: () => act(call('PUT', `peer/${p.id}`, { enabled: !p.enabled })) }, p.enabled ? 'Sperren' : 'Freigeben'),
        h('button', { class: 'sm', onclick: () => { if (confirm('Neue Schlüssel erzeugen? Die alte Konfiguration auf dem Gerät funktioniert danach nicht mehr.')) act(call('PUT', `peer/${p.id}`, { rekey: true })); } }, 'Neu schlüsseln'),
        h('button', { class: 'sm danger', onclick: () => { if (confirm(`Gerät „${p.name}“ löschen?`)) act(call('DELETE', `peer/${p.id}`)); } }, '🗑')));
  }

  function draw() {
    const el = box(); if (!el || !M) return;
    const p = [];
    if (M.err) p.push(h('div', { class: 'card', style: 'border-color:var(--bad)' }, h('b', { style: 'color:var(--bad)' }, 'Hinweis: '), M.err));
    if (!M.endpoints.length) p.push(h('div', { class: 'card', style: 'border-color:var(--warn,#e8a317)' }, '⚠ Kein Zugangspunkt: Das DuckDNS-Plugin einrichten (Domain + Token) oder in den WireGuard-Einstellungen eine Adresse unter „Weitere Zugangspunkte“ eintragen.'));
    p.push(h('div', { class: 'card kv' },
      h('span', {}, 'Server'), h('span', {}, `${M.up ? '🟢 läuft' : '⚪ aus'} · Schnittstelle ${M.iface} · UDP ${M.port}`),
      h('span', {}, 'VPN-Netz'), h('span', {}, `${M.subnet} (Server ${M.serverIp})`),
      h('span', {}, 'Heimnetz'), h('span', {}, M.lan || '– (in den Einstellungen eintragen)'),
      h('span', {}, 'Zugangspunkte'), h('span', {}, M.endpoints.join(', ') || '–'),
      h('span', {}, 'Ausgang (NAT)'), h('span', {}, M.wan || 'automatisch')));
    p.push(h('p', { class: 'hint' }, `Im Router muss UDP-Port ${M.port} auf diesen Rechner weitergeleitet werden.`));
    p.push(h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin:8px 0' },
      h('button', { class: 'primary', onclick: () => userDialog(null) }, '➕ Benutzer'),
      h('button', { onclick: () => act(call('POST', 'apply').then((r) => { toast(r.ok ? 'Übernommen' : r.error, !r.ok); return r.model; })) }, '↻ Neu einrichten'),
      M.up ? h('button', { class: 'danger', onclick: () => { if (confirm('VPN-Schnittstelle stoppen? Alle Verbindungen brechen ab.')) act(call('POST', 'stop')); } }, 'Stoppen') : null));
    if (!M.users.length) p.push(h('div', { class: 'empty' }, 'Noch kein Benutzer. Lege einen Benutzer an und danach seine Geräte.'));
    for (const u of M.users) {
      const ps = M.peers.filter((x) => x.userId === u.id);
      p.push(h('div', { class: 'card', style: 'margin-top:12px' },
        h('div', { class: 'row sb' }, h('div', {}, h('b', { style: 'font-size:1.1em' }, '👤 ' + u.name), ' ', u.enabled ? null : h('span', { class: 'pill bad' }, 'gesperrt'), u.note ? h('div', { class: 'hint' }, u.note) : null, h('div', { class: 'hint' }, 'Rechte: ' + permText(u))),
          h('div', { class: 'row', style: 'gap:6px' }, h('button', { class: 'sm', onclick: () => userDialog(u) }, 'Rechte'), h('button', { class: 'sm primary', onclick: () => peerDialog(u) }, '➕ Gerät'))),
        ps.length ? ps.map(peerRow) : h('div', { class: 'hint', style: 'margin-top:6px' }, 'Noch kein Gerät.')));
    }
    fill(el, ...p);
  }
  HL.on('wireguard', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('wireguard', {
    label: 'WireGuard', icon: '🔐',
    render(el) { el.append(h('h2', { class: 'page-title' }, '🔐 WireGuard'), h('div', { id: 'wg-box' })); call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail); },
  });
})();
