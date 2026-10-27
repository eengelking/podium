import { describe, test, expect } from 'claude-code/testing'
import { agentReport, buildReport } from './report.ts'
import { scriptedReport, scriptedState, T0 } from './scripted.ts'
import { MAIN_LOOP } from './protocol.ts'
import { ACTIVITY_KEPT, addActivity, agentRequested, agentSpawned, finishActivity, isWatched, isWatchedOutput, setWatched, setWatchedOutput, blowout, compaction, describeBackground, markTextSent, newSession, reconcile, resetForNewId, sessionEnd, setAttached, setBackground, setExplanation, step, toolResult, turnComplete } from './state.ts'

// The key sets of docs/fixtures/report.sample.json, so a built Report has the shared fixture's shape.
const REPORT_KEYS = ['agents', 'events', 'reporter', 'sentAt', 'session', 'v']
const SESSION_KEYS = ['activityFeed', 'activityOutput', 'attached', 'blowouts', 'context', 'costUsd', 'cwd', 'effort', 'endReason', 'fileDiff', 'files', 'git', 'id', 'loop', 'model', 'name', 'peers', 'plan', 'projectRoot', 'rateLimits', 'repoName', 'resumeId', 'sessionRecording', 'startedAt', 'status', 'tokens', 'usageByModel', 'waitNote', 'waitReason']
const AGENT_KEYS = ['answerExcerpt', 'blowouts', 'context', 'costUsdEst', 'description', 'effort', 'effortSource', 'endedAt', 'failure', 'id', 'kind', 'lastTool', 'model', 'name', 'parentId', 'promptExcerpt', 'skills', 'startedAt', 'status', 'steps', 'tokens', 'toolCalls', 'toolCounts', 'type', 'usageByModel']
const FAILURE_KEYS = ['at', 'call', 'class', 'evidence', 'exitCode', 'explanation', 'outputTail', 'retriedAs', 'tool']
const STEP_KEYS = ['activeText', 'id', 'ownerAgentId', 'ownerLabel', 'state', 'text']
const keys = (o: object) => Object.keys(o).sort()

describe('scripted session -> Report', () => {
  const r = scriptedReport()

  test('has the shared fixture shape, with nothing omitted', () => {
    expect(keys(r)).toEqual(REPORT_KEYS)
    expect(keys(r.session)).toEqual(SESSION_KEYS)
    for (const a of r.agents) expect(keys(a)).toEqual(AGENT_KEYS)
    expect(keys(r.agents.find((a) => a.failure)!.failure!)).toEqual(FAILURE_KEYS)
    for (const st of r.session.plan!.steps) expect(keys(st)).toEqual(STEP_KEYS)
    expect(r.v).toBe(1)
    expect(r.reporter.name).toBe('podium-reporter')
  })

  test('session figures', () => {
    // the fork still runs, so the session is running although the main loop is idle
    expect(r.session).toMatchObject({ id: 'sess-1', name: 'x', status: 'running', waitReason: null, model: 'claude-opus-5-5', effort: 'high', costUsd: 3.21, blowouts: 2, repoName: 'acme/app' })
    expect(r.session.context).toEqual({ tokens: 100_000, window: 1_000_000, percent: 10 })
    expect(r.session.tokens).toEqual({ input: 1000, output: 100, cacheRead: 50_000, cacheWrite: 0 })
    expect(r.session.rateLimits).toEqual([{ kind: 'five_hour', percentUsed: 12.5, resetsAt: null }])
  })

  test('the main loop block carries its own steps, tools and skills, not the agents', () => {
    expect(r.session.loop).toEqual({
      skills: ['code-review'],
      lastTool: 'TaskUpdate',
      toolCalls: 3,
      toolCounts: { TaskCreate: 2, TaskUpdate: 1 },
      steps: { done: 1, total: null },
    })
  })

  test('plan with title, states and owners', () => {
    const p = r.session.plan!
    expect(p.title).toBe('Migrate')
    expect(p.steps.map((s) => [s.id, s.state])).toEqual([['1', 'active'], ['2', 'pending']])
    expect(p.steps[0]!.ownerAgentId).toBe('a1')
    expect(p.steps[0]!.ownerLabel).toBe('Explore · Haiku medium')
    expect(p.steps[1]!.ownerAgentId).toBe('a2')
  })

  test('agents: effort requested, then observed wins; a fork inherits', () => {
    const [a1, a2, a3] = ['a1', 'a2', 'a3'].map((id) => r.agents.find((a) => a.id === id)!)
    expect(a1).toMatchObject({ kind: 'subagent', type: 'Explore', status: 'done', effort: 'medium', effortSource: 'observed', model: 'claude-haiku-5-5', skills: ['repo-map'], answerExcerpt: 'Found 42 call sites.' })
    expect(a1!.promptExcerpt).toBe('Find every call site. token=[redacted]')
    expect(a2).toMatchObject({ kind: 'fork', type: 'fork', status: 'running', effort: 'high', effortSource: 'inherited', model: 'claude-opus-5-5' })
    expect(a3).toMatchObject({ status: 'failed', effortSource: 'unknown', blowouts: 1 })
  })

  test('failure record', () => {
    const f = r.agents.find((a) => a.id === 'a3')!.failure!
    // its last model stop was window-exceeded, which 6.4 ranks above a tool error
    expect(f).toMatchObject({ class: 'Context window exhausted', tool: 'Bash', call: 'npm run backfill', exitCode: 1, outputTail: ['Exit code 1', 'Error: ECONNREFUSED'], retriedAs: null, explanation: null })
    expect(f.evidence.some((l) => l.startsWith('exceeded the context window 1 time'))).toBe(true)
    expect(f.evidence).toContain('same call failed 2 times: npm run backfill')
  })

  test('events: start-less script still logs spawn, skill, done, fail, blow, compact, plan', () => {
    const kinds = new Set(r.events.map((e) => e.kind))
    for (const k of ['spawn', 'skill', 'done', 'fail', 'blow', 'compact', 'plan']) expect(kinds.has(k as never)).toBe(true)
    const blows = r.events.filter((e) => e.kind === 'blow')
    expect(blows).toHaveLength(3)
    expect(blows[0]!.data).toMatchObject({ kind: 'window-exceeded' })
    expect(blows.every((e) => e.id.startsWith('sess-1:'))).toBe(true)
    expect(new Set(r.events.map((e) => e.id)).size).toBe(r.events.length)
  })
})

