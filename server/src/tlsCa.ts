// Built-in TLS (#577, T3): the server makes its own CA and serving certificate with `openssl` the first time TLS is on,
// and reuses them after that. EC P-256 keys; the folder is mode 0700 and every key 0600. A CA that exists is never
// overwritten: a half-made or unreadable one stops TLS (the caller keeps HTTP) rather than being replaced.
import { execFile } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { hostnameOf } from './hostCheck.js';

const run = promisify(execFile);

export const CA_YEARS = 10;
export const SERVING_DAYS = 365;

/** Names the serving certificate is valid for. `dns` and `ip` are lower-case and already checked, so safe in a config file. */
export interface ServerNames {
  dns: string[];
  ip: string[];
}

/** `localhost`, `127.0.0.1`, the bind address (unless a wildcard) and `PODIUM_ALLOWED_HOSTS`, each once. */
export function serverNames(bind: string | undefined, allowed: string[]): ServerNames {
  const dns = new Set<string>(['localhost']);
  const ip = new Set<string>(['127.0.0.1']);
  for (const raw of [bind ?? '', ...allowed]) {
    const h = hostnameOf(raw);
    // A zone id (fe80::5%eth0) is not a certificate name, and openssl would refuse it.
    if (!h || h === '0.0.0.0' || h === '::' || h.includes('%')) continue;
    (isIP(h) ? ip : dns).add(h);
  }
  return { dns: [...dns], ip: [...ip] };
}

export interface CertInfo {
  /** Uppercase hex pairs joined by colons, the form a browser shows. */
  fingerprintSha256: string;
  subject: string;
  notBefore: string;
  notAfter: string;
  serial: string;
}

export function describeCert(pem: string | Buffer): CertInfo {
  const c = new X509Certificate(pem);
  return {
    fingerprintSha256: c.fingerprint256,
    subject: c.subject.replaceAll('\n', ', '),
    notBefore: new Date(c.validFrom).toISOString(),
    notAfter: new Date(c.validTo).toISOString(),
    serial: c.serialNumber,
  };
}

export interface TlsMaterial {
  /** PEM text of the CA certificate. */
  caCert: string;
  /** PEM text of the serving certificate and its key, ready for `https.createServer`. */
  cert: string;
  key: string;
  ca: CertInfo;
  serving: CertInfo;
  /** True when this call made the CA. */
  createdCa: boolean;
  /** True when this call made the serving certificate. */
  createdServing: boolean;
}

export class TlsError extends Error {}

export interface EnsureTlsOptions {
  dir: string;
  names: ServerNames;
  /** Lifetime of a serving certificate made now (`tls.serving.lifetimeDays`); 365 when absent. */
  servingDays?: number;
  /** The openssl binary; tests may point it elsewhere. */
  openssl?: string;
}

export const file = (dir: string, name: string): string => path.join(dir, name);

export const randomSerial = (): string => {
  const b = randomBytes(16);
  b[0] &= 0x7f; // positive, so openssl does not read the top bit as a sign
  return `0x${b.toString('hex')}`;
};

/**
 * pathlen:1 leaves room for one cross certificate between this CA and a serving certificate (#588): OpenSSL refuses the
 * chain [leaf, cross] under a root with pathlen:0. A CA made before this change has pathlen:0 and can only rotate by
 * ending the overlap.
 */
export const caConfig = (cn = 'Podium CA'): string => `[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${cn}
O = podium
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:1
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
`;

const servingConfig = (names: ServerNames): string =>
  `[v3_serving]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
subjectAltName = @alt
[alt]
${names.dns.map((n, i) => `DNS.${i + 1} = ${n}`).join('\n')}
${names.ip.map((n, i) => `IP.${i + 1} = ${n}`).join('\n')}
`;

function readable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Throws a TlsError that says what is wrong with the folder; creates nothing. */
export function checkExisting(dir: string): { ca: boolean; serving: boolean } {
  const haveCa = fs.existsSync(file(dir, 'ca.crt'));
  const haveCaKey = fs.existsSync(file(dir, 'ca.key'));
  if (haveCa !== haveCaKey) {
    throw new TlsError(`${dir} has ${haveCa ? 'ca.crt but no ca.key' : 'ca.key but no ca.crt'}; Podium will not replace a CA. Restore the missing file, or delete the folder to start a new CA (every reporter config must then be reissued)`);
  }
  const haveServing = fs.existsSync(file(dir, 'serving.crt'));
  const haveServingKey = fs.existsSync(file(dir, 'serving.key'));
  if (haveServing !== haveServingKey) {
    throw new TlsError(`${dir} has ${haveServing ? 'serving.crt but no serving.key' : 'serving.key but no serving.crt'}; delete the one that is left and restart to make a new serving certificate`);
  }
  if (haveServing && !haveCa) throw new TlsError(`${dir} has a serving certificate but no CA`);
  return { ca: haveCa, serving: haveServing };
}

