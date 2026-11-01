import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REPORTING_MS, IDLE_MS, type ReporterSeen } from '../rows.js';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { PgReporterStore, pgReporters } from './reporters.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

const MIN = 60_000;
const START = 1_000_000_000_000;
let td: TestDatabase;
let db: PgDb;
let store: PgReporterStore;
beforeAll(async () => {
  if (!TEST_PG) return;
  td = await createTestDatabase();
  db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 4, name: 'test' });
  await migrate(db, MAIN_SCHEMA, MAIN_STEPS);
});
afterAll(async () => {
  if (!TEST_PG) return;
  await db.close();
  await td.drop();
});
beforeEach(async () => {
  if (!TEST_PG) return;
  await db.exec('DELETE FROM reporters; DELETE FROM reporter_ignores; DELETE FROM sessions; DELETE FROM settings');
  store = new PgReporterStore(db, START);
});

const seen = (over: Partial<ReporterSeen> = {}): ReporterSeen => ({
  kind: 'mod',
  machineId: '9f3a1c7d2e40',
  machineName: 'studio-m2',
  source: '192.168.1.24',
  owner: 'Dana',
  credential: 'pdm_3f9a1c07b2e4',
  version: '0.13.0',
  engineVersion: '2.1.299',
  sessionId: 's1',
  ...over,
});

