'use strict';
/* Seite: Energie (Erzeugung, Netz, Batterie, Verbrauch) */

const fmtW = (w) => (w === null || w === undefined || isNaN(w) ? '–' : Math.abs(w) >= 1000 ? `${fmtNum(w / 1000, 2)} kW` : `${fmtNum(w, 0)} W`);
const fmtK = (k) => (k === null || k === undefined || isNaN(k) ? '–' : `${fmtNum(k, k >= 100 ? 0 : k >= 10 ? 1 : 2)} kWh`);
const ENERGY_COLORS = { pv: 'var(--e-pv)', grid: 'var(--e-grid)', bat: 'var(--e-bat)', house: 'var(--e-house)' };
const ENERGY_NAMES = { pv: 'Erzeugung', house: 'Verbrauch', grid: 'Netz (+ Bezug / − Einspeisung)', bat: 'Batterie (+ laden / − entladen)' };

let energyRange = localStorage.getItem('hl_erange') || 'today';
const energyCache = {}; // range -> { ts, data }
const energyHidden = new Set();
let energyTable = false;

function energyCard() {
  const e = S.energy;
  if (!e || !e.configured) return null;
  const n = e.now;
  return h('div', { class: 'card tile click', onclick: () => go('energy') }, h('h3', {}, '⚡ Energie'),
    h('div', { class: 'kv' },
      h('span', {}, '☀ Erzeugung'), h('span', {}, fmtW(n.pv)),
      h('span', {}, '🏠 Verbrauch'), h('span', {}, fmtW(n.house)),
      h('span', {}, '🔌 Netz'), h('span', {}, n.grid === null ? '–' : (n.grid >= 0 ? '↓ ' : '↑ ') + fmtW(Math.abs(n.grid))),
      n.soc !== null || n.bat !== null ? [h('span', {}, '🔋 Batterie'), h('span', {}, `${n.soc === null ? '' : fmtNum(n.soc, 0) + ' % '}${n.bat === null ? '' : '(' + (n.bat >= 0 ? '+' : '−') + fmtW(Math.abs(n.bat)) + ')'}`)] : null),
    h('div', { class: 'sub' }, `Heute: ${fmtK(e.today.pv)} erzeugt · ${fmtK(e.today.house)} verbraucht`));
}

function flowSvg(n) {
  const on = (v) => v !== null && Math.abs(v) > 15;
  const node = (x, y, c, icon, label, val, sub, side) => {
    const lx = side ? x + 54 : x; const ly = side ? y - 2 : y - 52; const an = side ? 'start' : 'middle';
    return `<g><circle cx="${x}" cy="${y}" r="42" fill="var(--panel2)" stroke="${c}" stroke-width="3"/><text x="${x}" y="${y - 4}" text-anchor="middle" font-size="24">${icon}</text><text x="${x}" y="${y + 20}" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text)">${val}</text><text x="${lx}" y="${ly}" text-anchor="${an}" font-size="13" font-weight="600" fill="var(--text)">${label}</text>${sub ? `<text x="${lx}" y="${side ? y + 16 : y + 62}" text-anchor="${an}" font-size="12" fill="var(--muted)">${sub}</text>` : ''}</g>`;
  };
  const line = (x1, y1, x2, y2, c, active, rev) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${active ? c : 'var(--line)'}" stroke-width="3" stroke-linecap="round" ${active ? `stroke-dasharray="3 9" class="flow ${rev ? 'rev' : ''}"` : ''}/>`;
  const P = { x: 130, y: 90 }; const G = { x: 510, y: 90 }; const H = { x: 320, y: 170 }; const B = { x: 320, y: 295 };
  const pvOn = on(n.pv); const gOn = on(n.grid); const bOn = on(n.bat);
  return `<svg viewBox="0 0 640 360" class="flow-svg" role="img" aria-label="Energiefluss">
    ${line(P.x + 30, P.y + 30, H.x - 30, H.y - 20, ENERGY_COLORS.pv, pvOn, false)}
    ${line(G.x - 30, G.y + 30, H.x + 30, H.y - 20, ENERGY_COLORS.grid, gOn, !(n.grid > 0))}
    ${line(H.x, H.y + 42, B.x, B.y - 42, ENERGY_COLORS.bat, bOn, !(n.bat > 0))}
    ${node(P.x, P.y, ENERGY_COLORS.pv, '☀', 'Solar', fmtW(n.pv))}
    ${node(G.x, G.y, ENERGY_COLORS.grid, '⚡', 'Netz', fmtW(n.grid === null ? null : Math.abs(n.grid)), n.grid === null ? '' : on(n.grid) ? (n.grid > 0 ? 'Bezug' : 'Einspeisung') : '')}
    ${node(H.x, H.y, ENERGY_COLORS.house, '🏠', 'Haus', fmtW(n.house), '', true)}
    ${node(B.x, B.y, ENERGY_COLORS.bat, '🔋', 'Batterie', n.soc === null ? fmtW(n.bat === null ? null : Math.abs(n.bat)) : fmtNum(n.soc, 0) + ' %', n.bat === null ? '' : on(n.bat) ? `${n.bat > 0 ? 'lädt' : 'entlädt'} ${fmtW(Math.abs(n.bat))}` : 'inaktiv', true)}
  </svg>`;
}

