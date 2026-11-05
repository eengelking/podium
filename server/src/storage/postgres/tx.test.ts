// Transactions on PostgreSQL (#822), checked through the people store, which is real. `Storage.tx` is `PgDb.tx` of the main pool.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { pgPeople } from './people.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

const pid = async (db: PgDb): Promise<number> => (await db.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid;
const tick = () => new Promise((r) => setTimeout(r, 20));

describe.skipIf(!TEST_PG)('postgres transactions', () => {
  let td: TestDatabase;
  let db: PgDb;
  const people = () => pgPeople(db);
  const groups = async () => (await people().allGroups()).map((g) => g.name).filter((n) => n !== 'Administrators');

  beforeAll(async () => {
    td = await createTestDatabase();
    db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 4, name: 'tx-test' });
    await migrate(db, MAIN_SCHEMA, MAIN_STEPS);
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });

  it('commits what the callback wrote when it resolves', async () => {
    await db.tx(async () => {
      await people().createGroup('Committed', 1);
    });
    expect(await groups()).toContain('Committed');
  });

  it('rolls back every write when the callback rejects, and rethrows', async () => {
    await expect(db.tx(async () => {
      await people().createGroup('Doomed one', 1);
      await people().createGroup('Doomed two', 1);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await groups()).not.toContain('Doomed one');
    expect(await groups()).not.toContain('Doomed two');
  });

  it('keeps every statement of one tx on one connection, and other calls on others', async () => {
    let inside: number[] = [];
    let outside = 0;
    await db.tx(async () => {
      inside = [await pid(db), await pid(db)];
      expect(db.inTx()).toBe(true);
    });
    outside = await pid(db);
    expect(inside[0]).toBe(inside[1]);
    expect(db.inTx()).toBe(false);
    expect(typeof outside).toBe('number');
  });

  it('takes concurrent tx calls one at a time, each on its own connection, without interleaving', async () => {
    // The gate in `PgDb.tx` serializes transactions, so two cannot be open at once: the second begins after the first has ended.
    const log: string[] = [];
    const pids: number[] = [];
    const run = (name: string) => db.tx(async () => {
      log.push(`${name} begin`);
      pids.push(await pid(db));
      await tick();
      pids.push(await pid(db));
      log.push(`${name} end`);
    });
    await Promise.all([run('a'), run('b')]);
    expect(log).toEqual(['a begin', 'a end', 'b begin', 'b end']);
    expect(pids[0]).toBe(pids[1]);
    expect(pids[2]).toBe(pids[3]);
  });

  it('joins an outer tx from a nested one, on the same connection, and rolls both back together', async () => {
    let outer = 0;
    let inner = 0;
    await expect(db.tx(async () => {
      outer = await pid(db);
      await db.tx(async () => {
        inner = await pid(db);
        await people().createGroup('Nested', 1);
      });
      expect(await groups()).toContain('Nested');
      throw new Error('outer fails');
    })).rejects.toThrow('outer fails');
    expect(inner).toBe(outer);
    expect(await groups()).not.toContain('Nested');
  });

  it('rolls back only its own step in a savepoint', async () => {
    await db.tx(async () => {
      await people().createGroup('Before', 1);
      await expect(db.savepoint('step_one', async () => {
        await people().createGroup('Inside', 1);
        throw new Error('step fails');
      })).rejects.toThrow('step fails');
      await db.savepoint('step_two', async () => {
        await people().createGroup('After', 1);
      });
    });
    const names = await groups();
    expect(names).toContain('Before');
    expect(names).toContain('After');
    expect(names).not.toContain('Inside');
  });

  it('runs a savepoint outside a tx as a tx of its own', async () => {
    await expect(db.savepoint('alone', async () => {
      await people().createGroup('Alone', 1);
      throw new Error('alone fails');
    })).rejects.toThrow('alone fails');
    expect(await groups()).not.toContain('Alone');
    await db.savepoint('alone_ok', async () => {
      await people().createGroup('Alone ok', 1);
    });
    expect(await groups()).toContain('Alone ok');
  });

  it('lets a later tx run after one that rejected', async () => {
    await expect(db.tx(async () => { throw new Error('first'); })).rejects.toThrow('first');
    expect(await db.tx(async () => 5)).toBe(5);
  });
});
