// Built-in TLS (#577, T7): a reporter renews its own certificate. `POST /api/reporter/renew` is authenticated by the
// person's current client certificate and carries the reporter's new public key (no Node API builds a CSR); the answer is a
// new certificate and the CA(s), which the helper writes to the config file in one atomic write (SPEC 6, *Authenticating by
// certificate*). The old certificate stays live until it expires, since another session may still hold it.
//
// An expired certificate may renew inside `tls.reporter.graceDays`. The TLS layer reports `CERT_HAS_EXPIRED` for a genuine
// expired certificate and for every forgery that is expired (self-signed, or from a fake CA with the same subject and
// serial), so that error and a serial prove nothing. The certificate is accepted only when its exact bytes are the ones
// Podium stored and its signature verifies under the CA key it was issued by.
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { X509Certificate, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PeopleStore, PersonRow } from './fleet/people.js';
import type { Logger } from './logging/logger.js';
import { TlsError } from './tlsCa.js';
import type { ClientSocket, PersonCertRow, PersonCertStore } from './tlsClientAuth.js';
import { personSubject, REPORTER_DAYS, signClientCert, type IssuedPersonCert, type PersonIssuer } from './tlsPeople.js';

const DAY_MS = 86_400_000;
/** A person's certificate is renewed at most once in this long (#612), unless the one presented has expired. */
export const MIN_RENEW_INTERVAL_MS = 3_600_000;

export interface ReporterSettings {
  /** `tls.reporter.lifetimeDays`: how long a person's certificate lasts. */
  lifetimeDays: number;
  /** `tls.reporter.graceDays`: how long after expiry a certificate may still renew itself. */
  graceDays: number;
}

export const REPORTER_DEFAULTS: ReporterSettings = { lifetimeDays: REPORTER_DAYS, graceDays: 30 };

export interface IssueForKeyOptions {
  dir: string;
  /** The token's key id: the subject is `CN=pdm_<keyId>, O=podium`, as for a certificate made with its own key. */
  keyId: string;
  /** PEM text of the reporter's public key. */
  publicKey: string;
  days?: number;
  openssl?: string;
}

/** The public key as PEM, or the reason it cannot be used. Only an EC P-256 public key is signed, the kind the helper makes. */
function checkPublicKey(pem: unknown): string {
  if (typeof pem !== 'string' || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem.trim())) {
    throw new TlsError('the body needs a PEM public key');
  }
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new TlsError('the public key cannot be read');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new TlsError('the public key must be an EC P-256 key');
  return `${key.export({ type: 'spki', format: 'pem' }).toString().trim()}\n`;
}

/** Makes a `clientAuth` certificate for the key given, signed by the CA in `dir`. Nothing is left on disk. */
export async function issueForPublicKey(o: IssueForKeyOptions): Promise<Omit<IssuedPersonCert, 'key'>> {
  const pub = checkPublicKey(o.publicKey);
  const { cert, info, issuerFingerprint } = await signClientCert(o, async (work) => {
    fs.writeFileSync(path.join(work, 'client.pub'), pub);
    return { input: ['-new', '-force_pubkey', 'client.pub', '-subj', personSubject(o.keyId)] };
  });
  return { cert, info, issuerFingerprint };
}

/** The parts of a `tls.TLSSocket` this reads: `raw` is the certificate's DER bytes, present even when it did not verify. */
export interface RenewSocket extends Omit<ClientSocket, 'getPeerCertificate'> {
  getPeerCertificate?: () => { fingerprint256?: string; raw?: Buffer };
}

export type RenewRefusal = 'NO_CERTIFICATE' | 'NOT_TRUSTED' | 'NOT_RECOGNISED' | 'REVOKED' | 'PAST_GRACE';

export type RenewAuth = { ok: true; person: PersonRow; cert: PersonCertRow; expired: boolean } | { ok: false; code: RenewRefusal; reason: string };

export interface RenewAuthDeps {
  certs: PersonCertStore;
  people: PeopleStore;
  /** SHA-256 fingerprints of the CA certificate(s) a client certificate may have been issued by. */
  trustedIssuers: () => string[];
  /** The CA certificate(s) in PEM; the signature of an expired certificate is checked against the one that issued it. */
  caCerts: () => string[];
  graceDays: () => number;
  now: () => number;
}

