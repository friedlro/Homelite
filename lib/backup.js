'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const NAME = /^homelite-backup-[\w.-]+\.tgz$/;
const run = (cmd, args, opt = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 20e6, timeout: opt.timeout || 300000, cwd: opt.cwd }, (e, so, se) => {
    if (e && opt.okCodes && opt.okCodes.includes(e.code)) return resolve(String(so));
    if (e) { const er = new Error(String(se || e.message).trim().slice(0, 400)); er.status = 400; reject(er); } else resolve(String(so));
  });
});
const fail = (msg) => { const e = new Error(msg); e.status = 400; return e; };
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const PSEUDO = new Set(['tmpfs', 'overlay', 'proc', 'sysfs', 'devtmpfs', 'cgroup', 'cgroup2', '9p', 'squashfs', 'ramfs', 'autofs']);

// Backup & Wiederherstellung der Daten (data/: Konfiguration, Geräte, Automationen, Anwesenheit)
module.exports = function createBackup({ store, log, notify, version }) {
  const cfg = () => store.cfg.backup;
  const SAFE = path.join(store.DATA, 'backups');
  const underSystemd = () => !!process.env.INVOCATION_ID;

  function pathInfo(dir) {
    const info = { dir: dir || '', exists: false, writable: false, sameDisk: false, free: null };
    if (!dir) return info;
    try {
      const st = fs.statSync(dir);
      info.exists = st.isDirectory();
      if (!info.exists) return info;
      try { fs.accessSync(dir, fs.constants.W_OK); info.writable = true; } catch { /* nicht schreibbar */ }
      info.sameDisk = st.dev === fs.statSync(store.DATA).dev;
      const sf = fs.statfsSync(dir);
      info.free = sf.bavail * sf.bsize;
    } catch { /* ignorieren */ }
    return info;
  }

  function mounts() {
    const out = [];
    let txt = '';
    try { txt = fs.readFileSync('/proc/mounts', 'utf8'); } catch { return out; }
    for (const line of txt.split('\n')) {
      const [dev, mp0, type] = line.split(' ');
      if (!mp0 || PSEUDO.has(type)) continue;
      const mp = mp0.replace(/\\040/g, ' ');
      if (!/^\/(media|mnt|run\/media)(\/|$)/.test(mp) || mp === '/mnt' || mp === '/media') continue;
      try {
        const sf = fs.statfsSync(mp);
        out.push({ path: mp, device: dev, type, free: sf.bavail * sf.bsize, total: sf.blocks * sf.bsize });
      } catch { /* ignorieren */ }
    }
    return out;
  }

  function files(dir) {
    if (!dir) return [];
    try {
      return fs.readdirSync(dir).filter((f) => NAME.test(f)).map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, size: st.size, ts: st.mtimeMs };
      }).sort((a, b) => b.file.localeCompare(a.file));
    } catch { return []; }
  }

  async function create(auto = false) {
    const c = cfg();
    if (!c.dir) throw fail('Kein Zielordner eingestellt');
    let info = pathInfo(c.dir);
    if (!info.exists) {
      const parent = path.dirname(c.dir);
      if (!fs.existsSync(parent)) throw fail('Zielordner nicht gefunden – ist die Festplatte angeschlossen und eingehängt?');
      fs.mkdirSync(c.dir);
      info = pathInfo(c.dir);
    }
    if (!info.writable) throw fail('Zielordner ist nicht beschreibbar');
    if (info.sameDisk && !c.allowSameDisk) throw fail('Der Zielordner liegt auf derselben Festplatte wie HomeLite – vermutlich ist die externe Festplatte nicht eingehängt. Laufwerk prüfen oder „Auch auf derselben Festplatte erlauben“ aktivieren.');
    store.save();
    const meta = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-bk-'));
    const file = path.join(c.dir, `homelite-backup-${stamp()}.tgz`);
    try {
      fs.writeFileSync(path.join(meta, 'backup-meta.json'), JSON.stringify({ app: 'homelite', version: version(), ts: Date.now(), host: os.hostname() }));
      // SQLite: konsistente Momentaufnahme statt der laufenden Datei
      const snap = store.snapshotDb(path.join(meta, 'homelite.db'));
      await run('tar', ['-czf', file + '.part', '--warning=no-file-changed', '--exclude=./backups', '--exclude=*.tmp', ...(snap ? ['--exclude=./homelite.db'] : []), '-C', store.DATA, '.', '-C', meta, 'backup-meta.json', ...(snap ? ['homelite.db'] : [])], { okCodes: [1] });   // Exit 1 = „Datei hat sich beim Lesen geändert“ (Protokolle, Plugin-Daten) – Sicherung ist trotzdem vollständig
      fs.renameSync(file + '.part', file);
      try { fs.chmodSync(file, 0o600); } catch { /* FAT/exFAT */ }
    } catch (e) {
      fs.rmSync(file + '.part', { force: true });
      throw e;
    } finally { fs.rmSync(meta, { recursive: true, force: true }); }
    const keep = Math.max(1, Number(c.keep) || 10);
    for (const old of files(c.dir).slice(keep)) fs.rmSync(path.join(c.dir, old.file), { force: true });
    c.last = { ts: Date.now(), file: path.basename(file), ok: true, error: '', auto };
    store.save();
    log('info', `Backup erstellt: ${file}`);
    return { file: path.basename(file), size: fs.statSync(file).size };
  }

  async function inspect(file) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-rs-'));
    try {
      const verbose = (await run('tar', ['-tvzf', file])).split('\n').filter(Boolean);
      if (verbose.some((l) => /^[lh]/.test(l))) throw fail('Archiv enthält Verknüpfungen – abgelehnt');
      const names = (await run('tar', ['-tzf', file])).split('\n').filter(Boolean);
      if (names.some((n) => n.startsWith('/') || n.split('/').includes('..'))) throw fail('Archiv enthält ungültige Pfade – abgelehnt');
      const x = path.join(dir, 'x');
      fs.mkdirSync(x);
      await run('tar', ['-xzf', file, '-C', x, '--no-same-owner']);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(x, 'backup-meta.json'), 'utf8')); } catch { throw fail('Kein HomeLite-Backup (backup-meta.json fehlt)'); }
      if (meta.app !== 'homelite') throw fail('Kein HomeLite-Backup');
      let counts;
      if (fs.existsSync(path.join(x, 'homelite.db'))) {
        try { counts = store.inspectDb(path.join(x, 'homelite.db')); } catch (e) { throw fail('Datenbank im Backup ungültig: ' + e.message); }
      } else {
        let conf;
        try { conf = JSON.parse(fs.readFileSync(path.join(x, 'config.json'), 'utf8')); } catch { throw fail('Backup enthält weder homelite.db noch gültige config.json'); }
        if (!conf || !Array.isArray(conf.devices) || !Array.isArray(conf.automations)) throw fail('config.json im Backup ist unvollständig');
        counts = { devices: conf.devices.length, automations: conf.automations.length };
      }
      return { dir, x, meta, devices: counts.devices, automations: counts.automations };
    } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  }

  async function restoreFile(file) {
    const s = await inspect(file);
    try {
      fs.mkdirSync(SAFE, { recursive: true });
      await run('tar', ['-czf', path.join(SAFE, `pre-restore-${stamp()}.tgz`), '--warning=no-file-changed', '--exclude=./backups', '-C', store.DATA, '.'], { okCodes: [1] });
      const pre = fs.readdirSync(SAFE).filter((f) => f.startsWith('pre-restore-')).sort();
      for (const f of pre.slice(0, Math.max(0, pre.length - 3))) fs.rmSync(path.join(SAFE, f), { force: true });
      store.frozen = true; // verhindert, dass der laufende Prozess die wiederhergestellten Dateien überschreibt
      for (const f of fs.readdirSync(store.DATA)) if (f !== 'backups') fs.rmSync(path.join(store.DATA, f), { recursive: true, force: true });
      await run('cp', ['-a', s.x + '/.', store.DATA + '/']);
      fs.rmSync(path.join(store.DATA, 'backup-meta.json'), { force: true });
      for (const f of ['homelite.db', 'config.json']) { try { fs.chmodSync(path.join(store.DATA, f), 0o600); } catch { /* ignorieren */ } }
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
    log('info', `Backup wiederhergestellt (${s.devices} Geräte, ${s.automations} Automationen)`);
    if (underSystemd()) setTimeout(() => process.exit(0), 1200);
    return { ok: true, restart: underSystemd(), devices: s.devices, automations: s.automations, ts: s.meta.ts, version: s.meta.version };
  }

  async function restoreName(name) {
    const c = cfg();
    if (!NAME.test(name || '') || !fs.existsSync(path.join(c.dir || '', name))) throw fail('Backup nicht gefunden');
    return restoreFile(path.join(c.dir, name));
  }

  async function restoreUpload(buf) {
    if (!buf || buf.length < 200) throw fail('Datei leer oder zu klein');
    const tmp = path.join(os.tmpdir(), `hl-upload-${Date.now()}.tgz`);
    fs.writeFileSync(tmp, buf);
    try { return await restoreFile(tmp); } finally { fs.rmSync(tmp, { force: true }); }
  }

  function remove(name) {
    const c = cfg();
    if (!NAME.test(name || '') || !fs.existsSync(path.join(c.dir || '', name))) throw fail('Backup nicht gefunden');
    fs.rmSync(path.join(c.dir, name), { force: true });
  }

  function filePath(name) {
    const c = cfg();
    if (!NAME.test(name || '') || !fs.existsSync(path.join(c.dir || '', name))) throw fail('Backup nicht gefunden');
    return path.join(c.dir, name);
  }

  function info() {
    const c = cfg();
    return { dir: c.dir, keep: c.keep, auto: !!c.auto, time: c.time, allowSameDisk: !!c.allowSameDisk, last: c.last || null, path: pathInfo(c.dir), mounts: mounts(), files: files(c.dir), systemd: underSystemd() };
  }

  // minütlich aufgerufen: tägliches Backup zur eingestellten Zeit
  async function tick() {
    const c = cfg();
    if (!c.auto || !c.dir) return;
    const d = new Date();
    const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (hhmm < (c.time || '03:00') || c.lastAutoDay === day) return;
    c.lastAutoDay = day;
    try { await create(true); } catch (e) {
      c.last = { ts: Date.now(), ok: false, error: e.message, auto: true };
      store.save();
      log('warn', 'Automatisches Backup fehlgeschlagen: ' + e.message);
      notify('HomeLite', 'Automatisches Backup fehlgeschlagen: ' + e.message).catch(() => {});
    }
  }

  return { info, create, restoreName, restoreUpload, remove, filePath, tick, pathInfo };
};
