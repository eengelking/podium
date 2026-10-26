import express from 'express';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './fleet/db.js';
import { PeopleStore } from './fleet/people.js';
import { createLogger } from './logging/logger.js';
import { ensureTls, serverNames } from './tlsCa.js';
import { certAuth, PersonCertStore, type ClientSocket } from './tlsClientAuth.js';
import { buildReporterConfig, fileSafe, issuePersonCert, type IssuedPersonCert } from './tlsPeople.js';
import { signDated, startTlsForTest } from './tlsTesting.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-clientauth-'));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const NOW = () => Date.now();

/** A real mutual-TLS listener (#665) whose reporter route answers with what `certAuth` makes of the connection's certificate. */
async function setup() {
  const root = tmp();
  const db = openDb(':memory:');
  const people = new PeopleStore(db);
  const certs = new PersonCertStore(db);
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ format: 'json', write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
  let issuers: string[] = [];
  let clock = NOW;
  const app = express();
  app.get('/api/fleet/sessions/s1/peers', (req, res) => {
    const a = certAuth(req.socket as unknown as ClientSocket, { certs, people, trustedIssuers: () => issuers, now: () => clock() });
    res.json(a.kind === 'person' ? { kind: a.kind, name: a.person.name } : a);
  });
  const dbPath = path.join(root, 'podium.sqlite');
  const l = await startTlsForTest({ app, dbPath, logger });
  const port = l.port;
  cleanup.push(() => new Promise<void>((r) => { l.server.closeAllConnections(); l.server.close(() => r()); }));
  issuers = [l.material.ca.fingerprintSha256];
  const dir = path.join(root, 'tls');
  const issueFor = async (name: string, days?: number) => {
    const { person } = people.createPerson(name);
    const issued = await issuePersonCert({ dir, keyId: person.keyId, days });
    certs.replace(person.id, issued, NOW());
    return { person, issued };
  };
  const get = (client?: { cert: string; key: string }, agent?: https.Agent) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = https.get({ host: '127.0.0.1', port, ca: l.material.caCert, servername: 'localhost', path: '/api/fleet/sessions/s1/peers', agent, ...client }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body) as Record<string, unknown>));
      });
      req.on('error', reject);
    });
  return { root, dir, db, people, certs, l, lines, issueFor, get, setClock: (f: () => number) => (clock = f), setIssuers: (i: string[]) => (issuers = i) };
}

describe('issuePersonCert', () => {
  it('makes a clientAuth certificate signed by the CA, with a subject that carries no name, and leaves nothing on disk', async () => {
    const dir = path.join(tmp(), 'tls');
    const m = await ensureTls({ dir, names: serverNames('127.0.0.1', []) });
    const before = fs.readdirSync(dir).sort();
    const c = await issuePersonCert({ dir, keyId: 'a1b2c3d4e5f6' });
    const x = new X509Certificate(c.cert);
    expect(x.subject.replaceAll('\n', ', ')).toBe('CN=pdm_a1b2c3d4e5f6, O=podium');
    expect(x.ca).toBe(false);
    expect(x.verify(new X509Certificate(m.caCert).publicKey)).toBe(true);
    expect(x.checkIssued(new X509Certificate(m.caCert))).toBe(true);
    expect(c.issuerFingerprint).toBe(m.ca.fingerprintSha256);
    expect(c.key).toContain('PRIVATE KEY');
    expect(Math.round((Date.parse(c.info.notAfter) - Date.parse(c.info.notBefore)) / 86_400_000)).toBe(90);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
  });

  it('has extended key usage clientAuth and not serverAuth', async () => {
    const dir = path.join(tmp(), 'tls');
    await ensureTls({ dir, names: serverNames('127.0.0.1', []) });
    const c = await issuePersonCert({ dir, keyId: 'a1b2c3d4e5f6', days: 30 });
    const file = path.join(tmp(), 'c.pem');
    fs.writeFileSync(file, c.cert);
    const text = execFileSync('openssl', ['x509', '-in', file, '-noout', '-text'], { encoding: 'utf8' });
    expect(text).toMatch(/TLS Web Client Authentication/);
    expect(text).not.toMatch(/TLS Web Server Authentication/);
    expect(text).toMatch(/CA:FALSE/);
  });

  it('refuses a key id that is not 12 hex digits, so a name can never reach the subject', async () => {
    const dir = path.join(tmp(), 'tls');
    await ensureTls({ dir, names: serverNames('127.0.0.1', []) });
    for (const keyId of ['', 'a1b2c3', 'a1b2c3d4e5f6/O=evil', 'A1B2C3D4E5F6', 'Dana, O=x']) {
      await expect(issuePersonCert({ dir, keyId })).rejects.toThrow(/key id/);
    }
  });

  it('fails clearly with no CA, and with no openssl', async () => {
    const dir = tmp();
    await expect(issuePersonCert({ dir, keyId: 'a1b2c3d4e5f6' })).rejects.toThrow(/no CA/);
    const withCa = path.join(tmp(), 'tls');
    await ensureTls({ dir: withCa, names: serverNames('127.0.0.1', []) });
    await expect(issuePersonCert({ dir: withCa, keyId: 'a1b2c3d4e5f6', openssl: 'openssl-that-is-not-installed' })).rejects.toThrow(/not installed/);
    expect(fs.readdirSync(withCa).filter((n) => n.startsWith('.new-'))).toEqual([]);
  });
});

