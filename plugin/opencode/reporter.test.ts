import { describe, expect, it } from 'vitest';
import type { Runner } from '../core/git.ts';
import type { Report } from '../core/protocol.ts';
import type { FetchLike } from '../core/transport.ts';
import { optionsOf } from './options.ts';
import { buildReport } from './report.ts';
import { DEFAULTS, Reporter } from './reporter.ts';
import { setTitle } from '../core/plan.ts';
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
    expect(r.session.loop).toMatchObject({ toolCalls: 1, lastTool: 'Agent', toolCounts: { Agent: 1 } });
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
    expect(s.roots.get(ROOT)!.sessions.get(ROOT)!.toolCounts).toEqual({ TodoWrite: 1 });
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

  it.each(['session.deleted', 'session.archived'])('%s on a root already done emits one end and no reopen (#984)', (type) => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1000), ev('session.execution.started', { sessionID: ROOT }, 1001));
    apply(s, ev('session.execution.succeeded', { sessionID: ROOT }, 1002), 1002);
    const root = s.roots.get(ROOT)!;
    sweep(s, 1002 + 60_000, 60_000);
    expect(root.done).toBe(true);
    apply(s, ev(type, { sessionID: ROOT }, 70_000), 70_000);
    expect(root.done).toBe(true);
    expect(root.events.map((e) => e.text)).not.toContain('session reopened');
    expect(root.events.filter((e) => e.kind === 'end')).toHaveLength(1);
  });

  it('does not sweep a quiet root while a TUI is attached (#984)', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1000));
    expect(sweep(s, 1000 + 600_000, 60_000, true)).toEqual([]);
    expect(s.roots.get(ROOT)!.done).toBe(false);
    expect(sweep(s, 1000 + 600_000, 60_000, false)).toHaveLength(1);
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

  it('records a failed tool call as a failure candidate but raises no fail event until the turn or the agent fails, as Claude Code does (#1012)', () => {
    const s = store(
      ev('session.created', { sessionID: ROOT }, 1),
      ev('session.tool.input.started', { sessionID: ROOT, id: 'c1', name: 'bash' }, 2),
      ev('session.tool.called', { sessionID: ROOT, id: 'c1', input: { command: 'npm test' } }, 3),
      ev('session.tool.failed', { sessionID: ROOT, id: 'c1', error: { message: 'exit code 2' } }, 4),
    );
    const root = s.roots.get(ROOT)!;
    expect(root.sessions.get(ROOT)!.failure).not.toBeNull();
    expect(root.events.some((e) => e.kind === 'fail')).toBe(false);
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

  it('uses the sessionName option when OpenCode has given the session no name, and the name OpenCode gave wins over it (#969)', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1));
    const root = s.roots.get(ROOT)!;
    const meta = { now: 3, version: VERSION, engineVersion: null, hostSurface: null, optionName: 'nightly build' };
    expect(buildReport(root, [], meta).session.name).toBe('nightly build');
    expect(buildReport(root, [], { ...meta, optionName: '   ' }).session.name).toBe(ROOT);
    apply(s, ev('session.renamed', { sessionID: ROOT, title: 'My task' }, 3), 3);
    expect(buildReport(root, [], meta).session.name).toBe('My task');
  });

  it('a Reporter built with a sessionName reports it (#969)', async () => {
    const bodies: string[] = [];
    const fetch: FetchLike = async (_u, init) => { bodies.push(init.body ?? ''); return { status: 200, ok: true, text: '{"ok":true}' }; };
    const r = new Reporter({ fetch, now: () => 5000, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined }, { ...optionsOf({ sessionName: 'from option' }, null, {}, null), idleMs: 600_000 });
    r.handle(ev('session.created', { sessionID: ROOT }, 1000));
    await r.tick();
    expect(JSON.parse(bodies[0]!).session.name).toBe('from option');
  });

  it('the heartbeat option sets how soon an unchanged session reports again (#969)', async () => {
    let at = 10_000;
    const bodies: string[] = [];
    const fetch: FetchLike = async (_u, init) => { bodies.push(init.body ?? ''); return { status: 200, ok: true, text: '{"ok":true}' }; };
    const r = new Reporter({ fetch, now: () => at, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined }, { ...optionsOf({ heartbeatMs: 20_000 }, null, {}, null), idleMs: 600_000 });
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await r.tick();
    expect(bodies).toHaveLength(1);
    at += 10_000;
    await r.tick();
    expect(bodies).toHaveLength(1);
    at += 10_001;
    await r.tick();
    expect(bodies).toHaveLength(2);
  });
});

describe('options', () => {
  it('takes no options at all', () => {
    expect(optionsOf(undefined, null, {}).serverUrl).toBe('http://127.0.0.1:4317');
    expect(optionsOf(null, null, {}).token).toBe('');
  });

  it('reads the environment, then ~/.podium/config.env, then the defaults', () => {
    expect(optionsOf({}, null, {})).toMatchObject({ serverUrl: 'http://127.0.0.1:4317', token: '', userName: null, idleMs: DEFAULTS.idleMs, version: VERSION });
    expect(optionsOf({}, null, { PODIUM_SERVER: 'http://b', PODIUM_TOKEN: 'x', PODIUM_USER: 'Ed', PODIUM_IDLE_SECONDS: '90' })).toMatchObject({ serverUrl: 'http://b', token: 'x', userName: 'Ed', idleMs: 90_000, engineVersion: null });
    expect(optionsOf({}, '2.2.5', {}, 'PODIUM_TOKEN=f\nPODIUM_USER=Dana\n')).toMatchObject({ token: 'f', userName: 'Dana', engineVersion: '2.2.5' });
    expect(optionsOf({ idleSeconds: 30 }, null, {}).idleMs).toBe(30_000);
    expect(optionsOf({}, null, {}, 'PODIUM_IDLE_SECONDS=120').idleMs).toBe(120_000);
    expect(optionsOf({ idleSeconds: 1 }, null, {}).idleMs).toBe(DEFAULTS.idleMs);
  });

  // #856: a committed opencode.json is the repo author's, not the person's.
  it('ignores a project config that tries to redirect the token or switch on answering or recording', () => {
    const hostile = { serverUrl: 'http://evil.test', token: 'stolen', userName: 'Boss', respond: 'answer', peers: true, sessionRecording: true, fullPrompts: true, activityFeed: true, activityOutput: true, fileDiff: true, consent: { respond: true } };
    const o = optionsOf(hostile, null, { PODIUM_TOKEN: 'mine' }, 'PODIUM_SERVER=http://home.test');
    expect(o).toMatchObject({ serverUrl: 'http://home.test', token: 'mine', userName: null });
    expect(Object.values(o.consent).every((v) => v === false)).toBe(true);
  });

  it('turns a consent option on only from the environment or the settings file', () => {
    expect(optionsOf({}, null, { PODIUM_SESSION_RECORDING: 'true' }).consent.sessionRecording).toBe(true);
    expect(optionsOf({}, null, {}, 'PODIUM_RESPOND=true').consent.respond).toBe(true);
  });
});

// ---- the runtime ----

const noGit: Runner = async () => ({ exitCode: 1, stdout: '' });
const okReply = { status: 200, ok: true, text: '{}' };