function statTile(label, value, sub) {
  return h('div', { class: 'card tile' }, h('div', { class: 'name' }, label), h('div', { class: 'val' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
}

// ---------- Diagramme ----------
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function lineChart(series) {
  const W = 800; const Hh = 280; const L = 52; const R = 12; const T = 12; const Bm = 28;
  const keys = [['pv', 1], ['house', 4], ['grid', 2], ['bat', 3]].filter(([k]) => !energyHidden.has(k));
  const rows = series.filter((r) => r);
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const t0 = d0.getTime(); const t1 = t0 + 86400000;
  let hi = 0; let lo = 0;
  for (const r of rows) for (const [, i] of keys) { const v = r[i]; if (v !== null && v > hi) hi = v; if (v !== null && v < lo) lo = v; }
  hi = niceMax(hi); lo = lo < 0 ? -niceMax(-lo) : 0;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (Hh - T - Bm);
  const unit = hi >= 2000 ? 1000 : 1;
  let g = '';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = lo + ((hi - lo) * i) / steps;
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1" ${Math.abs(v) < 1e-9 ? '' : 'stroke-dasharray="2 4"'}/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtNum(v / unit, unit === 1000 ? 1 : 0)}${unit === 1000 ? ' kW' : ' W'}</text>`;
  }
  for (let hr = 0; hr <= 24; hr += 4) g += `<text x="${x(t0 + hr * 3600000)}" y="${Hh - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${String(hr).padStart(2, '0')}:00</text>`;
  const path = (i) => {
    let d = ''; let pen = false;
    for (const r of rows) {
      const v = r[i];
      if (v === null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(r[0]).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  let marks = '';
  if (!energyHidden.has('pv') && rows.length > 1) {
    const base = y(Math.max(lo, 0));
    const pts = rows.filter((r) => r[1] !== null);
    if (pts.length > 1) marks += `<path d="M${x(pts[0][0]).toFixed(1)},${base}${pts.map((r) => `L${x(r[0]).toFixed(1)},${y(r[1]).toFixed(1)}`).join('')}L${x(pts[pts.length - 1][0]).toFixed(1)},${base}Z" fill="${ENERGY_COLORS.pv}" opacity=".15"/>`;
  }
  for (const [k, i] of keys) marks += `<path d="${path(i)}" fill="none" stroke="${ENERGY_COLORS[k]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  return { svg: `<svg viewBox="0 0 ${W} ${Hh}" class="chart-svg" role="img" aria-label="Leistung im Tagesverlauf">${g}${marks}<line id="ec-cross" x1="0" x2="0" y1="${T}" y2="${Hh - Bm}" stroke="var(--muted)" stroke-width="1" opacity="0"/></svg>`, rows, x, W, L, R };
}

function barChart(days) {
  const W = 800; const Hh = 280; const L = 52; const R = 12; const T = 12; const Bm = 28;
  const keys = ['pv', 'house'].filter((k) => !energyHidden.has(k));
  let hi = 0;
  for (const d of days) for (const k of keys) hi = Math.max(hi, d[k]);
  hi = niceMax(hi);
  const y = (v) => T + (1 - v / hi) * (Hh - T - Bm);
  const slot = (W - L - R) / days.length;
  const bw = Math.max(3, Math.min(22, slot / (keys.length + 1)));
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = (hi * i) / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1" ${i ? 'stroke-dasharray="2 4"' : ''}/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtNum(v, hi < 10 ? 1 : 0)}</text>`; }
  let marks = '';
  days.forEach((d, i) => {
    const cx = L + slot * (i + 0.5);
    keys.forEach((k, j) => {
      const bx = cx - (keys.length * bw + (keys.length - 1) * 2) / 2 + j * (bw + 2);
      const bh = Math.max(0, y(0) - y(d[k]));
      if (bh > 0) marks += `<path d="M${bx},${y(0)}V${y(d[k]) + Math.min(4, bh)}Q${bx},${y(d[k])} ${bx + Math.min(4, bw / 2)},${y(d[k])}H${bx + bw - Math.min(4, bw / 2)}Q${bx + bw},${y(d[k])} ${bx + bw},${y(d[k]) + Math.min(4, bh)}V${y(0)}Z" fill="${ENERGY_COLORS[k]}"/>`;
    });
    if (days.length <= 10 || i % Math.ceil(days.length / 8) === 0) g += `<text x="${cx}" y="${Hh - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${d.day.slice(8)}.${d.day.slice(5, 7)}.</text>`;
  });
  return { svg: `<svg viewBox="0 0 ${W} ${Hh}" class="chart-svg" role="img" aria-label="Tagesenergie in kWh"><text x="${L}" y="10" font-size="11" fill="var(--muted)">kWh pro Tag</text>${g}${marks}</svg>`, slot, L, W, R };
}

function legend(keys, redraw) {
  return h('div', { class: 'legend' }, keys.map((k) => h('button', { class: 'lg ' + (energyHidden.has(k) ? 'off' : ''), onclick: () => { if (energyHidden.has(k)) energyHidden.delete(k); else energyHidden.add(k); redraw(); } },
    h('i', { style: `background:${ENERGY_COLORS[k]}` }), ENERGY_NAMES[k])));
}

// Spitzen des Netzbezugs: kurze Spitze (höchster Momentanwert) und Viertelstunden-Mittel (wie beim Smart Meter),
// mit Rückblick auf einzelne Tage (heute … 5 Tage zurück, weiter mit ◀) und eine Übersicht über 5 Tage
let peakMode = 'short';
let peakSel = '0';                 // '0'…'30' = Tage zurück, 'span5' = letzte 5 Tage
const peakData = {};               // Auswahl -> { t, v }
function peakCard(p) {
  let short = peakMode === 'short';
  const fmtKw = (v) => `${fmtNum(v, 2)} kW`;
  const tm = (ts, sec) => new Date(ts).toLocaleTimeString('de-AT', sec ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  const dt = (ts, sec) => new Date(ts).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' }) + ' ' + tm(ts, sec);
  const dlabel = (back) => (back === 0 ? 'Heute' : back === 1 ? 'Gestern' : new Date(Date.now() - back * 86400000).toLocaleDateString('de-AT', { weekday: 'short', day: 'numeric', month: 'numeric' }));
  const val = (r) => (short ? r.peakKw : r.kw);
  const when = (r) => (short ? r.peakTs : r.ts);
  const box = h('div', { class: 'card' });
  const isSpan = () => peakSel === 'span5';
  const load = () => {
    const c = peakData[peakSel];
    if (c && Date.now() - c.t < (peakSel === '0' || isSpan() ? 15000 : 120000)) return;
    const q = isSpan() ? 'span=5' : `back=${peakSel}`;
    api('GET', `/api/energy/peaks?${q}`).then((v) => { peakData[peakSel] = { t: Date.now(), v }; if (box.isConnected) draw(); }).catch(() => {});
  };
  const draw = () => {
    short = peakMode === 'short';
    const c = peakData[peakSel];
    const v = c && c.v;
    const bars = v ? v.quarters.map((r) => ({ x: r.ts, kw: val(r), avg: r.kw, label: `${dt(r.ts)}–${tm(r.ts + 900000)}: Spitze ${fmtNum(r.peakKw, 2)} kW (um ${tm(r.peakTs, true)}), Ø ${fmtNum(r.kw, 2)} kW` })) : [];
    const W = 640; const H = 170; const L = 38; const R = 6; const T = 10; const B = 22;
    let svg = '';
    if (bars.length) {
      const lim = v.limit;
      const mx = Math.max(0.5, lim || 0, ...bars.map((b) => b.kw)) * 1.1;
      const y = (n) => T + (1 - n / mx) * (H - T - B);
      const t0 = v.from; const span = v.to - v.from;
      const bw = Math.max(1.2, ((W - L - R) * 900000) / span - (isSpan() ? 0.3 : 1));
      const x = (t) => L + ((t - t0) / span) * (W - L - R);
      let g = '';
      for (let i = 0; i <= 4; i++) { const n = (mx * i) / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y(n)}" y2="${y(n)}" stroke="currentColor" opacity=".12"/><text x="${L - 5}" y="${y(n) + 4}" text-anchor="end" font-size="10" fill="currentColor" opacity=".6">${fmtNum(n, 1)}</text>`; }
      if (isSpan()) {
        for (let t = t0; t < v.to; t += 86400000) { g += `<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}" stroke="currentColor" opacity=".25"/><text x="${x(t) + 3}" y="${H - 6}" font-size="10" fill="currentColor" opacity=".7">${new Date(t + 3600000).toLocaleDateString('de-AT', { weekday: 'short', day: 'numeric', month: 'numeric' })}</text>`; }
      } else for (const hh of [0, 6, 12, 18]) g += `<text x="${x(t0 + hh * 3600000)}" y="${H - 6}" font-size="10" fill="currentColor" opacity=".6">${hh}:00</text>`;
      const rects = bars.map((b) => {
        const bad = lim && b.kw > lim;
        const avgBar = short ? `<rect x="${x(b.x).toFixed(1)}" y="${y(b.avg).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, H - B - y(b.avg)).toFixed(1)}" fill="currentColor" opacity=".28" pointer-events="none"/>` : '';
        return `<rect x="${x(b.x).toFixed(1)}" y="${y(b.kw).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, H - B - y(b.kw)).toFixed(1)}" rx="${isSpan() ? 0 : 1.5}" fill="${bad ? 'var(--bad,#e5484d)' : 'var(--accent,#3b82f6)'}"><title>${b.label}</title></rect>${avgBar}`;
      }).join('');
      const limL = lim ? `<line x1="${L}" x2="${W - R}" y1="${y(lim)}" y2="${y(lim)}" stroke="var(--bad,#e5484d)" stroke-dasharray="5 4"/><text x="${W - R}" y="${y(lim) - 3}" text-anchor="end" font-size="10" fill="var(--bad,#e5484d)">Grenze ${fmtNum(lim, 1)} kW</text>` : '';
      svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;color:var(--text,inherit)" role="img" aria-label="Spitzen des Netzbezugs">${g}${rects}${limL}</svg>`;
    }
    const chart = h('div', {}); chart.innerHTML = svg || (v ? '<div class="hint">Für diesen Zeitraum liegen keine Aufzeichnungen vor.</div>' : '<div class="hint">Lade …</div>');
    const list = v ? (short ? v.topShort : v.top) : [];
    const best = list[0];
    const mo = short ? p.monthShort : p.month; const pm = short ? p.prevMonthShort : p.prevMonth;
    const back = Number(peakSel) || 0;
    const days = [0, 1, 2, 3, 4, 5].map((n) => [String(n), dlabel(n)]);
    if (back > 5) days.push([peakSel, dlabel(back)]);
    const title = isSpan() ? 'letzte 5 Tage' : dlabel(back).toLowerCase();
    fill(box,
      h('div', { class: 'row sb' }, h('h3', { style: 'margin:0' }, '📈 Spitzen im Netzbezug'),
        h('div', { class: 'chipbar' }, [['short', 'Kurze Spitze'], ['avg', 'Viertelstunden-Ø']].map(([k, l]) => h('button', { class: 'fchip ' + (peakMode === k ? 'act' : ''), onclick: () => { peakMode = k; draw(); } }, l)))),
      h('div', { class: 'chipbar', style: 'margin:8px 0' },
        [...days, ['span5', '5 Tage']].map(([k, l]) => h('button', { class: 'fchip ' + (peakSel === k ? 'act' : ''), onclick: () => { peakSel = k; load(); draw(); } }, l)),
        h('button', { class: 'fchip', title: 'Einen Tag weiter zurück', onclick: () => { peakSel = String(Math.min(30, (isSpan() ? 5 : Number(peakSel)) + 1)); load(); draw(); } }, '◀ weiter zurück')),
      h('div', { class: 'grid', style: 'margin:8px 0' },
        statTile(isSpan() ? 'Höchste Spitze (5 Tage)' : `Höchste Spitze ${title}`, best ? fmtKw(val(best)) : '–', best ? dt(when(best), short) : ''),
        statTile('Dieser Monat', mo ? fmtKw(val(mo)) : '–', mo ? dt(when(mo), short) : ''),
        statTile('Vormonat', pm ? fmtKw(val(pm)) : '–', pm ? dt(when(pm), short) : '')),
      h('div', { class: 'hint' }, short
        ? 'Höchster Momentanwert je Viertelstunde (blau/rot); grau dahinter das Viertelstunden-Mittel.'
        : 'Mittlere Bezugsleistung je Viertelstunde (kW), wie beim Smart Meter.'),
      chart,
      list.length ? h('div', { style: 'margin-top:8px' }, h('b', {}, (short ? 'Höchste kurze Spitzen – ' : 'Höchste Viertelstunden – ') + title),
        h('table', {}, h('thead', {}, h('tr', {}, (short ? ['Zeitpunkt', 'Spitze', 'Ø der Viertelstunde'] : ['Viertelstunde', 'Ø Leistung', 'Kurze Spitze']).map((x) => h('th', {}, x)))),
          h('tbody', {}, list.map((r) => h('tr', {},
            h('td', {}, short ? dt(r.peakTs, true) : `${dt(r.ts)}–${tm(r.ts + 900000)}`),
            h('td', { style: v.limit && val(r) > v.limit ? 'color:var(--bad);font-weight:600' : '' }, fmtKw(val(r))),
            h('td', { class: 'hint' }, fmtKw(short ? r.kw : r.peakKw))))))) : null);
  };
  draw();
  load();
  return box;
}

function chartCard(data) {
  const box = h('div', { class: 'card chart-card' });
  const draw = () => {
    const isToday = energyRange === 'today';
    const keys = isToday ? ['pv', 'house', 'grid', 'bat'] : ['pv', 'house'];
    const head = h('div', { class: 'row sb' }, h('h3', { style: 'margin:0' }, isToday ? 'Leistung heute' : `Energie pro Tag (${energyRange} Tage)`),
      h('button', { class: 'sm', onclick: () => { energyTable = !energyTable; draw(); } }, energyTable ? '📈 Diagramm' : '▦ Tabelle'));
    if (energyTable) {
      const rows = isToday ? data.series.slice(-60).reverse() : data.days.slice().reverse();
      fill(box, head, legend(keys, draw), h('div', { style: 'overflow-x:auto;max-height:340px' }, h('table', {},
        isToday ? [h('thead', {}, h('tr', {}, ['Zeit', 'Erzeugung', 'Verbrauch', 'Netz', 'Batterie'].map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, new Date(r[0]).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })), h('td', {}, fmtW(r[1])), h('td', {}, fmtW(r[4])), h('td', {}, fmtW(r[2])), h('td', {}, fmtW(r[3])))))]
          : [h('thead', {}, h('tr', {}, ['Tag', 'Erzeugt', 'Verbraucht', 'Bezug', 'Einspeisung', 'Autarkie'].map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((d) => h('tr', {}, h('td', {}, d.day), h('td', {}, fmtK(d.pv)), h('td', {}, fmtK(d.house)), h('td', {}, fmtK(d.imp)), h('td', {}, fmtK(d.exp)), h('td', {}, d.autarky === null ? '–' : d.autarky + ' %'))))])));
      return;
    }
    const wrap = h('div', { class: 'chart-wrap' });
    const tip = h('div', { class: 'tip' });
    wrap.append(tip);
    fill(box, head, legend(keys, draw), wrap);
    if (isToday) {
      if (!data.series.length) { wrap.prepend(h('p', { class: 'hint' }, 'Noch keine Messwerte für heute – der Verlauf füllt sich minütlich.')); return; }
      const c = lineChart(data.series);
      wrap.insertAdjacentHTML('afterbegin', c.svg);
      const svg = wrap.querySelector('svg'); const cross = svg.querySelector('#ec-cross');
      svg.addEventListener('mousemove', (ev) => {
        const r = svg.getBoundingClientRect();
        const px = ((ev.clientX - r.left) / r.width) * c.W;
        let best = null; let bd = 1e9;
        for (const row of c.rows) { const dd = Math.abs(c.x(row[0]) - px); if (dd < bd) { bd = dd; best = row; } }
        if (!best || bd > 40) { cross.setAttribute('opacity', 0); tip.style.display = 'none'; return; }
        const cx = c.x(best[0]);
        cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('opacity', 0.5);
        tip.replaceChildren(h('b', {}, new Date(best[0]).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })),
          ...[['pv', 1], ['house', 4], ['grid', 2], ['bat', 3]].map(([k, i]) => h('div', {}, h('i', { class: 'dot', style: `background:${ENERGY_COLORS[k]}` }), `${ENERGY_NAMES[k].split(' ')[0]}: ${fmtW(best[i])}`)));
        tip.style.display = 'block';
        tip.style.left = Math.min(r.width - 150, (cx / c.W) * r.width + 12) + 'px';
      });
      svg.addEventListener('mouseleave', () => { cross.setAttribute('opacity', 0); tip.style.display = 'none'; });
    } else {
      const c = barChart(data.days);
      wrap.insertAdjacentHTML('afterbegin', c.svg);
      const svg = wrap.querySelector('svg');
      svg.addEventListener('mousemove', (ev) => {
        const r = svg.getBoundingClientRect();
        const px = ((ev.clientX - r.left) / r.width) * c.W;
        const i = Math.floor((px - c.L) / c.slot);
        const d = data.days[i];
        if (!d) { tip.style.display = 'none'; return; }
        tip.replaceChildren(h('b', {}, d.day), h('div', {}, `Erzeugt: ${fmtK(d.pv)}`), h('div', {}, `Verbraucht: ${fmtK(d.house)}`), h('div', {}, `Bezug: ${fmtK(d.imp)}`), h('div', {}, `Einspeisung: ${fmtK(d.exp)}`));
        tip.style.display = 'block';
        tip.style.left = Math.min(r.width - 150, ((c.L + c.slot * (i + 0.5)) / c.W) * r.width + 12) + 'px';
      });
      svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    }
  };
  draw();
  return box;
}

