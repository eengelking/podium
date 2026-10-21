// Built-in TLS (#577, T10): rotating the CA. A planned rotation makes a new CA, signs a cross certificate for it with the old
// one, and for the length of the overlap trusts both CAs for client certificates and presents [new leaf, cross certificate],
// so a reporter that holds only the old CA still verifies the server. The old CA's key is not kept: it is overwritten by the
// new one, and nothing after the cross certificate is signed with it. Ending the overlap (a leaked key, or the Admin retiring
// the old CA) removes the old CA, and the cross certificate with it.
//
// In `dir`, beside the files of tlsCa.ts: `previous-ca.crt` (the old CA, public), `cross.crt` (the new CA's key signed by the
// old CA) and `rotation.json` ({ startedAt }). All three exist during an overlap and none otherwise.
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { caConfig, checkExisting, describeCert, file, genKey, installServing, issueServing, loadExisting, openssl, randomSerial, TlsError, type CertInfo, type RenewedServing, type ServerNames } from './tlsCa.js';

/** How long the cross certificate lasts, and so how long the overlap does: a reporter's 90 days plus its 30-day grace. */
export const CROSS_DAYS = 120;

const PREVIOUS = 'previous-ca.crt';
const CROSS = 'cross.crt';
const MARK = 'rotation.json';

const crossConfig = `[v3_cross]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
`;

const readPem = (p: string): string | null => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** What the Admin page shows of an overlap that is under way. */
export interface RotationView {
  previousCa: CertInfo;
  cross: CertInfo;
  startedAt: number;
}

/**
 * The CA certificates this server trusts, read from `dir` once and again on `reload()`. The listener, the serving renewer,
 * the certificate check on each request and the config files all ask this and nothing else, so they cannot disagree about
 * which CAs are trusted (the T5 review's concern).
 */
export class TrustStore {
  private current = '';
  private previous: string | null = null;
  private crossPem: string | null = null;
  private started = 0;

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {
    this.reload();
  }

  reload(): void {
    this.current = fs.readFileSync(file(this.dir, 'ca.crt'), 'utf8');
    this.previous = null;
    this.crossPem = null;
    const prev = readPem(file(this.dir, PREVIOUS));
    const cross = readPem(file(this.dir, CROSS));
    if (!prev || !cross) return;
    try {
      const x = new X509Certificate(cross);
      // The cross certificate counts only if it is the current CA's key signed by the previous CA. A rotation that stopped
      // part-way leaves the old ca.crt in place and these two files beside it, and that is not an overlap.
      if (!x.verify(new X509Certificate(prev).publicKey) || !x.publicKey.equals(new X509Certificate(this.current).publicKey)) return;
      this.previous = prev;
      this.crossPem = cross;
      const mark = JSON.parse(readPem(file(this.dir, MARK)) ?? '{}') as { startedAt?: unknown };
      this.started = typeof mark.startedAt === 'number' ? mark.startedAt : Date.parse(x.validFrom);
    } catch {
      this.previous = null;
      this.crossPem = null;
    }
  }

  currentCa(): string {
    return this.current;
  }

  previousCa(): string | null {
    return this.previous;
  }

  /** The CAs a client certificate may come from: the current one, then the previous one during an overlap. */
  caCerts(): string[] {
    return this.previous ? [this.current, this.previous] : [this.current];
  }

  /** SHA-256 fingerprints of `caCerts()`, the form a stored certificate's issuer is kept in. */
  trustedIssuers(): string[] {
    return this.caCerts().map((p) => new X509Certificate(p).fingerprint256);
  }

  private crossLive(): boolean {
    return this.crossPem !== null && Date.parse(new X509Certificate(this.crossPem).validTo) > this.now();
  }

  /** What the listener presents: the leaf, then the cross certificate while it is valid, and nothing else. */
  chain(leaf: string): string {
    const l = leaf.endsWith('\n') ? leaf : `${leaf}\n`;
    return this.crossPem && this.crossLive() ? l + this.crossPem : l;
  }

  rotation(): RotationView | null {
    if (!this.previous || !this.crossPem) return null;
    return { previousCa: describeCert(this.previous), cross: describeCert(this.crossPem), startedAt: this.started };
  }

  /** The new CA and its cross certificate for a renewal response: only during a planned overlap, and only while the cross certificate is valid. */
  deliverable(): { ca: string; cross: string } | null {
    return this.crossPem && this.crossLive() ? { ca: this.current, cross: this.crossPem } : null;
  }
}

function pathLenZero(pem: string, bin: string): boolean {
  try {
    return /pathlen:\s*0\b/.test(execFileSync(bin, ['x509', '-noout', '-text'], { input: pem }).toString());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new TlsError(`${bin} is not installed or not on PATH; built-in TLS needs it to make certificates`);
    throw new TlsError(`${bin} could not read the CA certificate`);
  }
}

