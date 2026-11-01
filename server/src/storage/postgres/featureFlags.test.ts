import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { pgFeatureFlags } from './featureFlags.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import { ACTIVITY_FEED, FEATURES, RESPOND, UPDATE_CHECK } from '../features.js';

describe.skipIf(!TEST_PG)('postgres feature flags', () => {
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
  beforeEach(async () => {
    await db.run('DELETE FROM settings');
  });

  it('reads every flag at its default when nothing is stored', async () => {
    const flags = pgFeatureFlags(db);
    expect(await flags.view()).toEqual({ 'activity-feed': true, 'activity-output': false, respond: false, 'file-diff': false, 'peer-messaging': false, 'session-recording': false, 'update-check': true });
    expect(Object.keys(await flags.view())).toEqual(FEATURES.map((f) => f.id));
    expect(await flags.featureOn(UPDATE_CHECK)).toBe(true);
  });

  it('turns flags on and off and keeps them in the settings row', async () => {
    const flags = pgFeatureFlags(db);
    expect(await flags.setFeature(RESPOND, true)).toBe(true);
    expect(await db.get('SELECT value FROM settings WHERE key = ?', ['feature.respond'])).toEqual({ value: '1' });
    expect(await pgFeatureFlags(db).featureOn(RESPOND)).toBe(true);
    await flags.setFeature(ACTIVITY_FEED, false);
    expect(await flags.featureOn(ACTIVITY_FEED)).toBe(false);
    await flags.setFeature(RESPOND, false);
    expect(await flags.featureOn(RESPOND)).toBe(false);
  });

  it('refuses an id that is not a known flag and writes nothing', async () => {
    expect(await pgFeatureFlags(db).setFeature('nope', true)).toBe(false);
    expect(await db.get('SELECT COUNT(*) AS n FROM settings WHERE key LIKE ?', ['feature.%'])).toEqual({ n: 0 });
  });
});
