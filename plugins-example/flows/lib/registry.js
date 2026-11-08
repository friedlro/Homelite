'use strict';
// Knoten-Register: eingebaute Knoten, Dateien aus <Daten>/nodes/*.js und Knoten anderer Plugins
const fs = require('fs');
const path = require('path');

const TYPE_RE = /^[a-z0-9][a-z0-9._-]{1,48}$/;
const CATS = ['Auslöser', 'Logik', 'Daten', 'Fluss', 'Aktion', 'Erweiterung'];

function createRegistry() {
  const map = new Map(); // type -> { def, owner }
  const errors = [];

  function add(def, owner) {
    if (!def || typeof def !== 'object') throw new Error('Knoten-Definition fehlt');
    if (!TYPE_RE.test(String(def.type || ''))) throw new Error(`Knotentyp „${def.type}“ ungültig (a–z, 0–9, . _ -)`);
    if (typeof def.run !== 'function' && typeof def.start !== 'function' && !def.passive) throw new Error(`Knoten „${def.type}“ braucht run(ctx, msg) oder start(ctx)`);
    const ex = map.get(def.type);
    if (ex && ex.owner !== owner) throw new Error(`Knotentyp „${def.type}“ ist bereits durch ${ex.owner} belegt`);
    const d = { category: 'Erweiterung', icon: '🧩', color: '', desc: '', inputs: def.start || def.passive ? 0 : 1, outputs: 1, fields: [], ...def };
    if (!CATS.includes(d.category)) d.category = 'Erweiterung';
    map.set(d.type, { def: d, owner });
  }
  function removeOwner(owner) { for (const [k, v] of [...map]) if (v.owner === owner) map.delete(k); }
  const get = (type) => { const e = map.get(type); return e ? e.def : null; };

  // Für die Oberfläche (ohne Funktionen)
  function catalog() {
    return [...map.values()].map(({ def, owner }) => ({
      type: def.type, label: def.label || def.type, category: def.category, icon: def.icon, color: def.color, desc: def.desc, inputs: def.inputs, outputs: def.outputs,
      labels: def.labels || null, dyn: def.dyn || null, fields: def.fields || [], owner, noMcp: !!def.noMcp, passive: !!def.passive, trigger: typeof def.start === 'function', doc: def.doc || '',
    }));
  }

  function loadDir(dir, helpers) {
    errors.length = 0;
    for (const [k, v] of [...map]) if (v.owner.startsWith('datei:')) map.delete(k);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort(); } catch { return; }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        delete require.cache[require.resolve(full)];
        let m = require(full);
        if (typeof m === 'function') m = m(helpers);
        for (const d of Array.isArray(m) ? m : [m]) add(d, 'datei:' + f);
      } catch (e) { errors.push({ file: f, error: e.message }); }
    }
  }

  return { add, removeOwner, get, catalog, loadDir, errors, has: (t) => map.has(t), types: () => [...map.keys()] };
}

module.exports = { createRegistry, CATS };
