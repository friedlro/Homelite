// Systemseite: aktuelle Werte als Balken + 24-Stunden-Verlauf
(() => {
  const { h, fill } = HL;
  let now = null, alarms = [], hist = [], metric = 'cpu';
  const M = { cpu: ['CPU', '%', 100], ram: ['Arbeitsspeicher', '%', 100], temp: ['Temperatur', '°C', 0], disk: ['Datenträger', '%', 100], load: ['Last (1 Min)', '', 0] };
  const mb = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB');
  const dur = (s) => { const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mi = Math.floor((s % 3600) / 60); return (d ? d + ' d ' : '') + hh + ' h ' + mi + ' min'; };

  const bar = (key, label, pct, text) => {
    const bad = alarms.includes(key);
    const col = bad ? 'var(--bad)' : pct > 75 ? 'var(--warn, #d9a400)' : 'var(--ok, #2e9e5b)';
    return h('div', { style: 'margin:10px 0' },
      h('div', { class: 'row sb' }, h('b', {}, label), h('span', { class: 'hint' }, text)),
      h('div', { style: 'height:10px;border-radius:5px;background:var(--line,#8883);overflow:hidden;margin-top:4px' },
        h('div', { style: `height:100%;width:${Math.max(1, Math.min(100, pct || 0))}%;background:${col};transition:width .4s` })));
  };

  function chart() {
    const [name, unit, fixedMax] = M[metric];
    const pts = hist.filter((p) => p[metric] != null);
    if (pts.length < 2) return '<div class="empty">Noch zu wenig Daten (ein Punkt pro Minute).</div>';
    const W = 640, H = 200, L = 38, R = 8, T = 10, B = 22;
    const t1 = pts[pts.length - 1].t, t0 = Math.min(pts[0].t, t1 - 3600000);
    const vals = pts.map((p) => p[metric]);
    const max = fixedMax || Math.max(1, Math.ceil(Math.max(...vals) * 1.15));
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - Math.min(v, max) / max) * (H - T - B);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p[metric]).toFixed(1)).join('');
    const area = line + `L${x(t1).toFixed(1)} ${H - B}L${x(pts[0].t).toFixed(1)} ${H - B}Z`;
    let g = '';
    for (let i = 0; i <= 4; i++) { const v = (max * i) / 4, yy = y(v); g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="currentColor" opacity=".12"/><text x="${L - 5}" y="${yy + 4}" text-anchor="end" font-size="10" fill="currentColor" opacity=".6">${Math.round(v)}</text>`; }
    for (let i = 0; i <= 4; i++) { const tt = t0 + ((t1 - t0) * i) / 4; g += `<text x="${x(tt)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="currentColor" opacity=".6">${new Date(tt).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}</text>`; }
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;color:var(--text,inherit)" role="img" aria-label="${name} im Verlauf">${g}<path d="${area}" fill="var(--accent,#3b82f6)" opacity=".15"/><path d="${line}" fill="none" stroke="var(--accent,#3b82f6)" stroke-width="2" stroke-linejoin="round"/></svg>`;
  }

  const draw = () => {
    const box = document.getElementById('sysmon-box');
    if (!box) return;
    if (!now) return fill(box, h('div', { class: 'empty' }, 'Lade …'));
    const cv = h('div', {}); cv.innerHTML = chart();
    fill(box,
      h('div', { class: 'card' },
        alarms.length ? h('div', { class: 'hint', style: 'color:var(--bad);font-weight:600' }, '⚠ Grenzwert überschritten: ' + alarms.map((k) => M[k] ? M[k][0] : k).join(', ')) : null,
        bar('cpu', 'CPU', now.cpu, now.cpu + ' %  ·  ' + now.cores + ' Kerne'),
        bar('ram', 'Arbeitsspeicher', now.ram, `${now.ram} %  ·  ${mb(now.ramUsed)} von ${mb(now.ramTotal)}`),
        now.swapTotal ? bar('swap', 'Swap', now.swap, `${now.swap} %  ·  ${mb(now.swapTotal)}`) : null,
        now.disk != null ? bar('disk', 'Datenträger', now.disk, `${now.disk} %  ·  ${mb(now.diskUsed)} von ${mb(now.diskTotal)} (${now.diskPath})`) : null,
        now.temp != null ? bar('temp', 'Temperatur', Math.min(100, ((now.temp - 20) / 70) * 100), now.temp + ' °C') : null,
        h('div', { class: 'hint' }, `Last ${now.load1} / ${now.load5} / ${now.load15}  ·  Laufzeit ${dur(now.uptime)}  ·  HomeLite belegt ${mb(now.proc)}`),
        h('div', { class: 'hint' }, `${now.host} · ${now.platform}`)),
      h('div', { class: 'card' },
        h('div', { class: 'row sb' }, h('b', {}, 'Verlauf (24 Stunden)'),
          h('select', { onchange: (e) => { metric = e.target.value; draw(); } }, ...Object.entries(M).map(([k, v]) => h('option', { value: k, selected: k === metric }, v[0])))),
        cv));
  };

  HL.on('systemmonitor', (d) => {
    if (d.now) { now = d.now; alarms = d.alarms || []; }
    draw();
  });
  HL.page('systemmonitor', {
    label: 'System', icon: '📈',
    render(el) {
      el.append(h('h2', { class: 'page-title' }, '📈 Systemüberwachung'), h('div', { id: 'sysmon-box' }));
      draw();
      HL.api('systemmonitor', 'GET', 'status').then((r) => { now = r.now && r.now.time ? r.now : now; alarms = r.alarms || []; draw(); }).catch(HL.fail);
      HL.api('systemmonitor', 'GET', 'history').then((r) => { hist = r.hist || []; draw(); }).catch(HL.fail);
    },
  });
  // Verlauf alle 60 s nachladen, solange die Seite offen ist
  setInterval(() => { if (document.getElementById('sysmon-box')) HL.api('systemmonitor', 'GET', 'history').then((r) => { hist = r.hist || []; draw(); }).catch(() => {}); }, 60000);
})();
