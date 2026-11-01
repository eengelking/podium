// The Activity history on PostgreSQL (#822): the cases of `sqlite/activityHistory.test.ts` against the `podium_activity` schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { ACTIVITY_SCHEMA, ACTIVITY_STEPS, migrate } from './schema.js';
import { PgActivityHistory, entryBytesSql } from './activityHistory.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import { ACTIVITY_HISTORY_DEFAULTS, ACTIVITY_UNIT_MS, type ActivityHistorySettings } from '../../fleet/activityHistoryTypes.js';
import { LIMITS, MAIN_LOOP, type ActivityEntry, type Report } from '../../fleet/protocol.js';
import { fixtureReport } from '../../fleet/testing.js';
import type { SessionMeta } from '../rows.js';

const T0 = 1_800_000_000_000;
const DAY = ACTIVITY_UNIT_MS.days;
const META: SessionMeta = { name: 'invoice-v2', project: 'acme/billing', owner: 'Ed' };

const tool = (at: number, text = `Read f${at}`): ActivityEntry => ({ at, kind: 'tool', text });

/** The fixture's session, with a feed on the orchestrator and on its first agent. */
function report(main: ActivityEntry[], agent: ActivityEntry[] = [], id?: string): Report {
  const r = fixtureReport();
  r.session.activityFeed = true;
  if (id) r.session.id = id;
  r.session.activity = main;
  r.agents[0]!.activity = agent;
  return r;
}

