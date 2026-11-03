import { describe, expect, it } from 'vitest';
import type { Runner } from '../core/git.ts';
import type { Report } from '../core/protocol.ts';
import type { FetchLike } from '../core/transport.ts';
import { optionsOf } from './options.ts';
import { buildReport } from './report.ts';
import { DEFAULTS, Reporter } from './reporter.ts';
import { apply, finish, idleFor, newStore, sweep, tokensOf, type BusEvent } from './state.ts';
import { VERSION } from './version.ts';

let n = 0;
const ev = (type: string, data: Record<string, unknown>, created: number): BusEvent => ({ id: `e${++n}`, created, type, data, location: { directory: '/work/project' } });
const usage = (sessionID: string, cost: number, input: number, created: number) =>
  ev('session.usage.updated', { sessionID, cost, tokens: { input, output: input / 5, reasoning: 0, cache: { read: 0, write: 0 } } }, created);
const step = (sessionID: string, created: number, agent = 'build') => ev('session.step.started', { sessionID, agent, model: { id: 'qwen', providerID: 'local' } }, created);

const ROOT = 'ses_root';
const KID = 'ses_kid';

function store(...events: BusEvent[]) {
  const s = newStore();
  for (const e of events) apply(s, e, e.created ?? 0);
  return s;
}

