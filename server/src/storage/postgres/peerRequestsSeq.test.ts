// Migration step 2 of the main schema (#890): open peer requests get an insertion number. A database made before it keeps every request, in
// the order PostgreSQL can still give: by time, then by id. SQLite migration 26 numbers the same way (#916).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

describe.skipIf(!TEST_PG)('postgres peer request order migration', () => {
  let td: TestDatabase;
  let db: PgDb;
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 4, name: 'test' });
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });

  it('numbers the requests it finds by time and then id, keeps them all, and gives a new one the next number', async () => {
    // A database made before step 2: only the baseline has run, so peer_requests has no seq column.
    await migrate(db, MAIN_SCHEMA, MAIN_STEPS.slice(0, 1));
    for (const [id, at] of [['prq_c', 5000], ['prq_a', 5000], ['prq_b', 4000]] as const) {
      await db.run(
        `INSERT INTO peer_requests (id, owner, kind, from_key, to_key, level, reason, by, from_session, message_id, created_at)
         VALUES (?, 'ed', 'access', 'k1', 'k2', 'see', ?, 'n1', 's1', NULL, ?)`,
        [id, `why-${id}`, at],
      );
    }
    expect(await migrate(db, MAIN_SCHEMA, MAIN_STEPS)).toBe(MAIN_STEPS[MAIN_STEPS.length - 1]!.version);
    expect(await db.all<{ id: string; seq: number }>('SELECT id, seq FROM peer_requests ORDER BY created_at, seq')).toEqual([
      { id: 'prq_b', seq: 1 }, { id: 'prq_a', seq: 2 }, { id: 'prq_c', seq: 3 },
    ]);
    await db.run(
      `INSERT INTO peer_requests (id, owner, kind, from_key, to_key, level, reason, by, from_session, message_id, created_at, seq)
       VALUES ('prq_d', 'ed', 'access', 'k1', 'k2', 'see', 'new', 'n1', 's1', NULL, 5000, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_requests))`,
    );
    expect((await db.get<{ seq: number }>("SELECT seq FROM peer_requests WHERE id = 'prq_d'"))!.seq).toBe(4);
    // running the steps again changes nothing
    expect(await migrate(db, MAIN_SCHEMA, MAIN_STEPS)).toBe(MAIN_STEPS[MAIN_STEPS.length - 1]!.version);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM peer_requests'))!.n).toBe(4);
  });
});
