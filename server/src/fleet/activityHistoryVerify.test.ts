// What the live verification of the Activity history found on the server side (#432): what `sessions` counts, one size measure
// in every box, and the words of the Admin log.
import { describe, expect, it, vi } from 'vitest';
import { openActivityDb } from './activityDb.js';
import { ActivityHistory, type ActivityHistoryOpts, type SessionMeta } from './activityHistory.js';
import { ACTIVITY_HISTORY_DEFAULTS, ACTIVITY_LOG_KINDS, ACTIVITY_UNIT_MS, type ActivityHistorySettings } from './activityHistoryTypes.js';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import type { PeopleStoreApi } from '../storage/types.js';
import { type ActivityEntry, type Report } from './protocol.js';
import { purgeActivityHistory } from './sweeper.js';
import { fixtureReport } from './testing.js';

const T0 = 1_800_000_000_000;
const HOUR = ACTIVITY_UNIT_MS.hours;
const META: SessionMeta = { name: 'invoice-v2', project: 'acme/billing', owner: 'Ed' };

function setup(over: Partial<ActivityHistorySettings> = {}, extra: Partial<ActivityHistoryOpts> = {}) {
  const state = { settings: { ...ACTIVITY_HISTORY_DEFAULTS, policy: 'all' as ActivityHistorySettings['policy'], ...over }, live: new Set<string>() };
  const h = new ActivityHistory(openActivityDb(':memory:'), { now: () => T0, settings: () => state.settings, isLive: (id) => state.live.has(id), authOn: true, ...extra });
  return { h, state };
}

/** Twenty sessions with twenty entries each, one every two hours, the oldest 38 hours ago. */
function fill(h: ActivityHistory, sessions = 20) {
  for (let i = 0; i < sessions; i++) {
    const r: Report = fixtureReport();
    r.session.id = `s${i}`;
    r.session.activityFeed = true;
    r.session.activity = Array.from({ length: 20 }, (_, k): ActivityEntry => ({ at: T0 - (19 - k) * 2 * HOUR, kind: 'tool', text: `Read file number ${k}` }));
    r.agents = [];
    h.ingest(r, 0, { ...META, project: i % 2 ? 'acme/web' : 'acme/billing', owner: i % 4 ? 'Ed' : 'Sam' });
  }
}

describe('sessions are the sessions that lose at least one entry', () => {
  it('a purge that takes the old half of every session counts every session, though none was removed entirely', async () => {
    const { h } = setup({ policy: 'after', n: 24, unit: 'hours' });
    fill(h);
    const p = await h.preview({ policy: 'after', n: 24, unit: 'hours', capGb: null });
    expect(p).toMatchObject({ entries: 140, sessions: 20 });
    const r = await h.purge(T0);
    expect(r).toMatchObject({ entries: 140, sessions: 20 });
    expect(h.totals()).toMatchObject({ entries: 260, sessions: 20 });
  });

  it('a period that reaches only some sessions counts those', async () => {
    const { h } = setup({ policy: 'after', n: 30, unit: 'hours' });
    fill(h, 4);
    const late: Report = fixtureReport();
    late.session.id = 'late';
    late.session.activity = [{ at: T0 - HOUR, kind: 'tool', text: 'Read a' }];
    late.agents = [];
    h.ingest(late, 0, META);
    const p = await h.preview({ policy: 'after', n: 30, unit: 'hours', capGb: null });
    expect(p.sessions).toBe(4);
    expect((await h.purge(T0)).sessions).toBe(4);
  });

  it('under `end` it counts the sessions that are not live; a delete counts the sessions it took entries from', async () => {
    const { h, state } = setup({ policy: 'end' });
    fill(h, 6);
    state.live.add('s1');
    expect(await h.preview({ policy: 'end', n: 1, unit: 'hours', capGb: null })).toMatchObject({ entries: 100, sessions: 5 });
    expect(await h.purge(T0)).toMatchObject({ entries: 100, sessions: 5 });
    expect(await h.deleteBy({ ids: ['s1', 'nope'] })).toMatchObject({ entries: 20, sessions: 1 });
    expect(await h.deleteBy({ ids: ['s1'] })).toMatchObject({ entries: 0, sessions: 0 });
  });

  it('a filter that takes part of every matching session counts them all; deleting one session and everything count too', async () => {
    const { h } = setup({ policy: 'all' });
    fill(h, 8);
    expect(await h.deleteBy({ match: { olderThanDays: 1 } })).toMatchObject({ entries: 8 * 7, sessions: 8 });
    expect(h.totals().sessions).toBe(8);
    expect(await h.deleteBy({ match: { owner: 'Sam' } })).toMatchObject({ sessions: 2 });
    expect(await h.deleteSession('s1')).toMatchObject({ sessions: 1 });
    expect(await h.deleteSession('s1')).toMatchObject({ entries: 0, sessions: 0 });
    expect(await h.deleteBy({ all: true })).toMatchObject({ sessions: 5 });
  });

  it('under the size cap it counts the sessions the oldest entries come from (an estimate in the preview)', async () => {
    const { h, state } = setup({ policy: 'all', capGb: 1 }, { capBytesPerGb: 4000 });
    fill(h, 6);
    const p = await h.preview({ policy: 'all', n: 1, unit: 'hours', capGb: 1 });
    expect(p.entries).toBeGreaterThan(0);
    expect(p.sessions).toBeGreaterThan(0);
    expect(p.sessions).toBeLessThanOrEqual(6);
    const r = await h.purge(T0);
    expect(r.sessions).toBeGreaterThan(0);
    expect(r.sessions).toBeLessThanOrEqual(6);
    expect(state.settings.capGb).toBe(1);
  });

  it('the preview of the default policy is what is stored now: its sessions are the sessions with anything stored', async () => {
    const { h } = setup({ policy: 'all' });
    fill(h, 5);
    expect(await h.preview(ACTIVITY_HISTORY_DEFAULTS)).toMatchObject({ entries: 100, sessions: 5, stopsCapturing: true });
  });

  it('stays the count of touched sessions when the store is closed during the removal', async () => {
    const { h } = setup({}, { chunkRows: 10 });
    fill(h, 6);
    const p = h.deleteBy({ all: true });
    setImmediate(() => h.close());
    const r = await p;
    expect(r.entries).toBeGreaterThan(0);
    expect(r.sessions).toBeGreaterThan(0);
  });
});

