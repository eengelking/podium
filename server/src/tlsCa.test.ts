import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { describeCert, ensureTls, listPrevious, PREVIOUS_KEEP, renewServing, serverNames, TlsError } from './tlsCa.js';

const dirs: string[] = [];
const scratch = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-tls-test-'));
  dirs.push(d);
  return path.join(d, 'tls');
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const mode = (p: string): number => fs.statSync(p).mode & 0o777;
const names = serverNames('192.168.1.5', ['podium.lan:4318']);

describe('serverNames', () => {
  it('is localhost and 127.0.0.1 with nothing else', () => {
    expect(serverNames(undefined, [])).toEqual({ dns: ['localhost'], ip: ['127.0.0.1'] });
  });
  it('adds the bind address and each allowed host once, splitting names from addresses', () => {
    expect(serverNames('192.168.1.5', ['Podium.LAN:4318', '192.168.1.5', 'localhost', '[::1]'])).toEqual({
      dns: ['localhost', 'podium.lan'],
      ip: ['127.0.0.1', '192.168.1.5', '::1'],
    });
  });
  it('skips an address with a zone id', () => {
    expect(serverNames('fe80::5%eth0', [])).toEqual({ dns: ['localhost'], ip: ['127.0.0.1'] });
  });
  it('ignores a wildcard bind and a malformed entry', () => {
    expect(serverNames('0.0.0.0', ['bad host', '/CN=x'])).toEqual({ dns: ['localhost'], ip: ['127.0.0.1'] });
    expect(serverNames('::', [])).toEqual({ dns: ['localhost'], ip: ['127.0.0.1'] });
  });
});

