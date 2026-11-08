// DuckDNS-Seite: Status, IP, Domains, „Jetzt aktualisieren“
(() => {
  const { h, fill } = HL;
  let s = null;
  const when = (t) => (t ? new Date(t).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
  const draw = () => {
    const box = document.getElementById('duckdns-box');
    if (!box) return;
    if (!s) return fill(box, h('div', { class: 'empty' }, 'Lade …'));
    fill(box,
      h('div', { class: 'row sb' }, h('b', {}, s.ok === null ? 'Noch kein Update' : s.ok ? 'Aktuell' : 'Fehler'),
        h('span', { class: 'pill ' + (s.ok ? 'ok' : s.ok === false ? 'bad' : '') }, s.ok ? (s.result === 'UPDATED' ? 'IP aktualisiert' : 'unverändert') : s.ok === false ? 'Fehler' : '–')),
      s.error ? h('div', { class: 'hint', style: 'color:var(--bad)' }, s.error) : null,
      h('div', { class: 'hint' }, 'IPv4: ' + (s.ip || '–') + (s.ip6 ? '  ·  IPv6: ' + s.ip6 : '')),
      h('div', { class: 'hint' }, 'Domains: ' + (s.domains.length ? s.domains.join(', ') : 'noch keine (Einstellungen → Plugins → DuckDNS)')),
      h('div', { class: 'hint' }, `Letztes Update: ${when(s.last)} · letzte IP-Änderung: ${when(s.changed)}`));
  };
  HL.on('duckdns', (d) => { s = d.status; draw(); });
  HL.page('duckdns', {
    label: 'DuckDNS', icon: '🦆',
    render(el) {
      el.append(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, '🦆 DuckDNS'),
        h('button', { onclick: () => HL.api('duckdns', 'POST', 'update', {}).then((r) => { s = r.status; draw(); }).catch(HL.fail) }, '↻ Jetzt aktualisieren')),
        h('div', { class: 'card', id: 'duckdns-box' }));
      draw();
      HL.api('duckdns', 'GET', 'status').then((r) => { s = r.status; draw(); }).catch(HL.fail);
    },
  });
})();
