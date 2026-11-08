'use strict';
// Minimaler Cron-Parser: "Minute Stunde Tag Monat Wochentag", mit * , - / und Namen (MON-FRI, JAN …)
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function field(src, min, max, names) {
  const set = new Set();
  for (let part of String(src).toLowerCase().split(',')) {
    if (names) part = part.replace(/[a-z]{3}/g, (n) => (n in names ? names[n] : n));
    const [rng, stepS] = part.split('/');
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!(step >= 1)) throw new Error('Cron: ungültiger Schritt');
    let a, b;
    if (rng === '*' || rng === '') { a = min; b = max; }
    else if (rng.includes('-')) { [a, b] = rng.split('-').map(Number); }
    else { a = Number(rng); b = stepS === undefined ? a : max; }
    if (!(a >= min && b <= max && a <= b)) throw new Error(`Cron: Wert außerhalb ${min}–${max}`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

function parse(expr) {
  const p = String(expr || '').trim().split(/\s+/);
  if (p.length !== 5) throw new Error('Cron braucht 5 Felder: Minute Stunde Tag Monat Wochentag');
  const dow = field(p[4].replace(/\b7\b/g, '0'), 0, 6, DOW);
  return { min: field(p[0], 0, 59), hour: field(p[1], 0, 23), dom: field(p[2], 1, 31), mon: field(p[3], 1, 12, MON), dow, domStar: p[2] === '*', dowStar: p[4] === '*' };
}

function matches(c, d) {
  if (!c.min.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.mon.has(d.getMonth() + 1)) return false;
  const a = c.dom.has(d.getDate()), b = c.dow.has(d.getDay());
  // wie klassisches cron: sind beide Felder eingeschränkt, genügt eines
  return c.domStar || c.dowStar ? a && b : a || b;
}

module.exports = { parse, matches };