describe('blowout counting', () => {
  const base = () => newSession({ id: 's', cwd: '/x', startedAt: T0, model: 'opus' })
  test('auto compaction counts, manual does not', () => {
    let s = compaction(base(), { trigger: 'auto', tokensBefore: 1, tokensAfter: 0 }, T0)
    s = compaction(s, { trigger: 'manual' }, T0 + 10_000)
    s = compaction(s, { trigger: 'plugin' }, T0 + 20_000)
    expect(s.main.blowouts).toBe(1)
    expect(s.events.filter((e) => e.kind === 'compact')).toHaveLength(2)
  })
  test('model_context_window_exceeded counts', () => {
    const s = step(base(), { usage: null, stopReason: 'model_context_window_exceeded' }, T0)
    expect(s.main.blowouts).toBe(1)
  })
  // #687: a usage reset showed as a blowout at 25% context. The event carries the fill so the next one can be told apart.
  test('a blowout event records the window and how full it was, for each signal', () => {
    const usage = { model: 'claude-opus-5-5', input_tokens: 150_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const stopped = step(base(), { usage, stopReason: 'model_context_window_exceeded' }, T0)
    const window = stopped.main.window!
    const ev = stopped.events.find((e) => e.kind === 'blow')!
    expect(ev.data).toMatchObject({ kind: 'window-exceeded', tokensBefore: 150_000, window, percent: Math.round((150_000 / window) * 100) })
    const compacted = compaction(step(base(), { usage, stopReason: 'end_turn' }, T0), { trigger: 'auto', tokensBefore: 100_000, tokensAfter: 20_000 }, T0 + 5000)
    expect(compacted.events.find((e) => e.kind === 'blow')!.data).toMatchObject({ kind: 'auto-compact', tokensBefore: 100_000, window, percent: Math.round((100_000 / window) * 100) })
    const unknown = blowout(base(), null, 'auto-compact', T0, null, null)
    expect(unknown.events.find((e) => e.kind === 'blow')!.data).toMatchObject({ window: null, percent: null })
    // A window but no tokens before is not guessed from the last step's fill.
    const noTokens = blowout(step(base(), { usage, stopReason: 'end_turn' }, T0), null, 'auto-compact', T0 + 5000, null, null)
    expect(noTokens.events.find((e) => e.kind === 'blow')!.data).toMatchObject({ window, percent: null })
    const server = step(base(), { usage, stopReason: 'compaction' }, T0)
    expect(server.events.find((e) => e.kind === 'blow')!.data).toMatchObject({ kind: 'server-compaction', window, percent: Math.round((150_000 / window) * 100) })
  })
  test('duplicate signals within 2 s for one loop count once; another loop counts on its own', () => {
    let s = agentSpawned(base(), { toolUseId: 't', agentId: 'a', model: 'haiku', subagentType: 'x', description: 'd', prompt: 'p', fork: false }, T0)
    s = step(s, { agentId: 'a', usage: null, stopReason: 'model_context_window_exceeded' }, T0 + 1000)
    s = compaction(s, { agentId: 'a', trigger: 'auto' }, T0 + 2500)
    s = blowout(s, null, 'auto-compact', T0 + 2600, null, null)
    expect(s.agents.a!.blowouts).toBe(1)
    expect(s.main.blowouts).toBe(1)
    s = compaction(s, { agentId: 'a', trigger: 'auto' }, T0 + 3100)
    expect(s.agents.a!.blowouts).toBe(2)
  })
})

describe('reducers', () => {
  const base = () => newSession({ id: 's', cwd: '/x', startedAt: T0, model: 'claude-opus-5-5' })

  test('spawn before the Agent tool call still gets the requested effort', () => {
    let s = agentSpawned(base(), { toolUseId: 't9', agentId: 'z', model: 'claude-sonnet-5-5', subagentType: 'general-purpose', description: 'd', prompt: 'p', fork: false }, T0)
    expect(s.agents.z!.effortSource).toBe('unknown')
    s = agentRequested(s, 't9', { description: 'd', prompt: 'p', effort: 'xhigh' }, T0 + 1)
    expect(s.agents.z).toMatchObject({ effort: 'xhigh', effortSource: 'requested' })
  })

  test('an agent nested under another keeps its parent', () => {
    let s = agentSpawned(base(), { toolUseId: 't1', agentId: 'p', model: 'opus', subagentType: 'x', description: 'parent', prompt: 'p', fork: false }, T0)
    s = agentSpawned(s, { toolUseId: 't2', agentId: 'c', model: 'opus', subagentType: 'x', description: 'child', prompt: 'p', fork: true, parentAgentId: 'p' }, T0)
    expect(s.agents.c!.parentId).toBe('p')
  })

  // The order and fields a real run on Claude Code 2.1.296 produced (#101, docs/gotchas/): agent.spawn
  // carries the launching loop's id as parentAgentId at every depth, and $.agent.list() marks a parent
  // that waits on its child "waiting", then drops finished nested agents once their parent is done.
  test('a real nested run: subagent under subagent, fork under subagent, subagent under fork (#101)', () => {
    const spawn = (id: string, parentAgentId: string | undefined, fork: boolean, model: string) =>
      ({ toolUseId: `t-${id}`, agentId: id, model, subagentType: fork ? 'fork' : 'general-purpose', description: id, prompt: 'p', fork, parentAgentId })
    let s = step(base(), { model: 'claude-opus-5-5', effort: 'high', usage: null, stopReason: null }, T0)
    s = agentRequested(s, 't-p', { description: 'p', prompt: 'p', subagent_type: 'general-purpose', model: 'haiku', effort: 'low' }, T0)
    s = agentSpawned(s, spawn('p', undefined, false, 'claude-haiku-4-5'), T0)
    s = agentSpawned(s, spawn('f', undefined, true, 'claude-opus-5-5'), T0)
    s = step(s, { agentId: 'p', model: 'claude-haiku-4-5', effort: 'low', usage: null, stopReason: null }, T0 + 1)
    s = agentSpawned(s, spawn('c', 'p', false, 'claude-sonnet-5-5'), T0 + 2)
    s = agentSpawned(s, spawn('pf', 'p', true, 'claude-haiku-4-5'), T0 + 2)
    s = agentSpawned(s, spawn('g', 'c', false, 'claude-sonnet-5-5'), T0 + 3)
    s = agentSpawned(s, spawn('fc', 'f', false, 'claude-sonnet-5-5'), T0 + 3)
    expect(Object.fromEntries(s.order.map((id) => [id, s.agents[id]!.parentId]))).toEqual({ p: null, f: null, c: 'p', pf: 'p', g: 'c', fc: 'f' })
    // A fork inherits from the loop that launched it: the subagent's model and effort, not the orchestrator's.
    expect(s.agents.pf).toMatchObject({ kind: 'fork', model: 'claude-haiku-4-5', effort: 'low', effortSource: 'inherited' })
    expect(s.agents.f).toMatchObject({ kind: 'fork', model: 'claude-opus-5-5', effort: 'high', effortSource: 'inherited' })
    expect(s.events.filter((e) => e.kind === 'spawn').map((e) => e.agentId)).toEqual(['p', 'f', 'c', 'pf', 'g', 'fc'])

    // The list says "waiting" for a parent that waits on its child: it is still running here.
    const listed = (id: string, status: string, parentId?: string) => ({ id, description: id, type: 'general-purpose', status, parentId })
    s = reconcile(s, [listed('p', 'waiting'), listed('f', 'waiting'), listed('c', 'waiting', 'p'), listed('pf', 'running', 'p'), listed('g', 'running', 'c'), listed('fc', 'running', 'f')], T0 + 4)
    expect(s.agents.p!.status).toBe('running')
    expect(s.agents.c!.status).toBe('running')

    for (const id of ['g', 'pf', 'c', 'fc', 'p', 'f']) s = turnComplete(s, { agentId: id, reason: 'answer', answer: 'done' }, T0 + 5)
    // Finished nested agents are gone from the list; the report keeps them, under their parents.
    s = reconcile(s, [listed('p', 'completed'), listed('f', 'completed')], T0 + 6)
    const report = s.order.map((id) => agentReport(s.agents[id]!))
    expect(report.map((a) => [a.id, a.parentId, a.status])).toEqual([
      ['p', null, 'done'], ['f', null, 'done'], ['c', 'p', 'done'], ['pf', 'p', 'done'], ['g', 'c', 'done'], ['fc', 'f', 'done'],
    ])
  })

  test('a plan step can be owned by a nested agent, the same as by a top-level one', () => {
    let s = toolResult(base(), { tool: 'TaskCreate', input: { subject: 'Read the Stripe adapter', description: 'd' }, result: { result: { task: { id: '1', subject: 'Read the Stripe adapter' } } } }, T0)
    s = agentSpawned(s, { toolUseId: 't1', agentId: 'p', model: 'claude-sonnet-5-5', subagentType: 'general-purpose', description: 'Plan the rewrite', prompt: 'p', fork: false }, T0)
    s = agentSpawned(s, { toolUseId: 't2', agentId: 'g', model: 'claude-haiku-4-5', subagentType: 'Explore', description: 'Read the Stripe adapter', prompt: 'p', fork: false, parentAgentId: 'p' }, T0 + 1)
    expect(s.plan.tasks[0]).toMatchObject({ ownerAgentId: 'g', ownerLabel: 'Explore · Haiku' })
  })

  test('an agent the engine lists before its spawn hook keeps the parent the list gives', () => {
    const s = reconcile(base(), [{ id: 'g', description: 'grandchild', type: 'general-purpose', status: 'running', parentId: 'c' }], T0)
    expect(s.agents.g!.parentId).toBe('c')
  })

  test('a candidate is discarded when the loop answers', () => {
    let s = agentSpawned(base(), { toolUseId: 't', agentId: 'a', model: 'opus', subagentType: 'x', description: 'd', prompt: 'p', fork: false }, T0)
    s = toolResult(s, { agentId: 'a', tool: 'Bash', input: { command: 'false' }, result: { isError: true, text: 'Exit code 1' } }, T0 + 1)
    s = turnComplete(s, { agentId: 'a', reason: 'answer', answer: 'fine' }, T0 + 2)
    expect(s.agents.a).toMatchObject({ status: 'done', failure: null, candidate: null })
  })

  test('aborted and refused agents', () => {
    let s = agentSpawned(base(), { toolUseId: 't', agentId: 'a', model: 'opus', subagentType: 'x', description: 'd', prompt: 'p', fork: false }, T0)
    s = agentSpawned(s, { toolUseId: 'u', agentId: 'b', model: 'opus', subagentType: 'x', description: 'e', prompt: 'p', fork: false }, T0)
    s = turnComplete(s, { agentId: 'a', reason: 'aborted' }, T0 + 1)
    s = turnComplete(s, { agentId: 'b', reason: 'refusal' }, T0 + 1)
    expect(s.agents.a).toMatchObject({ status: 'aborted' })
    expect(s.agents.a!.failure!.class).toBe('Aborted')
    expect(s.agents.b!.failure!.class).toBe('Refusal')
  })

  test('agent.list reconciles: unknown agents appear, finished ones never run again', () => {
    let s = reconcile(base(), [{ id: 'x', description: 'from list', type: 'Explore', status: 'running' }, { id: 'y', description: 'done one', type: 'fork', status: 'completed' }], T0)
    expect(s.agents.x).toMatchObject({ description: 'from list', type: 'Explore', status: 'running' })
    expect(s.agents.y).toMatchObject({ kind: 'fork', status: 'done' })
    s = reconcile(s, [{ id: 'y', description: 'done one', type: 'fork', status: 'running' }, { id: 'x', description: 'from list', type: 'Explore', status: 'killed' }], T0 + 1)
    expect(s.agents.y!.status).toBe('done')
    expect(s.agents.x!.status).toBe('aborted')
  })

  test('session end aborts open agents; a new id starts clean but keeps where it runs', () => {
    let s = agentSpawned(base(), { toolUseId: 't', agentId: 'a', model: 'opus', subagentType: 'x', description: 'd', prompt: 'p', fork: false }, T0)
    s = { ...s, git: { branch: 'main', detached: false, isWorktree: false, worktreePath: null, ahead: 0, behind: 0, dirty: 0 } }
    s = sessionEnd(s, 'clear', 's', T0 + 1)
    expect(s).toMatchObject({ status: 'done', endReason: 'clear', resumeId: 's' })
    expect(s.agents.a!.status).toBe('aborted')
    const n = resetForNewId(s, 's2', T0 + 2)
    expect(n).toMatchObject({ id: 's2', ended: false, agents: {}, evSeq: 0 })
    expect(n.git?.branch).toBe('main')
    expect(n.plan.tasks).toEqual([])
  })

  test('the reducers never mutate their input', () => {
    const s = scriptedState()
    const frozen = JSON.stringify(s)
    step(s, { usage: null, stopReason: 'model_context_window_exceeded' }, T0 + 99_000)
    toolResult(s, { tool: 'TaskUpdate', input: { taskId: '2', status: 'completed' }, result: {} }, T0)
    sessionEnd(s, 'other', null, T0)
    expect(JSON.stringify(s)).toBe(frozen)
  })
})

describe('per-tool counts', () => {
  const base = () => newSession({ id: 's', cwd: '/x', startedAt: T0, model: 'claude-opus-5-5' })
  const spawn = () => agentSpawned(base(), { toolUseId: 't', agentId: 'a', model: 'opus', subagentType: 'x', description: 'd', prompt: 'p', fork: false }, T0)
  const call = (s: ReturnType<typeof base>, tool: string, agentId?: string) => toolResult(s, { agentId, tool, input: {}, result: {} }, T0 + 1)

  test('each finished call is counted under its tool, and the counts add up to the total', () => {
    let s = spawn()
    for (const t of ['Bash', 'Read', 'Bash', 'Grep', 'Bash']) s = call(s, t, 'a')
    expect(s.agents.a!.toolCounts).toEqual({ Bash: 3, Read: 1, Grep: 1 })
    expect(Object.values(s.agents.a!.toolCounts).reduce((n, c) => n + c, 0)).toBe(s.agents.a!.toolCalls)
  })

  test('the main loop is counted too, apart from the agents', () => {
    let s = spawn()
    s = call(s, 'Edit')
    s = call(s, 'Bash', 'a')
    expect(s.main.toolCounts).toEqual({ Edit: 1 })
    expect(s.agents.a!.toolCounts).toEqual({ Bash: 1 })
  })

  test('a long tool name is clipped to 120 characters', () => {
    const s = call(spawn(), 'm'.repeat(300), 'a')
    expect(Object.keys(s.agents.a!.toolCounts)).toEqual(['m'.repeat(120)])
  })

  test('past 100 distinct tools, new names are left out but known ones and the total still count', () => {
    let s = spawn()
    for (let i = 0; i < 100; i++) s = call(s, `tool-${i}`, 'a')
    s = call(s, 'one-too-many', 'a')
    s = call(s, 'tool-0', 'a')
    const counts = s.agents.a!.toolCounts
    expect(Object.keys(counts)).toHaveLength(100)
    expect(counts['one-too-many']).toBeUndefined()
    expect(counts['tool-0']).toBe(2)
    expect(s.agents.a!.toolCalls).toBe(102)
  })

  test('a tool named like an Object property is counted as its own name', () => {
    const s = call(call(spawn(), 'constructor', 'a'), 'constructor', 'a')
    expect(s.agents.a!.toolCounts).toEqual({ constructor: 2 })
  })

  test('the report carries the counts', () => {
    const s = call(call(spawn(), 'Bash', 'a'), 'Bash', 'a')
    expect(agentReport(s.agents.a!).toolCounts).toEqual({ Bash: 2 })
  })
})

describe('attached', () => {
  const base = () => newSession({ id: 's', cwd: '/x', startedAt: T0, model: 'claude-opus-5-5' })

  test('is unknown until the roster has been read', () => {
    expect(base().attached).toBeNull()
  })

  test('a change marks the session dirty; the same value does not', () => {
    const detached = setAttached({ ...base(), dirty: false }, false)
    expect(detached.attached).toBe(false)
    expect(detached.dirty).toBe(true)
    const again = setAttached({ ...detached, dirty: false }, false)
    expect(again.dirty).toBe(false)
    expect(setAttached({ ...again, dirty: false }, true).dirty).toBe(true)
  })

  test('does not mutate its input', () => {
    const s = base()
    const frozen = JSON.stringify(s)
    setAttached(s, false)
    expect(JSON.stringify(s)).toBe(frozen)
  })
})

describe('full prompt and answer text (opt-in)', () => {
  const spawned = (prompt: string) =>
    agentSpawned(newSession({ id: 's', cwd: '/w', startedAt: T0 }), { toolUseId: 't', agentId: 'a1', model: 'claude-haiku-5-5', subagentType: 'Explore', description: 'd', prompt, fork: false }, T0 + 1)

  test('kept redacted with its line breaks, apart from the 400-char excerpt', () => {
    const s = spawned('# Task\n\n- find calls\n- token=SECRET123')
    const a = s.agents.a1!
    expect(a.promptText).toBe('# Task\n\n- find calls\n- token=[redacted]')
    expect(a.promptExcerpt).toBe('# Task - find calls - token=[redacted]')
  })

  test('a text over the cap is cut with a visible marker', () => {
    const a = spawned('x'.repeat(25_000)).agents.a1!
    expect(a.promptText!.startsWith('x'.repeat(20_000))).toBe(true)
    expect(a.promptText!).toContain('cut off')
    expect(a.promptText!.length).toBeLessThan(20_100)
  })

  test('the report omits the text unless the option is on', () => {
    const a = spawned('Find calls.').agents.a1!
    expect('promptText' in agentReport(a)).toBe(false)
    expect(agentReport(a, true).promptText).toBe('Find calls.')
  })

  test('answer text arrives with the answer and goes out once', () => {
    let s = spawned('Find calls.')
    s = turnComplete(s, { agentId: 'a1', reason: 'answer', answer: '## Done\n\n42 sites' }, T0 + 5)
    expect(agentReport(s.agents.a1!, true)).toMatchObject({ promptText: 'Find calls.', answerText: '## Done\n\n42 sites' })
    s = markTextSent(s)
    const sent = agentReport(s.agents.a1!, true)
    expect('promptText' in sent).toBe(false)
    expect('answerText' in sent).toBe(false)
    expect(sent.promptExcerpt).toBe('Find calls.')
  })

  test('one report carries at most 120,000 characters of full text; the rest waits for the next', () => {
    let s = newSession({ id: 's', cwd: '/w', startedAt: T0 })
    for (let i = 0; i < 10; i++) s = agentSpawned(s, { toolUseId: `t${i}`, agentId: `a${i}`, model: 'claude-haiku-5-5', subagentType: 'Explore', description: 'd', prompt: 'x'.repeat(19_000), fork: false }, T0 + i)
    const carried = (st: typeof s) => Object.values(st.agents).map((a) => agentReport(a, true)).filter((r) => r.promptText)
    const meta = { version: '0.10.0', engineVersion: null, hostSurface: null, now: T0, storedName: null, optionName: null, fullText: true }
    const first = buildReport(s, [], meta).agents.filter((a) => a.promptText)
    expect(carried(s)).toHaveLength(10)
    expect(first.length).toBeLessThan(10)
    expect(first.reduce((n, a) => n + a.promptText!.length, 0)).toBeLessThanOrEqual(120_000)
    s = markTextSent(s, Object.fromEntries(first.map((a) => [a.id, { promptText: a.promptText }])))
    const second = buildReport(s, [], meta).agents.filter((a) => a.promptText)
    expect(first.length + second.length).toBe(10)
    expect(second.map((a) => a.id).some((id) => first.some((f) => f.id === id))).toBe(false)
  })

  test('a later answer for the same agent is sent again', () => {
    let s = spawned('p')
    s = turnComplete(s, { agentId: 'a1', reason: 'answer', answer: 'one' }, T0 + 5)
    s = markTextSent(s)
    s = turnComplete(s, { agentId: 'a1', reason: 'answer', answer: 'two' }, T0 + 6)
    expect(agentReport(s.agents.a1!, true).answerText).toBe('two')
  })
})

// A session idle on a background process is not waiting on the person (#119). The Stop hook input lists the
// background tasks and scheduled wake-ups still in flight; the report says what the session waits on.
describe('background work (#119)', () => {
  const meta = { version: '0.0.0', engineVersion: null, hostSurface: null, now: T0 + 10, storedName: null, optionName: null }
  const idle = () => turnComplete(newSession({ id: 's', cwd: '/x', startedAt: T0, model: 'claude-opus-5-5' }), { reason: 'answer' }, T0 + 1)
  const shell = { id: 'b1', type: 'shell', status: 'running', description: 'nightly build', command: 'npm run build && curl -H "Authorization: Bearer sk-live-123" https://example.com/upload' }

  test('a turn that ends with a shell running does not say waiting for input', () => {
    expect(idle()).toMatchObject({ status: 'waiting', waitReason: 'input' })
    const s = setBackground(idle(), { tasks: [shell], crons: [] }, T0 + 2)
    expect(s.status).toBe('waiting')
    expect(s.waitReason).toBeNull()
    const r = buildReport(s, [], meta)
    expect(r.session.status).toBe('waiting')
    expect(r.session.waitReason).toBeNull()
    expect(r.session.background).toEqual({ tasks: [{ type: 'shell', description: 'nightly build', status: 'running' }], wakeAt: null })
  })

  test('describeBackground lists each held entry, or says none (#128)', () => {
    expect(describeBackground(idle())).toBe('Background work: none')
    const s = setBackground(idle(), { tasks: [shell, { id: 'm1', type: 'monitor', status: 'exited', description: 'watch logs' }], crons: [] }, T0 + 2)
    expect(describeBackground(s)).toBe('Background work (2):\n  shell, running: nightly build\n  monitor, exited: watch logs')
  })

  test('an artifact live-update watcher is not work in flight, so a session with only watchers waits on the person (#128)', () => {
    const watch = (n: number) => ({ id: `w${n}`, type: 'monitor', status: 'running', description: `live updates for artifact https://claude.ai/artifact/abc${n} (re-armed on session resume)` })
    const watchers = Array.from({ length: 10 }, (_, n) => watch(n))
    const only = setBackground(idle(), { tasks: watchers, crons: [] }, T0 + 2)
    expect(only.background).toBeNull()
    expect(only).toMatchObject({ status: 'waiting', waitReason: 'input' })
    // real work next to the watchers is still listed, and the watchers are not
    const mixed = setBackground(idle(), { tasks: [...watchers, shell], crons: [] }, T0 + 2)
    expect(mixed.background!.tasks).toEqual([{ type: 'shell', description: 'nightly build', status: 'running' }])
    // a monitor the user started is not an artifact watcher
    const own = setBackground(idle(), { tasks: [{ id: 'm', type: 'monitor', status: 'running', description: 'tail the deploy log' }], crons: [] }, T0 + 2)
    expect(own.background!.tasks).toHaveLength(1)
  })

  test('a shell command is never sent whole', () => {
    const r = buildReport(setBackground(idle(), { tasks: [{ ...shell, description: '' }], crons: [] }, T0 + 2), [], meta)
    const text = JSON.stringify(r.session.background)
    expect(text).not.toContain('sk-live-123')
    expect(text).not.toContain('Authorization')
    // with no description, the task is named by its type only
    expect(r.session.background!.tasks[0]!.description.length).toBeLessThanOrEqual(120)
  })

  test('a task with no description is never named by an inline NAME=value secret', () => {
    const r = buildReport(setBackground(idle(), { tasks: [{ ...shell, description: '', command: 'API_KEY=sk-live-123 /usr/local/bin/node build.js' }], crons: [] }, T0 + 2), [], meta)
    expect(r.session.background!.tasks[0]!.description).toBe('node')
    expect(JSON.stringify(r.session.background)).not.toContain('sk-live-123')
  })

  test('background agents, monitors and workflows are counted by their type', () => {
    const tasks = [shell, { id: 'b2', type: 'subagent', status: 'running', description: 'Survey adapters' }, { id: 'b3', type: 'monitor', status: 'running', description: 'tail the log' }, { id: 'b4', type: 'workflow', status: 'running', description: 'release' }]
    const r = buildReport(setBackground(idle(), { tasks, crons: [] }, T0 + 2), [], meta)
    expect(r.session.background!.tasks.map((t) => t.type)).toEqual(['shell', 'agent', 'monitor', 'workflow'])
  })

  test('a scheduled wake-up alone is a background wait that says when it wakes', () => {
    const s = setBackground(idle(), { tasks: [], crons: [{ id: 'c1', schedule: '30 14 * * *', recurring: false, prompt: 'check the deploy', nextAt: T0 + 3_600_000 }] }, T0 + 2)
    expect(s.waitReason).toBeNull()
    const r = buildReport(s, [], meta)
    expect(r.session.background).toMatchObject({ tasks: [{ type: 'wakeup', description: 'check the deploy' }], wakeAt: T0 + 3_600_000 })
  })

  test('with two wake-ups and one time unreadable, no time is shown', () => {
    const crons = [{ id: 'c1', schedule: '0 15 * * *', recurring: true, prompt: 'a', nextAt: T0 + 3_600_000 }, { id: 'c2', schedule: '@weird', recurring: true, prompt: 'b', nextAt: null }]
    const r = buildReport(setBackground(idle(), { tasks: [], crons }, T0 + 2), [], meta)
    expect(r.session.background!.wakeAt).toBeNull()
    expect(r.session.background!.tasks).toHaveLength(2)
  })

  test('when the work finishes the session goes back to waiting for input at once', () => {
    let s = setBackground(idle(), { tasks: [shell], crons: [] }, T0 + 2)
    s = setBackground(s, { tasks: [], crons: [] }, T0 + 3)
    expect(s).toMatchObject({ status: 'waiting', waitReason: 'input' })
    const r = buildReport(s, [], meta)
    expect(r.session.background).toBeUndefined()
    expect(keys(r.session)).toEqual(SESSION_KEYS)
  })

  test('a finished task in the list is not work in flight', () => {
    const s = setBackground(idle(), { tasks: [{ ...shell, status: 'completed' }], crons: [] }, T0 + 2)
    expect(s).toMatchObject({ status: 'waiting', waitReason: 'input' })
  })

  test('a permission wait stays a permission wait while a shell runs', () => {
    let s = setBackground(idle(), { tasks: [shell], crons: [] }, T0 + 2)
    s = { ...s, waitReason: 'permission' as const, waitNote: 'Bash(rm x)' }
    s = setBackground(s, { tasks: [shell], crons: [] }, T0 + 3)
    expect(s.waitReason).toBe('permission')
    expect(buildReport(s, [], meta).session.waitReason).toBe('permission')
  })
})

describe('usage per model and prompt-size tier (#117)', () => {
  const base = () => newSession({ id: 's', cwd: '/x', startedAt: T0, model: 'claude-sonnet-5-5' })
  const u = (input: number, output: number, cacheRead: number, cacheWrite: number, extra: object = {}) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, ...extra })
  const reportMeta = { now: T0 + 99_000, version: '9.9.9', engineVersion: null, hostSurface: null, storedName: null, optionName: null }
  const usage = (r: ReturnType<typeof buildReport>['session'] | ReturnType<typeof buildReport>['agents'][number]) => r.usageByModel!

  test('adds up tokens per model, and a request with a prompt over 100,000 tokens counts in the long tier', () => {
    let s = step(base(), { model: 'claude-sonnet-5-5', usage: u(1000, 10, 2000, 300), stopReason: null }, T0 + 1)
    s = step(s, { model: 'claude-sonnet-5-5', usage: u(500, 5, 1000, 0), stopReason: null }, T0 + 2)
    s = step(s, { model: 'claude-haiku-5-5', usage: u(60_000, 20, 50_000, 0), stopReason: null }, T0 + 3)
    s = step(s, { model: 'claude-haiku-5-5', usage: u(10, 20, 1_000, 0), stopReason: null }, T0 + 4)
    const r = buildReport(s, [], reportMeta)
    expect(usage(r.session)).toEqual([
      { model: 'claude-haiku-5-5', tier: 'long', tokens: { input: 60_000, output: 20, cacheRead: 50_000, cacheWrite: 0, cacheWrite1h: 0 } },
      { model: 'claude-haiku-5-5', tier: 'std', tokens: { input: 10, output: 20, cacheRead: 1_000, cacheWrite: 0, cacheWrite1h: 0 } },
      { model: 'claude-sonnet-5-5', tier: 'std', tokens: { input: 1500, output: 15, cacheRead: 3000, cacheWrite: 300, cacheWrite1h: 0 } },
    ])
  })

  test('a prompt of exactly 100,000 tokens is not over the threshold', () => {
    const s = step(base(), { model: 'claude-haiku-5-5', usage: u(100_000, 1, 0, 0), stopReason: null }, T0 + 1)
    expect(usage(buildReport(s, [], reportMeta).session)[0]!.tier).toBe('std')
  })

  test('splits cache writes into 5 minutes and 1 hour when Claude Code gives the split', () => {
    const s = step(base(), { model: 'claude-sonnet-5-5', usage: u(10, 1, 0, 500, { cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 } }), stopReason: null }, T0 + 1)
    expect(usage(buildReport(s, [], reportMeta).session)[0]!.tokens).toEqual({ input: 10, output: 1, cacheRead: 0, cacheWrite: 200, cacheWrite1h: 300 })
    expect(buildReport(s, [], reportMeta).session.tokens.cacheWrite).toBe(500)
  })

  test('without the split, every cache write counts at the 5-minute rate', () => {
    const s = step(base(), { model: 'claude-sonnet-5-5', usage: u(10, 1, 0, 500), stopReason: null }, T0 + 1)
    expect(usage(buildReport(s, [], reportMeta).session)[0]!.tokens.cacheWrite1h).toBe(0)
  })

  test("the session's usage covers the orchestrator and every agent; an agent's covers only itself", () => {
    let s = step(base(), { model: 'claude-sonnet-5-5', usage: u(1000, 0, 0, 0), stopReason: null }, T0 + 1)
    s = agentSpawned(s, { toolUseId: 't-a', agentId: 'a', model: 'claude-sonnet-5-5', subagentType: 'Explore', description: 'a', prompt: 'p', fork: false }, T0 + 2)
    s = step(s, { agentId: 'a', model: 'claude-sonnet-5-5', usage: u(250, 0, 0, 0), stopReason: null }, T0 + 3)
    s = step(s, { agentId: 'a', model: 'claude-haiku-4-5', usage: u(40, 0, 0, 0), stopReason: null }, T0 + 4)
    const r = buildReport(s, [], reportMeta)
    const inputs = (rows: { model: string; tier: string; tokens: { input: number } }[]) => rows.map((x) => [x.model, x.tier, x.tokens.input])
    expect(inputs(usage(r.session))).toEqual([['claude-haiku-4-5', 'std', 40], ['claude-sonnet-5-5', 'std', 1250]])
    expect(inputs(usage(r.agents[0]!))).toEqual([['claude-haiku-4-5', 'std', 40], ['claude-sonnet-5-5', 'std', 250]])
  })

  test('a failure explanation counts in the agent and so in the session', () => {
    let s = agentSpawned(base(), { toolUseId: 't-a', agentId: 'a', model: 'claude-sonnet-5-5', subagentType: 'Explore', description: 'a', prompt: 'p', fork: false }, T0 + 2)
    s = { ...s, agents: { ...s.agents, a: { ...s.agents.a!, failure: { at: T0, class: 'Unknown', tool: null, call: null, exitCode: null, outputTail: [], evidence: [], retriedAs: null, explanation: null } as never } } }
    s = setExplanation(s, 'a', 'It failed because of X.', u(70, 30, 0, 0), 'claude-sonnet-5-5')
    const r = buildReport(s, [], reportMeta)
    expect(usage(r.agents[0]!)[0]!.tokens).toMatchObject({ input: 70, output: 30 })
    expect(usage(r.session)[0]!.tokens).toMatchObject({ input: 70, output: 30 })
  })

  test('a step with no usage adds no row', () => {
    const s = step(base(), { model: 'claude-sonnet-5-5', usage: null, stopReason: null }, T0 + 1)
    expect(usage(buildReport(s, [], reportMeta).session)).toEqual([])
  })
})

