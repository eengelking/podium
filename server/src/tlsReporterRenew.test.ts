// A reporter renews its own certificate (#585, SPEC 6 *Authenticating by certificate*). The server takes the reporter's new
// public key, authenticates the request by the current certificate, and answers with a new certificate and the CA(s).
// An expired certificate may renew inside the grace, but only when its signature verifies under the CA key and its exact
// fingerprint is one Podium stored: the error code `CERT_HAS_EXPIRED` and a serial are what a forgery also shows.
import express from 'express';
import { execFileSync } from 'node:child_process';
import { X509Certificate, generateKeyPairSync, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './fleet/db.js';
import { PeopleStore } from './fleet/people.js';
import { createLogger } from './logging/logger.js';
import { describeCert } from './tlsCa.js';
import { certAuth, PersonCertStore, type ClientSocket } from './tlsClientAuth.js';
import { issuePersonCert, type IssuedPersonCert } from './tlsPeople.js';
import { authorizeRenewal, createReporterRenewRouter, issueForPublicKey, REPORTER_DEFAULTS, type RenewSocket } from './tlsReporterRenew.js';
import { startTls, type TlsListener } from './tlsServer.js';
import { makeForgerCa, signClientDated } from './tlsTesting.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-renew-'));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const DAY = 86_400_000;
const pubPem = (k: KeyObject): string => k.export({ type: 'spki', format: 'pem' }).toString();
const newKey = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });

async function setup(o: { graceDays?: number; lifetimeDays?: number } = {}) {
  const root = tmp();
  const db = openDb(':memory:');
  const people = new PeopleStore(db);
  const certs = new PersonCertStore(db);
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ format: 'json', write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
  let listener: TlsListener | null = null;
  let clock = () => Date.now();
  let issuerOn = true;
  let opensslBin: string | undefined;
  const settings = { lifetimeDays: o.lifetimeDays ?? REPORTER_DEFAULTS.lifetimeDays, graceDays: o.graceDays ?? REPORTER_DEFAULTS.graceDays };
  const dir = path.join(root, 'tls');
  const app = express();
  app.use(
    '/api/reporter',
    createReporterRenewRouter({
      certs,
      people,
      logger,
      now: () => clock(),
      settings: () => settings,
      trustedIssuers: () => (listener ? [listener.material.ca.fingerprintSha256] : []),
      issuer: () => (listener && issuerOn ? { dir, port: listener.port, caCerts: () => [listener!.material.caCert], openssl: opensslBin } : null),
    }),
  );
  app.get('/whoami', (req, res) => {
    const a = certAuth(req.socket as unknown as ClientSocket, { certs, people, trustedIssuers: () => (listener ? [listener.material.ca.fingerprintSha256] : []), now: () => clock() });
    res.json(a.kind === 'person' ? { kind: a.kind, name: a.person.name } : a);
  });
  const port = await freePort();
  listener = (await startTls({ env: { PODIUM_TLS: 'on', PODIUM_TLS_PORT: String(port) }, app, dbPath: path.join(root, 'podium.sqlite'), bind: '127.0.0.1', httpPort: 4317, allowedHosts: [], logger })) as TlsListener;
  cleanup.push(() => new Promise<void>((r) => { listener!.server.closeAllConnections(); listener!.server.close(() => r()); }));
  const ca = listener.material.caCert;

  const personWith = (name: string) => people.createPerson(name).person;
  const store = (personId: number, i: IssuedPersonCert) => certs.replace(personId, i, Date.now());
  const issueFor = async (name: string, days = 90) => {
    const person = personWith(name);
    const issued = await issuePersonCert({ dir, keyId: person.keyId, days });
    store(person.id, issued);
    return { person, issued };
  };
  /** A genuine certificate, signed by the real CA and stored, with the dates given. */
  const issueDated = (name: string, from: number, to: number) => {
    const person = personWith(name);
    const pair = signClientDated({ caCrt: path.join(dir, 'ca.crt'), caKey: path.join(dir, 'ca.key'), keyId: person.keyId, from, to });
    const info = describeCert(pair.cert);
    const issued: IssuedPersonCert = { ...pair, info, issuerFingerprint: listener!.material.ca.fingerprintSha256 };
    store(person.id, issued);
    return { person, issued };
  };

  const post = (c: { cert: string; key: string } | null, body: unknown, route = '/api/reporter/renew') =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request(
        { host: '127.0.0.1', port, ca, servername: 'localhost', method: 'POST', path: route, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, ...(c ?? {}) },
        (res) => {
          let text = '';
          res.on('data', (x) => (text += x));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }));
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  const whoami = (c: { cert: string; key: string }) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, ca, servername: 'localhost', path: '/whoami', ...c }, (res) => {
        let text = '';
        res.on('data', (x) => (text += x));
        res.on('end', () => resolve(JSON.parse(text) as Record<string, unknown>));
      }).on('error', reject);
    });
  return { root, dir, db, people, certs, logger, lines, settings, listener, ca, port, issueFor, issueDated, post, whoami, setClock: (f: () => number) => (clock = f), personWith, setIssuerOn: (on: boolean) => (issuerOn = on), setOpenssl: (b: string) => (opensslBin = b) };
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

