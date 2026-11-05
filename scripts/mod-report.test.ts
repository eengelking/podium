// Cross-check between the reporter mod and the server: a Report the mod's own reducers build from a
// scripted session must pass the server's validator unchanged and ingest into a sensible view.
// (The mod's tests run in the hooks sandbox, which cannot reach the server code.)
import { describe, it, expect } from 'vitest';
import { scriptedReport, scriptedState, T0 } from '../plugin/claudecode/hooks/scripted.ts';
import { compaction, drainEvents, measure, newSession, resetForNewId, setIdentity, step } from '../plugin/claudecode/hooks/state.ts';
import { buildReport } from '../plugin/claudecode/hooks/report.ts';
import { planAsk, questionAsk, respondInfo, toolAsk } from '../plugin/claudecode/hooks/respond.ts';
import { validateReport } from '../server/src/fleet/protocol.ts';
import { openSqliteStorage } from '../server/src/storage/sqlite/index.ts';
import { DEFAULT_CONFIG, Fleet } from '../server/src/fleet/fleet.ts';

describe('mod report -> server', () => {
  it('validates without any clamping', () => {
    const report = scriptedReport();
    const v = validateReport(JSON.parse(JSON.stringify(report)));
    if (!v.ok) throw new Error(`${v.path}: ${v.error}`);
    // The server reads the legacy name the mod sends as the Claude Code reporter (#967); nothing else changes.
    expect(v.report).toEqual({ ...report, reporter: { ...report.reporter, name: 'podium-reporter-claudecode' } });
  });

  it('ingests into a view with the plan, agents, failure and blowout level', async () => {
    const fleet = new Fleet(openSqliteStorage(':memory:'), { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, () => 1_800_000_016_000);
    await fleet.init();
    await fleet.ingest(scriptedReport());
    const view = (await fleet.view('sess-1'))!;
    expect(view.project).toBe('~/app');
    expect(view.agents.map((a) => [a.id, a.status, a.modelFamily])).toEqual([['a1', 'done', 'haiku'], ['a2', 'running', 'opus'], ['a3', 'failed', 'sonnet']]);
    expect(view.blowouts).toMatchObject({ orchestrator: 2, agents: 1, total: 3, level: 2 });
    expect(view.blowouts.log).toHaveLength(3);
    expect(view.plan?.title).toBe('Migrate');
    fleet.close();
  });

  it('validates the responding fields the mod sends (#206) without any clamping', () => {
    const asks = [
      questionAsk('toolu_q', null, { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b', preview: 'x' }] }] }, T0)!,
      planAsk('toolu_p', null, { plan: '# Plan\n\n1. Go', planFilePath: '/Users/dev/.claude/plans/p.md' }, T0),
      toolAsk('toolu_t', 'agent-1', 'Bash', { command: 'git push', description: 'Push' }, T0),
    ];
    const report = buildReport(scriptedState(), [], { version: '0.14.0', engineVersion: '2.1.301', hostSurface: 'terminal', now: T0, storedName: null, optionName: null, respond: respondInfo('everything', true, true, false), asks, clearedFrom: 'sess-0' });
    const v = validateReport(JSON.parse(JSON.stringify(report)));
    if (!v.ok) throw new Error(`${v.path}: ${v.error}`);
    expect(v.report.session.respond).toEqual({ level: 'everything', accepts: ['question', 'message', 'plan-feedback', 'command'], limits: ['no-permission-hooks'] });
    expect(v.report.session.asks).toEqual(asks);
    expect(v.report.session.clearedFrom).toBe('sess-0');
  });
});

// #1007: the server rejects a fractional time or token count with a 400 for the whole report, so the session would vanish from
// the wall. A figure the host app supplies is not ours to trust: Claude Code's `$.session.usage()` (startedAt, context.tokens,
// context.window), a compaction's tokensBefore / tokensAfter and the usage block of a model request. Each must leave the reducers whole.
describe('mod report -> server, with fractions from the host (#1007)', () => {
  const FRAC = 1000.5;
  const BIG = 1_800_000_000_000.5;
  const meta = { version: '0.14.0', engineVersion: '2.1.301', hostSurface: 'terminal', storedName: null, claudeName: null, optionName: null } as const;
  const validated = (s: ReturnType<typeof scriptedState>) => {
    const [state, events] = drainEvents(s);
    const report = buildReport(state, events, { ...meta, now: T0 + 20_000 });
    const v = validateReport(JSON.parse(JSON.stringify(report)));
    if (!v.ok) throw new Error(`${v.path}: ${v.error}`);
    return v.report;
  };

  it('rounds the session start and the context figures from $.session.usage()', () => {
    const s = measure(scriptedState(), { startedAt: BIG, context: { tokens: FRAC, window: 200_000.5, percent: 0.5 } });
    const r = validated(s);
    expect(Number.isInteger(r.session.startedAt)).toBe(true);
    expect(Number.isInteger(r.session.context.tokens)).toBe(true);
    expect(Number.isInteger(r.session.context.window)).toBe(true);
  });

  it('keeps the known start when the host sends a start that rounds to zero, and rounds a start given as identity', () => {
    const before = scriptedState();
    expect(measure(before, { startedAt: 0.4 }).startedAt).toBe(before.startedAt);
    const r = validated(setIdentity(scriptedState(), { startedAt: BIG }));
    expect(Number.isInteger(r.session.startedAt)).toBe(true);
  });

  it('rounds a fractional start of a new session and of one cleared into a new id', () => {
    const a = validated(newSession({ id: 'x', cwd: '/Users/dev/app', startedAt: BIG, model: 'claude-opus-5-5' }));
    expect(Number.isInteger(a.session.startedAt)).toBe(true);
    const b = validated(resetForNewId(scriptedState(), 'x2', BIG));
    expect(Number.isInteger(b.session.startedAt)).toBe(true);
  });

  it('rounds fractional compaction counts, for the main loop and an agent, auto and manual', () => {
    let s = scriptedState();
    s = compaction(s, { trigger: 'auto', tokensBefore: 990_000.5, tokensAfter: FRAC }, T0 + 30_000);
    s = compaction(s, { trigger: 'manual', tokensBefore: 500_000.5, tokensAfter: 100_000.25 }, T0 + 31_000);
    s = compaction(s, { agentId: 'a2', trigger: 'plugin', tokensBefore: 10.5, tokensAfter: 5.5 }, T0 + 32_000);
    s = compaction(s, { agentId: 'a3', trigger: 'auto', tokensBefore: 990_000.5, tokensAfter: 300_000.5 }, T0 + 40_000);
    const r = validated(s);
    const counts = r.events.filter((e) => e.kind === 'compact' || e.kind === 'blow').flatMap((e) => [e.data?.tokensBefore, e.data?.tokensAfter]);
    expect(counts.filter((n) => typeof n === 'number').every(Number.isInteger)).toBe(true);
    for (const a of r.agents) expect(a.context.tokens === null || Number.isInteger(a.context.tokens)).toBe(true);
    expect(r.session.context.tokens === null || Number.isInteger(r.session.context.tokens)).toBe(true);
  });

  it('rounds fractional token usage of a model request, for the main loop and an agent', () => {
    const usage = { input_tokens: 10.5, output_tokens: 20.5, cache_read_input_tokens: 30.5, cache_creation_input_tokens: 40.5, cache_creation: { ephemeral_1h_input_tokens: 5.5 } };
    let s = step(scriptedState(), { model: 'claude-opus-5-5', usage, stopReason: 'tool_use' }, T0 + 20_000);
    s = step(s, { agentId: 'a1', model: 'claude-haiku-5-5', usage, stopReason: 'tool_use' }, T0 + 21_000);
    const r = validated(s);
    for (const t of [r.session.tokens, ...r.agents.map((a) => a.tokens)]) for (const n of Object.values(t)) expect(Number.isInteger(n)).toBe(true);
  });
});
