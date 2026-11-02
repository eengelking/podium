// Contract cases for the Activity store (#890): the Activity history, session recordings, the two settings stores that belong to
// them, and the transaction the main store offers. Each runs one scenario over the adapter and over the reference
// (`sameOnBoth`).
import { it, expect } from 'vitest';
import { sameOnBoth, type Openers } from './contractSame.js';
import { ACTIVITY_HISTORY_DEFAULTS } from '../fleet/activityHistoryTypes.js';
import { MAIN_LOOP, RECORDING_DEFAULTS, type ActivityEntry, type RecordingBatch, type Report } from '../fleet/protocol.js';
import { fixtureReport } from '../fleet/testing.js';
import type { ActivityStorage, Storage } from './types.js';

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const META = (name: string, owner: string | null = 'ed') => ({ name, project: owner === null ? null : 'acme/billing', owner });
const batch = (n: number, loop: string = MAIN_LOOP): RecordingBatch => ({ v: 1, sentAt: T0, entries: [{ loop, seq: n, at: T0 + n, kind: 'tool', text: `text ${n}` }] });
const tool = (at: number, text = `Read f${at}`): ActivityEntry => ({ at, kind: 'tool', text });
const report = (id: string, entries: ActivityEntry[]): Report => {
  const r = fixtureReport();
  r.session.activityFeed = true;
  r.session.id = id;
  r.session.activity = entries;
  r.agents[0]!.activity = [];
  return r;
};

/** The Activity store over `s`, with a clock the scenario moves and a set of sessions it says are live. */
function activityOf(s: Storage, memory: { now: number; live: Set<string>; policy?: 'all' | 'default' }, loops: string[] = [MAIN_LOOP]): ActivityStorage {
  return s.activity({
    history: {
      now: () => memory.now, settings: () => ({ ...ACTIVITY_HISTORY_DEFAULTS, policy: memory.policy ?? 'all' }), isLive: (id) => memory.live.has(id), agentsOf: async () => [], authOn: true,
    },
    recordings: {
      now: () => memory.now, settings: () => ({ ...RECORDING_DEFAULTS }), flagOn: () => true, authOn: true, isLive: (id) => memory.live.has(id),
      loopsOf: async () => loops.map((loop) => ({ loop, name: loop === MAIN_LOOP ? 'Orchestrator' : loop })),
    },
  });
}