describe.skipIf(!TEST_PG)('reporters', () => {
  it('says whether any reporter has reported', async () => {
    expect((await store.hasAny())).toBe(false);
    await store.record(seen(), START + MIN);
    expect((await store.hasAny())).toBe(true);
  });

  it('records a reporter on its machine id and keeps its first and last seen times', async () => {
    await store.record(seen(), START + MIN);
    await store.record(seen({ sessionId: 's2', version: '0.13.1' }), START + 5 * MIN);
    const l = (await store.list({}, START + 5 * MIN));
    expect(l.total).toBe(1);
    expect(l.rows[0]).toMatchObject({
      key: '9f3a1c7d2e40',
      name: 'studio-m2',
      who: 'Dana',
      version: '0.13.1',
      firstSeenAt: START + MIN,
      lastSeenAt: START + 5 * MIN,
      sessions: 2,
    });
  });

  describe('peers across the sessions of one machine (#838)', () => {
    const peersNow = async (now: number) => (await store.list({}, now)).rows[0]!.peers;
    const endSession = async (id: string, at: number) => {
      await db.run("INSERT INTO sessions (id, name, status, cwd, started_at, last_seen_at, ended_at) VALUES (?, 'n', 'done', '/p', ?, ?, ?)", [id, at, at, at]);
    };

    it('reads On while any live session reports true, however the reports interleave', async () => {
      for (let i = 0; i < 3; i++) {
        await store.record(seen({ sessionId: 'tty', peers: true }), START + (2 * i + 1) * MIN);
        expect(await peersNow(START + (2 * i + 1) * MIN)).toBe(true);
        await store.record(seen({ sessionId: 'run', peers: false }), START + (2 * i + 2) * MIN);
        expect(await peersNow(START + (2 * i + 2) * MIN)).toBe(true);
      }
    });

    it('reads Off when no session reports true', async () => {
      await store.record(seen({ sessionId: 'a', peers: false }), START + MIN);
      await store.record(seen({ sessionId: 'b', peers: false }), START + 2 * MIN);
      expect(await peersNow(START + 2 * MIN)).toBe(false);
    });

    it('reads Off again once the participating session has ended', async () => {
      await store.record(seen({ sessionId: 'tty', peers: true }), START + MIN);
      await endSession('tty', START + 2 * MIN);
      await store.record(seen({ sessionId: 'run', peers: false }), START + 3 * MIN);
      expect(await peersNow(START + 3 * MIN)).toBe(false);
    });

    it('reads Off when the same session turns the option off', async () => {
      await store.record(seen({ sessionId: 'tty', peers: true }), START + MIN);
      await store.record(seen({ sessionId: 'tty', peers: false }), START + 2 * MIN);
      expect(await peersNow(START + 2 * MIN)).toBe(false);
    });

    it('keeps the last value when a report carries none', async () => {
      await store.record(seen({ sessionId: 'tty', peers: true }), START + MIN);
      await store.record(seen({ sessionId: 'run', peers: null }), START + 2 * MIN);
      expect(await peersNow(START + 2 * MIN)).toBe(true);
    });
  });

  it('returns the key and keeps the last OS and peers option it was sent (#347)', async () => {
    expect((await store.record(seen(), START + MIN))).toBe('9f3a1c7d2e40');
    expect((await store.list({}, START + MIN)).rows[0]).toMatchObject({ os: null, peers: null });
    await store.record(seen({ os: 'macOS 27.0.1', peers: true }), START + 2 * MIN);
    await store.record(seen({ os: null, peers: null }), START + 3 * MIN);
    expect((await store.list({}, START + 3 * MIN)).rows[0]).toMatchObject({ os: 'macOS 27.0.1', peers: true });
    await store.record(seen({ peers: false }), START + 4 * MIN);
    expect((await store.list({}, START + 4 * MIN)).rows[0]).toMatchObject({ os: 'macOS 27.0.1', peers: false });
  });

  it('looks reporters up for messaging, by key and by owner whatever the case (#347)', async () => {
    await store.record(seen({ os: 'macOS 27.0.1', peers: true }), START + MIN);
    await store.record(seen({ machineId: 'bbbbbbbbbbbb', machineName: null, owner: 'dana', credential: 'admin secret', sessionId: 's2' }), START + MIN);
    await store.record(seen({ machineId: 'cccccccccccc', owner: 'Alex', sessionId: 's3' }), START + MIN);
    const look = store.peerLookup();
    expect((await look.get('9f3a1c7d2e40'))).toEqual({ key: '9f3a1c7d2e40', machine: 'studio-m2', owner: 'Dana', adminSecret: false, os: 'macOS 27.0.1', peers: true, version: '0.13.0' });
    expect((await look.get('bbbbbbbbbbbb'))).toMatchObject({ machine: 'bbbbbbbbbbbb', adminSecret: true, peers: null });
    expect((await look.get('nope'))).toBeNull();
    expect((await look.ofOwner('DANA')).map((r) => r.key)).toEqual(['bbbbbbbbbbbb', '9f3a1c7d2e40']);
    // A hooks-only reporter has no orchestrator: neither lookup knows it, so no right can name it.
    expect((await store.record(seen({ kind: 'hooks', machineId: 'dddddddddddd', sessionId: 's4' }), START + MIN))).toBe('dddddddddddd');
    expect((await look.get('dddddddddddd'))).toBeNull();
    expect((await look.ofOwner('Dana')).map((r) => r.key)).not.toContain('dddddddddddd');
  });

  it('gives one owner its reporters with the state and last report Admin > Reporters shows (#415)', async () => {
    await store.record(seen(), START + MIN);
    await store.record(seen({ machineId: 'bbbbbbbbbbbb', machineName: 'build-pi', sessionId: 's2' }), START + 60 * MIN);
    await store.record(seen({ machineId: 'cccccccccccc', machineName: 'ci', sessionId: 's3' }), START + 90 * MIN);
    // Heard from before the server started: "Not since restart".
    await store.record(seen({ machineId: 'eeeeeeeeeeee', machineName: 'old', sessionId: 's5' }), START - MIN);
    await store.record(seen({ kind: 'hooks', machineId: 'dddddddddddd', sessionId: 's4' }), START + 90 * MIN);
    const now = START + 91 * MIN;
    const look = store.peerLookup();
    expect(look.startedAt).toBe(START);
    const mine = (await look.ofOwnerSeen('dana', now));
    expect(mine.map((r) => [r.machine, r.state, r.lastSeenAt])).toEqual([
      ['build-pi', 'idle', START + 60 * MIN],
      ['ci', 'reporting', START + 90 * MIN],
      ['old', 'restart', START - MIN],
      ['studio-m2', 'silent', START + MIN],
    ]);
    expect(mine[3]).toEqual({ ...(await look.get('9f3a1c7d2e40')), state: 'silent', lastSeenAt: START + MIN, compat: 'ok' });
    // The same words and version check as the Admin's list, row for row.
    const admin = new Map((await store.list({}, now)).rows.map((r) => [r.key, [r.state, r.lastSeenAt, r.compat]]));
    for (const r of mine) expect([r.state, r.lastSeenAt, r.compat]).toEqual(admin.get(r.key));
    expect((await look.ofOwnerSeen('Alex', now))).toEqual([]);
  });

  it('counts a session once however often it reports', async () => {
    for (let i = 0; i < 4; i++) (await store.record(seen(), START + i * MIN));
    expect((await store.list({}, START + 4 * MIN)).rows[0]!.sessions).toBe(1);
  });

  it('keeps one row per account when two accounts report from one machine id (issue #221)', async () => {
    const ana = { owner: 'Ana', credential: 'pdm_aaaaaaaaaaaa' };
    const ben = { owner: 'Ben', credential: 'pdm_bbbbbbbbbbbb' };
    await store.record(seen({ ...ana, sessionId: 'a1' }), START + MIN);
    await store.record(seen({ ...ben, sessionId: 'b1' }), START + 2 * MIN);
    await store.record(seen({ ...ana, sessionId: 'a2' }), START + 3 * MIN);
    await store.record(seen({ ...ben, sessionId: 'b2' }), START + 4 * MIN);
    const rows = (await store.list({ sort: 'who' }, START + 4 * MIN)).rows;
    expect(rows.map((r) => [r.who, r.credential, r.sessions])).toEqual([
      ['Ana', 'pdm_aaaaaaaaaaaa', 2],
      ['Ben', 'pdm_bbbbbbbbbbbb', 2],
    ]);
    // The first account keeps the machine id as its key, so rows and ignore rules made before this fix still match.
    expect(rows[0]!.key).toBe('9f3a1c7d2e40');
    expect(rows[1]!.key).not.toBe(rows[0]!.key);
  });

  it('files a report under the account row after the first account is removed, not under a second copy (issue #221)', async () => {
    await store.record(seen({ owner: 'Ana', sessionId: 'a1' }), START + MIN);
    await store.record(seen({ owner: 'Ben', sessionId: 'b1' }), START + MIN);
    await store.remove('9f3a1c7d2e40');
    await store.record(seen({ owner: 'Ben', sessionId: 'b2' }), START + 2 * MIN);
    await store.record(seen({ owner: 'Ana', sessionId: 'a2' }), START + 3 * MIN);
    const rows = (await store.list({ sort: 'who' }, START + 3 * MIN)).rows;
    expect(rows.map((r) => r.who)).toEqual(['Ana', 'Ben']);
  });

  it('matches a reporter that sends no machine id by its source address, apart from hooks-only sessions', async () => {
    await store.record(seen({ machineId: null, machineName: null, owner: null, credential: 'admin secret' }), START + MIN);
    await store.record(seen({ kind: 'hooks', machineId: null, machineName: null, version: 'hooks', engineVersion: null, sessionId: 'h1' }), START + MIN);
    const rows = (await store.list({}, START + MIN)).rows;
    expect(rows.map((r) => r.key).sort()).toEqual(['addr:192.168.1.24', 'hooks:192.168.1.24']);
    expect(rows.find((r) => r.key.startsWith('addr:'))!.name).toBe('192.168.1.24');
    expect(rows.find((r) => r.key.startsWith('hooks:'))!.name).toBe('Hooks only');
    expect(rows.find((r) => r.key.startsWith('hooks:'))!.compat).toBe('unknown');
  });

  it('keeps one row for a reporter with no machine id that moves to a new source address (issue #166)', async () => {
    const anon = (over: Partial<ReporterSeen> = {}) => seen({ machineId: null, machineName: null, owner: null, ...over });
    await store.record(anon({ source: '10.88.0.133', sessionId: 's1' }), START + MIN);
    // The container restarted and came back on another address, still reporting the same session.
    await store.record(anon({ source: '10.88.0.134', sessionId: 's1' }), START + 2 * MIN);
    await store.record(anon({ source: '10.88.0.135', sessionId: 's2' }), START + 3 * MIN);
    await store.record(anon({ source: '10.88.0.135', sessionId: 's1' }), START + 4 * MIN);
    const rows = (await store.list({}, START + 4 * MIN)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'addr:10.88.0.133', firstSeenAt: START + MIN, lastSeenAt: START + 4 * MIN, sessions: 2 });
    expect((await store.get('addr:10.88.0.133', START + 4 * MIN))!.source).toBe('10.88.0.135');
  });

  it('carries each session\'s peers value when two reporter rows merge (#838)', async () => {
    const anon = (over: Partial<ReporterSeen> = {}) => seen({ machineId: null, machineName: null, owner: null, ...over });
    await store.record(anon({ source: '192.0.2.133', sessionId: 's1', peers: false }), START + MIN);
    // s2 reports from a new address first, so it gets a row of its own; s1 then turns up there and folds that row in.
    await store.record(anon({ source: '192.0.2.135', sessionId: 's2', peers: true }), START + 2 * MIN);
    await store.record(anon({ source: '192.0.2.135', sessionId: 's1', peers: false }), START + 3 * MIN);
    const rows = (await store.list({}, START + 3 * MIN)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.peers).toBe(true);
  });

  it('calls an unnamed reporter by its newest project, else its address, and says it is not named', async () => {
    await store.record(seen({ machineId: null, machineName: null, source: '10.88.0.133', sessionId: 's1' }), START + MIN);
    expect((await store.list({}, START + MIN)).rows[0]).toMatchObject({ name: '10.88.0.133', named: false });
    const add = (...a: (string | number | null)[]) => db.run(`INSERT INTO sessions (id, name, status, started_at, last_seen_at, cwd, repo_name) VALUES (?, ?, 'running', ?, ?, '/x', ?)`, a);
    await add('s1', 'older', START, START, null);
    expect((await store.list({}, START + MIN)).rows[0]!.name).toBe('older');
    await store.record(seen({ machineId: null, machineName: null, source: '10.88.0.133', sessionId: 's2' }), START + 2 * MIN);
    await add('s2', 'newer', START, START + MIN, 'podium');
    expect((await store.list({ q: 'podium' }, START + 2 * MIN)).rows[0]).toMatchObject({ name: 'podium', named: false });
    expect((await store.get('addr:10.88.0.133', START + 2 * MIN))!.serverStartedAt).toBe(START);
    await store.record(seen({ sessionId: 's3' }), START + 2 * MIN);
    expect((await store.list({ q: 'studio' }, START + 2 * MIN)).rows[0]).toMatchObject({ name: 'studio-m2', named: true });
  });

  it('flags a reporter that uses the admin secret, counts them and filters to them (issue #166)', async () => {
    await store.record(seen({ machineId: null, machineName: null, owner: 'Admin', credential: 'admin secret', source: '10.88.0.1', sessionId: 'a1' }), START + MIN);
    await store.record(seen({ machineId: null, machineName: null, owner: 'Admin', credential: 'admin secret', source: '10.88.0.2', sessionId: 'a2' }), START + MIN);
    await store.record(seen(), START + MIN);
    await store.record(seen({ machineId: 'bbbbbbbbbbbb', machineName: 'open', owner: null, credential: null, sessionId: 's9' }), START + MIN);
    const l = (await store.list({}, START + MIN));
    expect(l.adminSecret).toBe(2);
    const by = Object.fromEntries(l.rows.map((r) => [r.key, r]));
    expect(by['addr:10.88.0.1']).toMatchObject({ adminSecret: true, credential: 'admin secret' });
    expect(by['9f3a1c7d2e40']).toMatchObject({ adminSecret: false, credential: 'pdm_3f9a1c07b2e4' });
    // With authentication off there is no credential, so there is nothing to warn about.
    expect(by['bbbbbbbbbbbb']).toMatchObject({ adminSecret: false, credential: null });
    const only = (await store.list({ admin: true }, START + MIN));
    expect(only.rows.map((r) => r.key).sort()).toEqual(['addr:10.88.0.1', 'addr:10.88.0.2']);
    expect(only.total).toBe(2);
    expect(only.adminSecret).toBe(2);
    expect((await store.list({ sort: 'token', dir: 1 }, START + MIN)).rows.slice(0, 2).every((r) => r.adminSecret)).toBe(true);
    expect((await store.get('addr:10.88.0.1', START + MIN))!.adminSecret).toBe(true);
  });

  it('does not fold a hooks-only report into a mod reporter that shares its session', async () => {
    await store.record(seen({ machineId: null, machineName: null, source: '10.88.0.133' }), START + MIN);
    await store.record(seen({ kind: 'hooks', machineId: null, machineName: null, source: '10.88.0.134', version: 'hooks', engineVersion: null }), START + MIN);
    expect((await store.list({}, START + MIN)).total).toBe(2);
  });

  it('keeps a reporter after the sessions it reported are removed', async () => {
    await store.record(seen(), START + MIN);
    await db.run(`INSERT INTO sessions (id, name, status, started_at, last_seen_at, ended_at, cwd) VALUES ('s1', 'x', 'done', ?, ?, ?, '/x')`, [START, START, START]);
    // Retention removes sessions; the reporter row does not follow them.
    await db.run('DELETE FROM sessions');
    expect((await store.list({}, START + 2 * MIN)).total).toBe(1);
  });

  it('works out the state from what the server can see', async () => {
    await store.record(seen({ machineId: 'aaaaaaaaaaaa', machineName: 'a' }), START + 10 * MIN);
    await store.record(seen({ machineId: 'bbbbbbbbbbbb', machineName: 'b' }), START + 10 * MIN);
    await store.record(seen({ machineId: 'cccccccccccc', machineName: 'c' }), START + 10 * MIN);
    // Recorded before the server started: known, but not heard from since.
    await new PgReporterStore(db, START + 1000 * MIN).record(seen({ machineId: 'dddddddddddd', machineName: 'd' }), START - MIN);
    const by = async (now: number) => Object.fromEntries((await store.list({}, now)).rows.map((r) => [r.name, r.state]));
    expect(await by(START + 10 * MIN + REPORTING_MS - 1)).toMatchObject({ a: 'reporting', d: 'restart' });
    expect(await by(START + 10 * MIN + REPORTING_MS)).toMatchObject({ a: 'idle' });
    expect(await by(START + 10 * MIN + IDLE_MS)).toMatchObject({ a: 'silent', b: 'silent' });
    const l = (await store.list({}, START + 10 * MIN + IDLE_MS));
    expect(l.counts).toEqual({ all: 4, reporting: 0, idle: 0, silent: 3, restart: 1 });
  });

  it('filters by state, searches, sorts and pages', async () => {
    await store.record(seen({ machineId: 'aaaaaaaaaaaa', machineName: 'alpha', owner: 'Dana' }), START + 10 * MIN);
    await store.record(seen({ machineId: 'bbbbbbbbbbbb', machineName: 'bravo', owner: 'Sam', source: '10.0.0.9' }), START + 20 * MIN);
    await store.record(seen({ machineId: 'cccccccccccc', machineName: 'charlie', owner: 'Lee', version: '0.9.0' }), START + 30 * MIN);
    const now = START + 30 * MIN;
    expect((await store.list({ q: 'sam' }, now)).rows.map((r) => r.name)).toEqual(['bravo']);
    expect((await store.list({ q: '10.0.0' }, now)).rows.map((r) => r.name)).toEqual(['bravo']);
    expect((await store.list({ q: '0.9.0' }, now)).rows.map((r) => r.name)).toEqual(['charlie']);
    expect((await store.list({ state: 'reporting' }, now)).rows.map((r) => r.name)).toEqual(['charlie']);
    expect((await store.list({ sort: 'name', dir: 1 }, now)).rows.map((r) => r.name)).toEqual(['alpha', 'bravo', 'charlie']);
    expect((await store.list({ sort: 'last', dir: -1 }, now)).rows.map((r) => r.name)).toEqual(['charlie', 'bravo', 'alpha']);
    const p = (await store.list({ page: 2, pageSize: 2, sort: 'name', dir: 1 }, now));
    expect(p.rows.map((r) => r.name)).toEqual(['charlie']);
    expect(p.total).toBe(3);
  });

  it('treats search characters as text, not as patterns', async () => {
    await store.record(seen(), START + MIN);
    expect((await store.list({ q: '%' }, START + MIN)).total).toBe(0);
    expect((await store.list({ q: "'; DROP TABLE reporters; --" }, START + MIN)).total).toBe(0);
    expect((await store.list({}, START + MIN)).total).toBe(1);
  });

  it('flags a version outside the supported range', async () => {
    await store.record(seen({ machineId: 'aaaaaaaaaaaa', version: '0.1.0' }), START + MIN);
    await store.record(seen({ machineId: 'bbbbbbbbbbbb', version: '9.0.0' }), START + MIN);
    const c = Object.fromEntries((await store.list({}, START + MIN)).rows.map((r) => [r.version, r.compat]));
    expect(c).toEqual({ '0.1.0': 'outdated', '9.0.0': 'newer' });
  });

  it('gives the detail: its sessions, live count and credential key id, never a secret', async () => {
    await store.record(seen(), START + MIN);
    await db.run(`INSERT INTO sessions (id, name, status, started_at, last_seen_at, cwd, cost_usd) VALUES ('s1', 'api-gateway', 'running', ?, ?, '/x', 1.5)`, [START, START + MIN]);
    const d = (await store.get('9f3a1c7d2e40', START + MIN))!;
    expect(d).toMatchObject({ name: 'studio-m2', machineId: '9f3a1c7d2e40', source: '192.168.1.24', credential: 'pdm_3f9a1c07b2e4', engineVersion: '2.1.299', live: 1 });
    expect(d.recent).toEqual([{ id: 's1', name: 'api-gateway', status: 'running', lastSeenAt: START + MIN, costUsd: 1.5 }]);
    expect((await store.get('nope', START))).toBeUndefined();
  });

  it('pages the sessions it holds for a reporter, newest first, with the total (issue #188)', async () => {
    const add = (...a: (string | number | null)[]) => db.run(`INSERT INTO sessions (id, name, status, started_at, last_seen_at, cwd, cost_usd) VALUES (?, ?, 'ended', ?, ?, '/x', NULL)`, a);
    for (let i = 1; i <= 30; i++) {
      await store.record(seen({ sessionId: `s${i}` }), START + i);
      await add(`s${i}`, `n${i}`, START, START + i);
    }
    const one = (await store.get('9f3a1c7d2e40', START + MIN, { page: 1, pageSize: 25 }))!;
    expect(one).toMatchObject({ recentTotal: 30, recentPage: 1, recentPageSize: 25 });
    expect(one.recent.map((s) => s.id)).toEqual(Array.from({ length: 25 }, (_, i) => `s${30 - i}`));
    const two = (await store.get('9f3a1c7d2e40', START + MIN, { page: 2, pageSize: 25 }))!;
    expect(two.recent.map((s) => s.id)).toEqual(['s5', 's4', 's3', 's2', 's1']);
    expect((await store.get('9f3a1c7d2e40', START + MIN))!).toMatchObject({ recentPage: 1, recentPageSize: 50, recentTotal: 30 });
    expect((await store.get('9f3a1c7d2e40', START + MIN, { page: 1, pageSize: 5000 }))!.recentPageSize).toBeLessThanOrEqual(100);
  });

  it('lists recent refusals from the reporter\'s address, newest first, and forgets the oldest', async () => {
    await store.record(seen(), START);
    await store.rejected('192.168.1.24', 'wrong token', START + 1);
    await store.rejected('10.9.9.9', 'wrong token', START + 2);
    await store.rejected('192.168.1.24', 'unknown person token', START + 3);
    expect((await store.get('9f3a1c7d2e40', START + 4))!.rejected).toEqual([
      { t: START + 3, reason: 'unknown person token' },
      { t: START + 1, reason: 'wrong token' },
    ]);
    for (let i = 0; i < 500; i++) (await store.rejected('1.1.1.1', 'x', START + i));
    expect((await store.get('9f3a1c7d2e40', START + 4))!.rejected).toEqual([]);
  });

  it('removes a reporter and its session links, and it returns when it reports again', async () => {
    await store.record(seen(), START);
    expect((await store.remove('9f3a1c7d2e40'))).toBe(true);
    expect((await store.remove('9f3a1c7d2e40'))).toBe(false);
    expect((await store.list({}, START)).total).toBe(0);
    expect(await db.get('SELECT COUNT(*) AS n FROM reporter_sessions')).toEqual({ n: 0 });
    await store.record(seen(), START + MIN);
    expect((await store.list({}, START + MIN)).total).toBe(1);
  });
});

