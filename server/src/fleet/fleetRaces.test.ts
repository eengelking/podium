// What the async storage must not break (#313): the Fleet's read-then-write sequences were atomic only because every store call was
// synchronous. These run the sequences against each other over a real in-memory SQLite storage, with the interleavings that a
// straight `await` port of the synchronous code lets through.
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_CONFIG, Fleet, type FleetConfig } from './fleet.js';
import { OwnerConflict } from './ingest.js';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { Serializer } from './serial.js';
import type { Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const CFG: FleetConfig = { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' };
const T0 = 1_791_648_000_000;

interface Msg {
  event: string;
  data: unknown;
}
interface LogLine {
  event: string;
  fields: Record<string, unknown>;
}

async function setup() {
  const clock = { t: T0 };
  const storage = openSqliteStorage(':memory:', 0);
  const lines: LogLine[] = [];
  const line = (event: string, _text: string, fields: Record<string, unknown> = {}) => void lines.push({ event, fields });
  const logger = { debug: line, info: line, warn: line, error: line } as never;
  const fleet = new Fleet(storage, CFG, () => clock.t, logger);
  await fleet.init();
  const msgs: Msg[] = [];
  fleet.hub.add({
    write(chunk: string) {
      for (const block of chunk.split('\n\n')) {
        const m = /^event: (\w+)\ndata: (.*)$/s.exec(block);
        if (m) msgs.push({ event: m[1]!, data: JSON.parse(m[2]!) });
      }
    },
  });
  return { clock, storage, fleet, msgs, lines };
}

/** The shared fixture's report, as session `id`, with `over` laid on its session. */
function report(id: string, over: Partial<Report['session']> = {}): Report {
  const r = fixtureReport();
  return { ...r, session: { ...r.session, id, ...over }, events: r.events.map((e) => ({ ...e, id: `${id}:${e.id}` })) };
}

describe('Serializer', () => {
  it('runs one key at a time, keys beside each other, and an exclusive job alone between the jobs before and after it', async () => {
    const s = new Serializer();
    const log: string[] = [];
    const gate = (() => {
      let open!: () => void;
      const wait = new Promise<void>((r) => (open = r));
      return { wait, open };
    })();
    const a1 = s.run('a', async () => {
      log.push('a1 start');
      await gate.wait;
      log.push('a1 end');
    });
    const b1 = s.run('b', async () => void log.push('b1'));
    const a2 = s.run('a', async () => void log.push('a2'));
    const all = s.exclusive(async () => void log.push('exclusive'));
    const b2 = s.run('b', async () => void log.push('b2'));
    await b1;
    expect(log).toEqual(['a1 start', 'b1']);
    gate.open();
    await Promise.all([a1, a2, all, b2]);
    expect(log).toEqual(['a1 start', 'b1', 'a1 end', 'a2', 'exclusive', 'b2']);
  });

  it('keeps going after a job fails', async () => {
    const s = new Serializer();
    await expect(s.run('a', () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    await expect(s.exclusive(() => Promise.reject(new Error('no again')))).rejects.toThrow('no again');
    await expect(s.run('a', async () => 'fine')).resolves.toBe('fine');
  });
});

describe('two reports for one session', () => {
  it('from the same owner create it once and leave one consistent live session', async () => {
    const { fleet, msgs, lines } = await setup();
    const a = report('s1', { status: 'running' });
    const b = report('s1', { status: 'waiting', waitReason: 'input' });
    const [ra, rb] = await Promise.all([fleet.ingest(a, 'ed'), fleet.ingest(b, 'ed')]);
    expect([ra.created, rb.created].filter(Boolean)).toHaveLength(1);
    expect(lines.filter((l) => l.event === 'session.started')).toHaveLength(1);
    expect(fleet.liveIds()).toEqual(['s1']);
    // The later report is the stored one, whole.
    expect((await fleet.db.getSession('s1'))?.status).toBe('waiting');
    expect((await fleet.db.getSession('s1'))?.owner).toBe('ed');
    // Each report's events reached the wall once.
    const ids = msgs.filter((m) => m.event === 'activity').map((m) => (m.data as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('from two owners: exactly one is refused, and the stored owner is the one that got in', async () => {
    const { fleet } = await setup();
    const out = await Promise.allSettled([fleet.ingest(report('s1'), 'ed'), fleet.ingest(report('s1'), 'amy')]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const refused = out.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(OwnerConflict);
    expect((await fleet.db.getSession('s1'))?.owner).toBe('ed');
    expect(fleet.liveIds()).toEqual(['s1']);
  });
});

describe('a report and a sweep', () => {
  it('never drop a session that is reporting: a sweep that finds it silent and a report that arrives meanwhile end with it live', async () => {
    const { fleet, clock } = await setup();
    await fleet.ingest(report('s1', { status: 'running' }), 'ed');
    clock.t = T0 + 80_000; // silent past stale (15 s) and the drop (75 s)
    const sweep = fleet.sweep();
    const fresh = fleet.ingest(report('s1', { status: 'running' }), 'ed');
    await Promise.all([sweep, fresh]);
    const row = await fleet.db.getSession('s1');
    expect(row?.dropped_at).toBeNull();
    expect(row?.last_seen_at).toBe(T0 + 80_000);
    expect(fleet.isLive('s1')).toBe(true);
    expect((await fleet.view('s1'))?.status).toBe('running');
  });

  it('wait for a report already being stored: a sweep asked for after it sees the fresh session', async () => {
    const { fleet, clock } = await setup();
    await fleet.ingest(report('s1', { status: 'running' }), 'ed');
    clock.t = T0 + 80_000;
    const fresh = fleet.ingest(report('s1', { status: 'running' }), 'ed');
    const sweep = fleet.sweep();
    await Promise.all([fresh, sweep]);
    expect((await fleet.db.getSession('s1'))?.dropped_at).toBeNull();
    expect(fleet.isLive('s1')).toBe(true);
  });
});

describe('a delete and a report', () => {
  it('leave nothing behind when the delete is asked for after the report: no row, and no live session in memory', async () => {
    const { fleet, msgs } = await setup();
    const stored = fleet.ingest(report('s1', { status: 'running' }), 'ed');
    const deleted = fleet.deleteSession('s1');
    await Promise.all([stored, deleted]);
    expect(await deleted).toBe(true);
    expect(await fleet.db.getSession('s1')).toBeUndefined();
    expect(fleet.isLive('s1')).toBe(false);
    expect(msgs.filter((m) => m.event === 'removed')).toEqual([{ event: 'removed', data: { sessionId: 's1', reason: 'deleted' } }]);
  });

  it('let a report that arrives after a delete store the session again, as before', async () => {
    const { fleet } = await setup();
    await fleet.ingest(report('s1', { status: 'running' }), 'ed');
    const deleted = fleet.deleteSession('s1');
    const again = fleet.ingest(report('s1', { status: 'running' }), 'ed');
    await Promise.all([deleted, again]);
    expect((await fleet.db.getSession('s1'))?.id).toBe('s1');
    expect(fleet.isLive('s1')).toBe(true);
  });
});

describe('two hooks for one session', () => {
  const hook = (extra: Record<string, unknown>) => ({ session_id: 'h1', cwd: '/Users/dev/x', ...extra });

  it('each start from what the other stored: an agent that started is still running when the Stop hook lands', async () => {
    const { fleet } = await setup();
    await fleet.ingestHook(hook({ hook_event_name: 'SessionStart', source: 'startup' }));
    const [a, b] = await Promise.all([
      fleet.ingestHook(hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' })),
      fleet.ingestHook(hook({ hook_event_name: 'Stop' })),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const agents = await fleet.db.getAgents('h1');
    expect(agents.map((x) => [x.id, x.status])).toEqual([['a1', 'running']]);
    // The Stop hook saw the running agent, so the session is not idle.
    expect((await fleet.db.getSession('h1'))?.status).toBe('running');
  });

  it('are queued under the id the report carries, even when the payload spells it with padding', async () => {
    const { fleet } = await setup();
    await fleet.ingestHook(hook({ hook_event_name: 'SessionStart' }));
    const [a, b] = await Promise.all([
      fleet.ingestHook({ ...hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }), session_id: ' h1 ' }),
      fleet.ingestHook(hook({ hook_event_name: 'Stop' })),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect((await fleet.db.getSession('h1'))?.status).toBe('running');
  });

  it('are refused without a session id, and not queued', async () => {
    const { fleet } = await setup();
    expect(await fleet.ingestHook({ hook_event_name: 'Stop' })).toMatchObject({ ok: false, path: '$.session_id' });
    expect(await fleet.ingestHook(null)).toMatchObject({ ok: false, path: '$' });
  });
});

describe('messages', () => {
  async function wall(n: number) {
    const s = await setup();
    for (let i = 0; i < n; i++) await s.fleet.ingest(report(`w${i}`, { status: 'running' }), 'ed');
    await s.fleet.flush();
    s.msgs.length = 0;
    return s;
  }

  it('leave in the order they were asked for: a tick asked for after a slow snapshot does not pass it', async () => {
    const { fleet, msgs } = await wall(8);
    void fleet.activityHistoryChanged(); // a snapshot: reads every session, the events and the day's spend
    void fleet.tick(); // a tick: reads far less, so a straight port would finish it first
    await fleet.flush();
    expect(msgs.map((m) => m.event)).toEqual(['snapshot', 'tick']);
  });

  it('send a client its snapshot first and then everything asked for after it joined', async () => {
    const { fleet } = await wall(3);
    const got: string[] = [];
    const joined = fleet.attach({ write: (chunk: string) => void got.push(chunk) });
    void fleet.tick();
    const id = await joined;
    await fleet.flush();
    expect(id).not.toBeNull();
    const events = got.join('').split('\n\n').map((b) => /^event: (\w+)/.exec(b)?.[1]).filter(Boolean);
    expect(events).toEqual(['snapshot', 'tick']);
  });

  it('go on after one fails to read: the failure is logged and the next message is sent', async () => {
    const { fleet, msgs, lines } = await wall(1);
    vi.spyOn(fleet, 'state').mockRejectedValueOnce(new Error('disk gone'));
    await fleet.activityHistoryChanged();
    await fleet.tick();
    expect(lines.filter((l) => l.event === 'broadcast.failed')).toEqual([{ event: 'broadcast.failed', fields: { reason: 'disk gone' } }]);
    expect(msgs.map((m) => m.event)).toEqual(['tick']);
  });

  it('keep the cost sparkline off the old prices when a price changes while it is being read', async () => {
    const { fleet, storage } = await wall(1);
    // The first read is the one a price change overtakes; the one the change's own snapshot makes is on the new prices.
    let reads = 0;
    storage.fleet.fleetCostPerMinute = async () => {
      reads++;
      if (reads === 1) void fleet.prices.set('sonnet-5-5', { std: { input: 33, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 } });
      return [{ m: 1, v: reads === 1 ? 111 : 222 }];
    };
    await fleet.kpis();
    await fleet.flush();
    expect((fleet as unknown as { costMinuteCache: { rows: unknown[] } }).costMinuteCache.rows).toEqual([{ m: 1, v: 222 }]);
  });
});

describe('start up', () => {
  it('reads the sessions that were live and does it once however often it is asked', async () => {
    const { fleet, storage, clock } = await setup();
    await fleet.ingest(report('s1', { status: 'running' }), 'ed');
    clock.t += 1000;
    const next = new Fleet(storage, CFG, () => clock.t);
    expect(next.liveIds()).toEqual([]);
    await Promise.all([next.init(), next.init()]);
    expect(next.liveIds()).toEqual(['s1']);
    expect(next.init()).toBe(next.init());
  });
});
