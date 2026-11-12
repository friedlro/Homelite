// Seite „Tailscale“: Status, Geräte im Tailnet, Serve/Funnel
(() => {
  const { h, fill, toast, fail, fmtTime } = HL;
  let M = null;
  const box = () => document.getElementById('ts-box');
  const call = (m, sub) => HL.api('tailscale', m, sub, {});

  function draw() {
    const el = box(); if (!el || !M) return;
    const parts = [];
    if (!M.ok) parts.push(h('div', { class: 'card', style: 'border-color:var(--bad)' }, h('b', { style: 'color:var(--bad)' }, 'Fehler: '), M.error || 'keine Daten'));
    if (M.ok) {
      const s = M.self || {};
      parts.push(h('div', { class: 'card kv' },
        h('span', {}, 'Dieser Rechner'), h('span', {}, `${s.name || '–'} ${s.online ? '🟢' : '🔴'}`),
        h('span', {}, 'Status'), h('span', {}, M.state || '–'),
        h('span', {}, 'Tailscale-IP'), h('span', {}, (s.ips || []).join(', ') || '–'),
        h('span', {}, 'Tailnet'), h('span', {}, M.tailnet || M.suffix || '–'),
        h('span', {}, 'Version'), h('span', {}, M.version || '–'),
        h('span', {}, 'Stand'), h('span', {}, fmtTime(M.ts))));
      if (M.health && M.health.length) parts.push(h('div', { class: 'card', style: 'margin-top:12px;border-color:var(--warn,#f5a623)' }, h('b', {}, '⚠ Hinweise von Tailscale'), h('ul', {}, M.health.map((x) => h('li', {}, x)))));
      const sv = M.serve || {};
      const f = sv.funnel || [];
      parts.push(h('h2', {}, 'Freigaben (Serve / Funnel)'));
      if (f.length) parts.push(h('div', { class: 'card', style: 'border-color:var(--bad)' }, h('b', { style: 'color:var(--bad)' }, '🌐 Funnel ist aktiv – aus dem Internet erreichbar:'),
        f.map((x) => h('div', {}, h('code', {}, x.host), ' → ', x.paths.map((p) => `${p.path}${p.target ? ' (' + p.target + ')' : ''}`).join(', ') || '–')),
        h('p', { class: 'hint' }, 'Für HomeLite genügen /mcp, /hook, /trigger und /where.html. Alles andere sperrt HomeLite von außen selbst (Einstellungen → Schutz vor Zugriffen von außen). Funnel beenden: tailscale funnel reset.')));
      else parts.push(h('div', { class: 'card' }, sv.error ? 'Serve/Funnel nicht lesbar: ' + sv.error : (sv.serve && sv.serve.length ? '✅ Nur im Tailnet freigegeben (Serve), kein Funnel.' : '✅ Kein Funnel aktiv – nichts aus dem Internet erreichbar.')));
      if (sv.serve && sv.serve.length) parts.push(h('div', { class: 'card', style: 'margin-top:12px' }, h('b', {}, 'Serve (nur Tailnet)'), sv.serve.map((x) => h('div', {}, h('code', {}, x.host), ' → ', x.paths.map((p) => `${p.path}${p.target ? ' (' + p.target + ')' : ''}`).join(', ') || '–'))));
      parts.push(h('h2', {}, `Geräte im Tailnet (${M.peers.filter((p) => p.online).length}/${M.peers.length} online)`),
        h('div', { class: 'card', style: 'overflow:auto' }, h('table', {}, h('thead', {}, h('tr', {}, ['', 'Name', 'IP', 'System', 'Verbindung', 'Zuletzt'].map((x) => h('th', {}, x)))),
          h('tbody', {}, M.peers.map((p) => h('tr', {}, h('td', {}, p.online ? '🟢' : '⚪'), h('td', {}, p.name, p.exitNode ? ' (Exit-Node)' : '', p.tags && p.tags.length ? h('div', { class: 'hint' }, p.tags.join(' ')) : null), h('td', {}, p.ips[0] || ''), h('td', {}, p.os), h('td', {}, p.online ? p.path : ''), h('td', {}, p.lastSeen && !p.online ? fmtTime(p.lastSeen) : '')))))));
    }
    fill(el, ...parts);
  }
  HL.on('tailscale', (d) => { if (d.model) { M = d.model; draw(); } });
  HL.page('tailscale', {
    label: 'Tailscale', icon: '🛡️',
    render(el) {
      el.append(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, '🛡️ Tailscale'), h('button', { onclick: () => call('POST', 'refresh').then((r) => { M = r; draw(); toast('Aktualisiert'); }).catch(fail) }, '↻ Aktualisieren')), h('div', { id: 'ts-box' }));
      call('GET', 'model').then((r) => { M = r; draw(); }).catch(fail);
    },
  });
})();
