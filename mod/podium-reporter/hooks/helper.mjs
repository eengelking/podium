// The reporter's TLS helper (#584, SPEC 5.9). The mod cannot hand $.http.fetch a CA or a client certificate, so
// podium-reporter starts this script once per session. It reads the reporter config file, makes the HTTPS connection
// with the CA and the person's certificate, and listens on a Unix socket the mod sends its requests to.
//
//   node helper.mjs <config path> <socket path> <server url>
//
// It prints `ready` on stdout once it listens, and `error <CODE> <why>` before exiting 1 when it cannot start.
import { X509Certificate, generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
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
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 15_000;

/**
 * The calls the mod makes through this helper, and the only ones it forwards (#668). `:id` stands for one path segment. A copy of
 * REPORTER_ROUTE_TEMPLATES in the server's tlsHttp.ts, which reporterHelper.test.ts compares with this list: it fails if they differ.
 */
export const REPORTER_ROUTES = [
  ['POST', '/api/fleet/report'],
  ['POST', '/api/fleet/hook'],
  ['GET', '/api/fleet/sessions/:id/peers'],
  ['POST', '/api/fleet/sessions/:id/peers/messages'],
  ['POST', '/api/fleet/sessions/:id/peers/access'],
  ['POST', '/api/fleet/sessions/:id/peers/requests/:id'],
  ['POST', '/api/fleet/sessions/:id/peers/deliveries/:id/result'],
  ['PUT', '/api/fleet/sessions/:id/diffs/:id'],
  ['PUT', '/api/fleet/sessions/:id/asks/:id'],
  ['GET', '/api/fleet/sessions/:id/asks/:id/answer'],
  ['POST', '/api/fleet/sessions/:id/recording'],
  ['POST', '/api/fleet/sessions/:id/asks/:id/close'],
  ['POST', '/api/fleet/sessions/:id/deliveries/:id/result'],
];

/** An id in a path: what `encodeURIComponent` leaves or escapes. It has no slash, no blank, no `?`, `#` or backslash. */
const ID_SEGMENT = /^[A-Za-z0-9._~%!'()*-]+$/;
/** A query: names and values `encodeURIComponent` would write, joined by `=` and `&`. */
const QUERY = /^[A-Za-z0-9=&._~%!'()*-]*$/;

/** Whether an id could climb out of its place in the path: `.` or `..` however they are escaped, or an escaped slash. */
function badId(seg) {
  if (!ID_SEGMENT.test(seg) || /%(2f|5c)/i.test(seg)) return true;
  try {
    const plain = decodeURIComponent(seg);
    return plain === '.' || plain === '..';
  } catch {
    return true;
  }
}

/**
 * The request to make upstream for a request this helper was handed, or null when it is not one of the reporter routes. Nothing the
 * client wrote is passed on as it came: the method and the fixed parts of the path come from the matching route, only the ids and a
 * plain query are the client's, and an id that could change the path is refused. So the helper cannot be made to ask the server for
 * anything but a reporter call, and the host is always the one in the config file.
 */
export function reporterTarget(method, url) {
  if (typeof method !== 'string' || typeof url !== 'string' || !url.startsWith('/')) return null;
  const q = url.indexOf('?');
  const query = q < 0 ? '' : url.slice(q + 1);
  if (!QUERY.test(query)) return null;
  let end = q < 0 ? url.length : q;
  while (end > 1 && url.charCodeAt(end - 1) === 47) end--;
  const have = url.slice(1, end).split('/');
  for (const [m, template] of REPORTER_ROUTES) {
    if (m !== method) continue;
    const want = template.slice(1).split('/');
    if (want.length !== have.length) continue;
    const out = [];
    for (let i = 0; i < want.length; i++) {
      if (want[i] === ':id') {
        if (badId(have[i])) break;
        out.push(have[i]);
      } else if (want[i] === have[i].toLowerCase()) {
        out.push(want[i]);
      } else {
        break;
      }
      if (i === want.length - 1) return { method: m, path: `/${out.join('/')}${q < 0 ? '' : `?${query}`}` };
    }
  }
  return null;
}

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

/** The name in the file's `# user: Name` line, or ''. Read line by line, not with one multiline regex that could backtrack over a long run of blanks. */
export function headerUser(text) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('#')) continue;
    const rest = line.slice(1).trimStart();
    if (!rest.startsWith('user:')) continue;
    const name = rest.slice(5).trim();
    if (name) return name;
  }
  return '';
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
  const user = headerUser(text);
  return { ca, cert, key, user, notAfter: Date.parse(new X509Certificate(cert).validTo), notBefore: Date.parse(new X509Certificate(cert).validFrom) };
}

