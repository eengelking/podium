import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MariaDbConn, parseTarget } from './conn.js';
import { MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { mariaTlsSettings } from './tlsSettings.js';
import { TEST_MARIADB, createTestDatabase, type TestDatabase } from './testing.js';
import { ALLOW_HTTP_KEY, COUNTDOWN_KEY, FIELDS, REPORTER_FIELDS, SERVING_DEFAULTS } from '../../tlsRenew.js';

describe.skipIf(!TEST_MARIADB)('mariadb TLS settings', () => {
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

  const life = 'tls.serving.lifetimeDays';
  const reporter = 'tls.reporter.lifetimeDays';

  it('reads the defaults when nothing is stored', async () => {
    const s = mariaTlsSettings(db);
    expect(await s.get()).toEqual(SERVING_DEFAULTS);
    expect(await s.getReporter()).toEqual({ lifetimeDays: REPORTER_FIELDS[reporter].def });
    expect(await s.allowReportersOverHttp()).toBe(true);
  });

  it('saves serving, reporter, countdown and allow-HTTP settings and reads them back', async () => {
    const s = mariaTlsSettings(db);
    const days = FIELDS[life].min;
    const r = await s.set({ [life]: days, [COUNTDOWN_KEY]: false, [ALLOW_HTTP_KEY]: false, [reporter]: REPORTER_FIELDS[reporter].min });
    expect(r).toMatchObject({ ok: true, changed: [life, COUNTDOWN_KEY, ALLOW_HTTP_KEY, reporter] });
    expect(await s.get()).toMatchObject({ lifetimeDays: days, headerCountdown: false });
    expect(await s.getReporter()).toEqual({ lifetimeDays: REPORTER_FIELDS[reporter].min });
    expect(await s.allowReportersOverHttp()).toBe(false);
    await s.set({ [ALLOW_HTTP_KEY]: true });
    expect(await s.allowReportersOverHttp()).toBe(true);
  });

  it('refuses nothing to change, an unknown key and a bad value, saving nothing', async () => {
    const s = mariaTlsSettings(db);
    expect(await s.set({})).toEqual({ ok: false, error: 'nothing to change' });
    expect(await s.set({ nope: 1 })).toEqual({ ok: false, error: 'unknown setting: nope' });
    expect(await s.set({ [COUNTDOWN_KEY]: 'yes' })).toEqual({ ok: false, error: 'The header countdown must be on or off' });
    expect(await s.set({ [ALLOW_HTTP_KEY]: 1 })).toEqual({ ok: false, error: 'Allow reporters over HTTP must be on or off' });
    expect(await s.set({ [life]: 1 })).toMatchObject({ ok: false });
    expect(await s.set({ [reporter]: 'x' })).toMatchObject({ ok: false });
    expect(await s.set({ [life]: FIELDS[life].min, [reporter]: 1 })).toMatchObject({ ok: false });
    expect(await db.get('SELECT COUNT(*) AS n FROM settings')).toEqual({ n: 0 });
  });

  it('reads a damaged value as its default', async () => {
    const s = mariaTlsSettings(db);
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [life, 'abc']);
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [reporter, '1']);
    expect(await s.get()).toEqual(SERVING_DEFAULTS);
    expect(await s.getReporter()).toEqual({ lifetimeDays: REPORTER_FIELDS[reporter].def });
  });

  it('seeds allow-HTTP once and leaves an existing row alone', async () => {
    const s = mariaTlsSettings(db);
    await s.seedAllowReportersOverHttp(false);
    expect(await s.allowReportersOverHttp()).toBe(false);
    await s.seedAllowReportersOverHttp(true);
    expect(await s.allowReportersOverHttp()).toBe(false);
  });
});
