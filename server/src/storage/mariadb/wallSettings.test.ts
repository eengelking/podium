import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MariaDbConn, parseTarget } from './conn.js';
import { MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { mariaWallSettings } from './wallSettings.js';
import { TEST_MARIADB, createTestDatabase, type TestDatabase } from './testing.js';
import { NOTICES } from '../features.js';

describe.skipIf(!TEST_MARIADB)('mariadb wall settings', () => {
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

  it('starts with every notice on and the other two switches off', async () => {
    const view = await mariaWallSettings(db).view();
    expect(Object.keys(view.notices)).toEqual(NOTICES.map((n) => n.id));
    expect(Object.values(view.notices).every((v) => v)).toBe(true);
    expect(view).toMatchObject({ showBackgroundSessions: false, cardTitleMachine: false });
  });

  it('says whether a setter changed the value, writing the default over an unset row counting as a change', async () => {
    const wall = mariaWallSettings(db);
    const id = NOTICES[0]!.id;
    expect(await wall.setNotice(id, true)).toEqual({ known: true, changed: true });
    expect(await wall.setNotice(id, true)).toEqual({ known: true, changed: false });
    expect(await wall.setNotice(id, false)).toEqual({ known: true, changed: true });
    expect((await wall.view()).notices[id]).toBe(false);
    expect(await wall.setNotice('nope', false)).toEqual({ known: false, changed: false });
    expect(await wall.setShowBackgroundSessions(true)).toBe(true);
    expect(await wall.setShowBackgroundSessions(true)).toBe(false);
    expect(await wall.setCardTitleMachine(true)).toBe(true);
    expect(await wall.setCardTitleMachine(true)).toBe(false);
    expect(await wall.view()).toMatchObject({ showBackgroundSessions: true, cardTitleMachine: true });
  });

  it('claims a change once when two setters write the same value at the same time', async () => {
    const wall = mariaWallSettings(db);
    const results = await Promise.all(Array.from({ length: 6 }, () => wall.setShowBackgroundSessions(true)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('dismisses an update only forward, and reads a damaged value as none', async () => {
    const wall = mariaWallSettings(db);
    expect(await wall.updateDismissed()).toBeNull();
    expect(await wall.dismissUpdate('1.2.0')).toBe(true);
    expect(await wall.updateDismissed()).toBe('1.2.0');
    expect(await wall.dismissUpdate('1.1.0')).toBe(false);
    expect(await wall.dismissUpdate('1.2.0')).toBe(false);
    expect(await wall.updateDismissed()).toBe('1.2.0');
    expect(await wall.dismissUpdate('1.3.0')).toBe(true);
    await db.run('UPDATE settings SET value = ? WHERE key = ?', ['junk', 'wall_update_dismissed']);
    expect(await wall.updateDismissed()).toBeNull();
    expect(await wall.dismissUpdate('0.0.1')).toBe(true);
  });
});
