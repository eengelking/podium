import { beforeEach, describe, it, expect } from 'vitest';
import { ACTIVITY_LEASE_SLACK_MS, ActivityStore, everyOf } from './activity.js';
import { LIMITS, MAIN_LOOP, type ActivityEntry, type Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const T0 = 1_800_000_000_000;

function setup() {
  let t = T0;
  const store = new ActivityStore(() => t);
  return { store, advance: (ms: number) => (t += ms), now: () => t };
}

const tool = (at: number, text = `Read f${at}`): ActivityEntry => ({ at, kind: 'tool', text });

/** The fixture with a feed on the session's first agent and on the orchestrator. */
function report(agent: ActivityEntry[], main: ActivityEntry[] = [], feed = true): Report {
  const r = fixtureReport();
  r.session.activityFeed = feed;
  if (main.length) r.session.activity = main;
  r.agents[0]!.activity = agent;
  return r;
}

describe('ActivityStore', () => {
  it('keeps nothing for a loop nobody watches', () => {
    const { store } = setup();
    const r = report([tool(T0 + 1)]);
    store.ingest(r, 0);
    expect(store.watched(r.session.id)).toEqual([]);
    expect(store.watch(r.session.id, r.agents[0]!.id, 5).entries).toEqual([]);
  });

  it('a watch lists the loop in the reply and keeps what arrives from then on, in order, numbered', () => {
    const { store, advance } = setup();
    const r = report([]);
    const sid = r.session.id;
    const aid = r.agents[0]!.id;
    expect(store.watch(sid, aid, 5)).toMatchObject({ entries: [], since: T0 });
    expect(store.watched(sid)).toEqual([aid]);
    advance(1000);
    store.ingest(report([tool(T0 + 500), tool(T0 + 900)]), 0);
    // the next report repeats the snapshot and adds one: only the new one is added
    store.ingest(report([tool(T0 + 500), tool(T0 + 900), tool(T0 + 1000)]), 0);
    const got = store.watch(sid, aid, 5).entries;
    expect(got.map((e) => [e.seq, e.at])).toEqual([
      [1, T0 + 500],
      [2, T0 + 900],
      [3, T0 + 1000],
    ]);
  });

  it('never backfills: an entry from before the watch began is not kept', () => {
    const { store } = setup();
    const r = report([]);
    store.watch(r.session.id, r.agents[0]!.id, 5);
    store.ingest(report([tool(T0 - 5000), tool(T0 + 10)]), 0);
    expect(store.watch(r.session.id, r.agents[0]!.id, 5).entries.map((e) => e.at)).toEqual([T0 + 10]);
  });

  it('reads the reporter clock through the skew, so a reporter ahead of the server is not cut off', () => {
    const { store } = setup();
    const r = report([]);
    store.watch(r.session.id, r.agents[0]!.id, 5);
    // the reporter's clock is 3 s ahead: its T0 + 3010 is the server's T0 + 10
    store.ingest(report([tool(T0 + 3010)]), 3000);
    expect(store.watch(r.session.id, r.agents[0]!.id, 5).entries).toHaveLength(1);
    store.ingest(report([tool(T0 + 3010), tool(T0 + 2000)]), 3000);
    expect(store.watch(r.session.id, r.agents[0]!.id, 5).entries).toHaveLength(1);
  });

  it('keeps the last 20 per loop', () => {
    const { store } = setup();
    const r = report([]);
    store.watch(r.session.id, r.agents[0]!.id, 5);
    for (let i = 1; i <= 25; i++) store.ingest(report([tool(T0 + i)]), 0);
    const got = store.watch(r.session.id, r.agents[0]!.id, 5).entries;
    expect(got).toHaveLength(20);
    expect(got[0]!.at).toBe(T0 + 6);
    expect(got.at(-1)!.seq).toBe(25);
  });

  it('keeps the orchestrator under MAIN_LOOP, apart from its agents', () => {
    const { store } = setup();
    const r = report([]);
    store.watch(r.session.id, MAIN_LOOP, 5);
    store.ingest(report([tool(T0 + 1, 'Read agent')], [tool(T0 + 2, 'Agent Map call sites')]), 0);
    expect(store.watched(r.session.id)).toEqual([MAIN_LOOP]);
    expect(store.watch(r.session.id, MAIN_LOOP, 5).entries.map((e) => e.text)).toEqual(['Agent Map call sites']);
  });

  it('drops a loop when its lease lapses, and a later watch starts empty', () => {
    const { store, advance } = setup();
    const r = report([]);
    const sid = r.session.id;
    const aid = r.agents[0]!.id;
    store.watch(sid, aid, 5);
    store.ingest(report([tool(T0 + 1)]), 0);
    advance(5000 + ACTIVITY_LEASE_SLACK_MS - 1);
    expect(store.watched(sid)).toEqual([aid]);
    advance(2);
    store.expire();
    expect(store.watched(sid)).toEqual([]);
    expect(store.size).toBe(0);
    expect(store.watch(sid, aid, 5).entries).toEqual([]);
  });

  it('each fetch renews the lease for its own interval', () => {
    const { store, advance } = setup();
    const r = report([]);
    const sid = r.session.id;
    const aid = r.agents[0]!.id;
    store.watch(sid, aid, 60);
    advance(60_000);
    expect(store.watched(sid)).toEqual([aid]);
    store.watch(sid, aid, 60);
    advance(60_000);
    expect(store.watched(sid)).toEqual([aid]);
    advance(ACTIVITY_LEASE_SLACK_MS + 1);
    expect(store.watched(sid)).toEqual([]);
  });

  it('a second viewer on a shorter interval does not cut the first one short', () => {
    const { store, advance } = setup();
    const r = report([]);
    store.watch(r.session.id, r.agents[0]!.id, 60);
    store.watch(r.session.id, r.agents[0]!.id, 5);
    advance(30_000);
    expect(store.watched(r.session.id)).toHaveLength(1);
  });

  it('drops everything about a session that leaves or is deleted', () => {
    const { store } = setup();
    const r = report([]);
    store.watch(r.session.id, r.agents[0]!.id, 5);
    store.watch(r.session.id, MAIN_LOOP, 5);
    store.ingest(report([tool(T0 + 1)]), 0);
    store.dropSession(r.session.id);
    expect(store.size).toBe(0);
    expect(store.feedOn(r.session.id)).toBeNull();
  });

  it('clear() drops every lease and every entry, in every session (the Admin turned the feed off)', () => {
    const { store } = setup();
    const r = report([]);
    store.watch(r.session.id, r.agents[0]!.id, 60);
    store.watch(r.session.id, MAIN_LOOP, 60);
    store.watch('another-session', MAIN_LOOP, 60);
    store.ingest(report([tool(T0 + 1)]), 0);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.watched(r.session.id)).toEqual([]);
    expect(store.watch(r.session.id, r.agents[0]!.id, 5).entries).toEqual([]);
  });

  it('while the feature is off it lists nothing as watched and takes no entry, and resumes when it is back on', () => {
    let t = T0;
    let on = true;
    const store = new ActivityStore(() => t, () => on);
    const r = report([]);
    const aid = r.agents[0]!.id;
    store.watch(r.session.id, aid, 60);
    expect(store.on).toBe(true);
    on = false;
    expect(store.on).toBe(false);
    expect(store.watched(r.session.id)).toEqual([]);
    store.ingest(report([tool(T0 + 1)], [], true), 0);
    on = true;
    // the lease taken before is still there in this test (clear() is the fleet's job), but nothing came in while off
    expect(store.watch(r.session.id, aid, 5).entries).toEqual([]);
    // the reporter's option is still remembered while off
    expect(store.feedOn(r.session.id)).toBe(true);
    t += 10;
    store.ingest(report([tool(T0 + 5)]), 0);
    expect(store.watch(r.session.id, aid, 5).entries.map((e) => e.at)).toEqual([T0 + 5]);
  });

  it('remembers whether the reporter has the option on; null until a reporter says', () => {
    const { store } = setup();
    const r = report([], [], false);
    expect(store.feedOn(r.session.id)).toBeNull();
    store.ingest(r, 0);
    expect(store.feedOn(r.session.id)).toBe(false);
    store.ingest(report([], [], true), 0);
    expect(store.feedOn(r.session.id)).toBe(true);
  });
});