const refuse = (code: RenewRefusal, reason: string): RenewAuth => ({ ok: false, code, reason });

/**
 * Who may renew, from the certificate on the connection. A live certificate that Node verified against the Podium CA(s)
 * is looked up by its fingerprint. An expired one gets the same lookup and two more checks, because the error code does not tell a
 * genuine certificate from a forgery: its bytes must equal the stored certificate and its signature must verify under the
 * CA key that issued it.
 */
export function authorizeRenewal(socket: RenewSocket, d: RenewAuthDeps): RenewAuth {
  if (!socket.encrypted || typeof socket.getPeerCertificate !== 'function') return refuse('NO_CERTIFICATE', 'no client certificate');
  const peer = socket.getPeerCertificate();
  if (!peer.raw || !peer.fingerprint256) return refuse('NO_CERTIFICATE', 'no client certificate');
  let x: X509Certificate;
  try {
    x = new X509Certificate(peer.raw);
  } catch {
    return refuse('NOT_RECOGNISED', 'the client certificate cannot be read');
  }
  // The fingerprint is computed from the bytes and not taken on the socket's word.
  if (x.fingerprint256 !== peer.fingerprint256) return refuse('NOT_RECOGNISED', 'the client certificate does not match its fingerprint');
  const verified = socket.authorized === true;
  if (!verified) {
    const why = socket.authorizationError instanceof Error ? socket.authorizationError.message : socket.authorizationError;
    if (why !== 'CERT_HAS_EXPIRED') return refuse('NOT_TRUSTED', `client certificate not accepted: ${why ?? 'unverified'}`);
  }
  const row = d.certs.find(x.fingerprint256);
  if (!row) return refuse('NOT_RECOGNISED', 'client certificate is not one Podium issued');
  if (row.revokedAt !== null) return refuse('REVOKED', 'client certificate was revoked');
  if (!d.trustedIssuers().includes(row.issuerFingerprint)) return refuse('NOT_TRUSTED', 'client certificate was issued by a CA that is not trusted');
  const now = d.now();
  const expired = row.notAfter < now;
  if (!verified && !expired) return refuse('NOT_TRUSTED', 'client certificate not accepted: CERT_HAS_EXPIRED but the clock disagrees');
  if (expired) {
    const issuer = d.caCerts().map((p) => new X509Certificate(p)).find((c) => c.fingerprint256 === row.issuerFingerprint);
    let genuine = false;
    try {
      genuine = !!issuer && x.raw.equals(new X509Certificate(row.certPem).raw) && x.verify(issuer.publicKey);
    } catch {
      genuine = false;
    }
    if (!genuine) return refuse('NOT_RECOGNISED', 'client certificate is not one Podium issued');
    if (now - row.notAfter > d.graceDays() * DAY_MS) return refuse('PAST_GRACE', `client certificate expired more than ${d.graceDays()} days ago`);
  }
  const person = d.people.getPerson(row.personId);
  if (!person) return refuse('NOT_RECOGNISED', 'client certificate belongs to a person who no longer exists');
  return { ok: true, person, cert: row, expired };
}

const WORDS: Record<RenewRefusal, string> = {
  NO_CERTIFICATE: 'renewing needs your reporter certificate',
  NOT_TRUSTED: 'your certificate was not accepted',
  NOT_RECOGNISED: 'your certificate is not one this server issued',
  REVOKED: 'your certificate was revoked; ask an Admin to reissue your reporter config',
  PAST_GRACE: 'your certificate expired too long ago to renew itself; ask an Admin to reissue your reporter config',
};

export interface ReporterRenewDeps {
  certs: PersonCertStore;
  people: PeopleStore;
  logger: Logger;
  now: () => number;
  settings: () => ReporterSettings;
  trustedIssuers: () => string[];
  /** What signs a certificate and carries the CA(s); null while TLS is not running. */
  issuer: () => PersonIssuer | null;
}