describe('authorizeRenewal', () => {
  const sock = (x: { raw: Buffer; fingerprint256: string }, error: string | null): RenewSocket => ({ encrypted: true, authorized: error === null, authorizationError: error, getPeerCertificate: () => x });
  const peer = (pem: string) => ({ raw: new X509Certificate(pem).raw, fingerprint256: new X509Certificate(pem).fingerprint256 });

  async function deps() {
    const s = await setup();
    const ca = new X509Certificate(s.ca);
    return { s, d: { certs: s.certs, people: s.people, trustedIssuers: () => [ca.fingerprint256], caCerts: () => [s.ca], graceDays: () => s.settings.graceDays, now: () => Date.now() } };
  }

  it('lets a live certificate renew', async () => {
    const { s, d } = await deps();
    const { person, issued } = await s.issueFor('Dana');
    const r = authorizeRenewal(sock(peer(issued.cert), null), d);
    expect(r).toMatchObject({ ok: true, expired: false });
    expect(r.ok && r.person.id).toBe(person.id);
  });

  it('lets a genuine expired certificate renew inside the grace', async () => {
    const { s, d } = await deps();
    const { issued } = s.issueDated('Dana', Date.now() - 100 * DAY, Date.now() - 5 * DAY);
    const r = authorizeRenewal(sock(peer(issued.cert), 'CERT_HAS_EXPIRED'), d);
    expect(r).toMatchObject({ ok: true, expired: true });
  });

  it('refuses a genuine expired certificate past the grace, saying so', async () => {
    const { s, d } = await deps();
    const { issued } = s.issueDated('Dana', Date.now() - 200 * DAY, Date.now() - 31 * DAY);
    expect(authorizeRenewal(sock(peer(issued.cert), 'CERT_HAS_EXPIRED'), d)).toMatchObject({ ok: false, code: 'PAST_GRACE' });
  });

  it('refuses every expired certificate when the grace is 0', async () => {
    const { s, d } = await deps();
    s.settings.graceDays = 0;
    const { issued } = s.issueDated('Dana', Date.now() - 100 * DAY, Date.now() - 1 * DAY);
    expect(authorizeRenewal(sock(peer(issued.cert), 'CERT_HAS_EXPIRED'), d)).toMatchObject({ ok: false, code: 'PAST_GRACE' });
  });

  it('refuses a revoked certificate, live or expired', async () => {
    const { s, d } = await deps();
    const { person, issued } = await s.issueFor('Dana');
    s.certs.revokeFor(person.id, 'revoked', Date.now());
    expect(authorizeRenewal(sock(peer(issued.cert), null), d)).toMatchObject({ ok: false, code: 'REVOKED' });
    const e = s.issueDated('Eve', Date.now() - 100 * DAY, Date.now() - 5 * DAY);
    s.certs.revokeFor(e.person.id, 'revoked', Date.now());
    expect(authorizeRenewal(sock(peer(e.issued.cert), 'CERT_HAS_EXPIRED'), d)).toMatchObject({ ok: false, code: 'REVOKED' });
  });

  it('refuses a connection with no certificate, and any error other than expiry', async () => {
    const { s, d } = await deps();
    const { issued } = await s.issueFor('Dana');
    expect(authorizeRenewal({ encrypted: false }, d)).toMatchObject({ ok: false, code: 'NO_CERTIFICATE' });
    expect(authorizeRenewal({ encrypted: true, getPeerCertificate: () => ({}) }, d)).toMatchObject({ ok: false, code: 'NO_CERTIFICATE' });
    expect(authorizeRenewal(sock(peer(issued.cert), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'), d)).toMatchObject({ ok: false, code: 'NOT_TRUSTED' });
    expect(authorizeRenewal(sock(peer(issued.cert), 'DEPTH_ZERO_SELF_SIGNED_CERT'), d)).toMatchObject({ ok: false, code: 'NOT_TRUSTED' });
  });

  it('refuses a certificate whose issuer is no longer trusted', async () => {
    const { s, d } = await deps();
    const { issued } = await s.issueFor('Dana');
    expect(authorizeRenewal(sock(peer(issued.cert), null), { ...d, trustedIssuers: () => [] })).toMatchObject({ ok: false, code: 'NOT_TRUSTED' });
  });

  describe('forgeries that show CERT_HAS_EXPIRED', () => {
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
      expect(authorizeRenewal(sock(peer(f.cert), 'CERT_HAS_EXPIRED'), d)).toMatchObject({ ok: false, code: 'NOT_RECOGNISED' });
    });

    it('refuses a forged certificate even when its fingerprint is claimed to be a stored one', async () => {
      const { s, d } = await deps();
      const { person, issued } = await s.issueFor('Dana');
      const f = forged(issued.cert, person.keyId);
      const lying: RenewSocket = { encrypted: true, authorized: false, authorizationError: 'CERT_HAS_EXPIRED', getPeerCertificate: () => ({ raw: new X509Certificate(f.cert).raw, fingerprint256: new X509Certificate(issued.cert).fingerprint256 }) };
      expect(authorizeRenewal(lying, d)).toMatchObject({ ok: false });
    });

    it('refuses a forged certificate whose row somehow exists, because its signature does not verify under the CA key', async () => {
      const { s, d } = await deps();
      const { person, issued } = await s.issueFor('Dana');
      const f = forged(issued.cert, person.keyId);
      s.certs.replace(person.id, { cert: f.cert, info: describeCert(f.cert), issuerFingerprint: new X509Certificate(s.ca).fingerprint256 }, Date.now());
      expect(authorizeRenewal(sock(peer(f.cert), 'CERT_HAS_EXPIRED'), d)).toMatchObject({ ok: false, code: 'NOT_RECOGNISED' });
    });

    it('refuses a self-signed certificate with the same subject', async () => {
      const { s, d } = await deps();
      const { person, issued } = await s.issueFor('Dana');
      const f = forged(issued.cert, person.keyId);
      expect(authorizeRenewal(sock(peer(f.selfSigned), 'CERT_HAS_EXPIRED'), d)).toMatchObject({ ok: false, code: 'NOT_RECOGNISED' });
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
    expect(s.certs.listFor(person.id).filter((c) => c.revokedAt === null)).toHaveLength(2);
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

  it('renews an expired certificate inside the grace', async () => {
    const s = await setup();
    const e = s.issueDated('Dana', Date.now() - 100 * DAY, Date.now() - 5 * DAY);
    const k = newKey();
    const res = await s.post(e.issued, { publicKey: pubPem(k.publicKey) });
    expect(res.status).toBe(200);
    expect(new X509Certificate(res.body.cert as string).publicKey.equals(k.publicKey)).toBe(true);
  });

  it('refuses an expired certificate past the grace with a code the reporter can word', async () => {
    const s = await setup();
    const e = s.issueDated('Dana', Date.now() - 200 * DAY, Date.now() - 40 * DAY);
    const res = await s.post(e.issued, { publicKey: pubPem(newKey().publicKey) });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, code: 'PAST_GRACE' });
    expect(String(res.body.error)).toMatch(/reissue/i);
    expect(s.lines.some((l) => l.event === 'tls.reporter_renew_refused')).toBe(true);
  });

  it('refuses a forged expired certificate that uses a stolen serial', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    const fca = makeForgerCa(tmp());
    const f = signClientDated({ ...fca, keyId: person.keyId, from: Date.now() - 100 * DAY, to: Date.now() - 5 * DAY, serial: `0x${new X509Certificate(issued.cert).serialNumber}` });
    // the server's TLS stack talks to the forgery as it would to the genuine expired certificate
    const res = await s.post(f, { publicKey: pubPem(newKey().publicKey) });
    expect(res.status).toBe(401);
    expect(res.body.cert).toBeUndefined();
    expect(s.certs.listFor(person.id)).toHaveLength(1);
  });

  it('refuses a revoked certificate', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    s.certs.revokeFor(person.id, 'revoked', Date.now());
    const res = await s.post(issued, { publicKey: pubPem(newKey().publicKey) });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, code: 'REVOKED' });
  });

  it('refuses a connection with no certificate', async () => {
    const s = await setup();
    const res = await s.post(null, { publicKey: pubPem(newKey().publicKey) });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, code: 'NO_CERTIFICATE' });
  });

  it('answers 400 for a body with no usable public key, and renews nothing', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    for (const body of [{}, { publicKey: 5 }, { publicKey: 'nope' }, { publicKey: pubPem(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey) }]) {
      const res = await s.post(issued, body);
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    }
    expect(s.certs.listFor(person.id)).toHaveLength(1);
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
    expect(s.certs.listFor(person.id)).toHaveLength(1);
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
    s.certs.revokeFor(person.id, 'revoked', Date.now());
    const res = await pending;
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, code: 'REVOKED' });
    expect(s.certs.listFor(person.id)).toHaveLength(1);
  });

  it('is not reachable over plain HTTP', async () => {
    const s = await setup();
    const app = express();
    app.use('/api/reporter', createReporterRenewRouter({ certs: s.certs, people: s.people, logger: s.logger, now: Date.now, settings: () => s.settings, trustedIssuers: () => [], issuer: () => null }));
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