describe('everyOf', () => {
  it('takes the five intervals the panel offers and falls back to 5 s for anything else', () => {
    expect([5, 10, 20, 30, 60].map((n) => everyOf(String(n)))).toEqual([5, 10, 20, 30, 60]);
    expect(everyOf(undefined)).toBe(5);
    expect(everyOf('7')).toBe(5);
    expect(everyOf('3600')).toBe(5);
    expect(everyOf(['5', '60'])).toBe(5);
  });
});

describe('ActivityStore with the Activity history (#432)', () => {
  const withLoops = (loops: string[]) => new ActivityStore(() => T0, () => true, () => loops);

  it('lists the history’s loops only for a reporter with the option on, after the leased ones, once each', () => {
    const store = withLoops(['@orchestrator', 'a1']);
    const r = report([]);
    const sid = r.session.id;
    expect(store.watched(sid)).toEqual([]);
    store.ingest(r, 0);
    expect(store.watched(sid)).toEqual(['@orchestrator', 'a1']);
    store.watch(sid, 'a1', 5);
    store.watch(sid, 'a9', 5);
    expect(store.watched(sid)).toEqual(['a1', 'a9', '@orchestrator']);
    store.ingest(report([], [], false), 0);
    expect(store.watched(sid)).toEqual(['a1', 'a9']);
  });

  it('without a history it behaves as before: the leases and nothing else', () => {
    const store = new ActivityStore(() => T0);
    const r = report([]);
    store.ingest(r, 0);
    expect(store.watched(r.session.id)).toEqual([]);
    store.watch(r.session.id, 'a1', 5);
    expect(store.watched(r.session.id)).toEqual(['a1']);
  });

  it('lists nothing while the feature is off, whatever the history asks for', () => {
    const store = new ActivityStore(() => T0, () => false, () => ['a1']);
    const r = report([]);
    store.ingest(r, 0);
    expect(store.watched(r.session.id)).toEqual([]);
  });
});