async function loadEnergy(range) {
  const c = energyCache[range];
  if (c && Date.now() - c.ts < 60000) return;
  try {
    const data = await api('GET', '/api/energy?range=' + (range === 'today' ? 'today' : range));
    energyCache[range] = { ts: Date.now(), data };
    if (page === 'energy' && energyRange === range && !modalOpen()) renderPage();
  } catch { /* ignorieren */ }
}

// ---------- Konfiguration ----------
function multiPick(title, devs, set, single) {
  const box = h('div', { class: 'pick' });
  const q = h('input', { class: 'search', placeholder: 'Filtern …', oninput: () => list() });
  const lst = h('div', { class: 'picklist' });
  const list = () => fill(lst, devs.filter((d) => !q.value || `${d.name} ${d.room}`.toLowerCase().includes(q.value.toLowerCase())).map((d) => h('label', { class: 'chk' },
    h('input', { type: single ? 'radio' : 'checkbox', name: title, checked: set.has(d.id), onchange: (e) => { if (single) set.clear(); if (e.target.checked) set.add(d.id); else set.delete(d.id); } }),
    `${d.name}${d.unit ? ' [' + d.unit + ']' : ''}`)));
  list();
  fill(box, h('b', {}, title), devs.length > 8 ? q : null, lst);
  return box;
}

