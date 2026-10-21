// Built-in TLS (#577, T5): a client certificate for each person, and the reporter config file it travels in.
// The key is made in a work folder, read once for the config file and deleted with the folder. Podium keeps the
// certificate and never the key (SPEC 7.7, *Keys and certificates*).
import { execFile } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { hostnameOf } from './hostCheck.js';
import type { PersonRow } from './fleet/people.js';
import { describeCert, TlsError, type CertInfo } from './tlsCa.js';
import type { PersonCertRow, PersonCertStore } from './tlsClientAuth.js';

const run = promisify(execFile);

export const REPORTER_DAYS = 90;
export const CONFIG_HEADER = '# podium-reporter-config v1';

export interface IssuedPersonCert {
  /** PEM text of the certificate (public). */
  cert: string;
  /** PEM text of the private key. Returned to the caller once and not kept anywhere by Podium. */
  key: string;
  info: CertInfo;
  /** SHA-256 fingerprint of the CA certificate that signed it. */
  issuerFingerprint: string;
}

export interface IssueOptions {
  dir: string;
  /** The token's key id: the subject is `CN=pdm_<keyId>, O=podium`, never the person's name. */
  keyId: string;
  days?: number;
  openssl?: string;
}

const clientConfig = `[v3_client]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
`;

const randomSerial = (): string => {
  const b = randomBytes(16);
  b[0] &= 0x7f;
  return `0x${b.toString('hex')}`;
};

async function openssl(bin: string, args: string[], cwd: string): Promise<void> {
  try {
    await run(bin, args, { cwd, timeout: 30_000 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new TlsError(`${bin} is not installed or not on PATH; built-in TLS needs it to make certificates`);
    throw new TlsError(`${bin} ${args[0]} failed: ${(e.stderr ?? e.message).toString().trim().split('\n')[0]}`);
  }
}

/** Makes a key and a `clientAuth` certificate for one person, signed by the CA in `dir`. Nothing is left on disk. */
export async function issuePersonCert(o: IssueOptions): Promise<IssuedPersonCert> {
  if (!/^[0-9a-f]{12}$/.test(o.keyId)) throw new TlsError('the token key id is not 12 hex digits');
  const bin = o.openssl ?? 'openssl';
  const caCrt = path.join(o.dir, 'ca.crt');
  const caKey = path.join(o.dir, 'ca.key');
  if (!fs.existsSync(caCrt) || !fs.existsSync(caKey)) throw new TlsError(`${o.dir} has no CA to sign with`);
  const work = fs.mkdtempSync(path.join(o.dir, '.new-'));
  try {
    fs.chmodSync(work, 0o700);
    fs.writeFileSync(path.join(work, 'client.cnf'), clientConfig);
    await openssl(bin, ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'client.key'], work);
    fs.chmodSync(path.join(work, 'client.key'), 0o600);
    await openssl(bin, ['req', '-new', '-key', 'client.key', '-subj', `/CN=pdm_${o.keyId}/O=podium`, '-out', 'client.csr'], work);
    await openssl(bin, ['x509', '-req', '-in', 'client.csr', '-CA', caCrt, '-CAkey', caKey, '-sha256', '-days', String(o.days ?? REPORTER_DAYS), '-set_serial', randomSerial(), '-extfile', 'client.cnf', '-extensions', 'v3_client', '-out', 'client.crt'], work);
    const cert = fs.readFileSync(path.join(work, 'client.crt'), 'utf8');
    const key = fs.readFileSync(path.join(work, 'client.key'), 'utf8');
    return { cert, key, info: describeCert(cert), issuerFingerprint: new X509Certificate(fs.readFileSync(caCrt, 'utf8')).fingerprint256 };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** A person's name as it appears in a file name: letters, digits, dot, underscore and dash; anything else becomes a dash. */
export const fileSafe = (name: string): string => name.replaceAll(/[^A-Za-z0-9._-]+/g, '-').replaceAll(/^[-.]+|[-.]+$/g, '').slice(0, 48) || 'person';

export interface ConfigFile {
  filename: string;
  content: string;
}

export interface ConfigInput {
  user: string;
  server: string;
  issuedAt: number;
  cert: string;
  key: string;
  info: CertInfo;
  /** The CA certificate(s): one, or two during a CA overlap. */
  caCerts: string[];
}

/** The reporter config file (SPEC 5.9): the first line, `# key: value` headers, then the CA, the certificate and the key. */
export function buildReporterConfig(i: ConfigInput): ConfigFile {
  const epoch = Math.floor(i.issuedAt / 1000);
  const header = [
    CONFIG_HEADER,
    `# user: ${i.user}`,
    `# server: ${i.server}`,
    `# issued-at: ${new Date(i.issuedAt).toISOString()} ${epoch}`,
    `# expires: ${i.info.notAfter}`,
    `# fingerprint: ${i.info.fingerprintSha256}`,
  ];
  const pem = (t: string) => (t.endsWith('\n') ? t : `${t}\n`);
  return {
    filename: `reporter-config-${fileSafe(i.user)}-${epoch}.pem`,
    content: `${header.join('\n')}\n${i.caCerts.map(pem).join('')}${pem(i.cert)}${pem(i.key)}`,
  };
}

/** What issuing a person's certificate needs from the running server. */
export interface PersonIssuer {
  dir: string;
  /** The HTTPS port the reporter will connect to. */
  port: number;
  /** The CA certificate(s) a config file carries: one, or two during a CA overlap. */
  caCerts: () => string[];
  days?: number;
  openssl?: string;
}

/** The address a reporter should use: the name the Admin reached this server by, on the HTTPS port. */
export function serverUrlFor(host: string | undefined, port: number): string {
  const h = hostnameOf(host) ?? 'localhost';
  return `https://${h.includes(':') ? `[${h}]` : h}:${port}`;
}

/**
 * Issues a person a certificate, stores the certificate (revoking any earlier live one) and builds their config file.
 * The key is in the returned file and nowhere else.
 */
export async function issueConfigFor(person: PersonRow, store: PersonCertStore, issuer: PersonIssuer, host: string | undefined, now: number): Promise<{ file: ConfigFile; cert: PersonCertRow }> {
  const issued = await issuePersonCert({ dir: issuer.dir, keyId: person.keyId, days: issuer.days, openssl: issuer.openssl });
  const cert = store.replace(person.id, issued, now);
  const file = buildReporterConfig({ user: person.name, server: serverUrlFor(host, issuer.port), issuedAt: now, cert: issued.cert, key: issued.key, info: issued.info, caCerts: issuer.caCerts() });
  return { file, cert };
}
