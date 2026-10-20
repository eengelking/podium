// Fixes from the pre-PR review of the Activity history (#432): per-loop aggregates for the note, row-bounded counting,
// a failing Podium write, a store closed mid-delete, and the dedupe key across a restart.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openActivityDb } from './activityDb.js';
import { ActivityHistory, type ActivityHistoryOpts, type SessionMeta } from './activityHistory.js';
import { ACTIVITY_HISTORY_DEFAULTS, ACTIVITY_UNIT_MS, type ActivityHistorySettings } from './activityHistoryTypes.js';
import { FleetDb, openDb } from './db.js';
import { DEFAULT_CONFIG, Fleet, type FleetConfig } from './fleet.js';
import { MAIN_LOOP, type ActivityEntry, type Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const T0 = 1_800_000_000_000;
const HOUR = ACTIVITY_UNIT_MS.hours;
const META: SessionMeta = { name: 'invoice-v2', project: 'acme/billing', owner: 'Ed' };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmpFile = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'podium-activity-review-'));
  dirs.push(dir);
  return path.join(dir, 'activity.sqlite');
};

type Db = ReturnType<typeof openActivityDb>;

function setup(over: Partial<ActivityHistorySettings> = {}, extra: Partial<ActivityHistoryOpts> = {}, file = ':memory:', wrap?: (db: Db) => Db) {
  const state = { settings: { ...ACTIVITY_HISTORY_DEFAULTS, policy: 'all' as ActivityHistorySettings['policy'], ...over } };
  const raw = openActivityDb(file);
  const db = wrap ? wrap(raw) : raw;
  const h = new ActivityHistory(db, { now: () => T0, settings: () => state.settings, isLive: () => false, authOn: true, ...extra });
  return { h, db: raw, state };
}

/** A report whose main loop and agent `a1` each carry the given entries. */
function report(id: string, main: ActivityEntry[], agent: ActivityEntry[] = []): Report {
  const r = fixtureReport();
  r.session.id = id;
  r.session.activityFeed = true;
  r.session.activity = main;
  r.agents = [{ ...r.agents[0]!, id: 'a1', activity: agent }];
  return r;
}
const tool = (at: number, text = `Read f${at}`): ActivityEntry => ({ at, kind: 'tool', text });