/** Reads and checks what exists (throws a TlsError when it is wrong): the key opens, matches its certificate, and the serving certificate was signed by the CA. */
export function loadExisting(dir: string, state: { ca: boolean; serving: boolean }): void {
  if (!state.ca) return;
  for (const n of ['ca.crt', 'ca.key', ...(state.serving ? ['serving.crt', 'serving.key'] : [])]) {
    if (!readable(file(dir, n))) throw new TlsError(`${file(dir, n)} cannot be read; check its owner and mode (keys are 0600)`);
  }
  try {
    const ca = new X509Certificate(fs.readFileSync(file(dir, 'ca.crt'), 'utf8'));
    if (!ca.checkPrivateKey(createPrivateKey(fs.readFileSync(file(dir, 'ca.key'))))) throw new TlsError('ca.key does not belong to ca.crt');
    if (state.serving) {
      const leaf = new X509Certificate(fs.readFileSync(file(dir, 'serving.crt'), 'utf8'));
      if (!leaf.checkPrivateKey(createPrivateKey(fs.readFileSync(file(dir, 'serving.key'))))) throw new TlsError('serving.key does not belong to serving.crt');
      if (!leaf.verify(ca.publicKey)) throw new TlsError('serving.crt was not signed by this CA');
    }
  } catch (err) {
    if (err instanceof TlsError) throw new TlsError(`${dir}: ${err.message}`);
    throw new TlsError(`${dir}: a certificate or key cannot be read (${(err as Error).message})`);
  }
}

