'use strict';
// Sonnenauf-/untergang nach NOAA-Näherung (Genauigkeit ~1 Minute)
const rad = Math.PI / 180;
const deg = 180 / Math.PI;

function sunTimes(date, lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) return null;
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  const jd = Date.UTC(y, m, d, 12) / 86400000 + 2440587.5;
  const t = (jd - 2451545.0) / 36525;

  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const C = Math.sin(M * rad) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * t) + Math.sin(3 * M * rad) * 0.000289;
  const trueLong = L0 + C;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * rad);
  const obl0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obl = obl0 + 0.00256 * Math.cos((125.04 - 1934.136 * t) * rad);
  const decl = Math.asin(Math.sin(obl * rad) * Math.sin(appLong * rad)) * deg;
  const vy = Math.tan((obl / 2) * rad) ** 2;
  const eqTime = 4 * deg * (vy * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad)
    + 4 * e * vy * Math.sin(M * rad) * Math.cos(2 * L0 * rad)
    - 0.5 * vy * vy * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M * rad));

  const cosH = Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl * rad)) - Math.tan(lat * rad) * Math.tan(decl * rad);
  if (cosH > 1 || cosH < -1) return null; // Polartag/-nacht
  const ha = Math.acos(cosH) * deg;
  const noon = 720 - 4 * lon - eqTime; // Minuten ab 00:00 UTC
  const base = Date.UTC(y, m, d);
  return {
    sunrise: new Date(base + (noon - 4 * ha) * 60000),
    sunset: new Date(base + (noon + 4 * ha) * 60000),
  };
}

module.exports = { sunTimes };
