// Built-in TLS (#577, T5): who a client certificate belongs to. The certificate is found by its SHA-256 fingerprint and by
// nothing else: a subject or a serial can be copied by anyone who makes their own certificate. A connection counts only
// when Node verified the chain against the Podium CA(s) (`socket.authorized`, which means nothing unless the listener was
// given `ca`), and the row is checked again on every request, so a revoke takes effect on a connection that is still open.
import type { PersonRow } from './storage/rows.js';
import type { PeopleStoreApi, PersonCertsApi } from './storage/types.js';
import type { IssuedPersonCert } from './tlsPeople.js';

/** What is kept of an issued certificate: never the key. */
export type CertToStore = Pick<IssuedPersonCert, 'cert' | 'info' | 'issuerFingerprint'>;

export interface PersonCertRow {
  fingerprint: string;
  serial: string;
  issuerFingerprint: string;
  personId: number;
  certPem: string;
  notBefore: number;
  notAfter: number;
  issuedAt: number;
  revokedAt: number | null;
  reason: string | null;
}

/** The parts of a `tls.TLSSocket` this reads, so a test can hand in a stand-in. */
export interface ClientSocket {
  encrypted?: boolean;
  authorized?: boolean;
  authorizationError?: string | Error | null;
  getPeerCertificate?: () => { fingerprint256?: string };
}

export type CertAuth =
  | { kind: 'none' }
  | { kind: 'person'; person: PersonRow; cert: PersonCertRow }
  | { kind: 'refused'; reason: string };

export interface CertAuthDeps {
  certs: PersonCertsApi;
  people: PeopleStoreApi;
  /** SHA-256 fingerprints of the CA certificate(s) a client certificate may have been issued by. */
  trustedIssuers: () => string[];
  now: () => number;
}

/**
 * Who a connection's client certificate says it is. `none` is a connection that presented nothing (plain HTTP, or HTTPS
 * without a certificate); `refused` is one that presented a certificate that must not be trusted, and the caller must not
 * fall back to a token for it. Revoking a person's token revokes their certificate rows too (the Admin route does it); the person's own revocation is checked as well, in case a path forgets.
 */
export async function certAuth(socket: ClientSocket, d: CertAuthDeps): Promise<CertAuth> {
  if (!socket.encrypted || typeof socket.getPeerCertificate !== 'function') return { kind: 'none' };
  const fingerprint = socket.getPeerCertificate().fingerprint256;
  if (!fingerprint) return { kind: 'none' };
  if (socket.authorized !== true) {
    const why = socket.authorizationError instanceof Error ? socket.authorizationError.message : (socket.authorizationError ?? 'unverified');
    return { kind: 'refused', reason: `client certificate not accepted: ${why}` };
  }
  const cert = await d.certs.find(fingerprint);
  if (!cert) return { kind: 'refused', reason: 'client certificate is not one Podium issued' };
  if (cert.revokedAt !== null) return { kind: 'refused', reason: 'client certificate was revoked' };
  if (cert.notAfter < d.now()) return { kind: 'refused', reason: 'client certificate has expired' };
  if (!d.trustedIssuers().includes(cert.issuerFingerprint)) return { kind: 'refused', reason: 'client certificate was issued by a CA that is not trusted' };
  const person = await d.people.getPerson(cert.personId);
  if (!person) return { kind: 'refused', reason: 'client certificate belongs to a person who no longer exists' };
  // Defense in depth: a token revoked without the certificate rows must not leave the certificate working.
  if (person.revokedAt !== null) return { kind: 'refused', reason: 'client certificate was revoked' };
  return { kind: 'person', person, cert };
}