/** True unless the CA in `dir` has `pathlen:0`, which cannot sit above a cross certificate, so a planned rotation would be refused. True when there is no CA to read. */
export function caCanOverlap(dir: string, openssl = 'openssl'): boolean {
  const crt = file(dir, 'ca.crt');
  if (!fs.existsSync(crt)) return true;
  try {
    return !pathLenZero(fs.readFileSync(crt, 'utf8'), openssl);
  } catch {
    // A page that only reports this must not fail because openssl is missing or the CA is unreadable; rotateCa still refuses with its own message.
    return true;
  }
}

export interface RotateOptions {
  dir: string;
  names: ServerNames;
  servingDays: number;
  /** True for the hard cutover: no overlap, the old CA is gone at once. */
  endOverlap: boolean;
  openssl?: string;
  now?: () => number;
  /** Length of the cross certificate; CROSS_DAYS unless a test says otherwise. */
  crossDays?: number;
}

export interface RotatedCa extends RenewedServing {
  ca: CertInfo;
  /** True when the old CA is still trusted (a planned rotation). */
  overlap: boolean;
}

const atomicWrite = (p: string, text: string): void => {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, p);
};

/**
 * Makes a new CA and a serving certificate from it, and moves them into `dir`. Nothing in `dir` changes unless everything was
 * made. A planned rotation refuses to start while another overlap is open, and for a CA whose pathlen is 0 (made before #588),
 * which cannot sit above a cross certificate.
 */
export async function rotateCa(o: RotateOptions): Promise<RotatedCa> {
  const bin = o.openssl ?? 'openssl';
  const now = (o.now ?? Date.now)();
  const { dir } = o;
  const state = checkExisting(dir);
  if (!state.ca || !state.serving) throw new TlsError('there is no CA to rotate');
  loadExisting(dir, state);
  const oldCa = fs.readFileSync(file(dir, 'ca.crt'), 'utf8');
  if (!o.endOverlap) {
    if (new TrustStore(dir, () => now).rotation()) throw new TlsError('a rotation is already in progress; retire the old CA first, or choose Rotate CA and end the overlap now');
    if (pathLenZero(oldCa, bin)) throw new TlsError('this CA was made before rotation with an overlap was possible and cannot be rotated that way; choose Rotate CA and end the overlap now, then reissue each reporter config');
  }
  for (const n of fs.readdirSync(dir)) if (n.startsWith('.new-')) fs.rmSync(file(dir, n), { recursive: true, force: true });
  const work = fs.mkdtempSync(path.join(dir, '.new-'));
  try {
    fs.chmodSync(work, 0o700);
    const cn = `Podium CA ${new Date(now).toISOString().slice(0, 10)}`;
    fs.writeFileSync(file(work, 'ca.cnf'), caConfig(cn));
    await genKey(bin, 'ca.key', work);
    await openssl(bin, ['req', '-new', '-x509', '-key', 'ca.key', '-sha256', '-days', String(10 * 365 + 3), '-set_serial', randomSerial(), '-config', 'ca.cnf', '-extensions', 'v3_ca', '-out', 'ca.crt'], work);
    fs.chmodSync(file(work, 'ca.key'), 0o600);
    if (!o.endOverlap) {
      fs.writeFileSync(file(work, 'cross.cnf'), crossConfig);
      await openssl(bin, ['req', '-new', '-key', 'ca.key', '-subj', `/CN=${cn}/O=podium`, '-out', 'cross.csr'], work);
      await openssl(bin, ['x509', '-req', '-in', 'cross.csr', '-CA', file(dir, 'ca.crt'), '-CAkey', file(dir, 'ca.key'), '-sha256', '-days', String(o.crossDays ?? CROSS_DAYS), '-set_serial', randomSerial(), '-extfile', 'cross.cnf', '-extensions', 'v3_cross', '-out', 'cross.crt'], work);
    }
    // The new CA signs the serving certificate from the work folder, which holds its ca.crt and ca.key.
    await issueServing(bin, work, work, o.names, o.servingDays);

    // The overlap files go first and the CA after, so a crash in between leaves the old CA with files that do not match it, which TrustStore ignores.
    if (o.endOverlap) {
      for (const n of [PREVIOUS, CROSS, MARK]) fs.rmSync(file(dir, n), { force: true });
    } else {
      atomicWrite(file(dir, PREVIOUS), oldCa);
      fs.renameSync(file(work, 'cross.crt'), file(dir, CROSS));
      atomicWrite(file(dir, MARK), JSON.stringify({ startedAt: now }));
    }
    fs.renameSync(file(work, 'ca.key'), file(dir, 'ca.key'));
    fs.renameSync(file(work, 'ca.crt'), file(dir, 'ca.crt'));
    installServing(work, dir);
    const cert = fs.readFileSync(file(dir, 'serving.crt'), 'utf8');
    return { cert, key: fs.readFileSync(file(dir, 'serving.key'), 'utf8'), serving: describeCert(cert), ca: describeCert(fs.readFileSync(file(dir, 'ca.crt'), 'utf8')), overlap: !o.endOverlap };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Ends an overlap: the old CA and the cross certificate go, so a client certificate it signed is no longer accepted. */
export function retireCa(dir: string): void {
  for (const n of [PREVIOUS, CROSS, MARK]) fs.rmSync(file(dir, n), { force: true });
}