export function activityCases(o: Openers): void {
  it('matches the reference for the Activity history: ingesting, Podium entries, paging, notes, totals and the list', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      const memory = { now: T0, live: new Set(['s1']) };
      const h = activityOf(s, memory).history;
      await rec('enabled', h.enabled());
      await rec('current', h.current());
      await rec('stored', h.ingest(report('s1', [tool(T0 + 1), tool(T0 + 2), tool(T0 + 3)]), 0, META('one')));
      await rec('stored again (nothing new)', h.ingest(report('s1', [tool(T0 + 1), tool(T0 + 2), tool(T0 + 3)]), 0, META('one')));
      await rec('stored (more)', h.ingest(report('s1', [tool(T0 + 3), tool(T0 + 4)]), 0, META('one')));
      await h.ingest(report('s2', [tool(T0 + 5)]), 0, META('two', 'ann'));
      await rec('loops to watch', h.loopsToWatch('s1'));
      await rec('add podium', h.addPodium('s1', MAIN_LOOP, 'ref-1', { at: T0 + 6, text: 'from podium', by: 'ed', note: 'queued' }, META('one')));
      await rec('update podium', h.updatePodium('s1', 'ref-1', 'taken'));
      await rec('add podium 2', h.addPodium('s1', MAIN_LOOP, 'ref-2', { at: T0 + 7, text: 'never taken', by: 'ed', note: null }, META('one')));
      await rec('remove podium', h.removePodium('s1', 'ref-2'));
      await rec('page (newest)', h.page('s1', MAIN_LOOP, null));
      await rec('page (small)', h.page('s1', MAIN_LOOP, null, 2));
      const small = (await h.page('s1', MAIN_LOOP, null, 2)).olderBefore;
      await rec('page (older)', h.page('s1', MAIN_LOOP, small, 2));
      await rec('page (unknown session)', h.page('nope', MAIN_LOOP, null));
      await rec('note', h.note('s1', MAIN_LOOP));
      await rec('note (nothing)', h.note('nope', MAIN_LOOP));
      await rec('totals', h.totals());
      await rec('list', h.list({}, 1, 10));
      await rec('list (query)', h.list({ q: 'TWO' }, 1, 10));
      await rec('list (owner)', h.list({ owner: 'ann' }, 1, 10));
      await rec('list (small pages)', h.list({}, 2, 1));
      await rec('list (loop filter)', h.list({ loop: 'agents' }, 1, 10));
      await rec('busy', h.busy);
      await rec('last purge', h.lastPurge);
    });
    expect(t.get('stored')).toBeGreaterThan(0);
    expect(t.get('stored again (nothing new)')).toBe(0);
  });

  it('matches the reference for the Activity history purge, preview, deletes, dropping missing sessions and forgetting one', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      const memory = { now: T0, live: new Set<string>() };
      const h = activityOf(s, memory).history;
      for (const [id, at, owner] of [['old', T0 - 40 * DAY, 'ed'], ['mid', T0 - 10 * DAY, 'ann'], ['new', T0 - 1000, 'ed'], ['gone', T0 - 2000, null]] as const) {
        await h.ingest(report(id, [tool(at), tool(at + 1)]), 0, META(`n-${id}`, owner));
      }
      await rec('totals', h.totals());
      await rec('purge (all policy keeps everything)', h.purge(T0));
      await rec('preview (30 days)', h.preview({ policy: 'age', n: 30, unit: 'days', capGb: null } as never));
      await rec('preview (a day)', h.preview({ policy: 'age', n: 1, unit: 'days', capGb: null } as never));
      await rec('preview (default)', h.preview({ ...ACTIVITY_HISTORY_DEFAULTS }));
      await rec('drop missing', h.dropMissingSessions(async (id) => id !== 'gone'));
      await rec('list after drop', h.list({}, 1, 10));
      h.forgetSession('mid');
      await rec('delete one session', h.deleteSession('mid'));
      await rec('delete it again', h.deleteSession('mid'));
      await rec('delete by ids', h.deleteBy({ ids: ['old', 'nope'] }));
      await rec('delete by filter (nothing matches)', h.deleteBy({ match: { q: 'zzz' } }));
      await rec('delete by filter', h.deleteBy({ match: { owner: 'ed' } }));
      await rec('delete all', h.deleteBy({ all: true }, async () => true));
      await h.idle();
      await rec('totals (empty)', h.totals());
      await rec('list (empty)', h.list({}, 1, 10));
    });
    expect((t.get('delete it again') as { entries: number }).entries).toBe(0);
  });

  it('matches the reference for the Activity history settings with and without a sign-in token, and for a transaction', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      for (const authOn of [true, false]) {
        const a = s.activityHistorySettings(authOn);
        await rec(`get (auth ${authOn})`, a.get());
        await rec(`set unknown (auth ${authOn})`, a.set({ nope: 1 }));
        await rec(`set bad policy (auth ${authOn})`, a.set({ policy: 'forever-and-ever' }));
        await rec(`set age (auth ${authOn})`, a.set({ policy: 'age', n: 7, unit: 'days' }));
        await rec(`get after (auth ${authOn})`, a.get());
      }
      const rs = s.recordingSettings;
      await rec('recording settings (fresh)', rs.get());
      await rec('recording settings: refused', rs.set({ keepHours: 0 }));
      await rec('recording settings: all-or-nothing', rs.set({ keepHours: 12, budgetMb: -1 }));
      await rec('recording settings (unchanged)', rs.get());
      await rec('recording settings: set', rs.set({ keepHours: 12 }));
      await rec('recording settings (after)', rs.get());
      await rec('tx commits', s.tx(async () => { await s.people.log('in-tx', 'kept', 'src', T0); return 'done'; }));
      await rec('log after commit', s.people.listLog({}));
      await rec('tx rolls back', s.tx(async () => { await s.people.log('rolled-back', 'lost', 'src', T0); throw new Error('stop'); }));
      await rec('log after rollback', s.people.listLog({}));
    });
    expect((t.get('log after rollback') as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('matches the reference for starting, stopping and carrying over a recording, and for what a session may send', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      const memory = { now: T0, live: new Set(['r1', 'r2', 'r3']) };
      const r = activityOf(s, memory, [MAIN_LOOP, 'agent-1']).recordings;
      await rec('enabled', r.enabled());
      await rec('has (none)', r.has('r1'));
      await rec('grant (none)', r.grant('r1'));
      await rec('view (none)', r.view('r1'));
      await rec('state (none)', r.stateFor('r1'));
      await rec('capturing (no)', r.capturing('r1'));
      await rec('accepts until (no)', r.acceptsUntil('r1'));
      await rec('kept until (none)', r.keptUntilOf('r1'));
      await rec('option (unset)', r.optionOn('r1'));
      r.noteOption('r1', true);
      await rec('option (on)', r.optionOn('r1'));
      await rec('choose: unknown loop', r.choose('r1', ['nope'], 'ed', META('one'), [MAIN_LOOP]));
      await rec('choose', r.choose('r1', [MAIN_LOOP], 'ed', META('one'), [MAIN_LOOP, 'agent-1']));
      await rec('grant', r.grant('r1'));
      await rec('capturing', r.capturing('r1'));
      await rec('accepts until', r.acceptsUntil('r1'));
      await rec('state', r.stateFor('r1'));
      await rec('view', r.view('r1'));
      await rec('loop info', r.loopInfo('r1'));
      await rec('accept', r.accept('r1', batch(1), META('one')));
      await rec('accept again (nothing new)', r.accept('r1', batch(1), META('one')));
      await rec('accept (other loop, not chosen)', r.accept('r1', batch(2, 'agent-1'), META('one')));
      await rec('accept (never started)', r.accept('r2', batch(1), META('two')));
      await rec('total bytes', r.totalBytes());
      await rec('totals', r.totals());
      await rec('stop', r.stop('r1', 'ed'));
      await rec('stop again', r.stop('r1', 'ed'));
      await rec('stop (none)', r.stop('nope', 'ed'));
      await rec('state (stopped)', r.stateFor('r1'));
      await rec('start', r.start('r3', [MAIN_LOOP], 'ed', META('three')));
      await rec('carry over', r.carryOver('r3', 'r3-new', META('three')));
      await rec('carry over (not recorded)', r.carryOver('r1', 'r1-new', META('one')));
      await rec('state (new id)', r.stateFor('r3-new'));
      await rec('stop all', r.stopAll('Admin'));
      await rec('stop all again', r.stopAll('Admin'));
    });
    expect(t.get('stop (none)')).toBeNull();
    expect(t.get('capturing (no)')).toBe(false);
  });

  it('matches the reference for replaying, listing, deleting, purging and dropping recordings', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      const memory = { now: T0, live: new Set(['a1', 'B1', 'c1']) };
      const r = activityOf(s, memory).recordings;
      for (const [id, owner] of [['a1', 'Ed'], ['B1', 'ann'], ['c1', null], ['d1', 'ed']] as const) {
        r.noteOption(id, true);
        await r.start(id, [MAIN_LOOP], 'Ed', META(`name ${id}`, owner));
        for (const n of [1, 2, 3]) await r.ingest(id, batch(n), META(`name ${id}`, owner));
      }
      await rec('page (newest)', r.page('a1', null, 2, null));
      const older = (await r.page('a1', null, 2, null)).olderBefore;
      await rec('page (older)', r.page('a1', older, 2, MAIN_LOOP));
      await rec('page (unknown loop)', r.page('a1', null, 5, 'nope'));
      await rec('admin list', r.adminList({ page: 1, pageSize: 10 }));
      await rec('admin list (page 2)', r.adminList({ page: 2, pageSize: 2 }));
      await rec('admin list (query)', r.adminList({ page: 1, pageSize: 10, q: 'ANN' }));
      await rec('admin list (state)', r.adminList({ page: 1, pageSize: 10, state: 'recording' }));
      await rec('list stored', r.listStored({}, 1, 10));
      await rec('list stored (owner)', r.listStored({ owner: 'ann' }, 1, 10));
      await rec('ids for ids', r.idsFor({ ids: ['a1', 'nope'] }));
      await rec('ids for filter', r.idsFor({ match: { owner: 'ed' } }));
      await rec('ids for all', r.idsFor({ all: true }));
      await r.notePodiumPrompt('a1', MAIN_LOOP, { at: T0 + 9, text: 'p', by: 'ed' }, 'ref-1');
      r.forgetPodiumPrompt('a1', 'ref-1');
      r.forgetSession('c1');
      await rec('purge (nothing old)', r.purge(T0));
      await rec('purge (a day on)', r.purge(T0 + DAY));
      await rec('stored after purge', r.listStored({}, 1, 10));
      await rec('remove many', r.removeMany(['a1', 'nope']));
      await rec('remove for filter', r.removeFor({ match: { owner: 'ann' } }));
      await rec('drop missing', r.dropMissingSessions(async (id) => id === 'c1'));
      await rec('remove session', r.removeSession('c1'));
      await rec('remove session again', r.removeSession('c1'));
      await rec('remove for all', r.removeFor({ all: true }));
      await rec('totals (empty)', r.totals());
    });
    expect(t.has('admin list')).toBe(true);
  });
}