describe('state: one record per root, children folded in', () => {
  const s = store(
    ev('session.created', { sessionID: ROOT, slug: 'calm-fox', version: '2.2.5' }, 1000),
    ev('session.execution.started', { sessionID: ROOT }, 1001),
    step(ROOT, 1002),
    ev('session.tool.input.started', { sessionID: ROOT, id: 'c1', name: 'task' }, 1003),
    ev('session.tool.called', { sessionID: ROOT, id: 'c1', input: { description: 'child task' } }, 1004),
    ev('session.created', { sessionID: KID, parentID: ROOT, title: 'child task', agent: 'general' }, 1005),
    ev('session.execution.started', { sessionID: KID }, 1006),
    step(KID, 1007, 'general'),
    usage(KID, 0.00014, 100, 1008),
    ev('session.execution.succeeded', { sessionID: KID }, 1009),
    ev('session.tool.success', { sessionID: ROOT, id: 'c1', content: [{ type: 'text', text: 'ok' }] }, 1010),
    // The root's usage already includes the child's.
    usage(ROOT, 0.00028, 200, 1011),
  );

  it('makes one root and one agent', () => {
    expect([...s.roots.keys()]).toEqual([ROOT]);
    const root = s.roots.get(ROOT)!;
    expect(root.children).toEqual([KID]);
    expect(s.rootOf.get(KID)).toBe(ROOT);
  });

  it('builds a v2 report with the child as an agent and the root cost as the session cost', () => {
    const root = s.roots.get(ROOT)!;
    const r = buildReport(root, root.events, { now: 2000, version: VERSION, engineVersion: '2.2.5', hostSurface: null });
    expect(r.v).toBe(2);
    expect(r.harness).toMatchObject({ id: 'opencode', name: 'OpenCode' });
    expect(r.session).toMatchObject({ id: ROOT, harness: 'opencode', costSource: 'harness', costUsd: 0.00028, model: 'qwen', modelProvider: 'local', status: 'running', waitReason: null });
    expect(r.session.tokens.input).toBe(200);
    expect(r.session.loop).toMatchObject({ toolCalls: 1, lastTool: 'task', toolCounts: { task: 1 } });
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0]).toMatchObject({ id: KID, parentId: null, kind: 'subagent', type: 'general', name: 'child task', status: 'done', costUsdEst: 0.00014, model: 'qwen' });
    expect(r.events.map((e) => e.kind)).toEqual(['start', 'spawn', 'done']);
  });

  it('reports the context as the last step prompt: input + cache read + cache write', () => {
    const t = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.step.ended', { sessionID: ROOT, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 7, write: 3 } } }, 2));
    expect(t.roots.get(ROOT)!.sessions.get(ROOT)!.ctxTokens).toBe(20);
    expect(tokensOf({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } })).toEqual({ input: 1, output: 5, cacheRead: 4, cacheWrite: 5 });
    expect(tokensOf(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('state: status', () => {
  it('waits on a permission and a question, then runs again once answered', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.execution.started', { sessionID: ROOT }, 2));
    const root = s.roots.get(ROOT)!;
    const at = () => buildReport(root, [], { now: 9, version: VERSION, engineVersion: null, hostSurface: null }).session;
    expect(at().status).toBe('running');
    apply(s, ev('permission.asked', { id: 'per_1', sessionID: ROOT, action: 'read', resources: ['secret.env'] }, 3), 3);
    expect(at()).toMatchObject({ status: 'waiting', waitReason: 'permission', waitNote: 'read secret.env' });
    apply(s, ev('permission.replied', { sessionID: ROOT, requestID: 'per_1', reply: 'once' }, 4), 4);
    expect(at().status).toBe('running');
    apply(s, ev('form.created', { form: { id: 'frm_1', sessionID: ROOT, title: 'Questions', fields: [{ key: 'q0', title: 'Which one?' }] } }, 5), 5);
    expect(at()).toMatchObject({ status: 'waiting', waitReason: 'input', waitNote: 'Which one?' });
    apply(s, ev('form.replied', { id: 'frm_1', sessionID: ROOT, answer: { q0: 'B' } }, 6), 6);
    expect(at().status).toBe('running');
    apply(s, ev('form.created', { form: { id: 'frm_2', sessionID: ROOT, title: 'More' } }, 7), 7);
    apply(s, ev('form.cancelled', { id: 'frm_2', sessionID: ROOT }, 8), 8);
    expect(root.asks.size).toBe(0);
  });

  it('ignores a permission for a session it never saw, unless it was recovered', () => {
    const s = newStore();
    expect(apply(s, ev('permission.asked', { id: 'p', sessionID: 'ses_x', action: 'read' }, 1), 1)).toBeNull();
    expect(apply(s, ev('session.text.delta', {}, 1), 1)).toBeNull();
    expect(apply(s, { ...ev('permission.asked', { id: 'p', sessionID: 'ses_x', action: 'read' }, 1), recovered: true }, 1)).not.toBeNull();
    expect(s.roots.get('ses_x')!.asks.size).toBe(1);
  });

  it('names a tool call from its own event when the start of its input was missed', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.tool.called', { sessionID: ROOT, id: 'c1', name: 'todowrite', input: { todos: [{ content: 'A', status: 'pending' }] } }, 2), ev('session.tool.success', { sessionID: ROOT, id: 'c1' }, 3));
    expect(s.roots.get(ROOT)!.sessions.get(ROOT)!.toolCounts).toEqual({ todowrite: 1 });
  });

  it('tracks compaction', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.compaction.started', { sessionID: ROOT, reason: 'manual' }, 2));
    const root = s.roots.get(ROOT)!;
    expect(root.compacting).toBe(true);
    expect(idleFor(root, 10_000_000, 1)).toBe(false);
    apply(s, ev('session.compaction.ended', { sessionID: ROOT }, 3), 3);
    apply(s, ev('session.compaction.started', { sessionID: ROOT }, 4), 4);
    apply(s, ev('session.compaction.failed', { sessionID: ROOT }, 5), 5);
    expect(root.compacting).toBe(false);
    expect(root.compactions).toBe(2);
    expect(root.events.map((e) => e.text)).toContain('compaction failed');
  });
});

