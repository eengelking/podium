// The Activity history as the Fleet wires it (#432): what the report reply asks for, what is captured, what removes it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetDb, openDb } from './db.js';
import { DEFAULT_CONFIG, Fleet, type FleetConfig } from './fleet.js';
import { PeopleStore } from './people.js';
import { MAIN_LOOP, type ActivityEntry, type Report } from './protocol.js';
import { ACTIVITY_LOG_KINDS } from './activityHistoryTypes.js';
import { purgeActivityHistory, startSweeper } from './sweeper.js';
import { fixtureReport } from './testing.js';
import { silentLogger } from '../logging/logger.js';

const CFG: FleetConfig = { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' };
const T0 = 1_791_648_000_000; // the fixture's sentAt, so the clock skew is zero
const DAY = 86_400_000;

let clock = T0;
let db: FleetDb;
beforeEach(() => {
  clock = T0;
  db = new FleetDb(openDb(':memory:'));
});
afterEach(() => {
  vi.useRealTimers();
});

const makeFleet = (authOn = true) => new Fleet(db, CFG, () => clock, undefined, { authOn });
const tool = (at: number, text = `Read f${at}`): ActivityEntry => ({ at, kind: 'tool', text });

/** The fixture with the reporter's activityFeed option on, a main-loop snapshot and one on the first agent. */
function report(main: ActivityEntry[], agent: ActivityEntry[] = [], feed = true): Report {
  const r = fixtureReport();
  r.session.activityFeed = feed;
  r.session.activity = main;
  r.agents[0]!.activity = agent;
  r.sentAt = clock;
  return r;
}

const runningAgents = (r: Report) => r.agents.filter((a) => a.status === 'running').map((a) => a.id);

describe('a failing history file', () => {
  it('is logged and does not refuse the report', async () => {
    const logger = { ...silentLogger, error: vi.fn() };
    const fleet = new Fleet(db, CFG, () => clock, logger, { authOn: true });
    fleet.activityHistorySettings.set({ policy: 'all' });
    vi.spyOn(fleet.activityHistory, 'ingest').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => fleet.ingest(report([tool(T0)]))).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('activity.ingest_failed', expect.stringContaining('disk full'), expect.anything());
  });
});

describe('what the report reply asks the mod to send', () => {
  it('is exactly the leases under the default policy, with or without the option on', async () => {
    const fleet = makeFleet();
    const r = report([]);
    fleet.ingest(r);
    expect(fleet.activity.watched(r.session.id)).toEqual([]);
    fleet.activity.watch(r.session.id, 'a2', 5);
    expect(fleet.activity.watched(r.session.id)).toEqual(['a2']);
  });

  it('adds the orchestrator and every running agent under a keep policy, for a reporter with the option on', async () => {
    const fleet = makeFleet();
    const r = report([]);
    expect(runningAgents(r).length).toBeGreaterThan(0);
    expect(fleet.activityHistorySettings.set({ policy: 'all' })).toMatchObject({ ok: true });
    fleet.ingest(r);
    expect(fleet.activity.watched(r.session.id)).toEqual([MAIN_LOOP, ...runningAgents(r)]);
    // a lease on an agent already listed is not listed twice, and one on another loop is kept
    fleet.activity.watch(r.session.id, runningAgents(r)[0]!, 5);
    fleet.activity.watch(r.session.id, 'finished-agent', 5);
    expect(fleet.activity.watched(r.session.id)).toEqual([runningAgents(r)[0], 'finished-agent', MAIN_LOOP, ...runningAgents(r).slice(1)]);
  });

  it('adds nothing for a reporter with the option off or one that has not said', async () => {
    const fleet = makeFleet();
    fleet.activityHistorySettings.set({ policy: 'all' });
    const off = report([], [], false);
    fleet.ingest(off);
    expect(fleet.activity.watched(off.session.id)).toEqual([]);
    expect(fleet.activity.watched('unheard')).toEqual([]);
  });

  it('lists nothing while the activity-feed flag is off', async () => {
    const fleet = makeFleet();
    fleet.activityHistorySettings.set({ policy: 'all' });
    const r = report([]);
    fleet.ingest(r);
    fleet.features.setFeature('activity-feed', false);
    expect(fleet.activity.watched(r.session.id)).toEqual([]);
  });

  it('lists nothing for a keep policy saved before the token was removed', async () => {
    makeFleet().activityHistorySettings.set({ policy: 'all' });
    const fleet = makeFleet(false);
    const r = report([]);
    fleet.ingest(r);
    expect(fleet.activity.watched(r.session.id)).toEqual([]);
  });
});