function energyConfigDialog() {
  const c = S.energyCfg;
  const cand = S.devices.filter((d) => d.type === 'sensor' || ((d.type === 'switch' || d.type === 'light') && d.driver !== 'virtual'));
  const sets = { pv: new Set(c.pv), grid: new Set(c.grid), battery: new Set(c.battery), house: new Set(c.house), consumers: new Set(c.consumers), soc: new Set(c.soc ? [c.soc] : []) };
  const o = { gridInvert: c.gridInvert, batteryInvert: c.batteryInvert };
  const limit = h('input', { type: 'number', min: 0, step: '0.1', value: c.peakLimit || '', placeholder: 'z. B. 5 (leer = keine Grenze)', style: 'width:100%' });
  const body = h('div', {},
    h('p', { class: 'hint', style: 'margin-top:0' }, 'Wähle die Sensoren (Leistung in W oder kW) für jede Rolle. Mehrere Werte werden addiert, z. B. drei Phasen. Fehlt der Hausverbrauch, wird er aus Erzeugung + Netz − Batterie berechnet.'),
    multiPick('☀ Erzeugung (PV)', cand, sets.pv),
    multiPick('⚡ Netz (+ Bezug, − Einspeisung)', cand, sets.grid), chk('Vorzeichen umkehren (wenn Einspeisung positiv ist)', o.gridInvert, (v) => { o.gridInvert = v; }),
    multiPick('🔋 Batterieleistung (+ laden, − entladen)', cand, sets.battery), chk('Vorzeichen umkehren', o.batteryInvert, (v) => { o.batteryInvert = v; }),
    multiPick('🔋 Batterie-Ladestand (%)', cand, sets.soc, true),
    multiPick('🏠 Hausverbrauch (optional)', cand, sets.house),
    multiPick('🔌 Einzelverbraucher (Shelly, Steckdosen …)', cand, sets.consumers),
    h('div', { class: 'field' }, h('label', {}, '📈 Leistungsgrenze für Viertelstunden-Spitzen (kW, optional)'), limit,
      h('p', { class: 'hint' }, 'Wird im Diagramm als Linie eingezeichnet; Spitzen darüber werden rot markiert.')));
  modal('Energie-Quellen', body, [{ label: 'Abbrechen' }, {
    label: 'Speichern', primary: true, onClick: async () => {
      await api('PUT', '/api/energy/config', { pv: [...sets.pv], grid: [...sets.grid], battery: [...sets.battery], house: [...sets.house], consumers: [...sets.consumers], soc: [...sets.soc][0] || '', gridInvert: o.gridInvert, batteryInvert: o.batteryInvert, peakLimit: limit.value === '' ? 0 : Number(limit.value), victron: { keepalive: c.victron.keepalive } });
      toast('Gespeichert');
      Object.keys(energyCache).forEach((k) => delete energyCache[k]);
      await reload();
    },
  }]);
}

