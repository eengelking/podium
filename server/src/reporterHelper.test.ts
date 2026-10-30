// The reporter's TLS helper (#584, SPEC 5.9): the mod cannot hand $.http.fetch a CA or a client certificate, so a small
// Node process makes the connection. These tests run the real script against real certificates and a real HTTPS server.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
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
import { openSqliteStorage } from './storage/sqlite/index.js';
import { createLogger } from './logging/logger.js';
import { REPORTER_ROUTE_TEMPLATES } from './tlsHttp.js';
import { describeCert, ensureTls, serverNames } from './tlsCa.js';
import { createReporterRenewRouter } from './tlsReporterRenew.js';
import { makeForgerCa, signClientDated, signDated } from './tlsTesting.js';
import { buildReporterConfig, issuePersonCert } from './tlsPeople.js';

const HELPER = fileURLToPath(new URL('../../mod/podium-reporter/hooks/helper.mjs', import.meta.url));

/** Reporter routes the helper forwards (#668), for the tests that only need some request to go through. */
const PEERS = '/api/fleet/sessions/s1/peers';
const SLOW = '/api/fleet/sessions/s1/asks/slow/answer';

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
    const a = await viaHelper(h, 'GET', '/api/fleet/sessions/s1/peers?x=1');
    expect(a.status).toBe(201);
    expect(a.headers['x-extra']).toBe('kept');
    expect(JSON.parse(a.body)).toEqual({ path: '/api/fleet/sessions/s1/peers?x=1', method: 'GET' });
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
    expect((await viaHelper(h, 'GET', PEERS)).body).toBe('ok');
  });

  it('forces verification on even when the environment says NODE_TLS_REJECT_UNAUTHORIZED=0', async () => {
    const p = await pki();
    const stranger = await pki();
    const url = await upstream(stranger, (_req, res) => res.end('should never be read'), { requireClient: false });
    const h = await runHelper(configFor(p, url), url, { NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_OPTIONS: '' });
    const a = await viaHelper(h, 'GET', PEERS);
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
    const a = await viaHelper(h, 'GET', PEERS);
    expect(a.status).toBe(502);
    expect(a.headers['x-podium-helper-error']).toBe('ECONNREFUSED');
  });

  it('CLOSED_AFTER_HANDSHAKE when the server drops a fresh connection once TLS is up (a rejected client certificate looks like this under TLS 1.3)', async () => {
    const p = await pki();
    const other = await pki();
    const url = await upstream(other, (_req, res) => res.end('no'));
    // The server's CA is `other`'s, but the file's CA is `other`'s too, so only the client certificate is wrong.
    const h = await runHelper(configFor(p, url, 'Dana Lee', [other.caCert]), url);
    const a = await viaHelper(h, 'GET', PEERS);
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
    const a = await viaHelper(h, 'GET', PEERS);
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
    await viaHelper(h, 'GET', PEERS);
    const renewed = buildReporterConfig({ user: 'Dana Lee', server: url, issuedAt: Date.now() + 5000, cert: second.cert, key: second.key, info: second.info, caCerts: [p.caCert] }).content;
    fs.writeFileSync(file, renewed, { mode: 0o600 });
    await viaHelper(h, 'GET', PEERS);
    fs.writeFileSync(file, 'broken', { mode: 0o600 });
    await viaHelper(h, 'GET', PEERS);
    expect(seen).toEqual([new X509Certificate(p.person.cert).fingerprint256, new X509Certificate(second.cert).fingerprint256, new X509Certificate(second.cert).fingerprint256]);
  });

  it('lets a request that is in flight finish when the file is rewritten for the same person', async () => {
    const p = await pki();
    const second = await issuePersonCert({ dir: p.dir, keyId: 'd1b2c3d4e5f6' });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const url = await upstream(p, (req, res) => {
      if (req.url === SLOW) void held.then(() => res.end('finished'));
      else res.end('ok');
    });
    const h = await runHelper(configFor(p, url), url);
    const slow = viaHelper(h, 'GET', SLOW);
    await new Promise((r) => setTimeout(r, 100));
    const file = h.proc.spawnargs[2] as string;
    fs.writeFileSync(file, buildReporterConfig({ user: 'Dana Lee', server: url, issuedAt: Date.now() + 5000, cert: second.cert, key: second.key, info: second.info, caCerts: [p.caCert] }).content, { mode: 0o600 });
    expect((await viaHelper(h, 'GET', PEERS)).body).toBe('ok');
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
    await viaHelper(h, 'GET', PEERS);
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

describe('helper.mjs: it forwards the reporter routes and nothing else (#668)', () => {
  type Target = { method: string; path: string } | null;
  const load = async () => (await import(/* @vite-ignore */ HELPER)) as { REPORTER_ROUTES: Array<[string, string]>; reporterTarget: (method: string | undefined, url: string | undefined) => Target };

  it('holds the same list of routes as the server, so one cannot change without the other', async () => {
    const { REPORTER_ROUTES } = await load();
    expect(REPORTER_ROUTES).toEqual(REPORTER_ROUTE_TEMPLATES.map(([m, p]) => [m, p]));
  });

  it('rebuilds the request target from the matched route: its method and fixed parts, the person’s ids, and a plain query', async () => {
    const { reporterTarget } = await load();
    expect(reporterTarget('POST', '/api/fleet/report')).toEqual({ method: 'POST', path: '/api/fleet/report' });
    expect(reporterTarget('POST', '/API/Fleet/Report//')).toEqual({ method: 'POST', path: '/api/fleet/report' });
    expect(reporterTarget('GET', '/api/fleet/sessions/Ab%20c-1/asks/a1/answer?wait=25')).toEqual({ method: 'GET', path: '/api/fleet/sessions/Ab%20c-1/asks/a1/answer?wait=25' });
    expect(reporterTarget('PUT', '/api/fleet/sessions/s1/diffs/d.1')).toEqual({ method: 'PUT', path: '/api/fleet/sessions/s1/diffs/d.1' });
  });

  it('says no to every other route, method, address form and id that could change where the request goes', async () => {
    const { reporterTarget } = await load();
    for (const [m, u] of [
      ['GET', '/api/fleet/ping'],
      ['GET', '/api/fleet/report'],
      ['DELETE', '/api/fleet/report'],
      ['POST', '/api/reporter/renew'],
      ['POST', '/api/admin/people'],
      ['POST', '//evil.example/api/fleet/report'],
      ['POST', 'http://evil.example/api/fleet/report'],
      ['POST', '*'],
      ['POST', '/api//fleet/report'],
      ['POST', '/api/fleet/report/x'],
      ['GET', '/api/fleet/sessions//peers'],
      ['GET', '/api/fleet/sessions/../peers'],
      ['GET', '/api/fleet/sessions/./peers'],
      ['GET', '/api/fleet/sessions/%2e%2E/peers'],
      ['GET', '/api/fleet/sessions/a%2Fb/peers'],
      ['GET', '/api/fleet/sessions/a%5cb/peers'],
      ['GET', '/api/fleet/sessions/a\\b/peers'],
      ['GET', '/api/fleet/sessions/a b/peers'],
      ['GET', '/api/fleet/sessions/s1/peers?a=b#frag'],
      ['GET', '/api/fleet/sessions/s1/peers?a=\r\nHost: x'],
      [undefined, '/api/fleet/report'],
      ['POST', undefined],
    ] as Array<[string | undefined, string | undefined]>) expect(reporterTarget(m, u), `${m} ${u}`).toBeNull();
  });

  it('answers 403 to a route that is not a reporter route, and sends nothing upstream', async () => {
    const p = await pki();
    const seen: string[] = [];
    const url = await upstream(p, (req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.end('{}');
    });
    const h = await runHelper(configFor(p, url), url);
    for (const [m, u] of [['GET', '/api/fleet/ping'], ['POST', '//evil.example/api/fleet/report'], ['POST', '/api/reporter/renew'], ['GET', '/api/fleet/sessions/%2e%2e/peers']]) {
      const r = await viaHelper(h, m, u, m === 'POST' ? '{}' : undefined);
      expect(r.status, `${m} ${u}`).toBe(403);
      expect(JSON.parse(r.body)).toMatchObject({ error: 'ROUTE_NOT_ALLOWED' });
    }
    expect((await viaHelper(h, 'POST', '/api/fleet/report', '{}')).status).toBe(200);
    expect(seen).toEqual(['POST /api/fleet/report']);
  });
});

describe('helper.mjs: writeAtomic (#672)', () => {
  const load = async () => ((await import(/* @vite-ignore */ HELPER)) as { writeAtomic: (file: string, text: string) => void }).writeAtomic;

  it('writes the file at mode 0600 and leaves no temporary file', async () => {
    const writeAtomic = await load();
    const dir = tmp();
    const file = path.join(dir, 'config.pem');
    writeAtomic(file, 'one');
    writeAtomic(file, 'two');
    expect(fs.readFileSync(file, 'utf8')).toBe('two');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['config.pem']);
  });

  it('follows a destination that is a symlink: the target changes, the link stays a link, and no temporary file is left in either folder', async () => {
    const writeAtomic = await load();
    const dir = tmp();
    const other = tmp();
    const target = path.join(other, 'target.pem');
    const link = path.join(dir, 'config.pem');
    fs.writeFileSync(target, 'original');
    fs.symlinkSync(target, link);
    writeAtomic(link, 'new');
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['config.pem']);
    expect(fs.readdirSync(other)).toEqual(['target.pem']);
  });

  it('throws for a symlink whose target is missing, and creates nothing', async () => {
    const writeAtomic = await load();
    const dir = tmp();
    const link = path.join(dir, 'config.pem');
    fs.symlinkSync(path.join(dir, 'gone.pem'), link);
    expect(() => writeAtomic(link, 'new')).toThrow();
    expect(fs.readdirSync(dir)).toEqual(['config.pem']);
  });

  it('does not write through a symlink planted at the temporary name', async () => {
    const writeAtomic = await load();
    const dir = tmp();
    const file = path.join(dir, 'config.pem');
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'untouched');
    fs.symlinkSync(victim, `${file}.${process.pid}.tmp`);
    writeAtomic(file, 'new');
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
  });
});

