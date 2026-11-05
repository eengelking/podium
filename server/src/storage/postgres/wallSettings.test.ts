import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { pgWallSettings } from './wallSettings.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import { NOTICES } from '../features.js';

describe.skipIf(!TEST_PG)('postgres wall settings', () => {
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

  it('starts with every notice on and the other two switches off', async () => {
    const view = await pgWallSettings(db).view();
    expect(Object.keys(view.notices)).toEqual(NOTICES.map((n) => n.id));
    expect(Object.values(view.notices).every((v) => v)).toBe(true);
    expect(view).toMatchObject({ showBackgroundSessions: false, cardTitleMachine: false });
  });

  it('says whether a setter changed the value, writing the default over an unset row counting as a change', async () => {
    const wall = pgWallSettings(db);
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
    const wall = pgWallSettings(db);
    const results = await Promise.all(Array.from({ length: 6 }, () => wall.setShowBackgroundSessions(true)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('dismisses an update only forward, and reads a damaged value as none', async () => {
    const wall = pgWallSettings(db);
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