export async function openssl(bin: string, args: string[], cwd: string): Promise<void> {
  try {
    await run(bin, args, { cwd, timeout: 30_000 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new TlsError(`${bin} is not installed or not on PATH; built-in TLS needs it to make certificates`);
    throw new TlsError(`${bin} ${args[0]} failed: ${(e.stderr ?? e.message).toString().trim().split('\n')[0]}`);
  }
}

export const genKey = (bin: string, out: string, cwd: string): Promise<void> =>
  openssl(bin, ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', out], cwd);

/** Makes `serving.key` and `serving.crt` in `work`, signed by the CA in `dir` (its `ca.crt` and `ca.key`); nothing in `dir` changes. */
export async function issueServing(bin: string, dir: string, work: string, names: ServerNames, days: number): Promise<void> {
  fs.writeFileSync(file(work, 'serving.cnf'), servingConfig(names));
  await genKey(bin, 'serving.key', work);
  await openssl(bin, ['req', '-new', '-key', 'serving.key', '-subj', '/CN=localhost/O=podium', '-out', 'serving.csr'], work);
  await openssl(bin, ['x509', '-req', '-in', 'serving.csr', '-CA', file(dir, 'ca.crt'), '-CAkey', file(dir, 'ca.key'), '-sha256', '-days', String(days), '-set_serial', randomSerial(), '-extfile', 'serving.cnf', '-extensions', 'v3_serving', '-out', 'serving.crt'], work);
  fs.chmodSync(file(work, 'serving.key'), 0o600);
}

/** Moves a finished serving pair from `work` into `dir`. The key goes first: a crash between the two renames leaves a key that does not match its certificate, which is reported at start. */
export function installServing(work: string, dir: string): void {
  fs.renameSync(file(work, 'serving.key'), file(dir, 'serving.key'));
  fs.renameSync(file(work, 'serving.crt'), file(dir, 'serving.crt'));
}

/**
 * Makes the CA and the serving certificate when they are missing and returns what the HTTPS listener needs.
 * An existing CA is read, never rewritten. A serving certificate that exists is kept as it is (`renewServing` replaces it).
 */
export async function ensureTls(opts: EnsureTlsOptions): Promise<TlsMaterial> {
  const bin = opts.openssl ?? 'openssl';
  const { dir } = opts;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const state = checkExisting(dir);
  loadExisting(dir, state);

  // Work in a folder of our own and move the finished files in, so a failure part-way leaves no half-made CA behind.
  // A work folder left by a process that was killed mid-way holds only a partial key; clear it.
  for (const n of fs.readdirSync(dir)) if (n.startsWith('.new-')) fs.rmSync(file(dir, n), { recursive: true, force: true });
  const work = fs.mkdtempSync(path.join(dir, '.new-'));
  try {
    fs.chmodSync(work, 0o700);
    let createdCa = false;
    if (!state.ca) {
      fs.writeFileSync(file(work, 'ca.cnf'), caConfig());
      await genKey(bin, 'ca.key', work);
      await openssl(bin, ['req', '-new', '-x509', '-key', 'ca.key', '-sha256', '-days', String(CA_YEARS * 365 + 3), '-set_serial', randomSerial(), '-config', 'ca.cnf', '-extensions', 'v3_ca', '-out', 'ca.crt'], work);
      fs.chmodSync(file(work, 'ca.key'), 0o600);
      // The key goes first: a crash between the two renames leaves a key with no certificate, which is reported, not replaced.
      fs.renameSync(file(work, 'ca.key'), file(dir, 'ca.key'));
      fs.renameSync(file(work, 'ca.crt'), file(dir, 'ca.crt'));
      createdCa = true;
    }
    let createdServing = false;
    if (!state.serving) {
      await issueServing(bin, dir, work, opts.names, opts.servingDays ?? SERVING_DAYS);
      installServing(work, dir);
      createdServing = true;
    }
    const caCert = fs.readFileSync(file(dir, 'ca.crt'), 'utf8');
    const cert = fs.readFileSync(file(dir, 'serving.crt'), 'utf8');
    const key = fs.readFileSync(file(dir, 'serving.key'), 'utf8');
    return { caCert, cert, key, ca: describeCert(caCert), serving: describeCert(cert), createdCa, createdServing };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** How many replaced serving certificates are kept in `previous/`. */
export const PREVIOUS_KEEP = 3;

export interface RenewServingOptions {
  dir: string;
  names: ServerNames;
  servingDays: number;
  openssl?: string;
  /** Names the replaced files; tests pass a fixed clock. */
  now?: () => number;
}

export interface RenewedServing {
  cert: string;
  key: string;
  serving: CertInfo;
}

const previousDir = (dir: string): string => file(dir, 'previous');

/** The replaced serving certificates, newest first. A file that cannot be read is skipped. */
export function listPrevious(dir: string): CertInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(previousDir(dir)).filter((n) => n.endsWith('.crt'));
  } catch {
    return [];
  }
  const out: CertInfo[] = [];
  for (const n of names.sort().reverse()) {
    try {
      out.push(describeCert(fs.readFileSync(file(previousDir(dir), n), 'utf8')));
    } catch {
      // a damaged backup is not worth failing a page over
    }
  }
  return out;
}

/**
 * Replaces the serving certificate with a new one from the same CA, for `names`. The one being replaced is copied to
 * `previous/` first and only the last PREVIOUS_KEEP stay. Nothing in `dir` changes unless the new certificate was made.
 */
export async function renewServing(opts: RenewServingOptions): Promise<RenewedServing> {
  const bin = opts.openssl ?? 'openssl';
  const { dir } = opts;
  const state = checkExisting(dir);
  if (!state.ca || !state.serving) throw new TlsError(`${dir} has no serving certificate to renew`);
  loadExisting(dir, state);
  const work = fs.mkdtempSync(path.join(dir, '.new-'));
  try {
    fs.chmodSync(work, 0o700);
    await issueServing(bin, dir, work, opts.names, opts.servingDays);
    const old = describeCert(fs.readFileSync(file(dir, 'serving.crt')));
    const prev = previousDir(dir);
    fs.mkdirSync(prev, { recursive: true, mode: 0o700 });
    const stamp = new Date((opts.now ?? Date.now)()).toISOString().replaceAll(/\D/g, '');
    const base = `serving-${stamp}-${old.serial.toLowerCase()}`;
    fs.copyFileSync(file(dir, 'serving.crt'), file(prev, `${base}.crt`));
    fs.copyFileSync(file(dir, 'serving.key'), file(prev, `${base}.key`));
    fs.chmodSync(file(prev, `${base}.key`), 0o600);
    for (const n of fs.readdirSync(prev).filter((f) => f.endsWith('.crt')).sort().reverse().slice(PREVIOUS_KEEP)) {
      fs.rmSync(file(prev, n), { force: true });
      fs.rmSync(file(prev, n.replace(/\.crt$/, '.key')), { force: true });
    }
    installServing(work, dir);
    const cert = fs.readFileSync(file(dir, 'serving.crt'), 'utf8');
    return { cert, key: fs.readFileSync(file(dir, 'serving.key'), 'utf8'), serving: describeCert(cert) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
