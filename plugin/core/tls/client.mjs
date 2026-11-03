// The reporter's mTLS client (#584, #948, SPEC 5.9): everything about making the connection to a Podium server with the CA and the
// person's certificate from the reporter config file, and nothing about how a caller reaches it. The Claude helper (helper.mjs) is a
// thin shell around it that answers a Unix socket or a mailbox; the OpenCode reporter imports it in its own process. One copy, shared
// by every reporter (#927).
//
// What it does: reads the config file; makes one keep-alive https agent from it; takes up a rewrite of that file by another session
// (for the same person); renews the certificate before it expires, under a lock two sessions share; forwards only the reporter routes;
// refuses a request when the certificate has expired; and names what went wrong upstream.
//
// What it does not do: touch `process` (no exit, no signals, no environment changes) or print. A caller gets a `log` hook.
import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import { rewriteConfig, writeAtomic } from './atomic.mjs';
import { StartError, agentFor, readConfig } from './config.mjs';
import { DAY_MS, RENEW_RETRY_MS, classifyError, retryDelayMs } from './errors.mjs';
import { withLock } from './lock.mjs';
import { acceptRotation } from './rotation.mjs';
import { reporterTarget } from './routes.mjs';

export const UPSTREAM_TIMEOUT_MS = 30_000;
/** Request headers that describe the hop to the client, not the request itself. */
export const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

const ROUTE_REFUSAL = { status: 403, code: 'ROUTE_NOT_ALLOWED', message: 'The Podium connection helper forwards the reporter calls only.' };

/** An Error with a short `code`, the one the helper puts in `x-podium-helper-error`. */
const coded = (code, message) => Object.assign(new Error(message), { code });

/** The https options to reach `target`: a bracketed IPv6 host loses its brackets, and an address has no server name. */
const where = (target) => ({ host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 443, servername: /^[\d.]+$|:/.test(target.hostname) ? undefined : target.hostname });

