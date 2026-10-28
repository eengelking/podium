import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from './storage/sqlite/index.js';
import type { CertToStore } from './tlsClientAuth.js';

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

function setup() {
  const storage = openSqliteStorage(':memory:');
  open.push(storage);
  return storage;
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 1);

/** A certificate row without OpenSSL: only the fields the store keeps. */
const cert = (n: number): CertToStore => ({
  cert: `PEM-${n}`,
  info: { fingerprintSha256: `fp-${n}`, serial: String(n), notBefore: new Date(NOW).toISOString(), notAfter: new Date(NOW + 30 * DAY).toISOString() } as CertToStore['info'],
  issuerFingerprint: 'ca-1',
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the person certificate store over the async storage (#313)', () => {
  // Guards the design, not the lock: `replace` is one synchronous SAVEPOINT inside one lock step, so these pass with the lock removed too
  // (checked). They fail only if `replace` is split across an await, or its revoke-then-add stops being one unit.
  it('leaves exactly one live certificate when replaces overlap, and the newest one asked for is it', async () => {
    const storage = setup();
    const { person } = await storage.people.createPerson('Ann');
    const rows = await Promise.all([1, 2, 3, 4, 5].map((n) => storage.personCerts.replace(person.id, cert(n), NOW + n)));
    expect(rows.map((r) => r.fingerprint)).toEqual(['fp-1', 'fp-2', 'fp-3', 'fp-4', 'fp-5']);
    const all = await storage.personCerts.listFor(person.id);
    expect(all).toHaveLength(5);
    expect(all.filter((c) => c.revokedAt === null).map((c) => c.fingerprint)).toEqual(['fp-5']);
    expect((await storage.personCerts.current(person.id))?.fingerprint).toBe('fp-5');
    expect(all.filter((c) => c.revokedAt !== null).every((c) => c.reason === 'reissued')).toBe(true);
  });

  // Guards the same design property as the test above (one step per replace); it does not depend on the lock.
  it('keeps one live certificate per person when different people are replaced at once', async () => {
    const storage = setup();
    const ann = (await storage.people.createPerson('Ann')).person;
    const bo = (await storage.people.createPerson('Bo')).person;
    await Promise.all([
      storage.personCerts.replace(ann.id, cert(1), NOW),
      storage.personCerts.replace(bo.id, cert(2), NOW),
      storage.personCerts.replace(ann.id, cert(3), NOW + 1),
      storage.personCerts.replace(bo.id, cert(4), NOW + 1),
    ]);
    expect((await storage.personCerts.current(ann.id))?.fingerprint).toBe('fp-3');
    expect((await storage.personCerts.current(bo.id))?.fingerprint).toBe('fp-4');
    expect((await storage.personCerts.reportersByIssuer(NOW)).total).toBe(2);
  });

  it('nests a replace in a transaction, and rolls it back with the transaction', async () => {
    const storage = setup();
    const { person } = await storage.people.createPerson('Ann');
    await storage.personCerts.replace(person.id, cert(1), NOW);
    await expect(
      storage.tx(async () => {
        await storage.personCerts.replace(person.id, cert(2), NOW + 1);
        expect((await storage.personCerts.current(person.id))?.fingerprint).toBe('fp-2');
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect((await storage.personCerts.current(person.id))?.fingerprint).toBe('fp-1');
    expect(await storage.personCerts.find('fp-2')).toBeUndefined();
  });

  it('undoes the earlier certificates being revoked when the new one cannot be stored', async () => {
    const storage = setup();
    const { person } = await storage.people.createPerson('Ann');
    await storage.personCerts.replace(person.id, cert(1), NOW);
    await expect(storage.personCerts.replace(person.id, cert(1), NOW + 1)).rejects.toThrow();
    expect((await storage.personCerts.current(person.id))?.fingerprint).toBe('fp-1');
    await storage.personCerts.replace(person.id, cert(2), NOW + 2);
    expect((await storage.personCerts.current(person.id))?.fingerprint).toBe('fp-2');
  });

  it('a renewal that checks and then stores in one transaction cannot land after a revoke; the same two calls apart can', async () => {
    const storage = setup();
    const { person } = await storage.people.createPerson('Ann');
    await storage.personCerts.replace(person.id, cert(1), NOW);

    // Apart: the check passes, a revoke lands while the certificate is being signed, then the new one is stored live.
    const apart = async () => {
      const held = await storage.personCerts.find('fp-1');
      await sleep(10);
      if (held?.revokedAt === null) await storage.personCerts.add(person.id, cert(2), NOW + 1);
    };
    await Promise.all([apart(), sleep(2).then(() => storage.personCerts.revokeFor(person.id, 'revoked', NOW + 1))]);
    expect((await storage.personCerts.current(person.id))?.fingerprint).toBe('fp-2'); // the hazard: revoked, yet a live certificate

    // Together: the revoke waits for the transaction, so it revokes the new certificate as well.
    await storage.personCerts.replace(person.id, cert(3), NOW + 2);
    const together = storage.tx(async () => {
      const held = await storage.personCerts.find('fp-3');
      await sleep(10);
      if (held?.revokedAt === null) await storage.personCerts.add(person.id, cert(4), NOW + 3);
    });
    await Promise.all([together, sleep(2).then(() => storage.personCerts.revokeFor(person.id, 'revoked', NOW + 3))]);
    expect(await storage.personCerts.current(person.id)).toBeUndefined();
    expect((await storage.personCerts.find('fp-4'))?.revokedAt).toBe(NOW + 3);
  });
});