describe('ensureTls on a fresh folder', () => {
  it('makes a CA and a serving certificate with the right extensions, lifetimes and modes', async () => {
    const dir = scratch();
    const m = await ensureTls({ dir, names });
    expect(m.createdCa).toBe(true);
    expect(m.createdServing).toBe(true);
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(dir, 'ca.key'))).toBe(0o600);
    expect(mode(path.join(dir, 'serving.key'))).toBe(0o600);
    expect(fs.readdirSync(dir).sort()).toEqual(['ca.crt', 'ca.key', 'serving.crt', 'serving.key']);

    const ca = new X509Certificate(m.caCert);
    expect(ca.ca).toBe(true);
    const caText = execFileSync('openssl', ['x509', '-noout', '-text'], { input: m.caCert }).toString();
    expect(caText).toContain('CA:TRUE');
    expect(caText).toContain('Certificate Sign');
    expect(caText).toContain('Subject Key Identifier');
    expect(caText).toContain('Authority Key Identifier');
    expect(caText).toContain('prime256v1');
    const years = (Date.parse(m.ca.notAfter) - Date.parse(m.ca.notBefore)) / 86_400_000 / 365;
    expect(years).toBeGreaterThan(9.9);
    expect(years).toBeLessThan(10.1);

    const leaf = new X509Certificate(m.cert);
    expect(leaf.ca).toBe(false);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkIssued(ca)).toBe(true);
    const leafText = execFileSync('openssl', ['x509', '-noout', '-text'], { input: m.cert }).toString();
    expect(leafText).toContain('TLS Web Server Authentication');
    expect(leafText).not.toContain('TLS Web Client Authentication');
    expect(leaf.subjectAltName).toBe('DNS:localhost, DNS:podium.lan, IP Address:127.0.0.1, IP Address:192.168.1.5');
    const days = (Date.parse(m.serving.notAfter) - Date.parse(m.serving.notBefore)) / 86_400_000;
    expect(Math.round(days)).toBe(365);
  });

  it('leaves no work folder behind and reports the fingerprint and dates', async () => {
    const dir = scratch();
    const m = await ensureTls({ dir, names });
    expect(fs.readdirSync(dir).some((n) => n.startsWith('.new-'))).toBe(false);
    expect(m.ca.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(describeCert(m.caCert)).toEqual(m.ca);
    expect(Date.parse(m.ca.notAfter)).toBeGreaterThan(Date.parse(m.ca.notBefore));
  });

  it('clears a work folder an earlier killed run left behind', async () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, '.new-old'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.new-old', 'ca.key'), 'partial');
    await ensureTls({ dir, names });
    expect(fs.readdirSync(dir).sort()).toEqual(['ca.crt', 'ca.key', 'serving.crt', 'serving.key']);
  });

  it('fails with a clear error and leaves nothing when openssl is missing', async () => {
    const dir = scratch();
    await expect(ensureTls({ dir, names, openssl: 'no-such-openssl' })).rejects.toThrow(/not installed or not on PATH/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('ensureTls on a folder that has them', () => {
  it('uses the same CA and serving certificate on a second start', async () => {
    const dir = scratch();
    const first = await ensureTls({ dir, names });
    const caBefore = fs.readFileSync(path.join(dir, 'ca.key'));
    const second = await ensureTls({ dir, names });
    expect(second.createdCa).toBe(false);
    expect(second.createdServing).toBe(false);
    expect(second.ca).toEqual(first.ca);
    expect(second.serving).toEqual(first.serving);
    expect(fs.readFileSync(path.join(dir, 'ca.key')).equals(caBefore)).toBe(true);
  });

  it('makes only a new serving certificate when it is gone, signed by the same CA', async () => {
    const dir = scratch();
    const first = await ensureTls({ dir, names });
    fs.rmSync(path.join(dir, 'serving.crt'));
    fs.rmSync(path.join(dir, 'serving.key'));
    const second = await ensureTls({ dir, names });
    expect(second.createdCa).toBe(false);
    expect(second.createdServing).toBe(true);
    expect(second.ca).toEqual(first.ca);
    expect(second.serving.fingerprintSha256).not.toBe(first.serving.fingerprintSha256);
  });

  it('never replaces a CA whose certificate or key is missing', async () => {
    const dir = scratch();
    await ensureTls({ dir, names });
    const key = fs.readFileSync(path.join(dir, 'ca.key'));
    fs.rmSync(path.join(dir, 'ca.crt'));
    await expect(ensureTls({ dir, names })).rejects.toThrow(/ca.key but no ca.crt/);
    expect(fs.readFileSync(path.join(dir, 'ca.key')).equals(key)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'ca.crt'))).toBe(false);
  });

  it('stops on a CA key that does not belong to its certificate', async () => {
    const a = scratch();
    const b = scratch();
    await ensureTls({ dir: a, names });
    await ensureTls({ dir: b, names });
    fs.copyFileSync(path.join(b, 'ca.key'), path.join(a, 'ca.key'));
    await expect(ensureTls({ dir: a, names })).rejects.toThrow(/does not belong/);
  });

  it('stops on a serving certificate another CA signed, and on a half-present serving pair', async () => {
    const a = scratch();
    const b = scratch();
    await ensureTls({ dir: a, names });
    await ensureTls({ dir: b, names });
    fs.copyFileSync(path.join(b, 'serving.crt'), path.join(a, 'serving.crt'));
    fs.copyFileSync(path.join(b, 'serving.key'), path.join(a, 'serving.key'));
    await expect(ensureTls({ dir: a, names })).rejects.toThrow(/not signed by this CA/);
    fs.rmSync(path.join(a, 'serving.key'));
    await expect(ensureTls({ dir: a, names })).rejects.toThrow(/serving.crt but no serving.key/);
  });

  it('stops on a key it cannot read or parse, with a TlsError', async () => {
    const dir = scratch();
    await ensureTls({ dir, names });
    fs.writeFileSync(path.join(dir, 'ca.key'), 'not a key');
    await expect(ensureTls({ dir, names })).rejects.toBeInstanceOf(TlsError);
    fs.chmodSync(path.join(dir, 'ca.key'), 0o000);
    if (process.getuid?.() !== 0) await expect(ensureTls({ dir, names })).rejects.toThrow(/cannot be read/);
  });

  it('refuses a serving certificate with no CA beside it', async () => {
    const dir = scratch();
    await ensureTls({ dir, names });
    fs.rmSync(path.join(dir, 'ca.crt'));
    fs.rmSync(path.join(dir, 'ca.key'));
    await expect(ensureTls({ dir, names })).rejects.toThrow(/serving certificate but no CA/);
  });
});

describe('the material works for an HTTPS server', () => {
  it('verifies against the CA for a name on the certificate and fails for one that is not', async () => {
    const m = await ensureTls({ dir: scratch(), names });
    const server = https.createServer({ cert: m.cert, key: m.key }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const get = (servername: string) =>
      new Promise<string>((resolve, reject) => {
        const req = https.get({ host: '127.0.0.1', port, ca: m.caCert, servername, headers: { host: servername } }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(b));
        });
        req.on('error', reject);
      });
    try {
      await expect(get('localhost')).resolves.toBe('ok');
      await expect(get('podium.lan')).resolves.toBe('ok');
      await expect(get('evil.example')).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
      expect(tls.checkServerIdentity('evil.example', new X509Certificate(m.cert).toLegacyObject())).toBeInstanceOf(Error);
    } finally {
      server.close();
    }
  });
});

