'use strict';
// SSH-Plugin: Werkzeuge ssh_hosts und ssh_exec für den KI-Zugriff (MCP). Nutzt das System-ssh mit eigenem Schlüssel.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const MAX_OUT = 20000;

module.exports = (api) => {
  const dir = api.dataDir;
  const key = path.join(dir, 'id_ed25519');
  const known = path.join(dir, 'known_hosts');
  const history = []; // letzte Befehle (nur im Speicher)
  let pub = '';

  const askpass = path.join(dir, 'askpass.sh');
  const stored = () => { const v = api.kv.get('hosts'); return Array.isArray(v) ? v : []; };
  // Host aus den Plugin-Einstellungen (Felder Name/Server/Port/Benutzer/Passwort) + auf der Seite angelegte Hosts
  const cfgHost = () => {
    const c = api.config();
    const server = String(c.server || '').trim();
    const user = String(c.user || '').trim();
    if (!server || !user || !/^[\w.:-]+$/.test(server) || server.startsWith('-') || !/^[\w.-]+$/.test(user) || user.startsWith('-')) return null;
    const port = Number(c.port) || 22;
    return { name: String(c.name || '').trim() || 'server', host: server, user, port: port >= 1 && port <= 65535 ? port : 22, password: String(c.password || ''), fromConfig: true };
  };
  const hosts = () => { const c = cfgHost(); return c ? [c, ...stored().filter((x) => x.name.toLowerCase() !== c.name.toLowerCase())] : stored(); };
  const saveHosts = (l) => api.kv.set('hosts', l);

  function clean(b, old) {
    const name = String(b.name || '').trim();
    const host = String(b.host || '').trim();
    const user = String(b.user || '').trim();
    const port = Number(b.port) || 22;
    if (!/^[\w .-]{1,40}$/.test(name)) throw new Error('Name: 1–40 Zeichen (Buchstaben, Zahlen, Leerzeichen, . _ -)');
    if (!/^[\w.:-]{1,253}$/.test(host) || host.startsWith('-')) throw new Error('Server: ungültige Adresse');
    if (!/^[\w.-]{1,64}$/.test(user) || user.startsWith('-')) throw new Error('Benutzer ungültig');
    if (!(port >= 1 && port <= 65535)) throw new Error('Port ungültig');
    const password = b.password ? String(b.password).slice(0, 500) : (old ? old.password : '');
    return { name, host, user, port, password: password || '' };
  }
  const find = (n) => hosts().find((h) => h.name.toLowerCase() === String(n || '').trim().toLowerCase());

  function ensureKey() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$HL_SSH_PASS"\n', { mode: 0o700 });
    return new Promise((resolve) => {
      const done = () => { try { pub = fs.readFileSync(key + '.pub', 'utf8').trim(); } catch { pub = ''; } resolve(); };
      if (fs.existsSync(key)) return done();
      execFile('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'homelite', '-f', key], (e) => {
        if (e) api.log('error', 'ssh-keygen fehlgeschlagen (ist OpenSSH installiert?): ' + e.message);
        done();
      });
    });
  }

  function run(h, command, timeoutS, by) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const pw = !!h.password;
      const args = ['-i', key, '-p', String(h.port), '-o', pw ? 'BatchMode=no' : 'BatchMode=yes', ...(pw ? ['-o', 'PreferredAuthentications=password,keyboard-interactive,publickey', '-o', 'NumberOfPasswordPrompts=1'] : ['-o', 'IdentitiesOnly=yes']), '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'UserKnownHostsFile=' + known, '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR', `${h.user}@${h.host}`, '--', command];
      const env = pw ? { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', HL_SSH_PASS: h.password, DISPLAY: process.env.DISPLAY || 'homelite:0' } : process.env;
      const p = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
      let out = ''; let err = ''; let cut = false; let killed = false;
      const add = (cur, d) => { const s = cur + d; if (s.length > MAX_OUT) { cut = true; return s.slice(0, MAX_OUT); } return s; };
      p.stdout.on('data', (d) => { out = add(out, d); });
      p.stderr.on('data', (d) => { err = add(err, d); });
      let finished = false;
      const to = setTimeout(() => { killed = true; p.kill('SIGKILL'); fin(null); }, Math.max(1, timeoutS) * 1000);
      const fin = (code, msg) => {
        if (finished) return;
        finished = true;
        clearTimeout(to);
        const r = { host: h.name, exit: killed ? null : code, stdout: out, stderr: err || undefined, truncated: cut || undefined, error: killed ? `Zeitlimit (${timeoutS} s) überschritten` : msg, ms: Date.now() - t0 };
        history.unshift({ ts: Date.now(), host: h.name, cmd: command.slice(0, 300), exit: r.exit, by, err: r.error || '' });
        history.length = Math.min(history.length, 50);
        api.log('info', `${by}: ${h.name}$ ${command.slice(0, 200)} → ${r.error || 'Exit ' + r.exit}`);
        api.emit({ history });
        resolve(r);
      };
      p.on('error', (e) => fin(null, e.code === 'ENOENT' ? 'ssh ist auf dem HomeLite-Rechner nicht installiert' : e.message));
      p.on('close', (code) => fin(code));
    });
  }

  const tout = (v) => Math.min(Math.max(Number(v) || Number(api.config().timeout) || 30, 1), 300);

  api.mcp.tool({
    name: 'ssh_hosts', description: 'SSH: Liste der Hosts, auf denen ssh_exec Befehle ausführen darf.', readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ hosts: hosts().map((h) => ({ name: h.name, ziel: `${h.user}@${h.host}:${h.port}` })), befehle_erlaubt: !api.config().readonly }),
  });
  api.mcp.tool({
    name: 'ssh_exec', control: true,
    description: 'SSH: Befehl auf einem eingetragenen Host ausführen (Name aus ssh_hosts). Liefert Exit-Code, stdout und stderr (max. 20 000 Zeichen). Keine interaktiven Programme; Zeitlimit konfigurierbar.',
    inputSchema: { type: 'object', properties: { host: { type: 'string' }, command: { type: 'string' }, timeout: { type: 'number', description: 'Sekunden (1–300)' } }, required: ['host', 'command'] },
    run: async ({ host, command, timeout }) => {
      if (api.config().readonly) throw new Error('Befehle sind im SSH-Plugin ausgeschaltet (Einstellung „Nur Hosts auflisten“).');
      const h = find(host);
      if (!h) throw new Error(`Host „${host}“ ist nicht eingetragen. Erlaubt: ${hosts().map((x) => x.name).join(', ') || '(keine)'}`);
      const c = String(command || '');
      if (!c.trim() || c.length > 4000) throw new Error('Befehl leer oder zu lang');
      if (!pub && !h.password) throw new Error('Kein SSH-Schlüssel vorhanden (ssh-keygen fehlt?) und kein Passwort hinterlegt');
      return run(h, c, tout(timeout), 'KI');
    },
  });

  const status = () => ({ terminal: api.config().terminal !== false, mcp: api.mcp.endpoint().path, pub, hosts: hosts().map((h) => ({ name: h.name, host: h.host, port: h.port, user: h.user, hasPassword: !!h.password, fromConfig: !!h.fromConfig, target: `${h.user}@${h.host}:${h.port}` })), readonly: !!api.config().readonly, history });
  api.route('GET', 'status', () => status());
  // Host anlegen/ändern: { name, host, port, user, password, original? } – Passwort leer = unverändert
  api.route('POST', 'hosts', ({ body }) => {
    const b = body || {};
    const l = stored();
    const cn = cfgHost();
    if (cn && String(b.name || '').trim().toLowerCase() === cn.name.toLowerCase()) throw new Error('Dieser Name wird vom Host aus den Plugin-Einstellungen verwendet');
    const old = l.find((x) => x.name.toLowerCase() === String(b.original || b.name || '').trim().toLowerCase());
    const h = clean(b, old);
    if (b.clearPassword) h.password = '';
    if (l.some((x) => x !== old && x.name.toLowerCase() === h.name.toLowerCase())) throw new Error('Ein Host mit diesem Namen existiert schon');
    if (old) l[l.indexOf(old)] = h; else l.push(h);
    saveHosts(l);
    const st = status(); api.emit({ status: st }); return st;
  });
  api.route('DELETE', 'hosts/:name', ({ params }) => {
    saveHosts(stored().filter((x) => x.name.toLowerCase() !== params.name.toLowerCase()));
    const st = status(); api.emit({ status: st }); return st;
  });

  // ---------- Terminal (Befehlszeile auf der Seite „SSH“) ----------
  // Kein echtes Terminal: jeder Befehl läuft einzeln per ssh („sh -s“), die Ausgabe kommt live auf die Seite,
  // das Arbeitsverzeichnis wird zwischen den Befehlen mitgeführt. Interaktive Programme (vim, top, sudo-Passwort) gehen nicht.
  const jobs = new Map(); // id -> { p, host, killed }
  const MARK = '\u0001HLEND\u0001';
  const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n');
  const sshArgs = (h, remote) => ['-i', key, '-p', String(h.port), '-o', h.password ? 'BatchMode=no' : 'BatchMode=yes',
    ...(h.password ? ['-o', 'PreferredAuthentications=password,keyboard-interactive,publickey', '-o', 'NumberOfPasswordPrompts=1'] : ['-o', 'IdentitiesOnly=yes']),
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + known, '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'LogLevel=ERROR', `${h.user}@${h.host}`, '--', remote];
  const sshEnv = (h) => (h.password ? { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', HL_SSH_PASS: h.password, DISPLAY: process.env.DISPLAY || 'homelite:0' } : process.env);

  function startJob(h, cmd, cwd, job) {
    const script = `${cwd ? `cd -- ${sq(cwd)} 2>/dev/null\n` : ''}${cmd}\n__hl=$?\nprintf '\\001HLEND\\001%s|%s\\n' "$__hl" "$(pwd)"\n`;
    const p = spawn('ssh', sshArgs(h, 'sh -s'), { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnv(h) });
    const J = { p, host: h.name, killed: false };
    jobs.set(job, J);
    let buf = ''; let sent = 0; let total = 0; let finished = false; let endInfo = null;
    const emit = (d) => api.emit({ term: { job, ...d } });
    const flush = (final) => {
      let hold = 0;
      const i = buf.indexOf(MARK);
      let visible = buf;
      if (i >= 0) {
        visible = buf.slice(0, i);
        const m = /^\u0001HLEND\u0001(-?\d+)\|([^\n]*)\n?/.exec(buf.slice(i));
        if (m) endInfo = { exit: Number(m[1]), cwd: m[2] };
      } else if (!final) {
        for (let k = Math.min(buf.length, MARK.length - 1); k >= 1; k--) if (MARK.startsWith(buf.slice(-k))) { hold = k; break; }
        visible = buf.slice(0, buf.length - hold);
      }
      if (visible.length) { total += visible.length; if (total <= 300000) emit({ out: plain(visible) }); else if (!J.cut) { J.cut = true; emit({ out: '\n[… Ausgabe gekürzt]\n' }); } }
      buf = i >= 0 ? buf.slice(i) : buf.slice(buf.length - hold);
    };
    p.stdout.on('data', (d) => { buf += d; flush(false); });
    p.stderr.on('data', (d) => { emit({ out: plain(String(d)), err: true }); });
    const fin = (code, msg) => {
      if (finished) return;
      finished = true;
      clearTimeout(to);
      flush(true);
      jobs.delete(job);
      const err = J.timeout ? 'Zeitlimit (10 Minuten) überschritten' : J.killed ? 'Abgebrochen' : msg;
      history.unshift({ ts: Date.now(), host: h.name, cmd: cmd.slice(0, 300), exit: endInfo ? endInfo.exit : code, by: 'Terminal', err: err || '' });
      history.length = Math.min(history.length, 50);
      api.log('info', `Terminal: ${h.name}$ ${cmd.slice(0, 200)} → ${err || 'Exit ' + (endInfo ? endInfo.exit : code)}`);
      api.emit({ history });
      emit({ done: true, exit: endInfo ? endInfo.exit : code, cwd: endInfo ? endInfo.cwd : undefined, error: err || undefined });
    };
    const to = setTimeout(() => { J.timeout = true; p.kill('SIGKILL'); fin(null); }, 600000);
    p.on('error', (e) => fin(null, e.code === 'ENOENT' ? 'ssh ist auf dem HomeLite-Rechner nicht installiert' : e.message));
    p.on('close', (code) => fin(code));
    p.stdin.on('error', () => {});
    p.stdin.end(script);
  }

  api.route('POST', 'term/run', ({ body }) => {
    if (api.config().terminal === false) throw new Error('Das Terminal ist in den Plugin-Einstellungen ausgeschaltet');
    const b = body || {};
    const h = find(b.host);
    if (!h) throw new Error('Host nicht eingetragen');
    const cmd = String(b.cmd || '');
    if (!cmd.trim() || cmd.length > 8000) throw new Error('Befehl leer oder zu lang');
    if (!/^[\w-]{4,40}$/.test(String(b.job || ''))) throw new Error('Ungültige Kennung');
    if (jobs.size >= 6) throw new Error('Zu viele laufende Befehle');
    const cwd = String(b.cwd || '').slice(0, 1000);
    if (/[\n\0]/.test(cwd)) throw new Error('Ungültiges Verzeichnis');
    startJob(h, cmd, cwd, String(b.job));
    return { ok: true };
  });
  api.route('POST', 'term/cancel', ({ body }) => {
    const J = jobs.get(String((body || {}).job || ''));
    if (J) { J.killed = true; try { J.p.kill('SIGKILL'); } catch { /* beendet */ } }
    return { ok: true };
  });

  api.route('POST', 'test/:name', async ({ params }) => {
    const h = find(params.name);
    if (!h) throw new Error('Host nicht eingetragen');
    return run(h, 'echo HomeLite-SSH-ok', 15, 'Test');
  });
  api.route('POST', 'mcp-token', () => { api.mcp.endpoint(true); const st = status(); api.emit({ status: st }); return st; });
  api.onConfig(() => api.emit({ status: status() }));

  return ensureKey().then(() => { api.log('info', pub ? 'Bereit – öffentlicher Schlüssel auf der Seite „SSH“' : 'Kein Schlüssel'); return {}; });
};
