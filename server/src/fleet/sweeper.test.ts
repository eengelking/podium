import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from './db.js';
import { openSqliteStorage, type SqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet, type FleetConfig } from './fleet.js';
import { forgetReporters, startSweeper } from './sweeper.js';
import { PeopleStore } from './people.js';
import { ReporterStore } from './reporters.js';
import type { Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const CFG: FleetConfig = { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' };
const T0 = 1_791_648_000_000;

interface Msg {
  event: string;
  data: unknown;
}

function collect(fleet: Fleet): Msg[] {
  const msgs: Msg[] = [];
  fleet.hub.add({
    write(chunk: string) {
      for (const block of chunk.split('\n\n')) {
        const m = /^event: (\w+)\ndata: (.*)$/s.exec(block);
        if (m) msgs.push({ event: m[1]!, data: JSON.parse(m[2]!) });
      }
    },
  });
  return msgs;
}

let clock = T0;
let db: SqliteStorage;
beforeEach(() => {
  clock = T0;
  db = openSqliteStorage(':memory:');
});
afterEach(() => {
  vi.useRealTimers();
});

async function makeFleet() {
  const fleet = new Fleet(db, CFG, () => clock);
  await fleet.init();
  return fleet;
}

/** Advances the clock one second at a time, sweeping each second as the timer would. */
async function advance(fleet: Fleet, ms: number) {
  const end = clock + ms;
  while (clock < end) {
    clock = Math.min(end, clock + 1000);
    await fleet.sweep();
  }
  await fleet.flush();
}

describe('lifecycle', () => {
  it('a silent session goes stale at 15 s and is dropped at 75 s with removed:dropped', async () => {
    const fleet = await makeFleet();
    const msgs = collect(fleet);
    const r = fixtureReport();
    await fleet.ingest(r);
    await advance(fleet, 15_000);
    expect((await fleet.view(r.session.id))?.status).toBe('running');
    await advance(fleet, 1000);
    expect((await fleet.view(r.session.id))?.status).toBe('stale');
    expect(msgs.some((m) => m.event === 'session' && (m.data as { status: string }).status === 'stale')).toBe(true);
    await advance(fleet, 58_000);
    expect(fleet.isLive(r.session.id)).toBe(true);
    await advance(fleet, 1000);
    expect(fleet.isLive(r.session.id)).toBe(false);
    expect(msgs.filter((m) => m.event === 'removed')).toEqual([{ event: 'removed', data: { sessionId: r.session.id, reason: 'dropped' } }]);
    expect((await db.fleet.getSession(r.session.id))?.dropped_at).toBe(clock);
    expect(msgs.some((m) => m.event === 'activity' && (m.data as { text: string }).text === 'heartbeat lost')).toBe(true);
  });

  it('a done session lingers 8 s, then removed:done', async () => {
    const fleet = await makeFleet();
    const msgs = collect(fleet);
    const r = fixtureReport();
    await fleet.ingest({ ...r, session: { ...r.session, status: 'done', endReason: 'prompt_input_exit' } });
    await advance(fleet, 7000);
    expect(fleet.isLive(r.session.id)).toBe(true);
    await advance(fleet, 1000);
    expect(fleet.isLive(r.session.id)).toBe(false);
    expect(msgs.filter((m) => m.event === 'removed')).toEqual([{ event: 'removed', data: { sessionId: r.session.id, reason: 'done' } }]);
    expect(await fleet.clearedToday()).toBe(1);
  });

  it('a dropped session that reports again returns to the live set', async () => {
    const fleet = await makeFleet();
    const r = fixtureReport();
    await fleet.ingest(r);
    await advance(fleet, 80_000);
    expect(fleet.isLive(r.session.id)).toBe(false);
    await fleet.ingest({ ...r, events: [] });
    expect(fleet.isLive(r.session.id)).toBe(true);
    expect((await fleet.view(r.session.id))?.status).toBe('running');
    expect((await db.fleet.getSession(r.session.id))?.dropped_at).toBeNull();
  });

  it('a repeated final report does not bring an ended session back', async () => {
    const fleet = await makeFleet();
    const r = fixtureReport();
    const done: Report = { ...r, session: { ...r.session, status: 'done' } };
    await fleet.ingest(done);
    await advance(fleet, 9000);
    await fleet.ingest(done);
    expect(fleet.isLive(r.session.id)).toBe(false);
  });

  it('after a restart, stored sessions are stale until they report, then recover', async () => {
    const first = await makeFleet();
    const r = fixtureReport();
    await first.ingest(r);
    clock += 2000;
    const second = await makeFleet();
    expect(second.liveIds()).toEqual([r.session.id]);
    expect((await second.view(r.session.id))?.status).toBe('stale');
    await second.ingest({ ...r, events: [] });
    expect((await second.view(r.session.id))?.status).toBe('running');
  });

  it('after a restart, an unheard session gets the full drop window from the restart', async () => {
    const first = await makeFleet();
    const r = fixtureReport();
    await first.ingest(r);
    clock += 10 * 60_000; // server was down ten minutes
    const second = await makeFleet();
    await advance(second, 59_000);
    expect(second.isLive(r.session.id)).toBe(true);
    await advance(second, 1000);
    expect(second.isLive(r.session.id)).toBe(false);
  });

  it('writes a carry-forward sample each second for a quiet live session', async () => {
    const fleet = await makeFleet();
    const r = fixtureReport();
    await fleet.ingest(r);
    await advance(fleet, 3000);
    const samples = await db.fleet.samplesSince(r.session.id, 0);
    expect(samples).toHaveLength(4);
    expect(samples.slice(1).every((s) => s.tokens_delta === 0 && s.peak_context === samples[0]!.peak_context)).toBe(true);
  });
});

describe('dropSession (Remove on a heartbeat-lost card)', () => {
  it('takes a stale session off the wall like the automatic drop, and keeps it in History', async () => {
    const fleet = await makeFleet();
    const msgs = collect(fleet);
    const r = fixtureReport();
    await fleet.ingest(r);
    await advance(fleet, 20_000);
    expect((await fleet.view(r.session.id))?.status).toBe('stale');
    expect(await fleet.dropSession(r.session.id)).toBe('dropped');
    expect(fleet.isLive(r.session.id)).toBe(false);
    await fleet.flush();
    expect(msgs.filter((m) => m.event === 'removed')).toEqual([{ event: 'removed', data: { sessionId: r.session.id, reason: 'dropped' } }]);
    expect((await db.fleet.getSession(r.session.id))?.dropped_at).toBe(clock);
    expect((await fleet.history(T0 - 1, clock + 1)).map((h) => h.id)).toContain(r.session.id);
  });

  it('refuses a session that is not stale, and one that is not live', async () => {
    const fleet = await makeFleet();
    const r = fixtureReport();
    await fleet.ingest(r);
    expect(await fleet.dropSession(r.session.id)).toBe('not-stale');
    expect(fleet.isLive(r.session.id)).toBe(true);
    expect(await fleet.dropSession('nope')).toBe('unknown');
  });

  it('a removed session that reports again comes back live', async () => {
    const fleet = await makeFleet();
    const r = fixtureReport();
    await fleet.ingest(r);
    await advance(fleet, 20_000);
    await fleet.dropSession(r.session.id);
    await fleet.ingest({ ...r, events: [] });
    expect(fleet.isLive(r.session.id)).toBe(true);
    expect((await fleet.view(r.session.id))?.status).toBe('running');
    expect((await db.fleet.getSession(r.session.id))?.dropped_at).toBeNull();
  });
});

describe('dropAt (when a heartbeat-lost card goes away on its own)', () => {
  it('is null while the session is not stale', async () => {
    const fleet = await makeFleet();
    const r = fixtureReport();
    await fleet.ingest(r);
    expect((await fleet.view(r.session.id))?.dropAt).toBeNull();
  });

  it('is the last heartbeat plus the stale and drop windows for a session heard since start', async () => {
    const fleet = await makeFleet();
    const r = fixtureReport();
    await fleet.ingest(r);
    await advance(fleet, 20_000);
    expect((await fleet.view(r.session.id))?.dropAt).toBe(T0 + 15_000 + 60_000);
  });

  it('after a restart, an unheard session drops one window after the restart, matching the sweep', async () => {
    const first = await makeFleet();
    const r = fixtureReport();
    await first.ingest(r);
    clock += 10 * 60_000;
    const restartedAt = clock;
    const second = await makeFleet();
    expect((await second.view(r.session.id))?.dropAt).toBe(restartedAt + 60_000);
    await advance(second, 59_000);
    expect(second.isLive(r.session.id)).toBe(true);
    await advance(second, 1000);
    expect(second.isLive(r.session.id)).toBe(false);
  });

  it('uses the hook allowance for a session known only from settings hooks', async () => {
    const fleet = await makeFleet();
    await fleet.ingestHook({ hook_event_name: 'SessionStart', session_id: 'hook-only', cwd: '/Users/dev/x', source: 'startup' });
    await advance(fleet, CFG.hookStaleAfterMs + 1000);
    expect((await fleet.view('hook-only'))?.status).toBe('stale');
    expect((await fleet.view('hook-only'))?.dropAt).toBe(T0 + CFG.hookStaleAfterMs + CFG.dropAfterMs);
  });
});

describe('retention', () => {
  it('deletes samples older than 24 h, events older than 30 d and sessions ended 30 d ago', async () => {
    const fleet = await makeFleet();
    const r = fixtureReport();
    await fleet.ingest(r);
    const day = 24 * 3600_000;
    await db.fleet.upsertSample({ session_id: r.session.id, t: Math.floor((clock - day - 5000) / 1000), tokens_total: 1, tokens_delta: 1, peak_context: 0, running_agents: 0, cost_usd: null });
    await db.fleet.insertEvent({ id: 'old', session_id: r.session.id, agent_id: null, t: clock - 31 * day, kind: 'note', text: 'old', data_json: null });
    const old: Report = { ...r, agents: [r.agents[0]!], events: [], session: { ...r.session, id: 'old-session', status: 'done' } };
    clock -= 31 * day;
    await fleet.ingest(old);
    clock += 31 * day;
    const before = (await db.fleet.samplesSince(r.session.id, 0)).length;
    const res = await fleet.retain();
    expect(res.samples).toBeGreaterThanOrEqual(1);
    expect((await db.fleet.samplesSince(r.session.id, 0)).length).toBe(before - 1);
    expect(res.events).toBe(1);
    expect(res.sessions).toBe(1);
    expect(await db.fleet.getSession('old-session')).toBeUndefined();
    expect(await db.fleet.getAgents('old-session')).toEqual([]);
    expect(await db.fleet.getSession(r.session.id)).toBeDefined();
  });
});

describe('startSweeper', () => {
  it('runs sweep every second and tick every 2 s, and survives a throwing sweep', async () => {
    vi.useFakeTimers();
    const fleet = await makeFleet();
    const sweep = vi.spyOn(fleet, 'sweep').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const tick = vi.spyOn(fleet, 'tick');
    const logs: string[] = [];
    const stop = startSweeper(fleet, { sweepMs: 1000, tickMs: 2000, retentionMs: 3600_000 }, (l) => logs.push(l));
    vi.advanceTimersByTime(4000);
    expect(sweep).toHaveBeenCalledTimes(4);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(logs).toEqual(['podium sweeper: sweep failed: boom']);
    stop();
    vi.advanceTimersByTime(4000);
    expect(sweep).toHaveBeenCalledTimes(4);
  });
});

describe('forgetting reporters by age (issue #167)', () => {
  it('runs the retention hook at start and every hour, and a throwing hook does not stop retention', async () => {
    vi.useFakeTimers();
    const fleet = await makeFleet();
    const retain = vi.spyOn(fleet, 'retain');
    const hook = vi.fn().mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const logs: string[] = [];
    const stop = startSweeper(fleet, { sweepMs: 1000, tickMs: 2000, retentionMs: 3600_000 }, (l) => logs.push(l), hook);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(retain).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3600_000);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(retain).toHaveBeenCalledTimes(2);
    expect(logs.filter((l) => l.includes('boom'))).toHaveLength(1);
    stop();
  });

  it('still forgets reporters when the fleet retention step throws', async () => {
    vi.useFakeTimers();
    const fleet = await makeFleet();
    vi.spyOn(fleet, 'retain').mockImplementation(() => {
      throw new Error('disk');
    });
    const hook = vi.fn();
    const stop = startSweeper(fleet, { sweepMs: 1000, tickMs: 2000, retentionMs: 3600_000 }, () => {}, hook);
    expect(hook).toHaveBeenCalledTimes(1);
    stop();
  });

  it('removes stale reporters when the setting is on, and logs what it removed to the Admin log', async () => {
    const raw = openDb(':memory:');
    const reporters = new ReporterStore(raw, T0);
    const people = new PeopleStore(raw);
    const seen = (id: string) => ({ kind: 'mod' as const, machineId: id, machineName: id, source: '1.1.1.1', owner: null, credential: null, version: '0.13.0', engineVersion: null, sessionId: id });
    reporters.record(seen('old'), T0 - 40 * 86_400_000);
    reporters.record(seen('new'), T0 - 86_400_000);
    const lines: string[] = [];
    const logger = { info: (_e: string, m: string) => lines.push(m) } as never;
    const LATER = T0 + 2 * 3_600_000;
    forgetReporters(reporters, people, logger, LATER);
    expect(reporters.list({}, T0).total).toBe(2); // off by default
    reporters.setForgetSetting({ enabled: true, days: 30 });
    forgetReporters(reporters, people, logger, LATER);
    expect(reporters.list({}, T0).rows.map((r) => r.key)).toEqual(['new']);
    expect(people.listLog({ page: 1, pageSize: 10 }).rows[0]).toMatchObject({ kind: 'reporters_forgotten', source: 'sweeper' });
    expect(people.listLog({ page: 1, pageSize: 10 }).rows[0]!.detail).toContain('1 reporter');
    expect(lines).toHaveLength(1);
    forgetReporters(reporters, people, logger, LATER);
    expect(people.listLog({ page: 1, pageSize: 10 }).total).toBe(1); // nothing removed, nothing logged
  });
});

describe('per-session bookkeeping', () => {
  it('forgets a session\'s clock skew when it leaves the live set or is deleted', async () => {
    const fleet = await makeFleet();
    const skew = () => (fleet as unknown as { clockSkew: Map<string, number> }).clockSkew;
    const a = fixtureReport();
    const b = { ...fixtureReport(), session: { ...fixtureReport().session, id: 'second-session' } };
    await fleet.ingest(a);
    await fleet.ingest(b);
    expect(skew().size).toBe(2);
    await advance(fleet, 75_000); // both go stale, then dropped
    expect(fleet.isLive(a.session.id)).toBe(false);
    expect(skew().size).toBe(0);
    await fleet.ingest(a);
    expect(skew().size).toBe(1);
    await fleet.deleteSession(a.session.id);
    expect(skew().size).toBe(0);
  });
});