/**
 * Reads the file, refusing one that group or others can read (the key is in it, as `ssh` does with a private key). The mode is
 * read from the open file, not from its path, so the file checked is the file read.
 */
function readConfig(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    throw new StartError('CONFIG_MISSING', `cannot read ${file}: ${err.code ?? err.message}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      throw new StartError('CONFIG_PERMISSIONS', `${file} is readable by others (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file}`);
    }
    let text;
    try {
      text = fs.readFileSync(fd, 'utf8');
    } catch (err) {
      throw new StartError('CONFIG_MISSING', `cannot read ${file}: ${err.code ?? err.message}`);
    }
    return { ...parseConfig(text), mtimeMs: st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
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

/**
 * A planned CA rotation's new CA (#588): `{ ca, cross }`, the new CA and a certificate for it signed by a CA this file already
 * holds. Returns the new CA's PEM and whether the file holds it, or throws. The cross certificate is checked and dropped, never
 * stored, because parseConfig would read it as one more trust anchor. A held CA is never replaced or removed.
 */
function acceptRotation(rotation, held) {
  if (typeof rotation?.ca !== 'string' || typeof rotation?.cross !== 'string') throw new Error('the rotation is missing the new CA or the cross certificate');
  let ca;
  let cross;
  try {
    ca = new X509Certificate(rotation.ca);
    cross = new X509Certificate(rotation.cross);
  } catch {
    throw new Error('the rotation holds a certificate that cannot be read');
  }
  const now = Date.now();
  if (!ca.ca || !cross.ca) throw new Error('the rotation is not made of CA certificates');
  if (!held.some((c) => cross.verify(new X509Certificate(c).publicKey))) throw new Error('the cross certificate is not signed by a CA in the file');
  if (!ca.publicKey.equals(cross.publicKey) || ca.subject !== cross.subject) throw new Error('the cross certificate is not for the new CA');
  for (const c of [ca, cross]) if (Date.parse(c.validFrom) > now || Date.parse(c.validTo) <= now) throw new Error('a certificate in the rotation is not valid now');
  return { pem: rotation.ca, held: held.some((c) => new X509Certificate(c).fingerprint256 === ca.fingerprint256) };
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

/** True when `file` exists and was last written more than `ms` ago. */
function olderThan(file, ms) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > ms;
  } catch {
    return false;
  }
}

/** The generations of a lock, `<lock>.<n>`, lowest first: `[{ gen, file }]`. */
function generations(lockFile) {
  const dir = path.dirname(lockFile);
  const prefix = `${path.basename(lockFile)}.`;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // no folder, no lock
  }
  return names
    .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .map((n) => ({ gen: Number(n.slice(prefix.length)), file: path.join(dir, n) }))
    .sort((x, y) => x.gen - y.gen);
}

/** The lock scheme this helper speaks. 1 was the plain `<lock>` file of the first renewal code; 2 adds the numbered files. */
export const LOCK_SCHEME = 2;

/**
 * Records the scheme in `<lock>.scheme` and refuses a lock that a newer helper has written a higher number to, because this
 * helper would not know how to exclude it. A missing, older or unreadable marker is raised to this helper's scheme.
 */
function checkScheme(lockFile) {
  const marker = `${lockFile}.scheme`;
  let seen = Number.NaN;
  try {
    seen = Number.parseInt(fs.readFileSync(marker, 'utf8'), 10);
  } catch {
    // no marker yet
  }
  if (seen > LOCK_SCHEME) {
    throw Object.assign(new Error(`${marker} says lock scheme ${seen}, newer than the ${LOCK_SCHEME} this helper knows; update podium-reporter`), { code: 'LOCK_SCHEME' });
  }
  if (seen !== LOCK_SCHEME) writeAtomic(marker, `${LOCK_SCHEME}\n`);
}

/**
 * Runs `fn` while holding the lock `<lockFile>`. It is two locks, taken in this order.
 *
 * First a numbered file, `<lockFile>.<n>`, made with O_EXCL and naming its owner. The lock is held by the highest number and is
 * free when there is none or the highest is older than `staleMs` (its owner died, or it let go: letting go ages the file instead of
 * removing it). To take it, a waiter creates the next number. Of several waiters that want the same number exactly one creates
 * it and the rest see it exist, so taking a stale lock needs no removal that two waiters could race on, and a waiter never removes
 * a lock another has just made. A number is never used twice, so a waiter working from an old reading cannot be handed a number
 * that has since been held and released. Numbers below the one taken are leftovers and are removed.
 *
 * Then, while holding that, the plain file `<lockFile>` itself, with O_EXCL, which is what the first renewal code (lock scheme 1)
 * took. Taking it keeps a session on that older code out while this one works, and waits for one that holds it. Only the holder of
 * the numbered lock ever removes a stale plain lock, so this helper's sessions do not race on it; the one race left is with an
 * older helper clearing the same stale file, which only that older code can close.
 *
 * While `fn` runs both files' times are refreshed every third of `staleMs`, so a live holder is not taken over however long it
 * takes. Returns null when the lock could not be had in `waitMs`, and throws (code LOCK_SCHEME) for a scheme this helper does not know.
 */
export async function withLock(lockFile, fn, waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS) {
  checkScheme(lockFile);
  const until = Date.now() + waitMs;
  const owner = `${process.pid}:${randomBytes(8).toString('hex')}`;
  let mine = null;
  for (;;) {
    const all = generations(lockFile);
    const top = all.at(-1);
    if (!top || olderThan(top.file, staleMs)) {
      const file = `${lockFile}.${(top?.gen ?? 0) + 1}`;
      try {
        const fd = fs.openSync(file, 'wx', 0o600);
        fs.writeSync(fd, owner);
        fs.closeSync(fd);
        mine = file;
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        continue; // another waiter took this number: look again
      }
    }
    if (Date.now() > until) return null;
    await sleep(randomInt(50, 100));
  }
  for (const g of generations(lockFile)) {
    if (g.file === mine || g.gen > Number(mine.slice(mine.lastIndexOf('.') + 1))) continue;
    try {
      fs.rmSync(g.file, { force: true });
    } catch {
      // a leftover we cannot remove is stale; the next taker tries again
    }
  }
  const ours = (file) => {
    try {
      return fs.readFileSync(file, 'utf8') === owner;
    } catch {
      return false;
    }
  };
  const held = [mine];
  const beat = setInterval(() => {
    for (const f of held) {
      try {
        if (ours(f)) fs.utimesSync(f, new Date(), new Date());
      } catch {
        // gone: nothing of ours to keep fresh
      }
    }
  }, Math.max(10, staleMs / 3));
  const letGo = () => {
    clearInterval(beat);
    try {
      if (ours(mine)) fs.utimesSync(mine, new Date(0), new Date(0));
    } catch {
      // gone already
    }
    try {
      if (held.includes(lockFile) && ours(lockFile)) fs.rmSync(lockFile, { force: true });
    } catch {
      // gone already; a plain lock we cannot remove goes stale
    }
  };
  try {
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, 'wx', 0o600);
        fs.writeSync(fd, owner);
        fs.closeSync(fd);
        held.push(lockFile);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Ours alone to clear: no other session of this kind holds the numbered lock.
        if (olderThan(lockFile, staleMs)) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
        if (Date.now() > until) return null; // the finally lets go of the numbered lock
        await sleep(randomInt(50, 100));
      }
    }
    return { value: await fn() };
  } finally {
    letGo();
  }
}

/** How long to wait after a 429, from its Retry-After header in seconds: never less than the usual retry, never more than a day. */
export function retryDelayMs(header, usual = RENEW_RETRY_MS) {
  const secs = Number(Array.isArray(header) ? header[0] : header);
  return Number.isFinite(secs) && secs > 0 ? Math.min(Math.max(secs * 1000, usual), DAY_MS) : usual;
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
            resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {}, retryAfter: res.headers['retry-after'] });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: {}, retryAfter: res.headers['retry-after'] });
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
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new StartError('SOCKET_DIR', `${dir} is not a folder`);
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
        refused = { code: 'CERT_RENEWAL_REFUSED', message: String(answer.json.error ?? answer.json.code) };
        return;
      }
      if (answer.status === 429) {
        // Renewed less than an hour ago (by another session, most likely). Not a refusal: wait as long as the server says.
        retryAt = Date.now() + retryDelayMs(answer.retryAfter);
        return;
      }
      if (answer.status !== 200 || typeof answer.json?.cert !== 'string') throw new Error(`the server answered ${answer.status}`);
      // Never write what does not check out: the certificate must be for our key and signed by a CA this file already holds,
      // or, during a planned rotation (#588), by the new CA the response vouches for.
      const x = new X509Certificate(answer.json.cert);
      if (!x.publicKey.equals(publicKey) || x.ca) throw new Error('the renewed certificate is not for the new key');
      const added = answer.json.rotation === undefined ? null : acceptRotation(answer.json.rotation, cfg.ca);
      const holders = added ? [...cfg.ca, added.pem] : cfg.ca;
      if (!holders.some((c) => x.verify(new X509Certificate(c).publicKey))) throw new Error('the renewed certificate is not signed by the CA in the file');
      const text = rewriteConfig(fs.readFileSync(configPath, 'utf8'), {
        ca: added && !added.held ? [...cfg.ca, added.pem] : cfg.ca,
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
    // An expired certificate is never renewed (#665): the server's reporter port drops it at the handshake, so there is nobody to ask.
    if (refused || expired() || Date.now() < retryAt || !dueSoon()) return Promise.resolve();
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
    const route = reporterTarget(req.method, req.url);
    if (!route) {
      req.resume();
      res.writeHead(403, { 'content-type': 'application/json', 'x-podium-helper-error': 'ROUTE_NOT_ALLOWED' });
      res.end(JSON.stringify({ error: 'ROUTE_NOT_ALLOWED', message: 'The Podium connection helper forwards the reporter calls only.' }));
      return;
    }
    refresh();
    // The date is compared with this machine's clock before connecting, so the person is told it expired and nothing goes upstream (#665).
    if (expired()) {
      const on = new Date(cfg.notAfter).toISOString().slice(0, 10);
      res.writeHead(502, { 'content-type': 'application/json', 'x-podium-helper-error': 'CERT_EXPIRED' });
      res.end(JSON.stringify({ error: 'CERT_EXPIRED', message: `Your Podium certificate expired on ${on}. Ask an Admin to generate a new reporter config.` }));
      return;
    }
    if (dueSoon()) void maybeRenew();
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k) && v !== undefined) headers[k] = v;
    const up = https.request(
      { agent, host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 443, method: route.method, path: route.path, headers, servername: /^[\d.]+$|:/.test(target.hostname) ? undefined : target.hostname, rejectUnauthorized: true, timeout: UPSTREAM_TIMEOUT_MS },
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