describe('state: done after idle, at once on delete or archive, and reopening', () => {
  it('sweeps a quiet root to done and reopens it under the same id', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1000), ev('session.execution.started', { sessionID: ROOT }, 1001));
    const root = s.roots.get(ROOT)!;
    expect(sweep(s, 1000 + 120_000, 60_000)).toEqual([]); // still executing
    apply(s, ev('session.execution.succeeded', { sessionID: ROOT }, 1002), 1002);
    expect(sweep(s, 1002 + 59_999, 60_000)).toEqual([]);
    expect(sweep(s, 1002 + 60_000, 60_000)).toEqual([root]);
    expect(root.done).toBe(true);
    expect(buildReport(root, [], { now: 1, version: VERSION, engineVersion: null, hostSurface: null }).session).toMatchObject({ status: 'done', endReason: 'idle' });
    apply(s, ev('session.execution.started', { sessionID: ROOT }, 900_000), 900_000);
    expect(root.done).toBe(false);
    expect(root.endReason).toBeNull();
    expect(s.roots.get(ROOT)).toBe(root);
  });

  it.each([
    ['session.deleted', 'deleted'],
    ['session.archived', 'archived'],
  ])('%s ends the root at once', (type, reason) => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.created', { sessionID: KID, parentID: ROOT }, 2), ev('session.execution.started', { sessionID: KID }, 3));
    apply(s, ev(type, { sessionID: KID }, 4), 4); // a child going away does not end the root
    expect(s.roots.get(ROOT)!.done).toBe(false);
    apply(s, ev(type, { sessionID: ROOT }, 5), 5);
    const root = s.roots.get(ROOT)!;
    expect(root).toMatchObject({ done: true, endReason: reason });
    expect(root.sessions.get(KID)!.end).toBe('aborted');
    finish(root, 6, 'again'); // finishing twice changes nothing
    expect(root.endReason).toBe(reason);
  });
});

describe('state: failures and plan', () => {
  it('records a failed tool call as a failure, and a failed run as a failed agent', () => {
    const s = store(
      ev('session.created', { sessionID: ROOT }, 1),
      ev('session.created', { sessionID: KID, parentID: ROOT }, 2),
      ev('session.tool.input.started', { sessionID: KID, id: 'c9', name: 'bash' }, 3),
      ev('session.tool.called', { sessionID: KID, id: 'c9', input: { command: 'npm test' } }, 4),
      ev('session.tool.failed', { sessionID: KID, id: 'c9', error: { message: 'exit code 2' } }, 5),
      ev('session.execution.failed', { sessionID: KID }, 6),
    );
    const root = s.roots.get(ROOT)!;
    const kid = root.sessions.get(KID)!;
    expect(kid.failure).not.toBeNull();
    expect(kid.end).toBe('failed');
    const r = buildReport(root, root.events, { now: 7, version: VERSION, engineVersion: null, hostSurface: null });
    expect(r.agents[0]).toMatchObject({ status: 'failed', failure: { class: expect.any(String) } });
    expect(r.events.some((e) => e.kind === 'fail')).toBe(true);
  });

  it('records an interrupted run and a failed step', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.execution.interrupted', { sessionID: ROOT }, 2), ev('session.step.failed', { sessionID: ROOT, error: { message: 'boom' } }, 3));
    const root = s.roots.get(ROOT)!;
    expect(root.events.map((e) => e.kind)).toEqual(['start', 'end', 'fail']);
    expect(root.sessions.get(ROOT)!.failure).not.toBeNull();
  });

  it('builds the plan from the todo tool', () => {
    const s = store(
      ev('session.created', { sessionID: ROOT }, 1),
      ev('session.tool.input.started', { sessionID: ROOT, id: 't1', name: 'todowrite' }, 2),
      ev('session.tool.called', { sessionID: ROOT, id: 't1', input: { todos: [{ content: 'Write it', status: 'in_progress' }, { content: 'Test it', status: 'pending' }] } }, 3),
    );
    const root = s.roots.get(ROOT)!;
    const plan = buildReport(root, [], { now: 4, version: VERSION, engineVersion: null, hostSurface: null }).session.plan;
    expect(plan).toMatchObject({ source: 'todowrite' });
    expect(plan!.steps.map((p) => [p.text, p.state])).toEqual([['Write it', 'active'], ['Test it', 'pending']]);
  });

  it('names a session from its rename and falls back to the id', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.inbox.enqueued', { sessionID: ROOT, item: { payload: { text: 'hello there' } } }, 2));
    const meta = { now: 3, version: VERSION, engineVersion: null, hostSurface: null };
    const root = s.roots.get(ROOT)!;
    expect(buildReport(root, [], meta).session.name).toBe(ROOT);
    apply(s, ev('session.renamed', { sessionID: ROOT, title: 'My task' }, 3), 3);
    expect(buildReport(root, [], meta).session.name).toBe('My task');
  });
});