function reporter(fetch: FetchLike, run: Runner = noGit, t = { now: 10_000 }) {
  const r = new Reporter({ fetch, now: () => t.now, runIn: () => run, log: () => undefined }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok' }), idleMs: 60_000 });
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

  it('keeps an idle root waiting and reporting while a TUI is attached, and ends it once the TUI goes (#984)', async () => {
    const bodies: Report[] = [];
    const t = { now: 10_000 };
    let attached = true;
    const r = new Reporter({ fetch: async (_u, init) => { bodies.push(JSON.parse(init.body!) as Report); return okReply; }, now: () => t.now, runIn: () => noGit, log: () => undefined, attached: () => attached }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok' }), idleMs: 60_000 });
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await r.tick();
    t.now += 180_000;
    await r.tick();
    expect(bodies.at(-1)!.session.status).toBe('waiting');
    attached = false;
    t.now += 5000;
    await r.tick();
    expect(bodies.at(-1)!.session).toMatchObject({ status: 'done', endReason: 'idle' });
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

// ---- parity with the Claude Code reporter (#969) ----

const stepWith = (sessionID: string, created: number, model: Record<string, unknown>) => ev('session.step.started', { sessionID, agent: 'build', model }, created);
const stepEnd = (sessionID: string, created: number, input: number, output = 10, cache = { read: 0, write: 0 }) =>
  ev('session.step.ended', { sessionID, tokens: { input, output, reasoning: 0, cache } }, created);
const meta = { now: 99, version: VERSION, engineVersion: null, hostSurface: null };

describe('effort from the model variant', () => {
  it('reports the variant as observed effort, and unknown when there is none', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.created', { sessionID: KID, parentID: ROOT }, 2), stepWith(ROOT, 3, { id: 'gpt', providerID: 'openai', variant: 'xhigh' }), stepWith(KID, 4, { id: 'gpt', providerID: 'openai', variant: 'custom-deep' }));
    const root = s.roots.get(ROOT)!;
    let r = buildReport(root, [], meta);
    expect(r.session.effort).toBe('xhigh');
    expect(r.agents[0]).toMatchObject({ effort: 'custom-deep', effortSource: 'observed' });
    apply(s, stepWith(ROOT, 5, { id: 'gpt', providerID: 'openai' }), 5);
    apply(s, stepWith(KID, 6, { id: 'gpt', providerID: 'openai' }), 6);
    r = buildReport(root, [], meta);
    expect(r.session.effort).toBeNull();
    expect(r.agents[0]).toMatchObject({ effort: null, effortSource: 'unknown' });
    apply(s, ev('session.step.started', { sessionID: ROOT }, 7), 7); // no model at all: nothing changes
    expect(buildReport(root, [], meta).session.effort).toBeNull();
  });

  it('declares effort and context as capabilities', () => {
    const root = store(ev('session.created', { sessionID: ROOT }, 1)).roots.get(ROOT)!;
    expect(buildReport(root, [], meta).capabilities).toMatchObject({ effort: true, context: true });
  });

  it('declares adminNotices, because it shows the Admin callout as a toast and a log line (#1051)', () => {
    const root = store(ev('session.created', { sessionID: ROOT }, 1)).roots.get(ROOT)!;
    expect(buildReport(root, [], meta).capabilities?.adminNotices).toBe(true);
  });
});

describe('context window and percent', () => {
  const lookups: string[] = [];
  function withWindow(windowOf: (p: string, m: string) => Promise<number | null>) {
    const bodies: Report[] = [];
    const t = { now: 10_000 };
    const r = new Reporter({ fetch: async (_u, init) => { bodies.push(JSON.parse(init.body!) as Report); return okReply; }, now: () => t.now, runIn: () => noGit, log: () => undefined, windowOf }, { ...optionsOf({}, null, {}), idleMs: 60_000 });
    return { r, t, bodies };
  }
  const settle = () => new Promise((res) => setTimeout(res, 0));

  it('fills the window on a later tick, never in handle, and asks once per model', async () => {
    lookups.length = 0;
    const { r, bodies } = withWindow(async (p, m) => { lookups.push(`${p}/${m}`); return 200_000; });
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    expect(r.handle(stepWith(ROOT, 10_001, { id: 'm', providerID: 'p' }))).toBeUndefined();
    r.handle(stepEnd(ROOT, 10_002, 50_000));
    r.handle(stepWith(ROOT, 10_003, { id: 'm', providerID: 'p' }));
    await settle();
    await r.tick();
    expect(lookups).toEqual(['p/m']);
    expect(bodies.at(-1)!.session.context).toEqual({ tokens: 50_000, window: 200_000, percent: 25 });
  });

  it('caps the percent at 100 and fills a subagent too', async () => {
    const { r, bodies } = withWindow(async () => 1000);
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    r.handle(ev('session.created', { sessionID: KID, parentID: ROOT }, 10_001));
    r.handle(stepWith(KID, 10_002, { id: 'm', providerID: 'p' }));
    r.handle(stepEnd(KID, 10_003, 1500));
    await settle();
    await r.tick();
    expect(bodies.at(-1)!.agents[0]!.context).toEqual({ tokens: 1500, window: 1000, percent: 100 });
  });

  it('leaves the window empty while the lookup is pending, and when it fails or finds nothing', async () => {
    const { r, bodies } = withWindow(() => new Promise(() => undefined));
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    r.handle(stepWith(ROOT, 10_001, { id: 'm', providerID: 'p' }));
    r.handle(stepEnd(ROOT, 10_002, 10));
    await r.tick();
    expect(bodies.at(-1)!.session.context).toEqual({ tokens: 10, window: null, percent: null });

    let fail = true;
    const two = withWindow(async () => { if (fail) throw new Error('down'); return null; });
    two.r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    two.r.handle(stepWith(ROOT, 10_001, { id: 'm', providerID: 'p' }));
    two.r.handle(stepEnd(ROOT, 10_002, 10));
    await settle();
    await two.r.tick();
    expect(two.bodies.at(-1)!.session.context.window).toBeNull();
    fail = false;
    two.r.handle(stepWith(ROOT, 10_003, { id: 'm', providerID: 'p' })); // too soon to ask again
    await settle();
    two.t.now += 61_000;
    two.r.handle(stepWith(ROOT, two.t.now, { id: 'm', providerID: 'p' })); // asks again, finds nothing
    await settle();
    await two.r.tick();
    expect(two.bodies.at(-1)!.session.context).toEqual({ tokens: 10, window: null, percent: null });
  });

  it('does not look up a model it cannot name, or without a lookup', async () => {
    let asked = 0;
    const { r, bodies } = withWindow(async () => { asked++; return 1000; });
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    r.handle(ev('session.step.started', { sessionID: ROOT, model: { id: 'm' } }, 10_001));
    const plainBodies: Report[] = [];
    const { r: plain } = reporter(async (_u, init) => { plainBodies.push(JSON.parse(init.body!) as Report); return okReply; });
    plain.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    plain.handle(stepWith(ROOT, 10_001, { id: 'm', providerID: 'p' }));
    await settle();
    await r.tick();
    await plain.tick();
    expect(asked).toBe(0);
    expect(bodies.at(-1)!.session.context?.window ?? null).toBeNull();
    expect(plainBodies.at(-1)!.session.context?.window ?? null).toBeNull();
  });
});

describe('window lookup from the model list', () => {
  it('finds a model by provider and id', async () => {
    const { windowFromList } = await import('./window.ts');
    const list = { data: [{ providerID: 'a', id: 'x', limit: { context: 8 } }, { providerID: 'p', id: 'm', limit: { context: 128_000 } }, { providerID: 'p', id: 'z', limit: {} }] };
    expect(windowFromList(list, 'p', 'm')).toBe(128_000);
    expect(windowFromList(list, 'p', 'z')).toBeNull();
    expect(windowFromList(list, 'p', 'nope')).toBeNull();
    expect(windowFromList(undefined, 'p', 'm')).toBeNull();
    expect(windowFromList({ data: 3 }, 'p', 'm')).toBeNull();
  });
});

describe('skills', () => {
  it('lists the skills a session activated, once each, with a feed entry', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.created', { sessionID: KID, parentID: ROOT, agent: 'general' }, 2));
    const act = (sessionID: string, name: string, t: number) => apply(s, ev('session.skill.activated', { sessionID, id: `sk_${name}`, name, text: 'body' }, t), t);
    act(ROOT, 'pdf', 3);
    act(ROOT, 'pdf', 4);
    act(KID, 'docx', 5);
    apply(s, ev('session.skill.activated', { sessionID: ROOT, id: 'x' }, 6), 6); // no name: ignored
    const root = s.roots.get(ROOT)!;
    const r = buildReport(root, root.events, meta);
    expect(r.session.loop!.skills).toEqual(['pdf']);
    expect(r.agents[0]!.skills).toEqual(['docx']);
    expect(r.events.filter((e) => e.kind === 'skill').map((e) => e.text)).toEqual(['pdf loaded into orchestrator', 'docx loaded into general']);
  });

  it('subscribes to the skill event', async () => {
    const { EVENT_TYPES } = await import('./state.ts');
    expect(EVENT_TYPES).toContain('session.skill.activated');
  });
});

describe('usageByModel', () => {
  it('totals each step by model and prompt-size tier, children folded into the session', () => {
    const s = store(
      ev('session.created', { sessionID: ROOT }, 1),
      ev('session.created', { sessionID: KID, parentID: ROOT }, 2),
      stepWith(ROOT, 3, { id: 'big', providerID: 'p' }),
      stepEnd(ROOT, 4, 1000, 100, { read: 200, write: 50 }),
      stepWith(ROOT, 5, { id: 'big', providerID: 'p' }),
      stepEnd(ROOT, 6, 500, 20),
      stepWith(ROOT, 7, { id: 'big', providerID: 'p' }),
      stepEnd(ROOT, 8, 150_000, 30),
      stepWith(KID, 9, { id: 'small', providerID: 'q' }),
      stepEnd(KID, 10, 7, 3),
      stepWith(KID, 11, { id: 'big', providerID: 'p' }),
      stepEnd(KID, 12, 1, 1),
    );
    const r = buildReport(s.roots.get(ROOT)!, [], meta);
    const row = (rows: typeof r.session.usageByModel, model: string, tier: string) => rows!.find((u) => u.model === model && u.tier === tier)?.tokens;
    expect(row(r.session.usageByModel, 'big', 'std')).toEqual({ input: 1501, output: 121, cacheRead: 200, cacheWrite: 50, cacheWrite1h: 0 });
    expect(row(r.session.usageByModel, 'big', 'long')).toEqual({ input: 150_000, output: 30, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
    expect(row(r.session.usageByModel, 'small', 'std')).toMatchObject({ input: 7, output: 3 });
    expect(r.agents[0]!.usageByModel).toHaveLength(2);
  });

  it('counts nothing for a step that names no model', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), stepEnd(ROOT, 2, 10));
    expect(buildReport(s.roots.get(ROOT)!, [], meta).session.usageByModel).toEqual([]);
  });
});

describe('failure detail', () => {
  const setup = () => store(ev('session.created', { sessionID: ROOT }, 1), ev('session.created', { sessionID: KID, parentID: ROOT }, 2));
  const call = (s: ReturnType<typeof setup>, id: string, tool: string, input: Record<string, unknown>, t: number) => {
    apply(s, ev('session.tool.input.started', { sessionID: KID, id, name: tool }, t), t);
    apply(s, ev('session.tool.called', { sessionID: KID, id, input }, t + 1), t + 1);
  };
  // The record the agent holds, which a report carries only once the agent has failed (#1021); the detail tests read it directly.
  const failureOf = (s: ReturnType<typeof setup>) => s.roots.get(ROOT)!.sessions.get(KID)!.failure!;
  const reported = (s: ReturnType<typeof setup>) => buildReport(s.roots.get(ROOT)!, [], meta).agents[0]!;

  it('reports no failure for an agent that hit a failing call and finished normally, nor while it still runs (#1021)', () => {
    const s = setup();
    apply(s, ev('session.execution.started', { sessionID: KID }, 3), 3);
    call(s, 'c1', 'read', { filePath: '/nonexistent/file.txt' }, 4);
    apply(s, ev('session.tool.failed', { sessionID: KID, id: 'c1', error: { message: 'ENOENT' } }, 6), 6);
    expect(reported(s)).toMatchObject({ status: 'running', failure: null });
    apply(s, ev('session.execution.succeeded', { sessionID: KID }, 8), 8);
    expect(reported(s)).toMatchObject({ status: 'done', failure: null });
    // The call stays the candidate, so a later real failure is still blamed on it (#986).
    expect(s.roots.get(ROOT)!.sessions.get(KID)!.candidate).not.toBeNull();
  });

  it('still reports the failure of an agent whose run fails or is interrupted, with its class (#1021)', () => {
    const s = setup();
    call(s, 'c1', 'bash', { command: 'false' }, 4);
    apply(s, ev('session.tool.failed', { sessionID: KID, id: 'c1', error: { message: 'exit code 1' } }, 6), 6);
    apply(s, ev('session.execution.failed', { sessionID: KID, error: { message: 'stopped' } }, 7), 7);
    expect(reported(s)).toMatchObject({ status: 'failed', failure: { class: 'Tool error', tool: 'Bash' } });
    const t = setup();
    apply(t, ev('session.execution.interrupted', { sessionID: KID }, 7), 7);
    expect(reported(t)).toMatchObject({ status: 'aborted', failure: { class: 'Aborted' } });
  });

  it('keeps the error text of a failed run and of a failed step', () => {
    const s = setup();
    apply(s, ev('session.step.failed', { sessionID: KID, error: { type: 'api', message: 'rate limit hit\nretry later' } }, 3), 3);
    expect(failureOf(s)).toMatchObject({ class: 'Model API error', outputTail: ['rate limit hit', 'retry later'] });
    apply(s, ev('session.execution.failed', { sessionID: KID, error: { type: 'api', message: 'provider down' } }, 4), 4);
    expect(failureOf(s)).toMatchObject({ class: 'Model API error', tool: 'model request', outputTail: ['provider down'] });
  });

  it('classifies a run that auto-compacted three times as Context window exhausted, with the times as evidence (#986)', () => {
    const s = setup();
    for (const t of [10, 20, 30]) {
      apply(s, ev('session.compaction.started', { sessionID: KID, reason: 'auto' }, t), t);
      apply(s, ev('session.compaction.ended', { sessionID: KID, reason: 'auto' }, t + 1), t + 1);
    }
    // A manual compaction is not the window running out, and does not count.
    apply(s, ev('session.compaction.ended', { sessionID: KID, reason: 'manual' }, 40), 40);
    apply(s, ev('session.execution.failed', { sessionID: KID, error: { message: 'stopped' } }, 50), 50);
    expect(failureOf(s)).toMatchObject({ class: 'Context window exhausted', evidence: [expect.stringContaining('exceeded the context window 3 times')] });
  });

  it('counts compactions per run: those of an earlier run do not classify a later failure (#986)', () => {
    const s = setup();
    for (const t of [10, 20, 30]) apply(s, ev('session.compaction.ended', { sessionID: KID, reason: 'auto' }, t), t);
    apply(s, ev('session.execution.started', { sessionID: KID }, 40), 40);
    call(s, 'c1', 'bash', { command: 'false' }, 41);
    apply(s, ev('session.tool.failed', { sessionID: KID, id: 'c1', error: { message: 'exit code 1' } }, 43), 43);
    expect(failureOf(s)).toMatchObject({ class: 'Tool error', evidence: [] });
  });

  it('keeps a step failure after fewer than three auto-compactions out of that class, and carries the count to a failed call (#986)', () => {
    const s = setup();
    for (const t of [10, 20]) apply(s, ev('session.compaction.ended', { sessionID: KID, reason: 'auto' }, t), t);
    apply(s, ev('session.step.failed', { sessionID: KID, error: { message: 'boom' } }, 30), 30);
    expect(failureOf(s).class).toBe('Model API error');
    apply(s, ev('session.compaction.ended', { sessionID: KID, reason: 'auto' }, 40), 40);
    call(s, 'c9', 'bash', { command: 'npm test' }, 41);
    apply(s, ev('session.tool.failed', { sessionID: KID, id: 'c9', error: { message: 'exit code 1' } }, 43), 43);
    expect(failureOf(s)).toMatchObject({ class: 'Context window exhausted', evidence: [expect.stringContaining('3 times')] });
  });

  it('treats a shell call that exits non-zero as a failed call, with its exit code, though OpenCode 2.2.5 reports it as a success (#986)', () => {
    const s = setup();
    call(s, 'c1', 'shell', { command: 'exit 7' }, 3);
    apply(s, ev('session.tool.success', { sessionID: KID, id: 'c1', content: [{ type: 'text', text: 'oops\n' }, { type: 'text', text: 'Exited with code 7' }], metadata: { status: 'completed', truncated: false, exit: 7 } }, 5), 5);
    expect(failureOf(s)).toMatchObject({ class: 'Tool error', tool: 'Bash', call: 'exit 7', exitCode: 7 });
    const t2 = setup();
    call(t2, 'c1', 'shell', { command: 'x' }, 3);
    apply(t2, ev('session.tool.success', { sessionID: KID, id: 'c1', content: [{ type: 'text', text: 'Exited with code 9' }], metadata: { exit: 4 } }, 5), 5);
    expect(failureOf(t2).exitCode).toBe(4);
    // A failed call is a candidate for the failure, not an event of its own, as in Claude Code (#1012).
    expect(s.roots.get(ROOT)!.events.map((e) => e.text)).not.toContain('Bash failed');
  });

  it('takes the exit code from the metadata when the text does not state it, and ignores a zero exit, a missing one and a non-shell tool (#986)', () => {
    const s = setup();
    call(s, 'c1', 'shell', { command: 'run' }, 3);
    apply(s, ev('session.tool.success', { sessionID: KID, id: 'c1', content: [{ type: 'text', text: 'no code here' }], metadata: { exit: 2 } }, 5), 5);
    expect(failureOf(s).exitCode).toBe(2);
    const ok = setup();
    call(ok, 'c1', 'shell', { command: 'true' }, 3);
    apply(ok, ev('session.tool.success', { sessionID: KID, id: 'c1', metadata: { exit: 0 } }, 5), 5);
    call(ok, 'c2', 'shell', { command: 'true' }, 6);
    apply(ok, ev('session.tool.success', { sessionID: KID, id: 'c2', metadata: {} }, 8), 8);
    call(ok, 'c3', 'read', { filePath: '/x' }, 9);
    apply(ok, ev('session.tool.success', { sessionID: KID, id: 'c3', metadata: { exit: 3 } }, 11), 11);
    expect(ok.roots.get(ROOT)!.sessions.get(KID)!.failure).toBeNull();
  });

  it('says what model request failed, with the effort when known', () => {
    const s = setup();
    apply(s, stepWith(KID, 3, { id: 'm', providerID: 'p', variant: 'high' }), 3);
    apply(s, ev('session.execution.failed', { sessionID: KID, error: { message: 'x' } }, 4), 4);
    expect(failureOf(s).call).toBe('model request (m, effort high)');
  });

  it('classifies a rejected permission as Blocked by permission, even when the call then fails', () => {
    const s = setup();
    apply(s, ev('permission.asked', { id: 'per_1', sessionID: KID, action: 'bash', resources: ['rm -rf /'] }, 3), 3);
    call(s, 'c1', 'bash', { command: 'rm -rf /' }, 4);
    apply(s, ev('permission.replied', { sessionID: KID, requestID: 'per_1', reply: 'reject' }, 6), 6);
    apply(s, ev('session.tool.failed', { sessionID: KID, id: 'c1', error: { message: 'The user rejected this call' } }, 7), 7);
    expect(failureOf(s)).toMatchObject({ class: 'Blocked by permission', evidence: [expect.stringContaining('permission denied')] });
    apply(s, ev('session.execution.failed', { sessionID: KID, error: { message: 'stopped' } }, 8), 8);
    expect(failureOf(s).class).toBe('Blocked by permission');
  });

  it('does not treat an allowed permission as a denial', () => {
    const s = setup();
    apply(s, ev('permission.asked', { id: 'per_1', sessionID: KID, action: 'edit', resources: ['a.ts'] }, 3), 3);
    apply(s, ev('permission.replied', { sessionID: KID, requestID: 'per_1', reply: 'once' }, 4), 4);
    apply(s, ev('permission.replied', { sessionID: KID, requestID: 'unknown', reply: 'reject' }, 5), 5);
    apply(s, ev('session.execution.failed', { sessionID: KID, error: { message: 'x' } }, 6), 6);
    expect(failureOf(s).class).toBe('Model API error');
  });

  it('writes an evidence line when the same call failed twice', () => {
    const s = setup();
    for (const [i, id] of ['c1', 'c2'].entries()) {
      call(s, id, 'bash', { command: 'npm test' }, 10 + i * 10);
      apply(s, ev('session.tool.failed', { sessionID: KID, id, error: { message: 'exit code 1' } }, 12 + i * 10), 12 + i * 10);
    }
    apply(s, ev('session.execution.failed', { sessionID: KID, error: { message: 'gave up' } }, 40), 40);
    const f = failureOf(s);
    expect(f).toMatchObject({ class: 'Tool error', tool: 'Bash', exitCode: 1 });
    expect(f.evidence).toEqual(['same call failed 2 times: npm test']);
  });

  it('classifies an interruption as Aborted, and a stale failing call is not the cause', () => {
    const s = setup();
    apply(s, ev('session.execution.interrupted', { sessionID: KID }, 3), 3);
    expect(failureOf(s).class).toBe('Aborted');
    const t = setup();
    call(t, 'c1', 'bash', { command: 'x' }, 10);
    apply(t, ev('session.tool.failed', { sessionID: KID, id: 'c1', error: 'plain string error' }, 12), 12);
    apply(t, ev('session.execution.failed', { sessionID: KID, error: { message: 'late' } }, 12 + 120_000), 12 + 120_000);
    expect(failureOf(t)).toMatchObject({ class: 'Model API error', outputTail: ['late'] });
  });
});

describe('Reporter: changed files and the file diff on request', () => {
  /** A scripted repository: one modified file and one new file, and a diff for the modified one. */
  function repo(over: { diffExit?: number; paths?: string } = {}) {
    const calls: string[] = [];
    const run: Runner = async (argv) => {
      const a = argv.slice(1).join(' ');
      calls.push(a);
      if (a.endsWith('rev-parse --show-toplevel')) return { exitCode: 0, stdout: '/work/project\n' };
      if (a.endsWith('rev-parse HEAD')) return { exitCode: 0, stdout: 'aaaaaaa\n' };
      if (a.includes('merge-base --is-ancestor')) return { exitCode: 0, stdout: '' };
      if (a.includes('--name-status')) return { exitCode: 0, stdout: over.paths ?? 'M\0src/a.ts\0' };
      if (a.includes('--numstat')) return { exitCode: 0, stdout: '2\t1\tsrc/a.ts\0' };
      if (a.includes('ls-files')) return { exitCode: 0, stdout: 'notes.txt\0' };
      if (a.includes('grep')) return { exitCode: 0, stdout: 'notes.txt\x003\n' };
      if (a.includes('hash-object')) return { exitCode: 0, stdout: 'a'.repeat(40) + '\n' };
      if (a.includes(' diff ') || a.startsWith('diff ')) return { exitCode: over.diffExit ?? 0, stdout: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+token = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"\n' };
      return { exitCode: 1, stdout: '' };
    };
    return { run, calls };
  }

  function wired(run: Runner, extra: Record<string, unknown> = {}, reply: unknown | (() => unknown) = {}, idleMs = 60_000) {
    const posts: Report[] = [];
    const puts: { url: string; body: any }[] = [];
    const t = { now: 10_000 };
    const fetch: FetchLike = async (url, init) => {
      if (init.method === 'PUT') puts.push({ url, body: JSON.parse(init.body!) });
      else posts.push(JSON.parse(init.body!) as Report);
      return { status: 200, ok: true, text: init.method === 'PUT' ? '{}' : JSON.stringify(typeof reply === 'function' ? reply() : reply) };
    };
    const env = { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok', ...extra };
    const r = new Reporter({ fetch, now: () => t.now, runIn: () => run, log: () => undefined }, { ...optionsOf({}, null, env), idleMs });
    return { r, t, posts, puts };
  }

  it('reports the files the session changed, read in the session directory off the event loop', async () => {
    const { run } = repo();
    const { r, posts } = wired(run);
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    expect(r.store.roots.get(ROOT)!.files).toBeNull(); // handle returned before git answered
    await r.close();
    const files = posts.at(-1)!.session.files!;
    expect(files.since).toBe('start');
    expect(files.files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([['notes.txt', 'added', 3, 0], ['src/a.ts', 'modified', 2, 1]]);
    expect(files.total).toBe(2);
  });

  it('keeps the starting commit it first read, so the list stays "since the session began"', async () => {
    const { run, calls } = repo();
    const { r, t } = wired(run);
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await r.close();
    expect(r.store.roots.get(ROOT)!.gitBase).toBe('aaaaaaa');
    expect(calls.some((c) => c.includes('diff --name-status -z -M aaaaaaa'))).toBe(true);
    expect(t.now).toBe(10_000);
  });

  it('leaves files out of the report when git fails, and sends a long path cut', async () => {
    const { r, posts } = wired(async () => ({ exitCode: 128, stdout: '' }));
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await r.close();
    expect(posts.at(-1)!.session.files).toBeNull();
    const long = 'x'.repeat(400);
    const { run } = repo({ paths: `M\0${long}\0` });
    const w = wired(run);
    w.r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await w.r.close();
    expect(w.posts.at(-1)!.session.files!.files.every((f) => f.path.length <= 300)).toBe(true);
  });

  it('says whether the file diff is on, and the preload, in every report', async () => {
    const off = wired(repo().run);
    off.r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await off.r.tick();
    expect(off.posts[0]!.session).toMatchObject({ fileDiff: false, fileDiffPreload: false });
    const on = wired(repo().run, { PODIUM_FILE_DIFF: 'true' });
    on.r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await on.r.tick();
    expect(on.posts[0]!.session).toMatchObject({ fileDiff: true, fileDiffPreload: true });
    const some = new Reporter({ fetch: async () => okReply, now: () => 1, runIn: () => noGit, log: () => undefined }, { ...optionsOf({ fileDiffPreload: false }, null, { PODIUM_FILE_DIFF: 'true' }), idleMs: 60_000 });
    expect(some.opts).toMatchObject({ fileDiff: true, fileDiffPreload: false });
  });

  it('answers a listed diff request once, redacted, with the same reply shape as the Claude Code reporter', async () => {
    const { run } = repo();
    const { r, t, puts } = wired(run, { PODIUM_FILE_DIFF: 'true' }, { diffs: [{ id: 'd1', path: 'src/a.ts' }] });
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await new Promise((res) => setTimeout(res, 20)); // the file list is read in the background
    await r.tick();
    t.now += 5000;
    await r.tick(); // the same request again in the next reply
    await r.close();
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe('http://podium.test/api/fleet/sessions/ses_root/diffs/d1');
    expect(puts[0]!.body).toMatchObject({ path: 'src/a.ts', status: 'ok', truncated: false, base: 'aaaaaaa' });
    expect(puts[0]!.body.text).toContain('+new');
    expect(puts[0]!.body.text).not.toContain('sk-ant-api03');
    expect(puts[0]!.body.redactions).toBeGreaterThan(0);
  });

  it('answers unavailable for a path the list does not name, and reads nothing for it', async () => {
    const { run, calls } = repo();
    const { r, puts } = wired(run, { PODIUM_FILE_DIFF: 'true' }, { diffs: [{ id: 'd2', path: 'other.ts' }] });
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await new Promise((res) => setTimeout(res, 20));
    await r.tick();
    await r.close();
    expect(puts.map((p) => [p.body.path, p.body.status])).toEqual([['other.ts', 'unavailable']]);
    expect(calls.filter((c) => c.includes('other.ts'))).toEqual([]);
  });

  it('reads nothing and answers nothing while the file diff is off', async () => {
    const { run } = repo();
    const { r, puts } = wired(run, {}, { diffs: [{ id: 'd1', path: 'src/a.ts' }] });
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await new Promise((res) => setTimeout(res, 20));
    await r.tick();
    await r.close();
    expect(puts).toEqual([]);
  });

  it('forgets the oldest answered ids past a limit, and answers unavailable when git is gone', async () => {
    let n = 0;
    const { r, t, puts } = wired(async () => { throw new Error('git is gone'); }, { PODIUM_FILE_DIFF: 'true' }, () => ({ diffs: Array.from({ length: 4 }, () => ({ id: `d${n++ % 205}`, path: 'src/a.ts' })) }), 10 ** 9);
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    for (let i = 0; i < 120; i++) {
      t.now += 5000;
      await r.tick();
    }
    await r.close();
    // Requests cycle over 205 ids: the oldest id has left the 200 kept, so it is answered a second time.
    expect(puts.length).toBeGreaterThan(205);
    expect(puts.every((p) => p.body.status === 'unavailable')).toBe(true);
  });

  it('does not let a failing answer call stop the reporter', async () => {
    const { run } = repo();
    const t = { now: 10_000 };
    const fetch: FetchLike = async (_u, init) => {
      if (init.method === 'PUT') throw new Error('offline');
      return { status: 200, ok: true, text: JSON.stringify({ diffs: [{ id: 'd1', path: 'src/a.ts' }] }) };
    };
    const r = new Reporter({ fetch, now: () => t.now, runIn: () => run, log: () => undefined }, { ...optionsOf({}, null, { PODIUM_FILE_DIFF: 'true' }), idleMs: 60_000 });
    r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
    await new Promise((res) => setTimeout(res, 20));
    await r.tick();
    await expect(r.close()).resolves.toBeUndefined();
  });
});

// What a real OpenCode 2.2.5 sends (seen in a live run, #969): the shell tool is `shell`, a file tool takes `path`, the skill tool takes `id` and
// reports no `session.skill.activated`, a subagent is launched by `subagent`, and a compaction says how it was started.
describe('OpenCode 2.2.5 tools and events (#969)', () => {
  const run = (sid: string, id: string, name: string, input: Record<string, unknown>, at: number, result?: Record<string, unknown>) => [
    ev('session.tool.input.started', { sessionID: sid, id, name }, at),
    ev('session.tool.called', { sessionID: sid, id, input }, at + 1),
    ev('session.tool.success', { sessionID: sid, id, content: [{ type: 'text', text: 'ok' }], ...(result ? { metadata: result } : {}) }, at + 2),
  ];
  const sessOf = (s: ReturnType<typeof store>, sid = ROOT) => s.roots.get(ROOT)!.sessions.get(sid)!;

  it('counts the tools under the Claude Code reporter\'s names', () => {
    const s = store(
      ev('session.created', { sessionID: ROOT }, 1),
      ...run(ROOT, 'a', 'shell', { command: 'echo hi' }, 2), ...run(ROOT, 'b', 'bash', { command: 'ls' }, 5), ...run(ROOT, 'c', 'read', { path: 'a.txt' }, 8),
      ...run(ROOT, 'd', 'write', { path: 'a.txt', content: 'x' }, 11), ...run(ROOT, 'e', 'edit', { path: 'a.txt', oldString: 'x', newString: 'y' }, 14),
      ...run(ROOT, 'f', 'glob', { pattern: '*.txt' }, 17), ...run(ROOT, 'g', 'grep', { pattern: 'y' }, 20), ...run(ROOT, 'h', 'subagent', { agent: 'general', description: 'look', prompt: 'p' }, 23),
      ...run(ROOT, 'i', 'webfetch', { url: 'http://x.test' }, 26), ...run(ROOT, 'j', 'question', { questions: [] }, 29), ...run(ROOT, 'k', 'mcp_thing', {}, 32),
    );
    const k = sessOf(s);
    expect(k.toolCounts).toEqual({ Bash: 2, Read: 1, Write: 1, Edit: 1, Glob: 1, Grep: 1, Agent: 1, WebFetch: 1, AskUserQuestion: 1, mcp_thing: 1 });
    expect(k.lastTool).toBe('mcp_thing');
  });

  it('names a failed shell call by its command and keeps its exit code, as for Bash', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.tool.input.started', { sessionID: ROOT, id: 'a', name: 'shell' }, 2), ev('session.tool.called', { sessionID: ROOT, id: 'a', input: { command: 'make test' } }, 3), ev('session.tool.failed', { sessionID: ROOT, id: 'a', error: { message: 'Exit code 2' } }, 4));
    const f = sessOf(s).failure!;
    expect(f).toMatchObject({ tool: 'Bash', call: 'make test', exitCode: 2 });
  });

  it('names a failed file read by its path', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.tool.input.started', { sessionID: ROOT, id: 'a', name: 'read' }, 2), ev('session.tool.called', { sessionID: ROOT, id: 'a', input: { path: '/nonexistent/file.txt' } }, 3), ev('session.tool.failed', { sessionID: ROOT, id: 'a', error: { message: 'not found' } }, 4));
    expect(sessOf(s).failure).toMatchObject({ tool: 'Read', call: 'Read /nonexistent/file.txt' });
  });

  it('records a skill when its tool succeeds, from the skill the result names, once each', () => {
    const s = store(
      ev('session.created', { sessionID: ROOT }, 1),
      ...run(ROOT, 'a', 'skill', { id: 'hello' }, 2, { name: 'hello', directory: '/p' }),
      ...run(ROOT, 'b', 'skill', { id: 'hello' }, 5, { name: 'hello' }),
      ...run(ROOT, 'c', 'skill', { id: 'pdf' }, 8),
    );
    expect(sessOf(s).skills).toEqual(['hello', 'pdf']);
    expect(s.roots.get(ROOT)!.events.filter((e) => e.kind === 'skill').map((e) => e.text)).toEqual(['hello loaded into orchestrator', 'pdf loaded into orchestrator']);
  });

  it('records no skill when the skill tool failed', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.tool.input.started', { sessionID: ROOT, id: 'a', name: 'skill' }, 2), ev('session.tool.called', { sessionID: ROOT, id: 'a', input: { id: 'nope' } }, 3), ev('session.tool.failed', { sessionID: ROOT, id: 'a', error: { message: 'no such skill' } }, 4));
    expect(sessOf(s).skills).toEqual([]);
  });

  it('builds the plan from the todo tool a call at a time, in the orchestrator only', () => {
    const todo = (sid: string, id: string, status: string, at: number) => run(sid, id, 'todowrite', { todos: [{ content: 'write a file', status }] }, at, { todos: [{ content: 'write a file', status }] });
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.created', { sessionID: KID, parentID: ROOT }, 2), ...todo(KID, 'k', 'pending', 3), ...todo(ROOT, 'a', 'pending', 6), ...todo(ROOT, 'b', 'completed', 9));
    const root = s.roots.get(ROOT)!;
    expect(root.plan.tasks.map((t) => [t.text, t.status])).toEqual([['write a file', 'completed']]);
    expect(buildReport(root, [], { now: 12, version: VERSION, engineVersion: null, hostSurface: null }).session.plan!.steps.map((p) => p.state)).toEqual(['done']);
  });

  it('shows a plan the plan tool named even before any step is known, and the steps when they come', () => {
    const meta = { now: 12, version: VERSION, engineVersion: null, hostSurface: null };
    const s = store(ev('session.created', { sessionID: ROOT }, 1));
    const root = s.roots.get(ROOT)!;
    expect(buildReport(root, [], meta).session.plan).toBeNull();
    root.plan = setTitle(root.plan, { title: 'Ship it', phase: 'one' });
    expect(buildReport(root, [], meta).session.plan).toEqual({ title: 'Ship it · one', source: 'podium_plan', steps: [] });
    apply(s, ev('session.tool.called', { sessionID: ROOT, id: 't', name: 'todowrite', input: { todos: [{ content: 'A', status: 'pending' }] } }, 3), 3);
    expect(buildReport(root, [], meta).session.plan).toMatchObject({ title: 'Ship it · one', source: 'todowrite', steps: [{ text: 'A' }] });
  });

  it('counts a compaction, says how it began, and drops the context to the size of the summary it wrote', () => {
    const s = store(
      ev('session.created', { sessionID: ROOT }, 1),
      step(ROOT, 2),
      ev('session.step.ended', { sessionID: ROOT, tokens: { input: 9000, output: 5, reasoning: 0, cache: { read: 1000, write: 0 } } }, 3),
      ev('session.compaction.started', { sessionID: ROOT, reason: 'auto' }, 4),
    );
    const root = s.roots.get(ROOT)!;
    expect(sessOf(s).ctxTokens).toBe(10_000);
    apply(s, ev('session.compaction.ended', { sessionID: ROOT, reason: 'auto', text: 'summary', tokens: { input: 6000, output: 97, reasoning: 2514, cache: { read: 0, write: 0 } } }, 5), 5);
    expect(root.compactions).toBe(1);
    expect(sessOf(s).ctxTokens).toBe(97);
    expect(sessOf(s).blowouts).toBe(1);
    expect(root.events.find((e) => e.kind === 'compact')).toMatchObject({ text: 'auto-compacted', data: { trigger: 'auto', tokensBefore: 10_000, tokensAfter: 97 } });
    apply(s, step(ROOT, 6), 6);
    apply(s, ev('session.step.ended', { sessionID: ROOT, tokens: { input: 400, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }, 7), 7);
    expect(sessOf(s).ctxTokens).toBe(400);
    expect(buildReport(root, [], { now: 8, version: VERSION, engineVersion: null, hostSurface: null }).session.blowouts).toBe(1);
  });

  it('counts a manual compaction without a blowout, and a failed one without changing the context', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.step.ended', { sessionID: ROOT, tokens: { input: 500 } }, 2), ev('session.compaction.started', { sessionID: ROOT, reason: 'manual' }, 3));
    apply(s, ev('session.compaction.ended', { sessionID: ROOT, reason: 'manual', tokens: { input: 500, output: 40 } }, 4), 4);
    apply(s, ev('session.compaction.failed', { sessionID: ROOT, reason: 'auto', error: { message: 'x' } }, 5), 5);
    expect(s.roots.get(ROOT)!.compactions).toBe(2);
    expect(sessOf(s).blowouts).toBe(0);
    expect(sessOf(s).ctxTokens).toBe(40);
    expect(s.roots.get(ROOT)!.events.map((e) => e.text)).toContain('compaction failed');
  });

  it('keeps the context fill when a compaction ends with no output tokens', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.step.ended', { sessionID: ROOT, tokens: { input: 500 } }, 2), ev('session.compaction.started', { sessionID: ROOT, reason: 'manual' }, 3));
    apply(s, ev('session.compaction.ended', { sessionID: ROOT, reason: 'manual' }, 4), 4);
    expect(sessOf(s).ctxTokens).toBe(500);
    apply(s, ev('session.compaction.ended', { sessionID: ROOT, reason: 'manual', tokens: { input: 5, output: 0 } }, 5), 5);
    expect(sessOf(s).ctxTokens).toBe(500);
  });

  it('records a subagent compaction under its own loop and leaves the /compact Podium sent for the orchestrator', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.created', { sessionID: KID, parentID: ROOT }, 2));
    const root = s.roots.get(ROOT)!;
    const marks: { loop: string; by: string | undefined }[] = [];
    root.recorder.compact = (loop, _at, by) => void marks.push({ loop, by });
    root.podiumCompact = 'Ed';
    apply(s, ev('session.compaction.started', { sessionID: KID, reason: 'auto' }, 3), 3);
    expect(marks).toEqual([{ loop: KID, by: undefined }]);
    expect(root.podiumCompact).toBe('Ed');
    apply(s, ev('session.compaction.started', { sessionID: ROOT, reason: 'manual' }, 4), 4);
    expect(marks[1]).toEqual({ loop: '@orchestrator', by: 'Ed' });
    expect(root.podiumCompact).toBeNull();
  });
});

