// Opening and closing the MariaDB storage when a step fails (#823): the lock's connection and every pool are let go whatever failed, so a
// failed start or a failed stop never leaves the database locked against the next server. Failures are injected into the connection class.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_MARIADB, createTestDatabase, withConnection, type TestDatabase } from './testing.js';
import { singleProcessLockName } from './conn.js';

const inject = vi.hoisted(() => ({ throwOnPool: 0, rejectClose: 0, made: 0, closes: 0 }));

vi.mock('./conn.js', async (load) => {
  const real = await load<typeof import('./conn.js')>();
  class Failing extends real.MariaDbConn {
    constructor(opts: ConstructorParameters<typeof real.MariaDbConn>[0]) {
      inject.made++;
      if (inject.made === inject.throwOnPool) throw new Error('injected: the pool could not be made');
      super(opts);
    }

    override async close(): Promise<void> {
      inject.closes++;
      if (inject.closes === inject.rejectClose) {
        await super.close();
        throw new Error('injected: a pool failed to close');
      }
      return super.close();
    }
  }
  return { ...real, MariaDbConn: Failing };
});

const { openMariaDbStorage } = await import('./index.js');

const target = (td: TestDatabase): string => td.url.replace(/^mariadb:\/\//, '');
const lockHolder = (td: TestDatabase) =>
  withConnection(td.url, async (c) => (await c.query<{ id: bigint | null }[]>('SELECT IS_USED_LOCK(?) AS id', [singleProcessLockName(td.name)]))[0]!.id);
/** Connections to the test database other than the one asking, after a moment for the server to see them go. */
const others = async (td: TestDatabase): Promise<number> => {
  await new Promise((r) => setTimeout(r, 200));
  return withConnection(td.url, async (c) => Number((await c.query<{ n: bigint }[]>('SELECT COUNT(*) AS n FROM information_schema.processlist WHERE db = ? AND id <> CONNECTION_ID()', [td.name]))[0]!.n));
};

describe.skipIf(!TEST_MARIADB)('opening and closing the MariaDB storage when a step fails', () => {
  const dbs: TestDatabase[] = [];
  afterEach(async () => {
    Object.assign(inject, { throwOnPool: 0, rejectClose: 0, made: 0, closes: 0 });
    for (const d of dbs.splice(0)) await d.drop();
  });
  const fresh = async () => {
    const td = await createTestDatabase();
    dbs.push(td);
    return td;
  };

  it('releases the lock and closes the main pool when the Activity pool cannot be made', async () => {
    const td = await fresh();
    inject.throwOnPool = 2;
    await expect(openMariaDbStorage(target(td), 0)).rejects.toThrow('injected: the pool could not be made');
    expect(await lockHolder(td)).toBeNull();
    expect(await others(td)).toBe(0);
  });

  it('closes the main pool and releases the lock when the Activity side fails to close, and still reports the failure', async () => {
    const td = await fresh();
    const s = await openMariaDbStorage(target(td), 0);
    s.activity({ history: { now: () => 0, settings: () => ({ policy: 'default' }) as never, isLive: () => true, authOn: true, agentsOf: async () => [] }, recordings: { now: () => 0, settings: () => ({}) as never, flagOn: () => false, authOn: true, isLive: () => true, loopsOf: async () => [] } });
    inject.closes = 0;
    inject.rejectClose = 1; // the first pool closed is the Activity one
    await expect(s.close()).rejects.toThrow('injected: a pool failed to close');
    expect(inject.closes).toBe(2);
    expect(await lockHolder(td)).toBeNull();
    expect(await others(td)).toBe(0);
    // A second server can start at once.
    const next = await openMariaDbStorage(target(td), 0);
    await next.close();
  });

  it('releases the lock when the main pool fails to close', async () => {
    const td = await fresh();
    const s = await openMariaDbStorage(target(td), 0);
    inject.closes = 0;
    inject.rejectClose = 2; // the Activity pool closes first, then the main one
    await expect(s.close()).rejects.toThrow('injected: a pool failed to close');
    expect(await lockHolder(td)).toBeNull();
  });
});
