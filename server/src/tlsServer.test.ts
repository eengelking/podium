import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostCheck } from './hostCheck.js';
import { createLogger } from './logging/logger.js';
import { issuePersonCert } from './tlsPeople.js';
import { publicTlsPort, shortReason, startTls, tlsPortFrom } from './tlsServer.js';
import { freePort, makeForgerCa, signClientDated, startTlsForTest } from './tlsTesting.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-tlsserver-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ format: 'json', write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
  const app = express();
  app.use(hostCheck({ bind: '127.0.0.1', allowed: ['podium.lan'] }));
  app.get('/api/fleet/sessions/s1/peers', (req, res) => res.json({ proto: req.protocol }));
  return { root, dataDir: root, lines, logger, app };
}

const get = (port: number, ca: string, host: string, servername = 'localhost', client?: { cert: string; key: string }) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = https.get({ host: '127.0.0.1', port, ca, servername, headers: { host }, path: '/api/fleet/sessions/s1/peers', ...(client ?? {}) }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });

describe('tlsPortFrom', () => {
  it('defaults to 4318 and accepts a port', () => {
    expect(tlsPortFrom(undefined, 4317)).toEqual({ port: 4318 });
    expect(tlsPortFrom('', 4317)).toEqual({ port: 4318 });
    expect(tlsPortFrom('9443', 4317)).toEqual({ port: 9443 });
  });
  it('refuses a value that is not a port or is the HTTP port', () => {
    expect(tlsPortFrom('abc', 4317)).toMatchObject({ error: expect.stringContaining('not a port') });
    expect(tlsPortFrom('70000', 4317)).toHaveProperty('error');
    expect(tlsPortFrom('4317', 4317)).toMatchObject({ error: expect.stringContaining('same as the HTTP port') });
  });
});

describe('publicTlsPort', () => {
  it('is the port people reach the server on: the public one when set, else the listening one', () => {
    expect(publicTlsPort(undefined, 4318)).toBe(4318);
    expect(publicTlsPort('', 4318)).toBe(4318);
    expect(publicTlsPort('5318', 4318)).toBe(5318);
  });
  it('ignores a value that is not a port', () => {
    expect(publicTlsPort('abc', 4318)).toBe(4318);
    expect(publicTlsPort('70000', 4318)).toBe(4318);
  });
});

describe('shortReason', () => {
  it('keeps the reason of an OpenSSL error and nothing else, and leaves any other message alone (#672)', () => {
    const raw = '807F90F401000000:error:0A0000C7:SSL routines:tls_process_client_certificate:peer did not return a certificate:../deps/openssl/openssl/ssl/statem/statem_srvr.c:3510:';
    expect(shortReason(raw)).toBe('peer did not return a certificate');
    expect(shortReason('socket hang up')).toBe('socket hang up');
  });
});

