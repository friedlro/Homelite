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
module.exports = function createUpdater({ store, log }) {
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
      return { id, version: pkg.version, current: cur, newer: cmp(pkg.version, cur) > 0, same: cmp(pkg.version, cur) === 0 };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  function sourceUrl(u) {
    const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(u);
    return m ? `https://api.github.com/repos/${m[1]}/${m[2]}/tarball` : u;
  }

  async function fromUrl(u) {
    if (!/^https?:\/\//i.test(u || '')) throw fail('Update-Quelle muss mit http(s):// beginnen');
    let r;
    try { r = await fetch(sourceUrl(u), { redirect: 'follow', headers: { 'User-Agent': 'HomeLite-Updater' }, signal: AbortSignal.timeout(90000) }); } catch (e) { throw fail('Download fehlgeschlagen: ' + e.message); }
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

  return { version, stage, fromUrl, install, backups, rollback, underSystemd };
};