describe('one size measure in every box', () => {
  it('totals, a preview, a list and the purge or delete that follows agree to within the estimate', async () => {
    const { h, state } = setup({ policy: 'all' });
    fill(h, 10);
    const t0 = h.totals();
    expect(t0.bytes).toBeGreaterThan(0);
    expect(t0.fileBytes).toBeGreaterThan(0);
    // the default policy previews what is stored, in the same measure
    expect((await h.preview(ACTIVITY_HISTORY_DEFAULTS)).bytes).toBe(t0.bytes);
    // list rows and the match add up to the totals, exactly, when no filter cuts entries
    const all = await h.list({}, 1, 50);
    expect(all.rows.reduce((a, r) => a + r.bytes, 0)).toBe(t0.bytes);
    expect(all.match.bytes).toBe(t0.bytes);
    expect(all.totals.bytes).toBe(t0.bytes);

    // a period: preview, then purge. The estimate is within a tenth; the totals drop by exactly what the purge says.
    const next: ActivityHistorySettings = { policy: 'after', n: 24, unit: 'hours', capGb: null };
    const p = await h.preview(next);
    state.settings = next;
    const r = await h.purge(T0);
    expect(Math.abs(p.bytes - r.bytes)).toBeLessThanOrEqual(r.bytes * 0.1);
    const t1 = h.totals();
    expect(t0.bytes - t1.bytes).toBe(r.bytes);

    // a filter that cuts entries: the list's match is an estimate of the delete that follows
    const match = (await h.list({ loop: 'main', olderThanDays: 1 / 24 })).match;
    const del = await h.deleteBy({ match: { loop: 'main', olderThanDays: 1 / 24 } });
    expect(match.entries).toBe(del.entries);
    expect(Math.abs(match.bytes - del.bytes)).toBeLessThanOrEqual(del.bytes * 0.1);
    expect(t1.bytes - h.totals().bytes).toBe(del.bytes);
  });
});

describe('the Admin log words for the purge', () => {
  const logger = { info: vi.fn() } as never;
  const rows = async (people: PeopleStoreApi) => (await people.listLog({ page: 1, pageSize: 20 })).rows.filter((r) => r.kind === ACTIVITY_LOG_KINDS.purged);

  async function purgeWith(settings: ActivityHistorySettings, result: { entries: number; bytes: number; sessions: number }) {
    const people = openSqliteStorage(':memory:').people;
    const history = { purge: vi.fn().mockResolvedValue({ ...result, freed: 0 }), current: () => settings } as unknown as ActivityHistory;
    await purgeActivityHistory(history, people, logger, T0);
    return await rows(people);
  }

  it.each([
    [{ policy: 'after', n: 1, unit: 'hours', capGb: null }, 'purge after 1 hour'],
    [{ policy: 'after', n: 2, unit: 'hours', capGb: null }, 'purge after 2 hours'],
    [{ policy: 'end', n: 30, unit: 'days', capGb: null }, 'purge when the session ends'],
    [{ policy: 'all', n: 30, unit: 'days', capGb: 5 }, 'keep everything, no automatic purge, size cap 5 GB'],
    [{ policy: 'all', n: 30, unit: 'days', capGb: null }, 'keep everything, no automatic purge'],
  ] as const)('reads %j as "%s", with grouped digits and a size', async (settings, words) => {
    const out = await purgeWith({ ...settings }, { entries: 1_300_000, bytes: 3 * 1024 ** 3, sessions: 20 });
    expect(out).toHaveLength(1);
    expect(out[0]!.detail).toBe(`1,300,000 entries (3.0 GB) removed under ${words}`);
    expect(out[0]!.source).toBe('sweeper');
  });

  it('says one entry in the singular and writes counts only', async () => {
    const out = await purgeWith({ policy: 'after', n: 1, unit: 'days', capGb: null }, { entries: 1, bytes: 600, sessions: 1 });
    expect(out[0]!.detail).toBe('1 entry (600 B) removed under purge after 1 day');
  });
});