describe.skipIf(!TEST_PG)('postgres activity history', () => {
  let td: TestDatabase;
  let db: PgDb;
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new PgDb({ connectionString: td.url, schema: ACTIVITY_SCHEMA, max: 6, name: 'test-activity' });
    await migrate(db, ACTIVITY_SCHEMA, ACTIVITY_STEPS);
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE entries, stored_sessions, loops, rec_sessions, rec_entries RESTART IDENTITY');
  });

  function setup(over: Partial<ActivityHistorySettings> = {}, extra: { authOn?: boolean; featureOn?: boolean; capBytesPerGb?: number; chunkRows?: number } = {}) {
    let t = T0;
    const state = { settings: { ...ACTIVITY_HISTORY_DEFAULTS, policy: 'all' as const, ...over }, live: new Set<string>(), featureOn: extra.featureOn ?? true };
    const h = new PgActivityHistory(db, {
      now: () => t,
      settings: () => state.settings,
      featureOn: () => state.featureOn,
      isLive: (id) => state.live.has(id),
      agentsOf: () => ['a1', 'a2'],
      authOn: extra.authOn ?? true,
      capBytesPerGb: extra.capBytesPerGb,
      chunkRows: extra.chunkRows,
    });
    return { h, state, advance: (ms: number) => (t += ms), now: () => t };
  }

  const n = async (sql: string, ...p: (string | number)[]): Promise<number> => (await db.get<{ n: number }>(sql, p))!.n;

  describe('enabled', () => {
    it('is off for the default policy, on for a keep policy, and off without a token or with the feature flag off', () => {
      expect(setup({ policy: 'default' }).h.enabled()).toBe(false);
      expect(setup({ policy: 'all' }).h.enabled()).toBe(true);
      expect(setup({ policy: 'all' }, { authOn: false }).h.enabled()).toBe(false);
      expect(setup({ policy: 'all' }, { featureOn: false }).h.enabled()).toBe(false);
    });

    it('lists the orchestrator and every running agent to watch, or the orchestrator alone without a lookup', () => {
      expect(setup().h.loopsToWatch('s')).toEqual([MAIN_LOOP, 'a1', 'a2']);
      const h = new PgActivityHistory(db, { now: () => T0, settings: () => ACTIVITY_HISTORY_DEFAULTS, isLive: () => false, authOn: true });
      expect(h.loopsToWatch('s')).toEqual([MAIN_LOOP]);
      expect(h.current()).toBe(ACTIVITY_HISTORY_DEFAULTS);
    });

    it('says whether it was stopped, and is not busy when idle', async () => {
      const { h } = setup();
      expect(h.busy).toBe(false);
      expect(h.stopped).toBe(false);
      h.stop();
      expect(h.stopped).toBe(true);
      await h.idle();
    });
  });

  describe('capture', () => {
    it('stores the orchestrator and an agent with no lease, in order, numbered per loop', async () => {
      const { h } = setup();
      const r = report([tool(T0 + 1), tool(T0 + 2)], [tool(T0 + 3)]);
      expect(await h.ingest(r, 0, META)).toBe(3);
      const sid = r.session.id;
      expect((await h.page(sid, MAIN_LOOP, null, 20)).entries.map((e) => [e.seq, e.at])).toEqual([
        [1, T0 + 1],
        [2, T0 + 2],
      ]);
      expect((await h.page(sid, r.agents[0]!.id, null, 20)).entries.map((e) => [e.seq, e.at])).toEqual([[1, T0 + 3]]);
      const t = await h.totals();
      expect(t).toMatchObject({ entries: 3, sessions: 1 });
      expect(t.fileBytes).toBeGreaterThan(0);
      expect(typeof t.bytes).toBe('number');
    });

    it('stores nothing under the default policy, without a token, or with the flag off', async () => {
      for (const s of [setup({ policy: 'default' }), setup({}, { authOn: false }), setup({}, { featureOn: false })]) {
        expect(await s.h.ingest(report([tool(T0)]), 0, META)).toBe(0);
        expect((await s.h.totals()).entries).toBe(0);
      }
    });

    it('ignores a report with no entries', async () => {
      const { h } = setup();
      expect(await h.ingest(report([]), 0, META)).toBe(0);
      expect((await h.totals()).sessions).toBe(0);
    });

    it('adds each entry once across the overlapping snapshots of several reports', async () => {
      const { h } = setup();
      const sid = report([]).session.id;
      await h.ingest(report([tool(T0 + 1), tool(T0 + 2)]), 0, META);
      await h.ingest(report([tool(T0 + 1), tool(T0 + 2), tool(T0 + 3)]), 0, META);
      await h.ingest(report([tool(T0 + 1), tool(T0 + 2), tool(T0 + 3)]), 0, META);
      await h.ingest(report([tool(T0 + 2), tool(T0 + 3), tool(T0 + 4)]), 0, META);
      expect((await h.page(sid, MAIN_LOOP, null, 20)).entries.map((e) => [e.seq, e.at])).toEqual([
        [1, T0 + 1],
        [2, T0 + 2],
        [3, T0 + 3],
        [4, T0 + 4],
      ]);
    });

    it('keeps two different entries at the same time, and skips one older than the newest', async () => {
      const { h } = setup();
      const sid = report([]).session.id;
      await h.ingest(report([{ at: T0 + 5, kind: 'tool', text: 'Read a' }, { at: T0 + 5, kind: 'text', text: 'thinking aloud' }]), 0, META);
      await h.ingest(report([tool(T0 + 1, 'Read old'), { at: T0 + 5, kind: 'tool', text: 'Read a' }, { at: T0 + 5, kind: 'tool', text: 'Read b' }]), 0, META);
      expect((await h.page(sid, MAIN_LOOP, null, 20)).entries.map((e) => e.text)).toEqual(['Read a', 'thinking aloud', 'Read b']);
    });

    it('keeps the entry time as shown and the server-clock time as the reporter time less the skew', async () => {
      const { h } = setup();
      await h.ingest(report([tool(T0 + 10_000)]), 4_000, META);
      expect(await db.get('SELECT at, t FROM entries')).toEqual({ at: T0 + 10_000, t: T0 + 6_000 });
      expect(await db.get('SELECT first_t, last_t FROM stored_sessions')).toEqual({ first_t: T0 + 6_000, last_t: T0 + 6_000 });
    });

    it('cuts an entry to the feed limit and updates the session name and the time span on a later report', async () => {
      const { h } = setup();
      await h.ingest(report([tool(T0, 'x'.repeat(400))]), 0, META);
      await h.ingest(report([tool(T0 + 1)]), 0, { ...META, name: 'renamed' });
      expect(await n('SELECT length(text) AS n FROM entries WHERE seq = 1')).toBe(300);
      expect(await db.get('SELECT name, first_t, last_t, oldest_t, entries FROM stored_sessions')).toEqual({ name: 'renamed', first_t: T0, last_t: T0 + 1, oldest_t: T0, entries: 2 });
    });

    it('rolls a failed ingest back and forgets the loop positions, so the next one starts from the database', async () => {
      const { h } = setup();
      const sid = report([]).session.id;
      await expect(h.ingest(report([tool(T0)]), 0, { name: null as unknown as string, project: null, owner: null })).rejects.toThrow();
      expect((await h.totals()).entries).toBe(0);
      expect(await h.ingest(report([tool(T0)]), 0, META)).toBe(1);
      expect((await h.page(sid, MAIN_LOOP, null, 20)).entries.map((e) => e.seq)).toEqual([1]);
    });
  });

  describe('restart', () => {
    it('continues the sequence and de-duplicates against the database after a new instance takes over', async () => {
      const first = setup();
      const sid = report([]).session.id;
      await first.h.ingest(report([tool(T0 + 1), tool(T0 + 2)]), 0, META);
      const second = setup();
      expect(await second.h.ingest(report([tool(T0 + 1), tool(T0 + 2), tool(T0 + 3)]), 0, META)).toBe(1);
      await second.h.addPodium(sid, MAIN_LOOP, 'd1', { at: T0 + 4, text: 'answered', by: 'Ed', note: null }, META);
      expect((await second.h.page(sid, MAIN_LOOP, null, 20)).entries.map((e) => [e.seq, e.at])).toEqual([
        [1, T0 + 1],
        [2, T0 + 2],
        [3, T0 + 3],
        [4, T0 + 4],
      ]);
    });

    it('reloads the entries stored at the newest time, so a repeat of them is still skipped', async () => {
      await setup().h.ingest(report([tool(T0 + 1, 'Read a'), tool(T0 + 1, 'Read b')]), 0, META);
      expect(await setup().h.ingest(report([tool(T0 + 1, 'Read a'), tool(T0 + 1, 'Read b'), tool(T0 + 1, 'Read c')]), 0, META)).toBe(1);
    });

    it('walks back through more than one block of entries stored at the same time', async () => {
      const same = Array.from({ length: 120 }, (_, i) => tool(T0 + 1, `Read ${i}`));
      await setup().h.ingest(report(same), 0, META);
      // 120 entries share one time: the reload reads three blocks of 50 (the last short) and every one is still known
      expect(await setup().h.ingest(report([...same, tool(T0 + 1, 'Read new')]), 0, META)).toBe(1);
    });

    it('forgetSession drops a session’s loop positions and they reload from the database', async () => {
      const { h } = setup();
      const sid = report([]).session.id;
      await h.ingest(report([tool(T0 + 1)]), 0, META);
      h.forgetSession(sid);
      expect(await h.ingest(report([tool(T0 + 1), tool(T0 + 2)]), 0, META)).toBe(1);
      expect((await h.page(sid, MAIN_LOOP, null, 20)).entries.map((e) => e.seq)).toEqual([1, 2]);
    });
  });

  describe('Podium entries', () => {
    it('are written through with their sender and note, share the loop numbering, and are not compared as reporter entries', async () => {
      const { h } = setup();
      const sid = report([]).session.id;
      await h.ingest(report([tool(T0 + 100)]), 0, META);
      await h.addPodium(sid, MAIN_LOOP, 'd1', { at: T0 + 50, text: 'answered: yes', by: 'Ed', note: 'queued' }, META);
      expect(await h.ingest(report([tool(T0 + 100), tool(T0 + 101)]), 0, META)).toBe(1);
      expect((await h.page(sid, MAIN_LOOP, null, 20)).entries).toEqual([
        { seq: 1, at: T0 + 100, kind: 'tool', text: 'Read f1800000000100' },
        { seq: 2, at: T0 + 50, kind: 'podium', text: 'answered: yes', by: 'Ed', note: 'queued' },
        { seq: 3, at: T0 + 101, kind: 'tool', text: 'Read f1800000000101' },
      ]);
    });

    it('stores nothing when history is off, updates a note, and removes an entry with its session row when it was the last', async () => {
      const off = setup({ policy: 'default' });
      await off.h.addPodium('s', MAIN_LOOP, 'd1', { at: T0, text: 't', by: 'Ed', note: null }, META);
      expect((await off.h.totals()).entries).toBe(0);

      const { h } = setup();
      await h.addPodium('s', MAIN_LOOP, 'd1', { at: T0, text: 'x'.repeat(400), by: 'Ed', note: null }, META);
      const before = (await h.totals()).bytes;
      await h.updatePodium('s', 'd1', 'the session took it');
      expect((await h.page('s', MAIN_LOOP, null, 20)).entries[0]).toMatchObject({ note: 'the session took it' });
      expect((await h.totals()).bytes).toBe(before + 'the session took it'.length);
      expect(await n('SELECT length(text) AS n FROM entries')).toBe(300);
      await h.removePodium('s', 'other');
      expect((await h.totals()).entries).toBe(1);
      await h.removePodium('s', 'd1');
      expect(await h.totals()).toMatchObject({ entries: 0, sessions: 0 });
      expect(await n('SELECT COUNT(*) AS n FROM stored_sessions')).toBe(0);
      expect(await n('SELECT COUNT(*) AS n FROM loops')).toBe(0);
    });

    it('leaves the sizes alone when a note update changes no length', async () => {
      const { h } = setup();
      await h.addPodium('s', MAIN_LOOP, 'd1', { at: T0, text: 't', by: 'Ed', note: 'abc' }, META);
      const before = (await h.totals()).bytes;
      await h.updatePodium('s', 'd1', 'xyz');
      expect((await h.totals()).bytes).toBe(before);
    });
  });

  describe('page and note', () => {
    const fill = async (h: PgActivityHistory, count: number) => {
      const sid = report([]).session.id;
      for (let i = 1; i <= count; i += 10) await h.ingest(report(Array.from({ length: Math.min(10, count - i + 1) }, (_, k) => tool(T0 + i + k))), 0, META);
      return sid;
    };

    it('returns pages oldest first with the cursor of the next older page', async () => {
      const { h } = setup();
      const sid = await fill(h, 45);
      const newest = await h.page(sid, MAIN_LOOP, null, 20);
      expect(newest.entries.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 26 + i));
      expect(newest.olderBefore).toBe(26);
      expect(newest.total).toBe(45);
      const mid = await h.page(sid, MAIN_LOOP, newest.olderBefore, 20);
      expect(mid.entries[0]!.seq).toBe(6);
      const last = await h.page(sid, MAIN_LOOP, mid.olderBefore, 20);
      expect(last.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(last.olderBefore).toBeNull();
    });

    it('clamps the limit, uses the default for a bad one, and is empty for a loop with nothing', async () => {
      const { h } = setup();
      const sid = await fill(h, 150);
      expect((await h.page(sid, MAIN_LOOP, null, 1000)).entries).toHaveLength(100);
      expect((await h.page(sid, MAIN_LOOP, null, 0)).entries).toHaveLength(20);
      expect((await h.page(sid, MAIN_LOOP, null)).entries).toHaveLength(20);
      expect(await h.page(sid, 'nothing', null, 20)).toEqual({ entries: [], olderBefore: null, total: 0, since: null, keptUntil: null });
    });

    it('counts a loop for the live reply: since, and when the newest goes under `after`', async () => {
      const all = setup({ policy: 'all' });
      const sid = await fill(all.h, 3);
      expect(await all.h.note(sid, MAIN_LOOP)).toEqual({ policy: 'all', total: 3, since: T0 + 1, keptUntil: null });
      expect(await all.h.note(sid, 'nothing')).toBeNull();

      const after = setup({ policy: 'after', n: 2, unit: 'days' });
      expect(await after.h.note(sid, MAIN_LOOP)).toEqual({ policy: 'after', total: 3, since: T0 + 1, keptUntil: T0 + 3 + 2 * DAY });
      after.state.settings = { ...ACTIVITY_HISTORY_DEFAULTS };
      expect(await after.h.note(sid, MAIN_LOOP)).toBeNull();
    });
  });

  describe('purge', () => {
    /** Three sessions: one old, one recent, one recent and live. */
    async function seed(over: Partial<ActivityHistorySettings>, extra: { capBytesPerGb?: number } = {}) {
      const s = setup(over, extra);
      await s.h.ingest(report([tool(T0 - 10 * DAY), tool(T0 - 9 * DAY)], [], 'old'), 0, { ...META, name: 'old' });
      await s.h.ingest(report([tool(T0 - 2 * DAY), tool(T0 - DAY)], [], 'recent'), 0, { ...META, name: 'recent' });
      await s.h.ingest(report([tool(T0 - 10 * DAY), tool(T0 - 1000)], [], 'running'), 0, { ...META, name: 'running' });
      s.state.live.add('running');
      return s;
    }

    it('does nothing under the default policy', async () => {
      const s = setup({ policy: 'default' });
      expect(await s.h.purge(T0)).toEqual({ entries: 0, bytes: 0, sessions: 0, freed: 0 });
      expect(s.h.lastPurge).toBeNull();
    });

    it('under `after` removes entries older than the period, entry by entry, and sessions left empty', async () => {
      const { h, advance } = await seed({ policy: 'after', n: 3, unit: 'days' });
      const r = await h.purge(T0);
      // two sessions lost entries: `old` lost both of its (and is gone), `running` lost its oldest one
      expect(r).toMatchObject({ entries: 3, sessions: 2, freed: 0 });
      expect(r.bytes).toBeGreaterThan(0);
      expect(await h.totals()).toMatchObject({ entries: 3, sessions: 2 });
      expect(h.lastPurge).toEqual({ at: T0, entries: 3, bytes: r.bytes });
      // the loop of a session that kept entries has its first and last times read again
      expect(await db.get("SELECT entries, first_at, last_t FROM loops WHERE session_id = 'running'")).toEqual({ entries: 1, first_at: T0 - 1000, last_t: T0 - 1000 });
      expect(await db.get("SELECT oldest_t FROM stored_sessions WHERE session_id = 'running'")).toEqual({ oldest_t: T0 - 1000 });
      // a run that removes nothing does not move lastPurge
      advance(1000);
      expect(await h.purge(T0)).toMatchObject({ entries: 0, sessions: 0, freed: 0 });
      expect(h.lastPurge?.at).toBe(T0);
    });

    it('defaults the time of a purge to now, and takes a period that is not a whole number of milliseconds', async () => {
      const { h, advance } = await seed({ policy: 'after', n: 3, unit: 'days' });
      advance(100 * DAY);
      expect((await h.purge()).entries).toBe(6);
      const frac = await seed({ policy: 'after', n: 0.0000001, unit: 'days' });
      expect((await frac.h.purge(T0 + 1)).entries).toBeGreaterThan(0);
    });

    it('under `end` removes the sessions that are not live', async () => {
      const { h } = await seed({ policy: 'end' });
      expect(await h.purge(T0)).toMatchObject({ entries: 4, sessions: 2 });
      expect(await h.totals()).toMatchObject({ entries: 2, sessions: 1 });
      expect((await h.list({})).rows.map((r) => r.sessionId)).toEqual(['running']);
    });

    it('under `all` removes nothing without a cap', async () => {
      const { h } = await seed({ policy: 'all' });
      expect(await h.purge(T0)).toMatchObject({ entries: 0, sessions: 0 });
    });

    it('with a cap, removes the oldest entries first until the total is under it', async () => {
      const { h } = await seed({ policy: 'all', capGb: 1 }, { capBytesPerGb: 1 });
      // the cap is 1 byte here: everything goes, oldest first
      const total = await n('SELECT COUNT(*) AS n FROM entries');
      expect((await h.purge(T0)).entries).toBe(total);

      const perEntry = 48 + 'Read f'.length + 'tool'.length + MAIN_LOOP.length + 13;
      await db.exec('TRUNCATE entries, stored_sessions, loops RESTART IDENTITY');
      const two = await seed({ policy: 'all', capGb: 1 }, { capBytesPerGb: perEntry * 4 + 5 });
      const r = await two.h.purge(T0);
      expect(r.entries).toBe(2);
      expect((await two.h.totals()).entries).toBe(4);
      // the two that went were the two oldest by server time
      expect(await db.get('SELECT MIN(t) AS t FROM entries')).toEqual({ t: T0 - 9 * DAY });
    });

    it('removes in batches when the cap is far below the total', async () => {
      const { h } = setup({ policy: 'all', capGb: 1 }, { capBytesPerGb: 1000, chunkRows: 100 });
      for (let i = 0; i < 12; i++) await h.ingest(report(Array.from({ length: 20 }, (_, k) => tool(T0 + i * 20 + k)), [], `s${i}`), 0, META);
      expect((await h.totals()).entries).toBe(240);
      const r = await h.purge(T0);
      expect(r.entries).toBeGreaterThan(200);
      expect((await h.totals()).entries).toBeLessThan(40);
    });

    it('rejects, leaving everything stored, when the policy cannot be applied', async () => {
      const { h, state } = await seed({ policy: 'end' });
      state.live = { has: () => { throw new Error('boom'); } } as unknown as Set<string>;
      await expect(h.purge(T0)).rejects.toThrow('boom');
      expect((await h.totals()).entries).toBe(6);
    });

    it('does nothing once stopped', async () => {
      const { h } = await seed({ policy: 'end' });
      h.stop();
      expect(await h.purge(T0)).toEqual({ entries: 0, bytes: 0, sessions: 0, freed: 0 });
      expect(await h.deleteBy({ all: true })).toEqual({ entries: 0, sessions: 0, bytes: 0, freed: 0 });
      expect((await h.totals()).entries).toBe(6);
    });
  });

  describe('preview', () => {
    it('reports what saving would remove without removing it, and matches the purge that follows', async () => {
      const s = setup({ policy: 'all' });
      await s.h.ingest(report([tool(T0 - 10 * DAY), tool(T0 - 1)], [], 'a'), 0, META);
      await s.h.ingest(report([tool(T0 - 20 * DAY)], [], 'b'), 0, META);
      const next: ActivityHistorySettings = { policy: 'after', n: 5, unit: 'days', capGb: null };
      const p = await s.h.preview(next);
      expect(p).toMatchObject({ entries: 2, sessions: 2, stopsCapturing: false });
      expect((await s.h.totals()).entries).toBe(3);
      s.state.settings = next;
      expect(await s.h.purge(T0)).toMatchObject({ entries: p.entries, bytes: p.bytes, sessions: p.sessions });
    });

    it('says when saving the default policy would stop capturing what is stored', async () => {
      const s = setup({ policy: 'all' });
      expect(await s.h.preview(ACTIVITY_HISTORY_DEFAULTS)).toMatchObject({ entries: 0, sessions: 0, stopsCapturing: false });
      await s.h.ingest(report([tool(T0), tool(T0 + 1)]), 0, META);
      const t = await s.h.totals();
      expect(await s.h.preview(ACTIVITY_HISTORY_DEFAULTS)).toEqual({ entries: 2, bytes: t.bytes, sessions: 1, stopsCapturing: true });
      expect((await s.h.totals()).entries).toBe(2);
    });

    it('under `end` counts the sessions that are not live, and a cap adds the oldest entries by bytes', async () => {
      const s = setup({ policy: 'all' });
      await s.h.ingest(report([tool(T0 - 3 * DAY), tool(T0 - 2 * DAY)], [], 'gone'), 0, META);
      await s.h.ingest(report([tool(T0 - DAY), tool(T0)], [], 'live'), 0, META);
      s.state.live.add('live');
      expect(await s.h.preview({ policy: 'end', n: 1, unit: 'days', capGb: null })).toMatchObject({ entries: 2, sessions: 1, stopsCapturing: false });
      const total = (await s.h.totals()).bytes;
      const capped = new PgActivityHistory(db, { now: () => T0, settings: () => s.state.settings, isLive: () => false, authOn: true, capBytesPerGb: total / 2 });
      const p = await capped.preview({ policy: 'all', n: 1, unit: 'days', capGb: 1 });
      expect(p.entries).toBe(2);
      expect(p.sessions).toBeGreaterThan(0);
    });
  });

  describe('list and delete', () => {
    async function seed() {
      const s = setup({ policy: 'all' });
      await s.h.ingest(report([tool(T0 - 5 * DAY), tool(T0 - 4 * DAY)], [tool(T0 - 3 * DAY)], 'alpha-1'), 0, { name: 'Alpha', project: 'acme/billing', owner: 'Ed' });
      await s.h.ingest(report([tool(T0 - 2 * DAY)], [], 'beta-2'), 0, { name: 'Beta', project: 'acme/web', owner: 'Sam' });
      await s.h.ingest(report([tool(T0 - DAY)], [], 'gamma_3'), 0, { name: '100% sure', project: null, owner: null });
      s.state.live.add('beta-2');
      return s;
    }

    it('lists sessions newest first with what is stored, whether each is live, and the selects', async () => {
      const { h } = await seed();
      const l = await h.list({});
      expect(l).toMatchObject({ total: 3, page: 1, pageSize: 25, totals: { entries: 5, sessions: 3 }, match: { entries: 5, sessions: 3 }, projects: ['acme/billing', 'acme/web'], owners: ['Ed', 'Sam'] });
      expect(l.rows.map((r) => [r.sessionId, r.entries, r.live])).toEqual([
        ['gamma_3', 1, false],
        ['beta-2', 1, true],
        ['alpha-1', 3, false],
      ]);
      expect(l.rows[2]).toMatchObject({ name: 'Alpha', project: 'acme/billing', owner: 'Ed', oldestAt: T0 - 5 * DAY });
      expect(l.rows[2]!.bytes).toBeGreaterThan(0);
    });

    it('orders sessions that share a last entry time by id as bytes, and the filter choices as bytes, with numbers as numbers', async () => {
      const { h } = setup();
      await h.ingest(report([tool(T0)], [], 's-b'), 0, { name: 'n', project: 'Zeta', owner: 'ann' });
      await h.ingest(report([tool(T0)], [], 's-B'), 0, { name: 'n', project: 'alpha', owner: 'Bob' });
      await h.ingest(report([tool(T0)], [], 's-a'), 0, { name: 'n', project: null, owner: null });
      const l = await h.list({}, 1, 10);
      expect(l.rows.map((r) => r.sessionId)).toEqual(['s-B', 's-a', 's-b']);
      expect(l.owners).toEqual(['Bob', 'ann']);
      expect(l.projects).toEqual(['Zeta', 'alpha']);
      for (const r of l.rows) for (const k of ['entries', 'bytes', 'oldestAt'] as const) expect(typeof r[k], k).toBe('number');
      for (const k of ['entries', 'sessions', 'bytes', 'fileBytes'] as const) expect(typeof l.totals[k], k).toBe('number');
    });

    it('pages the list and clamps the page and the size', async () => {
      const { h } = await seed();
      expect(await h.list({}, 2, 2)).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect((await h.list({}, 2, 2)).rows.map((r) => r.sessionId)).toEqual(['alpha-1']);
      expect(await h.list({}, 0, 0)).toMatchObject({ page: 1, pageSize: 25 });
      expect((await h.list({}, 1, 5000)).pageSize).toBe(200);
    });

    it('filters by name or id (case-insensitive, % and _ literal), project, owner and loop', async () => {
      const { h } = await seed();
      expect((await h.list({ q: 'ALPHA' })).rows.map((r) => r.sessionId)).toEqual(['alpha-1']);
      expect((await h.list({ q: 'beta-' })).rows.map((r) => r.sessionId)).toEqual(['beta-2']);
      expect((await h.list({ q: '100%' })).rows.map((r) => r.sessionId)).toEqual(['gamma_3']);
      expect((await h.list({ q: 'a_3' })).rows.map((r) => r.sessionId)).toEqual(['gamma_3']);
      expect((await h.list({ q: '%' })).rows.map((r) => r.sessionId)).toEqual(['gamma_3']);
      expect((await h.list({ q: '   ' })).total).toBe(3);
      expect((await h.list({ project: 'acme/web' })).rows.map((r) => r.sessionId)).toEqual(['beta-2']);
      expect((await h.list({ owner: 'Ed' })).rows.map((r) => r.sessionId)).toEqual(['alpha-1']);
      expect(await h.list({ loop: 'agents' })).toMatchObject({ total: 1, match: { entries: 1 } });
      expect((await h.list({ loop: 'main' })).match.entries).toBe(4);
      expect((await h.list({ loop: 'all' })).match.entries).toBe(5);
    });

    it('filters the entry window: older than n days, from, to', async () => {
      const { h } = await seed();
      expect(await h.list({ olderThanDays: 3.5 })).toMatchObject({ total: 1, match: { entries: 2 } });
      expect((await h.list({ olderThanDays: 3.5 })).rows[0]).toMatchObject({ sessionId: 'alpha-1', entries: 2 });
      expect((await h.list({ from: T0 - 2 * DAY, to: T0 })).match.entries).toBe(2);
      expect((await h.list({ from: T0 - 2 * DAY, to: T0 - DAY })).match.entries).toBe(1);
    });

    it('takes a window that is not a whole number of milliseconds', async () => {
      const { h } = await seed();
      expect((await h.list({ olderThanDays: 3.5000000001 })).match.entries).toBe(2);
      expect((await h.list({ from: T0 - 2 * DAY + 0.5, to: T0 - DAY + 0.5 })).match.entries).toBe(1);
    });

    it('counts a window in slices when a session has more entries than one slice', async () => {
      const small = new PgActivityHistory(db, { now: () => T0, settings: () => ({ ...ACTIVITY_HISTORY_DEFAULTS, policy: 'all' }), isLive: () => false, authOn: true, sliceRows: 3 });
      await small.ingest(report(Array.from({ length: 10 }, (_, i) => tool(T0 - 10 * DAY + i * 1000)), [], 'sliced'), 0, META);
      const l = await small.list({ olderThanDays: 5 });
      expect(l).toMatchObject({ total: 1, match: { entries: 10 } });
      expect((await small.list({ from: T0 - 10 * DAY + 4000, to: T0 - 10 * DAY + 8000 })).match.entries).toBe(4);
    });

    it('deletes ticked sessions, everything a filter matches, or everything', async () => {
      const a = await seed();
      expect(await a.h.deleteBy({ ids: ['alpha-1', 'nope'] })).toMatchObject({ entries: 3, sessions: 1 });
      expect(await a.h.totals()).toMatchObject({ entries: 2, sessions: 2 });
      expect(await a.h.deleteBy({ ids: [] })).toEqual({ entries: 0, sessions: 0, bytes: 0, freed: 0 });

      await db.exec('TRUNCATE entries, stored_sessions, loops RESTART IDENTITY');
      const b = await seed();
      const r = await b.h.deleteBy({ match: { olderThanDays: 3.5 } });
      expect(r).toMatchObject({ entries: 2, sessions: 1 }); // alpha-1 lost two entries and keeps one
      expect((await b.h.list({})).rows.find((x) => x.sessionId === 'alpha-1')?.entries).toBe(1);
      expect(await b.h.deleteBy({ match: { loop: 'agents' } })).toMatchObject({ entries: 1, sessions: 1 });
      expect(await b.h.deleteBy({ match: { q: 'beta' } })).toMatchObject({ entries: 1, sessions: 1 });

      await db.exec('TRUNCATE entries, stored_sessions, loops RESTART IDENTITY');
      const c = await seed();
      const all = await c.h.deleteBy({ all: true });
      expect(all).toMatchObject({ entries: 5, sessions: 3 });
      expect(all.bytes).toBeGreaterThan(0);
      expect(await c.h.totals()).toMatchObject({ entries: 0, sessions: 0 });
      expect((await c.h.list({})).total).toBe(0);
    });

    it('rejects, leaving everything stored, when a delete fails', async () => {
      const { h } = await seed();
      await expect(h.deleteBy({ ids: ['alpha-1'] }, async () => { throw new Error('asked'); })).rejects.toThrow('asked');
      expect((await h.totals()).entries).toBe(5);
    });

    it('leaves a session alone when it is no longer wanted by the time its rows would go', async () => {
      const { h } = await seed();
      expect(await h.deleteBy({ ids: ['alpha-1', 'beta-2'] }, async (id) => id === 'beta-2')).toMatchObject({ entries: 1, sessions: 1 });
      expect((await h.list({})).rows.map((r) => r.sessionId).sort()).toEqual(['alpha-1', 'gamma_3']);
    });

    it('deletes one session’s rows and forgets its loop positions, and removes the rows of sessions the main database lost', async () => {
      const { h } = await seed();
      expect(await h.deleteSession('alpha-1')).toMatchObject({ entries: 3, sessions: 1 });
      expect(await h.deleteSession('nobody')).toEqual({ entries: 0, sessions: 0, bytes: 0, freed: 0 });
      expect(await h.dropMissingSessions((id) => id === 'beta-2')).toBe(1);
      expect((await h.list({})).rows.map((r) => r.sessionId)).toEqual(['beta-2']);
      expect(await h.dropMissingSessions(() => true)).toBe(0);
    });
  });

  describe('closing during a removal', () => {
    it('ends a purge at its next chunk, with nothing freed', async () => {
      const { h, state } = setup({ policy: 'end' }, { chunkRows: 2 });
      state.live.clear();
      for (let b = 0; b < 10; b++) await h.ingest(report(Array.from({ length: 20 }, (_, k) => tool(T0 + 100 * b + k, `e${b}-${k}`)), [], 'closing-1'), 0, META);
      const purge = h.purge();
      await new Promise((resolve) => setImmediate(resolve));
      h.stop();
      await expect(purge).resolves.toMatchObject({ freed: 0 });
      expect((await h.totals()).entries).toBe(await n('SELECT COUNT(*) AS n FROM entries'));
    });
  });

  describe('compaction', () => {
    it('has nothing to give back: autovacuum owns the space', async () => {
      const { h } = setup();
      expect(await h.compactNow()).toBe(0);
      expect(await h.runExclusive(async () => h.compactNow())).toBe(0);
    });
  });

  describe('heavy operations', () => {
    it('run one at a time and count as busy while they run or wait', async () => {
      const { h } = setup();
      const order: string[] = [];
      let release!: () => void;
      const first = h.runExclusive(async () => {
        order.push('first start');
        await new Promise<void>((resolve) => (release = resolve));
        order.push('first end');
      });
      const second = h.runExclusive(async () => void order.push('second'));
      expect(h.busy).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(order).toEqual(['first start']);
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(['first start', 'first end', 'second']);
      expect(h.busy).toBe(false);
      await expect(h.runExclusive(() => Promise.reject(new Error('bad')))).rejects.toThrow('bad');
      await h.idle();
      expect(h.busy).toBe(false);
    });
  });

  // #808: the bulk delete binds its ids in batches of a fixed size, so a set is checked on and around the batch edges.
  describe('a bulk delete across the batch edges (#808)', () => {
    const ROWS = 450;

    /** Two sessions, the first with `ROWS` entries over the orchestrator and an agent, the second with 30 that must never be touched. */
    async function fill(opts: { chunkRows?: number } = {}) {
      const h = new PgActivityHistory(db, { now: () => T0, settings: () => ({ ...ACTIVITY_HISTORY_DEFAULTS, policy: 'all' as const }), isLive: () => false, agentsOf: () => ['a1'], authOn: true, ...opts });
      const mk = (count: number, base: number) => Array.from({ length: count }, (_, k) => tool(T0 + base + k, `Read file-${base + k}-${'x'.repeat(k % 7)}`));
      const big = report(mk(300, 0), mk(ROWS - 300, 1000), 'big');
      const other = report(mk(30, 5000), [], 'other');
      other.agents[0]!.activity = [];
      expect(await h.ingest(big, 0, META)).toBe(ROWS);
      expect(await h.ingest(other, 0, META)).toBe(30);
      return h;
    }

    type Victim = { id: number; sid: string; loop: string; b: number };
    const victims = (sid = 'big') => db.all<Victim>(`SELECT id, session_id AS sid, loop, ${entryBytesSql()} AS b FROM entries WHERE session_id = ? ORDER BY id`, [sid]);
    const ids = async () => (await db.all<{ id: number }>('SELECT id FROM entries ORDER BY id')).map((r) => r.id);
    const aggregates = async (sid: string) => ({
      session: await db.get('SELECT entries, bytes FROM stored_sessions WHERE session_id = ?', [sid]),
      loops: await db.all('SELECT loop, entries FROM loops WHERE session_id = ? ORDER BY loop', [sid]),
      actual: await db.get(`SELECT COUNT(*) AS entries, COALESCE(SUM(${entryBytesSql()}), 0) AS bytes FROM entries WHERE session_id = ?`, [sid]),
    });

    it.each([1, 199, 200, 201, 400, 401, 450])('removes exactly the %i rows given, leaving every other one and exact aggregates', async (count) => {
      const h = await fill();
      const all = await victims();
      // every other row first, so the ids are not one run
      const pick = [...all.filter((_, i) => i % 2 === 0), ...all.filter((_, i) => i % 2 === 1)].slice(0, count);
      const gone = new Set(pick.map((v) => v.id));
      const before = await ids();
      const touched = { sessions: new Set<string>(), loops: new Map<string, { sid: string; loop: string }>() };
      await (h as unknown as { dropRows(rows: Victim[], t: typeof touched): Promise<void> }).dropRows(pick, touched);
      expect(await ids()).toEqual(before.filter((id) => !gone.has(id)));
      const a = await aggregates('big');
      expect(a.session).toEqual(a.actual);
      expect(a.session).toMatchObject({ entries: ROWS - count });
      expect(a.session).toMatchObject({ bytes: all.filter((v) => !gone.has(v.id)).reduce((x, v) => x + v.b, 0) });
      const left = (loop: string) => all.filter((v) => v.loop === loop && !gone.has(v.id)).length;
      expect(a.loops).toEqual([{ loop: MAIN_LOOP, entries: left(MAIN_LOOP) }, { loop: 'a1', entries: left('a1') }].sort((x, y) => (x.loop < y.loop ? -1 : x.loop > y.loop ? 1 : 0)));
      expect((await aggregates('other')).session).toMatchObject({ entries: 30 });
      expect([...touched.sessions]).toEqual(['big']);
    });

    it.each([100, 1000, 5000])('deletes a whole session of %i-row chunks through deleteBy and keeps the other session intact', async (chunkRows) => {
      const h = await fill({ chunkRows });
      const keep = (await victims('other')).map((v) => v.id);
      expect(await h.deleteBy({ ids: ['big'] })).toMatchObject({ entries: ROWS, sessions: 1 });
      expect(await ids()).toEqual(keep);
      expect((await aggregates('other')).session).toMatchObject({ entries: 30 });
      expect(await n("SELECT COUNT(*) AS n FROM stored_sessions WHERE session_id = 'big'")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM loops WHERE session_id = 'big'")).toBe(0);
    });

    it('removes only the filtered rows when the match spans more than one chunk', async () => {
      const h = await fill({ chunkRows: 100 });
      const all = await victims();
      const r = await h.deleteBy({ match: { loop: 'agents' } });
      expect(r).toMatchObject({ entries: ROWS - 300 });
      expect(await ids()).toEqual(all.filter((v) => v.loop !== 'a1').map((v) => v.id).concat((await victims('other')).map((v) => v.id)).sort((x, y) => x - y));
      const a = await aggregates('big');
      expect(a.session).toEqual(a.actual);
      expect(a.session).toMatchObject({ entries: 300 });
    });
  });

  describe('a Bash command and its output (#431)', () => {
    const SECRET = 'sk-live-OUTPUT-SECRET-9f3a';
    const bash = (at: number, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({
      at,
      kind: 'tool',
      text: 'Bash npm test',
      id: `c${at}`,
      command: 'npm test -- --run\necho done',
      ...extra,
    });

    it('stores the whole command and its cut flag, and reads them back for stored entries', async () => {
      const { h } = setup();
      const r = report([bash(T0 + 1), bash(T0 + 2, { command: 'x'.repeat(100), commandCut: true })]);
      await h.ingest(r, 0, META);
      const got = (await h.page(r.session.id, MAIN_LOOP, null, 20)).entries;
      expect(got[0]).toEqual({ seq: 1, at: T0 + 1, kind: 'tool', text: 'Bash npm test', command: 'npm test -- --run\necho done' });
      expect(got[1]).toMatchObject({ command: 'x'.repeat(100), commandCut: true });
    });

    it('never stores output, done, exitCode, failed or the call id, in any column', async () => {
      const { h } = setup();
      const r = report([bash(T0 + 1, { output: SECRET, outputCut: true, done: true, exitCode: 2, failed: true })]);
      await h.ingest(r, 0, META);
      const got = (await h.page(r.session.id, MAIN_LOOP, null, 20)).entries[0]!;
      for (const key of ['output', 'outputCut', 'done', 'exitCode', 'failed', 'id']) expect(got).not.toHaveProperty(key);
      expect(JSON.stringify(await db.all('SELECT * FROM entries'))).not.toContain(SECRET);
      expect(Object.keys((await db.get('SELECT * FROM entries'))!)).not.toEqual(expect.arrayContaining(['output']));
    });

    it('a later snapshot that adds output to a stored entry changes nothing in the database', async () => {
      const { h } = setup();
      const sid = report([]).session.id;
      await h.ingest(report([bash(T0 + 1)]), 0, META);
      const before = JSON.stringify(await db.all('SELECT * FROM entries'));
      expect(await h.ingest(report([bash(T0 + 1, { output: SECRET, done: true })]), 0, META)).toBe(0);
      expect(JSON.stringify(await db.all('SELECT * FROM entries'))).toBe(before);
      expect((await h.page(sid, MAIN_LOOP, null, 20)).entries).toHaveLength(1);
    });

    it('an older mod entry (no new fields) is stored and read back as before', async () => {
      const { h } = setup();
      const r = report([tool(T0 + 1)]);
      await h.ingest(r, 0, META);
      expect((await h.page(r.session.id, MAIN_LOOP, null, 20)).entries).toEqual([{ seq: 1, at: T0 + 1, kind: 'tool', text: 'Read f' + (T0 + 1) }]);
    });

    it('bounds a command that arrives over its limit, and keeps it on a tool entry only', async () => {
      const { h } = setup();
      const r = report([bash(T0 + 1, { command: 'y'.repeat(30_000) }), { at: T0 + 2, kind: 'text', text: 'hi', command: 'ls' }]);
      await h.ingest(r, 0, META);
      const got = (await h.page(r.session.id, MAIN_LOOP, null, 20)).entries;
      expect(got[0]!.command).toHaveLength(LIMITS.activityDetail);
      expect(got[1]).not.toHaveProperty('command');
    });

    it('counts the command in the stored size, and a purge removes it and settles the count', async () => {
      const { h } = setup({ policy: 'after', n: 1, unit: 'days' });
      await h.ingest(report([bash(T0 + 1, { command: undefined })]), 0, META);
      const small = (await h.totals()).bytes;
      await db.exec('TRUNCATE entries, stored_sessions, loops RESTART IDENTITY');
      h.forgetSession(report([]).session.id);
      await h.ingest(report([bash(T0 + 1, { command: 'z'.repeat(1000) })]), 0, META);
      expect((await h.totals()).bytes - small).toBe(1000);
      expect(await n('SELECT bytes AS n FROM stored_sessions')).toBe((await h.totals()).bytes);
      expect((await h.purge(T0 + 2 * DAY)).entries).toBe(1);
      expect(await h.totals()).toMatchObject({ entries: 0, bytes: 0 });
      expect(await n('SELECT COUNT(*) AS n FROM entries')).toBe(0);
    });
  });
});
