import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { PgPeerSettings } from './peerSettings.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import { PEER_DEFAULTS, peerSettingError } from '../settings.js';

describe.skipIf(!TEST_PG)('postgres PeerSettings', () => {
  let td: TestDatabase;
  let db: PgDb;
  let s: PgPeerSettings;
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
    await db.exec('TRUNCATE settings');
    s = new PgPeerSettings(db);
  });

  it('starts at the defaults: 10 round trips, 6 a minute, 20,000 characters, 30 days', async () => {
    expect(await s.get()).toEqual(PEER_DEFAULTS);
    expect(await s.limits()).toEqual({ roundTrips: 10, perMinute: 6, maxChars: 20_000 });
    expect(await s.retainMs()).toBe(30 * 86_400_000);
  });

  it('saves a change and keeps the rest', async () => {
    expect(await s.set({ roundTrips: 4, retainDays: 7 })).toEqual({ ok: true, settings: { ...PEER_DEFAULTS, roundTrips: 4, retainDays: 7 } });
    expect(await s.get()).toEqual({ ...PEER_DEFAULTS, roundTrips: 4, retainDays: 7 });
  });

  it.each([
    [{ roundTrips: 0 }, 'Round trips must be a whole number from 1 to 100'],
    [{ roundTrips: 101 }, 'Round trips must be a whole number from 1 to 100'],
    [{ perMinute: 2.5 }, 'Messages per minute must be a whole number from 1 to 60'],
    [{ maxChars: 20_001 }, 'Longest message must be a whole number from 1 to 20000'],
    [{ retainDays: '30' }, 'Keep conversations must be a whole number from 1 to 365'],
    [{ hops: 3 }, 'unknown setting: hops'],
  ])('refuses %j and saves nothing', async (patch, error) => {
    expect(await s.set({ perMinute: 3, ...patch })).toEqual({ ok: false, error });
    expect(await s.get()).toEqual(PEER_DEFAULTS);
  });

  it('refuses an empty change', async () => {
    expect(await s.set({})).toEqual({ ok: false, error: 'nothing to change' });
  });

  it('ignores a stored value that is no longer valid, and unreadable JSON', async () => {
    await db.run("INSERT INTO settings (key, value) VALUES ('peer_settings', ?)", [JSON.stringify({ roundTrips: 999, perMinute: 2 })]);
    expect(await s.get()).toEqual({ ...PEER_DEFAULTS, perMinute: 2 });
    await db.run("UPDATE settings SET value = '{' WHERE key = 'peer_settings'");
    expect(await s.get()).toEqual(PEER_DEFAULTS);
  });

  it('checks a value against a lower bound, for an owner who can only be stricter', () => {
    expect(peerSettingError('roundTrips', 5, 4)).toBe('Round trips must be a whole number from 1 to 4');
    expect(peerSettingError('roundTrips', 4, 4)).toBeNull();
  });
});
