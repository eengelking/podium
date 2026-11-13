import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MariaDbConn, parseTarget } from './conn.js';
import { MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { mariaRecordingSettings } from './recordingSettings.js';
import { TEST_MARIADB, createTestDatabase, type TestDatabase } from './testing.js';
import { RECORDING_DEFAULTS, RECORDING_RANGES } from '../../fleet/protocol.js';

describe.skipIf(!TEST_MARIADB)('mariadb recording settings', () => {
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

  const put = (v: string) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', ['recording_settings', v]);

  it('starts at the defaults', async () => {
    expect(await mariaRecordingSettings(db).get()).toEqual(RECORDING_DEFAULTS);
  });

  it('saves valid fields, keeps the others and reports what was saved before', async () => {
    const s = mariaRecordingSettings(db);
    const hours = RECORDING_RANGES.keepHours.min;
    const r = await s.set({ keepHours: hours });
    expect(r).toEqual({ ok: true, before: RECORDING_DEFAULTS, settings: { ...RECORDING_DEFAULTS, keepHours: hours } });
    expect(await s.get()).toEqual({ ...RECORDING_DEFAULTS, keepHours: hours });
    const again = await s.set({ keepHours: RECORDING_RANGES.keepHours.max });
    expect(again).toMatchObject({ ok: true, before: { keepHours: hours } });
  });

  it('refuses nothing to change, an unknown setting and a bad value, saving nothing', async () => {
    const s = mariaRecordingSettings(db);
    expect(await s.set({})).toEqual({ ok: false, error: 'nothing to change' });
    expect(await s.set({ nope: 1 })).toEqual({ ok: false, error: 'unknown setting: nope' });
    expect(await s.set({ keepHours: 0 })).toMatchObject({ ok: false });
    expect(await s.set({ keepHours: 1.5 })).toMatchObject({ ok: false });
    expect(await s.set({ budgetMb: '5' })).toMatchObject({ ok: false });
    expect(await s.set({ budgetMb: RECORDING_RANGES.budgetMb.min, sessionMb: RECORDING_RANGES.sessionMb.max })).toEqual({
      ok: false,
      error: 'The limit for one session cannot be above the disk budget',
    });
    expect(await s.get()).toEqual(RECORDING_DEFAULTS);
  });

  it('falls back to the defaults for a damaged row or damaged fields', async () => {
    const s = mariaRecordingSettings(db);
    await put('not json');
    expect(await s.get()).toEqual(RECORDING_DEFAULTS);
    await put('7');
    expect(await s.get()).toEqual(RECORDING_DEFAULTS);
    await put(JSON.stringify({ keepHours: -1, budgetMb: 'x' }));
    expect(await s.get()).toEqual(RECORDING_DEFAULTS);
    await put(JSON.stringify({ keepHours: RECORDING_RANGES.keepHours.min }));
    expect(await s.get()).toEqual({ ...RECORDING_DEFAULTS, keepHours: RECORDING_RANGES.keepHours.min });
  });
});