describe('buildReporterConfig', () => {
  const info = { fingerprintSha256: 'AA:BB', subject: 's', notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2026-04-01T00:00:00.000Z', serial: '01' };
  it('writes the header lines, then the CA, the certificate and the key', () => {
    const f = buildReporterConfig({ user: 'Dana Lee', server: 'https://podium.lan:4318', issuedAt: Date.UTC(2026, 0, 1), cert: 'CERT', key: 'KEY', info, caCerts: ['CA1\n', 'CA2'] });
    expect(f.filename).toBe('reporter-config-Dana-Lee-1767225600.pem');
    expect(f.content).toBe(
      [
        '# podium-reporter-config v1',
        '# user: Dana Lee',
        '# server: https://podium.lan:4318',
        '# issued-at: 2026-01-01T00:00:00.000Z 1767225600',
        '# expires: 2026-04-01T00:00:00.000Z',
        '# fingerprint: AA:BB',
        'CA1',
        'CA2',
        'CERT',
        'KEY',
        '',
      ].join('\n'),
    );
  });
  it('makes a file name from any name', () => {
    expect(fileSafe('../../etc/passwd')).toBe('etc-passwd');
    expect(fileSafe('Zoë  O\'Neil')).toBe('Zo-O-Neil');
    expect(fileSafe('\u202e')).toBe('person');
    expect(fileSafe('x'.repeat(100))).toHaveLength(48);
  });
});

describe('PersonCertStore', () => {
  it('stores the certificate by fingerprint, reissue revokes the earlier one, and the key is nowhere in the row', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    const first = s.certs.find(issued.info.fingerprintSha256)!;
    expect(first).toMatchObject({ personId: person.id, serial: issued.info.serial, issuerFingerprint: s.l.material.ca.fingerprintSha256, revokedAt: null });
    const again = await issuePersonCert({ dir: s.dir, keyId: person.keyId });
    s.certs.replace(person.id, again, NOW());
    expect(s.certs.find(issued.info.fingerprintSha256)).toMatchObject({ revokedAt: expect.any(Number), reason: 'reissued' });
    expect(s.certs.current(person.id)!.fingerprint).toBe(again.info.fingerprintSha256);
    expect(s.certs.listFor(person.id)).toHaveLength(2);
    const dump = JSON.stringify(s.db.prepare('SELECT * FROM person_certificates').all());
    expect(dump).not.toContain('PRIVATE KEY');
    expect(dump).not.toContain(issued.key.split('\n')[1]!);
  });

  it('revokeFor revokes the live certificates once and says so', async () => {
    const s = await setup();
    const { person } = await s.issueFor('Dana');
    expect(s.certs.revokeFor(person.id, 'revoked', NOW())).toBe(1);
    expect(s.certs.revokeFor(person.id, 'revoked', NOW())).toBe(0);
    expect(s.certs.current(person.id)).toBeUndefined();
  });

  it('deleting the person deletes their certificates', async () => {
    const s = await setup();
    const { person } = await s.issueFor('Dana');
    s.people.deleteMany([person.id]);
    expect(s.certs.listFor(person.id)).toEqual([]);
  });

  it('rolls back a reissue that fails, leaving the earlier certificate live', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    const broken = { ...issued, info: { ...issued.info } } as IssuedPersonCert; // the same fingerprint: the primary key refuses it
    expect(() => s.certs.replace(person.id, broken, NOW())).toThrow();
    expect(s.certs.current(person.id)!.fingerprint).toBe(issued.info.fingerprintSha256);
  });
});

