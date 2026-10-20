import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activityDbPath, openActivityDb } from './activityDb.js';
import { ActivityHistory, type SessionMeta } from './activityHistory.js';
import { ACTIVITY_HISTORY_DEFAULTS, ACTIVITY_UNIT_MS, type ActivityHistorySettings } from './activityHistoryTypes.js';
import { MAIN_LOOP, type ActivityEntry, type Report } from './protocol.js';
import { fixtureReport } from './testing.js';

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

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(over: Partial<ActivityHistorySettings> = {}, file = ':memory:', extra: { authOn?: boolean; featureOn?: boolean; capBytesPerGb?: number } = {}) {
  let t = T0;
  const state = { settings: { ...ACTIVITY_HISTORY_DEFAULTS, policy: 'all' as const, ...over }, live: new Set<string>(), featureOn: extra.featureOn ?? true };
  const db = openActivityDb(file);
  const h = new ActivityHistory(db, {
    now: () => t,
    settings: () => state.settings,
    featureOn: () => state.featureOn,
    isLive: (id) => state.live.has(id),
    agentsOf: () => ['a1', 'a2'],
    authOn: extra.authOn ?? true,
    capBytesPerGb: extra.capBytesPerGb,
  });
  return { h, db, state, advance: (ms: number) => (t += ms), now: () => t };
}

const tmpFile = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'podium-activity-'));
  dirs.push(dir);
  return path.join(dir, 'sub', 'activity.sqlite');
};

