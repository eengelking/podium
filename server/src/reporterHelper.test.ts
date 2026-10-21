// The reporter's TLS helper (#584, SPEC 5.9): the mod cannot hand $.http.fetch a CA or a client certificate, so a small
// Node process makes the connection. These tests run the real script against real certificates and a real HTTPS server.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { openDb } from './fleet/db.js';
import { PeopleStore } from './fleet/people.js';
import { createLogger } from './logging/logger.js';
import { describeCert, ensureTls, serverNames } from './tlsCa.js';
import { PersonCertStore } from './tlsClientAuth.js';
import { createReporterRenewRouter } from './tlsReporterRenew.js';
import { makeForgerCa, signClientDated } from './tlsTesting.js';
import { buildReporterConfig, issuePersonCert } from './tlsPeople.js';

const HELPER = fileURLToPath(new URL('../../mod/podium-reporter/hooks/helper.mjs', import.meta.url));

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-helper-'));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

interface Pki {
  dir: string;
  caCert: string;
  serving: { cert: string; key: string };
  person: { cert: string; key: string; info: { notAfter: string; fingerprintSha256: string } };
}

async function pki(): Promise<Pki> {
  const dir = path.join(tmp(), 'tls');
  const m = await ensureTls({ dir, names: serverNames('127.0.0.1', []) });
  const p = await issuePersonCert({ dir, keyId: 'a1b2c3d4e5f6' });
  return { dir, caCert: m.caCert, serving: { cert: m.cert, key: m.key }, person: p };
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, peer: X509Certificate | null) => void;

async function upstream(p: Pki, handler: Handler, opts: { requireClient?: boolean } = {}) {
  const sockets = new Set<Socket>();
  const server = https.createServer({ cert: p.serving.cert, key: p.serving.key, ca: [p.caCert], requestCert: true, rejectUnauthorized: opts.requireClient ?? true }, (req, res) => {
    const raw = (req.socket as unknown as { getPeerCertificate: () => { raw?: Buffer } }).getPeerCertificate().raw;
    handler(req, res, raw ? new X509Certificate(raw) : null);
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => {
    for (const s of sockets) s.destroy();
    server.close(() => r());
  }));
  return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const configFor = (p: Pki, server: string, user = 'Dana Lee', caCerts = [p.caCert]) =>
  buildReporterConfig({ user, server, issuedAt: Date.now(), cert: p.person.cert, key: p.person.key, info: p.person.info as never, caCerts }).content;

interface Running {
  proc: ChildProcess;
  config: string;
  socket: string;
  out: () => string;
  exited: Promise<number | null>;
}

/** Starts the helper; resolves once it prints `ready` (or exits, which the caller reads from `out`). */
async function runHelper(configText: string, server: string, env: Record<string, string> = {}, mode = 0o600, sameConfig?: string): Promise<Running> {
  const root = tmp();
  const config = sameConfig ?? path.join(root, 'reporter-config-Dana-1.pem');
  if (!sameConfig) {
    fs.writeFileSync(config, configText, { mode });
    fs.chmodSync(config, mode);
  }
  const socket = path.join(fs.mkdtempSync(path.join(root, 'run-')), 's.sock');
  const proc = spawn(process.execPath, [HELPER, config, socket, server], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (c) => (out += c));
  proc.stderr.on('data', (c) => (out += c));
  const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
  cleanup.push(() => {
    proc.kill('SIGKILL');
  });
  await new Promise<void>((resolve) => {
    const t = setInterval(() => out.includes('ready') && (clearInterval(t), resolve()), 10);
    void exited.then(() => (clearInterval(t), resolve()));
  });
  return { proc, config, socket, out: () => out, exited };
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  aborted: boolean;
}

function viaHelper(h: Running, method: string, p: string, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: h.socket, method, path: p, headers: body ? { 'content-type': 'application/json' } : {}, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('aborted', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, aborted: true }));
      res.on('error', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, aborted: true }));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, aborted: !res.complete }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('helper.mjs: the connection', () => {
  it('prints ready only once it listens, in a 0700 folder with a 0600 socket, and the server sees the person’s certificate', async () => {
    const p = await pki();
    const seen: string[] = [];
    const url = await upstream(p, (req, res, peer) => {
      seen.push(peer?.fingerprint256 ?? 'none');
      res.setHeader('x-extra', 'kept');
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    });
    const h = await runHelper(configFor(p, url), url);
    expect(h.out()).toContain('ready');
    expect(fs.statSync(h.socket).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(h.socket)).mode & 0o077).toBe(0);
    const a = await viaHelper(h, 'GET', '/api/fleet/ping?x=1');
    expect(a.status).toBe(201);
    expect(a.headers['x-extra']).toBe('kept');
    expect(JSON.parse(a.body)).toEqual({ path: '/api/fleet/ping?x=1', method: 'GET' });
    expect(seen).toEqual([new X509Certificate(p.person.cert).fingerprint256]);
  });

  it('passes a request body through and an error status unchanged', async () => {
    const p = await pki();
    const url = await upstream(p, (req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echoed: b }));
      });
    });
    const h = await runHelper(configFor(p, url), url);
    const a = await viaHelper(h, 'POST', '/api/fleet/report', '{"a":1}');
    expect(a.status).toBe(401);
    expect(a.headers['x-podium-helper-error']).toBeUndefined();
    expect(JSON.parse(a.body)).toEqual({ echoed: '{"a":1}' });
  });

  it('parses the CA by role, not position: two CA certificates and the certificate after them still connect', async () => {
    const p = await pki();
    const other = await pki();
    const url = await upstream(p, (_req, res) => res.end('ok'));
    const h = await runHelper(configFor(p, url, 'Dana Lee', [other.caCert, p.caCert]), url);
    expect((await viaHelper(h, 'GET', '/')).body).toBe('ok');
  });

  it('forces verification on even when the environment says NODE_TLS_REJECT_UNAUTHORIZED=0', async () => {
    const p = await pki();
    const stranger = await pki();
    const url = await upstream(stranger, (_req, res) => res.end('should never be read'), { requireClient: false });
    const h = await runHelper(configFor(p, url), url, { NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_OPTIONS: '' });
    const a = await viaHelper(h, 'GET', '/');
    expect(a.status).toBe(502);
    expect(a.body).not.toContain('should never');
    expect(a.headers['x-podium-helper-error']).toMatch(/^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT)$/);
  });
});