function victronDialog() {
  const v = S.energyCfg.victron;
  const host = h('input', { value: v.host || '', placeholder: 'IP des Cerbo GX, z. B. 192.168.1.50' });
  const port = h('input', { type: 'number', value: v.port || 1883 });
  const user = h('input', { value: v.user || '', placeholder: 'meist leer', autocomplete: 'off' });
  const pass = h('input', { type: 'password', placeholder: v.hasPass ? '(gespeichert)' : 'meist leer', autocomplete: 'new-password' });
  const id = h('input', { value: v.portalId, placeholder: 'z. B. c0619ab12345' });
  const ph = sel({ 3: '3 Phasen', 1: '1 Phase' }, v.phases || 3, () => {});
  const o = { keepalive: v.keepalive !== false };
  const found = h('div', { class: 'row', style: 'margin-top:6px' });
  const st = S.victron || {};
  modal('Victron einrichten', h('div', {},
    h('p', { class: 'hint', style: 'margin-top:0' }, 'HomeLite verbindet sich direkt mit dem MQTT-Broker des Cerbo GX (unabhängig von deinem Haupt-Broker). Am Cerbo muss „MQTT im LAN“ aktiv sein: Einstellungen → Dienste → MQTT im LAN (Klartext, Port 1883).'),
    st.configured ? h('p', { class: 'hint' }, st.ok ? '✓ Verbunden' : '✗ Nicht verbunden' + (st.error ? ': ' + st.error : '')) : null,
    h('div', { class: 'form' }, fld('Adresse Cerbo GX', host), fld('Port', port), fld('Benutzer', user), fld('Passwort', pass)),
    h('div', { class: 'row', style: 'margin:10px 0 2px' }, h('button', { class: 'sm', onclick: async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await api('POST', '/api/energy/victron/discover', { host: host.value.trim(), port: Number(port.value) || 1883, user: user.value, pass: pass.value });
        if (r.ids.length === 1) id.value = r.ids[0];
        fill(found, r.ids.length ? [h('span', { class: 'hint' }, 'Gefunden:'), r.ids.map((x) => h('button', { class: 'sm', onclick: () => { id.value = x; } }, x))] : h('span', { class: 'hint' }, 'Nichts gefunden'));
      } catch (e) { fail(e); }
      ev.target.disabled = false;
    } }, '🔍 Portal-ID suchen'), found),
    h('div', { class: 'form' }, fld('VRM-Portal-ID', id), fld('Phasen (Netz/Verbrauch)', ph)),
    chk('Keepalive senden (alle 30 s; nötig, damit der Cerbo seine Werte laufend liefert)', o.keepalive, (x) => { o.keepalive = x; })),
  [{ label: 'Abbrechen' }, {
    label: 'Speichern & verbinden', primary: true, onClick: async () => {
      if (!host.value.trim() || !id.value.trim()) { toast('Adresse und Portal-ID eintragen (Portal-ID mit „Suchen“)', true); return false; }
      const r = await api('POST', '/api/energy/victron', { host: host.value.trim(), port: Number(port.value) || 1883, user: user.value, pass: pass.value, portalId: id.value.trim(), phases: Number(ph.value), keepalive: o.keepalive });
      toast(`Victron eingerichtet (${r.devices} Sensoren)`);
      Object.keys(energyCache).forEach((k) => delete energyCache[k]);
      await reload();
    },
  }]);
}