describe('openActivityDb', () => {
  it('makes the folder, sets incremental auto-vacuum before the tables, WAL, and the schema version', async () => {
    const file = tmpFile();
    const db = openActivityDb(file);
    expect((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4);
    db.close();
    // opening again runs no migration and keeps the version
    const again = openActivityDb(file);
    expect((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4);
    again.close();
  });

  it('lives beside the main database, or in memory when the main one is', async () => {
    expect(activityDbPath('/data/podium.sqlite')).toBe('/data/activity.sqlite');
    expect(activityDbPath(':memory:')).toBe(':memory:');
  });
});

describe('enabled', () => {
  it('is off for the default policy, on for a keep policy, and off without a token or with the feature flag off', async () => {
    expect(setup({ policy: 'default' }).h.enabled()).toBe(false);
    expect(setup({ policy: 'all' }).h.enabled()).toBe(true);
    expect(setup({ policy: 'all' }, ':memory:', { authOn: false }).h.enabled()).toBe(false);
    expect(setup({ policy: 'all' }, ':memory:', { featureOn: false }).h.enabled()).toBe(false);
  });

  it('lists the orchestrator and every running agent to watch', async () => {
    expect(setup().h.loopsToWatch('s')).toEqual([MAIN_LOOP, 'a1', 'a2']);
  });

  it('without an agent lookup, watches the orchestrator alone', async () => {
    const h = new ActivityHistory(openActivityDb(':memory:'), { now: () => T0, settings: () => ACTIVITY_HISTORY_DEFAULTS, isLive: () => false, authOn: true });
    expect(h.loopsToWatch('s')).toEqual([MAIN_LOOP]);
  });
});

describe('capture', () => {
  it('stores the orchestrator and an agent with no lease, in order, numbered per loop', async () => {
    const { h } = setup();
    const r = report([tool(T0 + 1), tool(T0 + 2)], [tool(T0 + 3)]);
    expect(h.ingest(r, 0, META)).toBe(3);
    const sid = r.session.id;
    expect(h.page(sid, MAIN_LOOP, null, 20).entries.map((e) => [e.seq, e.at])).toEqual([
      [1, T0 + 1],
      [2, T0 + 2],
    ]);
    expect(h.page(sid, r.agents[0]!.id, null, 20).entries.map((e) => [e.seq, e.at])).toEqual([[1, T0 + 3]]);
    expect(h.totals()).toMatchObject({ entries: 3, sessions: 1 });
  });

  it('stores nothing under the default policy, without a token, or with the flag off', async () => {
    for (const s of [setup({ policy: 'default' }), setup({}, ':memory:', { authOn: false }), setup({}, ':memory:', { featureOn: false })]) {
      expect(s.h.ingest(report([tool(T0)]), 0, META)).toBe(0);
      expect(s.h.totals().entries).toBe(0);
    }
  });

  it('ignores a report with no entries', async () => {
    const { h } = setup();
    expect(h.ingest(report([]), 0, META)).toBe(0);
    expect(h.totals().sessions).toBe(0);
  });

  it('adds each entry once across the overlapping snapshots of several reports', async () => {
    const { h } = setup();
    const sid = report([]).session.id;
    h.ingest(report([tool(T0 + 1), tool(T0 + 2)]), 0, META);
    h.ingest(report([tool(T0 + 1), tool(T0 + 2), tool(T0 + 3)]), 0, META);
    h.ingest(report([tool(T0 + 1), tool(T0 + 2), tool(T0 + 3)]), 0, META);
    h.ingest(report([tool(T0 + 2), tool(T0 + 3), tool(T0 + 4)]), 0, META);
    expect(h.page(sid, MAIN_LOOP, null, 20).entries.map((e) => [e.seq, e.at])).toEqual([
      [1, T0 + 1],
      [2, T0 + 2],
      [3, T0 + 3],
      [4, T0 + 4],
    ]);
  });

  it('keeps two different entries at the same time, and skips one older than the newest', async () => {
    const { h } = setup();
    const sid = report([]).session.id;
    h.ingest(report([{ at: T0 + 5, kind: 'tool', text: 'Read a' }, { at: T0 + 5, kind: 'text', text: 'thinking aloud' }]), 0, META);
    h.ingest(report([tool(T0 + 1, 'Read old'), { at: T0 + 5, kind: 'tool', text: 'Read a' }, { at: T0 + 5, kind: 'tool', text: 'Read b' }]), 0, META);
    expect(h.page(sid, MAIN_LOOP, null, 20).entries.map((e) => e.text)).toEqual(['Read a', 'thinking aloud', 'Read b']);
  });

  it('keeps the entry time as shown and the server-clock time as the reporter time less the skew', async () => {
    const { h, db } = setup();
    h.ingest(report([tool(T0 + 10_000)]), 4_000, META);
    expect(db.prepare('SELECT at, t FROM entries').get()).toEqual({ at: T0 + 10_000, t: T0 + 6_000 });
    expect(db.prepare('SELECT first_t, last_t FROM stored_sessions').get()).toEqual({ first_t: T0 + 6_000, last_t: T0 + 6_000 });
  });

  it('cuts an entry to the feed limit and updates the session name on a later report', async () => {
    const { h, db } = setup();
    h.ingest(report([tool(T0, 'x'.repeat(400))]), 0, META);
    h.ingest(report([tool(T0 + 1)]), 0, { ...META, name: 'renamed' });
    expect((db.prepare('SELECT length(text) AS n FROM entries WHERE seq = 1').get() as { n: number }).n).toBe(300);
    expect((db.prepare('SELECT name FROM stored_sessions').get() as { name: string }).name).toBe('renamed');
  });

  it('rolls a failed ingest back and forgets the loop positions, so the next one starts from the file', async () => {
    const { h } = setup();
    const sid = report([]).session.id;
    expect(() => h.ingest(report([tool(T0)]), 0, { name: null as unknown as string, project: null, owner: null })).toThrow();
    expect(h.totals().entries).toBe(0);
    expect(h.ingest(report([tool(T0)]), 0, META)).toBe(1);
    expect(h.page(sid, MAIN_LOOP, null, 20).entries.map((e) => e.seq)).toEqual([1]);
  });
});

describe('restart', () => {
  it('continues the sequence and de-duplicates against the file after reopening it', async () => {
    const file = tmpFile();
    const first = setup({}, file);
    const sid = report([]).session.id;
    first.h.ingest(report([tool(T0 + 1), tool(T0 + 2)]), 0, META);
    first.h.close();

    const second = setup({}, file);
    expect(second.h.ingest(report([tool(T0 + 1), tool(T0 + 2), tool(T0 + 3)]), 0, META)).toBe(1);
    second.h.addPodium(sid, MAIN_LOOP, 'd1', { at: T0 + 4, text: 'answered', by: 'Ed', note: null }, META);
    expect(second.h.page(sid, MAIN_LOOP, null, 20).entries.map((e) => [e.seq, e.at])).toEqual([
      [1, T0 + 1],
      [2, T0 + 2],
      [3, T0 + 3],
      [4, T0 + 4],
    ]);
    second.h.close();
  });

  it('reloads the entries stored at the newest time, so a repeat of them is still skipped', async () => {
    const file = tmpFile();
    const first = setup({}, file);
    first.h.ingest(report([tool(T0 + 1, 'Read a'), tool(T0 + 1, 'Read b')]), 0, META);
    first.h.close();
    const second = setup({}, file);
    expect(second.h.ingest(report([tool(T0 + 1, 'Read a'), tool(T0 + 1, 'Read b'), tool(T0 + 1, 'Read c')]), 0, META)).toBe(1);
    second.h.close();
  });

  it('forgetSession drops a session’s loop positions and they reload from the file', async () => {
    const { h } = setup();
    const sid = report([]).session.id;
    h.ingest(report([tool(T0 + 1)]), 0, META);
    h.forgetSession(sid);
    expect(h.ingest(report([tool(T0 + 1), tool(T0 + 2)]), 0, META)).toBe(1);
    expect(h.page(sid, MAIN_LOOP, null, 20).entries.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('Podium entries', () => {
  it('are written through with their sender and note, share the loop numbering, and are not compared as reporter entries', async () => {
    const { h } = setup();
    const sid = report([]).session.id;
    h.ingest(report([tool(T0 + 100)]), 0, META);
    h.addPodium(sid, MAIN_LOOP, 'd1', { at: T0 + 50, text: 'answered: yes', by: 'Ed', note: 'queued' }, META);
    // a reporter entry between the two times is still newer than the last reporter entry only if it is
    expect(h.ingest(report([tool(T0 + 100), tool(T0 + 101)]), 0, META)).toBe(1);
    expect(h.page(sid, MAIN_LOOP, null, 20).entries).toEqual([
      { seq: 1, at: T0 + 100, kind: 'tool', text: 'Read f1800000000100' },
      { seq: 2, at: T0 + 50, kind: 'podium', text: 'answered: yes', by: 'Ed', note: 'queued' },
      { seq: 3, at: T0 + 101, kind: 'tool', text: 'Read f1800000000101' },
    ]);
  });

  it('stores nothing when history is off, updates a note, and removes an entry with its session row when it was the last', async () => {
    const off = setup({ policy: 'default' });
    off.h.addPodium('s', MAIN_LOOP, 'd1', { at: T0, text: 't', by: 'Ed', note: null }, META);
    expect(off.h.totals().entries).toBe(0);

    const { h, db } = setup();
    h.addPodium('s', MAIN_LOOP, 'd1', { at: T0, text: 'x'.repeat(400), by: 'Ed', note: null }, META);
    h.updatePodium('s', 'd1', 'the session took it');
    expect(h.page('s', MAIN_LOOP, null, 20).entries[0]).toMatchObject({ note: 'the session took it' });
    expect((db.prepare('SELECT length(text) AS n FROM entries').get() as { n: number }).n).toBe(300);
    h.removePodium('s', 'other');
    expect(h.totals().entries).toBe(1);
    h.removePodium('s', 'd1');
    expect(h.totals()).toMatchObject({ entries: 0, sessions: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM stored_sessions').get()).toEqual({ n: 0 });
  });
});

describe('page and note', () => {
  const fill = (h: ActivityHistory, n: number) => {
    const sid = report([]).session.id;
    for (let i = 1; i <= n; i += 10) h.ingest(report(Array.from({ length: Math.min(10, n - i + 1) }, (_, k) => tool(T0 + i + k))), 0, META);
    return sid;
  };

  it('returns pages oldest first with the cursor of the next older page', async () => {
    const { h } = setup();
    const sid = fill(h, 45);
    const newest = h.page(sid, MAIN_LOOP, null, 20);
    expect(newest.entries.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 26 + i));
    expect(newest.olderBefore).toBe(26);
    expect(newest.total).toBe(45);
    const mid = h.page(sid, MAIN_LOOP, newest.olderBefore, 20);
    expect(mid.entries[0]!.seq).toBe(6);
    const last = h.page(sid, MAIN_LOOP, mid.olderBefore, 20);
    expect(last.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(last.olderBefore).toBeNull();
  });

  it('clamps the limit, uses the default for a bad one, and is empty for a loop with nothing', async () => {
    const { h } = setup();
    const sid = fill(h, 150);
    expect(h.page(sid, MAIN_LOOP, null, 1000).entries).toHaveLength(100);
    expect(h.page(sid, MAIN_LOOP, null, 0).entries).toHaveLength(20);
    expect(h.page(sid, MAIN_LOOP, null).entries).toHaveLength(20);
    expect(h.page(sid, 'nothing', null, 20)).toEqual({ entries: [], olderBefore: null, total: 0, since: null, keptUntil: null });
  });

  it('counts a loop for the live reply: since, and when the newest goes under `after`', async () => {
    const all = setup({ policy: 'all' });
    const sid = fill(all.h, 3);
    expect(all.h.note(sid, MAIN_LOOP)).toEqual({ policy: 'all', total: 3, since: T0 + 1, keptUntil: null });
    expect(all.h.note(sid, 'nothing')).toBeNull();

    const after = setup({ policy: 'after', n: 2, unit: 'days' });
    const sid2 = fill(after.h, 3);
    expect(after.h.note(sid2, MAIN_LOOP)).toEqual({ policy: 'after', total: 3, since: T0 + 1, keptUntil: T0 + 3 + 2 * DAY });
    after.state.settings = { ...ACTIVITY_HISTORY_DEFAULTS };
    expect(after.h.note(sid2, MAIN_LOOP)).toBeNull();
  });
});

describe('purge', () => {
  /** Three sessions: one old, one recent, one recent and live. */
  function seed(over: Partial<ActivityHistorySettings>, extra: { capBytesPerGb?: number } = {}) {
    const s = setup(over, ':memory:', extra);
    s.h.ingest(report([tool(T0 - 10 * DAY), tool(T0 - 9 * DAY)], [], 'old'), 0, { ...META, name: 'old' });
    s.h.ingest(report([tool(T0 - 2 * DAY), tool(T0 - DAY)], [], 'recent'), 0, { ...META, name: 'recent' });
    s.h.ingest(report([tool(T0 - 10 * DAY), tool(T0 - 1000)], [], 'running'), 0, { ...META, name: 'running' });
    s.state.live.add('running');
    return s;
  }

  it('does nothing under the default policy', async () => {
    const s = setup({ policy: 'default' });
    expect((await s.h.purge(T0))).toEqual({ entries: 0, bytes: 0, sessions: 0, freed: 0 });
    expect(s.h.lastPurge).toBeNull();
  });

  it('under `after` removes entries older than the period, entry by entry, and sessions left empty', async () => {
    const { h, advance } = seed({ policy: 'after', n: 3, unit: 'days' });
    const r = (await h.purge(T0));
    // two sessions lost entries: `old` lost both of its (and is gone), `running` lost its oldest one
    expect(r).toMatchObject({ entries: 3, sessions: 2 });
    expect(r.bytes).toBeGreaterThan(0);
    expect(h.totals()).toMatchObject({ entries: 3, sessions: 2 });
    expect(h.lastPurge).toEqual({ at: T0, entries: 3, bytes: r.bytes });
    // a run that removes nothing does not move lastPurge
    advance(1000);
    expect((await h.purge(T0))).toMatchObject({ entries: 0, sessions: 0, freed: 0 });
    expect(h.lastPurge?.at).toBe(T0);
  });

  it('defaults the time of a purge to now', async () => {
    const { h, advance } = seed({ policy: 'after', n: 3, unit: 'days' });
    advance(100 * DAY);
    expect((await h.purge()).entries).toBe(6);
  });

  it('under `end` removes the sessions that are not live', async () => {
    const { h } = seed({ policy: 'end' });
    expect((await h.purge(T0))).toMatchObject({ entries: 4, sessions: 2 });
    expect(h.totals()).toMatchObject({ entries: 2, sessions: 1 });
    expect((await h.list({})).rows.map((r) => r.sessionId)).toEqual(['running']);
  });

  it('under `all` removes nothing without a cap', async () => {
    const { h } = seed({ policy: 'all' });
    expect((await h.purge(T0))).toMatchObject({ entries: 0, sessions: 0 });
  });

  it('with a cap, removes the oldest entries first until the total is under it', async () => {
    const { h, db } = seed({ policy: 'all', capGb: 1 }, { capBytesPerGb: 1 });
    // the cap is 1 byte here: everything goes, oldest first
    const total = (db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
    expect((await h.purge(T0)).entries).toBe(total);

    const perEntry = 48 + 'Read f'.length + 'tool'.length + MAIN_LOOP.length + 13;
    const two = seed({ policy: 'all', capGb: 1 }, { capBytesPerGb: perEntry * 4 + 5 });
    const r = (await two.h.purge(T0));
    expect(r.entries).toBe(2);
    expect(two.h.totals().entries).toBe(4);
    // the two that went were the two oldest by server time
    expect(two.db.prepare('SELECT MIN(t) AS t FROM entries').get()).toEqual({ t: T0 - 9 * DAY });
  });

  it('removes in batches when the cap is far below the total', async () => {
    const { h } = setup({ policy: 'all', capGb: 1 }, ':memory:', { capBytesPerGb: 1000 });
    for (let i = 0; i < 12; i++) h.ingest(report(Array.from({ length: 20 }, (_, k) => tool(T0 + i * 20 + k)), [], `s${i}`), 0, META);
    expect(h.totals().entries).toBe(240);
    const r = (await h.purge(T0));
    expect(r.entries).toBeGreaterThan(200);
    expect(h.totals().entries).toBeLessThan(40);
  });

  it('rejects, leaving everything stored, when the policy cannot be applied', async () => {
    const { h, state } = seed({ policy: 'end' });
    state.live = { has: () => { throw new Error('boom'); } } as unknown as Set<string>;
    await expect(h.purge(T0)).rejects.toThrow('boom');
    expect(h.totals().entries).toBe(6);
  });
});

describe('preview', () => {
  it('reports what saving would remove without removing it, and matches the purge that follows', async () => {
    const s = setup({ policy: 'all' });
    s.h.ingest(report([tool(T0 - 10 * DAY), tool(T0 - 1)], [], 'a'), 0, META);
    s.h.ingest(report([tool(T0 - 20 * DAY)], [], 'b'), 0, META);
    const next: ActivityHistorySettings = { policy: 'after', n: 5, unit: 'days', capGb: null };
    const p = (await s.h.preview(next));
    expect(p).toMatchObject({ entries: 2, sessions: 2, stopsCapturing: false });
    expect(s.h.totals().entries).toBe(3);
    s.state.settings = next;
    expect((await s.h.purge(T0))).toMatchObject({ entries: p.entries, bytes: p.bytes, sessions: p.sessions });
  });

  it('says when saving the default policy would stop capturing what is stored', async () => {
    const s = setup({ policy: 'all' });
    const empty = (await s.h.preview(ACTIVITY_HISTORY_DEFAULTS));
    expect(empty).toMatchObject({ entries: 0, sessions: 0, stopsCapturing: false });
    s.h.ingest(report([tool(T0), tool(T0 + 1)]), 0, META);
    const t = s.h.totals();
    expect((await s.h.preview(ACTIVITY_HISTORY_DEFAULTS))).toEqual({ entries: 2, bytes: t.bytes, sessions: 1, stopsCapturing: true });
    expect(s.h.totals().entries).toBe(2);
  });
});

describe('list and delete', () => {
  function seed() {
    const s = setup({ policy: 'all' });
    s.h.ingest(report([tool(T0 - 5 * DAY), tool(T0 - 4 * DAY)], [tool(T0 - 3 * DAY)], 'alpha-1'), 0, { name: 'Alpha', project: 'acme/billing', owner: 'Ed' });
    s.h.ingest(report([tool(T0 - 2 * DAY)], [], 'beta-2'), 0, { name: 'Beta', project: 'acme/web', owner: 'Sam' });
    s.h.ingest(report([tool(T0 - DAY)], [], 'gamma_3'), 0, { name: '100% sure', project: null, owner: null });
    s.state.live.add('beta-2');
    return s;
  }

  it('lists sessions newest first with what is stored, whether each is live, and the selects', async () => {
    const { h } = seed();
    const l = (await h.list({}));
    expect(l).toMatchObject({ total: 3, page: 1, pageSize: 25, totals: { entries: 5, sessions: 3 }, match: { entries: 5, sessions: 3 }, projects: ['acme/billing', 'acme/web'], owners: ['Ed', 'Sam'] });
    expect(l.rows.map((r) => [r.sessionId, r.entries, r.live])).toEqual([
      ['gamma_3', 1, false],
      ['beta-2', 1, true],
      ['alpha-1', 3, false],
    ]);
    expect(l.rows[2]).toMatchObject({ name: 'Alpha', project: 'acme/billing', owner: 'Ed', oldestAt: T0 - 5 * DAY });
    expect(l.rows[2]!.bytes).toBeGreaterThan(0);
  });

  it('pages the list and clamps the page and the size', async () => {
    const { h } = seed();
    expect((await h.list({}, 2, 2))).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect((await h.list({}, 2, 2)).rows.map((r) => r.sessionId)).toEqual(['alpha-1']);
    expect((await h.list({}, 0, 0))).toMatchObject({ page: 1, pageSize: 25 });
    expect((await h.list({}, 1, 5000)).pageSize).toBe(200);
  });

  it('filters by name or id (case-insensitive, % and _ literal), project, owner and loop', async () => {
    const { h } = seed();
    expect((await h.list({ q: 'ALPHA' })).rows.map((r) => r.sessionId)).toEqual(['alpha-1']);
    expect((await h.list({ q: 'beta-' })).rows.map((r) => r.sessionId)).toEqual(['beta-2']);
    expect((await h.list({ q: '100%' })).rows.map((r) => r.sessionId)).toEqual(['gamma_3']);
    expect((await h.list({ q: 'a_3' })).rows.map((r) => r.sessionId)).toEqual(['gamma_3']);
    expect((await h.list({ q: '%' })).rows.map((r) => r.sessionId)).toEqual(['gamma_3']);
    expect((await h.list({ q: '   ' })).total).toBe(3);
    expect((await h.list({ project: 'acme/web' })).rows.map((r) => r.sessionId)).toEqual(['beta-2']);
    expect((await h.list({ owner: 'Ed' })).rows.map((r) => r.sessionId)).toEqual(['alpha-1']);
    expect((await h.list({ loop: 'agents' }))).toMatchObject({ total: 1, match: { entries: 1 } });
    expect((await h.list({ loop: 'main' })).match.entries).toBe(4);
    expect((await h.list({ loop: 'all' })).match.entries).toBe(5);
  });

  it('filters the entry window: older than n days, from, to', async () => {
    const { h } = seed();
    expect((await h.list({ olderThanDays: 3.5 }))).toMatchObject({ total: 1, match: { entries: 2 } });
    expect((await h.list({ olderThanDays: 3.5 })).rows[0]).toMatchObject({ sessionId: 'alpha-1', entries: 2 });
    expect((await h.list({ from: T0 - 2 * DAY, to: T0 })).match.entries).toBe(2);
    expect((await h.list({ from: T0 - 2 * DAY, to: T0 - DAY })).match.entries).toBe(1);
  });

  it('deletes ticked sessions, everything a filter matches, or everything', async () => {
    const a = seed();
    expect((await a.h.deleteBy({ ids: ['alpha-1', 'nope'] }))).toMatchObject({ entries: 3, sessions: 1 });
    expect(a.h.totals()).toMatchObject({ entries: 2, sessions: 2 });
    expect((await a.h.deleteBy({ ids: [] }))).toEqual({ entries: 0, sessions: 0, bytes: 0, freed: 0 });

    const b = seed();
    const r = (await b.h.deleteBy({ match: { olderThanDays: 3.5 } }));
    expect(r).toMatchObject({ entries: 2, sessions: 1 }); // alpha-1 lost two entries and keeps one
    expect((await b.h.list({})).rows.find((x) => x.sessionId === 'alpha-1')?.entries).toBe(1);
    expect((await b.h.deleteBy({ match: { loop: 'agents' } }))).toMatchObject({ entries: 1, sessions: 1 });
    expect((await b.h.deleteBy({ match: { q: 'beta' } }))).toMatchObject({ entries: 1, sessions: 1 });

    const c = seed();
    const all = (await c.h.deleteBy({ all: true }));
    expect(all).toMatchObject({ entries: 5, sessions: 3 });
    expect(all.bytes).toBeGreaterThan(0);
    expect(c.h.totals()).toMatchObject({ entries: 0, sessions: 0 });
    expect((await c.h.list({})).total).toBe(0);
  });

  it('rejects, leaving everything stored, when a delete fails', async () => {
    const { h } = seed();
    await expect(h.deleteBy({ ids: [Symbol('x') as unknown as string] })).rejects.toThrow();
    expect(h.totals().entries).toBe(5);
  });

  it('deletes one session’s rows and forgets its loop positions, and removes the rows of sessions the main database lost', async () => {
    const { h } = seed();
    expect((await h.deleteSession('alpha-1'))).toMatchObject({ entries: 3, sessions: 1 });
    expect((await h.dropMissingSessions((id) => id === 'beta-2'))).toBe(1);
    expect((await h.list({})).rows.map((r) => r.sessionId)).toEqual(['beta-2']);
    expect((await h.dropMissingSessions(() => true))).toBe(0);
  });
});

describe('closing during a removal', () => {
  it('ends a purge quietly instead of touching the closed file', async () => {
    const { h, state } = setup({ policy: 'end' });
    state.live.clear();
    for (let b = 0; b < 40; b++) h.ingest(report(Array.from({ length: 20 }, (_, k) => tool(T0 + 100 * b + k, `e${b}-${k}`)), [], 'closing-1'), 0, META);
    const purge = h.purge();
    await new Promise((resolve) => setImmediate(resolve));
    h.close();
    await expect(purge).resolves.toMatchObject({ freed: 0 });
  });
});

describe('compaction', () => {
  it('gives the file’s space back after a large delete', async () => {
    const file = tmpFile();
    const { h, db } = setup({}, file);
    const text = 'y'.repeat(290);
    for (let s = 0; s < 6; s++) h.ingest(report(Array.from({ length: 20 }, (_, k) => tool(T0 + k, `${text}${k}`)), [], `big-${s}`), 0, META);
    for (let s = 0; s < 6; s++) {
      for (let b = 0; b < 40; b++) h.ingest(report(Array.from({ length: 20 }, (_, k) => tool(T0 + 1000 * (b + 1) + k, `${text}${b}-${k}`)), [], `big-${s}`), 0, META);
    }
    expect(h.totals().entries).toBe(6 * 20 * 41);
    const sizeBefore = statSync(file).size;
    const used = h.totals().bytes;
    expect(used).toBeGreaterThan(1_000_000);
    const r = (await h.deleteBy({ all: true }));
    expect(r.freed).toBeGreaterThan(1_000_000);
    expect(h.totals().bytes).toBeLessThan(used / 10);
    expect(statSync(file).size).toBeLessThan(sizeBefore / 2);
    expect((db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count).toBe(0);
    h.close();
  });
});
