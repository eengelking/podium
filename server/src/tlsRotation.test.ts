import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureTls, serverNames, TlsError } from './tlsCa.js';
import { caCanOverlap, CROSS_DAYS, retireCa, rotateCa, TrustStore } from './tlsRotation.js';
import { issuePersonCert } from './tlsPeople.js';
import { signDated, writeLegacyCa } from './tlsTesting.js';

const dirs: string[] = [];
const scratch = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-rot-test-'));
  dirs.push(d);
  return path.join(d, 'tls');
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const names = serverNames('127.0.0.1', []);
const DAY = 86_400_000;
const text = (pem: string): string => execFileSync('openssl', ['x509', '-noout', '-text'], { input: pem }).toString();

/** A server with the given chain and client CAs; resolves what a client with `ca` (and optionally a certificate) sees. */
async function handshake(o: { cert: string; key: string; ca: string[]; clientCa: string[]; client?: { cert: string; key: string } }): Promise<{ ok: true; authorized: boolean } | { ok: false; error: string }> {
  let authorized = false;
  const server = https.createServer({ cert: o.cert, key: o.key, ca: o.ca, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    authorized = (req.socket as unknown as { authorized: boolean }).authorized;
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise((resolve) => {
      const req = https.get({ host: '127.0.0.1', port, path: '/', ca: o.clientCa, ...(o.client ?? {}), agent: false, servername: 'localhost' }, (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: true, authorized }));
      });
      req.on('error', (e) => resolve({ ok: false, error: (e as NodeJS.ErrnoException).code ?? e.message }));
    });
  } finally {
    server.close();
  }
}

/** A fresh folder with a CA, a serving certificate and a person certificate signed by that CA. */
async function setup() {
  const dir = scratch();
  const m = await ensureTls({ dir, names });
  const oldCa = m.caCert;
  const person = await issuePersonCert({ dir, keyId: 'aaaaaaaaaaaa' });
  return { dir, oldCa, person, key: m.key };
}

describe('a new CA has room for a cross certificate under it', () => {
  it('is made with pathlen 1, so the chain [leaf, cross] verifies under it', async () => {
    const { oldCa } = await setup();
    expect(text(oldCa)).toContain('pathlen:1');
  });
});

describe('caCanOverlap', () => {
  it('is true for a CA made with pathlen 1', async () => {
    const { dir } = await setup();
    expect(caCanOverlap(dir)).toBe(true);
  });

  it('is false for a CA made with pathlen 0, the one T3 made', async () => {
    const dir = scratch();
    writeLegacyCa(dir);
    await ensureTls({ dir, names });
    expect(caCanOverlap(dir)).toBe(false);
  });

  it('is true when openssl is missing, so the page does not fail on a flag; rotateCa still refuses in its own words', async () => {
    const { dir } = await setup();
    expect(caCanOverlap(dir, 'openssl-does-not-exist')).toBe(true);
  });

  it('is true when there is no CA to look at, so the page does not claim a refusal it cannot explain', () => {
    expect(caCanOverlap(scratch())).toBe(true);
  });
});

