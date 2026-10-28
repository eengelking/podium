// A reporter renews its own certificate (#585, SPEC 6 *Authenticating by certificate*). The server takes the reporter's new
// public key, authenticates the request by the current certificate, and answers with a new certificate and the CA(s).
// Renewal needs a valid certificate in the handshake (#665): a reporter listener built with `rejectUnauthorized: true` drops an
// expired, untrusted or missing certificate before any route runs, and an expired certificate is never renewed.
import express from 'express';
import { execFileSync } from 'node:child_process';
import { X509Certificate, generateKeyPairSync, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from './storage/sqlite/index.js';
import { createLogger } from './logging/logger.js';
import { describeCert } from './tlsCa.js';
import { certAuth, type ClientSocket } from './tlsClientAuth.js';
import { issuePersonCert, type IssuedPersonCert } from './tlsPeople.js';
import { authorizeRenewal, createReporterRenewRouter, issueForPublicKey, REPORTER_DEFAULTS, type RenewSocket } from './tlsReporterRenew.js';
import type { TlsListener } from './tlsServer.js';
import { makeForgerCa, signClientDated, startTlsForTest } from './tlsTesting.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-renew-'));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const DAY = 86_400_000;
const pubPem = (k: KeyObject): string => k.export({ type: 'spki', format: 'pem' }).toString();
const newKey = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });

async function setup(o: { lifetimeDays?: number } = {}) {
  const root = tmp();
  const storage = openSqliteStorage(':memory:');
  cleanup.push(() => storage.close());
  const db = storage.sqliteHandle;
  const people = storage.people;
  const certs = storage.personCerts;
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ format: 'json', write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
  let listener: TlsListener | null = null;
  // Two hours ahead by default, so a certificate the test has just issued is past the renewal limit; the limit tests use the real clock.
  let clock = () => Date.now() + 2 * 3_600_000;
  let issuerOn = true;
  let opensslBin: string | undefined;
  const settings = { lifetimeDays: o.lifetimeDays ?? REPORTER_DEFAULTS.lifetimeDays };
  const dir = path.join(root, 'tls');
  const app = express();
  app.use(
    '/api/reporter',
    createReporterRenewRouter({
      certs,
      people,
      tx: storage.tx,
      logger,
      now: () => clock(),
      settings: () => settings,
      trustedIssuers: () => listener?.trust.trustedIssuers() ?? [],
      issuer: () => (listener && issuerOn ? { dir, port: listener.port, caCerts: () => [listener!.trust.currentCa()], rotation: () => listener!.trust.deliverable(), openssl: opensslBin } : null),
    }),
  );
  app.get('/api/fleet/sessions/s1/peers', async (req, res) => {
    const a = await certAuth(req.socket as unknown as ClientSocket, { certs, people, trustedIssuers: () => listener?.trust.trustedIssuers() ?? [], now: () => clock() });
    res.json(a.kind === 'person' ? { kind: a.kind, name: a.person.name } : a);
  });
  listener = await startTlsForTest({ app, dbPath: path.join(root, 'podium.sqlite'), logger });
  const port = listener.port;
  cleanup.push(() => new Promise<void>((r) => { listener!.server.closeAllConnections(); listener!.server.close(() => r()); }));
  const ca = listener.material.caCert;
  /** What the test's clients trust: the CA the server started with, until a test says otherwise. */
  let clientCa: string[] = [ca];

  const personWith = async (name: string) => (await people.createPerson(name)).person;
  const store = (personId: number, i: IssuedPersonCert) => certs.replace(personId, i, Date.now());
  const issueFor = async (name: string, days = 90) => {
    const person = await personWith(name);
    const issued = await issuePersonCert({ dir, keyId: person.keyId, days });
    await store(person.id, issued);
    return { person, issued };
  };
  /** A genuine certificate, signed by the real CA and stored, with the dates given. */
  const issueDated = async (name: string, from: number, to: number) => {
    const person = await personWith(name);
    const pair = signClientDated({ caCrt: path.join(dir, 'ca.crt'), caKey: path.join(dir, 'ca.key'), keyId: person.keyId, from, to });
    const info = describeCert(pair.cert);
    const issued: IssuedPersonCert = { ...pair, info, issuerFingerprint: listener!.material.ca.fingerprintSha256 };
    await store(person.id, issued);
    return { person, issued };
  };

  const post = (c: { cert: string; key: string } | null, body: unknown, route = '/api/reporter/renew') =>
    new Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request(
        { host: '127.0.0.1', port, ca: clientCa, servername: 'localhost', method: 'POST', path: route, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, ...(c ?? {}) },
        (res) => {
          let text = '';
          res.on('data', (x) => (text += x));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  const whoami = (c: { cert: string; key: string }) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, ca: clientCa, servername: 'localhost', path: '/api/fleet/sessions/s1/peers', ...c }, (res) => {
        let text = '';
        res.on('data', (x) => (text += x));
        res.on('end', () => resolve(JSON.parse(text) as Record<string, unknown>));
      }).on('error', reject);
    });
  return { root, dir, db, storage, people, certs, logger, lines, settings, listener, ca, port, issueFor, issueDated, post, whoami, setClock: (f: () => number) => (clock = f), personWith, trustOnlyClients: (c: string[]) => (clientCa = c), setIssuerOn: (on: boolean) => (issuerOn = on), setOpenssl: (b: string) => (opensslBin = b) };
}

