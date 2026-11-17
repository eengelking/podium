// Main step 19 (#755): `samples` gets an index on `t`, so the fleet-wide token and cost queries and the retention delete do not scan the table.
// A database made before it keeps every sample and gains the index. SQLite migration 43 and PostgreSQL step 19 do the same.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MariaDbConn, parseTarget } from './conn.js';
import { MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { TEST_MARIADB, createTestDatabase, type TestDatabase } from './testing.js';

describe.skipIf(!TEST_MARIADB)('mariadb samples(t) index migration', () => {
  let td: TestDatabase;
  let db: MariaDbConn;
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new MariaDbConn({ target: parseTarget(td.url), max: 4 });
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });

  const indexes = async (): Promise<string[]> =>
    (await db.all<{ index_name: string }>("SELECT DISTINCT index_name AS index_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'samples' ORDER BY index_name")).map((r) => r.index_name);

  it('adds samples_t to a database made before step 19 and keeps its samples', async () => {
    await migrate(db, MAIN_MIGRATIONS, MAIN_STEPS.filter((s) => s.version < 19));
    expect(await indexes()).not.toContain('samples_t');
    await db.run('INSERT INTO samples (session_id, t, tokens_total, tokens_delta, peak_context, running_agents, cost_usd) VALUES (?, ?, 10, 1, 0.5, 0, 0.25)', ['s1', 1000]);
    expect(await migrate(db, MAIN_MIGRATIONS, MAIN_STEPS)).toBe(MAIN_STEPS[MAIN_STEPS.length - 1]!.version);
    expect(await indexes()).toContain('samples_t');
    expect(await db.all<{ session_id: string; t: number }>('SELECT session_id, t FROM samples')).toEqual([{ session_id: 's1', t: 1000 }]);
    // running the steps again changes nothing
    expect(await migrate(db, MAIN_MIGRATIONS, MAIN_STEPS)).toBe(MAIN_STEPS[MAIN_STEPS.length - 1]!.version);
  });
});