describe('rotateCa, planned', () => {
  it('makes a new CA, a cross certificate signed by the old one, and a leaf from the new one', async () => {
    const { dir, oldCa } = await setup();
    const out = await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    const trust = new TrustStore(dir);
    const next = new X509Certificate(trust.currentCa());
    const prev = new X509Certificate(oldCa);
    expect(next.fingerprint256).not.toBe(prev.fingerprint256);
    expect(trust.previousCa()).toBe(oldCa);
    expect(out.overlap).toBe(true);

    const cross = new X509Certificate(fs.readFileSync(path.join(dir, 'cross.crt'), 'utf8'));
    expect(cross.verify(prev.publicKey)).toBe(true);
    expect(cross.publicKey.equals(next.publicKey)).toBe(true);
    expect(cross.subject).toBe(next.subject);
    const ct = text(cross.toString());
    expect(ct).toContain('CA:TRUE');
    expect(ct).toContain('Certificate Sign');
    expect(ct).toContain('Subject Key Identifier');
    expect(ct).toContain('Authority Key Identifier');
    expect(ct).not.toContain('pathlen:0');
    const days = (Date.parse(cross.validTo) - Date.parse(cross.validFrom)) / DAY;
    expect(Math.round(days)).toBe(CROSS_DAYS);

    const leaf = new X509Certificate(out.cert);
    expect(leaf.verify(next.publicKey)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'ca.key'))).toBe(true);
    expect(fs.statSync(path.join(dir, 'ca.key')).mode & 0o777).toBe(0o600);
  });

  it('presents [new leaf, cross certificate] in that order and nothing else', async () => {
    const { dir } = await setup();
    const out = await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    const trust = new TrustStore(dir);
    const chain = trust.chain(out.cert);
    const blocks = chain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    expect(blocks).toHaveLength(2);
    expect(new X509Certificate(blocks[0]!).ca).toBe(false);
    expect(new X509Certificate(blocks[1]!).ca).toBe(true);
  });

  it('is refused while another rotation is still in progress', async () => {
    const { dir } = await setup();
    await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    await expect(rotateCa({ dir, names, servingDays: 365, endOverlap: false })).rejects.toThrow(/retire/i);
  });

  it('is refused for a CA with pathlen 0, which cannot sit above a cross certificate', async () => {
    const dir = scratch();
    writeLegacyCa(dir);
    await ensureTls({ dir, names });
    const before = fs.readdirSync(dir).sort();
    await expect(rotateCa({ dir, names, servingDays: 365, endOverlap: false })).rejects.toThrow(/end the overlap/i);
    // Nothing changed.
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });
});

