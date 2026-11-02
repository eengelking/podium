import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { MAIN_LOOP } from '../../fleet/protocol.js';
import { runStorageContract } from '../contract.js';
import { openStorage } from '../index.js';
import { sqliteReference } from '../sqlite/contractReference.js';
import type { Storage } from '../types.js';
import { openPostgresStorage } from './index.js';
import { upgradeCases } from '../contractUpgrade.js';
import { openUpgradedPostgres } from './upgradeTesting.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

const target = (td: TestDatabase): string => td.url.replace(/^postgres:\/\//, '');

// The whole contract against PostgreSQL. A test that fails
// before its own close leaves its database and storage behind, so every one opened is also dropped after the file.
describe.skipIf(!TEST_PG)('postgres storage', () => {
  const opened: { td: TestDatabase; storage: Storage }[] = [];
  afterAll(async () => {
    for (const { td, storage } of opened.splice(0)) {
      await Promise.race([storage.close().catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
      await td.drop();
    }
  });
  runStorageContract('postgres', async () => {
    const td = await createTestDatabase();
    const storage = await openPostgresStorage(target(td), 0);
    const entry = { td, storage };
    opened.push(entry);
    return { ...storage, close: async () => { await storage.close(); await td.drop(); opened.splice(opened.indexOf(entry), 1); } };
  }, sqliteReference);
});

describe.skipIf(!TEST_PG)('postgres upgrade contract', () => {
  const dropped: TestDatabase[] = [];
  afterAll(async () => {
    for (const td of dropped) await td.drop();
  });
  upgradeCases({
    openUpgraded: async (rows, reporters, sessions) => {
      const { storage, td } = await openUpgradedPostgres(rows, reporters, sessions);
      dropped.push(td);
      return storage;
    },
  });
});

describe.skipIf(!TEST_PG)('opening the PostgreSQL storage', () => {
  const dbs: TestDatabase[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.drop();
  });
  const fresh = async (): Promise<TestDatabase> => {
    const td = await createTestDatabase();
    dbs.push(td);
    return td;
  };

  it('is what openStorage returns for PODIUM_DB=postgres://... and for postgresql://', async () => {
    const td = await fresh();
    for (const scheme of ['postgres', 'postgresql']) {
      const s = await openStorage({ PODIUM_DB: td.url.replace(/^postgres:/, `${scheme}:`) });
      expect(await s.tx(async () => 7)).toBe(7);
      await s.close();
    }
  });

  it('builds both schemas, and the people store is real', async () => {
    const td = await fresh();
    const s = await openPostgresStorage(target(td));
    await s.people.createGroup('Crew', 3);
    expect((await s.people.allGroups()).map((g) => g.name)).toEqual(['Administrators', 'Crew']);
    const c = new pg.Client({ connectionString: td.url });
    await c.connect();
    const r = await c.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('podium', 'podium_activity') ORDER BY 1");
    await c.end();
    expect(r.rows.map((x: { schema_name: string }) => x.schema_name)).toEqual(['podium', 'podium_activity']);
    await s.close();
  });

  it('refuses a second server on the same database, naming it without a password, and lets a third in once the first is closed', async () => {
    const td = await fresh();
    const first = await openPostgresStorage(target(td));
    const u = new URL(td.url);
    const err = await openPostgresStorage(target(td)).then(() => null, (e: Error) => e);
    expect(err?.message).toBe(`Another Podium server is already using this database (${u.host}${u.pathname}). Stop it first; two servers on one database are not supported.`);
    expect(err?.message).not.toContain('@');
    expect(err?.message).not.toContain(`${u.username}:`);
    await first.close();
    const third = await openPostgresStorage(target(td));
    await third.close();
  });

  it('closes twice without error, and builds the activity services only once asked', async () => {
    const td = await fresh();
    const s = await openPostgresStorage(target(td));
    const opts = {
      history: { now: () => 0, settings: () => ({ policy: 'default' }) as never, isLive: () => true, authOn: true, agentsOf: async () => ['a1'] },
      recordings: { now: () => 0, settings: () => ({}) as never, flagOn: () => false, authOn: true, isLive: () => true, loopsOf: async () => [] },
    };
    const a = s.activity(opts);
    expect(a.history.enabled()).toBe(false);
    expect(await a.history.loopsToWatch('s1')).toEqual([MAIN_LOOP, 'a1']);
    expect(a.recordings.enabled()).toBe(false);
    a.recordings.noteOption('s1', true);
    expect(a.recordings.optionOn('s1')).toBe(true);
    a.recordings.forgetPodiumPrompt('s1', 'x');
    a.recordings.forgetSession('s1');
    expect(a.recordings.optionOn('s1')).toBe(false);
    expect(await a.recordings.has('s1')).toBe(false);
    await s.close();
    await s.close();
  });

  it('releases the lock and closes its pools when a migration fails', async () => {
    const td = await fresh();
    // A schema_migrations table with no applied_at column makes the first migration step fail after the lock was taken.
    const c = new pg.Client({ connectionString: td.url });
    await c.connect();
    await c.query('CREATE SCHEMA podium');
    await c.query('CREATE TABLE podium.schema_migrations (version BIGINT PRIMARY KEY)');
    await c.end();
    const first = await openPostgresStorage(target(td)).then(() => 'opened', (e: Error) => e.message);
    expect(first).toContain('applied_at');
    // The lock was freed: the second attempt fails on the migration again and not with "already using".
    const second = await openPostgresStorage(target(td)).then(() => 'opened', (e: Error) => e.message);
    expect(second).toContain('applied_at');
  });
});