describe('helper.mjs: headerUser', () => {
  it('reads the name from the user line, line by line, however many blanks surround it', async () => {
    const { headerUser } = (await import(/* @vite-ignore */ HELPER)) as { headerUser: (t: string) => string };
    expect(headerUser('# podium-reporter-config v1\n# user: Dana Lee \n# server: x\n')).toBe('Dana Lee');
    expect(headerUser('#user:Dana\r\n')).toBe('Dana');
    expect(headerUser('# user:\n#   user:   Second   \n')).toBe('Second');
    expect(headerUser('x # user: no\n# users: no\n')).toBe('');
    expect(headerUser('')).toBe('');
    const t = process.hrtime.bigint();
    headerUser(`${'#'.repeat(100000)}\n${'#' + ' \n'.repeat(50000)}#${' '.repeat(100000)}!`);
    expect(Number(process.hrtime.bigint() - t) / 1e6).toBeLessThan(250);
  });
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
async function renewing(dates: { from: number; to: number } | { days: number }, o: { renewStatus?: number; retryAfter?: string } = {}) {
  const p = await pki();
  const storage = openSqliteStorage(':memory:');
  cleanup.push(() => storage.close());
  const people = storage.people;
  const certs = storage.personCerts;
  const person = (await people.createPerson('Dana Lee')).person;
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
  await certs.replace(person.id, { cert, info, issuerFingerprint: caFp }, Date.now());
  p.person = { cert, key, info };
  const seen: string[] = [];
  const app = express();
  let renewCalls = 0;
  app.use('/api/reporter', (req, res, next) => {
    renewCalls++;
    if (!o.renewStatus) return next();
    if (o.retryAfter) res.set('retry-after', o.retryAfter);
    res.status(o.renewStatus).json({ ok: false, code: o.renewStatus === 429 ? 'TOO_SOON' : undefined });
  });
  app.use('/api/reporter', createReporterRenewRouter({ certs, people, tx: storage.tx, logger: createLogger({ format: 'json', write: () => {} }), now: () => Date.now() + 2 * 3_600_000, settings: () => ({ lifetimeDays: 90 }), trustedIssuers: () => [caFp], issuer: () => ({ dir: p.dir, port: 0, caCerts: () => [p.caCert] }) }));
  app.get('/api/fleet/sessions/s1/peers', (req, res) => {
    const raw = (req.socket as unknown as { getPeerCertificate: () => { raw?: Buffer } }).getPeerCertificate().raw;
    seen.push(raw ? new X509Certificate(raw).fingerprint256 : 'none');
    res.json({ ok: true });
  });
  const url = await upstream(p, (req, res) => app(req, res), { requireClient: false });
  const live = async () => (await certs.listFor(person.id)).filter((c) => c.revokedAt === null);
  return { p, url, certs, person, seen, live, calls: () => renewCalls, original: new X509Certificate(cert).fingerprint256 };
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
    expect(await r.live()).toHaveLength(2);
    // the next request is made with the new certificate
    const a = await viaHelper(h, 'GET', '/api/fleet/sessions/s1/peers');
    expect(a.status).toBe(200);
    expect(r.seen.at(-1)).toBe(person.fingerprint256);
    // the old certificate still works until it expires
    expect((await r.live()).map((c) => c.fingerprint)).toContain(r.original);
  }, 30_000);

  it('does not renew while more than the threshold remains', async () => {
    const r = await renewing({ days: 60 });
    const h = await runHelper(configFor(r.p, r.url), r.url);
    const before = fs.readFileSync(h.config, 'utf8');
    expect((await viaHelper(h, 'GET', '/api/fleet/sessions/s1/peers')).status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    expect(fs.readFileSync(h.config, 'utf8')).toBe(before);
    expect(await r.live()).toHaveLength(1);
  });

  it('does not renew a short-lived certificate the moment it is issued: it waits until half its life is gone', async () => {
    // 30 days is the shortest the Admin can set; the 30-day threshold would make it due at once.
    const r = await renewing({ days: 30 });
    const original = configFor(r.p, r.url);
    const h = await runHelper(original, r.url);
    expect((await viaHelper(h, 'GET', '/api/fleet/sessions/s1/peers')).status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    expect(fs.readFileSync(h.config, 'utf8')).toBe(original);
    expect(await r.live()).toHaveLength(1);
  });

  it.each([
    ['a few days after it expired', 100, 5],
    ['long after it expired', 200, 40],
  ])('an expired certificate is not renewed, %s: it names the date, changes nothing and sends nothing upstream (#665)', async (_when, from, to) => {
    const r = await renewing({ from: Date.now() - from * DAY, to: Date.now() - to * DAY });
    const h = await runHelper(configFor(r.p, r.url), r.url);
    const before = fs.readFileSync(h.config, 'utf8');
    const expiredOn = new Date(Date.now() - to * DAY).toISOString().slice(0, 10);
    const a = await viaHelper(h, 'GET', '/api/fleet/sessions/s1/peers');
    expect(a.status).toBe(502);
    expect(a.headers['x-podium-helper-error']).toBe('CERT_EXPIRED');
    expect(a.body).toContain(expiredOn);
    expect(a.body).toMatch(/Admin/);
    expect(r.seen).toEqual([]);
    expect(r.calls()).toBe(0);
    expect(fs.readFileSync(h.config, 'utf8')).toBe(before);
    expect(await r.live()).toHaveLength(1);
    // it says the same on every request, and still asks the server for nothing
    const b = await viaHelper(h, 'GET', '/api/fleet/sessions/s1/peers');
    expect(b.headers['x-podium-helper-error']).toBe('CERT_EXPIRED');
    expect(r.calls()).toBe(0);
  }, 30_000);

  it('a forged expired certificate with a stolen serial is not sent upstream or renewed, and the file is not rewritten', async () => {
    const r = await renewing({ days: 90 });
    const work = tmp();
    const forged = signClientDated({ ...makeForgerCa(work), keyId: r.person.keyId, from: Date.now() - 100 * DAY, to: Date.now() - 5 * DAY, serial: `0x${new X509Certificate(r.p.person.cert).serialNumber}` });
    const h = await runHelper(configFor({ ...r.p, person: { ...forged, info: describeCert(forged.cert) } }, r.url), r.url);
    const before = fs.readFileSync(h.config, 'utf8');
    const a = await viaHelper(h, 'GET', '/api/fleet/sessions/s1/peers');
    expect(a.status).toBe(502);
    expect(a.headers['x-podium-helper-error']).toBe('CERT_EXPIRED');
    expect(r.calls()).toBe(0);
    expect(fs.readFileSync(h.config, 'utf8')).toBe(before);
    expect(await r.live()).toHaveLength(1);
  }, 30_000);

  it('a server that cannot renew right now does not stop the request, and the file is left alone', async () => {
    const r = await renewing({ days: 1 }, { renewStatus: 503 });
    const h = await runHelper(configFor(r.p, r.url), r.url, DUE);
    const before = fs.readFileSync(h.config, 'utf8');
    expect((await viaHelper(h, 'GET', '/api/fleet/sessions/s1/peers')).status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    expect(fs.readFileSync(h.config, 'utf8')).toBe(before);
  }, 30_000);

  it('a 429 is a wait, not a refusal: the request goes through, the file is left alone, and it does not ask again before Retry-After', async () => {
    const r = await renewing({ days: 1 }, { renewStatus: 429, retryAfter: '3600' });
    const original = configFor(r.p, r.url);
    const h = await runHelper(original, r.url, DUE);
    await until(() => r.calls() >= 1, 'it asked once');
    for (let i = 0; i < 3; i++) expect((await viaHelper(h, 'GET', '/api/fleet/sessions/s1/peers')).status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    expect(r.calls()).toBe(1);
    expect(fs.readFileSync(h.config, 'utf8')).toBe(original);
  }, 30_000);

  it('two sessions renewing together leave one valid file and one new certificate', async () => {
    const r = await renewing({ days: 1 });
    const original = configFor(r.p, r.url);
    const a = await runHelper(original, r.url, DUE);
    const b = await runHelper('', r.url, DUE, 0o600, a.config);
    const before = original;
    const [ra, rb] = await Promise.all([viaHelper(a, 'GET', '/api/fleet/sessions/s1/peers'), viaHelper(b, 'GET', '/api/fleet/sessions/s1/peers')]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    await until(() => fs.readFileSync(a.config, 'utf8') !== before, 'the file is rewritten');
    await new Promise((res) => setTimeout(res, 500));
    const f = partsOfFile(a.config);
    const person = new X509Certificate(f.certs.at(-1)!);
    expect(person.checkPrivateKey(createPrivateKey(f.key))).toBe(true);
    expect(f.mode).toBe(0o600);
    // the old certificate and the one new certificate; the second session took the first's instead of making a third
    expect(await r.live()).toHaveLength(2);
    expect((await r.live()).map((c) => c.fingerprint)).toContain(person.fingerprint256);
    expect(fs.readdirSync(path.dirname(a.config)).filter((n) => n.includes('.tmp'))).toEqual([]);
    // both sessions now use the file's certificate
    r.seen.length = 0;
    await viaHelper(a, 'GET', '/api/fleet/sessions/s1/peers');
    await viaHelper(b, 'GET', '/api/fleet/sessions/s1/peers');
    expect(r.seen).toEqual([person.fingerprint256, person.fingerprint256]);
  }, 40_000);

  it('takes over a lock left by a process that died', async () => {
    const r = await renewing({ days: 1 });
    const original = configFor(r.p, r.url);
    const root = tmp();
    const config = path.join(root, 'reporter-config-Dana-1.pem');
    fs.writeFileSync(config, original, { mode: 0o600 });
    // a lock from ten minutes ago, left by a process that died before it could remove it
    const lock = `${config}.lock.7`;
    fs.writeFileSync(lock, '99999999');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);
    await runHelper('', r.url, DUE, 0o600, config);
    await until(() => fs.readFileSync(config, 'utf8') !== original, 'renewed past a stale lock');
    await until(() => !fs.existsSync(lock), 'the stale lock is cleared');
  }, 40_000);
});

// ---- a planned CA rotation: the new CA arrives as an addition, vouched for by a cross certificate (#588) -----------------

type Variant = 'ok' | 'stranger-cross' | 'key-mismatch' | 'no-rotation' | 'extra-only' | 'expired-cross' | 'unheld-no-rotation';

/** A renew route that signs the helper's new key with a NEW CA and answers with `rotation`, the way the server will during a planned rotation. */
async function rotating(variant: Variant) {
  const p = await pki();
  const work = tmp();
  const run = (...a: string[]) => execFileSync('openssl', a, { cwd: work });
  const subj = '/CN=Podium CA 2/O=podium';
  fs.writeFileSync(path.join(work, 'ca.cnf'), '[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n');
  fs.writeFileSync(path.join(work, 'leaf.cnf'), '[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n');
  run('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'new.key');
  run('req', '-new', '-x509', '-key', 'new.key', '-subj', subj, '-config', 'ca.cnf', '-extensions', 'v3_ca', '-days', '3650', '-out', 'new.crt');
  run('req', '-new', '-key', 'new.key', '-subj', subj, '-out', 'new.csr');
  // the cross certificate: the new CA's name and key, signed by the old CA (or by a stranger's)
  const signer = variant === 'stranger-cross' ? makeForgerCa(work) : { caCrt: path.join(p.dir, 'ca.crt'), caKey: path.join(p.dir, 'ca.key') };
  if (variant === 'expired-cross') signDated(work, { csr: 'new.csr', caCrt: signer.caCrt, caKey: signer.caKey, extFile: 'ca.cnf', ext: 'v3_ca', from: Date.now() - 20 * DAY, to: Date.now() - 10 * DAY, out: 'cross.crt' });
  else run('x509', '-req', '-in', 'new.csr', '-CA', signer.caCrt, '-CAkey', signer.caKey, '-days', '365', '-extfile', 'ca.cnf', '-extensions', 'v3_ca', '-out', 'cross.crt');
  // a second CA with the same name but another key, to put in the rotation in place of the one the cross certificate vouches for
  run('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'other.key');
  run('req', '-new', '-x509', '-key', 'other.key', '-subj', subj, '-config', 'ca.cnf', '-extensions', 'v3_ca', '-days', '3650', '-out', 'other.crt');
  const read = (n: string) => fs.readFileSync(path.join(work, n), 'utf8');
  const newCa = read('new.crt');
  const cross = read('cross.crt');
  let calls = 0;
  const url = await upstream(p, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      fs.writeFileSync(path.join(work, 'pub.pem'), (JSON.parse(body) as { publicKey: string }).publicKey);
      const [crt, key] = variant === 'no-rotation' || variant === 'extra-only' ? [path.join(p.dir, 'ca.crt'), path.join(p.dir, 'ca.key')] : ['new.crt', 'new.key'];
      run('x509', '-new', '-force_pubkey', 'pub.pem', '-subj', '/CN=pdm_a1b2c3d4e5f6/O=podium', '-CA', crt, '-CAkey', key, '-days', '90', '-extfile', 'leaf.cnf', '-extensions', 'v3', '-out', 'leaf.crt');
      const cert = read('leaf.crt');
      const x = new X509Certificate(cert);
      const rotation = variant === 'no-rotation' || variant === 'unheld-no-rotation' ? undefined : { ca: variant === 'key-mismatch' ? read('other.crt') : newCa, cross };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, cert, ca: p.caCert, expires: x.validTo, fingerprint: x.fingerprint256, ...(rotation ? { rotation } : {}) }));
    });
  }, { requireClient: false });
  const issued = await issuePersonCert({ dir: p.dir, keyId: 'a1b2c3d4e5f6', days: 1 });
  p.person = { cert: issued.cert, key: issued.key, info: describeCert(issued.cert) };
  return { p, url, newCa, calls: () => calls, original: configFor(p, url) };
}

