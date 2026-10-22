// Built-in TLS (#577, T5): a client certificate for each person, and the reporter config file it travels in.
// The key is made in a work folder, read once for the config file and deleted with the folder. Podium keeps the
// certificate and never the key (SPEC 7.7, *Keys and certificates*).
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hostnameOf } from './hostCheck.js';
import type { PersonRow } from './fleet/people.js';
import { describeCert, openssl, randomSerial, TlsError, type CertInfo } from './tlsCa.js';
import type { PersonCertRow, PersonCertStore } from './tlsClientAuth.js';

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

const clientConfig = `[v3_client]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
`;

/** The part of making a certificate that differs: how the person's public key reaches `openssl x509`. */
export interface KeyStep {
  /** The `openssl x509` arguments that name the input and the subject, such as `-req -in client.csr`. */
  input: string[];
  /** The person's private key, when this step made one. */
  key?: string;
}

export interface SignOptions {
  dir: string;
  /** The token's key id: the subject is `CN=pdm_<keyId>, O=podium`, never the person's name. */
  keyId: string;
  days?: number;
  openssl?: string;
}

/** The subject of every person certificate. */
export const personSubject = (keyId: string): string => `/CN=pdm_${keyId}/O=podium`;

/**
 * Signs a `clientAuth` certificate with the CA in `dir`: the work folder, the extension file, the serial, the signing and
 * the reading back of the dates are here once. `prepare` puts the public key in the work folder and says how `openssl x509`
 * takes it. Nothing is left on disk.
 */
export async function signClientCert(o: SignOptions, prepare: (work: string, bin: string) => Promise<KeyStep>): Promise<IssuedPersonCert> {
  if (!/^[0-9a-f]{12}$/.test(o.keyId)) throw new TlsError('the token key id is not 12 hex digits');
  const bin = o.openssl ?? 'openssl';
  const caCrt = path.join(o.dir, 'ca.crt');
  const caKey = path.join(o.dir, 'ca.key');
  if (!fs.existsSync(caCrt) || !fs.existsSync(caKey)) throw new TlsError(`${o.dir} has no CA to sign with`);
  const work = fs.mkdtempSync(path.join(o.dir, '.new-'));
  try {
    fs.chmodSync(work, 0o700);
    fs.writeFileSync(path.join(work, 'client.cnf'), clientConfig);
    const step = await prepare(work, bin);
    await openssl(bin, ['x509', ...step.input, '-CA', caCrt, '-CAkey', caKey, '-sha256', '-days', String(o.days ?? REPORTER_DAYS), '-set_serial', randomSerial(), '-extfile', 'client.cnf', '-extensions', 'v3_client', '-out', 'client.crt'], work);
    const cert = fs.readFileSync(path.join(work, 'client.crt'), 'utf8');
    return { cert, key: step.key ?? '', info: describeCert(cert), issuerFingerprint: new X509Certificate(fs.readFileSync(caCrt, 'utf8')).fingerprint256 };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export type IssueOptions = SignOptions;

/** Makes a key and a `clientAuth` certificate for one person, signed by the CA in `dir`. Nothing is left on disk. */
export function issuePersonCert(o: IssueOptions): Promise<IssuedPersonCert> {
  return signClientCert(o, async (work, bin) => {
    await openssl(bin, ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'client.key'], work);
    fs.chmodSync(path.join(work, 'client.key'), 0o600);
    await openssl(bin, ['req', '-new', '-key', 'client.key', '-subj', personSubject(o.keyId), '-out', 'client.csr'], work);
    return { input: ['-req', '-in', 'client.csr'], key: fs.readFileSync(path.join(work, 'client.key'), 'utf8') };
  });
}

/** `s` without the `-` and `.` characters at both ends. Loops, not `/^[-.]+|[-.]+$/g`, which backtracks on a long run of them. */
const trimDashesAndDots = (s: string): string => {
  const edge = (c: number) => c === 45 || c === 46;
  let start = 0;
  let end = s.length;
  while (start < end && edge(s.charCodeAt(start))) start++;
  while (end > start && edge(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
};

/** A person's name as it appears in a file name: letters, digits, dot, underscore and dash; anything else becomes a dash. */
export const fileSafe = (name: string): string => trimDashesAndDots(name.replaceAll(/[^A-Za-z0-9._-]+/g, '-')).slice(0, 48) || 'person';

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
  /** The new CA and its cross certificate during a planned CA rotation, for a renewal response (#588). */
  rotation?: () => { ca: string; cross: string } | null;
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