describe('certAuth on a real mutual-TLS listener', () => {
  it('attributes a genuine certificate to its person, and drops a connection with none at the handshake', async () => {
    const s = await setup();
    const { issued } = await s.issueFor('Dana');
    expect(await s.get({ cert: issued.cert, key: issued.key })).toEqual({ kind: 'person', name: 'Dana' });
    await expect(s.get()).rejects.toBeDefined();
  });

  it('drops a certificate with the same subject and serial made by another CA at the handshake', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    const other = path.join(tmp(), 'tls');
    await ensureTls({ dir: other, names: serverNames('127.0.0.1', []) });
    const forgedKeyId = person.keyId;
    // Same subject, and the genuine certificate's serial: only the issuer differs.
    const work = tmp();
    const run = (...a: string[]) => execFileSync('openssl', a, { cwd: work });
    fs.writeFileSync(path.join(work, 'c.cnf'), '[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n');
    run('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'k.pem');
    run('req', '-new', '-key', 'k.pem', '-subj', `/CN=pdm_${forgedKeyId}/O=podium`, '-out', 'c.csr');
    run('x509', '-req', '-in', 'c.csr', '-CA', path.join(other, 'ca.crt'), '-CAkey', path.join(other, 'ca.key'), '-days', '30', '-set_serial', `0x${issued.info.serial}`, '-extfile', 'c.cnf', '-extensions', 'v3', '-out', 'c.pem');
    const forged = new X509Certificate(fs.readFileSync(path.join(work, 'c.pem')));
    expect(forged.subject).toBe(new X509Certificate(issued.cert).subject);
    expect(forged.serialNumber).toBe(new X509Certificate(issued.cert).serialNumber);
    await expect(s.get({ cert: fs.readFileSync(path.join(work, 'c.pem'), 'utf8'), key: fs.readFileSync(path.join(work, 'k.pem'), 'utf8') })).rejects.toBeDefined();
  });

  it('drops a self-signed certificate that copies the subject at the handshake', async () => {
    const s = await setup();
    const { person } = await s.issueFor('Dana');
    const work = tmp();
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '30', '-subj', `/CN=pdm_${person.keyId}/O=podium`], { cwd: work });
    await expect(s.get({ cert: fs.readFileSync(path.join(work, 'c.pem'), 'utf8'), key: fs.readFileSync(path.join(work, 'k.pem'), 'utf8') })).rejects.toBeDefined();
  });

  it('drops a genuine certificate once it has expired at the handshake', async () => {
    const s = await setup();
    const { person } = await s.issueFor('Dana');
    // Signed by the real CA and stored, so only its dates are wrong.
    const work = tmp();
    const run = (...a: string[]) => execFileSync('openssl', a, { cwd: work });
    fs.writeFileSync(path.join(work, 'c.cnf'), '[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n');
    run('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'k.pem');
    run('req', '-new', '-key', 'k.pem', '-subj', `/CN=pdm_${person.keyId}/O=podium`, '-out', 'c.csr');
    signDated(work, { csr: 'c.csr', caCrt: path.join(s.dir, 'ca.crt'), caKey: path.join(s.dir, 'ca.key'), extFile: 'c.cnf', ext: 'v3', from: Date.UTC(2020, 0, 1), to: Date.UTC(2020, 0, 2), out: 'c.pem' });
    const pem = fs.readFileSync(path.join(work, 'c.pem'), 'utf8');
    const x = new X509Certificate(pem);
    s.certs.replace(person.id, { cert: pem, info: { fingerprintSha256: x.fingerprint256, subject: x.subject, notBefore: new Date(x.validFrom).toISOString(), notAfter: new Date(x.validTo).toISOString(), serial: x.serialNumber }, issuerFingerprint: s.l.material.ca.fingerprintSha256 }, NOW());
    await expect(s.get({ cert: pem, key: fs.readFileSync(path.join(work, 'k.pem'), 'utf8') })).rejects.toBeDefined();
  });

  it('drops the serving certificate used as a client certificate at the handshake', async () => {
    const s = await setup();
    await s.issueFor('Dana');
    await expect(s.get({ cert: fs.readFileSync(path.join(s.dir, 'serving.crt'), 'utf8'), key: fs.readFileSync(path.join(s.dir, 'serving.key'), 'utf8') })).rejects.toBeDefined();
  });

  it('refuses a certificate the CA signed that Podium has no record of', async () => {
    const s = await setup();
    const { person } = s.people.createPerson('Ghost');
    const stray = await issuePersonCert({ dir: s.dir, keyId: person.keyId });
    expect(await s.get({ cert: stray.cert, key: stray.key })).toEqual({ kind: 'refused', reason: 'client certificate is not one Podium issued' });
  });

  it('checks revocation on every request, including one on a connection that is still open', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    cleanup.push(() => agent.destroy());
    const client = { cert: issued.cert, key: issued.key };
    expect(await s.get(client, agent)).toEqual({ kind: 'person', name: 'Dana' });
    s.certs.revokeFor(person.id, 'revoked', NOW());
    expect(await s.get(client, agent)).toEqual({ kind: 'refused', reason: 'client certificate was revoked' });
  });

  it('refuses a live certificate whose person is revoked, even when its row was not', async () => {
    const s = await setup();
    const { person, issued } = await s.issueFor('Dana');
    expect(s.people.revoke(person.id, NOW())).toBe(true);
    expect(s.certs.current(person.id)).toBeDefined();
    expect(await s.get({ cert: issued.cert, key: issued.key })).toEqual({ kind: 'refused', reason: 'client certificate was revoked' });
  });

  it('keeps accepting client certificates after the serving certificate is renewed', async () => {
    const s = await setup();
    const { issued } = await s.issueFor('Dana');
    const out = await s.l.renewer.renewNow();
    expect(out.ok).toBe(true);
    expect(await s.get({ cert: issued.cert, key: issued.key })).toEqual({ kind: 'person', name: 'Dana' });
  });

  it('refuses a certificate from a CA that is no longer trusted, and one past its own dates by the clock', async () => {
    const s = await setup();
    const { issued } = await s.issueFor('Dana');
    const client = { cert: issued.cert, key: issued.key };
    s.setIssuers(['AA:BB']);
    expect(await s.get(client)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/not trusted/) });
    s.setIssuers([s.l.material.ca.fingerprintSha256]);
    s.setClock(() => Date.now() + 200 * 86_400_000);
    expect(await s.get(client)).toMatchObject({ kind: 'refused', reason: 'client certificate has expired' });
  });
});

