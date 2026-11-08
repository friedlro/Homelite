'use strict';
const $ = (id) => document.getElementById(id);
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k) || ''; localStorage.setItem(k, v); } catch { return ''; } return ''; };
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('key')) store('hl_key', hash.get('key'));
if (hash.get('person')) store('hl_person', hash.get('person'));
$('key').value = store('hl_key');
$('person').value = store('hl_person');
$('who').textContent = store('hl_person') ? 'Person: ' + store('hl_person') : 'Bitte Person und Schlüssel eintragen.';
$('save').onclick = () => { store('hl_key', $('key').value.trim()); store('hl_person', $('person').value.trim()); $('who').textContent = 'Person: ' + store('hl_person'); };

let watchId = null;
let wake = null;
let lastSent = 0;
let sentCount = 0;

async function send(pos) {
  const now = Date.now();
  if (now - lastSent < 20000) return;
  lastSent = now;
  const c = pos.coords;
  const q = new URLSearchParams({ key: store('hl_key'), person: store('hl_person'), lat: c.latitude, lon: c.longitude, acc: Math.round(c.accuracy || 0), ts: pos.timestamp, src: 'Wo ist' });
  try {
    if (navigator.getBattery) { const b = await navigator.getBattery(); q.set('batt', Math.round(b.level * 100)); }
  } catch { /* ignorieren */ }
  try {
    const r = await fetch('/hook?' + q, { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 401 ? ' – Schlüssel falsch' : ''));
    sentCount++;
    $('state').textContent = `Gesendet: ${new Date().toLocaleTimeString('de-AT')}\n${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)} (±${Math.round(c.accuracy)} m)\n${sentCount}× gesendet`;
  } catch (e) { $('state').textContent = 'Senden fehlgeschlagen: ' + e.message; }
}

async function start() {
  if (!store('hl_key') || !store('hl_person')) { $('state').textContent = 'Bitte Person und Schlüssel eintragen.'; return; }
  if (!navigator.geolocation) { $('state').textContent = 'Dieses Gerät hat keine Standortfunktion.'; return; }
  watchId = navigator.geolocation.watchPosition(send, (e) => { $('state').textContent = 'Standort nicht verfügbar: ' + e.message + (location.protocol !== 'https:' ? '\n(Safari braucht für Standort eine HTTPS-Adresse.)' : ''); }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch { /* ignorieren */ }
  $('go').textContent = 'Senden beenden'; $('go').classList.add('on');
  $('state').textContent = 'Warte auf Position …';
}
function stop() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  try { if (wake) wake.release(); } catch { /* ignorieren */ }
  wake = null;
  $('go').textContent = 'Standort senden starten'; $('go').classList.remove('on');
  $('state').textContent = 'Beendet.';
}
$('go').onclick = () => (watchId === null ? start() : stop());
document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && watchId !== null && navigator.wakeLock) { try { wake = await navigator.wakeLock.request('screen'); } catch { /* ignorieren */ } } });