describe('renewServing', () => {
  const days = (c: { notBefore: string; notAfter: string }) => Math.round((Date.parse(c.notAfter) - Date.parse(c.notBefore)) / 86_400_000);

  it('makes a new certificate from the same CA with the new lifetime and keeps the old one in previous/', async () => {
    const dir = scratch();
    const first = await ensureTls({ dir, names });
    const out = await renewServing({ dir, names, servingDays: 30 });
    expect(out.serving.serial).not.toBe(first.serving.serial);
    expect(days(out.serving)).toBe(30);
    expect(new X509Certificate(out.cert).verify(new X509Certificate(first.caCert).publicKey)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'serving.crt'), 'utf8')).toBe(out.cert);
    expect(fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8')).toBe(first.caCert);
    const kept = fs.readdirSync(path.join(dir, 'previous'));
    expect(kept).toHaveLength(2);
    expect(listPrevious(dir)).toEqual([first.serving]);
    for (const n of kept.filter((f) => f.endsWith('.key'))) expect(mode(path.join(dir, 'previous', n))).toBe(0o600);
    expect(mode(path.join(dir, 'previous'))).toBe(0o700);
    expect(mode(path.join(dir, 'serving.key'))).toBe(0o600);
    expect(fs.readdirSync(dir).some((n) => n.startsWith('.new-'))).toBe(false);
  });

  it('keeps only the last three replaced certificates, newest first', async () => {
    const dir = scratch();
    await ensureTls({ dir, names });
    const serials: string[] = [];
    let t = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 5; i++) {
      serials.push(describeCert(fs.readFileSync(path.join(dir, 'serving.crt'))).serial);
      await renewServing({ dir, names, servingDays: 365, now: () => (t += 1000) });
    }
    expect(PREVIOUS_KEEP).toBe(3);
    expect(listPrevious(dir).map((c) => c.serial)).toEqual(serials.slice(2).reverse());
    expect(fs.readdirSync(path.join(dir, 'previous'))).toHaveLength(6);
  });

  it('picks up changed names', async () => {
    const dir = scratch();
    await ensureTls({ dir, names: serverNames(undefined, []) });
    const out = await renewServing({ dir, names, servingDays: 365 });
    expect(new X509Certificate(out.cert).subjectAltName).toContain('DNS:podium.lan');
  });

  it('changes nothing when openssl fails', async () => {
    const dir = scratch();
    const first = await ensureTls({ dir, names });
    await expect(renewServing({ dir, names, servingDays: 30, openssl: 'no-such-openssl' })).rejects.toThrow(/not installed or not on PATH/);
    expect(fs.readFileSync(path.join(dir, 'serving.crt'), 'utf8')).toBe(first.cert);
    expect(fs.existsSync(path.join(dir, 'previous'))).toBe(false);
    expect(fs.readdirSync(dir).some((n) => n.startsWith('.new-'))).toBe(false);
  });

  it('refuses a folder with no serving certificate, and reads no previous/ that is missing', async () => {
    const dir = scratch();
    fs.mkdirSync(dir, { recursive: true });
    await expect(renewServing({ dir, names, servingDays: 30 })).rejects.toBeInstanceOf(TlsError);
    expect(listPrevious(dir)).toEqual([]);
  });

  it('skips a damaged backup when listing', async () => {
    const dir = scratch();
    await ensureTls({ dir, names });
    await renewServing({ dir, names, servingDays: 365 });
    fs.writeFileSync(path.join(dir, 'previous', 'serving-zzz-1.crt'), 'not a certificate');
    expect(listPrevious(dir)).toHaveLength(1);
  });
});
