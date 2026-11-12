import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MariaDbConn, parseTarget } from './conn.js';
import { MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { mariaFeatureFlags } from './featureFlags.js';
import { TEST_MARIADB, createTestDatabase, type TestDatabase } from './testing.js';
import { ACTIVITY_FEED, FEATURES, RESPOND, UPDATE_CHECK } from '../features.js';

describe.skipIf(!TEST_MARIADB)('mariadb feature flags', () => {
  let td: TestDatabase;
  let db: MariaDbConn;
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new MariaDbConn({ target: parseTarget(td.url), max: 4 });
    await migrate(db, MAIN_MIGRATIONS, MAIN_STEPS);
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });
  beforeEach(async () => {
    await db.run('DELETE FROM settings');
  });

  it('reads every flag at its default when nothing is stored', async () => {
    const flags = mariaFeatureFlags(db);
    expect(await flags.view()).toEqual({ 'activity-feed': true, 'activity-output': false, respond: false, 'file-diff': false, 'peer-messaging': false, 'chat-everyone': false, 'session-recording': false, 'my-usage': false, 'update-check': true });
    expect(Object.keys(await flags.view())).toEqual(FEATURES.map((f) => f.id));
    expect(await flags.featureOn(UPDATE_CHECK)).toBe(true);
  });

  it('turns flags on and off and keeps them in the settings row', async () => {
    const flags = mariaFeatureFlags(db);
    expect(await flags.setFeature(RESPOND, true)).toBe(true);
    expect(await db.get('SELECT value FROM settings WHERE key = ?', ['feature.respond'])).toEqual({ value: '1' });
    expect(await mariaFeatureFlags(db).featureOn(RESPOND)).toBe(true);
    await flags.setFeature(ACTIVITY_FEED, false);
    expect(await flags.featureOn(ACTIVITY_FEED)).toBe(false);
    await flags.setFeature(RESPOND, false);
    expect(await flags.featureOn(RESPOND)).toBe(false);
  });

  it('refuses an id that is not a known flag and writes nothing', async () => {
    expect(await mariaFeatureFlags(db).setFeature('nope', true)).toBe(false);
    expect(await db.get('SELECT COUNT(*) AS n FROM settings WHERE key LIKE ?', ['feature.%'])).toEqual({ n: 0 });
  });
});