/** POSTs JSON to the server over the agent, which holds the person's certificate. Resolves to `{ status, json, retryAfter }`. */
function postJson(agent, target, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { agent, ...where(target), method: 'POST', path: pathname, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, rejectUnauthorized: true, timeout: timeoutMs },
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

/**
 * Makes the client for one config file and one server. Throws a StartError (INSECURE_URL, or the CONFIG_* codes of readConfig).
 * `log(line)` hears what a caller may want to show (a failed renewal); `env` supplies PODIUM_RENEW_BEFORE_SECONDS and
 * PODIUM_RENEW_CHECK_SECONDS, which tests use to make a renewal due.
 */
export function createTlsClient({ configPath, serverUrl, log = () => {}, env = process.env }) {
  let target;
  try {
    target = new URL(serverUrl);
  } catch {
    throw new StartError('INSECURE_URL', `${serverUrl} is not a URL`);
  }
  if (target.protocol !== 'https:') throw new StartError('INSECURE_URL', `${serverUrl} is not https; the helper never sends a credential over http`);
  let cfg = readConfig(configPath);
  let agent = agentFor(cfg);

  /** Renew when this much of the certificate is left (SPEC 6: 30 days of a 90-day certificate). The env var is for tests. */
  const renewBeforeOverridden = Number(env.PODIUM_RENEW_BEFORE_SECONDS) > 0;
  const renewBeforeMs = renewBeforeOverridden ? Number(env.PODIUM_RENEW_BEFORE_SECONDS) * 1000 : 30 * DAY_MS;
  const renewCheckMs = Number(env.PODIUM_RENEW_CHECK_SECONDS) > 0 ? Number(env.PODIUM_RENEW_CHECK_SECONDS) * 1000 : 10 * 60_000;

  /** Why the server refused to renew, or null. Kept until the file is replaced, so a refused renewal is not asked again on every request. */
  let refused = null;
  let retryAt = 0;
  let renewing = null;
  let timer = null;

  /** Takes up `next` and retires the agent that held the old certificate. */
  const swapAgent = () => {
    // Requests already on the old agent finish on it (they outlast neither the upstream timeout nor this delay).
    const old = agent;
    setTimeout(() => old.destroy(), UPSTREAM_TIMEOUT_MS + 5000).unref();
    agent = agentFor(cfg);
  };

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
      swapAgent();
    } catch {
      // keep the last good copy
      cfg = { ...cfg, mtimeMs: st.mtimeMs };
    }
  };

  // ---- renewing this person's certificate (#585) -------------------------------------------------------------------
  const useConfig = (next, st) => {
    cfg = { ...next, mtimeMs: st.mtimeMs };
    swapAgent();
  };
  // Never ask earlier than half the certificate's life: a short-lived certificate (the Admin can set 30 days) would otherwise be due the moment it is issued, and renew on every check.
  const dueSoon = () => cfg.notAfter - Date.now() <= (renewBeforeOverridden ? renewBeforeMs : Math.min(renewBeforeMs, (cfg.notAfter - cfg.notBefore) / 2));
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
        log(`renewal failed: ${err?.message ?? err}`);
      })
      .finally(() => {
        renewing = null;
      });
    return renewing;
  };

  /**
   * What to do with a request before it goes upstream: the route to forward it to, or the refusal to answer with. Also takes up a rewritten
   * config file, and starts a renewal (never awaited) when the certificate is due.
   */
  function guard(method, url) {
    const route = reporterTarget(method, url);
    if (!route) return { refusal: ROUTE_REFUSAL };
    refresh();
    // The date is compared with this machine's clock before connecting, so the person is told it expired and nothing goes upstream (#665).
    if (expired()) {
      const on = new Date(cfg.notAfter).toISOString().slice(0, 10);
      return { refusal: { status: 502, code: 'CERT_EXPIRED', message: `Your Podium certificate expired on ${on}. Ask an Admin to generate a new reporter config.` } };
    }
    if (dueSoon()) void maybeRenew();
    return { route };
  }

  /**
   * The upstream request for a route `guard` returned. Returns the ClientRequest: the caller writes the body into it (`end(body)` or a pipe).
   * `onResponse(upRes)` hears the reply; `onError({ code, message, err })` hears a failure, `code` being what goes in `x-podium-helper-error`.
   */
  function open(route, headers, { onResponse, onError }) {
    const out = {};
    for (const [k, v] of Object.entries(headers ?? {})) if (!HOP_HEADERS.has(k.toLowerCase()) && v !== undefined) out[k] = v;
    const up = https.request({ agent, ...where(target), method: route.method, path: route.path, headers: out, rejectUnauthorized: true, timeout: UPSTREAM_TIMEOUT_MS }, onResponse);
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
      let code = classifyError(err);
      if (code === 'ECONNRESET' && handshook && !up.reusedSocket) code = 'CLOSED_AFTER_HANDSHAKE';
      onError({ code, message: String(err.message ?? err), err });
    });
    return up;
  }

  /**
   * One buffered request, for a caller in the same process. Resolves `{ status, ok, text, headers }`; rejects with an Error whose `code` is
   * the short code the helper would answer in `x-podium-helper-error` (ROUTE_NOT_ALLOWED, CERT_EXPIRED, CLIENT_CERT_REJECTED, ...).
   */
  function request(method, url, { headers, body } = {}) {
    const g = guard(method, url);
    if (g.refusal) return Promise.reject(coded(g.refusal.code, g.refusal.message));
    return new Promise((resolve, reject) => {
      const sent = { ...headers };
      if (body !== undefined && !Object.keys(sent).some((k) => k.toLowerCase() === 'content-length')) sent['content-length'] = Buffer.byteLength(body);
      const up = open(g.route, sent, {
        onResponse: (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('error', (err) => reject(coded('UPSTREAM_ERROR', String(err.message ?? err))));
          res.on('aborted', () => reject(coded('UPSTREAM_ERROR', 'the connection closed before the reply ended')));
          res.on('end', () => {
            const out = {};
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
            const status = res.statusCode ?? 0;
            resolve({ status, ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString('utf8'), headers: out });
          });
        },
        onError: ({ code, message }) => reject(coded(code, message)),
      });
      up.end(body);
    });
  }

  /** `fetch` for a caller that holds the full server URL: only the path and query go on, and a URL on another origin is refused. */
  function fetchLike(url, init = {}) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return Promise.reject(coded('ROUTE_NOT_ALLOWED', `${url} is not a URL`));
    }
    if (u.origin !== target.origin) return Promise.reject(coded('ROUTE_NOT_ALLOWED', 'The Podium connection forwards requests to its own server only.'));
    return request(init.method ?? 'GET', `${u.pathname}${u.search}`, { headers: init.headers, body: init.body });
  }

  return {
    guard,
    open,
    request,
    fetch: fetchLike,
    /** Starts the check that renews a certificate in an idle session, and looks once now. */
    start() {
      if (!timer) timer = setInterval(() => void maybeRenew(), renewCheckMs).unref();
      void maybeRenew();
    },
    /** Stops the renewal check and closes the connections. */
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      agent.destroy();
    },
    /** Resolves when the renewal under way, if any, has ended. For tests and for a caller that must not leave one half done. */
    settled: () => renewing ?? Promise.resolve(),
    /** What a status display may show. Never a key, a certificate or a CA. */
    status: () => ({ user: cfg.user, server: target.origin, notAfter: cfg.notAfter, expired: expired(), refused: refused ? { ...refused } : null, renewing: renewing !== null, retryAt }),
  };
}