describe('options', () => {
  it('takes no options at all', () => {
    expect(optionsOf(undefined, null, {}).serverUrl).toBe('http://127.0.0.1:4317');
    expect(optionsOf(null, null, {}).token).toBe('');
  });

  it('reads the plugin options, then the environment, then the defaults', () => {
    expect(optionsOf({}, null, {})).toMatchObject({ serverUrl: 'http://127.0.0.1:4317', token: '', userName: null, idleMs: DEFAULTS.idleMs, version: VERSION });
    expect(optionsOf({ serverUrl: 'http://a', token: 't', userName: 'Dana', idleSeconds: 30 }, '2.2.5', { PODIUM_SERVER: 'http://b' })).toMatchObject({ serverUrl: 'http://a', token: 't', userName: 'Dana', idleMs: 30_000, engineVersion: '2.2.5' });
    expect(optionsOf({}, null, { PODIUM_SERVER: 'http://b', PODIUM_TOKEN: 'x', PODIUM_USER: 'Ed', PODIUM_IDLE_SECONDS: '90' })).toMatchObject({ serverUrl: 'http://b', token: 'x', userName: 'Ed', idleMs: 90_000 });
    expect(optionsOf({ idleSeconds: 1 }, null, {}).idleMs).toBe(DEFAULTS.idleMs);
  });
});

// ---- the runtime ----

const noGit: Runner = async () => ({ exitCode: 1, stdout: '' });
const okReply = { status: 200, ok: true, text: '{}' };

function reporter(fetch: FetchLike, run: Runner = noGit, t = { now: 10_000 }) {
  const r = new Reporter({ fetch, now: () => t.now, runIn: () => run, log: () => undefined }, { ...optionsOf({ serverUrl: 'http://podium.test', token: 'tok' }, null, {}), idleMs: 60_000 });
  return { r, t };
}