const DAY = 24 * 60 * MIN;

describe.skipIf(!TEST_PG)('removing many reporters (issue #167)', () => {
  const three = async () => {
    await store.record(seen({ machineId: 'aaaa', machineName: 'a', sessionId: 'a1' }), START + MIN);
    await store.record(seen({ machineId: 'bbbb', machineName: 'b', sessionId: 'b1' }), START - 5 * MIN);
    await store.record(seen({ machineId: 'cccc', machineName: 'c', sessionId: 'c1' }), START - 9 * MIN);
  };

  it('removes the keys it is given in one step, skips unknown ones, and says how many went', async () => {
    await three();
    expect((await store.removeMany(['aaaa', 'bbbb', 'nope']))).toBe(2);
    expect((await store.list({}, START + MIN)).rows.map((r) => r.key)).toEqual(['cccc']);
    expect(await db.get('SELECT COUNT(*) AS n FROM reporter_sessions')).toEqual({ n: 1 });
  });

  it('removes every reporter in one state', async () => {
    await three();
    expect((await store.removeState('restart', START + MIN))).toBe(2);
    expect((await store.list({}, START + MIN)).rows.map((r) => r.key)).toEqual(['aaaa']);
    expect((await store.removeState('restart', START + MIN))).toBe(0);
  });

  it('lists the keys of a filtered view, so "select all in this filter" can reach past one page', async () => {
    await three();
    expect((await store.keys({ state: 'restart' }, START + MIN)).sort()).toEqual(['bbbb', 'cccc']);
    expect((await store.keys({ q: 'bbb' }, START + MIN))).toEqual(['bbbb']);
  });
});