PAGES.energy = {
  label: 'Energie', icon: '⚡', live: true,
  render(el) {
    const e = S.energy;
    el.append(h('div', { class: 'row sb' }, h('h2', { class: 'page-title' }, 'Energie'),
      h('div', { class: 'row' }, h('button', { onclick: victronDialog }, 'Victron …'), h('button', { onclick: energyConfigDialog }, '⚙ Quellen'))));
    if (!e || !e.configured) {
      el.append(h('div', { class: 'empty', style: 'margin-top:12px' }, h('p', {}, 'Noch keine Energie-Quellen eingerichtet.'),
        h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'primary', onclick: victronDialog }, 'Victron einrichten'), h('button', { onclick: energyConfigDialog }, 'Quellen manuell wählen'))));
      return;
    }
    el.append(h('div', { class: 'chipbar', style: 'margin:10px 0' }, [['today', 'Heute'], ['7', '7 Tage'], ['30', '30 Tage']].map(([k, l]) => h('button', { class: 'fchip ' + (energyRange === k ? 'act' : ''), onclick: () => { energyRange = k; localStorage.setItem('hl_erange', k); renderPage(); } }, l))));
    el.append(h('div', { class: 'card' }, (() => { const d = h('div', {}); d.innerHTML = flowSvg(e.now); return d; })()));
    if (S.victron && S.victron.configured && !S.victron.ok) el.append(h('div', { class: 'banner' }, h('span', {}, '⚠ Victron-Broker nicht verbunden' + (S.victron.error ? ': ' + S.victron.error : '')), h('button', { class: 'sm', onclick: victronDialog }, 'Einstellungen')));
    loadEnergy(energyRange);
    const cached = energyCache[energyRange];
    const data = cached && cached.data;
    let t = e.today;
    if (energyRange !== 'today' && data && data.days) {
      const sum = (k) => data.days.reduce((a, d) => a + (d[k] || 0), 0);
      const imp = sum('imp'); const exp = sum('exp'); const pv = sum('pv'); const house = sum('house');
      t = { pv, house, imp, exp, chg: sum('chg'), dis: sum('dis'), autarky: house > 0.05 ? Math.max(0, Math.min(100, Math.round((1 - imp / house) * 100))) : null, selfUse: pv > 0.05 ? Math.max(0, Math.min(100, Math.round((1 - exp / pv) * 100))) : null };
    }
    el.append(h('div', { class: 'grid', style: 'margin:14px 0' },
      statTile('☀ Erzeugt', fmtK(t.pv)), statTile('🏠 Verbraucht', fmtK(t.house)),
      statTile('⬇ Netzbezug', fmtK(t.imp)), statTile('⬆ Einspeisung', fmtK(t.exp)),
      e.now.bat !== null || t.chg > 0 || t.dis > 0 ? statTile('🔋 Batterie', `${fmtK(t.chg)} ↑`, `${fmtK(t.dis)} entladen`) : null,
      statTile('Autarkie', t.autarky === null ? '–' : t.autarky + ' %', 'Anteil Verbrauch ohne Netz'),
      statTile('Eigenverbrauch', t.selfUse === null ? '–' : t.selfUse + ' %', 'Anteil Erzeugung selbst genutzt')));
    if (data) el.append(chartCard(data)); else el.append(h('div', { class: 'card hint' }, 'Lade Verlauf …'));
    if (data && data.peaks) el.append(peakCard(data.peaks));
    if (e.consumers.length) {
      const mx = Math.max(0.01, ...e.consumers.map((c) => c.kwh));
      el.append(h('h2', {}, 'Einzelverbraucher (heute)'), h('div', { class: 'card' }, e.consumers.slice().sort((a, b) => b.kwh - a.kwh).map((c) => h('div', { class: 'cons' },
        h('span', { class: 'cn' }, c.name), h('span', { class: 'bar' }, h('i', { style: `width:${Math.round((c.kwh / mx) * 100)}%` })), h('span', { class: 'cv' }, `${fmtK(c.kwh)} · ${fmtW(c.w)}`)))));
    }
  },
};

