// The reporter's TLS helper (#584, SPEC 5.9). The mod cannot hand $.http.fetch a CA or a client certificate, so
// podium-reporter starts this script once per session. It reads the reporter config file, makes the HTTPS connection
// with the CA and the person's certificate, and listens on a Unix socket the mod sends its requests to.
//
//   node helper.mjs <config path> <socket path> <server url>
//
// It prints `ready` on stdout once it listens, and `error <CODE> <why>` before exiting 1 when it cannot start.
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PARENT_POLL_MS = 1000;
const UPSTREAM_TIMEOUT_MS = 30_000;
/** Request headers that describe the hop to the helper, not the request itself. */
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

const CLIENT_REJECTED = /^ERR_SSL_.*(ALERT|CERTIFICATE_REQUIRED)/;
const OTHER_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

/** A short name for what went wrong upstream, for the `X-Podium-Helper-Error` header. */
export function classifyError(err) {
  const code = err?.code ?? '';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'ALTNAME';
  if (CLIENT_REJECTED.test(code)) return 'CLIENT_CERT_REJECTED';
  if (/^[A-Z0-9_]+$/.test(code) && (code.startsWith('CERT_') || code.includes('SELF_SIGNED') || code.startsWith('UNABLE_TO_') || OTHER_CODES.has(code))) return code;
  return 'UPSTREAM_ERROR';
}

class StartError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The CA certificates, the person's certificate and the key, by block type and role, never by position. */
export function parseConfig(text) {
  const blocks = [...text.matchAll(/-----BEGIN ([A-Z ]+)-----[\s\S]*?-----END \1-----/g)];
  const ca = [];
  let cert = null;
  let key = null;
  for (const m of blocks) {
    const [pem, type] = [m[0], m[1]];
    if (type === 'CERTIFICATE') {
      let x;
      try {
        x = new X509Certificate(pem);
      } catch {
        throw new StartError('CONFIG_INVALID', 'a certificate block in the config file cannot be read');
      }
      if (x.ca) ca.push(pem);
      else if (cert) throw new StartError('CONFIG_INVALID', 'the config file holds more than one person certificate');
      else cert = pem;
    } else if (type.endsWith('PRIVATE KEY')) {
      if (key) throw new StartError('CONFIG_INVALID', 'the config file holds more than one private key');
      key = pem;
    }
  }
  if (ca.length === 0) throw new StartError('CONFIG_INVALID', 'the config file has no CA certificate');
  if (!cert) throw new StartError('CONFIG_INVALID', 'the config file has no person certificate');
  if (!key) throw new StartError('CONFIG_INVALID', 'the config file has no private key');
  const user = /^#\s*user:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  return { ca, cert, key, user };
}

/** Reads the file, refusing one that group or others can read (the key is in it, as `ssh` does with a private key). */
function readConfig(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (err) {
    throw new StartError('CONFIG_MISSING', `cannot read ${file}: ${err.code ?? err.message}`);
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new StartError('CONFIG_PERMISSIONS', `${file} is readable by others (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file}`);
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new StartError('CONFIG_MISSING', `cannot read ${file}: ${err.code ?? err.message}`);
  }
  return { ...parseConfig(text), mtimeMs: st.mtimeMs };
}

/** One keep-alive agent per config; verification is forced on, whatever the environment says. */
function agentFor(cfg) {
  return new https.Agent({ ca: cfg.ca, cert: cfg.cert, key: cfg.key, rejectUnauthorized: true, keepAlive: true });
}

function fail(code, message) {
  process.stdout.write(`error ${code} ${message}\n`);
  process.exit(1);
}

