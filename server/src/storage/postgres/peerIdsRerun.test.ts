// The peer step that binds a person's end of a link to the id (step 26, #1284) runs once: a second run, as MariaDB's can after a crash between the rewrite and the version row, leaves an id and a
// gone key as they are, and the first run reads an all-digit name as a name. SQLite's migration 50 is held to the same in `sqlite/db.test.ts`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

describe.skipIf(!TEST_PG)('postgres peer person-end step', () => {
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

  it('turns person:<name> into person:<id> once, an all-digit name included, and leaves the result alone when the step runs again', async () => {
    await migrate(db, MAIN_SCHEMA, MAIN_STEPS.filter((s) => s.version <= 25));
    // Ids 1, 2 and 3: "a", "b" and a person called "1" (not the person with id 1).
    for (const n of ['a', 'b', '1']) await db.run('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, 1000)', [n, n, `key${n}`, '0'.repeat(64)]);
    for (const k of ['person:a', 'person:1', 'person:zz']) await db.run("INSERT INTO peer_rights (from_key, to_key, owner, level, paused, set_at) VALUES (?, 'rk', 'a', 'send', 0, 5000)", [k]);
    await migrate(db, MAIN_SCHEMA, MAIN_STEPS.filter((s) => s.version <= 27));
    const keys = async (): Promise<string[]> => (await db.all<{ from_key: string }>('SELECT from_key FROM peer_rights ORDER BY from_key')).map((r) => r.from_key);
    expect(await keys()).toEqual(['person:1', 'person:3', 'person:gone:zz']);
    await db.tx(async () => {
      await MAIN_STEPS.find((s) => s.version === 26)!.after!(db);
      await MAIN_STEPS.find((s) => s.version === 27)!.after!(db);
    });
    expect(await keys()).toEqual(['person:1', 'person:3', 'person:gone:zz']);
  });
});
