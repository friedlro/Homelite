'use strict';
// Quellen für Software-Update und Plugins: GitLite (eigener Git-Server) und GitHub.
//   GitLite: https://<Host>/r/<Repo>[/tree?ref=<Zweig>&path=<Ordner>]   (Dateien über /raw, Archiv über Git-Klon)
//   GitHub:  https://github.com/<Nutzer>/<Repo>[/tree/<Zweig>/<Ordner>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_SOURCE = 'https://gitlite.bicolor-bull.ts.net/r/homelite';
const GL = /^(https?):\/\/([^/\s?#]+)\/r\/([\w.-]+?)(?:\.git)?(?:\/(?:tree)?)?(?:\?([^#]*))?$/;
const GH = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/?#]+)(?:\/([^?#]*?))?)?\/?(?:[?#].*)?$/;
const REF = /^[\w][\w./-]{0,80}$/;
const fail = (m) => { const e = new Error(m); e.status = 400; return e; };
const run = (cmd, args, opt = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 20e6, timeout: opt.timeout || 120000, cwd: opt.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opt.env || {}) } }, (e, so, se) => {
    if (e) { const er = new Error(e.code === 'ENOENT' ? `„${cmd}“ ist nicht installiert (sudo apt install ${cmd})` : String(se || e.message).trim().slice(0, 300)); er.status = 400; reject(er); } else resolve(String(so));
  });
});

// Adresse → Quelle { kind, base|owner, repo, ref, path } oder null
function parse(u) {
  u = String(u || '').trim();
  let m = GL.exec(u);
  if (m) {
    const q = new URLSearchParams(m[4] || '');
    const ref = q.get('ref') || 'HEAD'; const p = (q.get('path') || '').replace(/^\/+|\/+$/g, '');
    if (!REF.test(ref) && ref !== 'HEAD') return null;
    if (p.split('/').includes('..')) return null;
    return { kind: 'gitlite', base: `${m[1]}://${m[2]}`, repo: m[3], ref, path: p };
  }
  m = GH.exec(u);
  if (m) return { kind: 'github', owner: m[1], repo: m[2], ref: m[3] || 'HEAD', path: (m[4] || '').replace(/\/+$/, '') };
  return null;
}
const withPath = (s, p, ref) => ({ ...s, path: p, ref: ref || s.ref });

// Adresse zum Ansehen im Browser
function web(s) {
  if (s.kind === 'gitlite') return `${s.base}/r/${s.repo}` + (s.path || s.ref !== 'HEAD' ? `/tree?ref=${encodeURIComponent(s.ref === 'HEAD' ? 'main' : s.ref)}${s.path ? '&path=' + encodeURIComponent(s.path).replace(/%2F/g, '/') : ''}` : '');
  return `https://github.com/${s.owner}/${s.repo}` + (s.path ? `/tree/${s.ref}/${s.path}` : '');
}

// Textdatei (Pfad relativ zum Repository-Wurzelverzeichnis) → { status, text }
async function rawFile(s, file) {
  const full = [s.path, file].filter(Boolean).join('/');
  const url = s.kind === 'gitlite'
    ? `${s.base}/r/${s.repo}/raw?ref=${encodeURIComponent(s.ref === 'HEAD' ? 'main' : s.ref)}&path=${encodeURIComponent(full).replace(/%2F/g, '/')}`
    : `${process.env.HOMELITE_RAW_BASE || 'https://raw.githubusercontent.com'}/${s.owner}/${s.repo}/${s.ref}/${full}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'HomeLite-Updater' }, signal: AbortSignal.timeout(20000) });
  return { status: r.status, text: r.ok ? (await r.text()).slice(0, 2e6) : '' };
}

// Git-Klon (flach) in ein Wegwerf-Verzeichnis; liefert { dir, top }
async function clone(s) {
  const url = process.env.HOMELITE_GIT_BASE ? `${process.env.HOMELITE_GIT_BASE}/${s.repo}.git` : `${s.base}/${s.repo}.git`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-git-'));
  const top = path.join(dir, s.repo);
  const proto = process.env.HOMELITE_GIT_BASE ? 'always' : 'never';
  try {
    await run('git', ['-c', 'protocol.allow=never', '-c', 'protocol.http.allow=always', '-c', 'protocol.https.allow=always', '-c', `protocol.file.allow=${proto}`, '-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null',
      'clone', '--quiet', '--depth', '1', ...(s.ref && s.ref !== 'HEAD' ? ['--branch', s.ref] : []), '--', url, top], { timeout: 120000 });
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  return { dir, top };
}

// Archiv des ganzen Repositories (tar.gz mit Oberordner) – Unterordner wählt der Aufrufer
async function archive(s) {
  if (s.kind === 'github') {
    const url = `https://api.github.com/repos/${s.owner}/${s.repo}/tarball${s.ref && s.ref !== 'HEAD' ? '/' + s.ref : ''}`;
    let r; try { r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'HomeLite-Plugins' }, signal: AbortSignal.timeout(90000) }); } catch (e) { throw fail('Download fehlgeschlagen: ' + e.message); }
    if (!r.ok) throw fail('Download fehlgeschlagen: HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 40e6) throw fail('Archiv zu groß');
    return buf;
  }
  const { dir, top } = await clone(s);
  try {
    fs.rmSync(path.join(top, '.git'), { recursive: true, force: true });
    const out = path.join(dir, 'a.tgz');
    await run('tar', ['-czf', out, '-C', dir, s.repo], { timeout: 120000 });
    const buf = fs.readFileSync(out);
    if (buf.length > 40e6) throw fail('Archiv zu groß');
    return buf;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Unterordner eines Verzeichnisses (für den Plugin-Katalog)
async function listDirs(s, dirPath) {
  if (s.kind === 'github') {
    const api = process.env.HOMELITE_API_BASE || 'https://api.github.com';
    let r; try { r = await fetch(`${api}/repos/${s.owner}/${s.repo}/contents/${dirPath}`, { headers: { 'User-Agent': 'HomeLite-Plugins' }, signal: AbortSignal.timeout(15000) }); } catch (e) { throw fail('GitHub nicht erreichbar: ' + e.message); }
    if (!r.ok) throw fail(r.status === 403 ? 'GitHub-Abrufgrenze erreicht – später erneut versuchen' : `GitHub-Verzeichnis nicht lesbar (HTTP ${r.status})`);
    return (await r.json()).filter((x) => x.type === 'dir').map((x) => x.name);
  }
  const { dir, top } = await clone(s);
  try { return fs.readdirSync(path.join(top, dirPath), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { throw fail(`Ordner „${dirPath}“ im Repository nicht gefunden`); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { DEFAULT_SOURCE, parse, withPath, web, rawFile, archive, listDirs };
