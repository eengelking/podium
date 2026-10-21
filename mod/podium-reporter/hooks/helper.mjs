// The reporter's TLS helper (#584, SPEC 5.9). The mod cannot hand $.http.fetch a CA or a client certificate, so
// podium-reporter starts this script once per session. It reads the reporter config file, makes the HTTPS connection
// with the CA and the person's certificate, and listens on a Unix socket the mod sends its requests to.
//
//   node helper.mjs <config path> <socket path> <server url>
//
// It prints `ready` on stdout once it listens, and `error <CODE> <why>` before exiting 1 when it cannot start.
import { X509Certificate, createPublicKey, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PARENT_POLL_MS = 1000;
const UPSTREAM_TIMEOUT_MS = 30_000;
/** Request headers that describe the hop to the helper, not the request itself. */
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

const DAY_MS = 86_400_000;
/** Renew when this much of the certificate is left (SPEC 6: 30 days of a 90-day certificate). The env var is for tests. */
const RENEW_BEFORE_OVERRIDDEN = Number(process.env.PODIUM_RENEW_BEFORE_SECONDS) > 0;
const RENEW_BEFORE_MS = RENEW_BEFORE_OVERRIDDEN ? Number(process.env.PODIUM_RENEW_BEFORE_SECONDS) * 1000 : 30 * DAY_MS;
const RENEW_CHECK_MS = Number(process.env.PODIUM_RENEW_CHECK_SECONDS) > 0 ? Number(process.env.PODIUM_RENEW_CHECK_SECONDS) * 1000 : 10 * 60_000;
/** After a renewal fails for a reason that may pass (the server is down), wait this long before asking again. */
const RENEW_RETRY_MS = 60_000;
/** A request that finds its certificate expired waits this long for the renewal under way. */
const RENEW_WAIT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 15_000;

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
  return { ca, cert, key, user, notAfter: Date.parse(new X509Certificate(cert).validTo), notBefore: Date.parse(new X509Certificate(cert).validFrom) };
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

const pem = (t) => (t.endsWith('\n') ? t : `${t}\n`);

/**
 * The config file after a renewal: the header lines (the name and the server stay) with the issued-at, expires and
 * fingerprint lines updated, then the CA certificate(s), the new certificate and the new key. The body is replaced whole, so
 * the file never holds a certificate from one renewal and a key from another.
 */
export function rewriteConfig(text, n) {
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((l) => l.startsWith('-----BEGIN'));
  const head = (end === -1 ? lines : lines.slice(0, end)).filter((l) => l.trim() !== '');
  const set = (name, value) => {
    const i = head.findIndex((l) => new RegExp(`^#\\s*${name}:`).test(l));
    if (i === -1) head.push(`# ${name}: ${value}`);
    else head[i] = `# ${name}: ${value}`;
  };
  set('issued-at', `${new Date(n.now).toISOString()} ${Math.floor(n.now / 1000)}`);
  set('expires', n.notAfter);
  set('fingerprint', n.fingerprint);
  return `${head.join('\n')}\n${n.ca.map(pem).join('')}${pem(n.cert)}${pem(n.key)}`;
}

/** Writes `text` to `file` through a temporary file in the same folder and a rename, at mode 0600, so a reader sees all of the old file or all of the new. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` while holding `<file>.lock`, a file made with O_EXCL. A lock older than a minute belongs to a process that died and is taken over. Returns null when the lock could not be had in time. */
async function withLock(lockFile, fn) {
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) fs.rmSync(lockFile, { force: true });
      } catch {
        // gone already
      }
      if (Date.now() > until) return null;
      await sleep(50 + Math.random() * 50);
    }
  }
  try {
    return { value: await fn() };
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

/** POSTs JSON to the server over the agent, which holds the person's certificate. Resolves to `{ status, json }`. */
function postJson(agent, target, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { agent, host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 443, method: 'POST', path: pathname, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, servername: /^[\d.]+$|:/.test(target.hostname) ? undefined : target.hostname, rejectUnauthorized: true, timeout: timeoutMs },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: {} });
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('upstream timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(data);
  });
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
      refused = null;
      retryAt = 0;
      // Requests already on the old agent finish on it (they outlast neither the upstream timeout nor this delay).
      const old = agent;
      setTimeout(() => old.destroy(), UPSTREAM_TIMEOUT_MS + 5000).unref();
      agent = agentFor(cfg);
    } catch {
      // keep the last good copy
      cfg = { ...cfg, mtimeMs: st.mtimeMs };
    }
  };

  // ---- renewing this person's certificate (#585) -------------------------------------------------------------------
  /** Why the server refused to renew, or null. Kept until the file is replaced, so a refused renewal is not asked again on every request. */
  let refused = null;
  let retryAt = 0;
  let renewing = null;

  const useConfig = (next, st) => {
    cfg = { ...next, mtimeMs: st.mtimeMs };
    const old = agent;
    setTimeout(() => old.destroy(), UPSTREAM_TIMEOUT_MS + 5000).unref();
    agent = agentFor(cfg);
  };
  // Never ask earlier than half the certificate's life: a short-lived certificate (the Admin can set 30 days) would otherwise be due the moment it is issued, and renew on every check.
  const dueSoon = () => cfg.notAfter - Date.now() <= (RENEW_BEFORE_OVERRIDDEN ? RENEW_BEFORE_MS : Math.min(RENEW_BEFORE_MS, (cfg.notAfter - cfg.notBefore) / 2));
  const expired = () => cfg.notAfter <= Date.now();

  /** One renewal, under the lock. Returns once the file holds a usable certificate or the attempt failed. */
  const renewOnce = async () => {
    const got = await withLock(`${configPath}.lock`, async () => {
      // Another session may have renewed while this one waited for the lock: take its certificate instead of making a third.
      try {
        const disk = readConfig(configPath);
        if (disk.user === cfg.user && disk.cert !== cfg.cert) {
          useConfig(disk, fs.statSync(configPath));
          if (!dueSoon()) return;
        }
      } catch {
        // the file we hold is the last good one
      }
      const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const spki = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const answer = await postJson(agent, target, '/api/reporter/renew', { publicKey: spki }, UPSTREAM_TIMEOUT_MS);
      if (answer.status === 401 && answer.json?.code) {
        refused = { code: answer.json.code === 'PAST_GRACE' ? 'CERT_PAST_GRACE' : 'CERT_RENEWAL_REFUSED', message: String(answer.json.error ?? answer.json.code) };
        return;
      }
      if (answer.status !== 200 || typeof answer.json?.cert !== 'string') throw new Error(`the server answered ${answer.status}`);
      // Never write what does not check out: the certificate must be for our key and signed by a CA this file already holds.
      const x = new X509Certificate(answer.json.cert);
      if (!x.publicKey.equals(publicKey) || x.ca) throw new Error('the renewed certificate is not for the new key');
      if (!cfg.ca.some((c) => x.verify(new X509Certificate(c).publicKey))) throw new Error('the renewed certificate is not signed by the CA in the file');
      const text = rewriteConfig(fs.readFileSync(configPath, 'utf8'), {
        ca: cfg.ca,
        cert: answer.json.cert,
        key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        notAfter: new Date(x.validTo).toISOString(),
        fingerprint: x.fingerprint256,
        now: Date.now(),
      });
      writeAtomic(configPath, text);
      useConfig(readConfig(configPath), fs.statSync(configPath));
    });
    if (got === null) throw new Error('another session held the renewal lock too long');
  };

  /** Starts a renewal if the certificate is due and none is under way; resolves when it ends. Never rejects. */
  const maybeRenew = () => {
    if (renewing) return renewing;
    if (refused || Date.now() < retryAt || !dueSoon()) return Promise.resolve();
    renewing = renewOnce()
      .catch((err) => {
        retryAt = Date.now() + RENEW_RETRY_MS;
        process.stderr.write(`renewal failed: ${err?.message ?? err}\n`);
      })
      .finally(() => {
        renewing = null;
      });
    return renewing;
  };

  const server = http.createServer(async (req, res) => {
    refresh();
    if (dueSoon()) {
      const renewal = maybeRenew();
      // An expired certificate cannot be used for the request, so wait for the renewal; one that is only due goes on as it is.
      if (expired()) {
        await Promise.race([renewal, sleep(RENEW_WAIT_MS)]);
        refresh();
      }
    }
    if (expired() && refused) {
      res.writeHead(502, { 'content-type': 'application/json', 'x-podium-helper-error': refused.code });
      res.end(JSON.stringify({ error: refused.code, message: refused.message }));
      return;
    }
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

  // A session that is idle still renews in time: look at the certificate now and then, and once at start.
  setInterval(() => void maybeRenew(), RENEW_CHECK_MS).unref();
  void maybeRenew();

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