const caFingerprints = (file: string) =>
  partsOfFile(file).certs.filter((c) => new X509Certificate(c).ca).map((c) => new X509Certificate(c).fingerprint256);

describe('helper.mjs: a planned CA rotation (#588)', () => {
  const DUE = { PODIUM_RENEW_BEFORE_SECONDS: String(2 * 86_400) };
  const refused = async (variant: Variant) => {
    const r = await rotating(variant);
    const h = await runHelper(r.original, r.url, DUE);
    await until(() => r.calls() > 0 && h.out().includes('renewal failed'), 'the renewal is refused');
    return { r, h };
  };

  it('adds the new CA to the file beside the old one, with the renewed certificate, and does not store the cross certificate', async () => {
    const r = await rotating('ok');
    const h = await runHelper(r.original, r.url, DUE);
    await until(() => fs.readFileSync(h.config, 'utf8') !== r.original, 'the file is rewritten');
    const f = partsOfFile(h.config);
    const cas = caFingerprints(h.config);
    expect(cas).toEqual([new X509Certificate(r.p.caCert).fingerprint256, new X509Certificate(r.newCa).fingerprint256]);
    expect(f.certs).toHaveLength(3);
    const person = new X509Certificate(f.certs.at(-1)!);
    expect(person.verify(new X509Certificate(r.newCa).publicKey)).toBe(true);
    expect(person.checkPrivateKey(createPrivateKey(f.key))).toBe(true);
    expect(f.mode).toBe(0o600);
  }, 30_000);

  it('still adds the new CA when the renewed certificate is signed by a CA the file already holds', async () => {
    const r = await rotating('extra-only');
    const h = await runHelper(r.original, r.url, DUE);
    await until(() => fs.readFileSync(h.config, 'utf8') !== r.original, 'the file is rewritten');
    expect(caFingerprints(h.config)).toEqual([new X509Certificate(r.p.caCert).fingerprint256, new X509Certificate(r.newCa).fingerprint256]);
  }, 30_000);

  it('refuses a cross certificate no held CA signed, and leaves the file as it was', async () => {
    const { r, h } = await refused('stranger-cross');
    expect(fs.readFileSync(h.config, 'utf8')).toBe(r.original);
  }, 30_000);

  it('refuses a rotation whose CA is not the one the cross certificate vouches for, and leaves the file as it was', async () => {
    const { r, h } = await refused('key-mismatch');
    expect(fs.readFileSync(h.config, 'utf8')).toBe(r.original);
  }, 30_000);

  it('refuses an expired cross certificate, and leaves the file as it was', async () => {
    const { r, h } = await refused('expired-cross');
    expect(fs.readFileSync(h.config, 'utf8')).toBe(r.original);
  }, 30_000);

  it('without a rotation, a certificate signed by a CA the file does not hold is still refused', async () => {
    const { r, h } = await refused('unheld-no-rotation');
    expect(fs.readFileSync(h.config, 'utf8')).toBe(r.original);
  }, 30_000);

  it('without a rotation, renews as before', async () => {
    const r = await rotating('no-rotation');
    const h = await runHelper(r.original, r.url, DUE);
    await until(() => fs.readFileSync(h.config, 'utf8') !== r.original, 'the file is rewritten');
    expect(caFingerprints(h.config)).toEqual([new X509Certificate(r.p.caCert).fingerprint256]);
  }, 30_000);
});