/** Makes a directory only this user can enter; refuses one that is someone else's or open to others. */
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new StartError('SOCKET_DIR', `${dir} belongs to another user`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

function main(configPath, socketPath, serverUrl) {
  // An inherited NODE_TLS_REJECT_UNAUTHORIZED=0 turned verification off in the spike; nothing here reads it, and it is gone.
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.NODE_OPTIONS;
  let target;
  try {
    target = new URL(serverUrl);
  } catch {
    return fail('INSECURE_URL', `${serverUrl} is not a URL`);
  }
  if (target.protocol !== 'https:') return fail('INSECURE_URL', `${serverUrl} is not https; the helper never sends a credential over http`);
  let cfg;
  try {
    cfg = readConfig(configPath);
  } catch (err) {
    return fail(err.code ?? 'CONFIG_INVALID', err.message);
  }
  let agent = agentFor(cfg);

  /** Before a request opens a new upstream connection: a rewrite of the same file is taken only for the same person. */
  const refresh = () => {
    let st;
    try {
      st = fs.statSync(configPath);
    } catch {
      return;
    }
    if (st.mtimeMs === cfg.mtimeMs) return;
    try {
      const next = readConfig(configPath);
      if (next.user !== cfg.user) {
        // Another person's file is not ours; remember it was looked at so it is not read again on every request.
        cfg = { ...cfg, mtimeMs: st.mtimeMs };
        return;
      }
      cfg = next;
      // Requests already on the old agent finish on it (they outlast neither the upstream timeout nor this delay).
      const old = agent;
      setTimeout(() => old.destroy(), UPSTREAM_TIMEOUT_MS + 5000).unref();
      agent = agentFor(cfg);
    } catch {
      // keep the last good copy
      cfg = { ...cfg, mtimeMs: st.mtimeMs };
    }
  };

  const server = http.createServer((req, res) => {
    refresh();
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k) && v !== undefined) headers[k] = v;
    const up = https.request(
      { agent, host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 443, method: req.method, path: req.url, headers, servername: /^[\d.]+$|:/.test(target.hostname) ? undefined : target.hostname, rejectUnauthorized: true, timeout: UPSTREAM_TIMEOUT_MS },
      (upRes) => {
        const out = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_HEADERS.has(k) && v !== undefined) out[k] = v;
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.on('error', () => res.destroy());
        upRes.on('aborted', () => res.destroy());
        upRes.pipe(res);
      },
    );
    // TLS 1.3 finishes the handshake on the client before the server has judged the client certificate, so a rejection
    // can look like the connection closing on a fresh connection that got no answer. A restart looks the same, so it
    // gets its own name and the mod words it as a maybe.
    let handshook = false;
    up.on('socket', (s) => {
      if (up.reusedSocket) return;
      s.once('secureConnect', () => (handshook = true));
    });
    up.on('timeout', () => up.destroy(Object.assign(new Error('upstream timed out'), { code: 'ETIMEDOUT' })));
    up.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      let code = classifyError(err);
      if (code === 'ECONNRESET' && handshook && !up.reusedSocket) code = 'CLOSED_AFTER_HANDSHAKE';
      res.writeHead(502, { 'content-type': 'application/json', 'x-podium-helper-error': code });
      res.end(JSON.stringify({ error: code, message: String(err.message ?? err) }));
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  });

  try {
    privateDir(path.dirname(socketPath));
    if (fs.existsSync(socketPath) && fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath);
  } catch (err) {
    return fail(err.code ?? 'SOCKET_DIR', err.message);
  }

  let owned = false;
  const cleanup = () => {
    if (!owned) return;
    owned = false;
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // already gone
    }
  };
  const stop = () => {
    cleanup();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', stop);
  process.on('exit', cleanup);

  server.on('error', (err) => fail(err.code ?? 'LISTEN', `cannot listen on ${socketPath}: ${err.message}`));
  const umask = process.umask(0o177);
  server.listen(socketPath, () => {
    process.umask(umask);
    owned = true;
    fs.chmodSync(socketPath, 0o600);
    process.stdout.write('ready\n');
  });

  // The child of a mod that was killed outright (SIGKILL) gets no signal: watch the parent instead.
  const parent = process.ppid;
  setInterval(() => {
    let gone = process.ppid !== parent;
    if (!gone) {
      try {
        process.kill(parent, 0);
      } catch (err) {
        gone = err.code === 'ESRCH';
      }
    }
    if (gone) stop();
  }, PARENT_POLL_MS).unref?.();
  // unref'd timers do not keep the process alive; the listening server does.
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [configPath, socketPath, serverUrl] = process.argv.slice(2);
  if (!configPath || !socketPath || !serverUrl) fail('USAGE', 'usage: node helper.mjs <config path> <socket path> <server url>');
  else main(configPath, socketPath, serverUrl);
}
