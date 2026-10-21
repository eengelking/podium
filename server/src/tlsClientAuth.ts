// Built-in TLS (#577, T5): who a client certificate belongs to. The certificate is found by its SHA-256 fingerprint and by
// nothing else: a subject or a serial can be copied by anyone who makes their own certificate. A connection counts only
// when Node verified the chain against the Podium CA(s) (`socket.authorized`, which means nothing unless the listener was
// given `ca`), and the row is checked again on every request, so a revoke takes effect on a connection that is still open.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { PeopleStore, PersonRow } from './fleet/people.js';
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

interface DbCert {
  fingerprint_sha256: string;
  serial: string;
  issuer_fingerprint: string;
  person_id: number;
  cert_pem: string;
  not_before: number;
  not_after: number;
  issued_at: number;
  revoked_at: number | null;
  reason: string | null;
}

const toRow = (r: DbCert): PersonCertRow => ({
  fingerprint: r.fingerprint_sha256,
  serial: r.serial,
  issuerFingerprint: r.issuer_fingerprint,
  personId: r.person_id,
  certPem: r.cert_pem,
  notBefore: r.not_before,
  notAfter: r.not_after,
  issuedAt: r.issued_at,
  revokedAt: r.revoked_at,
  reason: r.reason,
});

/** A person's certificates. Only the certificate is kept; the key is never passed in. */
export class PersonCertStore {
  private readonly stmts = new Map<string, StatementSync>();
  constructor(private readonly db: DatabaseSync) {}

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  find(fingerprint: string): PersonCertRow | undefined {
    const r = this.stmt('SELECT * FROM person_certificates WHERE fingerprint_sha256 = ?').get(fingerprint) as DbCert | undefined;
    return r && toRow(r);
  }

  /** The person's certificates, newest first. */
  listFor(personId: number): PersonCertRow[] {
    return (this.stmt('SELECT * FROM person_certificates WHERE person_id = ? ORDER BY issued_at DESC, rowid DESC').all(personId) as unknown as DbCert[]).map(toRow);
  }

  /** The newest certificate that is not revoked, or undefined. */
  current(personId: number): PersonCertRow | undefined {
    return this.listFor(personId).find((c) => c.revokedAt === null);
  }

  private insert(personId: number, c: CertToStore, now: number): void {
    this.stmt(
      `INSERT INTO person_certificates (fingerprint_sha256, serial, issuer_fingerprint, person_id, cert_pem, not_before, not_after, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.info.fingerprintSha256, c.info.serial, c.issuerFingerprint, personId, c.cert, Date.parse(c.info.notBefore), Date.parse(c.info.notAfter), now);
  }

  /**
   * Stores a new certificate and revokes the person's earlier live ones as `reissued`, in one step, so there is never a
   * moment with none or with two.
   */
  replace(personId: number, c: CertToStore, now: number): PersonCertRow {
    this.db.exec('BEGIN');
    try {
      this.stmt("UPDATE person_certificates SET revoked_at = ?, reason = 'reissued' WHERE person_id = ? AND revoked_at IS NULL").run(now, personId);
      this.insert(personId, c, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.find(c.info.fingerprintSha256)!;
  }

  /**
   * Stores a certificate a reporter renewed for itself and leaves the earlier ones live: the old certificate keeps working
   * until it expires, since another session of the same person may still hold it (SPEC 6, *Authenticating by certificate*).
   */
  add(personId: number, c: CertToStore, now: number): PersonCertRow {
    this.insert(personId, c, now);
    return this.find(c.info.fingerprintSha256)!;
  }

  /**
   * How many people are on each CA: a person counts once, by their newest certificate that is not revoked and has not run
   * past `cutoff` (its end, less the grace). Used to say how many reporters still depend on the old CA (#588).
   */
  reportersByIssuer(cutoff: number): { total: number; byIssuer: Record<string, number> } {
    const rows = this.stmt(
      `SELECT c.issuer_fingerprint AS issuer FROM person_certificates c
       WHERE c.rowid = (SELECT MAX(p.rowid) FROM person_certificates p WHERE p.person_id = c.person_id AND p.revoked_at IS NULL AND p.not_after > ?)`,
    ).all(cutoff) as unknown as Array<{ issuer: string }>;
    const byIssuer: Record<string, number> = {};
    for (const r of rows) byIssuer[r.issuer] = (byIssuer[r.issuer] ?? 0) + 1;
    return { total: rows.length, byIssuer };
  }

  /** Revokes the person's live certificates. Returns how many it revoked; 0 when there was none to revoke. */
  revokeFor(personId: number, reason: string, now: number): number {
    return Number(this.stmt('UPDATE person_certificates SET revoked_at = ?, reason = ? WHERE person_id = ? AND revoked_at IS NULL').run(now, reason, personId).changes);
  }
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
  certs: PersonCertStore;
  people: PeopleStore;
  /** SHA-256 fingerprints of the CA certificate(s) a client certificate may have been issued by. */
  trustedIssuers: () => string[];
  now: () => number;
}

/**
 * Who a connection's client certificate says it is. `none` is a connection that presented nothing (plain HTTP, or HTTPS
 * without a certificate); `refused` is one that presented a certificate that must not be trusted, and the caller must not
 * fall back to a token for it. Revoking a person's token revokes their certificate rows too (the Admin route does it), so this reads only the row.
 */
export function certAuth(socket: ClientSocket, d: CertAuthDeps): CertAuth {
  if (!socket.encrypted || typeof socket.getPeerCertificate !== 'function') return { kind: 'none' };
  const fingerprint = socket.getPeerCertificate().fingerprint256;
  if (!fingerprint) return { kind: 'none' };
  if (socket.authorized !== true) {
    const why = socket.authorizationError instanceof Error ? socket.authorizationError.message : (socket.authorizationError ?? 'unverified');
    return { kind: 'refused', reason: `client certificate not accepted: ${why}` };
  }
  const cert = d.certs.find(fingerprint);
  if (!cert) return { kind: 'refused', reason: 'client certificate is not one Podium issued' };
  if (cert.revokedAt !== null) return { kind: 'refused', reason: 'client certificate was revoked' };
  if (cert.notAfter < d.now()) return { kind: 'refused', reason: 'client certificate has expired' };
  if (!d.trustedIssuers().includes(cert.issuerFingerprint)) return { kind: 'refused', reason: 'client certificate was issued by a CA that is not trusted' };
  const person = d.people.getPerson(cert.personId);
  if (!person) return { kind: 'refused', reason: 'client certificate belongs to a person who no longer exists' };
  return { kind: 'person', person, cert };
}