describe('helper.mjs: withLock (#611, #616)', () => {
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

  const stale = (file: string, content = 'dead-owner') => {
    fs.writeFileSync(file, content);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(file, old, old);
  };
  type WithLock = (lock: string, fn: () => Promise<string>, waitMs?: number, staleMs?: number) => Promise<{ value: string } | null>;
  const loadWithLock = async () => ((await import(/* @vite-ignore */ HELPER)) as { withLock: WithLock }).withLock;
  const files = (dir: string) => fs.readdirSync(dir).filter((n) => !n.endsWith('.scheme')).sort();

  // A helper of the T7 kind: the plain `<lock>` file with O_EXCL, a stale one removed by its age, nothing else.
  const OLD_CHILD = `
    import fs from 'node:fs';
    const [lock, marker, go] = process.argv.slice(1);
    fs.writeFileSync(go + '.ready-' + process.pid, '');
    while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 1));
    let out = 'timeout';
    for (let i = 0; i < 600; i++) {
      try {
        const fd = fs.openSync(lock, 'wx', 0o600); fs.writeSync(fd, 'old:' + process.pid); fs.closeSync(fd);
      } catch (e) { await new Promise((r) => setTimeout(r, 20)); continue; }
      try { fs.closeSync(fs.openSync(marker, 'wx')); } catch { out = 'violation'; fs.rmSync(lock, { force: true }); break; }
      await new Promise((r) => setTimeout(r, 80));
      fs.rmSync(marker, { force: true });
      fs.rmSync(lock, { force: true });
      out = 'ok';
      break;
    }
    process.stdout.write(out);
  `;

  async function contend(startWith: (lock: string) => void, kids: number, rounds: number, oldKids = 0): Promise<string[]> {
    const results: string[] = [];
    for (let round = 0; round < rounds; round++) {
      const dir = tmp();
      const lock = path.join(dir, 'c.pem.lock');
      const go = path.join(dir, 'go');
      startWith(lock);
      const procs = Array.from({ length: kids + oldKids }, (_, i) => {
        const args = i < kids ? [CHILD, pathToFileURL(HELPER).href, lock, path.join(dir, 'inside'), go] : [OLD_CHILD, lock, path.join(dir, 'inside'), go];
        const proc = spawn(process.execPath, ['--input-type=module', '-e', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        cleanup.push(() => {
          proc.kill('SIGKILL');
        });
        let out = '';
        proc.stdout.on('data', (c) => (out += c));
        return new Promise<string>((resolve) => proc.on('exit', () => resolve(out || 'crashed')));
      });
      await until(() => fs.readdirSync(dir).filter((n) => n.startsWith('go.ready-')).length === kids + oldKids, 'every child is ready', 15_000);
      fs.writeFileSync(go, '');
      results.push(...(await Promise.all(procs)));
      // the lock is let go by aging its file, so one file is left, and it is stale
      const left = files(dir).filter((n) => /\.lock\.\d+$/.test(n));
      expect(files(dir).filter((n) => n.endsWith('.lock'))).toEqual([]);
      expect(left.length).toBeLessThanOrEqual(1);
      if (!left.length) continue;
      expect(Date.now() - fs.statSync(path.join(dir, left[0]!)).mtimeMs).toBeGreaterThan(60_000);
    }
    return results;
  }

  it('lets one waiter in at a time when many find the same stale lock together', async () => {
    expect(await contend((lock) => stale(`${lock}.3`), 8, 6)).toEqual(Array(48).fill('ok'));
  }, 90_000);

  it('lets one waiter in at a time when many find no lock at all', async () => {
    expect(await contend(() => {}, 8, 6)).toEqual(Array(48).fill('ok'));
  }, 90_000);

  it('takes the next number over a stale lock and removes the dead owner’s file', async () => {
    const withLock = await loadWithLock();
    const dir = tmp();
    const lock = path.join(dir, 'c.pem.lock');
    stale(`${lock}.2`);
    stale(`${lock}.5`);
    let during: string[] = [];
    const got = await withLock(lock, async () => {
      during = files(dir);
      return 'in';
    });
    expect(got).toEqual({ value: 'in' });
    expect(during).toEqual(['c.pem.lock', 'c.pem.lock.6']);
    expect(files(dir)).toEqual(['c.pem.lock.6']);
  });

  it('never gives out a number twice: a waiter working from an old reading cannot be handed one that was held and released since', async () => {
    const withLock = await loadWithLock();
    const dir = tmp();
    const lock = path.join(dir, 'c.pem.lock');
    stale(`${lock}.1`);
    // This waiter reads generation 1 as stale. Before it acts, another holder takes generation 2, finishes and lets go (an aged file).
    const real = fs.statSync;
    let swapped = false;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((...a: Parameters<typeof fs.statSync>) => {
      const st = real(...a);
      if (!swapped && String(a[0]) === `${lock}.1`) {
        swapped = true;
        fs.rmSync(`${lock}.1`);
        stale(`${lock}.2`, 'finished-owner');
      }
      return st;
    }) as typeof fs.statSync);
    let during: string[] = [];
    const got = await withLock(lock, async () => {
      during = files(dir);
      return 'in';
    });
    spy.mockRestore();
    expect(swapped).toBe(true);
    expect(got).toEqual({ value: 'in' });
    expect(during).toEqual(['c.pem.lock', 'c.pem.lock.3']);
  });

  it('numbers climb with each taking, and only the newest file is kept', async () => {
    const withLock = await loadWithLock();
    const dir = tmp();
    const lock = path.join(dir, 'c.pem.lock');
    for (const n of [1, 2, 3]) {
      await withLock(lock, async () => 'in');
      expect(files(dir)).toEqual([`c.pem.lock.${n}`]);
    }
  });

  it('leaves alone a lock another waiter made over the stale one, between this waiter reading it and acting', async () => {
    const withLock = await loadWithLock();
    const dir = tmp();
    const lock = path.join(dir, 'c.pem.lock');
    stale(`${lock}.1`);
    // This waiter reads generation 1 as stale; before it acts, another takes it over, so generation 2 exists and is fresh.
    const real = fs.statSync;
    let swapped = false;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((...a: Parameters<typeof fs.statSync>) => {
      const st = real(...a);
      if (!swapped && String(a[0]) === `${lock}.1`) {
        swapped = true;
        fs.writeFileSync(`${lock}.2`, 'fresh-owner');
      }
      return st;
    }) as typeof fs.statSync);
    let ran = false;
    const got = await withLock(lock, async () => void (ran = true) as unknown as string, 400);
    spy.mockRestore();
    expect(swapped).toBe(true);
    expect(ran).toBe(false);
    expect(got).toBeNull();
    expect(fs.readFileSync(`${lock}.2`, 'utf8')).toBe('fresh-owner');
  });

  it('takes over a stale plain lock an older helper left, and never touches its .takeover marker', async () => {
    const withLock = await loadWithLock();
    const dir = tmp();
    const lock = path.join(dir, 'c.pem.lock');
    stale(lock, 'old-plain-lock');
    stale(`${lock}.takeover`, 'old-marker');
    let during = '';
    const got = await withLock(lock, async () => {
      during = fs.readFileSync(lock, 'utf8');
      return 'in';
    }, 2000);
    expect(got).toEqual({ value: 'in' });
    expect(during).not.toBe('old-plain-lock');
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readFileSync(`${lock}.takeover`, 'utf8')).toBe('old-marker');
  });

  describe('across lock schemes (#621)', () => {
    it('waits for a live plain lock held by an older helper, and does not run', async () => {
      const withLock = await loadWithLock();
      const dir = tmp();
      const lock = path.join(dir, 'c.pem.lock');
      fs.writeFileSync(lock, 'old:1234');
      let ran = false;
      const got = await withLock(lock, async () => void (ran = true) as unknown as string, 400);
      expect(got).toBeNull();
      expect(ran).toBe(false);
      expect(fs.readFileSync(lock, 'utf8')).toBe('old:1234');
    });

    it('goes ahead when the older helper lets go of its plain lock', async () => {
      const withLock = await loadWithLock();
      const lock = path.join(tmp(), 'c.pem.lock');
      fs.writeFileSync(lock, 'old:1234');
      setTimeout(() => fs.rmSync(lock), 200);
      const got = await withLock(lock, async () => 'in', 3000);
      expect(got).toEqual({ value: 'in' });
    });

    it('holds the plain lock while it works, so an older helper’s O_EXCL fails, and lets go of it after', async () => {
      const withLock = await loadWithLock();
      const lock = path.join(tmp(), 'c.pem.lock');
      let oldTakes = '';
      await withLock(lock, async () => {
        try {
          fs.closeSync(fs.openSync(lock, 'wx'));
          oldTakes = 'took it';
        } catch (err) {
          oldTakes = (err as NodeJS.ErrnoException).code ?? '';
        }
        return 'in';
      });
      expect(oldTakes).toBe('EEXIST');
      expect(fs.existsSync(lock)).toBe(false);
    });

    it('refreshes the plain lock too while it works, so an older helper does not take it for dead', async () => {
      const withLock = await loadWithLock();
      const lock = path.join(tmp(), 'c.pem.lock');
      let age = Number.POSITIVE_INFINITY;
      await withLock(lock, async () => {
        await new Promise((r) => setTimeout(r, 700));
        age = Date.now() - fs.statSync(lock).mtimeMs;
        return 'in';
      }, 3000, 300);
      expect(age).toBeLessThan(250);
    });

    it('lets one in at a time when helpers of both kinds start together on no lock', async () => {
      expect(await contend(() => {}, 4, 6, 4)).toEqual(Array(48).fill('ok'));
    }, 120_000);

    it('lets one in at a time when helpers of both kinds start together on a stale plain lock', async () => {
      // the older helpers cannot clear it (they only wait), so only the newer ones get in; they must not run together
      const results = await contend((lock) => stale(lock, 'dead-old'), 6, 4, 0);
      expect(results).toEqual(Array(24).fill('ok'));
    }, 120_000);

    describe('the scheme marker', () => {
      it('is written as 2 when absent, and raised from 1', async () => {
        const withLock = await loadWithLock();
        const dir = tmp();
        const lock = path.join(dir, 'c.pem.lock');
        await withLock(lock, async () => 'in');
        expect(fs.readFileSync(`${lock}.scheme`, 'utf8').trim()).toBe('2');
        fs.writeFileSync(`${lock}.scheme`, '1\n');
        await withLock(lock, async () => 'in');
        expect(fs.readFileSync(`${lock}.scheme`, 'utf8').trim()).toBe('2');
        fs.writeFileSync(`${lock}.scheme`, 'garbage');
        await withLock(lock, async () => 'in');
        expect(fs.readFileSync(`${lock}.scheme`, 'utf8').trim()).toBe('2');
      });

      it('makes a helper that does not know the scheme refuse, with a code, and take no lock', async () => {
        const withLock = await loadWithLock();
        const dir = tmp();
        const lock = path.join(dir, 'c.pem.lock');
        fs.writeFileSync(`${lock}.scheme`, '3\n');
        let ran = false;
        await expect(withLock(lock, async () => void (ran = true) as unknown as string)).rejects.toMatchObject({ code: 'LOCK_SCHEME', message: expect.stringMatching(/newer|scheme 3/) });
        expect(ran).toBe(false);
        expect(fs.readdirSync(dir)).toEqual(['c.pem.lock.scheme']);
        expect(fs.readFileSync(`${lock}.scheme`, 'utf8').trim()).toBe('3');
      });
    });
  });

  it('never takes a lock from a holder that is still running, however long it takes', async () => {
    const withLock = await loadWithLock();
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
    expect(files(path.dirname(lock))).toEqual(['c.pem.lock.1']);
  });

  it('a holder that was taken over, or whose file was swept, removes only its own file when it finishes', async () => {
    const withLock = await loadWithLock();
    const dir = tmp();
    const lock = path.join(dir, 'c.pem.lock');
    await withLock(lock, async () => {
      // its own file is swept and a successor already holds the next number
      fs.rmSync(`${lock}.1`);
      fs.writeFileSync(`${lock}.2`, 'successor');
      return 'done';
    });
    expect(files(dir)).toEqual(['c.pem.lock.2']);
    expect(fs.readFileSync(`${lock}.2`, 'utf8')).toBe('successor');
  });

  it('does not start without a folder to put the lock in', async () => {
    const withLock = await loadWithLock();
    await expect(withLock(path.join(tmp(), 'missing', 'c.pem.lock'), async () => 'in', 100)).rejects.toThrow(/ENOENT/);
  });
});