// ---------- Wetter (Ecowitt) ----------
const ewVal = (key) => {
  const d = S.devices.find((x) => x.driver === 'ecowitt' && x.ekey === key);
  if (!d) return undefined;
  const v = (S.states[d.id] || {}).value;
  return v === undefined ? undefined : Number(v);
};
const compass = (deg) => (deg === undefined || isNaN(deg) ? '' : ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]);

function weatherCard() {
  if (!S.devices.some((d) => d.driver === 'ecowitt')) return null;
  const t = ewVal('common.0x02'); const hum = ewVal('common.0x07'); const feel = ewVal('common.3');
  const wind = ewVal('common.0x0B'); const gust = ewVal('common.0x0C'); const dir = ewVal('common.0x0A');
  const rainD = ewVal('rain.0x10') ?? ewVal('piezo.0x10'); const rate = ewVal('rain.0x0E') ?? ewVal('piezo.0x0E');
  const p = ewVal('wh25.rel'); const uv = ewVal('common.0x17'); const sol = ewVal('common.0x15');
  const rows = [
    ['💧 Feuchte', hum === undefined ? null : `${fmtNum(hum, 0)} %`],
    ['💨 Wind', wind === undefined ? null : `${fmtNum(wind, 0)} km/h ${compass(dir)}${gust === undefined ? '' : ' (Böen ' + fmtNum(gust, 0) + ')'}`],
    ['🌧 Regen heute', rainD === undefined ? null : `${fmtNum(rainD, 1)} mm${rate > 0 ? ' · ' + fmtNum(rate, 1) + ' mm/h' : ''}`],
    ['⏲ Luftdruck', p === undefined ? null : `${fmtNum(p, 0)} hPa`],
    ['☀ UV / Sonne', uv === undefined && sol === undefined ? null : `${uv === undefined ? '–' : fmtNum(uv, 0)}${sol === undefined ? '' : ' · ' + fmtNum(sol, 0) + ' W/m²'}`],
  ].filter((r) => r[1] !== null);
  return h('div', { class: 'card tile' }, h('h3', {}, '🌤 Wetter'),
    h('div', { class: 'big' }, t === undefined ? '–' : `${fmtNum(t, 1)} °C`),
    feel === undefined ? null : h('div', { class: 'sub' }, `gefühlt ${fmtNum(feel, 1)} °C`),
    h('div', { class: 'kv', style: 'margin-top:8px' }, rows.flatMap(([a, b]) => [h('span', {}, a), h('span', {}, b)])));
}

