// Claude-Seite: Chat, Systemcheck
(() => {
  const { h, fill } = HL;
  let chat = [], busy = false, cli = null, step = '', err = '';
  const esc = (s) => String(s);
  const fmt = (t) => {
    // sehr einfache Darstellung: Absätze, Listen, **fett**, `code` – ohne HTML-Einschleusung
    const box = h('div', { style: 'line-height:1.45' });
    String(t).split(/\n{2,}/).forEach((blk) => {
      const lines = blk.split('\n');
      const isList = lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l));
      const el = h(isList ? 'ul' : 'p', { style: 'margin:6px 0;' + (isList ? 'padding-left:20px' : '') });
      (isList ? lines : [blk]).forEach((l, i) => {
        const line = isList ? l.replace(/^\s*([-*•]|\d+\.)\s+/, '') : l;
        const host = isList ? el.appendChild(h('li', {})) : el;
        line.split(/(\*\*[^*]+\*\*|`[^`]+`)/).forEach((p) => {
          if (/^\*\*[^*]+\*\*$/.test(p)) host.append(h('b', {}, p.slice(2, -2)));
          else if (/^`[^`]+`$/.test(p)) host.append(h('code', {}, p.slice(1, -1)));
          else host.append(document.createTextNode(p));
        });
        if (!isList && i < lines.length - 1) host.append(document.createElement('br'));
      });
      box.append(el);
    });
    return box;
  };
  const NAMES = { list_devices: 'Geräte lesen', list_rooms: 'Räume lesen', get_device: 'Gerät lesen', list_automations: 'Automationen lesen', get_automation: 'Automation lesen', create_automation: 'Automation anlegen', update_automation: 'Automation ändern', get_logs: 'Protokoll lesen', control_device: 'Gerät steuern', run_automation: 'Automation ausführen' };

  const draw = () => {
    const box = document.getElementById('claude-box');
    if (!box) return;
    const msgs = h('div', { id: 'claude-msgs', style: 'display:flex;flex-direction:column;gap:10px;max-height:60vh;overflow:auto;padding:4px' },
      chat.length ? chat.map((m) => h('div', { style: `align-self:${m.role === 'user' ? 'flex-end' : 'flex-start'};max-width:92%;padding:8px 12px;border-radius:12px;background:${m.role === 'user' ? 'var(--accent,#3b82f6)' : 'var(--card2,#8882)'};${m.role === 'user' ? 'color:#fff' : ''}` },
        m.role === 'user' ? h('div', {}, m.content) : fmt(m.content),
        m.used && m.used.length ? h('div', { class: 'hint', style: 'margin-top:4px' }, '🔧 ' + [...new Set(m.used)].map((n) => NAMES[n] || n).join(', ')) : null))
        : h('div', { class: 'empty' }, 'Frag mich etwas zu deinem System – oder starte den Systemcheck.'),
      busy ? h('div', { class: 'hint' }, '⏳ Claude arbeitet …' + (step ? ' (' + (NAMES[step] || step) + ')' : '')) : null);
    const input = h('textarea', { rows: 2, placeholder: 'z. B. „Lege eine Automation an: Wenn es dunkel wird und jemand zuhause ist, Wohnzimmerlicht auf 40 %“', style: 'width:100%;resize:vertical', disabled: busy });
    const send = async () => {
      const text = input.value.trim();
      if (!text || busy) return;
      busy = true; err = ''; chat = [...chat, { role: 'user', content: text }]; draw();
      try { chat = (await HL.api('claude', 'POST', 'chat', { text })).chat; } catch (e) { err = e.message || String(e); }
      busy = false; step = ''; draw();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });
    fill(box,
      cli && !cli.installed ? h('div', { class: 'card hint', style: 'color:var(--bad)' }, 'Claude Code ist auf dem Server nicht installiert: npm install -g @anthropic-ai/claude-code – danach als Dienstbenutzer „claude setup-token“ ausführen und den Token in den Plugin-Einstellungen eintragen.') : null,
      h('div', { class: 'card' }, msgs, err ? h('div', { class: 'hint', style: 'color:var(--bad)' }, err) : null),
      h('div', { class: 'card' }, input,
        h('div', { class: 'row sb', style: 'margin-top:6px' },
          h('div', { class: 'row' },
            h('button', { onclick: async () => { busy = true; err = ''; draw(); try { chat = (await HL.api('claude', 'POST', 'check', {})).chat; } catch (e) { err = e.message || String(e); } busy = false; step = ''; draw(); }, disabled: busy }, '🔍 Systemcheck'),
            h('button', { onclick: async () => { try { await HL.api('claude', 'POST', 'clear', {}); chat = []; draw(); } catch (e) { HL.fail(e); } }, disabled: busy }, 'Verlauf löschen')),
          h('button', { class: 'primary', onclick: send, disabled: busy }, 'Senden (Strg+Enter)'))));
    const m = document.getElementById('claude-msgs'); if (m) m.scrollTop = m.scrollHeight;
  };
  HL.on('claude', (d) => { if (d.step) step = d.step; if (d.busy === false && busy) { /* Antwort kommt über die Anfrage */ } draw(); });
  HL.page('claude', {
    label: 'Claude', icon: '🤖',
    render(el) {
      el.append(h('h2', { class: 'page-title' }, '🤖 Claude-Assistent'), h('div', { id: 'claude-box' }));
      draw();
      HL.api('claude', 'GET', 'chat').then((r) => { chat = r.chat || []; busy = !!r.busy; draw(); }).catch(HL.fail);
      HL.api('claude', 'GET', 'status').then((r) => { cli = r; draw(); }).catch(() => {});
    },
  });
})();