describe('Reporter: the place of the session (#987)', () => {
  const gitRun: Runner = async (argv) => {
    const cmd = argv.join(' ');
    if (cmd.includes('--git-common-dir')) return { exitCode: 0, stdout: '/work/project/.git\n' };
    if (cmd.includes('remote.origin.url')) return { exitCode: 0, stdout: 'https://github.com/acme/project.git\n' };
    return { exitCode: 1, stdout: '' };
  };
  it('reports the project root and owner/name from the origin once git has been read', async () => {
    const bodies: Report[] = [];
    const { r } = reporter(async (_u, init) => { bodies.push(JSON.parse(init.body!) as Report); return okReply; }, gitRun);
    r.handle(ev('session.created', { sessionID: ROOT, location: { directory: '/work/project/sub' } }, 10_000));
    await r.close();
    expect(bodies.at(-1)!.session).toMatchObject({ cwd: '/work/project/sub', projectRoot: '/work/project', repoName: 'acme/project' });
  });
  it('starts with the folder it knows and the folder name before git has answered', () => {
    const root = store(ev('session.created', { sessionID: ROOT, location: { directory: '/work/project' } }, 1)).roots.get(ROOT)!;
    const rep = buildReport(root, [], { now: 2, version: VERSION, engineVersion: null, hostSurface: null });
    expect(rep.session).toMatchObject({ projectRoot: '/work/project', repoName: 'project' });
  });
});