describe.skipIf(!TEST_PG)('ignore rules (issue #167)', () => {
  it('matches a reporter by key, by address pattern and by version pattern', async () => {
    const k = (await store.addIgnore('key', 'aaaa', START));
    const a = (await store.addIgnore('address', '10.88.*', START));
    const v = (await store.addIgnore('version', '*-sim', START));
    expect((await store.ignoredBy({ key: 'aaaa', source: null, version: '0.13.0' }))?.id).toBe(k.id);
    expect((await store.ignoredBy({ key: 'x', source: '10.88.0.133', version: '0.13.0' }))?.id).toBe(a.id);
    expect((await store.ignoredBy({ key: 'x', source: '192.168.1.24', version: '0.1.0-sim' }))?.id).toBe(v.id);
    expect((await store.ignoredBy({ key: 'x', source: '192.168.1.24', version: '0.13.0' }))).toBeUndefined();
    // A pattern is text with * for "anything", never a regular expression.
    await store.addIgnore('address', '1.2.3.4', START);
    expect((await store.ignoredBy({ key: 'x', source: '1x2y3z4', version: '1' }))).toBeUndefined();
  });

  it('keeps one copy of a rule, lists rules oldest first, and removes one by id', async () => {
    const first = (await store.addIgnore('key', 'aaaa', START));
    expect((await store.addIgnore('key', 'aaaa', START + MIN)).id).toBe(first.id);
    await store.addIgnore('version', '*-sim', START + 2 * MIN);
    expect((await store.listIgnores()).map((r) => [r.kind, r.pattern])).toEqual([['key', 'aaaa'], ['version', '*-sim']]);
    expect((await store.removeIgnore(first.id))).toBe(true);
    expect((await store.removeIgnore(first.id))).toBe(false);
    expect((await store.ignoredBy({ key: 'aaaa', source: null, version: '1' }))).toBeUndefined();
  });

  it('matches * without backtracking on a long value', async () => {
    await store.addIgnore('version', 'a*a*a*a*a*a*b', START);
    const t0 = Date.now();
    expect((await store.ignoredBy({ key: 'k', source: null, version: 'a'.repeat(60) }))).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(50);
    expect((await store.ignoredBy({ key: 'k', source: null, version: 'aaaaaaaaaaaab' }))).toBeDefined();
  });

  it('matches a key rule on the row a session already belongs to, after the reporter changes address (#166)', async () => {
    const anon = (over: Partial<ReporterSeen>) => seen({ machineId: null, machineName: null, owner: null, ...over });
    await store.record(anon({ source: '10.88.0.133', sessionId: 's1' }), START + MIN);
    const s = anon({ source: '10.88.0.134', sessionId: 's1' });
    expect((await store.keysFor(s))).toEqual(['addr:10.88.0.134', 'addr:10.88.0.133']);
    await store.addIgnore('key', 'addr:10.88.0.133', START + 2 * MIN);
    expect((await store.ignoredBy({ key: 'addr:10.88.0.134', otherKeys: ['addr:10.88.0.133'], source: '10.88.0.134', version: '1' }))).toBeDefined();
  });

  it('lets a key rule on a machine id cover every account on it, and a rule on one account cover only that account (#221)', async () => {
    await store.record(seen({ owner: 'Ana', sessionId: 'a1' }), START + MIN);
    await store.record(seen({ owner: 'Ben', sessionId: 'b1' }), START + MIN);
    const ben = { kind: 'mod' as const, machineId: '9f3a1c7d2e40', source: null, owner: 'Ben', sessionId: 'b1' };
    const target = (keys: string[]) => ({ key: keys[0]!, otherKeys: keys.slice(1), source: null, version: '1' });
    const benRow = (await store.list({}, START + MIN)).rows.find((r) => r.who === 'Ben')!;
    await store.addIgnore('key', benRow.key, START + 2 * MIN);
    expect((await store.list({}, START + 2 * MIN)).rows.map((r) => r.who)).toEqual(['Ana']);
    expect((await store.ignoredBy(target((await store.keysFor(ben)))))).toBeDefined();
    expect((await store.ignoredBy(target((await store.keysFor({ ...ben, owner: 'Ana' })))))).toBeUndefined();
    await store.addIgnore('key', '9f3a1c7d2e40', START + 3 * MIN);
    expect((await store.list({}, START + 3 * MIN)).total).toBe(0);
    expect((await store.ignoredBy(target((await store.keysFor({ ...ben, owner: 'Ana' })))))).toBeDefined();
    expect((await store.ignoredBy(target((await store.keysFor(ben)))))).toBeDefined();
  });

  it('matches a rule on <machine id>#<owner> even when that account\'s row is keyed on the bare machine id (#221)', async () => {
    await store.record(seen({ owner: 'Ben', sessionId: 'b1' }), START + MIN);
    await store.addIgnore('key', '9f3a1c7d2e40#Ben', START + 2 * MIN);
    const keys = (await store.keysFor({ kind: 'mod', machineId: '9f3a1c7d2e40', source: null, owner: 'Ben', sessionId: 'b2' }));
    expect((await store.ignoredBy({ key: keys[0]!, otherKeys: keys.slice(1), source: null, version: '1' }))).toBeDefined();
  });

  it('refuses a rule made only of *, which would turn every reporter away', async () => {
    await expect(store.addIgnore('address', '*', START)).rejects.toThrow(/besides \*/);
    await expect(store.addIgnore('version', '**', START)).rejects.toThrow();
    expect((await store.addIgnore('version', '*-sim', START)).pattern).toBe('*-sim');
  });

  it('refuses a rule that is empty, too long, or of an unknown kind', async () => {
    await expect(store.addIgnore('key', '  ', START)).rejects.toThrow();
    await expect(store.addIgnore('key', 'x'.repeat(200), START)).rejects.toThrow();
    await expect(store.addIgnore('who' as 'key', 'x', START)).rejects.toThrow();
  });

  it('removes an ignored reporter\'s row when the rule is made', async () => {
    await store.record(seen(), START);
    await store.addIgnore('key', '9f3a1c7d2e40', START);
    expect((await store.list({}, START)).total).toBe(0);
  });
});