describe('startTls', () => {
  it('does nothing unless PODIUM_TLS is on', async () => {
    const s = setup();
    for (const env of [{}, { PODIUM_TLS: 'off' }, { PODIUM_TLS: 'yes' }]) {
      expect(await startTls({ env, app: s.app, dataDir: s.dataDir, bind: '127.0.0.1', httpPort: 4317, allowedHosts: [], logger: s.logger })).toBeNull();
    }
    expect(fs.existsSync(path.join(s.root, 'tls'))).toBe(false);
  });

  it('serves the app over HTTPS with the Host check, and keeps the same CA after a restart', async () => {
    const s = setup();
    const first = await startTlsForTest({ app: s.app, dataDir: s.dataDir, allowedHosts: ['podium.lan'], logger: s.logger });
    const port = first.port;
    const person = await issuePersonCert({ dir: path.join(s.root, 'tls'), keyId: 'aaaaaaaaaaaa' });
    try {
      await expect(get(port, first.material.caCert, 'localhost', 'localhost', person)).resolves.toEqual({ status: 200, body: '{"proto":"https"}' });
      await expect(get(port, first.material.caCert, 'podium.lan', 'podium.lan', person)).resolves.toMatchObject({ status: 200 });
      // The Host check applies on this listener too: a name that is not ours is refused.
      await expect(get(port, first.material.caCert, 'evil.example', 'localhost', person)).resolves.toMatchObject({ status: 403 });
      // A name that is not on the certificate fails verification.
      await expect(get(port, first.material.caCert, 'evil.example', 'evil.example', person)).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    } finally {
      await new Promise((r) => first.server.close(r));
    }
    // `startTlsForTest` retries a port another test file took first and logs `tls.failed` for it; that is not part of what this checks.
    expect(s.lines.map((l) => l.event).filter((e) => e !== 'tls.failed')).toEqual(['tls.ca_created', 'tls.serving_created', 'tls.listening']);
    // The line for the operator names the CA by whole bytes of its fingerprint and says when it ends.
    expect(s.lines.at(-1)!.message).toMatch(/for reporters \(CA ([0-9A-F]{2}:){7}[0-9A-F]{2}, expires \d{4}-/);

    const second = await startTlsForTest({ app: s.app, dataDir: s.dataDir, allowedHosts: ['podium.lan'], logger: s.logger });
    try {
      expect(second.material.ca).toEqual(first.material.ca);
      expect(second.material.serving).toEqual(first.material.serving);
      expect(s.lines.filter((l) => l.event === 'tls.ca_created')).toHaveLength(1);
    } finally {
      await new Promise((r) => second.server.close(r));
    }
  });

  it('logs a server error after it is listening instead of letting it escape', async () => {
    const s = setup();
    const l = await startTlsForTest({ app: s.app, dataDir: s.dataDir, logger: s.logger });
    try {
      l.server.emit('error', new Error('boom'));
      l.server.emit('tlsClientError', new Error('bad handshake'), { destroy() {} });
      expect(s.lines.find((x) => x.event === 'tls.server_error')).toMatchObject({ level: 'error', reason: 'boom' });
      expect(s.lines.find((x) => x.event === 'tls.handshake_failed')).toMatchObject({ level: 'warn', reason: 'bad handshake' });
    } finally {
      await new Promise((r) => l.server.close(r));
    }
  });

  it('names the reason and the source of a failed handshake, and words repeats alike so the text log folds them (#672)', async () => {
    const s = setup();
    const l = await startTlsForTest({ app: s.app, dataDir: s.dataDir, logger: s.logger });
    try {
      const fail = (message: string, code: string | undefined, remoteAddress: string) =>
        l.server.emit('tlsClientError', Object.assign(new Error(message), { code }), { remoteAddress, destroy() {} });
      fail('tlsv1 alert unknown ca', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', '192.0.2.5');
      fail('tlsv1 alert unknown ca', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', '192.0.2.6');
      fail('socket hang up', undefined, '192.0.2.7');
      const [first, second, third] = s.lines.filter((x) => x.event === 'tls.handshake_failed');
      expect(first).toMatchObject({ level: 'warn', reason: 'tlsv1 alert unknown ca', code: 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', remote: '192.0.2.5' });
      expect(first!.message).toContain('ERR_SSL_TLSV1_ALERT_UNKNOWN_CA');
      expect(first!.message).toContain('tlsv1 alert unknown ca');
      expect(first!.message).not.toContain('192.0.2.5');
      expect(second!.message).toBe(first!.message);
      expect(third).toMatchObject({ reason: 'socket hang up', remote: '192.0.2.7' });
      expect(third!.message).not.toContain('undefined');
    } finally {
      await new Promise((r) => l.server.close(r));
    }
  });

  it('logs tls.failed and returns null for a bad port, a bad CA folder, or a port in use', async () => {
    const s = setup();
    const base = { app: s.app, dataDir: s.dataDir, bind: '127.0.0.1', httpPort: 4317, allowedHosts: [], logger: s.logger };
    expect(await startTls({ ...base, env: { PODIUM_TLS: 'on', PODIUM_TLS_PORT: 'x' } })).toBeNull();

    fs.mkdirSync(path.join(s.root, 'tls'));
    fs.writeFileSync(path.join(s.root, 'tls', 'ca.key'), 'key only');
    expect(await startTls({ ...base, env: { PODIUM_TLS: 'on', PODIUM_TLS_PORT: String(await freePort()) } })).toBeNull();
    expect(fs.readFileSync(path.join(s.root, 'tls', 'ca.key'), 'utf8')).toBe('key only');
    fs.rmSync(path.join(s.root, 'tls'), { recursive: true });

    const blocker = http.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    cleanup.push(() => blocker.close());
    const busy = (blocker.address() as { port: number }).port;
    expect(await startTls({ ...base, env: { PODIUM_TLS: 'on', PODIUM_TLS_PORT: String(busy) } })).toBeNull();

    const failed = s.lines.filter((l) => l.event === 'tls.failed');
    expect(failed).toHaveLength(3);
    expect(String(failed[0].reason)).toMatch(/not a port/);
    expect(String(failed[1].reason)).toMatch(/ca.key but no ca.crt/);
    expect(String(failed[2].reason)).toMatch(/EADDRINUSE/);
  });
});

describe('the reporter port is mutual TLS only (#665)', () => {
  const DAY = 86_400_000;
  type Client = { cert: string; key: string } | undefined;
  const call = (port: number, ca: string, client: Client, method: string, p: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port, ca, servername: 'localhost', method, path: p, agent: false, ...(client ?? {}) }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });

  async function start() {
    const s = setup();
    s.app.post('/api/fleet/report', (_req, res) => res.json({ ok: true }));
    s.app.post('/api/reporter/renew', (_req, res) => res.json({ ok: true }));
    s.app.get('/api/fleet/sessions', (_req, res) => res.json({ console: true }));
    const l = await startTlsForTest({ app: s.app, dataDir: s.dataDir, logger: s.logger });
    const port = l.port;
    cleanup.push(() => l.server.close());
    const dir = path.join(s.root, 'tls');
    const person = await issuePersonCert({ dir, keyId: 'aaaaaaaaaaaa' });
    return { s, l, port, dir, ca: l.trust.currentCa(), person };
  }

  it('answers a client certificate Podium issued, on the reporter routes and the renewal route', async () => {
    const { port, ca, person } = await start();
    await expect(call(port, ca, person, 'POST', '/api/fleet/report')).resolves.toEqual({ status: 200, body: '{"ok":true}' });
    await expect(call(port, ca, person, 'POST', '/api/reporter/renew')).resolves.toEqual({ status: 200, body: '{"ok":true}' });
  });

  it('refuses every other route, the console included, even to a valid client certificate', async () => {
    const { port, ca, person } = await start();
    const refused = await call(port, ca, person, 'GET', '/api/fleet/sessions');
    expect(refused.status).toBe(404);
    expect(refused.body).not.toContain('console');
    await expect(call(port, ca, person, 'GET', '/ping')).resolves.toMatchObject({ status: 404 });
  });

  it('drops a client with no certificate at the handshake, so no route is reached', async () => {
    const { s, port, ca } = await start();
    await expect(call(port, ca, undefined, 'POST', '/api/fleet/report')).rejects.toBeDefined();
    expect(s.lines.find((x) => x.event === 'tls.handshake_failed')).toBeDefined();
  });

  it('drops an expired certificate at the handshake', async () => {
    const { port, ca, dir } = await start();
    const expired = signClientDated({ caCrt: path.join(dir, 'ca.crt'), caKey: path.join(dir, 'ca.key'), keyId: 'bbbbbbbbbbbb', from: Date.now() - 100 * DAY, to: Date.now() - 10 * DAY });
    await expect(call(port, ca, expired, 'POST', '/api/reporter/renew')).rejects.toBeDefined();
  });

  it('drops a certificate from a CA Podium does not trust at the handshake', async () => {
    const { port, ca, dir } = await start();
    const stranger = signClientDated({ ...makeForgerCa(dir), keyId: 'cccccccccccc', from: Date.now() - DAY, to: Date.now() + 30 * DAY });
    await expect(call(port, ca, stranger, 'POST', '/api/fleet/report')).rejects.toBeDefined();
  });
});

describe('rotating the CA on a running listener (#588)', () => {
  type Auth = { authorized: boolean };
  const authed = (port: number, ca: string, agent: https.Agent, client?: { cert: string; key: string }) =>
    new Promise<Auth>((resolve, reject) => {
      const req = https.get({ host: '127.0.0.1', port, ca, agent, servername: 'localhost', path: '/api/fleet/sessions/s2/peers', ...(client ?? {}) }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body) as Auth));
      });
      req.on('error', reject);
    });

  async function start() {
    const s = setup();
    s.app.get('/api/fleet/sessions/s2/peers', (req, res) => res.json({ authorized: (req.socket as unknown as { authorized: boolean }).authorized }));
    const l = await startTlsForTest({ app: s.app, dataDir: s.dataDir, logger: s.logger });
    const port = l.port;
    cleanup.push(() => l.server.close());
    const dir = path.join(s.root, 'tls');
    const oldCa = l.trust.currentCa();
    const person = await issuePersonCert({ dir, keyId: 'aaaaaaaaaaaa' });
    return { s, l, port, dir, oldCa, person };
  }

  it('trusts a certificate from each CA during the overlap, from the one source, and the listener, the renewer and the check agree', async () => {
    const { l, port, oldCa, person, dir } = await start();
    const out = await l.rotation.rotate(false);
    expect(out.overlap).toBe(true);
    const fresh = await issuePersonCert({ dir, keyId: 'bbbbbbbbbbbb' });
    const agent = new https.Agent({ keepAlive: false });
    // A client holding only the old CA still verifies the server, and either CA's client certificate is authorized.
    expect(await authed(port, oldCa, agent, person)).toEqual({ authorized: true });
    expect(await authed(port, l.trust.currentCa(), agent, fresh)).toEqual({ authorized: true });
    expect(l.trust.trustedIssuers()).toHaveLength(2);

    // A serving renewal during the overlap keeps both: the CA list and the cross certificate go back into the context.
    await l.renewer.renewNow();
    expect(await authed(port, oldCa, agent, person)).toEqual({ authorized: true });
    expect(await authed(port, l.trust.currentCa(), agent, fresh)).toEqual({ authorized: true });
    expect(l.renewer.view().rotation).not.toBeNull();
    expect(l.renewer.caPem()).toBe(l.trust.currentCa());
  });

  it('retiring the old CA refuses its certificates at once and closes the connection that was open', async () => {
    const { s, l, port, oldCa, person, dir } = await start();
    await l.rotation.rotate(false);
    const fresh = await issuePersonCert({ dir, keyId: 'bbbbbbbbbbbb' });
    const keep = new https.Agent({ keepAlive: true, maxSockets: 1 });
    expect(await authed(port, oldCa, keep, person)).toEqual({ authorized: true });
    const freshAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    expect(await authed(port, l.trust.currentCa(), freshAgent, fresh)).toEqual({ authorized: true });
    const sockets = Object.values(keep.freeSockets).flat();
    expect(sockets).toHaveLength(1);
    const closed = new Promise<void>((r) => sockets[0]!.once('close', () => r()));

    const out = await l.rotation.retire();
    expect(out).toEqual({ closed: 1 });
    await closed;
    // The new CA's client is untouched and the old CA's certificate is dropped at the handshake.
    await expect(authed(port, l.trust.currentCa(), new https.Agent({ keepAlive: false }), person)).rejects.toBeDefined();
    expect(await authed(port, l.trust.currentCa(), freshAgent, fresh)).toEqual({ authorized: true });
    expect(l.trust.trustedIssuers()).toHaveLength(1);
    expect(await l.rotation.retire()).toBeNull();
    expect(s.lines.find((x) => x.event === 'tls.ca_rotated')).toMatchObject({ overlap: true, connections_closed: 0 });
    expect(s.lines.find((x) => x.event === 'tls.ca_retired')).toMatchObject({ connections_closed: 1 });
  });

  it('ending the overlap now refuses every old certificate and closes every connection that held a client certificate', async () => {
    const { l, port, oldCa, person } = await start();
    const keep = new https.Agent({ keepAlive: true, maxSockets: 1 });
    expect(await authed(port, oldCa, keep, person)).toEqual({ authorized: true });
    const sockets = Object.values(keep.freeSockets).flat();
    const closed = new Promise<void>((r) => sockets[0]!.once('close', () => r()));
    const out = await l.rotation.rotate(true);
    expect(out).toMatchObject({ overlap: false, closed: 1 });
    await closed;
    expect(l.trust.previousCa()).toBeNull();
    await expect(authed(port, l.trust.currentCa(), new https.Agent({ keepAlive: false }), person)).rejects.toBeDefined();
    // A client that held only the old CA no longer verifies the server.
    await expect(authed(port, oldCa, new https.Agent({ keepAlive: false }))).rejects.toBeDefined();
  });
});
