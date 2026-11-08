'use strict';
/* Victron Cerbo GX / Venus OS: eigener MQTT-Broker (N/<Portal-ID>/…), unabhängig vom Haupt-Broker */

function createVictron({ store, devices, log, onStatus }) {
  let client = null;
  let ok = false;
  let error = '';
  let timer = null;
  let key = '';
  const conf = () => store.cfg.energy.victron;
  const brokerUrl = (v) => {
    const h = String(v.host || '').trim();
    if (!h) return '';
    if (/^[a-z]+:\/\//i.test(h)) return h;
    return `mqtt://${h}:${Number(v.port) || 1883}`;
  };

  function handle(topic, payload) {
    let value;
    try { value = JSON.parse(payload.toString()).value; } catch { return; }
    if (value === null || value === undefined) value = null;
    for (const dev of devices.list) {
      if (dev.driver !== 'victron' || dev.vtopic !== topic) continue;
      const prev = { ...(devices.states.get(dev.id) || {}) };
      const st = { ...prev, ts: Date.now() };
      if (value === null || isNaN(Number(value))) { if (prev.value === undefined) continue; st.value = 0; } else st.value = Math.round(Number(value) * 100) / 100;
      devices.setState(dev, st, prev);
    }
  }

  function stop() {
    clearInterval(timer);
    if (client) { try { client.end(true); } catch { /* ignorieren */ } client = null; }
    ok = false;
  }

  function start() {
    const v = conf();
    const url = brokerUrl(v);
    const k = JSON.stringify([url, v.user, v.pass, v.portalId, v.keepalive]);
    if (k === key && client) return;
    key = k;
    stop();
    if (!url || !v.portalId) { error = url ? 'Portal-ID fehlt' : ''; onStatus(); return; }
    let mqtt;
    try { mqtt = require('mqtt'); } catch { error = 'Paket "mqtt" fehlt'; onStatus(); return; }
    error = '';
    client = mqtt.connect(url, { username: v.user || undefined, password: v.pass || undefined, reconnectPeriod: 5000, connectTimeout: 10000, rejectUnauthorized: false });
    const id = v.portalId;
    const ka = () => { if (v.keepalive !== false && client && ok) client.publish(`R/${id}/keepalive`, '', { qos: 0 }); };
    client.on('connect', () => {
      ok = true; error = '';
      client.subscribe(`N/${id}/system/0/#`, (err) => { if (err) error = 'Subscribe: ' + err.message; onStatus(); });
      ka();
      log('info', 'Victron-MQTT verbunden');
      onStatus();
    });
    client.on('message', handle);
    client.on('error', (e) => { error = e.message || String(e); onStatus(); });
    client.on('close', () => { if (ok) log('warn', 'Victron-MQTT getrennt'); ok = false; onStatus(); });
    timer = setInterval(ka, 30000);
  }

  // Portal-ID automatisch finden: Venus liefert N/<ID>/system/0/Serial
  function discover({ host, port, user, pass }) {
    return new Promise((resolve, reject) => {
      const url = brokerUrl({ host, port });
      if (!url) return reject(new Error('Adresse des Cerbo fehlt'));
      let mqtt;
      try { mqtt = require('mqtt'); } catch { return reject(new Error('Paket "mqtt" fehlt')); }
      const found = new Set();
      let done = false;
      const c = mqtt.connect(url, { username: user || undefined, password: pass || undefined, reconnectPeriod: 0, connectTimeout: 6000, rejectUnauthorized: false });
      const fin = (err) => { if (done) return; done = true; clearTimeout(t); try { c.end(true); } catch { /* ignorieren */ } err && !found.size ? reject(err) : resolve([...found]); };
      const t = setTimeout(() => fin(found.size ? null : new Error('Keine Antwort vom Cerbo – MQTT aktiviert (Einstellungen → Dienste)?')), 8000);
      c.on('connect', () => c.subscribe('N/+/system/0/Serial'));
      c.on('message', (topic) => { const m = /^N\/([^/]+)\/system\/0\/Serial$/.exec(topic); if (m) { found.add(m[1]); setTimeout(() => fin(null), 800); } });
      c.on('error', (e) => fin(new Error(e.message || 'Verbindung fehlgeschlagen')));
    });
  }

  return { start, stop, discover, status: () => ({ ok, error, configured: !!brokerUrl(conf()) && !!conf().portalId }) };
}

// Sensor-Vorlagen
createVictron.template = (portalId, base, phases) => {
  const ph = Array.from({ length: Math.max(1, Math.min(3, phases || 3)) }, (_, i) => `L${i + 1}`);
  const mk = (role, name, sub, unit = 'W') => ({ role, key: `victron:${portalId}:${sub}`, name: `Victron ${name}`, type: 'sensor', driver: 'victron', unit, hide: true, vtopic: `${base || 'N'}/${portalId}/system/0/${sub}` });
  return [
    mk('pv', 'PV DC', 'Dc/Pv/Power'),
    ...ph.map((p) => mk('pv', `PV AC-Netz ${p}`, `Ac/PvOnGrid/${p}/Power`)),
    ...ph.map((p) => mk('pv', `PV AC-Ausgang ${p}`, `Ac/PvOnOutput/${p}/Power`)),
    ...ph.map((p) => mk('grid', `Netz ${p}`, `Ac/Grid/${p}/Power`)),
    mk('battery', 'Batterie Leistung', 'Dc/Battery/Power'),
    mk('soc', 'Batterie Ladestand', 'Dc/Battery/Soc', '%'),
    ...ph.map((p) => mk('house', `Verbrauch ${p}`, `Ac/Consumption/${p}/Power`)),
  ];
};

module.exports = createVictron;