describe.skipIf(!TEST_PG)('forgetting reporters by age (issue #167)', () => {
  it('is off, at 30 days, until the Admin turns it on', async () => {
    expect((await store.forgetSetting())).toEqual({ enabled: false, days: 30 });
    await store.record(seen(), START - 90 * DAY);
    expect((await store.forgetStale(START + 2 * 60 * MIN))).toBe(0);
    expect((await store.list({}, START)).total).toBe(1);
  });

  it('removes reporters not heard from for N days and keeps the rest', async () => {
    await store.record(seen({ machineId: 'old', sessionId: 'o' }), START - 31 * DAY);
    await store.record(seen({ machineId: 'new', sessionId: 'n' }), START - 29 * DAY);
    await store.setForgetSetting({ enabled: true, days: 30 });
    expect((await store.forgetStale(START + 2 * 60 * MIN))).toBe(1);
    expect((await store.list({}, START)).rows.map((r) => r.key)).toEqual(['new']);
  });

  it('waits an hour after the server starts, so a long outage does not empty the list', async () => {
    await store.record(seen({ machineId: 'old', sessionId: 'o' }), START - 90 * DAY);
    await store.setForgetSetting({ enabled: true, days: 30 });
    expect((await store.forgetStale(START + 59 * MIN))).toBe(0);
    expect((await store.list({}, START)).total).toBe(1);
    expect((await store.forgetStale(START + 61 * MIN))).toBe(1);
  });

  it('keeps the days when it is switched off and on, and refuses days outside 1 to 3650', async () => {
    await store.setForgetSetting({ enabled: true, days: 7 });
    await store.setForgetSetting({ enabled: false });
    expect((await store.forgetSetting())).toEqual({ enabled: false, days: 7 });
    await expect(store.setForgetSetting({ days: 0 })).rejects.toThrow();
    await expect(store.setForgetSetting({ days: 1.5 })).rejects.toThrow();
    await expect(store.setForgetSetting({ days: 4000 })).rejects.toThrow();
  });
});