describe('ActivityStore with a Bash command and its output (#431)', () => {
  const SECRET = 'sk-live-OUTPUT-SECRET-9f3a';
  let outputOn = true;
  let t = T0;
  const make = (historyLoops: string[] = []) => new ActivityStore(() => t, () => true, () => historyLoops, () => outputOn);
  const bash = (at: number, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({ at, kind: 'tool', text: 'Bash npm test', id: 'c1', command: 'npm test', ...extra });
  const rep = (agent: ActivityEntry[], opt: boolean | 'absent' = true): Report => {
    const r = report(agent);
    if (opt === 'absent') delete r.session.activityOutput;
    else r.session.activityOutput = opt;
    return r;
  };
  const sid = report([]).session.id;
  const aid = report([]).agents[0]!.id;
  const got = (s: ActivityStore) => s.watch(sid, aid, 5).entries;
  beforeEach(() => {
    outputOn = true;
    t = T0;
  });

  it('keeps the command and attaches output that arrives later to the entry it belongs to', () => {
    const s = make();
    s.watch(sid, aid, 5);
    t += 100;
    s.ingest(rep([bash(T0 + 10)]), 0);
    expect(got(s)).toEqual([{ seq: 1, at: T0 + 10, kind: 'tool', text: 'Bash npm test', id: 'c1', command: 'npm test' }]);
    s.ingest(rep([bash(T0 + 10, { output: 'ok\n', done: true, exitCode: 0 })]), 0);
    expect(got(s)).toEqual([{ seq: 1, at: T0 + 10, kind: 'tool', text: 'Bash npm test', id: 'c1', command: 'npm test', output: 'ok\n', done: true, exitCode: 0 }]);
    s.ingest(rep([bash(T0 + 10, { output: 'bad', outputCut: true, done: true, failed: true, exitCode: 1 })]), 0);
    expect(got(s)).toHaveLength(1);
    expect(got(s)[0]).toMatchObject({ output: 'bad', outputCut: true, failed: true, exitCode: 1 });
  });

  it('an update does not move the entry or hide a newer one', () => {
    const s = make();
    s.watch(sid, aid, 5);
    s.ingest(rep([bash(T0 + 10, { id: 'c1' })]), 0);
    s.ingest(rep([bash(T0 + 10, { id: 'c1', output: 'a', done: true }), bash(T0 + 20, { id: 'c2', text: 'Bash ls' })]), 0);
    expect(got(s).map((e) => [e.seq, e.id, e.output])).toEqual([
      [1, 'c1', 'a'],
      [2, 'c2', undefined],
    ]);
  });

  it('an entry without an id behaves exactly as before (an older mod)', () => {
    const s = make();
    s.watch(sid, aid, 5);
    s.ingest(rep([tool(T0 + 1), tool(T0 + 1)], 'absent'), 0);
    s.ingest(rep([tool(T0 + 1)], 'absent'), 0);
    expect(got(s)).toEqual([{ seq: 1, at: T0 + 1, kind: 'tool', text: `Read f${T0 + 1}` }]);
  });

  it('discards output while the Admin flag is off or the reporter option is not on, and keeps the command and how the call ended (#598)', () => {
    const s = make();
    s.watch(sid, aid, 5);
    outputOn = false;
    s.ingest(rep([bash(T0 + 1, { output: SECRET, done: true, exitCode: 0, failed: false })]), 0);
    expect(got(s)[0]).toEqual({ seq: 1, at: T0 + 1, kind: 'tool', text: 'Bash npm test', id: 'c1', command: 'npm test', done: true, exitCode: 0 });
    outputOn = true;
    for (const opt of [false, 'absent'] as const) {
      const s2 = make();
      s2.watch(sid, aid, 5);
      s2.ingest(rep([bash(T0 + 1, { output: SECRET, done: true })], opt), 0);
      expect(JSON.stringify(got(s2))).not.toContain(SECRET);
    }
  });

  it('serves no output while the flag is off, even for output held before, and does not bring it back when the flag returns', () => {
    const s = make();
    s.watch(sid, aid, 5);
    s.ingest(rep([bash(T0 + 1, { output: SECRET, done: true })]), 0);
    outputOn = false;
    expect(JSON.stringify(got(s))).not.toContain(SECRET);
    s.dropOutput();
    outputOn = true;
    expect(JSON.stringify(got(s))).not.toContain(SECRET);
  });

  it('forgets a session output when its reporter says the option is off', () => {
    const s = make();
    s.watch(sid, aid, 5);
    s.ingest(rep([bash(T0 + 1, { output: SECRET, done: true })]), 0);
    s.ingest(rep([bash(T0 + 1)], false), 0);
    expect(got(s)[0]).toMatchObject({ command: 'npm test' });
    expect(JSON.stringify(got(s))).not.toContain(SECRET);
  });

  it('watchedOutput lists only the loops under a live lease, never a loop the history lists, and nothing while a flag is off', () => {
    const s = make([MAIN_LOOP, aid]);
    s.ingest(rep([], true), 0);
    expect(s.watched(sid).sort()).toEqual([MAIN_LOOP, aid].sort());
    expect(s.watchedOutput(sid)).toEqual([]);
    s.watch(sid, aid, 5);
    expect(s.watchedOutput(sid)).toEqual([aid]);
    expect(s.watched(sid)).toContain(aid);
    outputOn = false;
    expect(s.watchedOutput(sid)).toEqual([]);
    outputOn = true;
    t += 5000 + ACTIVITY_LEASE_SLACK_MS + 1;
    expect(s.watchedOutput(sid)).toEqual([]);
  });

  it('with the activity-feed flag off nothing is listed for output', () => {
    let feedOn = true;
    const s = new ActivityStore(() => t, () => feedOn, () => [], () => outputOn);
    s.watch(sid, aid, 5);
    feedOn = false;
    expect(s.watchedOutput(sid)).toEqual([]);
  });

  it('output is gone after the lease lapses, the session leaves, the flag goes off and in a new store', () => {
    const s = make();
    s.watch(sid, aid, 5);
    s.ingest(rep([bash(T0 + 1, { output: SECRET, done: true })]), 0);
    t += 5000 + ACTIVITY_LEASE_SLACK_MS + 1;
    s.expire();
    expect(s.watch(sid, aid, 5).entries).toEqual([]);

    const s2 = make();
    s2.watch(sid, aid, 5);
    s2.ingest(rep([bash(T0 + 1_000_000, { output: SECRET })]), 0);
    s2.dropSession(sid);
    expect(s2.watch(sid, aid, 5).entries).toEqual([]);

    const s3 = make();
    s3.watch(sid, aid, 5);
    s3.ingest(rep([bash(T0 + 1_000_000, { output: SECRET })]), 0);
    s3.clear();
    expect(s3.watch(sid, aid, 5).entries).toEqual([]);

    expect(make().watch(sid, aid, 5).entries).toEqual([]);
  });

  it('bounds what it holds: a command or output over the protocol limit is cut, over the 20-entry window the oldest go', () => {
    const s = make();
    s.watch(sid, aid, 5);
    s.ingest(rep([bash(T0 + 1, { command: 'c'.repeat(30_000), output: 'o'.repeat(30_000), done: true })]), 0);
    expect(got(s)[0]!.command).toHaveLength(LIMITS.activityDetail);
    expect(got(s)[0]!.output).toHaveLength(LIMITS.activityDetail);
    for (let i = 0; i < 25; i++) s.ingest(rep([bash(T0 + 10 + i, { id: `n${i}`, text: `Bash ${i}`, output: 'x', done: true })]), 0);
    expect(got(s)).toHaveLength(LIMITS.activityEntries);
  });

  it('does not match a call id across entries of another kind, and takes no command on a non-tool entry', () => {
    const s = make();
    s.watch(sid, aid, 5);
    s.ingest(rep([{ at: T0 + 1, kind: 'text', text: 'hello', id: 'c1', command: 'ls', output: SECRET }]), 0);
    expect(got(s)[0]).toEqual({ seq: 1, at: T0 + 1, kind: 'text', text: 'hello', id: 'c1' });
    s.ingest(rep([bash(T0 + 2, { output: 'x', done: true })]), 0);
    expect(got(s).map((e) => [e.kind, e.output])).toEqual([['text', undefined], ['tool', 'x']]);
  });
});
