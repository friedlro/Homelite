// Flows – Oberfläche: Übersicht, visueller Editor, Verlauf, Variablen, Erweiterungen
(() => {
  const { h, fill, toast, fail, modal } = HL;
  const API = (m, s, b) => HL.api('flows', m, s, b);
  const COLORS = { 'Auslöser': '#2e9e5b', 'Logik': '#e08a00', 'Daten': '#3b82f6', 'Fluss': '#7c8cff', 'Aktion': '#a855f7', 'Erweiterung': '#14b8a6' };
  const NW = 176, PS = 22;                                  // Knotenbreite, Abstand der Ausgänge
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs, ...kids) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === null || v === undefined || v === false) continue; if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
    for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  };
  const uid = () => 'n' + Math.random().toString(36).slice(2, 9);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
  const when = (t) => new Date(t).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ST = { ok: 'ok', error: 'Fehler', handled: 'behandelt', running: 'läuft', stopped: 'gestoppt', skipped: 'übersprungen' };
  const sw = (checked, on) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange: (e) => on(e.target.checked) }));

  // ---------- Zustand ----------
  let root = null, cat = [], byType = {}, flows = [], info = {}, status = [], recent = [], view = 'list', ed = null;
  let debugList = [];
  const nodeStat = {};                                       // flowId -> { nodeId -> {s, t} }

  const defOf = (t) => byType[t] || { type: t, label: t + ' (fehlt)', category: 'Erweiterung', icon: '❓', inputs: 1, outputs: 1, fields: [], missing: true };
  const outsOf = (n) => {
    const d = defOf(n.type); let c = d.outputs === undefined ? 1 : d.outputs;
    if (d.dyn && d.dyn.fixedKey) c = Math.max(1, Math.min(10, Number((n.cfg || {})[d.dyn.fixedKey]) || 1));
    else if (d.dyn) c = Math.max(1, ((n.cfg || {})[d.dyn.list] || []).length + ((n.cfg || {})[d.dyn.elseKey] ? 1 : 0));
    return c;
  };
  const portCount = (n) => outsOf(n) + (n.onError === 'port' ? 1 : 0);
  const nodeH = (n) => Math.max(48, 18 + Math.max(portCount(n), 1) * PS);
  const outLabel = (n, i) => {
    const d = defOf(n.type);
    if (n.onError === 'port' && i === outsOf(n)) return 'Fehler';
    if (d.labels && d.labels[i]) return d.labels[i];
    if (d.dyn && d.dyn.elseKey && (n.cfg || {})[d.dyn.elseKey] && i === outsOf(n) - 1) return 'sonst';
    return outsOf(n) > 1 ? String(i + 1) : '';
  };
  const devName = (id) => { const d = HL.S && (HL.S.devices || []).find((x) => x.id === id); return d ? d.name : id; };

  async function loadCatalog() {
    const r = await API('GET', 'catalog');
    cat = r.nodes; byType = Object.fromEntries(cat.map((n) => [n.type, n])); info = { ...info, fileErrors: r.fileErrors, nodesDir: r.nodesDir, core: r.core };
  }
  async function loadFlows() { const r = await API('GET', 'flows'); flows = r.flows; status = r.status; }
  async function loadRecent() { const r = await API('GET', 'history?n=200'); recent = r.history; }

  // ---------- Seite ----------
  HL.page('flows', {
    label: 'Flows', icon: '🕸',
    render(el) {
      root = h('div', {});
      el.append(h('h2', { class: 'page-title' }, '🕸 Flows'), root);
      Promise.all([loadCatalog(), loadFlows(), loadRecent(), API('GET', 'info').then((r) => { info = { ...info, ...r }; }), API('GET', 'debug').then((r) => { debugList = r.list; })])
        .then(() => { if (!ed) go('list'); else drawEditor(); }).catch(fail);
    },
  });

  HL.on('flows', (d) => {
    if (d.t === 'nodes') {
      for (const e of d.list) {
        const m = nodeStat[e.f] = nodeStat[e.f] || {};
        m[e.n] = { s: e.s, t: Date.now() };
        if (ed && ed.flow.id === e.f) paintStatus(e.n);
        if (e.s === 'ok') setTimeout(() => { const x = (nodeStat[e.f] || {})[e.n]; if (x && x.s === 'ok' && Date.now() - x.t > 1400) { delete nodeStat[e.f][e.n]; if (ed && ed.flow.id === e.f) paintStatus(e.n); } }, 1600);
      }
    } else if (d.t === 'exec') {
      const i = recent.findIndex((x) => x.id === d.e.id);
      if (i >= 0) recent[i] = d.e; else recent.unshift(d.e);
      if (recent.length > 200) recent.length = 200;
      if (root && view === 'list' && !ed) drawList();
      if (root && view === 'hist') drawHist();
      if (ed && ed.tab === 'runs') drawSide();
    } else if (d.t === 'debug') {
      debugList.push(d.e); if (debugList.length > 200) debugList.shift();
      if (ed && ed.tab === 'debug') drawSide();
    } else if (d.t === 'catalog') { loadCatalog().then(() => { if (ed) drawEditor(); }).catch(() => {}); }
  });

  function go(v) {
    if (ed && ed.dirty && !confirm('Nicht gespeicherte Änderungen verwerfen?')) return;
    ed = null; view = v;
    if (v === 'list') drawList(); else if (v === 'hist') { loadRecent().then(drawHist).catch(fail); } else if (v === 'ctx') drawCtx(); else if (v === 'help') drawHelp();
  }

  function tabs() {
    return h('div', { class: 'fl-tabs' }, ...[['list', 'Flows'], ['hist', 'Verlauf'], ['ctx', 'Variablen'], ['help', 'Erweitern & Hilfe']].map(([k, l]) => h('button', { class: view === k ? 'act' : '', onclick: () => go(k) }, l)));
  }

  // ---------- Übersicht ----------
  function lastOf(id) { return recent.find((e) => e.flow === id); }
  function drawList() {
    const stat = (id) => status.find((s) => s.id === id) || {};
    fill(root, tabs(),
      h('div', { class: 'fl-row', style: 'margin-bottom:12px' },
        h('button', { class: 'primary', onclick: () => openFlow(newFlow()) }, '+ Neuer Flow'),
        h('button', { onclick: importDlg }, 'Importieren'),
        h('span', { class: 'hint' }, 'Flows verbinden Auslöser, Bedingungen und Aktionen visuell – für alles, was eine einfache Automation nicht kann.')),
      flows.length ? h('div', { class: 'fl-grid' }, flows.map((f) => {
        const last = lastOf(f.id); const st = stat(f.id);
        const trig = [...new Set(f.nodes.map((n) => defOf(n.type)).filter((d) => d.trigger && d.type !== 'catch' && d.type !== 'flow-in').map((d) => d.icon + ' ' + d.label))];
        return h('div', { class: 'card fl-card' },
          h('div', { class: 'fl-row sb' }, h('div', { class: 't' }, f.name), sw(f.enabled, async (on) => { try { const r = await API('POST', `flow/${f.id}/enable`, { enabled: on }); f.enabled = r.enabled; st.errors = r.errors; if (Object.keys(r.errors || {}).length) toast('Ein Auslöser konnte nicht starten: ' + Object.values(r.errors)[0], true); drawList(); } catch (e) { fail(e); drawList(); } })),
          h('div', { class: 'fl-chips' }, h('span', { class: 'fl-chip' }, f.nodes.length + ' Knoten'), trig.slice(0, 4).map((t) => h('span', { class: 'fl-chip' }, t)),
            last ? h('span', { class: 'fl-chip ' + last.status }, `${ST[last.status] || last.status} · ${when(last.t0)}`) : h('span', { class: 'fl-chip' }, 'noch nie gelaufen')),
          f.note ? h('div', { class: 'hint' }, trunc(f.note, 140)) : null,
          Object.keys(st.errors || {}).length ? h('div', { class: 'hint', style: 'color:var(--bad)' }, '⚠ ' + Object.values(st.errors)[0]) : null,
          h('div', { class: 'fl-row' },
            h('button', { class: 'sm primary', onclick: () => openFlow(f) }, 'Öffnen'),
            h('button', { class: 'sm', onclick: async () => { try { const r = await API('POST', `flow/${f.id}/run`, {}); toast(`Lauf: ${ST[r.status] || r.status} (${r.ms} ms)`, r.status === 'error'); await loadRecent(); drawList(); } catch (e) { fail(e); } } }, '▶ Test'),
            h('button', { class: 'sm', onclick: async () => { try { const c = clone(f); delete c.id; c.name += ' (Kopie)'; c.enabled = false; const r = await API('POST', 'flow', { flow: c }); await loadFlows(); toast('Dupliziert'); drawList(); void r; } catch (e) { fail(e); } } }, 'Duplizieren'),
            h('button', { class: 'sm', onclick: () => exportFlow(f) }, 'Export'),
            h('button', { class: 'sm danger', onclick: () => { modal('Flow löschen?', h('p', {}, `„${f.name}“ wird samt Verlauf gelöscht.`), [{ label: 'Abbrechen' }, { label: 'Löschen', danger: true, onClick: async () => { await API('DELETE', `flow/${f.id}`); await loadFlows(); drawList(); } }]); } }, '🗑')));
      })) : h('div', { class: 'empty' }, 'Noch keine Flows. Lege einen an oder importiere einen – oder bitte die KI, einen zu entwerfen.'));
  }

  function newFlow() {
    return { id: '', name: 'Neuer Flow', enabled: false, settings: { concurrency: 'parallel', notifyOnError: false }, note: '', nodes: [{ id: uid(), type: 'trigger-manual', name: '', x: 60, y: 80, cfg: {} }], edges: [] };
  }
  function exportFlow(f) {
    const data = JSON.stringify({ homelite: 'flow', ...f, id: undefined, enabled: undefined }, null, 2);
    const body = h('div', {}, h('p', { class: 'hint' }, 'Zum Weitergeben oder Sichern. Passwörter in Feldern sind enthalten!'), h('textarea', { class: 'fl-pre', style: 'width:100%;height:300px', readonly: true }, data));
    modal('Export: ' + f.name, body, [{ label: 'Schließen' }, { label: 'Kopieren', primary: true, onClick: async () => { try { await navigator.clipboard.writeText(data); toast('Kopiert'); } catch { toast('Bitte manuell markieren und kopieren', true); } return false; } }]);
  }
  function importDlg() {
    const ta = h('textarea', { style: 'width:100%;height:260px', placeholder: 'Exportierten Flow (JSON) hier einfügen' });
    modal('Flow importieren', h('div', {}, h('p', { class: 'hint' }, 'Der Flow wird ausgeschaltet angelegt.'), ta), [{ label: 'Abbrechen' }, { label: 'Importieren', primary: true, onClick: async () => { const r = await API('POST', 'import', { flow: ta.value }); await loadFlows(); openFlow(r.flow); } }]);
  }

  // ---------- Verlauf ----------
  let histFilter = '';
  function drawHist() {
    const list = recent.filter((e) => !histFilter || e.flow === histFilter);
    fill(root, tabs(),
      h('div', { class: 'fl-row', style: 'margin-bottom:10px' },
        HL.sel({ '': 'Alle Flows', ...Object.fromEntries(flows.map((f) => [f.id, f.name])) }, histFilter, (v) => { histFilter = v; drawHist(); }),
        h('button', { class: 'sm', onclick: () => loadRecent().then(drawHist).catch(fail) }, 'Aktualisieren'),
        h('button', { class: 'sm danger', onclick: async () => { await API('DELETE', 'history' + (histFilter ? '?flow=' + histFilter : '')); await loadRecent(); drawHist(); } }, 'Verlauf löschen')),
      list.length ? h('div', { class: 'card' }, h('table', { class: 'fl-tbl' }, h('tr', {}, ['Zeit', 'Flow', 'Auslöser', 'Dauer', 'Schritte', 'Status'].map((x) => h('th', {}, x))),
        list.slice(0, 100).map((e) => h('tr', { style: 'cursor:pointer', onclick: () => showExec(e.id) },
          h('td', {}, when(e.t0)), h('td', {}, e.flowName), h('td', {}, (e.trigger && e.trigger.name) || '', e.why ? h('div', { class: 'hint' }, e.why) : null), h('td', {}, e.ms + ' ms'), h('td', {}, e.steps),
          h('td', { class: e.status === 'ok' ? 'ok' : e.status === 'error' ? 'bad' : '' }, ST[e.status] || e.status, e.errors && e.errors[0] ? h('div', { class: 'hint' }, trunc(e.errors[0].message, 70)) : null))))) : h('div', { class: 'empty' }, 'Noch keine Läufe aufgezeichnet.'));
  }
  async function showExec(id) {
    try {
      const { exec } = await API('GET', 'history/' + id);
      const rows = exec.trace.map((t) => h('tr', {},
        h('td', {}, t.i + 1), h('td', {}, defOf(t.type).icon + ' ' + t.name, t.retries ? h('div', { class: 'hint' }, t.retries + ' Wiederholung(en)') : null), h('td', {}, t.ms + ' ms'),
        h('td', {}, h('pre', { class: 'fl-pre' }, t.in)), h('td', {}, t.err ? h('div', { style: 'color:var(--bad)' }, '⚠ ' + t.err) : null, t.out.map((o) => h('pre', { class: 'fl-pre' }, o)))));
      const btns = [{ label: 'Schließen' }];
      if (ed && ed.flow.id === exec.flow) btns.push({ label: 'Daten im Editor zeigen', primary: true, onClick: () => { ed.last = Object.fromEntries(exec.trace.map((t) => [t.node, t])); ed.tab = 'node'; drawSide(); toast('Ein-/Ausgänge im Reiter „Knoten“ sichtbar'); } });
      modal(`${exec.flowName} · ${ST[exec.status] || exec.status}`, h('div', {},
        h('div', { class: 'hint' }, `${when(exec.t0)} · ${exec.ms} ms · ${exec.steps} Schritte${exec.why ? ' · ' + exec.why : ''}`),
        exec.errors.map((e) => h('div', { style: 'color:var(--bad);margin:6px 0' }, `⚠ ${e.name || ''}: ${e.message}`)),
        h('table', { class: 'fl-tbl' }, h('tr', {}, ['#', 'Knoten', 'Zeit', 'Eingang', 'Ausgang / Fehler'].map((x) => h('th', {}, x))), rows),
        exec.truncated ? h('div', { class: 'hint' }, 'Ablauf gekürzt (mehr als 400 Schritte).') : null), btns);
    } catch (e) { fail(e); }
  }

  // ---------- Variablen ----------
  async function drawCtx() {
    let c; try { c = await API('GET', 'context'); } catch (e) { return fail(e); }
    const row = (scope, flow, k, v) => h('tr', {}, h('td', {}, h('code', { class: 'fl-c' }, k)), h('td', {}, h('pre', { class: 'fl-pre' }, JSON.stringify(v))),
      h('td', {}, h('button', { class: 'sm', onclick: () => editVar(scope, flow, k, v) }, '✏️'), h('button', { class: 'sm danger', onclick: async () => { await API('POST', 'context', { scope, flow, key: k, delete: true }); drawCtx(); } }, '🗑')));
    const block = (title, scope, flow, obj) => h('div', { class: 'card', style: 'margin-bottom:12px' }, h('div', { class: 'fl-row sb' }, h('b', {}, title), h('button', { class: 'sm', onclick: () => editVar(scope, flow, '', '') }, '+ Variable')),
      Object.keys(obj).length ? h('table', { class: 'fl-tbl' }, Object.entries(obj).map(([k, v]) => row(scope, flow, k, v))) : h('div', { class: 'hint' }, 'leer'));
    fill(root, tabs(), h('p', { class: 'hint' }, 'Variablen bleiben zwischen den Läufen (auch nach Neustart) erhalten. In Flows: Ausdruck {{ flow.name }} / {{ global.name }}, Knoten „Werte setzen“ mit Ziel flow.name, im Code flow.name = …'),
      block('Global (alle Flows)', 'global', '', c.global), flows.map((f) => block('Flow: ' + f.name, 'flow', f.id, c.flows[f.id] || {})));
  }
  function editVar(scope, flow, key, val) {
    const k = h('input', { value: key, placeholder: 'name' }), v = h('textarea', { style: 'width:100%;height:120px' }, key ? JSON.stringify(val, null, 2) : '');
    modal('Variable', h('div', {}, HL.fld('Name', k), HL.fld('Wert (JSON oder Text)', v)), [{ label: 'Abbrechen' }, { label: 'Speichern', primary: true, onClick: async () => {
      let x = v.value; try { x = JSON.parse(x); } catch { /* Text */ }
      await API('POST', 'context', { scope, flow, key: k.value.trim(), value: x }); drawCtx();
    } }]);
  }

  // ---------- Erweitern & Hilfe ----------
  function drawHelp() {
    const expr = h('input', { value: 'Temperatur: {{ payload.t * 2 }} °C', style: 'width:100%' }), msg = h('textarea', { style: 'width:100%;height:70px' }, '{"payload": {"t": 21.5}, "topic": "test"}'), out = h('pre', { class: 'fl-pre' });
    const test = async () => { try { const r = await API('POST', 'expr', { expr: expr.value, msg: JSON.parse(msg.value) }); out.textContent = r.ok ? JSON.stringify(r.value) : '⚠ ' + r.error; } catch (e) { out.textContent = '⚠ ' + e.message; } };
    const url = location.origin + (info.hook || '') + '/';
    fill(root, tabs(),
      h('div', { class: 'card', style: 'margin-bottom:12px' }, h('h3', {}, 'Wie Flows arbeiten'),
        h('p', {}, 'Ein Flow besteht aus Knoten. Ein ', h('b', {}, 'Auslöser'), ' (Gerät, Zeitplan, Webhook, MQTT …) startet den Lauf mit einer Nachricht ', h('code', { class: 'fl-c' }, 'msg'), ' (Feld ', h('code', { class: 'fl-c' }, 'payload'), ' = Inhalt). Jeder Knoten verarbeitet sie und reicht sie über seine Ausgänge weiter – auch parallel in mehrere Zweige.'),
        h('ul', {}, h('li', {}, 'In jedem Textfeld sind ', h('code', { class: 'fl-c' }, '{{ Ausdruck }}'), ' erlaubt, z. B. ', h('code', { class: 'fl-c' }, '{{ payload.temp > 25 }}'), ', ', h('code', { class: 'fl-c' }, '{{ $device("Wohnzimmer").power }}'), ', ', h('code', { class: 'fl-c' }, '{{ $node["Gerät lesen"].payload }}'), ', ', h('code', { class: 'fl-c' }, '{{ flow.zaehler }}'), '.'),
          h('li', {}, 'Hilfsfunktionen: ', h('code', { class: 'fl-c' }, '$fmt(zeit,"HH:mm")  $round(x,1)  $sum/$avg/$min/$max(liste)  $num(x)  $now  $sun.sunset'), '.'),
          h('li', {}, 'Fehler: pro Knoten „bei Fehler“ (abbrechen / weitermachen / Fehlerausgang) und Wiederholungen; flowweit der Knoten „Fehler abfangen“.'),
          h('li', {}, 'Komplexe Abläufe: Weiche, Schleife, Aufteilen/Zusammenführen, Zweige vereinen, Auf Gerät warten, Unterflows („Flow aufrufen“), Code-Knoten.'),
          h('li', {}, 'Läufe mit allen Zwischenwerten findest du unter „Verlauf“, Live-Werte in der Debug-Leiste des Editors.'))),
      h('div', { class: 'card', style: 'margin-bottom:12px' }, h('h3', {}, 'Ausdruck ausprobieren'), expr, msg, h('div', { class: 'fl-row', style: 'margin-top:6px' }, h('button', { class: 'sm primary', onclick: test }, 'Auswerten')), out),
      h('div', { class: 'card', style: 'margin-bottom:12px' }, h('h3', {}, 'Webhook-Adresse'),
        h('p', { class: 'hint' }, 'Basis für Webhook-Auslöser. Wer die Adresse kennt, kann Flows starten – daher geheim halten (mit Zusatz-Passwort im Auslöser absichern).'),
        h('div', { class: 'fl-row' }, h('code', { class: 'fl-c', style: 'word-break:break-all' }, url + '<pfad>'), h('button', { class: 'sm', onclick: () => navigator.clipboard && navigator.clipboard.writeText(url).then(() => toast('Kopiert')) }, 'Kopieren'),
          h('button', { class: 'sm danger', onclick: async () => { if (!confirm('Neue Adresse erzeugen? Die alte funktioniert dann nicht mehr.')) return; const r = await API('POST', 'hook/regenerate'); info.hook = r.path; drawHelp(); } }, 'Neu erzeugen'))),
      h('div', { class: 'card' }, h('h3', {}, 'Eigene Knoten (Erweiterungen)'),
        h('p', {}, 'Lege JavaScript-Dateien in diesen Ordner auf dem Server: ', h('code', { class: 'fl-c' }, info.nodesDir || '')),
        h('p', { class: 'hint' }, 'Die Datei „_beispiel.js“ dort erklärt den Aufbau (Felder, run(), start()). Ein Knoten erscheint danach in der Palette – ohne Programmierung der Oberfläche, die Felder bauen das Formular. Auch andere Plugins können Knoten über api.use("flows").registerNode(…) bereitstellen.'),
        (info.fileErrors || []).map((e) => h('div', { style: 'color:var(--bad)' }, `⚠ ${e.file}: ${e.error}`)),
        h('div', { class: 'fl-row' }, h('button', { class: 'sm primary', onclick: async () => { try { const r = await API('POST', 'reload-nodes'); info.fileErrors = r.errors; await loadCatalog(); toast('Erweiterungen neu geladen'); drawHelp(); } catch (e) { fail(e); } } }, 'Erweiterungen neu laden')),
        h('div', { class: 'hint', style: 'margin-top:8px' }, `${cat.length} Knotentypen geladen (${cat.filter((n) => n.owner !== 'eingebaut').length} Erweiterungen).`)));
  }

  // ---------- Formulare (aus den Feldbeschreibungen der Knoten) ----------
  const fval = (f, cfg) => (cfg[f.key] !== undefined ? cfg[f.key] : f.default);
  const shown = (f, cfg, all) => {
    const s = f.showIf; if (!s) return true;
    const ref = all.find((x) => x.key === s.key); const v = cfg[s.key] !== undefined ? cfg[s.key] : ref ? ref.default : undefined;
    if (s.in) return s.in.includes(v);
    if (s.notIn) return !s.notIn.includes(v);
    return v === s.eq;
  };
  const defaultsOf = (fields) => { const c = {}; for (const f of fields || []) if (f.default !== undefined) c[f.key] = clone(f.default); return c; };

  function renderForm(fields, cfg, opt = {}) {
    const box = h('div', {}); const exprMode = {};
    const redo = () => build();
    function field(f) {
      const set = (v, struct) => { cfg[f.key] = v; if (opt.onChange) opt.onChange(); if (struct) redo(); };
      const v = fval(f, cfg);
      const wrap = (input, extra) => h('div', { class: 'fl-f' + (extra || '') + (opt.row && f.w ? ' w' + f.w : '') }, f.label && f.type !== 'bool' ? h('label', { class: 'l' }, f.label) : null, input, f.help ? h('div', { class: 'h' }, f.help) : null);
      switch (f.type) {
        case 'bool': return h('div', { class: 'fl-f' }, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!v, onchange: (e) => set(e.target.checked, true) }), f.label), f.help ? h('div', { class: 'h' }, f.help) : null);
        case 'number': return wrap(h('input', { type: 'number', step: 'any', value: v === undefined ? '' : v, oninput: (e) => set(e.target.value === '' ? '' : Number(e.target.value)) }));
        case 'select': return wrap(HL.sel(f.options, v, (x) => set(x, true)));
        case 'time': return wrap(h('input', { type: 'time', value: v || '', onchange: (e) => set(e.target.value) }));
        case 'textarea': case 'json': return wrap(h('textarea', { rows: f.rows || 3, placeholder: f.placeholder || '', oninput: (e) => set(e.target.value) }, v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)));
        case 'code': return wrap(h('textarea', { class: 'code', spellcheck: 'false', oninput: (e) => set(e.target.value), onkeydown: (e) => { if (e.key === 'Tab') { e.preventDefault(); const t = e.target, s = t.selectionStart; t.setRangeText('  ', s, t.selectionEnd, 'end'); set(t.value); } } }, v === undefined ? '' : v));
        case 'combo': {
          const id = 'dl' + Math.random().toString(36).slice(2, 7); let opts = f.options || [];
          return wrap(h('div', {}, h('input', { value: v === undefined ? '' : v, list: id, placeholder: f.placeholder || '', oninput: (e) => set(e.target.value) }), h('datalist', { id }, opts.map((o) => h('option', { value: o })))));
        }
        case 'weekdays': {
          const cur = Array.isArray(v) ? v.map(Number) : [];
          return wrap(h('div', { class: 'fl-days' }, [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [0, 'So']].map(([d, l]) => h('button', { type: 'button', class: 'sm' + (cur.includes(d) ? ' act' : ''), onclick: () => set(cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d], true) }, l))));
        }
        case 'device': {
          const devs = ((HL.S && HL.S.devices) || []).slice().sort((a, b) => (a.room || '').localeCompare(b.room || '') || a.name.localeCompare(b.name));
          const known = devs.some((d) => d.id === v);
          if (exprMode[f.key] || (v && !known)) return wrap(h('div', { class: 'fl-row' }, h('input', { class: 'fl-grow', value: v || '', placeholder: 'Name, ID, Liste oder {{ Ausdruck }}', oninput: (e) => set(e.target.value) }), h('button', { type: 'button', class: 'sm', onclick: () => { exprMode[f.key] = false; set('', true); } }, '◂ Liste')));
          const rooms = [...new Set(devs.map((d) => d.room || 'Ohne Raum'))];
          return wrap(h('div', { class: 'fl-row' }, h('select', { class: 'fl-grow', onchange: (e) => set(e.target.value) }, h('option', { value: '' }, f.help && /Leer/.test(f.help) ? '— jedes Gerät —' : '— wählen —'),
            rooms.map((r) => h('optgroup', { label: r }, devs.filter((d) => (d.room || 'Ohne Raum') === r).map((d) => h('option', { value: d.id, selected: d.id === v }, d.name)))), 
          ), h('button', { type: 'button', class: 'sm', title: 'Ausdruck / mehrere Geräte', onclick: () => { exprMode[f.key] = true; redo(); } }, 'ƒ')), '');
        }
        case 'flowref': {
          const o = { '': '— wählen —', ...Object.fromEntries(flows.filter((x) => !ed || x.id !== ed.flow.id).map((x) => [x.id, x.name])) };
          return wrap(HL.sel(o, v || '', (x) => set(x)));
        }
        case 'hookurl': {
          const p = (cfg.path !== undefined ? cfg.path : 'mein-hook');
          return wrap(h('code', { class: 'fl-c', style: 'word-break:break-all' }, location.origin + (info.hook || '/hook/flows/…') + '/' + String(p).replace(/^\/+/, '')), ' ');
        }
        case 'list': {
          if (!Array.isArray(cfg[f.key])) cfg[f.key] = clone(f.default || []);
          const rows = cfg[f.key];
          return h('div', { class: 'fl-f' }, h('label', { class: 'l' }, f.label),
            rows.map((row, i) => h('div', { class: 'fl-lrow' },
              renderForm(f.item, row, { onChange: opt.onChange, row: true }),
              h('div', { class: 'fl-row' },
                h('button', { type: 'button', class: 'sm', disabled: i === 0, onclick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; set(rows, true); } }, '↑'),
                h('button', { type: 'button', class: 'sm', disabled: i === rows.length - 1, onclick: () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; set(rows, true); } }, '↓'),
                h('button', { type: 'button', class: 'sm danger', onclick: () => { rows.splice(i, 1); set(rows, true); } }, '✕')))),
            h('button', { type: 'button', class: 'sm', onclick: () => { rows.push(defaultsOf(f.item)); set(rows, true); } }, f.addLabel || '+ Hinzufügen'));
        }
        default: return wrap(h('input', { value: v === undefined ? '' : v, placeholder: f.placeholder || '', oninput: (e) => set(e.target.value) }));
      }
    }
    function build() { fill(box, fields.filter((f) => shown(f, cfg, fields)).map(field)); }
    build();
    if (opt.row) box.style.display = 'contents';
    return box;
  }

  // ---------- Editor ----------
  const snapG = (v) => Math.round(v / 10) * 10;
  const catColor = (d) => d.color || COLORS[d.category] || '#888';

  function openFlow(f) {
    const flow = clone(f);
    flow.settings = flow.settings || { concurrency: 'parallel', notifyOnError: false };
    ed = { flow, dirty: !f.id, sel: new Set(), selEdge: null, view: { x: 40, y: 40, k: 1 }, undo: [], redo: [], tab: 'debug', last: {}, els: new Map(), edgeEls: new Map(), fitted: false, tap: {}, palOpen: false, sideOpen: false, q: '', closed: {} };
    if (flow.nodes.length > 1 && flow.nodes.every((n) => !n.x && !n.y)) autoLayout(true);
    view = 'edit';
    drawEditor();
  }

  function snapshot() { ed.undo.push(JSON.stringify({ n: ed.flow.nodes, e: ed.flow.edges })); if (ed.undo.length > 60) ed.undo.shift(); ed.redo = []; dirty(); }
  function dirty() { ed.dirty = true; const b = document.getElementById('fl-dirty'); if (b) b.textContent = '● ungespeichert'; }
  function restore(from, to) {
    const s = from.pop(); if (!s) return;
    to.push(JSON.stringify({ n: ed.flow.nodes, e: ed.flow.edges }));
    const o = JSON.parse(s); ed.flow.nodes = o.n; ed.flow.edges = o.e; ed.sel.clear(); ed.selEdge = null; dirty(); renderAll(); drawSide();
  }

  function drawEditor() {
    const f = ed.flow;
    const name = h('input', { class: 'fl-name', value: f.name, oninput: (e) => { f.name = e.target.value; dirty(); } });
    const bar = h('div', { class: 'fl-bar' },
      h('button', { onclick: () => go('list') }, '←'), name, h('span', { class: 'fl-dirty', id: 'fl-dirty' }, ed.dirty ? '● ungespeichert' : ''),
      h('button', { class: 'primary', onclick: () => saveFlow().catch(fail) }, 'Speichern'),
      h('label', { class: 'fl-row', style: 'gap:6px' }, sw(f.enabled, async (on) => { try { if (!f.id || ed.dirty) await saveFlow(); const r = await API('POST', `flow/${f.id}/enable`, { enabled: on }); f.enabled = r.enabled; const fl = flows.find((x) => x.id === f.id); if (fl) fl.enabled = r.enabled; if (Object.keys(r.errors || {}).length) toast('Auslöser nicht gestartet: ' + Object.values(r.errors)[0], true); else toast(on ? 'Flow ist aktiv' : 'Flow ist aus'); } catch (e) { fail(e); drawEditor(); } }), h('span', { class: 'hint' }, 'aktiv')),
      h('button', { onclick: () => runFlow().catch(fail) }, '▶ Test'),
      h('span', { class: 'sep' }),
      h('button', { title: 'Rückgängig (Strg+Z)', onclick: () => restore(ed.undo, ed.redo) }, '↶'), h('button', { title: 'Wiederholen', onclick: () => restore(ed.redo, ed.undo) }, '↷'),
      h('button', { title: 'Auswahl löschen (Entf)', onclick: delSel }, '🗑'),
      h('button', { onclick: () => fit() }, 'Einpassen'),
      h('button', { onclick: menu }, '⋯'),
      h('button', { class: 'fl-mob', onclick: () => { ed.palOpen = !ed.palOpen; ed.sideOpen = false; syncDrawers(); } }, '＋ Knoten'),
      h('button', { class: 'fl-mob', onclick: () => { ed.sideOpen = !ed.sideOpen; ed.palOpen = false; syncDrawers(); } }, '☰ Panel'));
    ed.pal = h('div', { class: 'fl-pal' }); ed.side = h('div', { class: 'fl-side' }); ed.canvas = h('div', { class: 'fl-canvas' });
    fill(root, h('div', { class: 'fl-ed' }, bar, h('div', { class: 'fl-main' }, ed.pal, ed.canvas, ed.side)));
    drawPalette(); drawCanvas(); drawSide(); syncDrawers();
  }
  function syncDrawers() { ed.pal.classList.toggle('open', ed.palOpen); ed.side.classList.toggle('open', ed.sideOpen); }

  async function saveFlow() {
    const r = await API('POST', 'flow', { flow: ed.flow });
    const keep = { x: 0 }; void keep;
    ed.flow.id = r.flow.id; ed.flow.updated = r.flow.updated;
    ed.dirty = false; const b = document.getElementById('fl-dirty'); if (b) b.textContent = '';
    await loadFlows();
    const st = status.find((s) => s.id === ed.flow.id);
    if (st && Object.keys(st.errors || {}).length) toast('Gespeichert – aber: ' + Object.values(st.errors)[0], true); else toast('Gespeichert');
  }
  async function runFlow(nodeId, msg) {
    if (!ed.flow.id || ed.dirty) await saveFlow();
    const r = await API('POST', `flow/${ed.flow.id}/run`, { node: nodeId, msg });
    toast(`Testlauf: ${ST[r.status] || r.status} (${r.ms} ms)${r.errors && r.errors[0] ? ' – ' + r.errors[0].message : ''}`, r.status === 'error');
    await loadRecent(); ed.tab = 'runs'; drawSide();
    try { const { exec } = await API('GET', 'history/' + r.id); ed.last = Object.fromEntries(exec.trace.map((t) => [t.node, t])); } catch { /* egal */ }
  }

  function menu() {
    const f = ed.flow;
    const mk = (label, fn) => h('button', { style: 'display:block;width:100%;margin-bottom:6px;text-align:left', onclick: () => { document.getElementById('overlay').classList.remove('show'); fn(); } }, label);
    modal('Weitere Aktionen', h('div', {}, mk('⚙ Flow-Einstellungen', settingsDlg), mk('▶ Testlauf mit eigenem Wert …', testDlg), mk('🧹 Knoten automatisch anordnen', () => { snapshot(); autoLayout(); renderAll(); fit(); }), mk('📋 Auswahl kopieren (Strg+C)', copySel), mk('📥 Einfügen (Strg+V)', paste), mk('⏪ Frühere Versionen', versions), mk('📤 Export (JSON)', () => exportFlow(f))), [{ label: 'Schließen' }]);
  }
  function settingsDlg() {
    const f = ed.flow; const s = f.settings; const note = h('textarea', { style: 'width:100%;height:80px' }, f.note || '');
    modal('Flow-Einstellungen', h('div', {},
      HL.fld('Beschreibung', note),
      HL.fld('Wenn der Auslöser erneut feuert, während der Flow noch läuft', HL.sel({ parallel: 'parallel weiterlaufen lassen', skip: 'überspringen', queue: 'hintereinander abarbeiten (Warteschlange)' }, s.concurrency, (v) => { s.concurrency = v; })),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!s.notifyOnError, onchange: (e) => { s.notifyOnError = e.target.checked; } }), 'Bei einem Fehler benachrichtigen')),
    [{ label: 'Abbrechen' }, { label: 'Übernehmen', primary: true, onClick: () => { f.note = note.value; dirty(); } }]);
  }
  function testDlg() {
    const trig = ed.flow.nodes.filter((n) => defOf(n.type).trigger && n.type !== 'catch');
    if (!trig.length) return toast('Der Flow hat keinen Auslöser', true);
    let nid = trig[0].id; const ta = h('textarea', { style: 'width:100%;height:110px' }, '{"payload": "Test"}');
    modal('Testlauf', h('div', {}, HL.fld('Ab Auslöser', HL.sel(Object.fromEntries(trig.map((n) => [n.id, n.name || defOf(n.type).label])), nid, (v) => { nid = v; })), HL.fld('Start-Nachricht (JSON)', ta), h('p', { class: 'hint' }, 'Aktionen im Flow werden wirklich ausgeführt.')), [{ label: 'Abbrechen' }, { label: 'Starten', primary: true, onClick: async () => { let m; try { m = JSON.parse(ta.value); } catch { throw new Error('Kein gültiges JSON'); } await runFlow(nid, m); } }]);
  }
  async function versions() {
    try {
      const r = await API('GET', `flow/${ed.flow.id}/revisions`);
      if (!r.revisions.length) return toast('Noch keine früheren Versionen');
      modal('Frühere Versionen', h('div', {}, r.revisions.map((v) => h('div', { class: 'fl-run' }, h('div', { class: 'fl-grow' }, when(v.ts), h('div', { class: 'hint' }, `${v.name} · ${v.nodes} Knoten · von ${v.by}`)),
        h('button', { class: 'sm', onclick: async () => { if (!confirm('Diese Version wiederherstellen? (Der Flow wird danach ausgeschaltet)')) return; try { const x = await API('POST', `flow/${ed.flow.id}/restore`, { i: v.i }); await loadFlows(); ed.dirty = false; document.getElementById('overlay').classList.remove('show'); openFlow(x.flow); } catch (e) { fail(e); } } }, 'Wiederherstellen')))), [{ label: 'Schließen' }]);
    } catch (e) { fail(e); }
  }
  function exportFlowNow() { exportFlow(ed.flow); }
  void exportFlowNow;

  // ----- Palette -----
  function drawPalette() {
    const q = ed.q.toLowerCase();
    const cats = ['Auslöser', 'Logik', 'Daten', 'Fluss', 'Aktion', 'Erweiterung'];
    const search = h('input', { placeholder: 'Knoten suchen …', value: ed.q, oninput: (e) => { ed.q = e.target.value; drawPaletteList(); } });
    ed.palList = h('div', {});
    fill(ed.pal, search, ed.palList);
    drawPaletteList(cats);
  }
  function drawPaletteList(cats) {
    cats = cats || ['Auslöser', 'Logik', 'Daten', 'Fluss', 'Aktion', 'Erweiterung'];
    const q = ed.q.toLowerCase();
    fill(ed.palList, cats.map((c) => {
      const items = cat.filter((n) => n.category === c && (!q || (n.label + ' ' + n.desc + ' ' + n.type).toLowerCase().includes(q)));
      if (!items.length) return null;
      const closed = ed.closed[c] && !q;
      return [h('div', { class: 'fl-pcat', onclick: () => { ed.closed[c] = !ed.closed[c]; drawPaletteList(); } }, (closed ? '▸ ' : '▾ ') + c), closed ? null : items.map((n) => h('div', { class: 'fl-pitem', style: `--nc:${catColor(n)}`, title: n.desc, onpointerdown: (ev) => palDown(ev, n) }, h('span', {}, n.icon), h('span', {}, n.label)))];
    }));
  }
  function palDown(ev, d) {
    if (ev.pointerType === 'mouse') ev.preventDefault();
    const sx = ev.clientX, sy = ev.clientY; let ghost = null, moved = false;
    const mv = (e) => {
      if (!moved && e.pointerType === 'mouse' && Math.hypot(e.clientX - sx, e.clientY - sy) > 6) { moved = true; ghost = h('div', { class: 'fl-ghost' }, d.icon + ' ' + d.label); document.body.append(ghost); }
      if (ghost) { ghost.style.left = e.clientX + 8 + 'px'; ghost.style.top = e.clientY + 8 + 'px'; }
    };
    const up = (e) => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
      if (ghost) ghost.remove();
      if (e.type === 'pointercancel') return;
      const r = ed.svg.getBoundingClientRect();
      if (moved) { if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) addNode(d.type, ...toWorld(e.clientX, e.clientY)); }
      else { const [wx, wy] = toWorld(r.left + r.width / 2 + (Math.random() - .5) * 120, r.top + r.height / 2 + (Math.random() - .5) * 120); addNode(d.type, wx, wy); }
      if (ed.palOpen) { ed.palOpen = false; syncDrawers(); }
    };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
  }
  function addNode(type, wx, wy) {
    const d = defOf(type); snapshot();
    const n = { id: uid(), type, name: '', x: snapG(wx - NW / 2), y: snapG(wy - 24), cfg: defaultsOf(d.fields) };
    if (type === 'trigger-webhook') n.cfg.path = 'hook-' + Math.random().toString(36).slice(2, 6);
    if (type === 'virtual-device') n.cfg.key = 'wert-' + Math.random().toString(36).slice(2, 5);
    ed.flow.nodes.push(n); ed.sel = new Set([n.id]); ed.selEdge = null;
    renderAll(); drawSide();
    if (d.fields.length && !d.passive) editNode(n);
  }

  // ----- Zeichenfläche -----
  const toWorld = (cx, cy) => { const r = ed.svg.getBoundingClientRect(); return [(cx - r.left - ed.view.x) / ed.view.k, (cy - r.top - ed.view.y) / ed.view.k]; };
  const nodeById = (id) => ed.flow.nodes.find((n) => n.id === id);
  const outPos = (n, i) => { const H = nodeH(n), c = portCount(n); return [n.x + NW, n.y + (H - c * PS) / 2 + PS / 2 + i * PS]; };
  const inPos = (n) => [n.x, n.y + nodeH(n) / 2];
  const curve = (a, b) => { const dx = Math.max(50, Math.abs(b[0] - a[0]) / 2); return `M${a[0]},${a[1]} C${a[0] + dx},${a[1]} ${b[0] - dx},${b[1]} ${b[0]},${b[1]}`; };

  function drawCanvas() {
    const svg = sv('svg', { 'aria-label': 'Flow-Zeichenfläche' });
    const pat = sv('pattern', { id: 'flgrid', width: 20, height: 20, patternUnits: 'userSpaceOnUse' }, sv('circle', { cx: 1, cy: 1, r: 1, fill: 'currentColor', opacity: '.18' }));
    ed.patEl = pat;
    ed.gridRect = sv('rect', { width: '100%', height: '100%', fill: 'url(#flgrid)', style: 'color:var(--text)' });
    ed.world = sv('g', {}); ed.edgesG = sv('g', {}); ed.nodesG = sv('g', {}); ed.tempG = sv('g', {});
    ed.world.append(ed.edgesG, ed.nodesG, ed.tempG);
    svg.append(sv('defs', {}, pat), ed.gridRect, ed.world);
    ed.svg = svg;
    fill(ed.canvas, svg,
      h('div', { class: 'fl-zoom' }, h('button', { onclick: () => zoomBy(1.25) }, '+'), h('button', { onclick: () => zoomBy(0.8) }, '−')),
      h('div', { class: 'fl-hint' }, 'Ziehen = verschieben · Mausrad/Pinch = Zoom · Ausgang → Eingang ziehen = verbinden · Doppelklick = bearbeiten'));
    bindCanvas(svg);
    renderAll();
    if (!ed.fitted) { ed.fitted = true; setTimeout(() => fit(true), 30); }
  }

  function applyView() {
    const { x, y, k } = ed.view;
    ed.world.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
    ed.patEl.setAttribute('patternTransform', `translate(${x},${y}) scale(${k})`);
  }
  function zoomBy(f, cx, cy) {
    const r = ed.svg.getBoundingClientRect(); cx = cx === undefined ? r.width / 2 : cx - r.left; cy = cy === undefined ? r.height / 2 : cy - r.top;
    const v = ed.view; const k = Math.max(0.25, Math.min(2.2, v.k * f)); const rf = k / v.k;
    v.x = cx - (cx - v.x) * rf; v.y = cy - (cy - v.y) * rf; v.k = k; applyView();
  }
  function fit(soft) {
    const ns = ed.flow.nodes; const r = ed.svg.getBoundingClientRect();
    if (!ns.length || !r.width) return;
    const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y)), x1 = Math.max(...ns.map((n) => n.x + NW)), y1 = Math.max(...ns.map((n) => n.y + nodeH(n)));
    const k = Math.max(0.3, Math.min(soft ? 1 : 1.3, (r.width - 80) / (x1 - x0), (r.height - 80) / (y1 - y0)));
    ed.view = { k, x: (r.width - (x1 - x0) * k) / 2 - x0 * k, y: (r.height - (y1 - y0) * k) / 2 - y0 * k };
    applyView();
  }

  function summaryOf(n) {
    const d = defOf(n.type); const c = n.cfg || {};
    if (d.type === 'comment') return '';
    for (const f of d.fields || []) {
      const v = c[f.key] !== undefined ? c[f.key] : f.default;
      if (v === undefined || v === '' || v === null) continue;
      if (f.type === 'device') return '💡 ' + trunc(devName(v), 22);
      if (f.type === 'list') { const r = (v || [])[0]; return r ? trunc(`${v.length}× ${r.op ? (r.left || r.prop || '') + ' ' + r.op : r.target || ''}`, 26) : ''; }
      if (['text', 'combo', 'time', 'number', 'select', 'textarea'].includes(f.type) && f.key !== 'secret') {
        if (f.type === 'select' && f.options && !Array.isArray(f.options)) return trunc(f.options[v] || v, 26);
        return trunc(String(v).replace(/\s+/g, ' '), 26);
      }
    }
    return '';
  }

  function renderNode(n) {
    const d = defOf(n.type); const H = nodeH(n); const col = catColor(d); const outs = portCount(n);
    const g = sv('g', { class: 'fl-node' + (ed.sel.has(n.id) ? ' sel' : '') + (n.disabled ? ' dis' : ''), 'data-nid': n.id, transform: `translate(${n.x},${n.y})` });
    if (d.type === 'comment') {
      const lines = String((n.cfg || {}).text || 'Notiz').split('\n').flatMap((l) => l.match(/.{1,26}/g) || ['']).slice(0, 12);
      const hh = Math.max(48, 16 + lines.length * 16);
      g.append(sv('rect', { class: 'body', width: NW + 20, height: hh, rx: 6, style: 'fill:color-mix(in srgb,#f5c542 22%,var(--panel));stroke:#d9a400' }), ...lines.map((l, i) => sv('text', { x: 10, y: 20 + i * 16, style: 'font-weight:400;font-size:12px' }, l)));
      return g;
    }
    g.append(sv('rect', { class: 'body', width: NW, height: H, rx: 10, 'stroke-dasharray': d.missing ? '5 4' : null }), sv('rect', { x: 0, y: 0, width: 6, height: H, rx: 3, fill: col }),
      sv('text', { class: 'ic', x: 20, y: H / 2 + 6 }, d.icon),
      sv('text', { x: 44, y: H / 2 - (summaryOf(n) ? 2 : -4) }, trunc(n.name || d.label, outs > 1 ? 14 : 17)),
      summaryOf(n) ? sv('text', { class: 'sub', x: 44, y: H / 2 + 13 }, trunc(summaryOf(n), outs > 1 ? 15 : 22)) : null,
      sv('circle', { class: 'stat', cx: NW - 10, cy: 10, r: 5 }));
    if (d.inputs > 0 || (d.inputs === undefined && !d.trigger)) g.append(sv('circle', { class: 'port', 'data-in': '1', cx: 0, cy: H / 2, r: 7 }));
    for (let i = 0; i < outs; i++) {
      const y = (H - outs * PS) / 2 + PS / 2 + i * PS; const isErr = n.onError === 'port' && i === outs - 1; const lab = outLabel(n, i);
      g.append(sv('circle', { class: 'port' + (isErr ? ' errp' : ''), 'data-out': i, cx: NW, cy: y, r: 7 }), lab ? sv('text', { class: 'plabel', x: NW - 12, y: y + 3, 'text-anchor': 'end' }, lab) : null);
    }
    const st = (nodeStat[ed.flow.id] || {})[n.id]; if (st) g.classList.add(st.s);
    return g;
  }
  function renderEdge(e) {
    const a = nodeById(e.from), b = nodeById(e.to); if (!a || !b) return null;
    const isErr = a.onError === 'port' && (e.out || 0) === portCount(a) - 1;
    const key = `${e.from}:${e.out || 0}>${e.to}`;
    const p = sv('path', { class: 'fl-edge' + (isErr ? ' errp' : '') + (ed.selEdge === key ? ' sel' : ''), d: curve(outPos(a, e.out || 0), inPos(b)) });
    const hit = sv('path', { class: 'fl-hit', d: p.getAttribute('d'), 'data-eid': key });
    const g = sv('g', {}, p, hit); g._p = p; g._hit = hit; ed.edgeEls.set(key, g);
    return g;
  }
  function renderAll() {
    ed.edgesG.replaceChildren(); ed.nodesG.replaceChildren(); ed.els.clear(); ed.edgeEls.clear();
    // Kanten zu nicht mehr vorhandenen Ausgängen entfernen
    ed.flow.edges = ed.flow.edges.filter((e) => { const a = nodeById(e.from); return a && nodeById(e.to) && (e.out || 0) < portCount(a); });
    for (const e of ed.flow.edges) { const g = renderEdge(e); if (g) ed.edgesG.append(g); }
    for (const n of ed.flow.nodes) { const g = renderNode(n); ed.els.set(n.id, g); ed.nodesG.append(g); }
    applyView();
  }
  function refreshEdges(ids) {
    for (const e of ed.flow.edges) {
      if (!ids.has(e.from) && !ids.has(e.to)) continue;
      const g = ed.edgeEls.get(`${e.from}:${e.out || 0}>${e.to}`); const a = nodeById(e.from), b = nodeById(e.to);
      if (g && a && b) { const d = curve(outPos(a, e.out || 0), inPos(b)); g._p.setAttribute('d', d); g._hit.setAttribute('d', d); }
    }
  }
  function paintStatus(nid) {
    const g = ed.els.get(nid); if (!g) return;
    g.classList.remove('run', 'ok', 'err'); const st = (nodeStat[ed.flow.id] || {})[nid]; if (st) g.classList.add(st.s);
  }
  function setSel(ids, edge) {
    ed.sel = new Set(ids); ed.selEdge = edge || null;
    for (const [id, g] of ed.els) g.classList.toggle('sel', ed.sel.has(id));
    for (const [k, g] of ed.edgeEls) g._p.classList.toggle('sel', k === ed.selEdge);
    if (ed.tab === 'node') drawSide();
  }

  function bindCanvas(svg) {
    const ptrs = new Map(); let drag = null; let pinch0 = null;
    const pt = (e) => { const r = svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); }, { passive: false });
    svg.addEventListener('pointerdown', (e) => {
      svg.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: ed.view.k }; drag = null; return; }
      const outEl = e.target.closest('[data-out]'); const nEl = e.target.closest('[data-nid]'); const eEl = e.target.closest('[data-eid]');
      if (outEl && nEl) { const n = nodeById(nEl.dataset.nid); drag = { t: 'wire', n, out: Number(outEl.dataset.out), from: outPos(n, Number(outEl.dataset.out)) }; return; }
      if (nEl) {
        const id = nEl.dataset.nid;
        if (e.shiftKey || e.ctrlKey || e.metaKey) { const s = new Set(ed.sel); s.has(id) ? s.delete(id) : s.add(id); setSel(s); }
        else if (!ed.sel.has(id)) setSel([id]);
        drag = { t: 'node', id, sx: e.clientX, sy: e.clientY, moved: false, orig: new Map([...ed.sel].map((i) => [i, [nodeById(i).x, nodeById(i).y]])) };
        return;
      }
      if (eEl) { setSel([], eEl.dataset.eid); drag = { t: 'none' }; return; }
      if (e.shiftKey) { const [wx, wy] = toWorld(e.clientX, e.clientY); drag = { t: 'marq', x0: wx, y0: wy, el: null }; return; }
      drag = { t: 'pan', sx: e.clientX, sy: e.clientY, vx: ed.view.x, vy: ed.view.y, moved: false };
    });
    svg.addEventListener('pointermove', (e) => {
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch0 && ptrs.size === 2) { const [a, b] = [...ptrs.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); zoomBy((pinch0.k * d / pinch0.d) / ed.view.k, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); return; }
      if (!drag) return;
      if (drag.t === 'pan') { const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; ed.view.x = drag.vx + dx; ed.view.y = drag.vy + dy; applyView(); }
      else if (drag.t === 'node') {
        const dx = (e.clientX - drag.sx) / ed.view.k, dy = (e.clientY - drag.sy) / ed.view.k;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4 / ed.view.k) return;
        if (!drag.moved) { drag.moved = true; snapshot(); }
        for (const [id, [ox, oy]] of drag.orig) { const n = nodeById(id); n.x = snapG(ox + dx); n.y = snapG(oy + dy); ed.els.get(id).setAttribute('transform', `translate(${n.x},${n.y})`); }
        refreshEdges(new Set(drag.orig.keys()));
      } else if (drag.t === 'wire') {
        const [wx, wy] = toWorld(e.clientX, e.clientY); ed.tempG.replaceChildren(sv('path', { class: 'fl-temp', d: curve(drag.from, [wx, wy]) }));
      } else if (drag.t === 'marq') {
        const [wx, wy] = toWorld(e.clientX, e.clientY); drag.x1 = wx; drag.y1 = wy;
        ed.tempG.replaceChildren(sv('rect', { class: 'fl-marq', x: Math.min(drag.x0, wx), y: Math.min(drag.y0, wy), width: Math.abs(wx - drag.x0), height: Math.abs(wy - drag.y0) }));
      }
    });
    const end = (e) => {
      ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null;
      const dg = drag; if (!dg || ptrs.size) { if (!ptrs.size) drag = null; return; }
      drag = null;
      if (dg.t === 'pan' && !dg.moved) setSel([]);
      else if (dg.t === 'node' && !dg.moved) {
        const now = Date.now(); const last = ed.tap[dg.id] || 0; ed.tap[dg.id] = now;
        if (now - last < 450) { ed.tap[dg.id] = 0; const n = nodeById(dg.id); if (n && !defOf(n.type).missing) editNode(n); } else if (!(e.shiftKey || e.ctrlKey || e.metaKey)) setSel([dg.id]);
        if (ed.tab === 'node') drawSide();
      } else if (dg.t === 'wire') {
        ed.tempG.replaceChildren();
        const el = document.elementFromPoint(e.clientX, e.clientY); const tn = el && el.closest && el.closest('[data-nid]');
        if (tn && tn.dataset.nid !== dg.n.id) {
          const t = nodeById(tn.dataset.nid); const td = defOf(t.type);
          if (td.inputs === 0 || td.passive) return toast(`„${td.label}“ hat keinen Eingang`, true);
          if (!ed.flow.edges.some((x) => x.from === dg.n.id && (x.out || 0) === dg.out && x.to === t.id)) { snapshot(); ed.flow.edges.push({ from: dg.n.id, out: dg.out, to: t.id }); renderAll(); }
        }
      } else if (dg.t === 'marq') {
        ed.tempG.replaceChildren();
        if (dg.x1 !== undefined) { const x0 = Math.min(dg.x0, dg.x1), x1 = Math.max(dg.x0, dg.x1), y0 = Math.min(dg.y0, dg.y1), y1 = Math.max(dg.y0, dg.y1); setSel(ed.flow.nodes.filter((n) => n.x < x1 && n.x + NW > x0 && n.y < y1 && n.y + nodeH(n) > y0).map((n) => n.id)); }
      } else if (dg.t === 'node' && dg.moved) { drawSide(); }
    };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  }

  function delSel() {
    if (!ed) return;
    if (ed.selEdge) { snapshot(); ed.flow.edges = ed.flow.edges.filter((e) => `${e.from}:${e.out || 0}>${e.to}` !== ed.selEdge); ed.selEdge = null; renderAll(); return; }
    if (!ed.sel.size) return toast('Nichts ausgewählt');
    snapshot(); const ids = ed.sel; ed.flow.nodes = ed.flow.nodes.filter((n) => !ids.has(n.id)); ed.flow.edges = ed.flow.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to)); ed.sel = new Set(); renderAll(); drawSide();
  }
  function copySel() {
    if (!ed.sel.size) return toast('Erst Knoten auswählen');
    ed.clip = { nodes: clone(ed.flow.nodes.filter((n) => ed.sel.has(n.id))), edges: clone(ed.flow.edges.filter((e) => ed.sel.has(e.from) && ed.sel.has(e.to))) };
    toast(`${ed.clip.nodes.length} Knoten kopiert`);
  }
  function paste() {
    if (!ed.clip || !ed.clip.nodes.length) return toast('Nichts kopiert', true);
    snapshot(); const map = new Map(); const added = [];
    for (const n of ed.clip.nodes) { const c = clone(n); const id = uid(); map.set(n.id, id); c.id = id; c.x += 40; c.y += 40; if (c.type === 'trigger-webhook') c.cfg.path = 'hook-' + Math.random().toString(36).slice(2, 6); ed.flow.nodes.push(c); added.push(id); }
    for (const e of ed.clip.edges) ed.flow.edges.push({ from: map.get(e.from), out: e.out || 0, to: map.get(e.to) });
    ed.clip = { nodes: ed.clip.nodes.map((n) => ({ ...clone(n), x: n.x + 40, y: n.y + 40 })), edges: ed.clip.edges };
    renderAll(); setSel(added);
  }

  function autoLayout(quiet) {
    const ns = ed.flow.nodes, es = ed.flow.edges; const lvl = new Map();
    const incoming = new Map(ns.map((n) => [n.id, []])); for (const e of es) if (incoming.has(e.to)) incoming.get(e.to).push(e.from);
    for (let it = 0; it < ns.length + 2; it++) { let ch = false; for (const n of ns) { const l = Math.max(0, ...incoming.get(n.id).map((s) => (lvl.has(s) ? lvl.get(s) + 1 : 0))); if (!lvl.has(n.id) || (lvl.get(n.id) < l && l <= ns.length)) { lvl.set(n.id, l); ch = true; } } if (!ch) break; }
    const cols = new Map(); for (const n of ns) { const l = lvl.get(n.id) || 0; (cols.get(l) || cols.set(l, []).get(l)).push(n); }
    for (const [l, list] of cols) { let y = 30; for (const n of list) { n.x = 30 + l * (NW + 80); n.y = y; y += nodeH(n) + 28; } }
    if (!quiet && ed.els) { dirty(); }
  }

  // ----- Seitenleiste -----
  function drawSide() {
    if (!ed || !ed.side) return;
    const tabBtn = (k, l) => h('button', { class: ed.tab === k ? 'act' : '', onclick: () => { ed.tab = k; drawSide(); } }, l);
    const body = h('div', { class: 'fl-sbody' });
    fill(ed.side, h('div', { class: 'fl-stabs' }, tabBtn('debug', '🐞 Debug'), tabBtn('runs', '🧾 Läufe'), tabBtn('node', 'ℹ Knoten')), body);
    if (ed.tab === 'debug') {
      const mine = debugList.filter((e) => e.flow === ed.flow.id).slice().reverse();
      fill(body, h('div', { class: 'fl-row sb' }, h('span', { class: 'hint' }, 'Ausgaben der „Debug“-Knoten'), h('button', { class: 'sm', onclick: async () => { await API('DELETE', 'debug'); debugList = []; drawSide(); } }, 'Leeren')),
        mine.length ? mine.slice(0, 80).map((e) => h('div', { class: 'fl-dbg' }, h('div', { class: 'm' }, `${new Date(e.ts).toLocaleTimeString('de-AT')} · ${e.name}${e.label ? ' · ' + e.label : ''}`), h('pre', {}, e.value))) : h('div', { class: 'hint', style: 'padding:10px' }, 'Noch nichts. Füge einen „Ausgabe / Debug“-Knoten ein und starte einen Testlauf.'));
    } else if (ed.tab === 'runs') {
      const mine = recent.filter((e) => e.flow === ed.flow.id).slice(0, 40);
      fill(body, mine.length ? mine.map((e) => h('div', { class: 'fl-run', onclick: () => showExec(e.id) }, h('span', { class: 'fl-chip ' + e.status }, ST[e.status] || e.status), h('div', { class: 'fl-grow' }, when(e.t0), h('div', { class: 'hint' }, `${e.ms} ms · ${e.steps} Schritte${e.errors && e.errors[0] ? ' · ' + trunc(e.errors[0].message, 40) : ''}`)))) : h('div', { class: 'hint', style: 'padding:10px' }, 'Noch keine Läufe.'));
    } else {
      const id = [...ed.sel][0]; const n = ed.sel.size === 1 ? nodeById(id) : null;
      if (!n) return fill(body, h('div', { class: 'hint', style: 'padding:10px' }, ed.sel.size > 1 ? `${ed.sel.size} Knoten ausgewählt.` : 'Knoten anklicken, um Details und die Daten des letzten Laufs zu sehen. Doppelklick öffnet die Einstellungen.'));
      const d = defOf(n.type); const l = ed.last[n.id];
      fill(body, h('div', { class: 'fl-row sb' }, h('b', {}, d.icon + ' ' + (n.name || d.label)), h('button', { class: 'sm primary', onclick: () => editNode(n) }, 'Bearbeiten')),
        h('div', { class: 'hint' }, d.desc), h('div', { class: 'hint' }, `Typ: ${d.type}${d.owner && d.owner !== 'eingebaut' ? ' · ' + d.owner : ''}`),
        h('div', { class: 'fl-row', style: 'margin:8px 0' }, h('button', { class: 'sm', onclick: () => { snapshot(); n.disabled = !n.disabled; renderAll(); drawSide(); } }, n.disabled ? 'Aktivieren' : 'Deaktivieren (durchreichen)'),
          (d.trigger ? h('button', { class: 'sm', onclick: () => runFlow(n.id).catch(fail) }, '▶ Ab hier starten') : null)),
        l ? h('div', {}, h('div', { class: 'hint', style: 'margin-top:8px' }, `Letzter Lauf · ${l.ms} ms`), h('div', { class: 'hint' }, 'Eingang:'), h('pre', { class: 'fl-pre' }, l.in), l.err ? h('div', { style: 'color:var(--bad)' }, '⚠ ' + l.err) : null, l.out && l.out.length ? [h('div', { class: 'hint' }, 'Ausgang:'), l.out.map((o) => h('pre', { class: 'fl-pre' }, o))] : null) : h('div', { class: 'hint', style: 'margin-top:8px' }, 'Noch keine Daten – Testlauf starten.'));
    }
  }

  // ----- Knoten bearbeiten -----
  function editNode(n) {
    const d = defOf(n.type);
    const w = { name: n.name || '', cfg: clone(n.cfg || {}), disabled: !!n.disabled, onError: n.onError || '', retries: n.retries || 0, retryDelay: n.retryDelay || 1000, timeout: n.timeout === undefined ? '' : n.timeout, note: n.note || '' };
    let tab = 'cfg'; const body = h('div', {}); let testOut = null;
    const draw = () => {
      const tabs = h('div', { class: 'fl-tabsm' }, [['cfg', 'Einstellungen'], ['beh', 'Verhalten'], ...(d.passive || !n.id || d.trigger && d.type !== 'trigger-manual' ? [] : [['test', 'Testen']])].map(([k, l]) => h('button', { class: tab === k ? 'act' : '', onclick: () => { tab = k; draw(); } }, l)));
      let content;
      if (tab === 'cfg') content = [h('div', { class: 'hint' }, d.desc), renderForm(d.fields, w.cfg, {}), d.missing ? h('div', { style: 'color:var(--bad)' }, 'Dieser Knotentyp ist nicht installiert. Die Einstellungen bleiben erhalten.') : null];
      else if (tab === 'beh') content = [
        HL.fld('Name auf der Zeichenfläche', h('input', { value: w.name, placeholder: d.label, oninput: (e) => { w.name = e.target.value; } })),
        d.passive ? null : [
          HL.fld('Bei einem Fehler', HL.sel({ '': 'Zweig abbrechen (und „Fehler abfangen“ auslösen)', continue: 'weitermachen (msg.error enthält den Fehler)', port: 'zusätzlicher Fehler-Ausgang' }, w.onError, (v) => { w.onError = v; })),
          HL.fld('Wiederholungen bei Fehler (0–5)', h('input', { type: 'number', min: 0, max: 5, value: w.retries, oninput: (e) => { w.retries = Number(e.target.value) || 0; } })),
          HL.fld('Pause zwischen Wiederholungen (ms)', h('input', { type: 'number', min: 0, value: w.retryDelay, oninput: (e) => { w.retryDelay = Number(e.target.value) || 0; } })),
          HL.fld('Zeitlimit in Sekunden (leer = Standard 60, 0 = keins)', h('input', { type: 'number', min: 0, value: w.timeout, oninput: (e) => { w.timeout = e.target.value === '' ? '' : Number(e.target.value); } })),
          h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: w.disabled, onchange: (e) => { w.disabled = e.target.checked; } }), 'Knoten deaktivieren (Nachricht wird nur durchgereicht)')],
        HL.fld('Notiz', h('textarea', { style: 'width:100%;height:60px', oninput: (e) => { w.note = e.target.value; } }, w.note))];
      else {
        const ta = h('textarea', { style: 'width:100%;height:90px' }, '{"payload": "Test"}'); const out = h('div', {});
        content = [h('p', { class: 'hint' }, 'Führt nur diesen Knoten mit der Nachricht unten aus (speichert vorher den Flow). Aktionen werden wirklich ausgeführt, nachfolgende Knoten nicht.'), ta,
          h('button', { class: 'sm primary', style: 'margin-top:6px', onclick: async () => {
            try { apply(); if (!ed.flow.id || ed.dirty) await saveFlow(); const r = await API('POST', `flow/${ed.flow.id}/node/${n.id}/test`, { msg: JSON.parse(ta.value) });
              fill(out, h('div', { class: 'hint' }, `${r.ms} ms`), r.error ? h('div', { style: 'color:var(--bad)' }, '⚠ ' + r.error.message) : null, r.outputs.length ? r.outputs.map((o) => h('div', {}, h('div', { class: 'hint' }, `Ausgang ${o.port + 1}:`), h('pre', { class: 'fl-pre' }, JSON.stringify(o.msg, null, 1)))) : h('div', { class: 'hint' }, 'Keine Ausgabe.'));
            } catch (e) { fill(out, h('div', { style: 'color:var(--bad)' }, '⚠ ' + e.message)); } } }, 'Knoten ausführen'), out];
        void testOut;
      }
      fill(body, tabs, content);
    };
    const apply = () => {
      snapshot();
      Object.assign(n, { name: w.name.trim(), cfg: w.cfg, disabled: w.disabled, onError: w.onError, retries: w.retries, retryDelay: w.retryDelay, timeout: w.timeout, note: w.note });
      renderAll(); drawSide();
    };
    draw();
    modal(`${d.icon} ${d.label}`, body, [
      { label: 'Löschen', danger: true, onClick: () => { ed.sel = new Set([n.id]); delSel(); } },
      { label: 'Abbrechen' },
      { label: 'Übernehmen', primary: true, onClick: () => { apply(); } },
    ]);
  }

  // Tastatur
  document.addEventListener('keydown', (e) => {
    if (!ed || !root || !root.isConnected || document.getElementById('overlay').classList.contains('show')) return;
    const t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); delSel(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveFlow().catch(fail); }
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? restore(ed.redo, ed.undo) : restore(ed.undo, ed.redo); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); restore(ed.redo, ed.undo); }
    else if (mod && e.key.toLowerCase() === 'c') copySel();
    else if (mod && e.key.toLowerCase() === 'v') paste();
    else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSel(ed.flow.nodes.map((n) => n.id)); }
  });
})();