describe('activity feed (#118)', () => {
  const base = () => agentSpawned(newSession({ id: 's', cwd: '/x', startedAt: T0 }), { toolUseId: 't1', agentId: 'a1', model: 'claude-sonnet-5-5', subagentType: 'Explore', description: 'Map', prompt: 'p', fork: false }, T0)
  const entry = (i: number) => ({ at: T0 + i, kind: 'tool' as const, text: `Read f${i}` })

  test('nothing is kept for a loop that is not watched', () => {
    const s = addActivity(base(), 'a1', entry(1))
    expect(s.agents.a1!.activity).toEqual([])
    expect(s.main.activity).toEqual([])
    expect(isWatched(s, 'a1')).toBe(false)
  })

  test('a watched loop keeps its last 20 entries, oldest first', () => {
    let s = setWatched(base(), ['a1'])
    expect(isWatched(s, 'a1')).toBe(true)
    for (let i = 1; i <= 25; i++) s = addActivity(s, 'a1', entry(i))
    expect(s.agents.a1!.activity).toHaveLength(ACTIVITY_KEPT)
    expect(s.agents.a1!.activity[0]!.at).toBe(T0 + 6)
    expect(s.agents.a1!.activity.at(-1)!.at).toBe(T0 + 25)
    expect(s.dirty).toBe(true)
  })

  test('the watched ids are kept in alphabetical order, not by UTF-16 code unit', () => {
    expect(setWatched(base(), ['b', 'B', 'a', 'Z']).watched).toEqual(['a', 'b', 'B', 'Z'])
  })

  test('the orchestrator is watched as MAIN_LOOP', () => {
    let s = setWatched(base(), [MAIN_LOOP])
    s = addActivity(s, undefined, entry(1))
    s = addActivity(s, 'a1', entry(2))
    expect(s.main.activity).toEqual([entry(1)])
    expect(s.agents.a1!.activity).toEqual([])
  })

  test('a loop that is no longer watched forgets its entries, and starts empty when watched again', () => {
    let s = setWatched(base(), ['a1', MAIN_LOOP])
    s = addActivity(addActivity(s, 'a1', entry(1)), undefined, entry(2))
    s = setWatched(s, [MAIN_LOOP])
    expect(s.agents.a1!.activity).toEqual([])
    expect(s.main.activity).toHaveLength(1)
    s = setWatched(s, [MAIN_LOOP, 'a1'])
    expect(s.agents.a1!.activity).toEqual([])
  })

  test('the same watch list leaves the state as it was', () => {
    const s = setWatched(base(), ['a1'])
    expect(setWatched(s, ['a1'])).toBe(s)
  })

  test('a report carries the feed only with the option on and only for watched loops', () => {
    let s = setWatched(base(), ['a1'])
    s = addActivity(s, 'a1', entry(1))
    const meta = { version: '0.13.0', engineVersion: null, hostSurface: null, now: T0, storedName: null, optionName: null }
    const off = buildReport(s, [], meta)
    expect(off.session.activityFeed).toBe(false)
    expect('activity' in off.agents[0]!).toBe(false)
    const on = buildReport(s, [], { ...meta, activity: true })
    expect(on.session.activityFeed).toBe(true)
    expect(on.agents[0]!.activity).toEqual([entry(1)])
    expect('activity' in on.session).toBe(false)
    const unwatched = buildReport(setWatched(s, []), [], { ...meta, activity: true })
    expect('activity' in unwatched.agents[0]!).toBe(false)
  })

  test('a Bash entry with no call id still carries its command, commandCut and output', () => {
    const e = { at: T0 + 1, kind: 'tool' as const, text: 'Bash ls', command: 'ls', commandCut: true, output: 'a', done: true }
    const s = addActivity(setWatched(base(), ['a1']), 'a1', e)
    const a = s.agents.a1!
    expect(agentReport(a, false, true, true).activity).toEqual([e])
    const noOut = agentReport(a, false, true, false).activity![0]!
    expect(noOut.command).toBe('ls')
    expect(noOut.commandCut).toBe(true)
    expect('id' in noOut).toBe(false)
    expect('output' in noOut).toBe(false)
  })
})