describe.skipIf(!TEST_PG)('postgres specifics (#822)', () => {
  it('sorts a missing credential first when ascending and last when descending, as SQLite does', async () => {
    await store.record(seen({ machineId: 'aaaa', machineName: 'a', credential: null, sessionId: 'a1' }), START);
    await store.record(seen({ machineId: 'bbbb', machineName: 'b', credential: 'pdm_b', sessionId: 'b1' }), START);
    await store.record(seen({ machineId: 'cccc', machineName: 'c', credential: 'admin secret', sessionId: 'c1' }), START);
    const keys = async (dir: number) => (await store.list({ sort: 'token', dir }, START)).rows.map((r) => r.key);
    expect(await keys(1)).toEqual(['cccc', 'aaaa', 'bbbb']);
    expect(await keys(-1)).toEqual(['cccc', 'bbbb', 'aaaa']);
  });

  it('sorts names by byte after folding ASCII only', async () => {
    for (const [id, name] of [['m-e1', 'émile'], ['m-e2', 'Émile'], ['m-z', 'zed']] as const) await store.record(seen({ machineId: id, machineName: name, sessionId: id }), START);
    expect((await store.list({ sort: 'name', dir: 1 }, START)).rows.map((r) => r.key)).toEqual(['m-z', 'm-e2', 'm-e1']);
  });

  it('hands out the peer lookup over the same start time, through the factory too', async () => {
    const reporters = pgReporters(db, START);
    await reporters.record(seen(), START);
    const look = reporters.peerLookup();
    expect(look.startedAt).toBe(START);
    expect((await look.get('9f3a1c7d2e40'))!.machine).toBe('studio-m2');
  });
});
