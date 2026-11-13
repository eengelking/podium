import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MariaDbConn, parseTarget } from './conn.js';
import { MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { mariaActivityHistorySettings } from './activityHistorySettings.js';
import { TEST_MARIADB, createTestDatabase, type TestDatabase } from './testing.js';
import { ACTIVITY_HISTORY_DEFAULTS } from '../../fleet/activityHistoryTypes.js';

describe.skipIf(!TEST_MARIADB)('mariadb activity history settings', () => {
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

  it('starts at the default policy', async () => {
    expect(await mariaActivityHistorySettings(db, true).get()).toEqual(ACTIVITY_HISTORY_DEFAULTS);
  });

  it('saves a valid choice, keeps the other fields, and returns the whole settings', async () => {
    const s = mariaActivityHistorySettings(db, true);
    expect(await s.set({ policy: 'after', n: 14, unit: 'days' })).toEqual({ ok: true, settings: { policy: 'after', n: 14, unit: 'days', capGb: null } });
    expect(await s.set({ capGb: 5 })).toEqual({ ok: true, settings: { policy: 'after', n: 14, unit: 'days', capGb: 5 } });
    expect(await s.set({ capGb: null })).toMatchObject({ ok: true, settings: { capGb: null } });
    expect(await s.get()).toEqual({ policy: 'after', n: 14, unit: 'days', capGb: null });
  });

  it('refuses nothing to change, an unknown setting, and every out-of-range value, saving nothing', async () => {
    const s = mariaActivityHistorySettings(db, true);
    expect(await s.set({})).toEqual({ ok: false, error: 'nothing to change' });
    expect(await s.set({ nope: 1 })).toEqual({ ok: false, error: 'unknown setting: nope' });
    for (const patch of [{ policy: 'forever' }, { unit: 'years' }, { n: 0 }, { n: 3651 }, { n: 1.5 }, { n: '5' }, { capGb: 0 }, { capGb: 1001 }, { capGb: 'x' }]) {
      expect(await s.set(patch)).toMatchObject({ ok: false });
    }
    expect(await s.get()).toEqual(ACTIVITY_HISTORY_DEFAULTS);
  });

  it('takes the edges of every range', async () => {
    const s = mariaActivityHistorySettings(db, true);
    expect(await s.set({ n: 1, capGb: 1 })).toMatchObject({ ok: true });
    expect(await s.set({ n: 3650, capGb: 1000 })).toMatchObject({ ok: true });
  });

  it('refuses a keep policy when the server has no token, and still takes the default', async () => {
    const s = mariaActivityHistorySettings(db, false);
    const r = await s.set({ policy: 'all' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('sign-in token');
    expect(await s.set({ policy: 'default', n: 7 })).toMatchObject({ ok: true });
  });

  it('reads the default policy when a keep policy was saved before the token was removed', async () => {
    await mariaActivityHistorySettings(db, true).set({ policy: 'all' });
    expect((await mariaActivityHistorySettings(db, false).get()).policy).toBe('default');
    expect((await mariaActivityHistorySettings(db, true).get()).policy).toBe('all');
  });

  it('falls back to the defaults for a damaged row or damaged fields', async () => {
    const s = mariaActivityHistorySettings(db, true);
    const put = (v: string) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', ['activity_history', v]);
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
