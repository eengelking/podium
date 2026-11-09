// The OpenCode reporter against synthetic OpenCode 2.2.5 event streams (scripts/opencode-streams.ts, #1025; #848 recorded the shapes): each stream is replayed
// through the reporter, and every report it sends goes through the server's validator and then its ingest (#855).
import { describe, expect, it } from 'vitest';
import { DEFAULTS, Reporter } from '../plugin/opencode/reporter.ts';
import { optionsOf } from '../plugin/opencode/options.ts';
import type { BusEvent } from '../plugin/opencode/state.ts';
import { openSqliteStorage } from '../server/src/storage/sqlite/index.ts';
import { ingestReport } from '../server/src/fleet/ingest.ts';
import { validateReport } from '../server/src/fleet/protocol.ts';
import { STREAM_NAMES, streamOf, type StreamName } from './opencode-streams.ts';


/** Replays a fixture, then lets the root go quiet and end, and returns every body the reporter posted. */
async function replay(name: StreamName): Promise<{ bodies: unknown[]; reporter: Reporter }> {
  const bodies: unknown[] = [];
  const clock = { now: 0 };
  const reporter = new Reporter(
    { fetch: async (_u, init) => { bodies.push(JSON.parse(init.body!)); return { status: 200, ok: true, text: '{}' }; }, now: () => clock.now, runIn: () => async () => ({ exitCode: 1, stdout: "" }), log: () => undefined },
    { ...optionsOf({ serverUrl: 'http://podium.test' }, null, {}), idleMs: 60_000 },
  );
  for (const e of streamOf(name)) {
    clock.now = e.created ?? clock.now;
    reporter.handle(e);
  }
  clock.now += 1;
  await reporter.tick();
  clock.now += 61_000;
  await reporter.tick();
  return { bodies, reporter };
}

describe.each(STREAM_NAMES)('OpenCode fixture %s', (name) => {
  it('turns into reports the server validates and ingests', async () => {
    const { bodies } = await replay(name);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    const storage = openSqliteStorage(':memory:');
    let at = 1_000;
    for (const body of bodies) {
      const v = validateReport(body);
      if (!v.ok) throw new Error(`${name}: ${v.path}: ${v.error}`);
      expect(v.report.harness).toMatchObject({ id: 'opencode' });
      await ingestReport(storage, v.report, (at += 1000));
    }
    const last = validateReport(bodies.at(-1));
    if (!last.ok) throw new Error('unreachable');
    const row = await storage.fleet.getSession(last.report.session.id);
    expect(row).toMatchObject({ harness: 'opencode', status: 'done' });
    expect(row?.cost_source).toBe('harness');
  });
});

describe('OpenCode fixtures: what the wall shows', () => {
  it('folds the subagent into the root and counts its cost once', async () => {
    const { bodies } = await replay('subagent');
    const v = validateReport(bodies.at(-1));
    if (!v.ok) throw new Error(v.error);
    const r = v.report;
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0]).toMatchObject({ kind: 'subagent', type: 'general', status: 'done' });
    expect(r.agents[0]!.parentId).toBeNull();
    // The root's own usage already includes the child's 0.00014: the session cost is not 0.00056.
    expect(r.session.costUsd).toBeCloseTo(0.00042, 8);
    expect(r.session.loop?.toolCounts).toEqual({ Agent: 1 });
    expect(new Set(bodies.map((b) => (b as { session: { id: string } }).session.id)).size).toBe(1);
    const storage = openSqliteStorage(':memory:');
    for (const b of bodies) {
      const x = validateReport(b);
      if (x.ok) await ingestReport(storage, x.report, 5);
    }
    expect(await storage.fleet.getAgents(r.session.id)).toHaveLength(1);
  });

  it('waits on the permission and on the question while they are open', async () => {
    for (const [name, reason] of [['permission', 'permission'], ['question', 'input']] as const) {
      const events = streamOf(name);
      const clock = { now: 0 };
      const seen: string[] = [];
      const reporter = new Reporter(
        { fetch: async (_u, init) => { const b = JSON.parse(init.body!); seen.push(`${b.session.status}:${b.session.waitReason}`); return { status: 200, ok: true, text: '{}' }; }, now: () => clock.now, runIn: () => async () => ({ exitCode: 1, stdout: "" }), log: () => undefined },
        { ...optionsOf({}, null, {}), idleMs: 60_000 },
      );
      for (const e of events) {
        clock.now = e.created ?? clock.now;
        reporter.handle(e);
        clock.now += DEFAULTS.heartbeatMs; // send after every event
        await reporter.tick();
      }
      expect(seen).toContain(`waiting:${reason}`);
      expect(seen).toContain('running:null');
    }
  });

  it('reports a compaction as an event', async () => {
    const { bodies } = await replay('compaction');
    const kinds = bodies.flatMap((b) => (b as { events: { kind: string }[] }).events.map((e) => e.kind));
    expect(kinds).toContain('compact');
  });
});

// #1007: the server rejects a fractional time or token count with a 400 for the whole report. Every number OpenCode puts on an event
// (its `created` time, the `tokens` of a step, a usage update or a compaction, its cost) and the model's context window come from the
// host, so each fixture is replayed with half added to all of them and every report must still validate with whole numbers.
describe.each(STREAM_NAMES)('OpenCode fixture %s with fractions from the host (#1007)', (name) => {
  const frac = (v: unknown): unknown => (typeof v === 'number' ? v + 0.5 : Array.isArray(v) ? v.map(frac) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, frac(x)])) : v);
  const fractional = (e: BusEvent): BusEvent => {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const data = { ...d, ...(d.tokens !== undefined ? { tokens: frac(d.tokens) } : {}), ...(typeof d.cost === 'number' ? { cost: d.cost + 0.5 } : {}) };
    return { ...e, ...(typeof e.created === 'number' ? { created: e.created + 0.5 } : {}), data } as BusEvent;
  };

  it('sends only whole times and counts', async () => {
    const bodies: unknown[] = [];
    const clock = { now: 0 };
    const reporter = new Reporter(
      { fetch: async (_u, init) => { bodies.push(JSON.parse(init.body!)); return { status: 200, ok: true, text: '{}' }; }, now: () => clock.now, runIn: () => async () => ({ exitCode: 1, stdout: "" }), log: () => undefined, windowOf: async () => 200_000.5 },
      { ...optionsOf({ serverUrl: 'http://podium.test' }, null, {}), idleMs: 60_000 },
    );
    for (const e of streamOf(name)) {
      clock.now = e.created ?? clock.now;
      reporter.handle(fractional(e));
      await Promise.resolve();
    }
    clock.now += 1;
    await reporter.tick();
    clock.now += 61_000;
    await reporter.tick();
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) {
      const v = validateReport(body);
      if (!v.ok) throw new Error(`${name}: ${v.path}: ${v.error}`);
    }
  });
});