/** The router for `/api/reporter`: only `POST /renew`, and only answered to a client certificate. */
export function createReporterRenewRouter(d: ReporterRenewDeps): Router {
  const router = Router();
  const json = express.json({ limit: '4kb', type: ['application/json'] });
  /** People with a renewal between the check and the stored row; a second request in that window would pass the hourly limit. */
  const inFlight = new Set<number>();

  const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    const issuer = d.issuer();
    const auth = authorizeRenewal(req.socket as unknown as RenewSocket, {
      certs: d.certs,
      people: d.people,
      trustedIssuers: d.trustedIssuers,
      caCerts: () => issuer?.caCerts() ?? [],
      graceDays: () => d.settings().graceDays,
      now: d.now,
    });
    if (!auth.ok) {
      d.logger.warn('tls.reporter_renew_refused', `podium: refused a certificate renewal from ${req.ip ?? 'unknown'}: ${auth.reason}`, { code: auth.code, reason: auth.reason, status: 401, source: req.ip });
      res.status(401).json({ ok: false, code: auth.code, error: WORDS[auth.code] });
      return;
    }
    // One renewal an hour per person, so a looping client cannot fill the table or keep openssl busy. A certificate that has
    // expired inside its grace is never held back: it has no other way in.
    if (!auth.expired) {
      const newest = d.certs.current(auth.person.id);
      const waitMs = inFlight.has(auth.person.id) ? 1000 : newest ? Math.min(newest.issuedAt + MIN_RENEW_INTERVAL_MS - d.now(), MIN_RENEW_INTERVAL_MS) : 0;
      if (waitMs > 0) {
        const retryAfter = Math.ceil(waitMs / 1000);
        d.logger.warn('tls.reporter_renew_refused', `podium: refused a certificate renewal from ${req.ip ?? 'unknown'}: ${auth.person.name} renewed less than an hour ago`, { code: 'TOO_SOON', reason: 'renewed less than an hour ago', status: 429, source: req.ip, retry_after: retryAfter });
        res.set('Retry-After', String(retryAfter));
        res.status(429).json({ ok: false, code: 'TOO_SOON', error: 'your certificate was renewed less than an hour ago; try again later', retryAfterSec: retryAfter });
        return;
      }
      inFlight.add(auth.person.id);
      res.once('close', () => inFlight.delete(auth.person.id));
    }
    res.locals.renewal = auth;
    next();
  };

  router.post('/renew', authenticate, json, (req, res) => {
    const auth = res.locals.renewal as Extract<RenewAuth, { ok: true }>;
    const issuer = d.issuer();
    if (!issuer) return void res.status(503).json({ ok: false, error: 'TLS is not running on this server' });
    const body: unknown = req.body;
    const publicKey = body && typeof body === 'object' ? (body as { publicKey?: unknown }).publicKey : undefined;
    void issueForPublicKey({ dir: issuer.dir, keyId: auth.person.keyId, publicKey: publicKey as string, days: d.settings().lifetimeDays, openssl: issuer.openssl })
      .then((issued) => {
        // Revoked, or the person removed, while OpenSSL was signing: do not hand a live certificate to someone who lost theirs.
        if (d.certs.find(auth.cert.fingerprint)?.revokedAt !== null || !d.people.getPerson(auth.person.id)) {
          return void res.status(401).json({ ok: false, code: 'REVOKED', error: WORDS.REVOKED });
        }
        d.certs.add(auth.person.id, issued, d.now());
        d.logger.info('tls.reporter_renewed', `podium: renewed ${auth.person.name}'s certificate${auth.expired ? ' (it had expired, inside the grace)' : ''}`, {
          person: auth.person.name,
          previous_fingerprint_sha256: auth.cert.fingerprint,
          fingerprint_sha256: issued.info.fingerprintSha256,
          not_after: issued.info.notAfter,
          within_grace: auth.expired,
        });
        // Only during a planned rotation; the reporter takes it as an addition and only if the cross certificate verifies under a CA it holds.
        const rotation = issuer.rotation?.();
        res.json({ ok: true, cert: issued.cert, ca: issuer.caCerts(), ...(rotation ? { rotation } : {}), expires: issued.info.notAfter, fingerprint: issued.info.fingerprintSha256 });
      })
      .catch((err: unknown) => {
        if (err instanceof TlsError && /public key/.test(err.message)) return void res.status(400).json({ ok: false, error: err.message });
        d.logger.error('tls.reporter_renew_failed', `podium: could not renew ${auth.person.name}'s certificate: ${(err as Error).message}`, { person: auth.person.name, reason: (err as Error).message });
        res.status(500).json({ ok: false, error: 'could not renew the certificate' });
      });
  });
  return router;
}