describe('certAuth with a stand-in socket', () => {
  const deps = { certs: {} as PersonCertStore, people: {} as PeopleStore, trustedIssuers: () => [], now: NOW };
  it('treats plain HTTP and a certificate-less handshake as none', () => {
    expect(certAuth({}, deps)).toEqual({ kind: 'none' });
    expect(certAuth({ encrypted: true, getPeerCertificate: () => ({}) }, deps)).toEqual({ kind: 'none' });
  });
  it('refuses an unauthorized certificate and says why, in words or from an Error', () => {
    expect(certAuth({ encrypted: true, authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', getPeerCertificate: () => ({ fingerprint256: 'AA' }) }, deps)).toEqual({ kind: 'refused', reason: 'client certificate not accepted: DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(certAuth({ encrypted: true, authorized: false, authorizationError: new Error('bad'), getPeerCertificate: () => ({ fingerprint256: 'AA' }) }, deps)).toEqual({ kind: 'refused', reason: 'client certificate not accepted: bad' });
    expect(certAuth({ encrypted: true, getPeerCertificate: () => ({ fingerprint256: 'AA' }) }, deps)).toEqual({ kind: 'refused', reason: 'client certificate not accepted: unverified' });
  });
});

describe('PersonCertStore.reportersByIssuer (#588)', () => {
  const issued = (issuer: string, serial: string, notAfter: number): IssuedPersonCert => {
    const info = { fingerprintSha256: `fp-${serial}`, subject: 's', notBefore: new Date(0).toISOString(), notAfter: new Date(notAfter).toISOString(), serial };
    return { cert: 'pem', key: '', info, issuerFingerprint: issuer };
  };
  const store = () => {
    const db = openDb(':memory:');
    return { people: new PeopleStore(db), certs: new PersonCertStore(db) };
  };

  it('counts each person once, by their newest live certificate', () => {
    const { people, certs } = store();
    const a = people.createPerson('A').person;
    const b = people.createPerson('B').person;
    const c = people.createPerson('C').person;
    const future = Date.now() + 86_400_000;
    certs.replace(a.id, issued('old', '1', future), 1000);
    certs.replace(b.id, issued('old', '2', future), 1000);
    // B renewed onto the new CA and still holds the old, live certificate: B is on the new CA.
    certs.add(b.id, issued('new', '3', future), 2000);
    certs.replace(c.id, issued('new', '4', future), 1000);
    expect(certs.reportersByIssuer(Date.now())).toEqual({ total: 3, byIssuer: { old: 1, new: 2 } });
  });

  it('leaves out a revoked certificate and one that ended before the cutoff', () => {
    const { people, certs } = store();
    const a = people.createPerson('A').person;
    const b = people.createPerson('B').person;
    const c = people.createPerson('C').person;
    const now = Date.now();
    certs.replace(a.id, issued('old', '1', now + 1000), 1000);
    certs.revokeFor(a.id, 'revoked', 2000);
    certs.replace(b.id, issued('old', '2', now - 40 * 86_400_000), 1000);
    certs.replace(c.id, issued('old', '3', now - 10 * 86_400_000), 1000);
    // the cutoff is 30 days ago
    expect(certs.reportersByIssuer(now - 30 * 86_400_000)).toEqual({ total: 1, byIssuer: { old: 1 } });
  });
});

describe('fileSafe edges (S8786)', () => {
  it('trims leading and trailing dashes and dots without backtracking', () => {
    const t = process.hrtime.bigint();
    fileSafe(`${'-'.repeat(100000)}x${'-'.repeat(100000)}!`);
    expect(Number(process.hrtime.bigint() - t) / 1e6).toBeLessThan(250);
    expect(fileSafe('..-a.b-..')).toBe('a.b');
    expect(fileSafe('---')).toBe('person');
  });
});