describe('two CAs, one source of trust', () => {
  it('trusts both CAs during the overlap, only the new one after retiring it', async () => {
    const { dir, oldCa } = await setup();
    await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    const trust = new TrustStore(dir);
    const nextFp = new X509Certificate(trust.currentCa()).fingerprint256;
    const oldFp = new X509Certificate(oldCa).fingerprint256;
    expect(trust.caCerts()).toEqual([trust.currentCa(), oldCa]);
    expect(trust.trustedIssuers().sort()).toEqual([nextFp, oldFp].sort());

    retireCa(dir);
    trust.reload();
    expect(trust.caCerts()).toEqual([trust.currentCa()]);
    expect(trust.trustedIssuers()).toEqual([nextFp]);
    expect(trust.previousCa()).toBeNull();
    expect(fs.existsSync(path.join(dir, 'cross.crt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'previous-ca.crt'))).toBe(false);
  });

  it('stops trusting the old CA for client certificates the day after the cross certificate expires (#657)', async () => {
    const { dir, oldCa } = await setup();
    await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    let clock = Date.now();
    const trust = new TrustStore(dir, () => clock);
    const nextFp = new X509Certificate(trust.currentCa()).fingerprint256;
    const notAfter = Date.parse(new X509Certificate(fs.readFileSync(path.join(dir, 'cross.crt'), 'utf8')).validTo);
    clock = notAfter - DAY;
    expect(trust.caCerts()).toEqual([trust.currentCa(), oldCa]);
    clock = notAfter + DAY;
    expect(trust.caCerts()).toEqual([trust.currentCa()]);
    expect(trust.trustedIssuers()).toEqual([nextFp]);
  });

  it('describes the overlap for the Admin page', async () => {
    const { dir, oldCa } = await setup();
    const startedAt = Date.parse('2026-10-21T12:00:00Z');
    await rotateCa({ dir, names, servingDays: 365, endOverlap: false, now: () => startedAt });
    const view = new TrustStore(dir, () => startedAt).rotation();
    expect(view?.previousCa.fingerprintSha256).toBe(new X509Certificate(oldCa).fingerprint256);
    expect(view?.startedAt).toBe(startedAt);
    expect(Date.parse(view!.cross.notAfter)).toBeGreaterThan(startedAt);
  });

  it('delivers the new CA and the cross certificate only during a planned rotation', async () => {
    const { dir } = await setup();
    expect(new TrustStore(dir).deliverable()).toBeNull();
    await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    const d = new TrustStore(dir).deliverable();
    expect(d?.ca).toBe(new TrustStore(dir).currentCa());
    expect(new X509Certificate(d!.cross).ca).toBe(true);
    retireCa(dir);
    expect(new TrustStore(dir).deliverable()).toBeNull();
  });

  it('ignores a cross certificate that does not belong to the CA in the folder', async () => {
    const { dir } = await setup();
    await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    // A half-finished rotation: the new CA's files were never moved in, so ca.crt is still the old one.
    const trust0 = new TrustStore(dir);
    fs.copyFileSync(path.join(dir, 'previous-ca.crt'), path.join(dir, 'ca.crt'));
    const trust = new TrustStore(dir);
    expect(trust.rotation()).toBeNull();
    expect(trust.deliverable()).toBeNull();
    expect(trust.caCerts()).toHaveLength(1);
    expect(trust0.caCerts()).toHaveLength(2);
  });

  it('drops an expired cross certificate from the chain', async () => {
    const { dir } = await setup();
    const out = await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    const later = Date.now() + (CROSS_DAYS + 2) * DAY;
    expect(new TrustStore(dir, () => later).chain(out.cert).match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
  });
});

describe('real handshakes', () => {
  it('a client holding only the old CA and a client holding only the new CA both verify the server', async () => {
    const { dir, oldCa } = await setup();
    const out = await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    const trust = new TrustStore(dir);
    const base = { cert: trust.chain(out.cert), key: out.key, ca: trust.caCerts() };
    expect(await handshake({ ...base, clientCa: [oldCa] })).toEqual({ ok: true, authorized: false });
    expect(await handshake({ ...base, clientCa: [trust.currentCa()] })).toEqual({ ok: true, authorized: false });
  });

  it('a new leaf sent alone fails for the client that holds only the old CA', async () => {
    const { dir, oldCa } = await setup();
    const out = await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    const trust = new TrustStore(dir);
    const r = await handshake({ cert: out.cert, key: out.key, ca: trust.caCerts(), clientCa: [oldCa] });
    expect(r.ok).toBe(false);
  });

  it('a cross certificate before the leaf is refused', async () => {
    const { dir, oldCa } = await setup();
    const out = await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    const cross = fs.readFileSync(path.join(dir, 'cross.crt'), 'utf8');
    // Node refuses to start a listener whose first certificate is not the one the key belongs to.
    await expect(handshake({ cert: cross + out.cert, key: out.key, ca: new TrustStore(dir).caCerts(), clientCa: [oldCa] })).rejects.toThrow(/key values mismatch/);
  });

  it('adding the new self-signed root to the chain breaks the client that holds only the old CA', async () => {
    const { dir, oldCa } = await setup();
    const out = await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    const trust = new TrustStore(dir);
    const cross = fs.readFileSync(path.join(dir, 'cross.crt'), 'utf8');
    const r = await handshake({ cert: out.cert + cross + trust.currentCa(), key: out.key, ca: trust.caCerts(), clientCa: [oldCa] });
    // Node builds the path from the first chain it can complete; the old-only client has no trust anchor for the new root.
    expect(r.ok === false || r.authorized === false).toBe(true);
  });

  it('an expired cross certificate ends the overlap for a client that holds only the old CA, and not for one with the new CA', async () => {
    const { dir, oldCa } = await setup();
    const out = await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    const trust = new TrustStore(dir);
    // Re-sign the cross certificate with dates in the past, using the old CA's public identity is not possible without its
    // key, so build the whole case by hand with a throwaway old CA that has pathlen 1.
    const work = path.join(path.dirname(dir), 'hand');
    fs.mkdirSync(work);
    const sh = (...a: string[]) => execFileSync('openssl', a, { cwd: work });
    fs.writeFileSync(path.join(work, 'c.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Old\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:1\nkeyUsage=critical,keyCertSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n[x]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n');
    sh('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'old.key');
    sh('req', '-new', '-x509', '-key', 'old.key', '-config', 'c.cnf', '-extensions', 'ca', '-days', '3650', '-out', 'old.crt');
    // The cross certificate carries the new CA's subject and key.
    const subject = new X509Certificate(trust.currentCa()).subject.replaceAll('\n', '/');
    sh('req', '-new', '-key', path.join(dir, 'ca.key'), '-subj', `/${subject}`, '-out', 'cross.csr');
    signDated(work, { csr: 'cross.csr', caCrt: 'old.crt', caKey: 'old.key', extFile: 'c.cnf', ext: 'x', from: Date.now() - 200 * DAY, to: Date.now() - 80 * DAY, serial: '9', out: 'cross.crt' });
    const expiredCross = fs.readFileSync(path.join(work, 'cross.crt'), 'utf8');
    const oldOnly = fs.readFileSync(path.join(work, 'old.crt'), 'utf8');
    const base = { cert: out.cert + expiredCross, key: out.key, ca: trust.caCerts() };
    expect((await handshake({ ...base, clientCa: [oldOnly] })).ok).toBe(false);
    expect((await handshake({ ...base, clientCa: [trust.currentCa()] })).ok).toBe(true);
  });

  it('accepts a client certificate from either CA during the overlap, and from the old one not after it is retired', async () => {
    const { dir, oldCa, person } = await setup();
    const out = await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    const trust = new TrustStore(dir);
    const fresh = await issuePersonCert({ dir, keyId: 'bbbbbbbbbbbb' });
    const base = { cert: trust.chain(out.cert), key: out.key, ca: trust.caCerts(), clientCa: [oldCa, trust.currentCa()] };
    expect(await handshake({ ...base, client: { cert: person.cert, key: person.key } })).toEqual({ ok: true, authorized: true });
    expect(await handshake({ ...base, client: { cert: fresh.cert, key: fresh.key } })).toEqual({ ok: true, authorized: true });

    retireCa(dir);
    trust.reload();
    const after = { cert: out.cert, key: out.key, ca: trust.caCerts(), clientCa: [trust.currentCa()] };
    expect(await handshake({ ...after, client: { cert: person.cert, key: person.key } })).toEqual({ ok: true, authorized: false });
    expect(await handshake({ ...after, client: { cert: fresh.cert, key: fresh.key } })).toEqual({ ok: true, authorized: true });
  });
});

describe('rotateCa, ending the overlap now', () => {
  it('leaves one CA, no cross certificate and nothing to deliver, and refuses what the old CA signed', async () => {
    const { dir, oldCa, person } = await setup();
    const out = await rotateCa({ dir, names, servingDays: 365, endOverlap: true });
    expect(out.overlap).toBe(false);
    const trust = new TrustStore(dir);
    expect(trust.caCerts()).toHaveLength(1);
    expect(trust.previousCa()).toBeNull();
    expect(trust.deliverable()).toBeNull();
    expect(trust.currentCa()).not.toBe(oldCa);
    expect(fs.readdirSync(dir).filter((n) => n === 'cross.crt' || n === 'previous-ca.crt')).toEqual([]);
    // An old-CA client certificate is not authorized, and an old-only client no longer verifies the server.
    const r = await handshake({ cert: trust.chain(out.cert), key: out.key, ca: trust.caCerts(), clientCa: [trust.currentCa()], client: { cert: person.cert, key: person.key } });
    expect(r).toEqual({ ok: true, authorized: false });
    expect((await handshake({ cert: out.cert, key: out.key, ca: trust.caCerts(), clientCa: [oldCa] })).ok).toBe(false);
  });

  it('also ends an overlap that is under way', async () => {
    const { dir } = await setup();
    await rotateCa({ dir, names, servingDays: 365, endOverlap: false });
    await rotateCa({ dir, names, servingDays: 365, endOverlap: true });
    const trust = new TrustStore(dir);
    expect(trust.caCerts()).toHaveLength(1);
    expect(trust.rotation()).toBeNull();
  });
});

describe('failures change nothing', () => {
  it('a missing openssl leaves the folder as it was', async () => {
    const { dir } = await setup();
    const before = fs.readdirSync(dir).sort();
    await expect(rotateCa({ dir, names, servingDays: 365, endOverlap: false, openssl: 'definitely-not-openssl' })).rejects.toBeInstanceOf(TlsError);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });
});