describe('capture through the fleet', () => {
  it('stores every loop of a report with no lease, and the live window still needs one', async () => {
    const fleet = makeFleet();
    fleet.activityHistorySettings.set({ policy: 'all' });
    const r = report([tool(T0 + 1), tool(T0 + 2)], [tool(T0 + 3)]);
    fleet.ingest(r);
    fleet.ingest(report([tool(T0 + 1), tool(T0 + 2), tool(T0 + 4)], [tool(T0 + 3)]));
    expect(fleet.activityHistory.page(r.session.id, MAIN_LOOP, null, 20).entries.map((e) => e.at)).toEqual([T0 + 1, T0 + 2, T0 + 4]);
    expect(fleet.activityHistory.page(r.session.id, r.agents[0]!.id, null, 20).entries).toHaveLength(1);
    expect(fleet.activity.watch(r.session.id, MAIN_LOOP, 5).entries).toEqual([]);
    const stored = (await fleet.activityHistory.list({})).rows[0]!;
    expect(stored).toMatchObject({ sessionId: r.session.id, name: db.getSession(r.session.id)!.name, project: db.getSession(r.session.id)!.repo_name });
  });

  it('keeps the live window as it was: entries come only after a lease, the last 20', async () => {
    const fleet = makeFleet();
    fleet.activityHistorySettings.set({ policy: 'all' });
    const r = report([]);
    fleet.ingest(r);
    fleet.activity.watch(r.session.id, MAIN_LOOP, 5);
    clock += 1000;
    fleet.ingest(report(Array.from({ length: 25 }, (_, i) => tool(clock + i))));
    const live = fleet.activity.watch(r.session.id, MAIN_LOOP, 5).entries;
    expect(live.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 6 + i));
    expect(fleet.activityHistory.page(r.session.id, MAIN_LOOP, null, 100).entries).toHaveLength(25);
  });

  it('stores nothing under the default policy, even for a watched loop', async () => {
    const fleet = makeFleet();
    const r = report([]);
    fleet.ingest(r);
    fleet.activity.watch(r.session.id, MAIN_LOOP, 5);
    clock += 1000;
    fleet.ingest(report([tool(clock + 1)]));
    expect(fleet.activity.watch(r.session.id, MAIN_LOOP, 5).entries).toHaveLength(1);
    expect(fleet.activityHistory.totals().entries).toBe(0);
  });

  it('stores nothing while the flag is off, and starts again when it is back on', async () => {
    const fleet = makeFleet();
    fleet.activityHistorySettings.set({ policy: 'all' });
    fleet.features.setFeature('activity-feed', false);
    fleet.ingest(report([tool(T0 + 1)]));
    expect(fleet.activityHistory.totals().entries).toBe(0);
    fleet.features.setFeature('activity-feed', true);
    fleet.ingest(report([tool(T0 + 1)]));
    expect(fleet.activityHistory.totals().entries).toBe(1);
  });

  it('stores nothing without a token', async () => {
    makeFleet().activityHistorySettings.set({ policy: 'all' });
    const fleet = makeFleet(false);
    fleet.ingest(report([tool(T0 + 1)]));
    expect(fleet.activityHistory.totals().entries).toBe(0);
  });

  it('stores what is sent from Podium with its sender, updates its note and removes it when the session never took it', async () => {
    const fleet = makeFleet();
    fleet.activityHistorySettings.set({ policy: 'all' });
    fleet.features.setFeature('respond', true);
    const r = report([]);
    r.session.respond = { level: 'everything', accepts: ['message', 'command'], limits: [] };
    fleet.ingest(r);
    const sent = fleet.respond.message(r.session.id, 'Ed', { text: 'please rerun the tests' });
    if (!sent.ok) throw new Error('message refused');
    const stored = () => fleet.activityHistory.page(r.session.id, MAIN_LOOP, null, 20).entries;
    expect(stored()).toEqual([expect.objectContaining({ kind: 'podium', by: 'Ed', note: null })]);
    expect(fleet.respond.result(r.session.id, sent.delivery.id, 'queued')).toBe('new');
    expect(stored()[0]!.note).toEqual(expect.any(String));
    expect(stored()[0]!.note).not.toBeNull();

    const second = fleet.respond.message(r.session.id, 'Ed', { text: 'and again' });
    if (!second.ok) throw new Error('message refused');
    expect(stored()).toHaveLength(2);
    fleet.respond.result(r.session.id, second.delivery.id, 'refused');
    expect(stored()).toHaveLength(1);
  });

  it('skips a Podium entry for a session the main database does not hold', async () => {
    const fleet = makeFleet();
    fleet.activityHistorySettings.set({ policy: 'all' });
    fleet.respond.noteReport(report([]), true);
    expect(() => fleet.respond.message('ghost', 'Ed', { text: 'hi' })).not.toThrow();
    expect(fleet.activityHistory.totals().entries).toBe(0);
  });
});