describe('issuing a certificate for a public key', () => {
  it('signs the key it was given, for the same name, and is a clientAuth certificate that verifies under the CA', async () => {
    const s = await setup();
    const { person } = await s.issueFor('Dana');
    const k = newKey();
    const out = await issueForPublicKey({ dir: s.dir, keyId: person.keyId, publicKey: pubPem(k.publicKey), days: 90 });
    const x = new X509Certificate(out.cert);
    expect(x.verify(new X509Certificate(s.ca).publicKey)).toBe(true);
    expect(x.publicKey.equals(k.publicKey)).toBe(true);
    expect(x.subject).toContain(`CN=pdm_${person.keyId}`);
    expect(x.keyUsage).toContain('1.3.6.1.5.5.7.3.2');
    expect(x.ca).toBe(false);
    expect(out.issuerFingerprint).toBe(new X509Certificate(s.ca).fingerprint256);
    expect(out.info.fingerprintSha256).toBe(x.fingerprint256);
  });

  it.each([
    ['an RSA key', () => pubPem(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey)],
    ['an EC key on another curve', () => pubPem(generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey)],
    ['text that is not a key', () => 'not a key'],
    ['a private key', () => newKey().privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
  ])('refuses %s', async (_n, make) => {
    const s = await setup();
    const { person } = await s.issueFor('Dana');
    await expect(issueForPublicKey({ dir: s.dir, keyId: person.keyId, publicKey: make(), days: 90 })).rejects.toThrow(/P-256|public key/);
  });
});

describe('both ways of signing a person certificate share one path (#613)', () => {
  const paths = [
    ['issuePersonCert', (dir: string, keyId: string) => issuePersonCert({ dir, keyId })],
    ['issueForPublicKey', (dir: string, keyId: string) => issueForPublicKey({ dir, keyId, publicKey: pubPem(newKey().publicKey) })],
  ] as const;

  it.each(paths)('%s makes the same profile: clientAuth, not a CA, the person subject, signed by the CA, no work folder left', async (_n, make) => {
    const s = await setup();
    const out = await make(s.dir, 'a1b2c3d4e5f6');
    const x = new X509Certificate(out.cert);
    expect(x.subject).toBe('CN=pdm_a1b2c3d4e5f6\nO=podium');
    expect(x.ca).toBe(false);
    expect(x.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
    expect(x.verify(new X509Certificate(s.ca).publicKey)).toBe(true);
    expect(out.issuerFingerprint).toBe(new X509Certificate(s.ca).fingerprint256);
    expect(fs.readdirSync(s.dir).filter((n) => n.startsWith('.new-'))).toEqual([]);
  });

  it.each(paths)('%s refuses a key id that is not 12 hex digits and a folder with no CA', async (_n, make) => {
    const s = await setup();
    await expect(make(s.dir, '../etc/passwd')).rejects.toThrow(/12 hex digits/);
    await expect(make(tmp(), 'a1b2c3d4e5f6')).rejects.toThrow(/no CA to sign with/);
  });
});

describe('authorizeRenewal', () => {
  const sock = (x: { raw: Buffer; fingerprint256: string }, error: string | null): RenewSocket => ({ encrypted: true, authorized: error === null, authorizationError: error, getPeerCertificate: () => x });
  const peer = (pem: string) => ({ raw: new X509Certificate(pem).raw, fingerprint256: new X509Certificate(pem).fingerprint256 });

  async function deps() {
    const s = await setup();
    const ca = new X509Certificate(s.ca);
    return { s, d: { certs: s.certs, people: s.people, trustedIssuers: () => [ca.fingerprint256], now: () => Date.now() } };
  }

  it('lets a live certificate renew', async () => {
    const { s, d } = await deps();
    const { person, issued } = await s.issueFor('Dana');
    const r = await authorizeRenewal(sock(peer(issued.cert), null), d);
    expect(r).toMatchObject({ ok: true });
    expect(r).not.toHaveProperty('expired');
    expect(r.ok && r.person.id).toBe(person.id);
  });

  it('refuses an expired certificate, however genuine: there is no grace', async () => {
    const { s, d } = await deps();
    for (const [i, [from, to]] of [[100, 5], [200, 31], [100, 1]].entries()) {
      const { issued } = await s.issueDated(`Dana ${i}`, Date.now() - from * DAY, Date.now() - to * DAY);
      expect(await authorizeRenewal(sock(peer(issued.cert), 'CERT_HAS_EXPIRED'), d)).toMatchObject({ ok: false, code: 'NOT_TRUSTED' });
    }
  });

  it('refuses a revoked certificate', async () => {
    const { s, d } = await deps();
    const { person, issued } = await s.issueFor('Dana');
    await s.certs.revokeFor(person.id, 'revoked', Date.now());
    expect(await authorizeRenewal(sock(peer(issued.cert), null), d)).toMatchObject({ ok: false, code: 'REVOKED' });
  });

  it('refuses a connection with no certificate, and any verification error', async () => {
    const { s, d } = await deps();
    const { issued } = await s.issueFor('Dana');
    expect(await authorizeRenewal({ encrypted: false }, d)).toMatchObject({ ok: false, code: 'NO_CERTIFICATE' });
    expect(await authorizeRenewal({ encrypted: true, getPeerCertificate: () => ({}) }, d)).toMatchObject({ ok: false, code: 'NO_CERTIFICATE' });
    expect(await authorizeRenewal(sock(peer(issued.cert), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'), d)).toMatchObject({ ok: false, code: 'NOT_TRUSTED' });
    expect(await authorizeRenewal(sock(peer(issued.cert), 'DEPTH_ZERO_SELF_SIGNED_CERT'), d)).toMatchObject({ ok: false, code: 'NOT_TRUSTED' });
    expect(await authorizeRenewal(sock(peer(issued.cert), 'CERT_HAS_EXPIRED'), d)).toMatchObject({ ok: false, code: 'NOT_TRUSTED' });
  });

  it('refuses a certificate whose issuer is no longer trusted', async () => {
    const { s, d } = await deps();
    const { issued } = await s.issueFor('Dana');
    expect(await authorizeRenewal(sock(peer(issued.cert), null), { ...d, trustedIssuers: () => [] })).toMatchObject({ ok: false, code: 'NOT_TRUSTED' });
  });

  describe('forgeries that claim CERT_HAS_EXPIRED', () => {
    /** An expired certificate with the person's subject and serial, signed by a CA of the same name that is not Podium's. */
    function forged(realPem: string, keyId: string) {
      const work = tmp();
      const fca = makeForgerCa(work);
      const serial = `0x${new X509Certificate(realPem).serialNumber}`;
      const pair = signClientDated({ ...fca, keyId, from: Date.now() - 100 * DAY, to: Date.now() - 5 * DAY, serial });
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ss.key', '-out', 'ss.crt', '-days', '1', '-subj', `/CN=pdm_${keyId}/O=podium`], { cwd: work });
      return { ...pair, selfSigned: fs.readFileSync(path.join(work, 'ss.crt'), 'utf8') };
    }

    it('refuses an expired certificate from a fake CA with the same subject and serial', async () => {
      const { s, d } = await deps();
      const { person, issued } = await s.issueFor('Dana');
      const f = forged(issued.cert, person.keyId);
      expect(new X509Certificate(f.cert).serialNumber).toBe(new X509Certificate(issued.cert).serialNumber);
      expect(await authorizeRenewal(sock(peer(f.cert), 'CERT_HAS_EXPIRED'), d)).toMatchObject({ ok: false, code: 'NOT_TRUSTED' });
    });

    it('refuses a forged certificate even when its fingerprint is claimed to be a stored one', async () => {
      const { s, d } = await deps();
      const { person, issued } = await s.issueFor('Dana');
      const f = forged(issued.cert, person.keyId);
      const lying: RenewSocket = { encrypted: true, authorized: false, authorizationError: 'CERT_HAS_EXPIRED', getPeerCertificate: () => ({ raw: new X509Certificate(f.cert).raw, fingerprint256: new X509Certificate(issued.cert).fingerprint256 }) };
      expect(await authorizeRenewal(lying, d)).toMatchObject({ ok: false });
    });

    it('refuses a forged certificate whose row somehow exists, because its signature does not verify under the CA key', async () => {
      const { s, d } = await deps();
      const { person, issued } = await s.issueFor('Dana');
      const f = forged(issued.cert, person.keyId);
      await s.certs.replace(person.id, { cert: f.cert, info: describeCert(f.cert), issuerFingerprint: new X509Certificate(s.ca).fingerprint256 }, Date.now());
      expect(await authorizeRenewal(sock(peer(f.cert), 'CERT_HAS_EXPIRED'), d)).toMatchObject({ ok: false, code: 'NOT_TRUSTED' });
    });

    it('refuses a self-signed certificate with the same subject', async () => {
      const { s, d } = await deps();
      const { person, issued } = await s.issueFor('Dana');
      const f = forged(issued.cert, person.keyId);
      expect(await authorizeRenewal(sock(peer(f.selfSigned), 'CERT_HAS_EXPIRED'), d)).toMatchObject({ ok: false, code: 'NOT_TRUSTED' });
    });
  });
});

describe('POST /api/reporter/renew over mutual TLS', () => {
  it('renews before expiry: the response carries the new certificate and the CA, and the old certificate keeps working', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    const k = newKey();
    const res = await s.post(issued, { publicKey: pubPem(k.publicKey) });
    expect(res.status).toBe(200);
    const cert = res.body.cert as string;
    const x = new X509Certificate(cert);
    expect(x.publicKey.equals(k.publicKey)).toBe(true);
    expect(res.body.ca).toEqual([s.ca]);
    expect(res.body.expires).toBe(new Date(x.validTo).toISOString());
    expect(res.body.fingerprint).toBe(x.fingerprint256);
    // both are live rows for the person, and both authenticate
    expect((await s.certs.listFor(person.id)).filter((c) => c.revokedAt === null)).toHaveLength(2);
    expect(await s.whoami(issued)).toEqual({ kind: 'person', name: 'Dana' });
    expect(await s.whoami({ cert, key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })).toEqual({ kind: 'person', name: 'Dana' });
    expect(s.lines.some((l) => l.event === 'tls.reporter_renewed')).toBe(true);
  });

  it('uses tls.reporter.lifetimeDays for the new certificate', async () => {
    const s = await setup({ lifetimeDays: 45 });
    const { issued } = await s.issueFor('Dana');
    const res = await s.post(issued, { publicKey: pubPem(newKey().publicKey) });
    const x = new X509Certificate(res.body.cert as string);
    const days = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / DAY;
    expect(days).toBeGreaterThanOrEqual(44.9);
    expect(days).toBeLessThanOrEqual(45.1);
  });

  it('does not renew an expired certificate: it is dropped at the handshake, in or past what used to be the grace', async () => {
    const s = await setup();
    for (const [from, to] of [[100, 5], [200, 40]]) {
      const e = await s.issueDated(`Dana ${from}`, Date.now() - from * DAY, Date.now() - to * DAY);
      await expect(s.post(e.issued, { publicKey: pubPem(newKey().publicKey) })).rejects.toBeDefined();
      expect((await s.certs.listFor(e.person.id))).toHaveLength(1);
    }
    expect(s.lines.some((l) => l.event === 'tls.reporter_renewed')).toBe(false);
  });

  it('refuses a forged expired certificate that uses a stolen serial', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    const fca = makeForgerCa(tmp());
    const f = signClientDated({ ...fca, keyId: person.keyId, from: Date.now() - 100 * DAY, to: Date.now() - 5 * DAY, serial: `0x${new X509Certificate(issued.cert).serialNumber}` });
    // the server's TLS stack talks to the forgery as it would to the genuine expired certificate
    await expect(s.post(f, { publicKey: pubPem(newKey().publicKey) })).rejects.toBeDefined();
    expect((await s.certs.listFor(person.id))).toHaveLength(1);
  });

  describe('the limit: a certificate is renewed at most once an hour (#612)', () => {
    it('refuses a second renewal inside the hour with 429, Retry-After and no new row', async () => {
      const s = await setup();
      s.setClock(() => Date.now());
      const { person, issued } = await s.issueFor('Dana');
      const res = await s.post(issued, { publicKey: pubPem(newKey().publicKey) });
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ ok: false, code: 'TOO_SOON' });
      expect(String(res.body.error)).toMatch(/hour/);
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(3500);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(3600);
      expect((await s.certs.listFor(person.id))).toHaveLength(1);
      expect(s.lines.some((l) => l.event === 'tls.reporter_renew_refused' && l.code === 'TOO_SOON')).toBe(true);
    });

    it('allows the renewal once the hour has passed, and then limits the next one again', async () => {
      const s = await setup();
      let offset = 0;
      s.setClock(() => Date.now() + offset);
      const { person, issued } = await s.issueFor('Dana');
      offset = 61 * 60_000;
      const first = await s.post(issued, { publicKey: pubPem(newKey().publicKey) });
      expect(first.status).toBe(200);
      // the new certificate counts: asking again straight away is limited
      const second = await s.post(issued, { publicKey: pubPem(newKey().publicKey) });
      expect(second.status).toBe(429);
      expect((await s.certs.listFor(person.id))).toHaveLength(2);
    });

    it('never asks for more than an hour, even if the server clock was stepped back', async () => {
      const s = await setup();
      const { issued } = await s.issueFor('Dana');
      s.setClock(() => Date.now() - 24 * 3_600_000);
      const res = await s.post(issued, { publicKey: pubPem(newKey().publicKey) });
      expect(res.status).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(3600);
    });

    it('cannot be got round with an expired certificate, which is dropped at the handshake instead of skipping the limit', async () => {
      const s = await setup();
      s.setClock(() => Date.now());
      const e = await s.issueDated('Dana', Date.now() - 100 * DAY, Date.now() - 5 * DAY);
      for (let i = 0; i < 3; i++) await expect(s.post(e.issued, { publicKey: pubPem(newKey().publicKey) })).rejects.toBeDefined();
      expect((await s.certs.listFor(e.person.id))).toHaveLength(1);
    });

    it('lets only one of several renewals sent at the same moment through', async () => {
      const s = await setup();
      const { person, issued } = await s.issueFor('Dana');
      const results = await Promise.all([1, 2, 3, 4].map(() => s.post(issued, { publicKey: pubPem(newKey().publicKey) })));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 429)).toHaveLength(3);
      expect((await s.certs.listFor(person.id))).toHaveLength(2);
    });

    it('limits each person on their own', async () => {
      const s = await setup();
      s.setClock(() => Date.now());
      const a = await s.issueFor('Dana');
      const b = await s.issueFor('Eve');
      expect((await s.post(a.issued, { publicKey: pubPem(newKey().publicKey) })).status).toBe(429);
      expect((await s.post(b.issued, { publicKey: pubPem(newKey().publicKey) })).status).toBe(429);
      s.setClock(() => Date.now() + 2 * 3_600_000);
      expect((await s.post(a.issued, { publicKey: pubPem(newKey().publicKey) })).status).toBe(200);
      expect((await s.certs.listFor(b.person.id))).toHaveLength(1);
    });
  });

  it('refuses a revoked certificate', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    await s.certs.revokeFor(person.id, 'revoked', Date.now());
    const res = await s.post(issued, { publicKey: pubPem(newKey().publicKey) });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, code: 'REVOKED' });
  });

  it('refuses a live certificate whose person is revoked, even when its row was not', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    expect(await s.people.revoke(person.id, Date.now())).toBe(true);
    const res = await s.post(issued, { publicKey: pubPem(newKey().publicKey) });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, code: 'REVOKED' });
    expect((await s.certs.listFor(person.id))).toHaveLength(1);
  });

  it('drops a connection with no certificate at the handshake', async () => {
    const s = await setup();
    await expect(s.post(null, { publicKey: pubPem(newKey().publicKey) })).rejects.toBeDefined();
  });

  it('answers 400 for a body with no usable public key, and renews nothing', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    for (const body of [{}, { publicKey: 5 }, { publicKey: 'nope' }, { publicKey: pubPem(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey) }]) {
      const res = await s.post(issued, body);
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    }
    expect((await s.certs.listFor(person.id))).toHaveLength(1);
  });

  it('answers 503 while TLS has no issuer, and 500 without leaking why when openssl fails', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    s.setIssuerOn(false);
    expect((await s.post(issued, { publicKey: pubPem(newKey().publicKey) })).status).toBe(503);
    s.setIssuerOn(true);
    s.setOpenssl('/nonexistent/openssl');
    const res = await s.post(issued, { publicKey: pubPem(newKey().publicKey) });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('nonexistent');
    expect((await s.certs.listFor(person.id))).toHaveLength(1);
    expect(s.lines.some((l) => l.event === 'tls.reporter_renew_failed')).toBe(true);
  });

  it('does not hand out a certificate when the person is revoked while it is being signed', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    // an openssl that takes a moment, so the revoke lands between the check and the insert
    const slow = path.join(tmp(), 'slow-openssl.sh');
    fs.writeFileSync(slow, '#!/bin/sh\nsleep 0.6\nexec openssl "$@"\n', { mode: 0o755 });
    s.setOpenssl(slow);
    const pending = s.post(issued, { publicKey: pubPem(newKey().publicKey) });
    await new Promise((r) => setTimeout(r, 200));
    await s.certs.revokeFor(person.id, 'revoked', Date.now());
    const res = await pending;
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, code: 'REVOKED' });
    expect((await s.certs.listFor(person.id))).toHaveLength(1);
  });

  it('is not reachable over plain HTTP', async () => {
    const s = await setup();
    const app = express();
    app.use('/api/reporter', createReporterRenewRouter({ certs: s.certs, people: s.people, tx: s.storage.tx, logger: s.logger, now: Date.now, settings: () => s.settings, trustedIssuers: () => [], issuer: () => null }));
    const server = http.createServer(app).listen(0, '127.0.0.1');
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as { port: number };
    const res = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/reporter/renew', headers: { 'content-type': 'application/json' } }, (r) => resolve(r.statusCode ?? 0));
      req.on('error', reject);
      req.end('{}');
    });
    expect(res).toBe(401);
  });
});

