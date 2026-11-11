'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const run = (cmd, args, opt = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 20e6, timeout: opt.timeout || 120000, cwd: opt.cwd }, (e, so, se) => {
    if (e) { const er = new Error(String(se || e.message).trim().slice(0, 400)); er.status = 400; reject(er); }
    else resolve(String(so));
  });
});
const fail = (msg) => { const e = new Error(msg); e.status = 400; return e; };
const readPkg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const cmp = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
};

// Software-Update: Archiv (tar.gz) prüfen, Sicherung anlegen, Dateien ersetzen, neu starten.
const gitsrc = require('./gitsrc');
const DEFAULT_SOURCE = gitsrc.DEFAULT_SOURCE;

// Neuerungen aus docs/CHANGELOG.md: alle Abschnitte „## <Version> …“, die neuer als `current` sind, als kurze Liste
function notesFrom(md, current) {
  const out = [];
  let ver = null;
  for (const line of String(md || '').split('\n')) {
    const h2 = /^##\s+v?(\d+\.\d+\.\d+)\b/.exec(line);
    if (h2) { ver = cmp(h2[1], current) > 0 ? h2[1] : null; continue; }
    if (/^##\s/.test(line)) { ver = null; continue; }
    const b = /^\s*[-*]\s+(.*\S)/.exec(line);
    if (ver && b) out.push({ version: ver, text: b[1].replace(/\*\*/g, '').replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^(.{200}).+$/, '$1…') });
  }
  return out.slice(0, 12);
}

