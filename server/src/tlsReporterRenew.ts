// Built-in TLS (#577, T7): a reporter renews its own certificate. `POST /api/reporter/renew` is authenticated by the
// person's current client certificate and carries the reporter's new public key (no Node API builds a CSR); the answer is a
// new certificate and the CA(s), which the helper writes to the config file in one atomic write (SPEC 6, *Authenticating by
// certificate*). The old certificate stays live until it expires, since another session may still hold it.
//
// A certificate is renewed only while it is valid (#665). The reporter port is mutual TLS with `rejectUnauthorized: true`, so
// an expired, untrusted or missing certificate never gets as far as this route, and a renewal answer (a new CA included)
// only travels over a connection Node verified. A certificate that lapsed is not renewed: an Admin generates a new config.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { jsonBody } from './jsonBody.js';
import { X509Certificate, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PersonRow } from './storage/rows.js';
import type { PeopleStoreApi, PersonCertsApi, Storage } from './storage/types.js';
import { asyncHandler } from './fleet/asyncHandler.js';
import type { Logger } from './logging/logger.js';
import { TlsError } from './tlsCa.js';
import type { ClientSocket, PersonCertRow } from './tlsClientAuth.js';
import { personSubject, REPORTER_DAYS, signClientCert, type IssuedPersonCert, type PersonIssuer } from './tlsPeople.js';

/** A person's certificate is renewed at most once in this long (#612). */
export const MIN_RENEW_INTERVAL_MS = 3_600_000;

export interface ReporterSettings {
  /** `tls.reporter.lifetimeDays`: how long a person's certificate lasts. */
  lifetimeDays: number;
}

export const REPORTER_DEFAULTS: ReporterSettings = { lifetimeDays: REPORTER_DAYS };

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

export type RenewRefusal = 'NO_CERTIFICATE' | 'NOT_TRUSTED' | 'NOT_RECOGNISED' | 'REVOKED';

export type RenewAuth = { ok: true; person: PersonRow; cert: PersonCertRow } | { ok: false; code: RenewRefusal; reason: string };

export interface RenewAuthDeps {
  certs: PersonCertsApi;
  people: PeopleStoreApi;
  /** SHA-256 fingerprints of the CA certificate(s) a client certificate may have been issued by. */
  trustedIssuers: () => string[];
  now: () => number;
}

const refuse = (code: RenewRefusal, reason: string): RenewAuth => ({ ok: false, code, reason });

/**
 * Who may renew, from the certificate on the connection: one that Node verified against the Podium CA(s), looked up by its
 * fingerprint. Anything Node did not verify, an expired certificate included, is refused (there is no grace).
 */
export async function authorizeRenewal(socket: RenewSocket, d: RenewAuthDeps): Promise<RenewAuth> {
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
  if (socket.authorized !== true) {
    const why = socket.authorizationError instanceof Error ? socket.authorizationError.message : socket.authorizationError;
    return refuse('NOT_TRUSTED', `client certificate not accepted: ${why ?? 'unverified'}`);
  }
  const row = await d.certs.find(x.fingerprint256);
  if (!row) return refuse('NOT_RECOGNISED', 'client certificate is not one Podium issued');
  if (row.revokedAt !== null) return refuse('REVOKED', 'client certificate was revoked');
  if (!d.trustedIssuers().includes(row.issuerFingerprint)) return refuse('NOT_TRUSTED', 'client certificate was issued by a CA that is not trusted');
  const person = await d.people.getPerson(row.personId);
  if (!person) return refuse('NOT_RECOGNISED', 'client certificate belongs to a person who no longer exists');
  if (person.revokedAt !== null) return refuse('REVOKED', 'client certificate was revoked');
  return { ok: true, person, cert: row };
}

const WORDS: Record<RenewRefusal, string> = {
  NO_CERTIFICATE: 'renewing needs your reporter certificate',
  NOT_TRUSTED: 'your certificate was not accepted',
  NOT_RECOGNISED: 'your certificate is not one this server issued',
  REVOKED: 'your certificate was revoked; ask an Admin to reissue your reporter config',
};

export interface ReporterRenewDeps {
  certs: PersonCertsApi;
  people: PeopleStoreApi;
  /** Runs a callback in one storage transaction: the check after signing and the stored row are one step. */
  tx: Storage['tx'];
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
  const json = jsonBody({ limit: '4kb', type: ['application/json'] });
  /** People with a renewal between the check and the stored row; a second request in that window would pass the hourly limit. */
  const inFlight = new Set<number>();

  const authenticate = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const auth = await authorizeRenewal(req.socket as unknown as RenewSocket, {
      certs: d.certs,
      people: d.people,
      trustedIssuers: d.trustedIssuers,
      now: d.now,
    });
    if (!auth.ok) {
      d.logger.warn('tls.reporter_renew_refused', `podium: refused a certificate renewal from ${req.ip ?? 'unknown'}: ${auth.reason}`, { code: auth.code, reason: auth.reason, status: 401, source: req.ip });
      res.status(401).json({ ok: false, code: auth.code, error: WORDS[auth.code] });
      return;
    }
    // One renewal an hour per person, so a looping client cannot fill the table or keep openssl busy.
    const newest = await d.certs.current(auth.person.id);
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
    res.locals.renewal = auth;
    next();
  });

  router.post('/renew', authenticate, json, (req, res) => {
    const auth = res.locals.renewal as Extract<RenewAuth, { ok: true }>;
    const issuer = d.issuer();
    if (!issuer) return void res.status(503).json({ ok: false, error: 'TLS is not running on this server' });
    const body: unknown = req.body;
    const publicKey = body && typeof body === 'object' ? (body as { publicKey?: unknown }).publicKey : undefined;
    void issueForPublicKey({ dir: issuer.dir, keyId: auth.person.keyId, publicKey: publicKey as string, days: d.settings().lifetimeDays, openssl: issuer.openssl })
      .then(async (issued) => {
        // Revoked, or the person removed, while OpenSSL was signing: do not hand a live certificate to someone who lost theirs.
        // The check and the stored row are one step, so a revoke cannot land between them.
        const kept = await d.tx(async () => {
          const person = await d.people.getPerson(auth.person.id);
          if ((await d.certs.find(auth.cert.fingerprint))?.revokedAt !== null || !person || person.revokedAt !== null) return false;
          await d.certs.add(auth.person.id, issued, d.now());
          return true;
        });
        if (!kept) return void res.status(401).json({ ok: false, code: 'REVOKED', error: WORDS.REVOKED });
        d.logger.info('tls.reporter_renewed', `podium: renewed ${auth.person.name}'s certificate`, {
          person: auth.person.name,
          previous_fingerprint_sha256: auth.cert.fingerprint,
          fingerprint_sha256: issued.info.fingerprintSha256,
          not_after: issued.info.notAfter,
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