function ecowittSection(el) {
  const e = S.ecowitt || {};
  const ip = h('input', { value: e.ip || '', placeholder: 'IP des Gateways, z. B. 192.168.1.60' });
  const iv = h('input', { type: 'number', min: 10, max: 3600, value: e.interval || 60 });
  const n = S.devices.filter((d) => d.driver === 'ecowitt').length;
  const out = h('div');
  el.append(h('h2', {}, 'Wetterstation (Ecowitt)'), h('div', { class: 'card' },
    h('p', { class: 'hint', style: 'margin-top:0' }, 'Liest den Ecowitt-Gateway (GW1100, GW1000, GW2000 …) lokal über seine HTTP-Schnittstelle, ohne Cloud und ohne Einstellungen am Gateway. Die IP findest du in der Router-Geräteliste oder in der WS View Plus-App.'),
    h('div', { class: 'form' }, fld('Gateway-IP', ip), fld('Abfrage alle (Sekunden)', iv)),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'primary', onclick: async (ev) => {
        ev.target.disabled = true;
        try { const r = await api('POST', '/api/ecowitt', { ip: ip.value.trim(), interval: Number(iv.value) || 60 }); toast(`Wetterstation verbunden (${r.total} Messwerte, ${r.added} neu)`); await reload(); } catch (x) { fail(x); }
        ev.target.disabled = false;
      } }, n ? 'Speichern & Sensoren aktualisieren' : 'Verbinden & Sensoren anlegen'),
      h('button', { onclick: async () => {
        try { const r = await api('POST', '/api/ecowitt/test', { ip: ip.value.trim() }); fill(out, h('div', { class: 'kv', style: 'margin-top:10px' }, r.items.flatMap((x) => [h('span', {}, x.name), h('span', {}, `${fmtNum(x.value, 2)} ${x.unit}`)]))); } catch (x) { fail(x); }
      } }, 'Testen'),
      n ? h('button', { class: 'danger', onclick: async () => { if (confirm('Alle Wetter-Sensoren entfernen?')) { try { await api('DELETE', '/api/ecowitt'); await reload(); } catch (x) { fail(x); } } } }, 'Entfernen') : null,
      e.configured ? h('span', { class: 'pill ' + (e.ok ? 'ok' : 'bad') }, e.ok ? `verbunden · ${n} Sensoren` : (e.error || 'nicht verbunden')) : null),
    out));
}

// ---------- Matter ----------
function matterSection(el) {
  const m = S.matter || {};
  const box = h('div', { class: 'card' });
  el.append(h('h2', {}, 'Matter (z. B. SwitchBot-Schloss)'), box);
  const code = h('input', { placeholder: '11-stelliger Kopplungscode oder MT:… (QR-Text)' });
  const online = m.ready;
  fill(box,
    h('p', { class: 'hint', style: 'margin-top:0' }, 'HomeLite kann als Matter-Controller Geräte direkt aufnehmen (Schlösser, Schalter, Lichter, Sensoren). Das SwitchBot-Schloss geht über einen Matter-fähigen SwitchBot Hub (Hub Mini Matter / Hub 2): In der SwitchBot-App im Hub unter Matter → „Mit anderen Plattformen koppeln“ einen Kopplungscode erzeugen und hier einfügen. Das Schloss muss dazu am Hub hängen und im Matter-Bereich freigegeben sein.'),
    !m.nodeOk ? h('p', { class: 'pill bad' }, `Node ${m.nodeVersion} ist zu alt – Matter braucht Node ≥ 22.13`) : null,
    m.nodeOk && !m.installed ? h('div', { class: 'row' }, h('button', { class: 'primary', disabled: m.installing, onclick: async (ev) => {
      ev.target.disabled = true;
      toast('Installiere Matter-Paket … (kann einige Minuten dauern)');
      try { await api('POST', '/api/matter/install', {}); toast('Matter-Paket installiert'); await reload(); } catch (e) { fail(e); ev.target.disabled = false; }
    } }, m.installing ? 'Installiere …' : 'Matter-Paket installieren'), h('span', { class: 'hint' }, 'Lädt das npm-Paket @matter/main (Internetzugang des Servers nötig).')) : null,
    m.installed ? h('div', { class: 'row' }, chk('Matter aktivieren', !!m.enabled, async (v) => { try { await api('PUT', '/api/matter', { enabled: v }); await reload(); } catch (e) { fail(e); } }),
      m.enabled ? h('span', { class: 'pill ' + (online ? 'ok' : m.error ? 'bad' : 'warn') }, online ? `bereit · ${(m.nodes || []).length} Knoten · ${m.entities || 0} Funktionen erkannt` : (m.error || 'startet …')) : null) : null,
    m.installLog && !m.installed ? h('pre', { class: 'hint', style: 'white-space:pre-wrap;max-height:160px;overflow:auto' }, m.installLog) : null,
    online ? h('div', { style: 'margin-top:12px' }, h('div', { class: 'form' }, fld('Kopplungscode', code)),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: async (ev) => {
        ev.target.disabled = true;
        toast('Koppeln … (bis zu 2 Minuten)');
        try { await api('POST', '/api/matter/commission', { code: code.value.trim() }); toast('Gerät gekoppelt'); code.value = ''; await reload(); } catch (e) { fail(e); }
        ev.target.disabled = false;
      } }, 'Gerät koppeln')),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'sm', onclick: async () => { try { const d = await api('GET', '/api/matter/diag'); modal('Matter-Diagnose', h('div', {}, h('div', { class: 'hint' }, 'Zeigt, was die gekoppelten Knoten melden. Bei fehlenden Geräten bitte diesen Text senden.'), h('textarea', { rows: 18, readonly: true, style: 'width:100%;font-family:monospace;font-size:11px', onclick: (e) => e.target.select() }, JSON.stringify(d, null, 1))), [{ label: 'Schließen' }]); } catch (e) { fail(e); } } }, 'Diagnose anzeigen')),
      (m.nodes || []).length ? h('div', { style: 'margin-top:10px' }, m.nodes.map((n) => h('div', { class: 'row sb', style: 'padding:4px 0' }, h('span', {}, `${n.name}${n.vendor ? ' · ' + n.vendor : ''}`),
        h('button', { class: 'sm danger', onclick: async () => { if (confirm(`„${n.name}“ aus Matter entfernen? Zugehörige Geräte werden gelöscht.`)) { try { await api('POST', '/api/matter/remove', { peer: n.id }); await reload(); } catch (e) { fail(e); } } } }, 'Entfernen')))) : null) : null);
}