module.exports = function createUpdater({ store, log, notify }) {
  const BACKUPS = path.join(store.DATA, 'backups');
  const staged = new Map();
  const underSystemd = () => !!process.env.INVOCATION_ID;
  const version = () => readPkg(ROOT).version;

  setInterval(() => {
    for (const [id, s] of staged) if (Date.now() - s.t > 15 * 60000) { fs.rmSync(s.dir, { recursive: true, force: true }); staged.delete(id); }
  }, 60000).unref();

  async function stage(buf) {
    if (!buf || buf.length < 500) throw fail('Datei leer oder zu klein');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-up-'));
    try {
      const file = path.join(dir, 'update.tgz');
      fs.writeFileSync(file, buf);
      const verbose = (await run('tar', ['-tvzf', file])).split('\n').filter(Boolean);
      if (verbose.some((l) => /^[lh]/.test(l))) throw fail('Archiv enthält Verknüpfungen – abgelehnt');
      const names = (await run('tar', ['-tzf', file])).split('\n').filter(Boolean);
      if (names.some((n) => n.startsWith('/') || n.split('/').includes('..'))) throw fail('Archiv enthält ungültige Pfade – abgelehnt');
      const x = path.join(dir, 'x');
      fs.mkdirSync(x);
      await run('tar', ['-xzf', file, '-C', x, '--no-same-owner']);
      let root = x;
      const ents = fs.readdirSync(x);
      if (!fs.existsSync(path.join(root, 'package.json')) && ents.length === 1 && fs.statSync(path.join(x, ents[0])).isDirectory()) root = path.join(x, ents[0]);
      if (!fs.existsSync(path.join(root, 'package.json')) || !fs.existsSync(path.join(root, 'server.js'))) throw fail('Kein HomeLite-Paket (package.json/server.js fehlen)');
      const pkg = readPkg(root);
      if (pkg.name !== 'homelite') throw fail('Kein HomeLite-Paket');
      await run('node', ['--check', path.join(root, 'server.js')]);
      for (const skip of ['data', 'node_modules', '.venv']) fs.rmSync(path.join(root, skip), { recursive: true, force: true });
      const id = crypto.randomBytes(6).toString('hex');
      staged.set(id, { id, dir, root, version: pkg.version, deps: pkg.dependencies || {}, t: Date.now() });
      const cur = version();
      let notes = [];
      try { notes = notesFrom(fs.readFileSync(path.join(root, 'docs', 'CHANGELOG.md'), 'utf8'), cur); } catch { /* ohne Changelog */ }
      return { id, version: pkg.version, current: cur, newer: cmp(pkg.version, cur) > 0, same: cmp(pkg.version, cur) === 0, notes };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  async function fromUrl(u) {
    if (!/^https?:\/\//i.test(u || '')) throw fail('Update-Quelle muss mit http(s):// beginnen');
    const src = gitsrc.parse(u);
    if (src) return stage(await gitsrc.archive(src)); // GitLite oder GitHub
    let r;
    try { r = await fetch(u, { redirect: 'follow', headers: { 'User-Agent': 'HomeLite-Updater' }, signal: AbortSignal.timeout(90000) }); } catch (e) { throw fail('Download fehlgeschlagen: ' + e.message); }
    if (!r.ok) throw fail('Download fehlgeschlagen: HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 40e6) throw fail('Archiv zu groß');
    return stage(buf);
  }

  async function install(id) {
    const s = staged.get(id);
    if (!s) throw fail('Update nicht mehr vorhanden – bitte erneut suchen/hochladen');
    const oldPkg = readPkg(ROOT);
    fs.mkdirSync(BACKUPS, { recursive: true });
    const backup = path.join(BACKUPS, `homelite-${oldPkg.version}-${Date.now()}.tgz`);
    await run('tar', ['-czf', backup, '--exclude=./data', '--exclude=./node_modules', '--exclude=./.venv', '--exclude=__pycache__', '-C', ROOT, '.']);
    const old = fs.readdirSync(BACKUPS).filter((f) => f.endsWith('.tgz')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 5))) fs.rmSync(path.join(BACKUPS, f), { force: true });
    await run('cp', ['-a', s.root + '/.', ROOT + '/']);
    let npmNote = '';
    if (JSON.stringify(oldPkg.dependencies || {}) !== JSON.stringify(s.deps)) {
      try { await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, timeout: 180000 }); } catch (e) { npmNote = 'npm install fehlgeschlagen: ' + e.message; log('warn', npmNote); }
    }
    fs.rmSync(s.dir, { recursive: true, force: true });
    staged.delete(id);
    log('info', `Update ${oldPkg.version} → ${s.version} installiert${underSystemd() ? ' – starte neu' : ''}`);
    if (underSystemd()) setTimeout(() => process.exit(0), 1200);
    return { ok: true, version: s.version, restart: underSystemd(), note: npmNote };
  }

  function backups() {
    if (!fs.existsSync(BACKUPS)) return [];
    return fs.readdirSync(BACKUPS).filter((f) => /^homelite-[\w.-]+\.tgz$/.test(f)).sort().reverse().map((f) => {
      const st = fs.statSync(path.join(BACKUPS, f));
      const m = /^homelite-([\d.]+)-(\d+)\.tgz$/.exec(f);
      return { file: f, version: m ? m[1] : '?', ts: st.mtimeMs, size: st.size };
    });
  }

  async function rollback(name) {
    if (!/^homelite-[\w.-]+\.tgz$/.test(name || '') || !fs.existsSync(path.join(BACKUPS, name))) throw fail('Sicherung nicht gefunden');
    const s = await stage(fs.readFileSync(path.join(BACKUPS, name)));
    return install(s.id);
  }

  // ---------- tägliche Prüfung (GitLite oder GitHub) ----------
  const source = () => (store.cfg.update.url || DEFAULT_SOURCE).trim();
  function status() {
    const c = store.kvGet('update:check') || {};
    const cur = version();
    return { latest: c.latest || '', newer: !!c.latest && cmp(c.latest, cur) > 0, notes: c.latest && cmp(c.latest, cur) > 0 ? notesFrom(c.md, cur) : [], checked: c.ts || 0, error: c.error || '', auto: store.cfg.update.auto !== false, source: source() };
  }
  async function check() {
    const src = gitsrc.parse(source());
    if (!src) { store.kvSet('update:check', { ts: Date.now(), error: 'Automatische Prüfung nur für GitLite-/GitHub-Quellen' }); return status(); }
    const get = async (f) => { const r = await gitsrc.rawFile(src, f); if (r.status !== 200) throw new Error('HTTP ' + r.status); return r.text; };
    try {
      const pkg = JSON.parse(await get('package.json'));
      if (pkg.name !== 'homelite' || !/^\d+\.\d+\.\d+$/.test(pkg.version || '')) throw new Error('Kein HomeLite-Repository');
      let md = ''; try { md = await get('docs/CHANGELOG.md'); } catch { /* ohne Changelog */ }
      store.kvSet('update:check', { ts: Date.now(), latest: pkg.version, md: md.slice(0, 40000) });
      const st = status();
      if (st.newer && store.kvGet('update:notified') !== st.latest) {
        store.kvSet('update:notified', st.latest);
        log('info', `Neue HomeLite-Version ${st.latest} verfügbar`);
        if (notify) { const top = st.notes.slice(0, 3).map((n) => '• ' + n.text).join('\n'); notify(`HomeLite ${st.latest} verfügbar`, top || 'Neue Version – Einstellungen → Software-Update.').catch(() => {}); }
      }
    } catch (e) { store.kvSet('update:check', { ...(store.kvGet('update:check') || {}), ts: Date.now(), error: e.message }); log('warn', 'Update-Prüfung: ' + e.message); }
    return status();
  }
  const due = () => { const c = store.kvGet('update:check') || {}; return store.cfg.update.auto !== false && Date.now() - (c.ts || 0) > 23 * 3600e3; };
  setTimeout(() => { if (due()) check(); }, 90000).unref();
  setInterval(() => { if (due()) check(); }, 3600e3).unref();

  return { version, stage, fromUrl, install, backups, rollback, underSystemd, check, status, source };
};