describe('Reporter', () => {
  it('does not touch the network while handling events', async () => {
    const calls: string[] = [];
    const { r } = reporter(async (url) => { calls.push(url); return okReply; });
    for (let i = 0; i < 50; i++) expect(r.handle(ev('session.created', { sessionID: `ses_${i}` }, i))).toBeUndefined();
    expect(calls).toEqual([]);
    await r.tick();
    expect(calls).toHaveLength(50);
    expect(calls[0]).toBe('http://podium.test/api/fleet/report');
  });

  it('keeps its events when the server is down, backs off, and sends them later', async () => {
    let up = false;
    const bodies: Report[] = [];
    const { r, t } = reporter(async (_u, init) => {
      if (!up) throw new Error('refused');
      bodies.push(JSON.parse(init.body!) as Report);
      return okReply;
    });
    r.handle(ev('session.created', { sessionID: ROOT, version: '2.2.5' }, 10_000));
    await r.tick();
    const tr = r.transports.get(ROOT)!;
    expect(tr.online).toBe(false);
    expect(tr.queue.length).toBeGreaterThan(0);
    await r.tick(); // inside the backoff: nothing is sent
    expect(bodies).toHaveLength(0);
    up = true;
    t.now += 2000;
    await r.tick();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.events.map((e) => e.kind)).toEqual(['start']);
    expect(bodies[0]!.reporter.engineVersion).toBe('2.2.5');
    expect(tr.queue).toEqual([]);
  });

  it('sends a heartbeat only while a root is open, and forgets a long-done root', async () => {
    const bodies: Report[] = [];
    const { r, t } = reporter(async (_u, init) => { bodies.push(JSON.parse(init.body!) as Report); return okReply; });
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await r.tick();
    t.now += 5000;
    await r.tick();
    expect(bodies.map((b) => b.session.status)).toEqual(['waiting', 'waiting']);
    t.now += 60_000; // idle: done
    await r.tick();
    expect(bodies.at(-1)!.session).toMatchObject({ status: 'done', endReason: 'idle' });
    const sent = bodies.length;
    t.now += 10_000;
    await r.tick();
    expect(bodies).toHaveLength(sent); // a done root is quiet
    t.now += DEFAULTS.keepDoneMs;
    await r.tick();
    expect(r.store.roots.size).toBe(0);
    expect(r.transports.size).toBe(0);
  });

  it('reads the branch in the session directory, as soon as the root appears, and waits for it on close', async () => {
    const bodies: Report[] = [];
    const dirs: string[] = [];
    const t = { now: 10_000 };
    const r = new Reporter(
      {
        fetch: async (_u, init) => { bodies.push(JSON.parse(init.body!) as Report); return okReply; },
        now: () => t.now,
        runIn: (cwd) => async (argv) => {
          dirs.push(cwd);
          const cmd = argv.join(' ');
          await new Promise((res) => setTimeout(res, 5));
          if (cmd.includes('--abbrev-ref')) return { exitCode: 0, stdout: 'feature/x\n' };
          if (cmd.includes('--git-dir') || cmd.includes('--git-common-dir')) return { exitCode: 0, stdout: '.git\n' };
          if (cmd.includes('--show-toplevel')) return { exitCode: 0, stdout: '/work/project\n' };
          if (cmd.includes('status')) return { exitCode: 0, stdout: '## feature/x...origin/feature/x [ahead 2]\n M a.ts\n' };
          return { exitCode: 1, stdout: '' };
        },
        log: () => undefined,
      },
      { ...optionsOf({}, null, {}), idleMs: 60_000 },
    );
    r.handle(ev('session.created', { sessionID: ROOT, location: { directory: '/work/project' } }, 10_000));
    await r.close(); // the branch read is still in flight here
    expect(new Set(dirs)).toEqual(new Set(['/work/project']));
    expect(bodies.at(-1)!.session.git).toMatchObject({ branch: 'feature/x', ahead: 2, dirty: 1 });
  });

  it('leaves the branch out when the directory is not a repository', async () => {
    const bodies: Report[] = [];
    const { r, t } = reporter(async (_u, init) => { bodies.push(JSON.parse(init.body!) as Report); return okReply; });
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await r.tick();
    t.now += 20_000;
    await r.tick();
    expect(bodies.at(-1)!.session.git).toBeNull();
  });

  it('ends every open root on close with one bounded final flush', async () => {
    const bodies: Report[] = [];
    const { r } = reporter(async (_u, init) => { bodies.push(JSON.parse(init.body!) as Report); return okReply; });
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    r.handle(ev('session.created', { sessionID: 'ses_two' }, 10_001));
    await r.close();
    expect(bodies.map((b) => [b.session.status, b.session.endReason])).toEqual([['done', 'shutdown'], ['done', 'shutdown']]);
    r.handle(ev('session.created', { sessionID: 'ses_late' }, 10_002)); // closed: ignored
    expect(r.store.roots.has('ses_late')).toBe(false);
    await r.close(); // closing twice is harmless
    await r.tick();
  });

  it('folds an event once, however many subscriptions deliver it', () => {
    const { r } = reporter(async () => okReply);
    const e = ev('session.step.started', { sessionID: ROOT, model: { id: 'm', providerID: 'p' } }, 10_000);
    r.handle(ev('session.created', { sessionID: ROOT }, 9_999));
    r.handle(e);
    r.handle(e);
    expect(r.store.roots.get(ROOT)!.sessions.get(ROOT)!.steps).toBe(1);
    for (let i = 0; i < 2100; i++) r.handle(ev('session.renamed', { sessionID: ROOT, title: `t${i}` }, 10_001 + i));
    r.handle(e); // far enough back that it is no longer remembered
    expect(r.store.roots.get(ROOT)!.sessions.get(ROOT)!.steps).toBe(2);
  });

  it('does not wait for a server that never answers', async () => {
    const { r } = reporter(() => new Promise(() => undefined));
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    const started = Date.now();
    await r.close(30);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('skips the final send for a root that is backing off', async () => {
    let calls = 0;
    const { r } = reporter(async () => { calls++; throw new Error('down'); });
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await r.tick();
    expect(calls).toBe(1);
    await r.close();
    expect(calls).toBe(1);
  });

  it('recovers permissions that were open when it started', async () => {
    const bodies: Report[] = [];
    const { r } = reporter(async (_u, init) => { bodies.push(JSON.parse(init.body!) as Report); return okReply; });
    expect(r.sessionIds()).toEqual([]);
    r.recover([{ id: 'per_1', sessionID: ROOT, action: 'edit', resources: ['a.ts'] }, { nope: true }, null]);
    expect(r.sessionIds()).toEqual([ROOT]);
    await r.tick();
    expect(bodies[0]!.session).toMatchObject({ status: 'waiting', waitReason: 'permission', waitNote: 'edit a.ts' });
  });
});
