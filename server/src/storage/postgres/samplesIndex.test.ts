// Main step 19 (#755): `samples` gets an index on `t`, so the fleet-wide token and cost queries and the retention delete do not scan the table.
// A database made before it keeps every sample and gains the index. SQLite migration 43 and MariaDB step 19 do the same.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

describe.skipIf(!TEST_PG)('postgres samples(t) index migration', () => {
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

  const indexes = async (): Promise<string[]> =>
    (await db.all<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'podium' AND tablename = 'samples' ORDER BY indexname")).map((r) => r.indexname);

  it('adds samples_t to a database made before step 19 and keeps its samples', async () => {
    await migrate(db, MAIN_SCHEMA, MAIN_STEPS.filter((s) => s.version < 19));
    expect(await indexes()).not.toContain('samples_t');
    await db.run('INSERT INTO samples (session_id, t, tokens_total, tokens_delta, peak_context, running_agents, cost_usd) VALUES (?, ?, 10, 1, 0.5, 0, 0.25)', ['s1', 1000]);
    expect(await migrate(db, MAIN_SCHEMA, MAIN_STEPS)).toBe(MAIN_STEPS[MAIN_STEPS.length - 1]!.version);
    expect(await indexes()).toContain('samples_t');
    expect(await db.all<{ session_id: string; t: number }>('SELECT session_id, t FROM samples')).toEqual([{ session_id: 's1', t: 1000 }]);
    // running the steps again changes nothing
    expect(await migrate(db, MAIN_SCHEMA, MAIN_STEPS)).toBe(MAIN_STEPS[MAIN_STEPS.length - 1]!.version);
  });
});
