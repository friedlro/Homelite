// Seite „Z-Wave“: Verbindung, Geräte hinzufügen/entfernen, Knotenliste
(() => {
  const { h, fill, toast, fail } = HL;
  let M = null, tick = null;
  const call = (m, sub, body) => HL.api('zwave', m, sub, body);
  const box = () => document.getElementById('zw-box');
  const when = (s) => (s ? new Date(s).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
  const ST = { Alive: ['ok', 'aktiv'], Awake: ['ok', 'wach'], Asleep: ['', 'schläft'], Dead: ['bad', 'ausgefallen'], Unknown: ['', 'unbekannt'] };
  const take = (r) => { M = r.nodes ? r : M; draw(); };
  const run = (p, msg) => p.then((r) => { if (msg) toast(msg); take(r); }).catch(fail);
  let strategy = 'insecure';

  function draw() {
    const el = box();
    if (!el || !M) return;
    const md = M.mode || {};
    const sel = h('select', { onchange: (e) => { strategy = e.target.value; } },
      [['insecure', 'Ohne Verschlüsselung (einfach, für Lampen/Sensoren)'], ['s0', 'Sicher S0 (z. B. Türschlösser)'], ['default', 'Standard (S2 – PIN-Eingabe in Z-Wave JS UI)']].map(([v, l]) => h('option', { value: v, selected: strategy === v }, l)));
    const control = md.kind
      ? h('div', { class: 'card', style: 'padding:12px;margin:10px 0;text-align:center' },
        h('b', {}, md.kind === 'include' ? '➕ Gerät hinzufügen: Anlernmodus aktiv' : '➖ Gerät entfernen: Anlernmodus aktiv'),
        h('div', { id: 'zw-cd', style: 'font-size:1.5em;margin:6px 0' }, ''),
        h('div', { class: 'hint' }, md.kind === 'include' ? 'Jetzt am Gerät die Anlerntaste drücken (meist 3× schnell).' : 'Jetzt am Gerät die Anlerntaste drücken, um es aus dem Netz zu entfernen.'),
        h('button', { style: 'margin-top:8px', onclick: () => run(call('POST', 'cancel', {})) }, 'Abbrechen'))
      : h('div', { class: 'card', style: 'padding:12px;margin:10px 0' },
        h('b', {}, 'Geräte verwalten'),
        h('div', { class: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' }, sel,
          h('button', { class: 'primary', disabled: !M.connected, onclick: () => run(call('POST', 'include', { strategy }), 'Anlernmodus gestartet') }, '➕ Gerät hinzufügen'),
          h('button', { disabled: !M.connected, onclick: () => run(call('POST', 'exclude', {}), 'Entfernmodus gestartet') }, '➖ Gerät entfernen')));
    const rows = M.nodes.length ? M.nodes.map((n) => {
      const [cls, txt] = ST[n.status] || ['', n.status || '–'];
      return h('div', { style: 'padding:10px 0;border-top:1px solid var(--line)' },
        h('div', { class: 'row sb' },
          h('div', { style: 'min-width:0' }, h('b', {}, `#${n.id} ${n.name}`), n.location ? h('span', { class: 'hint' }, '  ' + n.location) : null,
            h('div', { class: 'hint' }, [n.label, `${n.devices} Gerät${n.devices === 1 ? '' : 'e'}`, n.battery !== null ? `🔋 ${n.battery} %` : null, n.lastSeen ? 'zuletzt ' + when(n.lastSeen) : null].filter(Boolean).join(' · '))),
          h('div', { class: 'row', style: 'gap:6px;flex:none' },
            h('span', { class: 'pill ' + cls }, n.ready ? txt : 'wird eingelesen'),
            h('button', { class: 'sm', onclick: () => call('POST', 'ping', { nodeId: n.id }).then(() => toast('Ping gesendet')).catch(fail) }, 'Ping'),
            h('button', { class: 'sm', onclick: () => call('POST', 'refresh', { nodeId: n.id }).then(() => toast('Wird neu eingelesen')).catch(fail) }, '↻'),
            n.status === 'Dead' ? h('button', { class: 'sm danger', onclick: () => { if (confirm(`Ausgefallenen Knoten #${n.id} aus dem Netz entfernen? Seine Geräte werden gelöscht.`)) run(call('POST', 'remove-failed', { nodeId: n.id })); } }, 'Entfernen') : null)));
    }) : h('div', { class: 'empty' }, M.connected ? 'Noch keine Geräte – oben ➕ Gerät hinzufügen.' : 'Nicht verbunden.');
    fill(el,
      h('div', { class: 'row sb' },
        h('span', { class: 'pill ' + (M.connected ? 'ok' : 'bad') }, M.connected ? 'verbunden' : 'getrennt'),
        h('span', { class: 'hint' }, M.info && M.info.server ? `Server ${M.info.server} · ${M.url}` : M.url)),
      M.error && !M.connected ? h('div', { class: 'hint', style: 'color:var(--bad);margin-top:6px' }, M.error + ' – Einstellungen: Erweiterungen → Plugins → Z-Wave → ⚙') : null,
      control, h('b', {}, 'Knoten'), rows);
    clearInterval(tick);
    if (md.ends) tick = setInterval(() => { const n = document.getElementById('zw-cd'); if (!n) return clearInterval(tick); n.textContent = Math.max(0, Math.ceil((md.ends - Date.now()) / 1000)) + ' s'; }, 500);
  }

  HL.on('zwave', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('zwave', {
    label: 'Z-Wave', icon: '📡',
    render(el) {
      el.append(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, '📡 Z-Wave'), h('button', { onclick: () => call('POST', 'reconnect', {}).then(() => toast('Verbinde neu …')).catch(fail) }, 'Neu verbinden')), h('div', { class: 'card', id: 'zw-box' }));
      call('GET', 'model').then(take).catch(fail);
    },
  });
})();
