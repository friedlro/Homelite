// SSH-Seite: öffentlicher Schlüssel, Hosts mit Test, letzte Befehle
(() => {
  const { h, fill } = HL;
  let s = null;
  let edit = null; // Host in Bearbeitung (oder null = neuer Host)
  const form = () => {
    const e = edit || {};
    const f = (ph, val, type) => h('input', { placeholder: ph, value: val ?? '', type: type || 'text', autocomplete: type === 'password' ? 'new-password' : 'off', style: 'width:100%' });
    const name = f('Name (z. B. nas)', e.name); const host = f('Server (IP oder Name)', e.host); const port = f('Port', e.port || 22, 'number');
    const user = f('Benutzer', e.user); const pass = f(e.hasPassword ? '(gespeichert – leer lassen = unverändert)' : 'Passwort (leer = Schlüssel verwenden)', '', 'password');
    const clr = e.hasPassword ? h('input', { type: 'checkbox' }) : null;
    const save = () => HL.api('ssh', 'POST', 'hosts', { original: e.name, name: name.value, host: host.value, port: port.value, user: user.value, password: pass.value, clearPassword: !!(clr && clr.checked) })
      .then((r) => { s = r; edit = null; HL.toast('Gespeichert'); draw(); drawForm(); }).catch(HL.fail);
    return h('div', { style: 'margin-top:14px;padding-top:12px;border-top:1px solid var(--line)' },
      h('b', {}, edit ? `Host „${e.name}“ bearbeiten` : 'Host hinzufügen'),
      h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin:8px 0' }, name, host, port, user, pass),
      clr ? h('label', { class: 'hint' }, clr, ' Gespeichertes Passwort löschen (Schlüssel verwenden)') : null,
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: save }, edit ? 'Speichern' : 'Hinzufügen'), edit ? h('button', { onclick: () => { edit = null; drawForm(); } }, 'Abbrechen') : null),
      h('div', { class: 'hint', style: 'margin-top:6px' }, 'Das Passwort wird in HomeLite gespeichert und nie angezeigt. Sicherer ist die Anmeldung per Schlüssel (Passwort leer lassen und den öffentlichen Schlüssel oben auf dem Server eintragen).'));
  };
  const when = (t) => new Date(t).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const test = (name, btn) => { btn.disabled = true; HL.api('ssh', 'POST', 'test/' + encodeURIComponent(name), {}).then((r) => HL.toast(r.exit === 0 ? `${name}: Verbindung OK (${r.ms} ms)` : `${name}: ${r.error || (r.stderr || 'Fehler').trim().slice(0, 200)}`)).catch(HL.fail).finally(() => { btn.disabled = false; }); };
  const drawForm = () => { const b = document.getElementById('ssh-formbox'); if (b && s) fill(b, form()); };
  const draw = () => {
    const box = document.getElementById('ssh-box');
    if (!box) return;
    if (!s) return fill(box, h('div', { class: 'empty' }, 'Lade …'));
    const url = location.origin + s.mcp;
    fill(box,
      h('b', {}, 'Eigener MCP-Server für Claude'),
      h('div', { class: 'hint' }, 'Als Connector in Claude eintragen (nur SSH-Werkzeuge ssh_hosts und ssh_exec, unabhängig vom HomeLite-KI-Zugriff). Die Adresse enthält den Zugangsschlüssel – geheim halten.'),
      h('input', { readonly: true, value: url, style: 'width:100%;font-family:monospace;font-size:12px', onclick: (e) => e.target.select() }),
      h('div', { class: 'row', style: 'margin:8px 0 12px' },
        h('button', { class: 'sm', onclick: () => navigator.clipboard.writeText(url).then(() => HL.toast('Adresse kopiert')).catch(() => HL.toast('Zum Kopieren Feld anklicken')) }, 'Kopieren'),
        h('button', { class: 'sm danger', onclick: () => { if (confirm('Neuen Schlüssel erzeugen? Die alte Adresse funktioniert dann nicht mehr.')) HL.api('ssh', 'POST', 'mcp-token', {}).then((r) => { s = r; draw(); }).catch(HL.fail); } }, 'Neuer Schlüssel')),
      h('b', {}, 'Öffentlicher Schlüssel von HomeLite'),
      h('div', { class: 'hint' }, 'Für Hosts ohne Passwort: diese Zeile auf dem Ziel-Rechner in ~/.ssh/authorized_keys des Benutzers eintragen:'),
      h('textarea', { readonly: true, rows: 3, style: 'width:100%;font-family:monospace;font-size:12px', onclick: (e) => e.target.select() }, s.pub || '(noch kein Schlüssel – ist OpenSSH installiert?)'),
      h('div', { style: 'height:12px' }),
      h('b', {}, s.readonly ? 'Hosts (Befehle durch die KI ausgeschaltet)' : 'Hosts'),
      s.hosts.length ? s.hosts.map((x) => { const t = h('button', { class: 'sm' }, 'Testen'); t.onclick = () => test(x.name, t);
        return h('div', { class: 'row sb', style: 'padding:8px 0;border-top:1px solid var(--line)' },
          h('div', {}, h('b', {}, x.name), h('div', { class: 'hint' }, `${x.target} · ${x.hasPassword ? 'Passwort' : 'Schlüssel'}${x.fromConfig ? ' · aus den Plugin-Einstellungen' : ''}`)),
          h('div', { class: 'row' }, t, x.fromConfig ? null : h('button', { class: 'sm', onclick: () => { edit = x; drawForm(); } }, 'Bearbeiten'),
            x.fromConfig ? null : h('button', { class: 'sm danger', onclick: () => { if (confirm(`Host „${x.name}“ entfernen?`)) HL.api('ssh', 'DELETE', 'hosts/' + encodeURIComponent(x.name)).then((r) => { s = r; draw(); }).catch(HL.fail); } }, 'Entfernen'))); }) : h('div', { class: 'hint' }, 'Noch keine Hosts.'),
      h('div', { style: 'height:12px' }),
      h('b', {}, 'Letzte Befehle'),
      s.history.length ? s.history.map((x) => h('div', { style: 'padding:6px 0;border-top:1px solid var(--line)' },
        h('div', {}, h('span', { class: 'pill ' + (x.exit === 0 ? 'ok' : 'bad') }, x.err ? 'Fehler' : 'Exit ' + x.exit), ' ', h('b', {}, x.host), ' ', h('span', { class: 'hint' }, `${x.by} · ${when(x.ts)}`)),
        h('code', { style: 'word-break:break-all' }, x.cmd), x.err ? h('div', { class: 'hint', style: 'color:var(--bad)' }, x.err) : null)) : h('div', { class: 'hint' }, 'Noch nichts ausgeführt.'));
  };

  // ---------- Terminal ----------
  const T = { host: '', cwd: {}, hist: [], hi: -1, job: null, out: [] }; // bleibt beim Seitenwechsel erhalten
  const hostRow = () => (s && s.hosts.find((x) => x.name === T.host)) || null;
  const promptText = () => { const x = hostRow(); return x ? `${x.target.split('@')[0]}@${x.name}:${T.cwd[x.name] || '~'}$` : '$'; };
  const outEl = () => document.getElementById('ssh-out');
  const scrollDown = () => { const o = outEl(); if (o) o.scrollTop = o.scrollHeight; };
  const addOut = (text, cls) => { T.out.push([text, cls || '']); if (T.out.length > 2000) T.out.splice(0, T.out.length - 2000); const o = outEl(); if (o) { o.append(h('span', { class: cls || '' }, text)); scrollDown(); } };
  const syncPrompt = () => { const p = document.getElementById('ssh-prompt'); if (p) p.textContent = promptText(); const b = document.getElementById('ssh-stop'); if (b) b.style.display = T.job ? '' : 'none'; const i = document.getElementById('ssh-cmd'); if (i) i.disabled = !!T.job || !hostRow(); };
  const runCmd = (cmd) => {
    cmd = cmd.trim();
    if (!cmd || T.job) return;
    const x = hostRow();
    if (!x) return HL.toast('Zuerst einen Host eintragen und wählen');
    addOut(`${promptText()} ${cmd}\n`, 'cmd');
    T.hist = [cmd, ...T.hist.filter((c) => c !== cmd)].slice(0, 100); T.hi = -1;
    if (cmd === 'clear' || cmd === 'cls') { T.out = []; const o = outEl(); if (o) o.replaceChildren(); return; }
    T.job = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    syncPrompt();
    HL.api('ssh', 'POST', 'term/run', { host: x.name, cmd, cwd: T.cwd[x.name] || '', job: T.job }).catch((e) => { addOut((e.message || 'Fehler') + '\n', 'err'); T.job = null; syncPrompt(); });
  };
  const termEvent = (t) => {
    if (!t || t.job !== T.job) return;
    if (t.out) addOut(t.out, t.err ? 'err' : '');
    if (t.done) {
      const x = hostRow();
      if (t.cwd && x) T.cwd[x.name] = t.cwd;
      if (t.error) addOut(`[${t.error}]\n`, 'err'); else if (t.exit) addOut(`[Exit ${t.exit}]\n`, 'err');
      T.job = null; syncPrompt();
      const i = document.getElementById('ssh-cmd'); if (i) i.focus();
    }
  };
  const termCard = () => {
    const hostSel = h('select', { id: 'ssh-host', onchange: (e) => { T.host = e.target.value; syncPrompt(); } });
    const input = h('input', { id: 'ssh-cmd', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'Befehl eingeben, Enter zum Ausführen', style: 'flex:1;min-width:0;font-family:monospace', onkeydown: (e) => {
      if (e.key === 'Enter') { const v = input.value; input.value = ''; runCmd(v); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (T.hi < T.hist.length - 1) { T.hi++; input.value = T.hist[T.hi]; } }
      else if (e.key === 'ArrowDown') { e.preventDefault(); T.hi = Math.max(-1, T.hi - 1); input.value = T.hi >= 0 ? T.hist[T.hi] : ''; }
      else if (e.ctrlKey && e.key === 'l') { e.preventDefault(); T.out = []; outEl().replaceChildren(); }
    } });
    const out = h('pre', { id: 'ssh-out', class: 'ssh-out', onclick: () => { if (!getSelection().toString()) input.focus(); } }, T.out.map(([t, c]) => h('span', { class: c }, t)));
    const card = h('div', { class: 'card', id: 'ssh-term' },
      h('div', { class: 'row sb', style: 'flex-wrap:wrap;gap:8px' }, h('b', {}, 'Terminal'), h('div', { class: 'row' }, hostSel,
        h('button', { class: 'sm', onclick: () => { T.out = []; out.replaceChildren(); } }, 'Leeren'))),
      h('div', { class: 'hint', style: 'margin:4px 0 8px' }, 'Befehle laufen einzeln auf dem gewählten Host, das Verzeichnis (cd) bleibt erhalten. Interaktive Programme (vim, top, sudo mit Passwort) gehen nicht. ↑/↓ = frühere Befehle.'),
      out,
      h('div', { class: 'row', style: 'margin-top:8px;flex-wrap:nowrap' }, h('code', { id: 'ssh-prompt', style: 'white-space:nowrap' }, ''), input,
        h('button', { id: 'ssh-stop', class: 'sm danger', style: 'display:none', onclick: () => { if (T.job) HL.api('ssh', 'POST', 'term/cancel', { job: T.job }).catch(HL.fail); } }, 'Abbrechen (Strg+C)')));
    return card;
  };
  const syncTermHosts = () => {
    const sel = document.getElementById('ssh-host');
    if (!sel || !s) return;
    if (!s.hosts.some((x) => x.name === T.host)) T.host = s.hosts.length ? s.hosts[0].name : '';
    fill(sel, s.hosts.map((x) => h('option', { value: x.name, selected: x.name === T.host }, x.name)));
    const card = document.getElementById('ssh-term');
    if (card) card.style.display = s.terminal === false ? 'none' : '';
    syncPrompt();
  };

  HL.on('ssh', (d) => { if (d.term) return termEvent(d.term); if (d.status) { s = d.status; syncTermHosts(); } else if (d.history && s) s.history = d.history; draw(); });
  HL.page('ssh', {
    label: 'SSH', icon: '🖥',
    render(el) {
      el.append(h('h2', { class: 'page-title' }, '🖥 SSH für KI-Zugriff'), termCard(), h('div', { class: 'card', id: 'ssh-box' }), h('div', { class: 'card', id: 'ssh-formbox' }));
      draw();
      HL.api('ssh', 'GET', 'status').then((r) => { s = r; draw(); drawForm(); syncTermHosts(); }).catch(HL.fail);
    },
  });
})();
