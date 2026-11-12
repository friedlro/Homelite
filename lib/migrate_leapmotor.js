'use strict';
// Einmalige Übernahme der früher eingebauten Leapmotor-Anbindung in das Plugin „leapmotor“ (ab HomeLite 1.26.0).
// Zugangsdaten, Einstellungen und App-Zertifikate wandern ins Plugin; die Geräte-IDs bleiben (Plugin legt Sensoren neu an).
const fs = require('fs');
const path = require('path');

module.exports = function migrateLeapmotor({ store, log, root }) {
  const c = store.cfg;
  const legacy = c.car;
  const used = !!(legacy && (legacy.enabled || legacy.username));
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* egal */ } };
  const certsDir = path.join(root, 'lib', 'leapmotor', 'certs');
  const dst = path.join(store.DATA, 'plugins', 'leapmotor');
  if (!used) {
    if (c.car !== undefined || (c.modules && c.modules.car !== undefined)) { delete c.car; if (c.modules) delete c.modules.car; store.save(); }
    return false;
  }
  try {
    if (!fs.existsSync(path.join(dst, 'plugin.json'))) {
      const src = path.join(root, 'plugins-example', 'leapmotor');
      if (!fs.existsSync(path.join(src, 'plugin.json'))) throw new Error('Plugin-Dateien fehlen im Update (plugins-example/leapmotor)');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
    // App-Zertifikate in den Datenordner des Plugins (bleibt bei Plugin-Updates erhalten)
    const pdir = path.join(store.DATA, 'plugin-data', 'leapmotor', 'certs');
    const bundled = [certsDir, path.join(root, 'plugins-example', 'leapmotor', 'leapmotor', 'certs')].find((d) => ['app_cert.pem', 'app_key.pem'].every((f) => fs.existsSync(path.join(d, f))));
    if (bundled) {
      fs.mkdirSync(pdir, { recursive: true });
      for (const f of ['app_cert.pem', 'app_key.pem']) if (!fs.existsSync(path.join(pdir, f))) { fs.copyFileSync(path.join(bundled, f), path.join(pdir, f)); try { fs.chmodSync(path.join(pdir, f), 0o600); } catch { /* egal */ } }
    }
    // Aus dem Plugin-Ordner die mitgelieferten Zertifikate entfernen (liegen jetzt im Datenordner)
    rm(path.join(dst, 'leapmotor', 'certs', 'app_cert.pem')); rm(path.join(dst, 'leapmotor', 'certs', 'app_key.pem'));
  } catch (e) {
    log('error', 'Leapmotor-Plugin konnte nicht installiert werden – Daten bleiben unverändert: ' + e.message);
    return false;
  }
  if (!c.plugins || typeof c.plugins !== 'object') c.plugins = {};
  if (!c.plugins.leapmotor) {
    c.plugins.leapmotor = {
      enabled: !!legacy.enabled,
      config: {
        name: legacy.name || 'Leapmotor', username: legacy.username || '', password: legacy.password || '', pin: legacy.pin || '',
        vin: legacy.vin || '', pollMinutes: Number(legacy.pollMinutes) || 10, certPath: legacy.certPath || '', keyPath: legacy.keyPath || '',
      },
    };
  }
  c.car = { migrated: new Date().toISOString() };   // überschreibt die gespeicherten Zugangsdaten in der Datenbank
  if (c.modules) delete c.modules.car;
  store.save();
  delete c.car;
  // Veraltete Dateien des früheren Kerns entfernen (ein Update überschreibt nur, löscht aber nichts)
  for (const f of ['car.js', 'leap_bridge.py', 'leap_bridge_view.py', 'leap_diag.py']) rm(path.join(root, 'lib', f));
  rm(path.join(root, 'lib', 'leapmotor'));
  log('info', 'Leapmotor: Einstellungen, Zugangsdaten und Zertifikate in das Plugin „Leapmotor“ übernommen');
  return true;
};
