// The connection (#822): the schema binding a URL cannot override, a transaction on a connection that dies, and the error a savepoint keeps.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb, withoutSettings } from './conn.js';
import { ACTIVITY_SCHEMA, ACTIVITY_STEPS, MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

const admin = async <T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};

describe('withoutSettings', () => {
  it('drops options and application_name and keeps the rest, and passes a value that is not a URL through', () => {
    expect(withoutSettings('postgres://u@h:5432/d?options=-c%20x%3D1&sslmode=require&application_name=a')).toBe('postgres://u@h:5432/d?sslmode=require');
    expect(withoutSettings('not a url')).toBe('not a url');
  });
});

describe.skipIf(!TEST_PG)('postgres connection', () => {
  let td: TestDatabase;

  beforeAll(async () => {
    td = await createTestDatabase();
  });
  afterAll(async () => {
    await td.drop();
  });

  it('binds the schema whatever the URL carries (options, application_name)', async () => {
    const hostile = [`${td.url}?options=-c%20search_path%3Dpublic`, `${td.url}?application_name=x`, `${td.url}?options=-c%20search_path%3Dpublic&application_name=x`];
    for (const url of hostile) {
      const main = new PgDb({ connectionString: url, schema: MAIN_SCHEMA, max: 2, name: 'main' });
      const act = new PgDb({ connectionString: url, schema: ACTIVITY_SCHEMA, max: 2, name: 'activity' });
      try {
        await migrate(main, MAIN_SCHEMA, MAIN_STEPS);
        await migrate(act, ACTIVITY_SCHEMA, ACTIVITY_STEPS);
        expect((await main.get<{ s: string }>(`SELECT current_setting('search_path') AS s`))!.s).toBe(MAIN_SCHEMA);
        expect((await act.get<{ s: string }>(`SELECT current_setting('search_path') AS s`))!.s).toBe(ACTIVITY_SCHEMA);
      } finally {
        await main.close();
        await act.close();
      }
    }
    const inPublic = await admin(td.url, (c) => c.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`));
    expect(inPublic.rows[0].n).toBe(0);
    const inMain = await admin(td.url, (c) => c.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'podium'`));
    expect(inMain.rows[0].n).toBeGreaterThan(0);
  });

  it('does not reuse the client of a transaction whose connection died', async () => {
    const db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 1, name: 'died' });
    try {
      let dead = 0;
      await expect(db.tx(async () => {
        dead = (await db.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid;
        await admin(td.url, (c) => c.query('SELECT pg_terminate_backend($1)', [dead]));
        await new Promise((r) => setTimeout(r, 100));
        await db.get('SELECT 1');
      })).rejects.toThrow();
      // With max 1 the pool hands out the same slot again: a destroyed client is replaced, a released dead one would fail here.
      const next = await db.get<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(next!.pid).not.toBe(dead);
      expect(db.pool.totalCount).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('destroys the client when COMMIT fails on a dead connection', async () => {
    const db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 1, name: 'commit' });
    try {
      let dead = 0;
      await expect(db.tx(async () => {
        dead = (await db.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid;
        await admin(td.url, (c) => c.query('SELECT pg_terminate_backend($1)', [dead]));
        await new Promise((r) => setTimeout(r, 100));
      })).rejects.toThrow();
      expect((await db.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid).not.toBe(dead);
    } finally {
      await db.close();
    }
  });

  it('keeps the original error when a savepoint cannot roll back', async () => {
    const db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 2, name: 'sp' });
    try {
      await expect(db.tx(async () => {
        await db.savepoint('sp_one', async () => {
          // Ends the savepoint from inside, so ROLLBACK TO SAVEPOINT in the catch has nothing to roll back to and throws.
          await db.exec('RELEASE SAVEPOINT sp_one');
          throw new Error('the real failure');
        });
      })).rejects.toThrow('the real failure');
    } finally {
      await db.close();
    }
  });

  it('aborts the whole transaction after a failed statement unless a savepoint wraps it (unlike SQLite)', async () => {
    const db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 2, name: 'abort' });
    try {
      await db.exec('CREATE TABLE IF NOT EXISTS ab_t (id int PRIMARY KEY)');
      await expect(db.tx(async () => {
        await db.run('INSERT INTO ab_t VALUES (1)');
        await db.run('INSERT INTO ab_t VALUES (1)').catch(() => undefined);
        await db.run('INSERT INTO ab_t VALUES (2)');
      })).rejects.toThrow(/current transaction is aborted/);
      expect(await db.all('SELECT id FROM ab_t')).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('rolls a savepoint back alone and lets the transaction go on', async () => {
    const db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 2, name: 'sp2' });
    try {
      await db.exec('CREATE TABLE IF NOT EXISTS sp_t (id int PRIMARY KEY)');
      await db.tx(async () => {
        await db.run('INSERT INTO sp_t VALUES (1)');
        await expect(db.savepoint('sp_dup', () => db.run('INSERT INTO sp_t VALUES (1)'))).rejects.toThrow();
        await db.run('INSERT INTO sp_t VALUES (2)');
      });
      expect((await db.all<{ id: number }>('SELECT id FROM sp_t ORDER BY id')).map((r) => r.id)).toEqual([1, 2]);
    } finally {
      await db.close();
    }
  });
});