describe('the note and the page never count a loop', () => {
  it('reads the per-loop aggregates only: no statement touches `entries` by count, min or max', () => {
    const prepared: string[] = [];
    const wrap = (db: Db): Db =>
      new Proxy(db, {
        get(target, prop) {
          if (prop === 'prepare') return (sql: string) => (prepared.push(sql), target.prepare(sql));
          const v = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    const { h } = setup({}, {}, ':memory:', wrap);
    h.ingest(report('s1', [tool(T0), tool(T0 + 5), tool(T0 + 9)]), 0, META);
    prepared.length = 0;
    expect(h.note('s1', MAIN_LOOP)).toEqual({ policy: 'all', total: 3, since: T0, keptUntil: null });
    expect(prepared.filter((q) => /COUNT|MIN\(|MAX\(/i.test(q) && /FROM entries/i.test(q))).toEqual([]);
    expect(prepared.every((q) => /FROM loops/.test(q))).toBe(true);
    expect(h.note('s1', 'nothing')).toBeNull();
  });

  it('keeps the count, the first time and the newest time through ingest, Podium entries, a purge and a delete', async () => {
    const { h, state } = setup({ policy: 'after', n: 1, unit: 'hours' });
    h.ingest(report('s1', [tool(T0 - 5 * HOUR), tool(T0 - 4 * HOUR), tool(T0 - 60_000), tool(T0 - 30_000)]), 0, META);
    h.addPodium('s1', MAIN_LOOP, 'd1', { at: T0 - 10_000, text: 'answered', by: 'Ed', note: null }, META);
    expect(h.note('s1', MAIN_LOOP)).toEqual({ policy: 'after', total: 5, since: T0 - 5 * HOUR, keptUntil: T0 - 10_000 + HOUR });
    // a purge takes the two old ones: the first time moves to the third entry
    await h.purge(T0);
    expect(h.note('s1', MAIN_LOOP)).toMatchObject({ total: 3, since: T0 - 60_000 });
    // the Podium entry is the newest by sequence; removing it moves the newest back to the last reporter entry
    h.removePodium('s1', 'd1');
    expect(h.note('s1', MAIN_LOOP)).toMatchObject({ total: 2, keptUntil: T0 - 30_000 + HOUR });
    // another loop is its own row
    h.ingest(report('s1', [], [tool(T0 - 1000)]), 0, META);
    expect(h.note('s1', 'a1')).toMatchObject({ total: 1, since: T0 - 1000 });
    await h.deleteBy({ match: { loop: 'main' } });
    expect(h.note('s1', MAIN_LOOP)).toBeNull();
    expect(h.note('s1', 'a1')).toMatchObject({ total: 1 });
    await h.deleteSession('s1');
    expect(h.note('s1', 'a1')).toBeNull();
    state.settings = { ...ACTIVITY_HISTORY_DEFAULTS };
    expect(h.note('s1', 'a1')).toBeNull();
  });

  it('page reports the total, since and keptUntil from the same row', () => {
    const { h } = setup({ policy: 'after', n: 2, unit: 'hours' });
    h.ingest(report('s1', Array.from({ length: 30 }, (_, i) => tool(T0 + i))), 0, META);
    const p = h.page('s1', MAIN_LOOP, null, 10);
    expect(p).toMatchObject({ total: 30, since: T0, keptUntil: T0 + 29 + 2 * HOUR, olderBefore: 21 });
    expect(p.entries).toHaveLength(10);
  });
});

describe('counting is bounded by rows, not by time', () => {
  /** The `n` of every count statement countIn ran. */
  function spied(sliceRows: number) {
    const counts: number[] = [];
    const wrap = (db: Db): Db =>
      new Proxy(db, {
        get(target, prop) {
          if (prop === 'prepare') {
            return (sql: string) => {
              const stmt = target.prepare(sql);
              if (!sql.includes('COUNT(*) AS n, MIN(t) AS oldest')) return stmt;
              return new Proxy(stmt, {
                get(s, q) {
                  if (q === 'get') {
                    return (...a: unknown[]) => {
                      const row = (s.get as (...x: unknown[]) => { n: number }).apply(s, a);
                      counts.push(row.n);
                      return row;
                    };
                  }
                  const v = (s as unknown as Record<string | symbol, unknown>)[q];
                  return typeof v === 'function' ? v.bind(s) : v;
                },
              });
            };
          }
          const v = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    return { counts, ...setup({}, { sliceRows }, ':memory:', wrap) };
  }

  /** Most of a session's rows inside one second of a day, the rest spread over the day. */
  function bursty(h: ActivityHistory) {
    for (let i = 0; i < 20; i++) h.ingest(report('s1', Array.from({ length: 20 }, (_, k) => tool(T0 - 24 * HOUR + i * HOUR + k * 7))), 0, META);
    for (let i = 0; i < 10; i++) h.ingest(report('s1', Array.from({ length: 20 }, (_, k) => tool(T0 - 3 * HOUR + i * 20 + k))), 0, META);
  }

  it('never lets one count statement cover more rows than a slice (a burst inside a day is cut by rows)', async () => {
    const { h, counts } = spied(25);
    bursty(h);
    const total = h.totals().entries;
    expect(total).toBe(600);
    const l = await h.list({ olderThanDays: 0 }, 1, 25);
    expect(l.match.entries).toBe(total);
    expect(Math.max(...counts)).toBeLessThanOrEqual(25);
    expect(counts.length).toBeGreaterThanOrEqual(total / 25);
    counts.length = 0;
    const w = await h.list({ loop: 'main', from: T0 - 24 * HOUR, to: T0 + HOUR }, 1, 25);
    expect(w.match.entries).toBe(total);
    expect(Math.max(...counts)).toBeLessThanOrEqual(25);
    counts.length = 0;
    const p = await h.preview({ policy: 'after', n: 1, unit: 'hours', capGb: null });
    expect(p.entries).toBe(total);
    expect(Math.max(...counts)).toBeLessThanOrEqual(25);
  });

  it('counts the same as one big slice, whatever the slice, for windows that cut through the burst', async () => {
    const small = spied(7);
    const big = spied(1_000_000);
    bursty(small.h);
    bursty(big.h);
    const filters = [{ olderThanDays: 0.1 }, { from: T0 - 3 * HOUR + 50, to: T0 - 3 * HOUR + 130 }, { loop: 'agents' as const }, { from: T0 - 24 * HOUR + 3, to: T0 - 24 * HOUR + 50 }];
    for (const f of filters) expect(await small.h.list(f, 1, 25)).toEqual(await big.h.list(f, 1, 25));
  });

  it('counts entries that all share one instant in a single statement, however many, and still advances', async () => {
    const { h, counts } = spied(5);
    h.ingest(report('s1', Array.from({ length: 40 }, (_, k) => tool(T0 - 5000, `same instant ${k}`))), 0, META);
    h.ingest(report('s1', [tool(T0 - 4990), tool(T0 - 4989)]), 0, META);
    const l = await h.list({ olderThanDays: 0 }, 1, 25);
    expect(l.match.entries).toBe(42);
    expect(Math.max(...counts)).toBe(40);
  });
});

describe('a failing history write never reaches the answer path', () => {
  const CFG: FleetConfig = { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' };

  it('logs activity.podium_failed for add, update and remove, and leaves the live feed updated', () => {
    const errors: { event: string; msg: string }[] = [];
    const logger = { info() {}, warn() {}, debug() {}, error: (event: string, msg: string) => errors.push({ event, msg }) } as never;
    let now = T0;
    const fleet = new Fleet(new FleetDb(openDb(':memory:')), CFG, () => now, logger, { authOn: true });
    fleet.activityHistorySettings.set({ policy: 'all' });
    fleet.features.setFeature('respond', true);
    const r = fixtureReport();
    r.session.activityFeed = true;
    r.session.respond = { level: 'everything', accepts: ['message', 'command'], limits: [] };
    r.sentAt = now;
    fleet.ingest(r);
    fleet.activity.watch(r.session.id, MAIN_LOOP, 5);
    const boom = () => {
      throw new Error('disk full');
    };
    vi.spyOn(fleet.activityHistory, 'addPodium').mockImplementation(boom);
    vi.spyOn(fleet.activityHistory, 'updatePodium').mockImplementation(boom);
    vi.spyOn(fleet.activityHistory, 'removePodium').mockImplementation(boom);

    const sent = fleet.respond.message(r.session.id, 'Ed', { text: 'please rerun the tests' });
    if (!sent.ok) throw new Error('message refused');
    expect(fleet.activity.watch(r.session.id, MAIN_LOOP, 5).entries).toEqual([expect.objectContaining({ kind: 'podium', by: 'Ed' })]);
    expect(() => fleet.respond.result(r.session.id, sent.delivery.id, 'queued')).not.toThrow();
    expect(fleet.activity.watch(r.session.id, MAIN_LOOP, 5).entries[0]!.note).not.toBeNull();
    const second = fleet.respond.message(r.session.id, 'Ed', { text: 'and again' });
    if (!second.ok) throw new Error('message refused');
    expect(() => fleet.respond.result(r.session.id, second.delivery.id, 'refused')).not.toThrow();
    expect(fleet.activity.watch(r.session.id, MAIN_LOOP, 5).entries).toHaveLength(1);

    expect(errors.map((e) => e.event)).toEqual(['activity.podium_failed', 'activity.podium_failed', 'activity.podium_failed', 'activity.podium_failed']);
    expect(errors[0]!.msg).toContain('disk full');
    expect(errors.map((e) => /could not (\w+)/.exec(e.msg)![1])).toEqual(['add', 'update', 'add', 'remove']);
  });
});

describe('a store closed during a delete', () => {
  function fill(h: ActivityHistory) {
    for (let i = 0; i < 6; i++) h.ingest(report(`s${i}`, Array.from({ length: 20 }, (_, k) => tool(T0 + k))), 0, META);
  }

  it('answers nothing when it was closed before the delete started', async () => {
    const { h } = setup({}, { chunkRows: 10 });
    fill(h);
    h.close();
    expect(await h.deleteBy({ all: true })).toEqual({ entries: 0, sessions: 0, bytes: 0, freed: 0 });
    expect(await h.deleteBy({ match: { project: 'x' } })).toEqual({ entries: 0, sessions: 0, bytes: 0, freed: 0 });
    expect(await h.deleteBy({ ids: ['s1'] })).toEqual({ entries: 0, sessions: 0, bytes: 0, freed: 0 });
  });

  it('stops at the next chunk and resolves, without touching the closed file, when it is closed in the middle', async () => {
    const { h } = setup({}, { chunkRows: 10 });
    fill(h);
    const p = h.deleteBy({ all: true });
    setImmediate(() => h.close());
    const r = await p;
    expect(r.entries).toBeGreaterThan(0);
    expect(r.entries).toBeLessThan(120);
    expect(r).toMatchObject({ sessions: 0, freed: 0 });
    expect(h.busy).toBe(false);
  });

  it('a delete that finishes before the close still settles and compacts as usual', async () => {
    const { h } = setup({}, { chunkRows: 10 });
    fill(h);
    expect(await h.deleteBy({ all: true })).toMatchObject({ entries: 120, sessions: 6 });
    h.close();
  });
});

describe('the dedupe key follows the stored text', () => {
  it('does not store an over-long entry again after a restart', () => {
    const file = tmpFile();
    const long = tool(T0, 'L'.repeat(400));
    const first = setup({}, {}, file);
    expect(first.h.ingest(report('s1', [long, tool(T0 + 1)]), 0, META)).toBe(2);
    expect(first.h.ingest(report('s1', [long, tool(T0 + 1)]), 0, META)).toBe(0);
    first.h.close();
    const second = setup({}, {}, file);
    expect(second.h.ingest(report('s1', [long, tool(T0 + 1)]), 0, META)).toBe(0);
    expect((second.db.prepare("SELECT length(text) AS n FROM entries WHERE text LIKE 'LLL%'").get() as { n: number }).n).toBe(300);
    second.h.close();
    // the over-long one is the newest entry at its time
    const third = setup({}, {}, file);
    third.h.ingest(report('s2', [long]), 0, META);
    third.h.close();
    const fourth = setup({}, {}, file);
    expect(fourth.h.ingest(report('s2', [long]), 0, META)).toBe(0);
    fourth.h.close();
  });

  it('rebuilds the whole run of entries stored at the newest time after a restart, however long (more than one batch)', () => {
    const file = tmpFile();
    const run = Array.from({ length: 130 }, (_, k) => tool(T0 + 5, `same instant ${k}`));
    const first = setup({}, {}, file);
    first.h.ingest(report('s1', [tool(T0), ...run]), 0, META);
    first.h.close();
    const second = setup({}, {}, file);
    expect(second.h.ingest(report('s1', [tool(T0), ...run, tool(T0 + 5, 'one more')]), 0, META)).toBe(1);
    second.h.close();
  });

  it('after a restart with only Podium entries or no entries in a loop, starts from the stored sequence', () => {
    const file = tmpFile();
    const first = setup({}, {}, file);
    first.h.addPodium('s1', MAIN_LOOP, 'd1', { at: T0, text: 'hi', by: 'Ed', note: null }, META);
    first.h.close();
    const second = setup({}, {}, file);
    expect(second.h.ingest(report('s1', [tool(T0 + 1)]), 0, META)).toBe(1);
    expect(second.h.page('s1', MAIN_LOOP, null, 10).entries.map((e) => e.seq)).toEqual([1, 2]);
    second.h.close();
  });
});
