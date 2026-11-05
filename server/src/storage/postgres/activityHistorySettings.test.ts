import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { pgActivityHistorySettings } from './activityHistorySettings.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import { ACTIVITY_HISTORY_DEFAULTS } from '../../fleet/activityHistoryTypes.js';

describe.skipIf(!TEST_PG)('postgres activity history settings', () => {
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

  it('starts at the default policy', async () => {
    expect(await pgActivityHistorySettings(db, true).get()).toEqual(ACTIVITY_HISTORY_DEFAULTS);
  });

  it('saves a valid choice, keeps the other fields, and returns the whole settings', async () => {
    const s = pgActivityHistorySettings(db, true);
    expect(await s.set({ policy: 'after', n: 14, unit: 'days' })).toEqual({ ok: true, settings: { policy: 'after', n: 14, unit: 'days', capGb: null } });
    expect(await s.set({ capGb: 5 })).toEqual({ ok: true, settings: { policy: 'after', n: 14, unit: 'days', capGb: 5 } });
    expect(await s.set({ capGb: null })).toMatchObject({ ok: true, settings: { capGb: null } });
    expect(await s.get()).toEqual({ policy: 'after', n: 14, unit: 'days', capGb: null });
  });

  it('refuses nothing to change, an unknown setting, and every out-of-range value, saving nothing', async () => {
    const s = pgActivityHistorySettings(db, true);
    expect(await s.set({})).toEqual({ ok: false, error: 'nothing to change' });
    expect(await s.set({ nope: 1 })).toEqual({ ok: false, error: 'unknown setting: nope' });
    for (const patch of [{ policy: 'forever' }, { unit: 'years' }, { n: 0 }, { n: 3651 }, { n: 1.5 }, { n: '5' }, { capGb: 0 }, { capGb: 1001 }, { capGb: 'x' }]) {
      expect(await s.set(patch)).toMatchObject({ ok: false });
    }
    expect(await s.get()).toEqual(ACTIVITY_HISTORY_DEFAULTS);
  });

  it('takes the edges of every range', async () => {
    const s = pgActivityHistorySettings(db, true);
    expect(await s.set({ n: 1, capGb: 1 })).toMatchObject({ ok: true });
    expect(await s.set({ n: 3650, capGb: 1000 })).toMatchObject({ ok: true });
  });

  it('refuses a keep policy when the server has no token, and still takes the default', async () => {
    const s = pgActivityHistorySettings(db, false);
    const r = await s.set({ policy: 'all' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('sign-in token');
    expect(await s.set({ policy: 'default', n: 7 })).toMatchObject({ ok: true });
  });

  it('reads the default policy when a keep policy was saved before the token was removed', async () => {
    await pgActivityHistorySettings(db, true).set({ policy: 'all' });
    expect((await pgActivityHistorySettings(db, false).get()).policy).toBe('default');
    expect((await pgActivityHistorySettings(db, true).get()).policy).toBe('all');
  });

  it('falls back to the defaults for a damaged row or damaged fields', async () => {
    const s = pgActivityHistorySettings(db, true);
    const put = (v: string) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ['activity_history', v]);
    await put('not json');
    expect(await s.get()).toEqual(ACTIVITY_HISTORY_DEFAULTS);
    await put('7');
    expect(await s.get()).toEqual(ACTIVITY_HISTORY_DEFAULTS);
    await put(JSON.stringify({ policy: 'x', n: -1, unit: 'y', capGb: 0 }));
    expect(await s.get()).toEqual(ACTIVITY_HISTORY_DEFAULTS);
    await put(JSON.stringify({ policy: 'end', capGb: 3 }));
    expect(await s.get()).toEqual({ ...ACTIVITY_HISTORY_DEFAULTS, policy: 'end', capGb: 3 });
  });
});