describe('removal through the fleet', () => {
  it('deleting a session deletes its stored rows', async () => {
    const fleet = makeFleet();
    fleet.activityHistorySettings.set({ policy: 'all' });
    const a = report([tool(T0 + 1)]);
    const b = { ...report([tool(T0 + 2)]), session: { ...report([tool(T0 + 2)]).session, id: 'second-session' } };
    fleet.ingest(a);
    fleet.ingest(b);
    expect(fleet.activityHistory.totals().sessions).toBe(2);
    fleet.deleteSession(a.session.id);
    await fleet.activityHistory.idle();
    expect((await fleet.activityHistory.list({})).rows.map((r) => r.sessionId)).toEqual(['second-session']);
  });

  it('keeps the rows when a session only leaves the wall, and picks up where it left off if it reports again', async () => {
    const fleet = makeFleet();
    fleet.activityHistorySettings.set({ policy: 'all' });
    const r = report([tool(T0 + 1)]);
    fleet.ingest(r);
    clock += 75_000;
    fleet.sweep();
    expect(fleet.isLive(r.session.id)).toBe(false);
    expect(fleet.activityHistory.totals().entries).toBe(1);
    fleet.ingest(report([tool(T0 + 1), tool(T0 + 2)]));
    expect(fleet.activityHistory.page(r.session.id, MAIN_LOOP, null, 20).entries.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('the session retention removes the rows too, whatever the policy', async () => {
    const fleet = makeFleet();
    fleet.activityHistorySettings.set({ policy: 'all' });
    const old = report([tool(T0 - 31 * DAY)]);
    old.session.id = 'old-session';
    old.session.status = 'done';
    clock -= 31 * DAY;
    old.sentAt = clock;
    fleet.ingest(old);
    clock += 31 * DAY;
    fleet.ingest(report([tool(T0 + 1)]));
    expect(fleet.activityHistory.totals().sessions).toBe(2);
    fleet.retain();
    await fleet.activityHistory.idle();
    expect((await fleet.activityHistory.list({})).rows.map((r) => r.sessionId)).not.toContain('old-session');
    expect(fleet.activityHistory.totals().sessions).toBe(1);
  });

  it('a failing cleanup is logged and does not stop the rest of retention', async () => {
    const errors: string[] = [];
    const fleet = new Fleet(db, CFG, () => clock, { info() {}, warn() {}, debug() {}, error: (_e: string, m: string) => errors.push(m) } as never, { authOn: true });
    vi.spyOn(fleet.activityHistory, 'dropMissingSessions').mockRejectedValue(new Error('disk full'));
    expect(() => fleet.retain()).not.toThrow();
    await fleet.activityHistory.idle();
    await new Promise((r) => setImmediate(r));
    expect(errors.join('\n')).toContain('disk full');
  });
});

describe('the purge in the sweeper', () => {
  const ADMIN_LOG = (people: PeopleStore) => people.listLog({ page: 1, pageSize: 50 }).rows.filter((r) => r.kind === ACTIVITY_LOG_KINDS.purged);
  const lines: string[] = [];
  const logger = { info: (_e: string, m: string) => lines.push(m) } as never;

  it('writes one Admin log row for a run that removed something and none for one that removed nothing', async () => {
    const fleet = makeFleet();
    const people = new PeopleStore(db.db);
    fleet.activityHistorySettings.set({ policy: 'after', n: 1, unit: 'days' });
    await purgeActivityHistory(fleet.activityHistory, people, logger, clock);
    expect(ADMIN_LOG(people)).toEqual([]);

    const r = report([tool(T0 - 3 * DAY), tool(T0 - 2 * DAY), tool(T0)]);
    fleet.ingest(r);
    await purgeActivityHistory(fleet.activityHistory, people, logger, clock);
    const rows = ADMIN_LOG(people);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'sweeper' });
    expect(rows[0]!.detail).toMatch(/^2 entries \(\d+ B\) removed under purge after 1 day$/);
    expect(lines).toHaveLength(1);

    await purgeActivityHistory(fleet.activityHistory, people, logger, clock);
    expect(ADMIN_LOG(people)).toHaveLength(1);
  });

  it('writes the size in the unit that fits', async () => {
    const fleet = makeFleet();
    const people = new PeopleStore(db.db);
    fleet.activityHistorySettings.set({ policy: 'end' });
    const spy = vi.spyOn(fleet.activityHistory, 'purge');
    for (const [bytes, text] of [[2048, '2.0 KB'], [3 * 1024 ** 2, '3.0 MB'], [2 * 1024 ** 3, '2.0 GB']] as const) {
      spy.mockResolvedValueOnce({ entries: 5, bytes, sessions: 1, freed: 0 });
      await purgeActivityHistory(fleet.activityHistory, people, logger, clock);
      expect(ADMIN_LOG(people)[0]!.detail).toContain(`(${text})`);
    }
  });

  it('runs on its own interval and at start through the hook, and a failing hook is logged and survived', async () => {
    vi.useFakeTimers();
    const fleet = makeFleet();
    const hook = vi.fn();
    const logs: string[] = [];
    const stop = startSweeper(fleet, { sweepMs: 1000, tickMs: 2000, retentionMs: 3600_000, activityPurgeMs: 5000 }, (l) => logs.push(l), undefined, hook);
    expect(hook).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(hook).toHaveBeenCalledTimes(3);
    hook.mockImplementationOnce(() => {
      throw new Error('locked');
    });
    vi.advanceTimersByTime(5000);
    expect(logs).toEqual(['podium sweeper: activity-purge failed: locked']);
    vi.advanceTimersByTime(5000);
    expect(hook).toHaveBeenCalledTimes(5);
    stop();
  });

  it('uses five minutes when the interval is not given', async () => {
    vi.useFakeTimers();
    const fleet = makeFleet();
    const hook = vi.fn();
    const stop = startSweeper(fleet, undefined, () => {}, undefined, hook);
    vi.advanceTimersByTime(299_000);
    expect(hook).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(hook).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('the console state', () => {
  it('carries a derived activity-history entry that is true only with a keep policy, a token and the feed flag', async () => {
    const fleet = makeFleet();
    expect(fleet.state().features['activity-history']).toBe(false);
    fleet.activityHistorySettings.set({ policy: 'all' });
    expect(fleet.state().features['activity-history']).toBe(true);
    fleet.features.setFeature('activity-feed', false);
    expect(fleet.state().features['activity-history']).toBe(false);
    expect(makeFleet(false).state().features['activity-history']).toBe(false);
  });

  it('keeps it out of the Admin flags: the flag view, FEATURES and the stored rows', async () => {
    const { FEATURES } = await import('./featureFlags.js');
    const fleet = makeFleet();
    fleet.activityHistorySettings.set({ policy: 'all' });
    fleet.features.setFeature('activity-feed', true);
    expect(fleet.features.view()).not.toHaveProperty('activity-history');
    expect(FEATURES.map((f) => f.id)).not.toContain('activity-history');
    const rows = db.db.prepare("SELECT key FROM settings WHERE key LIKE 'feature%'").all() as { key: string }[];
    expect(rows.some((r) => r.key.includes('activity-history'))).toBe(false);
  });

  it('broadcasts a fresh snapshot when told the setting changed', async () => {
    const fleet = makeFleet();
    const spy = vi.spyOn(fleet.hub, 'broadcast');
    fleet.activityHistoryChanged();
    expect(spy).toHaveBeenCalledWith('snapshot', expect.objectContaining({ features: expect.objectContaining({ 'activity-history': false }) }));
  });
});
