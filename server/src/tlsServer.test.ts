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
import { startTls, tlsPortFrom, type TlsListener } from './tlsServer.js';

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
  app.get('/ping', (req, res) => res.json({ proto: req.protocol }));
  return { root, dbPath: path.join(root, 'podium.sqlite'), lines, logger, app };
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const get = (port: number, ca: string, host: string, servername = 'localhost') =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = https.get({ host: '127.0.0.1', port, ca, servername, headers: { host }, path: '/ping' }, (res) => {
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

describe('startTls', () => {
  it('does nothing unless PODIUM_TLS is on', async () => {
    const s = setup();
    for (const env of [{}, { PODIUM_TLS: 'off' }, { PODIUM_TLS: 'yes' }]) {
      expect(await startTls({ env, app: s.app, dbPath: s.dbPath, bind: '127.0.0.1', httpPort: 4317, allowedHosts: [], logger: s.logger })).toBeNull();
    }
    expect(fs.existsSync(path.join(s.root, 'tls'))).toBe(false);
  });

  it('serves the app over HTTPS with the Host check, and keeps the same CA after a restart', async () => {
    const s = setup();
    const port = await freePort();
    const env = { PODIUM_TLS: 'on', PODIUM_TLS_PORT: String(port) };
    const base = { env, app: s.app, dbPath: s.dbPath, bind: '127.0.0.1', httpPort: 4317, allowedHosts: ['podium.lan'], logger: s.logger };
    const first = (await startTls(base)) as TlsListener;
    expect(first).not.toBeNull();
    try {
      await expect(get(port, first.material.caCert, 'localhost')).resolves.toEqual({ status: 200, body: '{"proto":"https"}' });
      await expect(get(port, first.material.caCert, 'podium.lan', 'podium.lan')).resolves.toMatchObject({ status: 200 });
      // The Host check applies on this listener too: a name that is not ours is refused.
      await expect(get(port, first.material.caCert, 'evil.example')).resolves.toMatchObject({ status: 403 });
      // A name that is not on the certificate fails verification.
      await expect(get(port, first.material.caCert, 'evil.example', 'evil.example')).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    } finally {
      await new Promise((r) => first.server.close(r));
    }
    expect(s.lines.map((l) => l.event)).toEqual(['tls.ca_created', 'tls.serving_created', 'tls.listening']);

    const second = (await startTls(base)) as TlsListener;
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
    const port = await freePort();
    const l = (await startTls({ env: { PODIUM_TLS: 'on', PODIUM_TLS_PORT: String(port) }, app: s.app, dbPath: s.dbPath, bind: '127.0.0.1', httpPort: 4317, allowedHosts: [], logger: s.logger })) as TlsListener;
    try {
      l.server.emit('error', new Error('boom'));
      l.server.emit('tlsClientError', new Error('bad handshake'), { destroy() {} });
      expect(s.lines.find((x) => x.event === 'tls.server_error')).toMatchObject({ level: 'error', reason: 'boom' });
      expect(s.lines.find((x) => x.event === 'tls.handshake_failed')).toMatchObject({ level: 'warn', reason: 'bad handshake' });
    } finally {
      await new Promise((r) => l.server.close(r));
    }
  });

  it('logs tls.failed and returns null for a bad port, a bad CA folder, or a port in use', async () => {
    const s = setup();
    const base = { app: s.app, dbPath: s.dbPath, bind: '127.0.0.1', httpPort: 4317, allowedHosts: [], logger: s.logger };
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

describe('rotating the CA on a running listener (#588)', () => {
  type Auth = { authorized: boolean };
  const authed = (port: number, ca: string, agent: https.Agent, client?: { cert: string; key: string }) =>
    new Promise<Auth>((resolve, reject) => {
      const req = https.get({ host: '127.0.0.1', port, ca, agent, servername: 'localhost', path: '/auth', ...(client ?? {}) }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body) as Auth));
      });
      req.on('error', reject);
    });

  async function start() {
    const s = setup();
    s.app.get('/auth', (req, res) => res.json({ authorized: (req.socket as unknown as { authorized: boolean }).authorized }));
    const port = await freePort();
    const l = (await startTls({ env: { PODIUM_TLS: 'on', PODIUM_TLS_PORT: String(port) }, app: s.app, dbPath: s.dbPath, bind: '127.0.0.1', httpPort: 4317, allowedHosts: [], logger: s.logger })) as TlsListener;
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
    // The new CA's client is untouched and the old CA's certificate is no longer authorized.
    expect(await authed(port, l.trust.currentCa(), new https.Agent({ keepAlive: false }), person)).toEqual({ authorized: false });
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
    expect(await authed(port, l.trust.currentCa(), new https.Agent({ keepAlive: false }), person)).toEqual({ authorized: false });
    // A client that held only the old CA no longer verifies the server.
    await expect(authed(port, oldCa, new https.Agent({ keepAlive: false }))).rejects.toBeDefined();
  });
});