describe('helper.mjs: retryDelayMs', () => {
  it('waits as long as Retry-After says, within the usual retry and a day', async () => {
    const { retryDelayMs } = (await import(/* @vite-ignore */ HELPER)) as { retryDelayMs: (h: unknown, usual?: number) => number };
    expect(retryDelayMs('3000', 60_000)).toBe(3_000_000);
    expect(retryDelayMs(['120'], 60_000)).toBe(120_000);
    expect(retryDelayMs('5', 60_000)).toBe(60_000);
    expect(retryDelayMs('99999999', 60_000)).toBe(86_400_000);
    for (const bad of [undefined, '', 'soon', '-5', '0', 'NaN']) expect(retryDelayMs(bad, 60_000)).toBe(60_000);
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

  it('writes two CAs that parseConfig reads back as two CAs, beside one person certificate and one key', async () => {
    const { rewriteConfig, parseConfig } = (await import(/* @vite-ignore */ HELPER)) as {
      rewriteConfig: (text: string, n: { ca: string[]; cert: string; key: string; notAfter: string; fingerprint: string; now: number }) => string;
      parseConfig: (text: string) => { ca: string[]; cert: string; key: string };
    };
    const p = await pki();
    const second = await pki();
    const out = rewriteConfig(configFor(p, 'https://h:4318'), { ca: [p.caCert, second.caCert], cert: p.person.cert, key: p.person.key, notAfter: p.person.info.notAfter, fingerprint: p.person.info.fingerprintSha256, now: Date.now() });
    const got = parseConfig(out);
    expect(got.ca.map((c) => new X509Certificate(c).fingerprint256)).toEqual([p.caCert, second.caCert].map((c) => new X509Certificate(c).fingerprint256));
    expect(new X509Certificate(got.cert).fingerprint256).toBe(new X509Certificate(p.person.cert).fingerprint256);
  });
});

describe('helper.mjs: the mailbox mode, used where there is no Unix socket (#834)', () => {
  interface Box {
    proc: ChildProcess;
    dir: string;
    out: () => string;
    exited: Promise<number | null>;
  }

  /** Starts the helper with `mailbox:<dir>` in place of a socket path; resolves once it prints `ready` or exits. */
  async function runBox(p: Pki, server: string, before?: (dir: string) => void): Promise<Box> {
    const root = tmp();
    const config = path.join(root, 'reporter-config-Dana-1.pem');
    fs.writeFileSync(config, configFor(p, server), { mode: 0o600 });
    const dir = path.join(root, 'run', 'box');
    if (before) {
      fs.mkdirSync(dir, { recursive: true });
      before(dir);
    }
    const proc = spawn(process.execPath, [HELPER, config, `mailbox:${dir}`, server], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    return { proc, dir, out: () => out, exited };
  }

  const request = (id: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ id, method: 'GET', path: '/api/fleet/sessions/s1/peers', headers: {}, body: '', ...over });

  /** The decoded `res <id> <base64>` line for `id`, waiting for it. */
  async function answer(b: Box, id: string, ms = 3000): Promise<{ status: number; headers: Record<string, string>; body: string } | null> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const line = b.out().split('\n').find((l) => l.startsWith(`res ${id} `));
      if (line) return JSON.parse(Buffer.from(line.slice(`res ${id} `.length), 'base64').toString('utf8'));
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  }

  it('answers a request file with a res line, over the person’s certificate, and removes the file', async () => {
    const p = await pki();
    const seen: string[] = [];
    const url = await upstream(p, (req, res, peer) => {
      seen.push(peer?.fingerprint256 ?? 'none');
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json', 'x-extra': 'kept' });
        res.end(JSON.stringify({ path: req.url, method: req.method, echoed: b, type: req.headers['content-type'] }));
      });
    });
    const b = await runBox(p, url);
    expect(b.out()).toContain('ready');
    fs.writeFileSync(path.join(b.dir, 'req-1.json'), request('1', { method: 'POST', path: '/api/fleet/report?x=1', headers: { 'content-type': 'application/json' }, body: '{"a":"é"}' }));
    const a = await answer(b, '1');
    expect(a?.status).toBe(201);
    expect(a?.headers['x-extra']).toBe('kept');
    expect(JSON.parse(a!.body)).toEqual({ path: '/api/fleet/report?x=1', method: 'POST', echoed: '{"a":"é"}', type: 'application/json' });
    expect(seen).toEqual([new X509Certificate(p.person.cert).fingerprint256]);
    expect(fs.readdirSync(b.dir)).toEqual([]);
  });

  it('refuses a route the helper does not forward, as the socket mode does', async () => {
    const p = await pki();
    const url = await upstream(p, (_req, res) => res.end('{}'));
    const b = await runBox(p, url);
    fs.writeFileSync(path.join(b.dir, 'req-2.json'), request('2', { path: '/api/admin/settings' }));
    const a = await answer(b, '2');
    expect(a?.status).toBe(403);
    expect(a?.headers['x-podium-helper-error']).toBe('ROUTE_NOT_ALLOWED');
  });

  it('waits for a request file that is not all written yet, then answers it', async () => {
    const p = await pki();
    const url = await upstream(p, (_req, res) => res.end('{"ok":true}'));
    const b = await runBox(p, url);
    const file = path.join(b.dir, 'req-3.json');
    const whole = request('3');
    fs.writeFileSync(file, whole.slice(0, 20));
    expect(await answer(b, '3', 600)).toBeNull();
    fs.writeFileSync(file, whole);
    expect((await answer(b, '3'))?.status).toBe(200);
  });

  it('ignores a request that is not one, removes it, and keeps working', async () => {
    const p = await pki();
    const url = await upstream(p, (_req, res) => res.end('{}'));
    const b = await runBox(p, url);
    fs.writeFileSync(path.join(b.dir, 'req-4.json'), JSON.stringify({ id: '../x', method: 'GET', path: '/api/fleet/sessions/s1/peers' }));
    fs.writeFileSync(path.join(b.dir, 'req-5.json'), request('5'));
    expect((await answer(b, '5'))?.status).toBe(200);
    expect(b.out()).not.toContain('res ../x');
    expect(fs.readdirSync(b.dir)).toEqual([]);
  });

  it('sets the content type itself and ignores any header in the file', async () => {
    const p = await pki();
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const url = await upstream(p, (req, res) => {
      seen.push({ type: req.headers['content-type'], other: req.headers['x-other'], token: req.headers['x-podium-token'] });
      res.end('{}');
    });
    const b = await runBox(p, url);
    fs.writeFileSync(path.join(b.dir, 'req-6.json'), request('6', { method: 'POST', path: '/api/fleet/report', headers: { 'content-type': 'text/evil', 'x-other': 'one\r\nx-b: two', 'X-Podium-Token': 'secret' }, body: '{}' }));
    expect((await answer(b, '6'))?.status).toBe(200);
    expect(seen).toEqual([{ type: 'application/json', other: undefined, token: undefined }]);
  });

  it('answers 400 to a request whose method, path or body is not text, and sends nothing upstream', async () => {
    const p = await pki();
    let hits = 0;
    const url = await upstream(p, (_req, res) => {
      hits++;
      res.end('{}');
    });
    const b = await runBox(p, url);
    fs.writeFileSync(path.join(b.dir, 'req-7.json'), request('7', { body: 5 }));
    fs.writeFileSync(path.join(b.dir, 'req-9.json'), request('9', { path: 7 }));
    for (const id of ['7', '9']) {
      const a = await answer(b, id);
      expect(a?.status).toBe(400);
      expect(a?.headers['x-podium-helper-error']).toBe('BAD_REQUEST');
    }
    expect(hits).toBe(0);
  });

  it('forwards the route the helper rebuilt from its list, not the text in the file', async () => {
    const p = await pki();
    const seen: string[] = [];
    const url = await upstream(p, (req, res) => {
      seen.push(req.url ?? '');
      res.end('{}');
    });
    const b = await runBox(p, url);
    fs.writeFileSync(path.join(b.dir, 'req-8.json'), request('8', { path: '/API/fleet/Sessions/s1/peers/' }));
    expect((await answer(b, '8'))?.status).toBe(200);
    expect(seen).toEqual(['/api/fleet/sessions/s1/peers']);
  });

  it('removes requests left by an earlier helper instead of sending them', async () => {
    const p = await pki();
    let hits = 0;
    const url = await upstream(p, (_req, res) => {
      hits++;
      res.end('{}');
    });
    const b = await runBox(p, url, (dir) => fs.writeFileSync(path.join(dir, 'req-old.json'), request('old')));
    expect(b.out()).toContain('ready');
    await new Promise((r) => setTimeout(r, 400));
    expect(fs.readdirSync(b.dir)).toEqual([]);
    expect(hits).toBe(0);
    expect(b.out()).not.toContain('res old');
  });

  it('a named-pipe address is no longer an option: the helper takes a socket path or a mailbox', async () => {
    const { isMailbox } = (await import(/* @vite-ignore */ HELPER)) as { isMailbox: (a: string) => string | null };
    expect(isMailbox('mailbox:C:\\Users\\d\\.podium\\run\\ab')).toBe('C:\\Users\\d\\.podium\\run\\ab');
    expect(isMailbox('/home/d/.podium/run/12345678.sock')).toBeNull();
  });
});