describe('helper.mjs: a structured error for each kind of failure', () => {
  it('ECONNREFUSED when nothing listens', async () => {
    const p = await pki();
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const url = `https://127.0.0.1:${port}`;
    const h = await runHelper(configFor(p, url), url);
    const a = await viaHelper(h, 'GET', '/');
    expect(a.status).toBe(502);
    expect(a.headers['x-podium-helper-error']).toBe('ECONNREFUSED');
  });

  it('CLOSED_AFTER_HANDSHAKE when the server drops a fresh connection once TLS is up (a rejected client certificate looks like this under TLS 1.3)', async () => {
    const p = await pki();
    const other = await pki();
    const url = await upstream(other, (_req, res) => res.end('no'));
    // The server's CA is `other`'s, but the file's CA is `other`'s too, so only the client certificate is wrong.
    const h = await runHelper(configFor(p, url, 'Dana Lee', [other.caCert]), url);
    const a = await viaHelper(h, 'GET', '/');
    expect(a.status).toBe(502);
    expect(a.headers['x-podium-helper-error']).toMatch(/^(CLOSED_AFTER_HANDSHAKE|CLIENT_CERT_REJECTED)$/);
  });

  it('aborts the response on an upstream error mid-body, so a truncated reply never reads as a 200', async () => {
    const p = await pki();
    const url = await upstream(p, (_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('{"partial":');
      setTimeout(() => res.socket?.destroy(), 30);
    });
    const h = await runHelper(configFor(p, url), url);
    const a = await viaHelper(h, 'GET', '/');
    expect(a.aborted).toBe(true);
  });

  it('refuses a config file that group or others can read, and says why', async () => {
    const p = await pki();
    const url = 'https://127.0.0.1:1';
    const h = await runHelper(configFor(p, url), url, {}, 0o640);
    expect(await h.exited).toBe(1);
    expect(h.out()).toContain('CONFIG_PERMISSIONS');
    expect(h.out()).not.toContain('ready');
  });

  it('refuses an http:// server address: a credential never goes over http', async () => {
    const p = await pki();
    const h = await runHelper(configFor(p, 'https://127.0.0.1:1'), 'http://127.0.0.1:1');
    expect(await h.exited).toBe(1);
    expect(h.out()).toContain('INSECURE_URL');
  });

  it('refuses a file with no key, or no person certificate', async () => {
    const p = await pki();
    const url = 'https://127.0.0.1:1';
    const noKey = configFor(p, url).replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----\n/, '');
    const h = await runHelper(noKey, url);
    expect(await h.exited).toBe(1);
    expect(h.out()).toContain('CONFIG_INVALID');
  });
});

