// A person's certificates on PostgreSQL (#822): the SQLite store's logic over `PgDb`. Only the certificate is kept.
import type { CertToStore, PersonCertRow } from '../../tlsClientAuth.js';
import type { PersonCertsApi } from '../types.js';
import type { PgDb } from './conn.js';

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

export const pgPersonCerts = (db: PgDb): PersonCertsApi => {
  const find = async (fingerprint: string): Promise<PersonCertRow | undefined> => {
    const r = await db.get<DbCert>('SELECT * FROM person_certificates WHERE fingerprint_sha256 = ?', [fingerprint]);
    return r && toRow(r);
  };
  const listFor = async (personId: number): Promise<PersonCertRow[]> =>
    (await db.all<DbCert>('SELECT * FROM person_certificates WHERE person_id = ? ORDER BY issued_at DESC, seq DESC', [personId])).map(toRow);
  // `seq` is one more than the highest at insert, so two inserts at once could take the same one: callers run this inside a transaction.
  const insert = (personId: number, c: CertToStore, now: number): Promise<number> =>
    db.run(
      `INSERT INTO person_certificates (fingerprint_sha256, serial, issuer_fingerprint, person_id, cert_pem, not_before, not_after, issued_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM person_certificates))`,
      [c.info.fingerprintSha256, c.info.serial, c.issuerFingerprint, personId, c.cert, Date.parse(c.info.notBefore), Date.parse(c.info.notAfter), now],
    );
  return {
    find,
    listFor,
    async current(personId) {
      return (await listFor(personId)).find((c) => c.revokedAt === null);
    },
    // A savepoint opens the transaction when none is open and nests inside a `Storage.tx` when one is (#313).
    async replace(personId, c, now) {
      await db.savepoint('replace_cert', async () => {
        await db.run("UPDATE person_certificates SET revoked_at = ?, reason = 'reissued' WHERE person_id = ? AND revoked_at IS NULL", [now, personId]);
        await insert(personId, c, now);
      });
      return (await find(c.info.fingerprintSha256))!;
    },
    async add(personId, c, now) {
      await db.tx(() => insert(personId, c, now));
      return (await find(c.info.fingerprintSha256))!;
    },
    async reportersByIssuer(cutoff) {
      const rows = await db.all<{ issuer: string }>(
        `SELECT c.issuer_fingerprint AS issuer FROM person_certificates c
         WHERE c.seq = (SELECT MAX(p.seq) FROM person_certificates p WHERE p.person_id = c.person_id AND p.revoked_at IS NULL AND p.not_after > ?)`,
        [cutoff],
      );
      const byIssuer: Record<string, number> = {};
      for (const r of rows) byIssuer[r.issuer] = (byIssuer[r.issuer] ?? 0) + 1;
      return { total: rows.length, byIssuer };
    },
    revokeFor: (personId, reason, now) =>
      db.run('UPDATE person_certificates SET revoked_at = ?, reason = ? WHERE person_id = ? AND revoked_at IS NULL', [now, reason, personId]),
  };
};