describe('activity command and output (#431)', () => {
  const base = () => agentSpawned(newSession({ id: 's', cwd: '/x', startedAt: T0 }), { toolUseId: 't1', agentId: 'a1', model: 'claude-sonnet-5-5', subagentType: 'Explore', description: 'Map', prompt: 'p', fork: false }, T0)
  const bash = (id: string) => ({ at: T0, kind: 'tool' as const, text: 'Bash ls', id, command: 'ls' })
  const meta = { version: '0.13.0', engineVersion: null, hostSurface: null, now: T0, storedName: null, optionName: null, activity: true }
  const watched = () => setWatched(base(), ['a1', MAIN_LOOP])

  test('output is watched per loop, and only a loop the reply lists', () => {
    let s = setWatchedOutput(watched(), ['a1'])
    expect(isWatchedOutput(s, 'a1')).toBe(true)
    expect(isWatchedOutput(s, undefined)).toBe(false)
    expect(setWatchedOutput(s, ['a1'])).toBe(s)
    s = setWatchedOutput(s, [MAIN_LOOP, 'a1', 'a1'])
    expect(s.watchedOutput).toEqual(['@orchestrator', 'a1'].sort((a, b) => a.localeCompare(b)))
    expect(isWatchedOutput(s, undefined)).toBe(true)
  })

  test('a loop that stops being watched for output loses the output it held and keeps its command and how the call ended (#598)', () => {
    let s = setWatchedOutput(watched(), ['a1', MAIN_LOOP])
    s = addActivity(addActivity(s, 'a1', bash('c1')), undefined, bash('c2'))
    s = finishActivity(s, 'a1', 'c1', { output: 'out', done: true, exitCode: 2, failed: true, outputCut: true })
    s = finishActivity(s, undefined, 'c2', { output: 'main out', done: true })
    s = setWatchedOutput(s, [MAIN_LOOP])
    expect(s.agents.a1!.activity).toEqual([{ ...bash('c1'), done: true, exitCode: 2, failed: true }])
    expect(s.main.activity[0]!.output).toBe('main out')
    s = setWatchedOutput(s, [])
    expect(s.main.activity).toEqual([{ ...bash('c2'), done: true }])
  })

  test('a loop that is no longer watched at all drops its output list too', () => {
    let s = setWatchedOutput(watched(), ['a1'])
    s = setWatched(s, [MAIN_LOOP])
    expect(s.agents.a1!.activity).toEqual([])
  })

  test('finishActivity merges into the entry with that id, in that loop, and nothing else', () => {
    let s = setWatchedOutput(watched(), ['a1'])
    s = addActivity(addActivity(s, 'a1', bash('c1')), 'a1', bash('c2'))
    const done = finishActivity(s, 'a1', 'c2', { output: 'hi', done: true })
    expect(done.agents.a1!.activity).toEqual([bash('c1'), { ...bash('c2'), output: 'hi', done: true }])
    expect(done.dirty).toBe(true)
    expect(finishActivity(s, 'a1', 'gone', { done: true })).toBe(s)
    expect(finishActivity(s, 'nobody', 'c1', { done: true })).toBe(s)
  })

  test('a report carries id and command with the feed, and the output only with the option on', () => {
    let s = setWatchedOutput(watched(), ['a1'])
    s = addActivity(s, 'a1', bash('c1'))
    s = finishActivity(s, 'a1', 'c1', { output: 'hi', done: true, failed: true, exitCode: 1, outputCut: true })
    const off = buildReport(s, [], meta)
    expect(off.session.activityOutput).toBe(false)
    expect(off.agents[0]!.activity).toEqual([{ at: T0, kind: 'tool', text: 'Bash ls', id: 'c1', command: 'ls', done: true, exitCode: 1, failed: true }])
    const on = buildReport(s, [], { ...meta, activityOutput: true })
    expect(on.session.activityOutput).toBe(true)
    expect(on.agents[0]!.activity).toEqual([{ at: T0, kind: 'tool', text: 'Bash ls', id: 'c1', command: 'ls', output: 'hi', outputCut: true, done: true, exitCode: 1, failed: true }])
  })

  test('a call finished without output is reported done, failed and exitCode with the option off or on, and no output (#598)', () => {
    let s = addActivity(watched(), 'a1', bash('c1'))
    s = finishActivity(s, 'a1', 'c1', { done: true, failed: true, exitCode: 2 })
    const want = [{ at: T0, kind: 'tool', text: 'Bash ls', id: 'c1', command: 'ls', done: true, failed: true, exitCode: 2 }]
    expect(buildReport(s, [], meta).agents[0]!.activity).toEqual(want)
    expect(buildReport(s, [], { ...meta, activityOutput: true }).agents[0]!.activity).toEqual(want)
    expect(finishActivity(s, 'a1', 'c1', { done: true })).not.toBe(s)
  })

  test('a command that was cut says so, and an older entry keeps its old shape', () => {
    let s = watched()
    s = addActivity(s, 'a1', { ...bash('c1'), commandCut: true })
    s = addActivity(s, 'a1', { at: T0, kind: 'text', text: 'hello' })
    const r = buildReport(s, [], meta)
    expect(r.agents[0]!.activity).toEqual([{ at: T0, kind: 'tool', text: 'Bash ls', id: 'c1', command: 'ls', commandCut: true }, { at: T0, kind: 'text', text: 'hello' }])
  })

  test('the 200,000-character budget drops output first, then the command, newest entry first, and keeps the summary', () => {
    let s = setWatchedOutput(watched(), ['a1'])
    const big = 'x'.repeat(20_000)
    for (let i = 0; i < 12; i++) {
      s = addActivity(s, 'a1', { ...bash(`c${i}`), command: big })
      s = finishActivity(s, 'a1', `c${i}`, { output: big, done: true })
    }
    const list = buildReport(s, [], { ...meta, activityOutput: true }).agents[0]!.activity!
    expect(list).toHaveLength(12)
    const chars = list.reduce((n, e) => n + (e.command?.length ?? 0) + (e.output?.length ?? 0), 0)
    expect(chars).toBeLessThanOrEqual(200_000)
    expect(list.at(-1)!.output).toBe(big) // the newest keeps all it had
    expect(list.at(-1)!.command).toBe(big)
    expect(list[0]!.output).toBeUndefined()
    expect(list[0]!.command).toBeUndefined()
    expect(list.every((e) => e.text === 'Bash ls')).toBe(true)
  })

  test('an entry whose command fits the budget but whose output does not keeps the command alone', () => {
    let s = setWatchedOutput(watched(), ['a1'])
    const big = 'x'.repeat(20_000)
    s = addActivity(s, 'a1', { ...bash('old'), command: big })
    s = finishActivity(s, 'a1', 'old', { output: 'z'.repeat(20_100), done: true })
    for (let i = 0; i < 4; i++) {
      s = addActivity(s, 'a1', { ...bash(`c${i}`), command: big })
      s = finishActivity(s, 'a1', `c${i}`, { output: big, done: true })
    }
    const list = buildReport(s, [], { ...meta, activityOutput: true }).agents[0]!.activity!
    expect(list[0]!.command).toBe(big)
    expect(list[0]!.output).toBeUndefined()
    expect(list[0]!.done).toBe(true)
    expect(list.at(-1)!.output).toBe(big)
  })

  test('the orchestrator feed is budgeted before the agents', () => {
    let s = setWatchedOutput(watched(), ['a1', MAIN_LOOP])
    const big = 'y'.repeat(20_000)
    for (let i = 0; i < 6; i++) {
      s = addActivity(s, undefined, { ...bash(`m${i}`), command: big })
      s = finishActivity(s, undefined, `m${i}`, { output: big, done: true })
    }
    s = addActivity(s, 'a1', { ...bash('c1'), command: big })
    s = finishActivity(s, 'a1', 'c1', { output: big, done: true })
    const r = buildReport(s, [], { ...meta, activityOutput: true })
    expect(r.session.activity!.at(-1)!.output).toBe(big)
    expect(r.agents[0]!.activity![0]!.output).toBeUndefined()
    expect(r.agents[0]!.activity![0]!.command).toBeUndefined()
  })

  const bytes = (x: object) => new TextEncoder().encode(JSON.stringify(x)).length
  // 3 bytes a character, so 200,000 characters (the character budget) are 600,000 bytes, over the 480,000 a request may hold
  const wide = '\u20ac'.repeat(20_000)

  test('over the serialized byte limit, output goes first, oldest first, and the commands stay', () => {
    let s = setWatchedOutput(watched(), ['a1'])
    for (let i = 0; i < 5; i++) {
      s = addActivity(s, 'a1', { ...bash(`c${i}`), command: wide })
      s = finishActivity(s, 'a1', `c${i}`, { output: wide, done: true })
    }
    const r = buildReport(s, [], { ...meta, activityOutput: true })
    expect(bytes(r)).toBeLessThanOrEqual(480_000)
    const list = r.agents[0]!.activity!
    expect(list.every((e) => e.command === wide)).toBe(true)
    expect(list[0]!.output).toBeUndefined()
    expect(list[0]!.done).toBe(true)
    expect(list[2]!.output).toBeUndefined()
    expect(list.at(-1)!.output).toBe(wide) // only as many as needed went, the newest last
  })

  test('still over after the output is gone, the oldest commands go next and the summaries stay', () => {
    let s = watched()
    for (let i = 0; i < 10; i++) s = addActivity(s, 'a1', { ...bash(`c${i}`), command: wide })
    const r = buildReport(s, [], meta)
    expect(bytes(r)).toBeLessThanOrEqual(480_000)
    const list = r.agents[0]!.activity!
    expect(list).toHaveLength(10)
    expect(list[0]!.command).toBeUndefined()
    expect(list[0]!.commandCut).toBeUndefined()
    expect(list[0]!.text).toBe('Bash ls')
    expect(list.at(-1)!.command).toBe(wide)
  })

  test('a report under the byte limit is left alone', () => {
    let s = watched()
    s = addActivity(s, 'a1', bash('c1'))
    expect(buildReport(s, [], meta).agents[0]!.activity![0]!.command).toBe('ls')
  })
})