describe('helper.mjs: identity and lifetime', () => {
  it('re-reads the file it started with when the name still matches, and keeps the last good copy when a read fails', async () => {
    const p = await pki();
    const second = await issuePersonCert({ dir: p.dir, keyId: 'b1b2c3d4e5f6' });
    const seen: string[] = [];
    const url = await upstream(p, (_req, res, peer) => {
      seen.push(peer?.fingerprint256 ?? 'none');
      res.end('ok');
    });
    const h = await runHelper(configFor(p, url), url);
    const file = (h.proc.spawnargs[2] as string);
    await viaHelper(h, 'GET', '/');
    const renewed = buildReporterConfig({ user: 'Dana Lee', server: url, issuedAt: Date.now() + 5000, cert: second.cert, key: second.key, info: second.info, caCerts: [p.caCert] }).content;
    fs.writeFileSync(file, renewed, { mode: 0o600 });
    await viaHelper(h, 'GET', '/');
    fs.writeFileSync(file, 'broken', { mode: 0o600 });
    await viaHelper(h, 'GET', '/');
    expect(seen).toEqual([new X509Certificate(p.person.cert).fingerprint256, new X509Certificate(second.cert).fingerprint256, new X509Certificate(second.cert).fingerprint256]);
  });

  it('lets a request that is in flight finish when the file is rewritten for the same person', async () => {
    const p = await pki();
    const second = await issuePersonCert({ dir: p.dir, keyId: 'd1b2c3d4e5f6' });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const url = await upstream(p, (req, res) => {
      if (req.url === '/slow') void held.then(() => res.end('finished'));
      else res.end('ok');
    });
    const h = await runHelper(configFor(p, url), url);
    const slow = viaHelper(h, 'GET', '/slow');
    await new Promise((r) => setTimeout(r, 100));
    const file = h.proc.spawnargs[2] as string;
    fs.writeFileSync(file, buildReporterConfig({ user: 'Dana Lee', server: url, issuedAt: Date.now() + 5000, cert: second.cert, key: second.key, info: second.info, caCerts: [p.caCert] }).content, { mode: 0o600 });
    expect((await viaHelper(h, 'GET', '/')).body).toBe('ok');
    release();
    const a = await slow;
    expect(a.body).toBe('finished');
    expect(a.headers['x-podium-helper-error']).toBeUndefined();
  });

  it('ignores a rewrite for a different person', async () => {
    const p = await pki();
    const second = await issuePersonCert({ dir: p.dir, keyId: 'c1b2c3d4e5f6' });
    const seen: string[] = [];
    const url = await upstream(p, (_req, res, peer) => {
      seen.push(peer?.fingerprint256 ?? 'none');
      res.end('ok');
    });
    const h = await runHelper(configFor(p, url), url);
    const file = h.proc.spawnargs[2] as string;
    const someoneElse = buildReporterConfig({ user: 'Ed', server: url, issuedAt: Date.now() + 5000, cert: second.cert, key: second.key, info: second.info, caCerts: [p.caCert] }).content;
    fs.writeFileSync(file, someoneElse, { mode: 0o600 });
    await viaHelper(h, 'GET', '/');
    expect(seen).toEqual([new X509Certificate(p.person.cert).fingerprint256]);
  });

  it('removes its own socket when told to stop, and never one it did not make', async () => {
    const p = await pki();
    const url = await upstream(p, (_req, res) => res.end('ok'));
    const h = await runHelper(configFor(p, url), url);
    expect(fs.existsSync(h.socket)).toBe(true);
    h.proc.kill('SIGTERM');
    await h.exited;
    expect(fs.existsSync(h.socket)).toBe(false);
  });

  it('exits when its parent dies', async () => {
    const p = await pki();
    const url = await upstream(p, (_req, res) => res.end('ok'));
    const root = tmp();
    const config = path.join(root, 'reporter-config-Dana-1.pem');
    fs.writeFileSync(config, configFor(p, url), { mode: 0o600 });
    const socket = path.join(root, 's.sock');
    // A throwaway parent starts the helper, reports its pid, and is then killed with SIGKILL.
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,[${JSON.stringify(HELPER)},${JSON.stringify(config)},${JSON.stringify(socket)},${JSON.stringify(url)}],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`;
    const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    cleanup.push(() => {
      parent.kill('SIGKILL');
    });
    const pid = await new Promise<number>((r) => parent.stdout.once('data', (c) => r(Number(String(c).trim()))));
    cleanup.push(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    });
    for (let i = 0; i < 100 && !fs.existsSync(socket); i++) await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(socket)).toBe(true);
    parent.kill('SIGKILL');
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
    expect(fs.existsSync(socket)).toBe(false);
  }, 20_000);
});

describe('helper.mjs: classifyError', () => {
  it('names the failures a person can act on', async () => {
    const { classifyError } = (await import(/* @vite-ignore */ HELPER)) as { classifyError: (e: { code?: string; message?: string }) => string };
    expect(classifyError({ code: 'CERT_HAS_EXPIRED' })).toBe('CERT_HAS_EXPIRED');
    expect(classifyError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).toBe('ALTNAME');
    expect(classifyError({ code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED' })).toBe('CLIENT_CERT_REJECTED');
    expect(classifyError({ code: 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED' })).toBe('CLIENT_CERT_REJECTED');
    expect(classifyError({ code: 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA' })).toBe('CLIENT_CERT_REJECTED');
    expect(classifyError({ code: 'ENOTFOUND' })).toBe('ENOTFOUND');
    expect(classifyError({ code: 'ECONNRESET' })).toBe('ECONNRESET');
    expect(classifyError({ message: 'something odd' })).toBe('UPSTREAM_ERROR');
  });
});

// ---- renewing the reporter's own certificate (#585) --------------------------------------------------------------------

const DAY = 86_400_000;

/** A real Podium renewal route behind a real mutual-TLS listener, and a person whose certificate has the dates given. */
async function renewing(dates: { from: number; to: number } | { days: number }, o: { graceDays?: number; renewStatus?: number } = {}) {
  const p = await pki();
  const db = openDb(':memory:');
  const people = new PeopleStore(db);
  const certs = new PersonCertStore(db);
  const person = people.createPerson('Dana Lee').person;
  const caFp = new X509Certificate(p.caCert).fingerprint256;
  let cert: string;
  let key: string;
  if ('days' in dates) {
    const i = await issuePersonCert({ dir: p.dir, keyId: person.keyId, days: dates.days });
    ({ cert, key } = i);
  } else {
    ({ cert, key } = signClientDated({ caCrt: path.join(p.dir, 'ca.crt'), caKey: path.join(p.dir, 'ca.key'), keyId: person.keyId, ...dates }));
  }
  const info = describeCert(cert);
  certs.replace(person.id, { cert, info, issuerFingerprint: caFp }, Date.now());
  p.person = { cert, key, info };
  const seen: string[] = [];
  const app = express();
  app.use('/api/reporter', (req, res, next) => (o.renewStatus ? void res.status(o.renewStatus).json({ ok: false }) : next()));
  app.use('/api/reporter', createReporterRenewRouter({ certs, people, logger: createLogger({ format: 'json', write: () => {} }), now: Date.now, settings: () => ({ lifetimeDays: 90, graceDays: o.graceDays ?? 30 }), trustedIssuers: () => [caFp], issuer: () => ({ dir: p.dir, port: 0, caCerts: () => [p.caCert] }) }));
  app.get('/api/fleet/ping', (req, res) => {
    const raw = (req.socket as unknown as { getPeerCertificate: () => { raw?: Buffer } }).getPeerCertificate().raw;
    seen.push(raw ? new X509Certificate(raw).fingerprint256 : 'none');
    res.json({ ok: true });
  });
  const url = await upstream(p, (req, res) => app(req, res), { requireClient: false });
  const live = () => certs.listFor(person.id).filter((c) => c.revokedAt === null);
  return { p, url, certs, person, seen, live, original: new X509Certificate(cert).fingerprint256 };
}

const partsOfFile = (file: string) => {
  const text = fs.readFileSync(file, 'utf8');
  const blocks = text.match(/-----BEGIN ([A-Z ]+)-----[\s\S]*?-----END \1-----/g) ?? [];
  const certs = blocks.filter((b) => b.includes('CERTIFICATE'));
  return { text, certs, key: blocks.find((b) => b.includes('PRIVATE KEY'))!, mode: fs.statSync(file).mode & 0o777 };
};

/** Waits until `f` is true, polling; fails with `what` after `ms`. */
async function until(f: () => boolean, what: string, ms = 8000): Promise<void> {
  for (let t = 0; t < ms && !f(); t += 25) await new Promise((r) => setTimeout(r, 25));
  expect(f(), what).toBe(true);
}

describe('helper.mjs: renewing its own certificate', () => {
  // The certificate lasts a day; the test asks the helper to renew when two days remain, so it is due at once.
  const DUE = { PODIUM_RENEW_BEFORE_SECONDS: String(2 * 86_400) };

  it('renews before expiry, writes the new certificate and the CA to the file in one rename at mode 0600, and keeps the old certificate working', async () => {
    const r = await renewing({ days: 1 });
    const original = configFor(r.p, r.url);
    const h = await runHelper(original, r.url, DUE);
    await until(() => fs.readFileSync(h.config, 'utf8') !== original, 'the file is rewritten');
    const f = partsOfFile(h.config);
    expect(f.mode).toBe(0o600);
    // the CA first, then the new certificate; the key matches the new certificate
    const person = new X509Certificate(f.certs.at(-1)!);
    expect(person.fingerprint256).not.toBe(r.original);
    expect(person.checkPrivateKey(createPrivateKey(f.key))).toBe(true);
    expect(person.verify(new X509Certificate(r.p.caCert).publicKey)).toBe(true);
    expect(f.certs.slice(0, -1).map((c) => new X509Certificate(c).fingerprint256)).toEqual([new X509Certificate(r.p.caCert).fingerprint256]);
    expect(f.text).toMatch(/^# user: Dana Lee$/m);
    expect(f.text).toContain(`# fingerprint: ${person.fingerprint256}`);
    expect(f.text).toContain(`# expires: ${new Date(person.validTo).toISOString()}`);
    expect(r.live()).toHaveLength(2);
    // the next request is made with the new certificate
    const a = await viaHelper(h, 'GET', '/api/fleet/ping');
    expect(a.status).toBe(200);
    expect(r.seen.at(-1)).toBe(person.fingerprint256);
    // the old certificate still works until it expires
    expect(r.live().map((c) => c.fingerprint)).toContain(r.original);
  }, 30_000);

  it('does not renew while more than the threshold remains', async () => {
    const r = await renewing({ days: 60 });
    const h = await runHelper(configFor(r.p, r.url), r.url);
    const before = fs.readFileSync(h.config, 'utf8');
    expect((await viaHelper(h, 'GET', '/api/fleet/ping')).status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    expect(fs.readFileSync(h.config, 'utf8')).toBe(before);
    expect(r.live()).toHaveLength(1);
  });

  it('does not renew a short-lived certificate the moment it is issued: it waits until half its life is gone', async () => {
    // 30 days is the shortest the Admin can set; the 30-day threshold would make it due at once.
    const r = await renewing({ days: 30 });
    const original = configFor(r.p, r.url);
    const h = await runHelper(original, r.url);
    expect((await viaHelper(h, 'GET', '/api/fleet/ping')).status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    expect(fs.readFileSync(h.config, 'utf8')).toBe(original);
    expect(r.live()).toHaveLength(1);
  });

  it('renews an expired certificate inside the grace before the request that found it expired goes out', async () => {
    const r = await renewing({ from: Date.now() - 100 * DAY, to: Date.now() - 5 * DAY });
    const h = await runHelper(configFor(r.p, r.url), r.url);
    const a = await viaHelper(h, 'GET', '/api/fleet/ping');
    expect(a.status).toBe(200);
    const f = partsOfFile(h.config);
    const renewed = new X509Certificate(f.certs.at(-1)!);
    expect(renewed.fingerprint256).not.toBe(r.original);
    expect(Date.parse(renewed.validTo)).toBeGreaterThan(Date.now());
    expect(r.seen.at(-1)).toBe(renewed.fingerprint256);
  }, 30_000);

  it('past the grace it says so, changes nothing and sends nothing upstream', async () => {
    const r = await renewing({ from: Date.now() - 200 * DAY, to: Date.now() - 40 * DAY });
    const h = await runHelper(configFor(r.p, r.url), r.url);
    const before = fs.readFileSync(h.config, 'utf8');
    const a = await viaHelper(h, 'GET', '/api/fleet/ping');
    expect(a.status).toBe(502);
    expect(a.headers['x-podium-helper-error']).toBe('CERT_PAST_GRACE');
    expect(r.seen).toEqual([]);
    expect(fs.readFileSync(h.config, 'utf8')).toBe(before);
    expect(r.live()).toHaveLength(1);
    // it does not ask again on every request
    const b = await viaHelper(h, 'GET', '/api/fleet/ping');
    expect(b.headers['x-podium-helper-error']).toBe('CERT_PAST_GRACE');
  }, 30_000);

  it('a forged expired certificate with a stolen serial is refused and the file is not rewritten', async () => {
    const r = await renewing({ days: 90 });
    const work = tmp();
    const forged = signClientDated({ ...makeForgerCa(work), keyId: r.person.keyId, from: Date.now() - 100 * DAY, to: Date.now() - 5 * DAY, serial: `0x${new X509Certificate(r.p.person.cert).serialNumber}` });
    const h = await runHelper(configFor({ ...r.p, person: { ...forged, info: describeCert(forged.cert) } }, r.url), r.url);
    const before = fs.readFileSync(h.config, 'utf8');
    const a = await viaHelper(h, 'GET', '/api/fleet/ping');
    expect(a.status).toBe(502);
    expect(a.headers['x-podium-helper-error']).toBe('CERT_RENEWAL_REFUSED');
    expect(fs.readFileSync(h.config, 'utf8')).toBe(before);
    expect(r.live()).toHaveLength(1);
  }, 30_000);

  it('a server that cannot renew right now does not stop the request, and the file is left alone', async () => {
    const r = await renewing({ days: 1 }, { renewStatus: 503 });
    const h = await runHelper(configFor(r.p, r.url), r.url, DUE);
    const before = fs.readFileSync(h.config, 'utf8');
    expect((await viaHelper(h, 'GET', '/api/fleet/ping')).status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    expect(fs.readFileSync(h.config, 'utf8')).toBe(before);
  }, 30_000);

  it('two sessions renewing together leave one valid file and one new certificate', async () => {
    const r = await renewing({ days: 1 });
    const original = configFor(r.p, r.url);
    const a = await runHelper(original, r.url, DUE);
    const b = await runHelper('', r.url, DUE, 0o600, a.config);
    const before = original;
    const [ra, rb] = await Promise.all([viaHelper(a, 'GET', '/api/fleet/ping'), viaHelper(b, 'GET', '/api/fleet/ping')]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    await until(() => fs.readFileSync(a.config, 'utf8') !== before, 'the file is rewritten');
    await new Promise((res) => setTimeout(res, 500));
    const f = partsOfFile(a.config);
    const person = new X509Certificate(f.certs.at(-1)!);
    expect(person.checkPrivateKey(createPrivateKey(f.key))).toBe(true);
    expect(f.mode).toBe(0o600);
    // the old certificate and the one new certificate; the second session took the first's instead of making a third
    expect(r.live()).toHaveLength(2);
    expect(r.live().map((c) => c.fingerprint)).toContain(person.fingerprint256);
    expect(fs.readdirSync(path.dirname(a.config)).filter((n) => n.includes('.tmp') || n.endsWith('.lock'))).toEqual([]);
    // both sessions now use the file's certificate
    r.seen.length = 0;
    await viaHelper(a, 'GET', '/api/fleet/ping');
    await viaHelper(b, 'GET', '/api/fleet/ping');
    expect(r.seen).toEqual([person.fingerprint256, person.fingerprint256]);
  }, 40_000);

  it('takes over a lock left by a process that died', async () => {
    const r = await renewing({ days: 1 });
    const original = configFor(r.p, r.url);
    const root = tmp();
    const config = path.join(root, 'reporter-config-Dana-1.pem');
    fs.writeFileSync(config, original, { mode: 0o600 });
    // a lock from ten minutes ago, left by a process that died before it could remove it
    const lock = `${config}.lock`;
    fs.writeFileSync(lock, '99999999');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);
    await runHelper('', r.url, DUE, 0o600, config);
    await until(() => fs.readFileSync(config, 'utf8') !== original, 'renewed past a stale lock');
    await until(() => !fs.existsSync(lock), 'the lock is released');
  }, 40_000);
});

describe('helper.mjs: withLock on a stale lock (#611)', () => {
  // Every child waits for `go`, then takes the lock and spends 80 ms inside it; a second one inside at the same time is a violation.
  const CHILD = `
    import fs from 'node:fs';
    const [helper, lock, marker, go] = process.argv.slice(1);
    const { withLock } = await import(helper);
    fs.writeFileSync(go + '.ready-' + process.pid, '');
    while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 1));
    const got = await withLock(lock, async () => {
      try { fs.closeSync(fs.openSync(marker, 'wx')); } catch { return 'violation'; }
      await new Promise((r) => setTimeout(r, 80));
      fs.rmSync(marker, { force: true });
      return 'ok';
    });
    process.stdout.write(got === null ? 'timeout' : got.value);
  `;

  it('lets one waiter in at a time when many find the same stale lock together', async () => {
    const results: string[] = [];
    for (let round = 0; round < 6; round++) {
      const dir = tmp();
      const lock = path.join(dir, 'c.pem.lock');
      const go = path.join(dir, 'go');
      fs.writeFileSync(lock, '99999999');
      const old = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(lock, old, old);
      const kids = Array.from({ length: 8 }, () => {
        const proc = spawn(process.execPath, ['--input-type=module', '-e', CHILD, pathToFileURL(HELPER).href, lock, path.join(dir, 'inside'), go], { stdio: ['ignore', 'pipe', 'pipe'] });
        cleanup.push(() => {
          proc.kill('SIGKILL');
        });
        let out = '';
        proc.stdout.on('data', (c) => (out += c));
        return new Promise<string>((resolve) => proc.on('exit', () => resolve(out || 'crashed')));
      });
      await until(() => fs.readdirSync(dir).filter((n) => n.startsWith('go.ready-')).length === 8, 'every child is ready', 15_000);
      fs.writeFileSync(go, '');
      results.push(...(await Promise.all(kids)));
      expect(fs.existsSync(lock)).toBe(false);
    }
    expect(results.filter((r) => r !== 'ok')).toEqual([]);
  }, 60_000);

  it('does not take over a lock that was fresh again by the time it acted on a stale reading', async () => {
    const { withLock } = (await import(/* @vite-ignore */ HELPER)) as { withLock: (lock: string, fn: () => Promise<void>, waitMs?: number) => Promise<unknown> };
    const lock = path.join(tmp(), 'c.pem.lock');
    fs.writeFileSync(lock, 'stale-owner');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);
    // This waiter reads the lock as stale; before it acts, another waiter takes it over and makes a fresh one.
    const real = fs.statSync;
    let swapped = false;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((...a: Parameters<typeof fs.statSync>) => {
      const st = real(...a);
      if (!swapped && String(a[0]) === lock) {
        swapped = true;
        fs.writeFileSync(lock, 'fresh-owner');
      }
      return st;
    }) as typeof fs.statSync);
    let ran = false;
    const got = await withLock(lock, async () => void (ran = true), 400);
    spy.mockRestore();
    expect(swapped).toBe(true);
    expect(ran).toBe(false);
    expect(got).toBeNull();
    expect(fs.readFileSync(lock, 'utf8')).toBe('fresh-owner');
  });

  it('never takes a lock from a holder that is still running, however long it takes', async () => {
    const { withLock } = (await import(/* @vite-ignore */ HELPER)) as { withLock: (lock: string, fn: () => Promise<string>, waitMs?: number, staleMs?: number) => Promise<{ value: string } | null> };
    const lock = path.join(tmp(), 'c.pem.lock');
    // the lock goes stale after 300 ms without a refresh; the holder works for 1.2 s
    const holder = withLock(lock, async () => {
      await new Promise((r) => setTimeout(r, 1200));
      return 'held';
    }, 5000, 300);
    await new Promise((r) => setTimeout(r, 100));
    const waiter = await withLock(lock, async () => 'stolen', 900, 300);
    expect(waiter).toBeNull();
    expect(await holder).toEqual({ value: 'held' });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('clears a takeover lock left by a process that died mid-takeover, then gets the lock', async () => {
    const { withLock } = (await import(/* @vite-ignore */ HELPER)) as { withLock: (lock: string, fn: () => Promise<string>, waitMs?: number) => Promise<{ value: string } | null> };
    const lock = path.join(tmp(), 'c.pem.lock');
    const old = new Date(Date.now() - 10 * 60_000);
    for (const f of [lock, `${lock}.takeover`]) {
      fs.writeFileSync(f, '99999999');
      fs.utimesSync(f, old, old);
    }
    const got = await withLock(lock, async () => 'in', 5000);
    expect(got).toEqual({ value: 'in' });
    expect(fs.readdirSync(path.dirname(lock))).toEqual([]);
  });

  it('does not remove a lock that another process took after this one lost its own', async () => {
    const { withLock } = (await import(/* @vite-ignore */ HELPER)) as { withLock: (lock: string, fn: () => Promise<void>) => Promise<unknown> };
    const lock = path.join(tmp(), 'c.pem.lock');
    await withLock(lock, async () => {
      // this holder was taken over: someone else's lock is in its place when it finishes
      fs.writeFileSync(lock, 'another-owner');
    });
    expect(fs.readFileSync(lock, 'utf8')).toBe('another-owner');
  });
});

describe('helper.mjs: rewriteConfig', () => {
  it('keeps the name and the server, and updates the issued-at, expires and fingerprint lines', async () => {
    const { rewriteConfig } = (await import(/* @vite-ignore */ HELPER)) as { rewriteConfig: (text: string, n: { ca: string[]; cert: string; key: string; notAfter: string; fingerprint: string; now: number }) => string };
    const old = '# podium-reporter-config v1\n# user: Dana Lee\n# server: https://h:4318\n# issued-at: 2026-01-01T00:00:00.000Z 1767225600\n# expires: 2026-04-01T00:00:00.000Z\n# fingerprint: AA\n-----BEGIN CERTIFICATE-----\nOLD\n-----END CERTIFICATE-----\n';
    const out = rewriteConfig(old, { ca: ['-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n'], cert: '-----BEGIN CERTIFICATE-----\nNEW\n-----END CERTIFICATE-----\n', key: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n', notAfter: '2026-07-01T00:00:00.000Z', fingerprint: 'BB', now: Date.parse('2026-05-01T00:00:00.000Z') });
    expect(out.split('\n').slice(0, 6)).toEqual(['# podium-reporter-config v1', '# user: Dana Lee', '# server: https://h:4318', '# issued-at: 2026-05-01T00:00:00.000Z 1777593600', '# expires: 2026-07-01T00:00:00.000Z', '# fingerprint: BB']);
    expect(out).not.toContain('OLD');
    expect(out.indexOf('CA')).toBeLessThan(out.indexOf('NEW'));
    expect(out.indexOf('NEW')).toBeLessThan(out.indexOf('PRIVATE KEY'));
  });
});
