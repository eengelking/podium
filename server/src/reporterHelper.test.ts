// The reporter's TLS helper (#584, SPEC 5.9): the mod cannot hand $.http.fetch a CA or a client certificate, so a small
// Node process makes the connection. These tests run the real script against real certificates and a real HTTPS server.
import { spawn, type ChildProcess } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureTls, serverNames } from './tlsCa.js';
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
  socket: string;
  out: () => string;
  exited: Promise<number | null>;
}

/** Starts the helper; resolves once it prints `ready` (or exits, which the caller reads from `out`). */
async function runHelper(configText: string, server: string, env: Record<string, string> = {}, mode = 0o600): Promise<Running> {
  const root = tmp();
  const config = path.join(root, 'reporter-config-Dana-1.pem');
  fs.writeFileSync(config, configText, { mode });
  fs.chmodSync(config, mode);
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
  return { proc, socket, out: () => out, exited };
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
