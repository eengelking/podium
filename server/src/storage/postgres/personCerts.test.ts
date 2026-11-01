import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { pgPersonCerts } from './personCerts.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import type { CertToStore } from '../../tlsClientAuth.js';

const cert = (fp: string, issuer = 'ca1', notAfter = '2030-01-01T00:00:00Z'): CertToStore =>
  ({
    cert: `PEM ${fp}`,
    issuerFingerprint: issuer,
    info: { fingerprintSha256: fp, serial: `s-${fp}`, notBefore: '2026-01-01T00:00:00Z', notAfter },
  }) as unknown as CertToStore;

describe.skipIf(!TEST_PG)('postgres person certificates', () => {
  let td: TestDatabase;
  let db: PgDb;
  let a: number;
  let b: number;
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 4, name: 'test' });
    await migrate(db, MAIN_SCHEMA, MAIN_STEPS);
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });
  beforeEach(async () => {
    await db.run('DELETE FROM person_certificates');
    await db.run('DELETE FROM people');
    for (const n of ['a', 'b']) {
      await db.run('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)', [n, n, `k${n}`, `h${n}`, 1]);
    }
    a = (await db.get<{ id: number }>('SELECT id FROM people WHERE name = ?', ['a']))!.id;
    b = (await db.get<{ id: number }>('SELECT id FROM people WHERE name = ?', ['b']))!.id;
  });

  it('adds a certificate, finds it and maps the columns to a row', async () => {
    const certs = pgPersonCerts(db);
    expect(await certs.find('f1')).toBeUndefined();
    const row = await certs.add(a, cert('f1'), 100);
    expect(row).toEqual({
      fingerprint: 'f1', serial: 's-f1', issuerFingerprint: 'ca1', personId: a, certPem: 'PEM f1',
      notBefore: Date.parse('2026-01-01T00:00:00Z'), notAfter: Date.parse('2030-01-01T00:00:00Z'), issuedAt: 100, revokedAt: null, reason: null,
    });
    expect(await certs.find('f1')).toEqual(row);
    expect((await certs.current(a))?.fingerprint).toBe('f1');
    expect(await certs.current(b)).toBeUndefined();
  });

  it('replaces: revokes the earlier live ones as reissued and keeps the new one live', async () => {
    const certs = pgPersonCerts(db);
    await certs.add(a, cert('f1'), 100);
    await certs.add(a, cert('f2'), 100);
    const row = await certs.replace(a, cert('f3'), 200);
    expect(row.revokedAt).toBeNull();
    expect((await certs.find('f1'))).toMatchObject({ revokedAt: 200, reason: 'reissued' });
    expect((await certs.find('f2'))).toMatchObject({ revokedAt: 200, reason: 'reissued' });
    expect((await certs.current(a))?.fingerprint).toBe('f3');
  });

  it('lists newest first and breaks a tie in issued_at by the last stored', async () => {
    const certs = pgPersonCerts(db);
    await certs.add(a, cert('f1'), 100);
    await certs.add(a, cert('f2'), 100);
    await certs.add(a, cert('f0'), 50);
    expect((await certs.listFor(a)).map((c) => c.fingerprint)).toEqual(['f2', 'f1', 'f0']);
  });

  it('rolls back a replace that fails, leaving the earlier certificate live', async () => {
    const certs = pgPersonCerts(db);
    await certs.add(a, cert('f1'), 100);
    await expect(certs.replace(a, cert('f1'), 200)).rejects.toThrow();
    expect(await certs.find('f1')).toMatchObject({ revokedAt: null, reason: null });
  });

  it('nests a replace inside an open transaction', async () => {
    const certs = pgPersonCerts(db);
    await certs.add(a, cert('f1'), 100);
    await expect(
      db.tx(async () => {
        await certs.replace(a, cert('f2'), 200);
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect((await certs.current(a))?.fingerprint).toBe('f1');
  });

  it('counts each person once, by their newest live certificate that has not ended', async () => {
    const certs = pgPersonCerts(db);
    const cutoff = Date.parse('2027-01-01T00:00:00Z');
    await certs.add(a, cert('f1', 'old'), 100);
    await certs.add(a, cert('f2', 'new'), 200);
    await certs.add(b, cert('f3', 'old'), 100);
    await certs.add(b, cert('f4', 'new', '2026-06-01T00:00:00Z'), 200);
    expect(await certs.reportersByIssuer(cutoff)).toEqual({ total: 2, byIssuer: { new: 1, old: 1 } });
    expect(await certs.reportersByIssuer(Date.parse('2031-01-01T00:00:00Z'))).toEqual({ total: 0, byIssuer: {} });
  });

  it('revokes a person live certificates and says how many', async () => {
    const certs = pgPersonCerts(db);
    await certs.add(a, cert('f1'), 100);
    await certs.add(a, cert('f2'), 100);
    expect(await certs.revokeFor(a, 'lost', 300)).toBe(2);
    expect(await certs.find('f1')).toMatchObject({ revokedAt: 300, reason: 'lost' });
    expect(await certs.current(a)).toBeUndefined();
    expect(await certs.revokeFor(a, 'lost', 400)).toBe(0);
  });

  it('gives two certificates added at once distinct order numbers', async () => {
    const certs = pgPersonCerts(db);
    await Promise.all(['f1', 'f2', 'f3', 'f4'].map((f) => certs.add(a, cert(f), 100)));
    const seqs = await db.all<{ seq: number }>('SELECT seq FROM person_certificates ORDER BY seq');
    expect(new Set(seqs.map((r) => r.seq)).size).toBe(4);
  });
});