describe('a CA rotation seen by a renewing reporter (#588)', () => {
  const sign = (k: KeyObject) => ({ publicKey: pubPem(k) });

  it('a planned rotation adds the new CA and its cross certificate to the response, signs the new certificate with the new CA, and both CAs authenticate', async () => {
    const s = await setup();
    const { issued } = await s.issueFor('Dana');
    await s.listener.rotation.rotate(false);
    const { ca: newCa } = s.listener.trust.deliverable()!;
    const k = newKey();
    const res = await s.post(issued, sign(k.publicKey));
    expect(res.status).toBe(200);
    expect(res.body.ca).toEqual([newCa]);
    const rotation = res.body.rotation as { ca: string; cross: string };
    expect(rotation.ca).toBe(newCa);
    const cross = new X509Certificate(rotation.cross);
    expect(cross.verify(new X509Certificate(s.ca).publicKey)).toBe(true);
    expect(cross.publicKey.equals(new X509Certificate(newCa).publicKey)).toBe(true);
    const renewed = new X509Certificate(res.body.cert as string);
    expect(renewed.verify(new X509Certificate(newCa).publicKey)).toBe(true);
    // The old certificate (old CA) and the renewed one (new CA) both identify Dana during the overlap.
    s.trustOnlyClients([s.ca]);
    expect(await s.whoami(issued)).toEqual({ kind: 'person', name: 'Dana' });
    s.trustOnlyClients([newCa]);
    expect(await s.whoami({ cert: res.body.cert as string, key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })).toEqual({ kind: 'person', name: 'Dana' });
  });

  it('offers nothing after the overlap ends, and the old certificate is refused at renewal', async () => {
    const s = await setup();
    const { issued } = await s.issueFor('Dana');
    await s.listener.rotation.rotate(false);
    const newCa = s.listener.trust.currentCa();
    expect(await s.listener.rotation.retire()).not.toBeNull();
    s.trustOnlyClients([newCa]);
    await expect(s.post(issued, sign(newKey().publicKey))).rejects.toBeDefined();
    await expect(s.whoami(issued)).rejects.toBeDefined();
  });

  it('after a hard cutover there is nothing to offer, and an old certificate cannot renew', async () => {
    const s = await setup();
    const { issued } = await s.issueFor('Dana');
    await s.listener.rotation.rotate(true);
    s.trustOnlyClients([s.listener.trust.currentCa()]);
    await expect(s.post(issued, sign(newKey().publicKey))).rejects.toBeDefined();
    await expect(s.whoami(issued)).rejects.toBeDefined();
    // A person reissued after the cutover renews, and the answer carries no rotation.
    const fresh = await s.issueFor('Eli');
    const ok = await s.post(fresh.issued, sign(newKey().publicKey));
    expect(ok.status).toBe(200);
    expect(ok.body.rotation).toBeUndefined();
  });
});