describe('Reporter: background work and attached (#987)', () => {
  const start = (r: Reporter) => r.handle(ev('session.created', { sessionID: ROOT, location: { directory: '/work/project' } }, 10_000));
  const lastOf = async (bodies: Report[], r: Reporter) => { await r.tick(); return bodies.at(-1)!.session; };
  const collect = (bodies: Report[]): FetchLike => async (_u, init) => { bodies.push(JSON.parse(init.body!) as Report); return okReply; };

  it('says what an idle session still runs, and that it is not waiting on the person', async () => {
    const bodies: Report[] = [];
    const { r } = reporter(collect(bodies));
    start(r);
    r.background(ROOT, [
      { kind: 'shell', sessionID: ROOT, shellID: 's1', command: 'npm run dev -- --token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz\nsecond line' },
      { kind: 'subagent', sessionID: ROOT, childSessionID: 'ses_c', agent: 'general', description: 'Scan the repo' },
      { kind: 'image', sessionID: ROOT, path: '/tmp/a.png', model: 'img' },
    ]);
    const s = await lastOf(bodies, r);
    expect(s).toMatchObject({ status: 'waiting', waitReason: null });
    expect(s.background).toEqual({
      tasks: [
        { type: 'shell', description: 'npm', status: 'running' },
        { type: 'agent', description: 'Scan the repo', status: 'running' },
        { type: 'other', description: 'image', status: 'running' },
      ],
      wakeAt: null,
    });
    expect(JSON.stringify(s.background)).not.toContain('sk-ant');
    expect(JSON.stringify(s.background)).not.toMatch(/second line|--token|run dev/);
  });
  it('leaves it out for an empty list, an unknown session, and once a run starts again', async () => {
    const bodies: Report[] = [];
    const { r } = reporter(collect(bodies));
    start(r);
    r.background('ses_nobody', [{ kind: 'shell', sessionID: 'ses_nobody', shellID: 's', command: 'x' }]);
    r.background(ROOT, []);
    expect((await lastOf(bodies, r)).background).toBeUndefined();
    const again = [] as Report[];
    const second = reporter(collect(again));
    start(second.r);
    second.r.background(ROOT, [{ kind: 'shell', sessionID: ROOT, shellID: 's', command: 'sleep 9' }]);
    second.r.handle(ev('session.execution.started', { sessionID: ROOT }, 10_001));
    const s = await lastOf(again, second.r);
    expect(s.background).toBeUndefined();
    expect(s.status).toBe('running');
  });
  it('reports a question as the wait even with background work', async () => {
    const bodies: Report[] = [];
    const { r } = reporter(collect(bodies));
    start(r);
    r.handle({ type: 'permission.asked', data: { id: 'p1', sessionID: ROOT, action: 'bash', resources: ['ls'] } });
    r.background(ROOT, [{ kind: 'shell', sessionID: ROOT, shellID: 's', command: 'sleep 9' }]);
    expect(await lastOf(bodies, r)).toMatchObject({ status: 'waiting', waitReason: 'permission' });
  });
  it('reports attached true while a TUI part is attached, and null (never false) when none is or the host cannot say', async () => {
    // false would make the server hide the card after a minute: an OpenCode run with no TUI part (serve, the desktop app, `opencode run`) is still a live session.
    for (const [attached, want] of [[() => true, true], [() => false, null], [undefined, null]] as const) {
      const bodies: Report[] = [];
      const r = new Reporter({ fetch: collect(bodies), now: () => 10_000, runIn: () => noGit, log: () => undefined, ...(attached ? { attached } : {}) }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok' }), idleMs: 60_000 });
      start(r);
      expect((await lastOf(bodies, r)).attached).toBe(want);
    }
  });
  it('keeps at most 20 background tasks, names a shell by its first word and never sends the rest of its command', async () => {
    const bodies: Report[] = [];
    const { r } = reporter(collect(bodies));
    start(r);
    const jobs = Array.from({ length: 30 }, (_, i) => ({ kind: 'shell', sessionID: ROOT, shellID: `s${i}`, command: `API_KEY=hunter2 /usr/bin/curl -u user:pass https://x.test/${i}` }));
    r.background(ROOT, [...jobs, { kind: 'shell', sessionID: ROOT, shellID: 'e', command: '' }]);
    const s = await lastOf(bodies, r);
    expect(s.background!.tasks).toHaveLength(20);
    expect(s.background!.tasks[0]).toEqual({ type: 'shell', description: 'curl', status: 'running' });
    expect(JSON.stringify(s.background)).not.toMatch(/hunter2|user:pass|x\.test/);
    const empty = [] as Report[];
    const e = reporter(collect(empty));
    start(e.r);
    e.r.background(ROOT, [{ kind: 'shell', sessionID: ROOT, shellID: 'e', command: '' }, { kind: 'subagent', sessionID: ROOT, childSessionID: 'c', agent: 'g', description: '' }]);
    expect((await lastOf(empty, e.r)).background!.tasks).toEqual([
      { type: 'shell', description: 'shell', status: 'running' },
      { type: 'agent', description: 'subagent', status: 'running' },
    ]);
  });
  it('ignores the idle hook of a child session: only the root lists the work of the whole tree', async () => {
    const bodies: Report[] = [];
    const { r } = reporter(collect(bodies));
    start(r);
    r.handle(ev('session.created', { sessionID: KID, parentID: ROOT, title: 'child' }, 10_001));
    r.background(ROOT, [{ kind: 'shell', sessionID: ROOT, shellID: 's', command: 'sleep 9' }]);
    r.background(KID, []);
    expect((await lastOf(bodies, r)).background!.tasks).toHaveLength(1);
  });
});

describe('Reporter: a dev build says so (#987)', () => {
  it('puts the build in the report the reporter sends, and leaves the field out for a release', async () => {
    for (const [build, want] of [['a1b2c3d4-dirty', 'a1b2c3d4-dirty'], [null, undefined]] as const) {
      const bodies: Report[] = [];
      const r = new Reporter({ fetch: async (_u, init) => { bodies.push(JSON.parse(init.body!) as Report); return okReply; }, now: () => 10_000, runIn: () => noGit, log: () => undefined }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok' }), build, idleMs: 60_000 });
      r.handle(ev('session.created', { sessionID: ROOT }, 10_000));
      await r.tick();
      expect(bodies.at(-1)!.reporter.build).toBe(want);
    }
  });
});

describe('Reporter: /podium name (#987)', () => {
  const collect = (bodies: Report[]): FetchLike => async (_u, init) => { bodies.push(JSON.parse(init.body!) as Report); return okReply; };
  const start = (r: Reporter, id = ROOT) => r.handle(ev('session.created', { sessionID: id, title: 'OpenCode title', location: { directory: '/work/project' } }, 10_000));

  it('names the root, over OpenCode\'s title, from the root or from a child session, and says which root to keep it for', async () => {
    const bodies: Report[] = [];
    const { r } = reporter(collect(bodies));
    start(r);
    r.handle(ev('session.created', { sessionID: KID, parentID: ROOT, title: 'child' }, 10_001));
    expect(r.rename(KID, 'Silverbolt')).toBe(ROOT);
    await r.tick();
    expect(bodies.at(-1)!.session.name).toBe('Silverbolt');
    expect(r.rename('ses_nobody', 'x')).toBeNull();
  });
  it('asks once for a name kept before a reload, and a name typed since wins over it', async () => {
    const asked: string[] = [];
    const bodies: Report[] = [];
    const r = new Reporter({ fetch: collect(bodies), now: () => 10_000, runIn: () => noGit, log: () => undefined, loadName: async (id) => (asked.push(id), 'Kept name') }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok' }), idleMs: 60_000 });
    start(r);
    start(r);
    await r.tick();
    await new Promise((res) => setTimeout(res, 0));
    await r.tick();
    expect(asked).toEqual([ROOT]);
    expect(bodies.at(-1)!.session.name).toBe('Kept name');
    const typed = new Reporter({ fetch: collect(bodies), now: () => 10_000, runIn: () => noGit, log: () => undefined, loadName: async () => 'Old' }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok' }), idleMs: 60_000 });
    start(typed);
    typed.rename(ROOT, 'New');
    await new Promise((res) => setTimeout(res, 0));
    await typed.tick();
    expect(bodies.at(-1)!.session.name).toBe('New');
    const none = new Reporter({ fetch: collect(bodies), now: () => 10_000, runIn: () => noGit, log: () => undefined, loadName: async () => { throw new Error('no storage'); } }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok' }), idleMs: 60_000 });
    start(none);
    await new Promise((res) => setTimeout(res, 0));
    await none.tick();
    expect(bodies.at(-1)!.session.name).toBe('OpenCode title');
  });
});
