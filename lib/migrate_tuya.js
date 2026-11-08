'use strict';
// Einmalige Übernahme der früher eingebauten Tuya-Anbindung in das Plugin „tuya“ (ab HomeLite 1.20.0).
// Geräte behalten ihre ID (Automationen, Dashboard, Verlauf bleiben), Anmeldung und Verknüpfungen wandern in den Plugin-Speicher.
const fs = require('fs');
const path = require('path');

module.exports = function migrateTuya({ store, log, root }) {
  const c = store.cfg;
  const legacy = c.tuya;
  const devs = (c.devices || []).filter((d) => d.driver === 'tuya');
  const hasAuth = !!(legacy && (legacy.auth || legacy.userCode));
  if (!hasAuth && !devs.length) {
    if (c.tuya !== undefined) delete c.tuya;   // (Zeile in der Datenbank bleibt als Marker „migrated“ stehen – ohne Zugangsdaten)
    if (c.modules && c.modules.tuya !== undefined) { delete c.modules.tuya; store.save(); }
    return false;
  }
  const dst = path.join(store.DATA, 'plugins', 'tuya');
  try {
    if (!fs.existsSync(path.join(dst, 'plugin.json'))) {
      const src = path.join(root, 'plugins-example', 'tuya');
      if (!fs.existsSync(path.join(src, 'plugin.json'))) throw new Error('Plugin-Dateien fehlen im Update (plugins-example/tuya)');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  } catch (e) {
    log('error', 'Tuya-Plugin konnte nicht installiert werden – Daten bleiben unverändert: ' + e.message);
    return false;
  }
  // Anmeldung
  if (hasAuth && !store.kvGet('plugin:tuya:auth')) store.kvSet('plugin:tuya:auth', { userCode: legacy.userCode || '', auth: legacy.auth || null });
  // Geräte → Plugin-Geräte (gleiche ID)
  const links = Array.isArray(store.kvGet('plugin:tuya:links')) ? store.kvGet('plugin:tuya:links') : [];
  const clean = (s) => String(s).replace(/[^\w.:@#-]/g, '_').slice(0, 80);
  for (const d of devs) {
    const t = d.tuya || {};
    let key;
    if (t.id && (t.on || t.value)) {
      key = clean(`${t.id}.${t.on || t.value}`);
      if (!links.some((l) => l.key === key)) {
        const l = { key, tuyaId: t.id, type: d.type, name: d.name, room: d.room || '', unit: d.unit || '' };
        if (d.type === 'sensor') { l.value = t.value; l.scale = t.scale || 0; } else {
          l.on = t.on;
          if (t.brightness) { l.brightness = t.brightness; l.brightnessMax = t.brightnessMax || 1000; l.brightnessMin = t.brightnessMin || 10; }
        }
        links.push(l);
      }
    } else { key = clean(`ph.${d.id}`); d.pending = true; d.note = d.note || 'Tuya-Gerät noch nicht verknüpft'; }
    d.driver = 'plugin'; d.plugin = 'tuya'; d.key = key; d.src = `plugin:tuya:${key}`;
    delete d.tuya;
  }
  store.kvSet('plugin:tuya:links', links);
  // Plugin einschalten
  if (!c.plugins || typeof c.plugins !== 'object') c.plugins = {};
  if (!c.plugins.tuya) c.plugins.tuya = { enabled: true, config: {} };
  c.tuya = { migrated: new Date().toISOString() };   // überschreibt die gespeicherten Zugangsdaten in der Datenbank
  if (c.modules) delete c.modules.tuya;
  store.save();
  delete c.tuya;
  log('info', `Tuya: ${devs.length} Gerät(e) und Anmeldung in das Plugin „Tuya“ übernommen`);
  return true;
};
