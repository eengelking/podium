import { describe, expect, it, vi } from 'vitest';
import { explainPrompt } from '../core/failures.ts';
import type { Report } from '../core/protocol.ts';
import { optionsOf } from './options.ts';
import { Reporter } from './reporter.ts';
import type { BusEvent } from './state.ts';

let n = 0;
const ev = (type: string, data: Record<string, unknown>, created: number): BusEvent => ({ id: `x${++n}`, created, type, data, location: { directory: '/work/project' } });
const ROOT = 'ses_root';
const KID = 'ses_kid';

/** A child session whose bash call fails and whose run then fails: one failure to explain, with a secret in its output. */
const failing = (id = 'c1', at = 100): BusEvent[] => [
  ev('session.tool.input.started', { sessionID: KID, id, name: 'bash' }, at),
  ev('session.tool.called', { sessionID: KID, id, input: { command: 'npm test' } }, at + 1),
  ev('session.tool.failed', { sessionID: KID, id, error: { message: 'exit code 2 token=hunter2' } }, at + 2),
  ev('session.execution.failed', { sessionID: KID }, at + 3),
];

function rig(explain: ((prompt: string) => Promise<string | null>) | undefined, on = true, over: { explainMs?: number } = {}) {
  const reports: Report[] = [];
  const t = { now: 10_000 };
  const r = new Reporter(
    { fetch: async (_u, init) => { reports.push(JSON.parse(init.body!) as Report); return { status: 200, ok: true, text: '{}' }; }, now: () => t.now, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined, ...(explain ? { explain } : {}), ...over },
    { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok', ...(on ? { PODIUM_EXPLAIN_FAILURES: 'true' } : {}) }), idleMs: 600_000 },
  );
  r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
  r.handle(ev('session.created', { sessionID: KID, parentID: ROOT }, 10_001));
  return { r, t, reports };
}
const kidOf = (s: Report) => s.agents.find((a) => a.id === KID)!;

describe('explaining failures (#969)', () => {
  it('asks the model once for each new failure, from the tick and not from the event handler, and reports the explanation', async () => {
    const explain = vi.fn(async () => 'The tests failed because a dependency is missing. Run npm install.');
    const { r, reports } = rig(explain);
    for (const e of failing()) r.handle(e);
    expect(explain).not.toHaveBeenCalled();
    await r.tick();
    await vi.waitFor(() => expect(explain).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      r.store.roots.get(ROOT)!.dirty = true;
      await r.tick();
      expect(kidOf(reports.at(-1)!).failure?.explanation).toBe('The tests failed because a dependency is missing. Run npm install.');
    });
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('builds the prompt from the redacted failure record and names OpenCode', async () => {
    let prompt = '';
    const { r } = rig(async (p) => { prompt = p; return 'x'; });
    for (const e of failing()) r.handle(e);
    await r.tick();
    await vi.waitFor(() => expect(prompt).not.toBe(''));
    expect(prompt).toContain('An OpenCode agent failed');
    expect(prompt).toContain('npm test');
    expect(prompt).not.toContain('hunter2');
    expect(explainPrompt({ class: 'Aborted', at: 1, tool: null, call: null, exitCode: null, outputTail: [], evidence: [], explanation: null, retriedAs: null })).toContain('A Claude Code agent failed');
  });

  it('never asks while the person has not allowed it, even when OpenCode can generate', async () => {
    const explain = vi.fn(async () => 'x');
    const { r } = rig(explain, false);
    for (const e of failing()) r.handle(e);
    await r.tick();
    await r.tick();
    expect(explain).not.toHaveBeenCalled();
  });

  it('asks nothing when the host cannot generate, and does not fail', async () => {
    const { r, reports } = rig(undefined);
    for (const e of failing()) r.handle(e);
    await r.tick();
    expect(kidOf(reports.at(-1)!).failure?.explanation).toBeNull();
  });

  it('gives up after the time limit and leaves the failure unexplained, without asking again for it', async () => {
    const explain = vi.fn(() => new Promise<string | null>(() => undefined));
    const { r, t } = rig(explain, true, { explainMs: 20 });
    for (const e of failing()) r.handle(e);
    await r.tick();
    await new Promise((res) => setTimeout(res, 60));
    t.now += 10_000;
    await r.tick();
    expect(explain).toHaveBeenCalledTimes(1);
    expect(r.store.roots.get(ROOT)!.sessions.get(KID)!.failure!.explanation).toBeNull();
  });

  it('swallows a model call that throws or answers nothing', async () => {
    const explain = vi.fn().mockRejectedValueOnce(new Error('no model')).mockResolvedValueOnce(null);
    const { r } = rig(explain);
    for (const e of failing('c1', 100)) r.handle(e);
    await r.tick();
    await vi.waitFor(() => expect(explain).toHaveBeenCalledTimes(1));
    r.handle(ev('session.created', { sessionID: 'ses_k2', parentID: ROOT }, 200));
    r.handle(ev('session.execution.failed', { sessionID: 'ses_k2' }, 201));
    await r.tick();
    await vi.waitFor(() => expect(explain).toHaveBeenCalledTimes(2));
    await new Promise((res) => setTimeout(res, 10));
    expect(r.store.roots.get(ROOT)!.sessions.get(KID)!.failure!.explanation).toBeNull();
    expect(r.store.roots.get(ROOT)!.sessions.get('ses_k2')!.failure!.explanation).toBeNull();
  });

  it('asks again for a failure of the same agent that is new, and keeps the cost of calls to a few at a time', async () => {
    const release: (() => void)[] = [];
    const explain = vi.fn(() => new Promise<string | null>((res) => release.push(() => res('Because.'))));
    const { r, t } = rig(explain);
    for (const id of ['a', 'b', 'c', 'd']) {
      r.handle(ev('session.created', { sessionID: `ses_${id}`, parentID: ROOT }, 300));
      r.handle(ev('session.execution.failed', { sessionID: `ses_${id}` }, 301));
    }
    await r.tick();
    await vi.waitFor(() => expect(explain.mock.calls.length).toBeGreaterThan(0));
    expect(explain.mock.calls.length).toBeLessThanOrEqual(2);
    release.splice(0).forEach((f) => f());
    await new Promise((res) => setTimeout(res, 10));
    t.now += 10_000;
    await r.tick();
    await vi.waitFor(() => expect(explain.mock.calls.length).toBe(4));
    release.splice(0).forEach((f) => f());
    await new Promise((res) => setTimeout(res, 10));
    // The same agent fails again later: a new failure, explained anew.
    for (const e of failing('c2', 5000)) r.handle(e);
    await r.tick();
    await vi.waitFor(() => expect(explain.mock.calls.length).toBe(5));
  });
});
