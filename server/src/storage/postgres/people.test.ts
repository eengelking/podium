import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { ACTIVITY_STEPS, MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { PgPeopleStore } from './people.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

describe.skipIf(!TEST_PG)('postgres people store', () => {
  let td: TestDatabase;
  let db: PgDb;
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 4, name: 'test' });
    await migrate(db, MAIN_SCHEMA, MAIN_STEPS);
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });

  it('creates, finds and lists people, with numbers as numbers', async () => {
    const people = new PgPeopleStore(db);
    const { person, token } = await people.createPerson('Ada', null, 1_800_000_000_000);
    expect(typeof person.id).toBe('number');
    expect(person.createdAt).toBe(1_800_000_000_000);
    expect(token.length).toBeGreaterThan(10);
    expect((await people.findByName('ada'))!.id).toBe(person.id);
    await expect(people.createPerson('ADA')).rejects.toThrow('already taken');
    expect((await people.list({})).rows.map((r) => r.name)).toEqual(['Ada']);
    void ACTIVITY_STEPS;
  });
});
