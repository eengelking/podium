import { afterAll, describe, expect, it } from 'vitest';
import { MAIN_LOOP } from '../../fleet/protocol.js';
import { openStorage } from '../index.js';
import { openMariaDbStorage } from './index.js';
import { COLLATION, MariaDbConn, parseTarget } from './conn.js';
import { ACTIVITY_MIGRATIONS, ACTIVITY_STEPS, MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { readSchema } from './contractAdapter.js';
import { TEST_MARIADB, createTestDatabase, withConnection, type TestDatabase } from './testing.js';

const target = (td: TestDatabase): string => td.url.replace(/^mariadb:\/\//, '');

describe.skipIf(!TEST_MARIADB)('opening the MariaDB storage (#823)', () => {
  const dbs: TestDatabase[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.drop();
  });
  const fresh = async (): Promise<TestDatabase> => {
    const td = await createTestDatabase();
    dbs.push(td);
    return td;
  };

  it('is what openStorage returns for PODIUM_DB=mariadb://...', async () => {
    const td = await fresh();
    const s = await openStorage({ PODIUM_DB: td.url });
    expect(await s.tx(async () => 7)).toBe(7);
    await s.close();
  });

  it('builds the main and the Activity tables in the one database, each with its own record of steps, and the people store is real', async () => {
    const td = await fresh();
    const s = await openMariaDbStorage(target(td));
    await s.people.createGroup('Crew', 3);
    expect((await s.people.allGroups()).map((g) => g.name)).toEqual(['Administrators', 'Crew']);
    const tables = await withConnection(td.url, async (c) => (await c.query<{ t: string }[]>('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1')).map((r) => r.t));
    expect(tables).toEqual(expect.arrayContaining(['sessions', 'people', 'entries', 'rec_entries', MAIN_MIGRATIONS, ACTIVITY_MIGRATIONS]));
    const versions = await withConnection(td.url, async (c) => ({
      main: Number((await c.query<{ v: bigint }[]>(`SELECT MAX(version) AS v FROM ${MAIN_MIGRATIONS}`))[0]!.v),
      activity: Number((await c.query<{ v: bigint }[]>(`SELECT MAX(version) AS v FROM ${ACTIVITY_MIGRATIONS}`))[0]!.v),
    }));
    expect(versions).toEqual({ main: MAIN_STEPS.at(-1)!.version, activity: ACTIVITY_STEPS.at(-1)!.version });
    await s.close();
  });

  it('sets utf8mb4 and the byte collation on the database, every table and every text column, whatever the server defaults to', async () => {
    const td = await fresh();
    const s = await openMariaDbStorage(target(td));
    await s.close();
    const { db, tables, cols } = await withConnection(td.url, async (c) => ({
      db: (await c.query<{ cs: string; co: string }[]>('SELECT default_character_set_name AS cs, default_collation_name AS co FROM information_schema.schemata WHERE schema_name = DATABASE()'))[0],
      tables: await c.query<{ t: string; co: string }[]>("SELECT table_name AS t, table_collation AS co FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'"),
      cols: await c.query<{ t: string; c: string; cs: string; co: string }[]>('SELECT table_name AS t, column_name AS c, character_set_name AS cs, collation_name AS co FROM information_schema.columns WHERE table_schema = DATABASE() AND character_set_name IS NOT NULL'),
    }));
    expect(db).toEqual({ cs: 'utf8mb4', co: COLLATION });
    expect(tables.filter((t) => t.co !== COLLATION)).toEqual([]);
    expect(cols.length).toBeGreaterThan(100);
    expect(cols.filter((x) => x.cs !== 'utf8mb4' || x.co !== COLLATION)).toEqual([]);
  });

  it('keeps emoji and accents, folds a person\'s name as the contract says (Ed and ed are one person), and keeps ids that differ only by case or a trailing space apart', async () => {
    const td = await fresh();
    const s = await openMariaDbStorage(target(td));
    try {
      const names = ['Ed', 'Zoë 🎉', 'Émile', '😀 Ünïcode'];
      for (const n of names) await s.people.createPerson(n, null, 1);
      expect((await s.people.list({})).rows.map((p) => p.name).sort()).toEqual([...names].sort());
      // The contract keeps people names unique whatever their case: the second is refused, and either spelling finds the first.
      await expect(s.people.createPerson('ed', null, 1)).rejects.toThrow('already taken');
      expect((await s.people.findByName('eD'))?.name).toBe('Ed');
      expect((await s.people.findByName('ZOË 🎉'))?.name).toBe('Zoë 🎉');
      // An id compares as bytes: a case or a trailing space makes another session, and each keeps its own emoji name.
      const { session } = await import('../contract.js');
      await s.fleet.upsertSession(session({ id: 'Sess', name: 'Grüße 😀' }));
      await s.fleet.upsertSession(session({ id: 'sess', name: 'grüße' }));
      expect((await s.fleet.getSession('Sess'))?.name).toBe('Grüße 😀');
      expect((await s.fleet.getSession('sess'))?.name).toBe('grüße');
      expect(await s.fleet.getSession('Sess ')).toBeUndefined();
      expect(await s.fleet.getSession('SESS')).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it('refuses a second server on the same database, naming it without a password, and lets a third in once the first is closed', async () => {
    const td = await fresh();
    const first = await openMariaDbStorage(target(td));
    const u = new URL(td.url);
    const err = await openMariaDbStorage(target(td)).then(() => null, (e: Error) => e);
    expect(err?.message).toBe(`Another Podium server is already using this database (${u.host}${u.pathname}). Stop it first; two servers on one database are not supported.`);
    expect(err?.message).not.toContain('@');
    expect(err?.message).not.toContain(`${u.username}:`);
    if (u.password) expect(err?.message).not.toContain(decodeURIComponent(u.password));
    await first.close();
    const third = await openMariaDbStorage(target(td));
    await third.close();
  });

  it('closes twice without error, and builds the activity services only once asked', async () => {
    const td = await fresh();
    const s = await openMariaDbStorage(target(td));
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
    // A record of steps with no applied_at column makes the first step's record fail after the lock was taken.
    await withConnection(td.url, (c) => c.query(`CREATE TABLE ${MAIN_MIGRATIONS} (version BIGINT PRIMARY KEY)`));
    const first = await openMariaDbStorage(target(td)).then(() => 'opened', (e: Error) => e.message);
    expect(first).toContain('applied_at');
    // The lock was freed: the second attempt fails on the migration again and not with "already using".
    const second = await openMariaDbStorage(target(td)).then(() => 'opened', (e: Error) => e.message);
    expect(second).toContain('applied_at');
  });

  it('refuses a URL with no database or with a parameter it does not know, before connecting, and never echoes the password', async () => {
    await expect(openMariaDbStorage('u:s3cret@127.0.0.1:1')).rejects.toThrow(/names its database.*127\.0\.0\.1:1/);
    await expect(openMariaDbStorage('u:s3cret@127.0.0.1:1')).rejects.not.toThrow(/s3cret/);
    await expect(openMariaDbStorage('u:s3cret@127.0.0.1:1/db?charset=latin1')).rejects.toThrow(/"charset" is not supported/);
  });
});

/**
 * DDL commits on its own in MariaDB, so a step that stops part way is not rolled back (#823). The runner is stopped before each chosen
 * statement in turn, as a process that dies would leave it, and started again; it must end with the same tables, columns and indexes as a
 * run that never stopped, and with every step recorded once.
 */
describe.skipIf(!TEST_MARIADB)('the migration runner, stopped between statements', () => {
  const dbs: TestDatabase[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.drop();
  });

  it('resumes a step that stopped part way and ends as a run that never stopped', async () => {
    const clean = await createTestDatabase();
    dbs.push(clean);
    const run = async (td: TestDatabase, stopAt?: number): Promise<number> => {
      const main = new MariaDbConn({ target: parseTarget(td.url), max: 2 });
      const act = new MariaDbConn({ target: parseTarget(td.url), max: 2 });
      let n = 0;
      const before = () => {
        if (n++ === stopAt) throw new Error('the runner died here');
      };
      try {
        await migrate(main, MAIN_MIGRATIONS, MAIN_STEPS, before);
        await migrate(act, ACTIVITY_MIGRATIONS, ACTIVITY_STEPS, before);
        return n;
      } finally {
        await main.close();
        await act.close();
      }
    };
    const total = await run(clean);
    const expected = await readSchema(clean.url, clean.name);
    const seeded = (td: TestDatabase) => withConnection(td.url, async (c) => (await c.query<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM \"groups\" WHERE name_lower = 'administrators'"))[0]!.n);
    // The first statement, one inside step 1, the last of step 1, the step-2 renumbering, a later step, the Activity step and the last statement.
    const step1 = MAIN_STEPS[0]!.statements.length;
    const stops = [...new Set([0, 1, Math.floor(step1 / 2), step1 - 1, step1, step1 + 1, step1 + 4, total - 8, total - 2, total - 1])].filter((x) => x >= 0 && x < total);
    for (const stop of stops) {
      const td = await createTestDatabase();
      dbs.push(td);
      await expect(run(td, stop), `stopped before statement ${stop}`).rejects.toThrow('the runner died here');
      // Stopped again later in the same run, then left to finish: each start does the unfinished step again from its first statement.
      await run(td, stop + 3).catch(() => undefined);
      await run(td);
      expect(await readSchema(td.url, td.name), `stopped before statement ${stop}`).toEqual(expected);
      expect(Number(await seeded(td)), `the Administrators group once, stopped before statement ${stop}`).toBe(1);
      const recorded = await withConnection(td.url, async (c) => (await c.query<{ v: bigint }[]>(`SELECT version AS v FROM ${MAIN_MIGRATIONS} ORDER BY version`)).map((r) => Number(r.v)));
      expect(recorded).toEqual(MAIN_STEPS.map((s) => s.version));
    }
  });

  it('numbers peer requests that already exist the same way when step 2 runs twice', async () => {
    const td = await createTestDatabase();
    dbs.push(td);
    const db = new MariaDbConn({ target: parseTarget(td.url), max: 2 });
    try {
      await migrate(db, MAIN_MIGRATIONS, MAIN_STEPS.slice(0, 1));
      for (const [id, at] of [['b', 5], ['a', 5], ['c', 1]] as const) {
        await db.run("INSERT INTO peer_requests (id, owner, kind, from_key, to_key, by, created_at) VALUES (?, 'ed', 'access', 'k1', 'k2', 'ed', ?)", [id, at]);
      }
      const step2 = MAIN_STEPS[1]!.statements;
      for (const sql of step2) await db.exec(sql);
      const once = await db.all('SELECT id, seq FROM peer_requests ORDER BY id');
      for (const sql of step2) await db.exec(sql);
      expect(await db.all('SELECT id, seq FROM peer_requests ORDER BY id')).toEqual(once);
      expect(once).toEqual([{ id: 'a', seq: 2 }, { id: 'b', seq: 3 }, { id: 'c', seq: 1 }]);
    } finally {
      await db.close();
    }
  });
});
