import { describe, test, expect, mock, type Engine } from 'claude-code/testing'
import type { AgentSpawnInput, CommandRunInput, On, TurnStepChunk } from 'claude-code'
import { MAIN_LOOP, type Report } from './protocol.ts'
import { VERSION } from './register.ts'

// The test runner has a console; the hooks sandbox's declarations do not.
declare const console: { log: (...args: unknown[]) => void }

const SID = 'sess-e2e-0001'
/** A compaction leaves at least one message: its summary. */
const SUMMARY = [{ role: 'user' as const, text: 'Summary of the work so far.', toolUses: [] }]
const CWD = '/Users/dev/app/.claude/worktrees/feat-x'
/** A pre-warmed spare of the desktop app, and the project it is moved to (#382). */
const SPARE = '/Users/dev/.claude/spares/spare-eB3Cs1'
const PROJECT = '/Users/dev/web/podium'
const PROJECT_GIT: Record<string, string> = {
  'rev-parse --abbrev-ref HEAD': 'main',
  'rev-parse --git-dir': '.git',
  'rev-parse --git-common-dir': '.git',
  'rev-parse --path-format=absolute --git-common-dir': `${PROJECT}/.git`,
  'rev-parse --show-toplevel': PROJECT,
  'status --porcelain=v1 -b': '## main...origin/main\n',
  'config --get remote.origin.url': 'git@github.com:acme/podium.git',
}

interface World {
  posts: Report[]
  headers: Record<string, string>[]
  clock: ReturnType<typeof mock.clock>
  lastToolUseId: () => string
  sessionId: { value: string }
  fetchMode: { mode: 'ok' | 'down' | 'hang' | 'denied' }
  /** The clients attached to the session, as `$.session.surfaces()` answers. */
  surfaces: { value: ('terminal' | 'desktop' | 'vscode' | 'mobile')[]; fail: boolean }
  /** Every command the plugin ran, as its argument vector. */
  ran: string[][]
  /** The loops the server's reply says someone is watching (#118). */
  watch: { value: string[] }
  /** The loops the reply says a viewer has the feed open on (#431); null leaves the field out, as an older server does. */
  watchOutput: { value: string[] | null }
  /** What a Bash call returns, by a word in its command (#431); the default is the plain mock. */
  bash: { results: Record<string, unknown> }
  /** What each model request streams before it ends. */
  chunks: { value: TurnStepChunk[] }
  /** The files the plugin reads and writes by path, from memory; `broken` makes every access fail. */
  files: { text: Record<string, string>; broken: boolean }
  /** Where `$.session` says the session is: `cwd` null makes `cwd()` fail; `repo` null is a folder that is not a repository (#382). */
  place: { cwd: string | null; root: string; repo: { root: string; remote: string | null; internal: boolean; name: string | null } | null }
  /** Git's answers for a folder other than the default one: null is a folder that is not a repository (#382). */
  gitAt: Record<string, Record<string, string> | null>
  /** The commit the mod's own folder is a dev checkout at (#400); null is an installed copy, which has no repository. */
  devBuild: { value: string | null }
  /** What `hostname` and macOS's `scutil --get LocalHostName` print; `local` null is a machine with no `scutil` (it exits 1). */
  hosts: { hostname: string; local: string | null }
  /** What `claude agents --json` lists (#595); null is a machine where the command fails. */
  agents: { value: { sessionId: string; name?: string }[] | null }
  /** Every status line the plugin set. */
  statuses: (string | undefined)[]
  /** What the server's reply says about itself: its build (#400). */
  serverBuild: { value: string | null }
  /** Where each request went: the URL, and the socket when it was sent through the TLS helper (#584). */
  fetched: { url: string; socketPath?: string }[]
  /** Every toast the plugin showed. */
  toasts: string[]
}

const GIT: Record<string, string> = {
  'rev-parse --abbrev-ref HEAD': 'feat/x',
  'rev-parse --git-dir': '/Users/dev/app/.git/worktrees/feat-x',
  'rev-parse --git-common-dir': '/Users/dev/app/.git',
  'rev-parse --show-toplevel': CWD,
  'status --porcelain=v1 -b': '## feat/x...origin/feat/x [ahead 2]\n M src/a.ts\n',
}

/** Everything beneath the plugin: the engine's answers, from memory. */
function world(on: On, store: Record<string, unknown> = {}, files: Record<string, string> = {}): World {
  const posts: Report[] = []
  const headers: Record<string, string>[] = []
  const sessionId = { value: SID }
  const fetchMode: World['fetchMode'] = { mode: 'ok' }
  const surfaces: World['surfaces'] = { value: ['terminal'], fail: false }
  let toolUseId = ''
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on, store)
  const kept: World['files'] = { text: { ...files }, broken: false }
  on('fs.read', (_$, e) => {
    if (kept.broken || !(e.path in kept.text)) throw new Error('ENOENT')
    return { value: kept.text[e.path]! }
  })
  on('fs.write', (_$, e) => {
    if (kept.broken) throw new Error('EACCES')
    kept.text[e.path] = e.text
    return { value: undefined }
  })
  const ran: string[][] = []
  const place: World['place'] = { cwd: CWD, root: CWD, repo: { root: '/Users/dev/app', remote: 'git@github.com:acme/app.git', internal: false, name: null } }
  const gitAt: World['gitAt'] = {}
  const devBuild: World['devBuild'] = { value: null }
  const hosts: World['hosts'] = { hostname: 'Devs-MBP.local\n', local: null }
  const agents: World['agents'] = { value: null }
  const statuses: World['statuses'] = []
  const serverBuild: World['serverBuild'] = { value: null }
  const fetched: World['fetched'] = []
  const toasts: string[] = []
  const watch: World['watch'] = { value: [] }
  const watchOutput: World['watchOutput'] = { value: null }
  const bash: World['bash'] = { results: {} }
  const chunks: World['chunks'] = { value: [] }
  on('session.id', () => ({ value: sessionId.value }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => {
    if (place.cwd === null) throw new Error('no cwd')
    return { value: place.cwd }
  })
  on('session.root', () => ({ value: place.root }))
  on('session.repo', () => ({ value: place.repo }))
  on('session.version', () => ({ value: { version: '2.1.296' } }))
  on('session.usage', () => ({ value: { startedAt: 1_800_000_000_000, context: { tokens: 120_000, window: 1_000_000, percent: 12 }, rateLimits: [], cost: { usd: 1.25 } } }))
  on('session.surfaces', () => {
    if (surfaces.fail) throw new Error('no roster')
    return { value: surfaces.value }
  })
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.detach', (_$, e) => ({ clientId: e.clientId }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'podium' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__podium-reporter__plan' } }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'claude' && e.argv[1] === 'agents') {
      return { value: { exitCode: agents.value === null ? 1 : 0, stdout: agents.value === null ? '' : JSON.stringify(agents.value), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[1] === '-C') {
      // the mod's own folder: a dev checkout names a commit, an installed copy is no repository (#400)
      const sub = e.argv.slice(3).join(' ')
      const out = devBuild.value === null ? undefined : sub === 'rev-parse --short=8 HEAD' ? `${devBuild.value}\n` : sub === 'ls-files --error-unmatch .claude-plugin/plugin.json' || sub === 'status --porcelain -- .' ? '' : undefined
      return { value: { exitCode: out === undefined ? 128 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const at = e.init?.cwd
    const here = at !== undefined && at in gitAt ? gitAt[at] : undefined
    if (here !== undefined) {
      const out = here?.[e.argv.slice(1).join(' ')]
      return { value: { exitCode: out === undefined ? 128 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'hostname') return { value: { exitCode: 0, stdout: hosts.hostname, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'scutil') return { value: { exitCode: hosts.local === null ? 1 : 0, stdout: hosts.local ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: e.argv[1] === 'rev-parse' || e.argv[1] === 'status' ? 0 : 1, stdout: GIT[e.argv.slice(1).join(' ')] ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', (_$, e) => {
    if (fetchMode.mode === 'down') throw new Error('ECONNREFUSED')
    fetched.push({ url: e.url, socketPath: e.init?.socketPath })
    if (fetchMode.mode === 'denied') return { value: { status: 401, ok: false, headers: {}, text: '{"ok":false,"error":"client certificate refused"}' } }
    const body = JSON.parse(e.init?.body ?? '{}') as Report
    if (fetchMode.mode === 'hang') return new Promise(() => {})
    posts.push(body)
    headers.push(e.init?.headers ?? {})
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, ackedEvents: body.events.length, liveSessions: 3, watch: watch.value, ...(watchOutput.value ? { watchOutput: watchOutput.value } : {}), serverVersion: '1.1.0', serverBuild: serverBuild.value }) } }
  })
  on('session.start', () => ({ cwd: CWD }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 1_000_000, tokensAfter: 300_000 }))
  on('agent.spawn', (_$, e) => ({ model: e.fork ? e.parentModel : e.model === 'haiku' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5', agentId: e.fork ? 'a-fork' : e.description === 'Backfill dry run' ? 'a-fail' : 'a-sub' }))
  on('tool.call', (_$, e) => {
    toolUseId = e.tool_use_id
    if (e.tool === 'TaskCreate') return { result: { task: { id: '1', subject: e.subject } } }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }
    if (e.tool === 'Bash') {
      const hit = Object.keys(bash.results).find((k) => e.command.includes(k))
      if (hit && (bash.results[hit] as { throws?: boolean }).throws) throw new Error('tool blew up')
      if (hit) return bash.results[hit] as never
    }
    if (e.tool === 'Bash' && e.command.startsWith('npm test')) return { isError: true, result: 'Exit code 1\nFAIL src/a.test.ts', text: 'Exit code 1\nFAIL src/a.test.ts' }
    return { result: { ok: true }, text: 'ok' }
  })
  on('turn.step', async function* (_$, e) {
    const big = e.agentId === 'a-fail'
    for (const c of chunks.value) yield c
    return {
      turnId: e.turnId,
      index: e.index,
      answer: chunks.value.map((c) => (c.kind === 'text' ? c.text : '')).join(''),
      toolUses: [],
      stopReason: big ? 'model_context_window_exceeded' : 'end_turn',
      usage: { input_tokens: big ? 990_000 : 2000, output_tokens: 300, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 1000, model: e.model },
    }
  })
  on('classic.PermissionRequest', () => ({}))
  on('classic.Notification', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  return { posts, headers, clock, lastToolUseId: () => toolUseId, sessionId, fetchMode, surfaces, ran, watch, watchOutput, bash, chunks, files: kept, place, gitAt, devBuild, hosts, agents, statuses, serverBuild, fetched, toasts }
}

type StepArgs = Parameters<Engine['turn']['step']>[0]

/** Raises one model request and reads its stream to the end, as the engine's loop does. */
async function stepOnce($: Engine, input: StepArgs) {
  // `for await` drops a generator's return value, which is the step's result: read it by hand.
  const s = $.turn.step(input)
  let r = await s.next()
  while (!r.done) r = await s.next()
  return r.value
}

const spawnInput = (over: Partial<AgentSpawnInput> & { tool_use_id: string }): AgentSpawnInput => ({
  prompt: 'Do the task.',
  description: 'Map call sites',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
  ...over,
})

/** `/podium <args>` typed at the prompt. */
const podium = (args: string): CommandRunInput => ({ command: 'podium', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

describe('podium-reporter end to end', () => {
  test('raises every hooked event and posts agents, plan, failure, blowouts and skills', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(w.posts.length).toBe(1)
    expect(w.posts[0]!.session).toMatchObject({ id: SID, name: 'x', repoName: 'acme/app', costUsd: 1.25 })
    expect(w.posts[0]!.events.map((e) => e.kind)).toContain('start')

    await $.turn.start({ text: 'go', turnId: 't1' })
    await stepOnce($, { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Map call sites', description: 'find them', metadata: { planTitle: 'Migrate invoices' } })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
    await $.tool.call({ tool: 'Skill', skill: 'repo-map' })

    // a subagent: the Agent call asks for effort low; its own steps then show medium
    await $.tool.call({ tool: 'Agent', description: 'Map call sites', prompt: 'Do the task.', subagent_type: 'Explore', model: 'haiku', effort: 'low' })
    await $.agent.spawn(spawnInput({ tool_use_id: w.lastToolUseId(), model: 'haiku' }))
    await stepOnce($, { turnId: 'ta', index: 0, model: 'claude-haiku-5-5', effort: 'medium', messageCount: 2, agentId: 'a-sub' })
    await $.turn.complete({ answer: 'Found 3 call sites.', durationMs: 900, isAborted: false, turnId: 'ta', agentId: 'a-sub', reason: 'answer' })

    // a fork: inherits model and effort
    await $.tool.call({ tool: 'Agent', description: 'Draft schema', prompt: 'Draft it.', subagent_type: 'fork', effort: 'max' })
    await $.agent.spawn(spawnInput({ tool_use_id: w.lastToolUseId(), description: 'Draft schema', subagentType: 'fork', fork: true }))

    // a subagent that exceeds its window, auto-compacts, and dies on an API error
    await $.agent.spawn(spawnInput({ tool_use_id: 'tu-fail', description: 'Backfill dry run', subagentType: 'general-purpose', model: 'sonnet' }))
    await stepOnce($, { turnId: 'tf', index: 0, model: 'claude-sonnet-5-5', messageCount: 9, agentId: 'a-fail' })
    await $.session.compact({ trigger: 'auto', agentId: 'a-fail', messages: SUMMARY })
    await $.turn.complete({ answer: '', durationMs: 900, isAborted: false, turnId: 'tf', agentId: 'a-fail', reason: 'error' })

    // the orchestrator: a failing Bash, a permission prompt, an automatic compaction
    await $.tool.call({ tool: 'Bash', command: 'npm test -- a.test.ts' })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } })
    await w.clock.advance(1000)
    const waiting = w.posts.at(-1)!.session
    expect(waiting).toMatchObject({ status: 'waiting', waitReason: 'permission', waitNote: 'Bash(rm -rf dist)' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.session.compact({ trigger: 'auto', messages: SUMMARY })
    await $.turn.complete({ answer: 'done', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' })
    await w.clock.advance(1000)

    const r = w.posts.at(-1)!
    const agent = (id: string) => r.agents.find((a) => a.id === id)!
    expect(agent('a-sub')).toMatchObject({ kind: 'subagent', type: 'Explore', status: 'done', model: 'claude-haiku-5-5', effort: 'medium', effortSource: 'observed', answerExcerpt: 'Found 3 call sites.' })
    expect(agent('a-fork')).toMatchObject({ kind: 'fork', type: 'fork', status: 'running', model: 'claude-opus-5-5', effort: 'high', effortSource: 'inherited' })
    expect(agent('a-fail')).toMatchObject({ status: 'failed', blowouts: 1 })
    expect(agent('a-fail').failure!.class).toBe('Context window exhausted')
    expect(agent('a-fail').failure!.evidence[0]).toContain('exceeded the context window 1 time')
    expect(r.session.plan).toMatchObject({ title: 'Migrate invoices', source: 'TaskCreate' })
    expect(r.session.plan!.steps[0]).toMatchObject({ id: '1', state: 'active', ownerAgentId: 'a-sub', ownerLabel: 'Explore · Haiku medium' })
    expect(r.session.blowouts).toBe(1)
    expect(r.session.git).toEqual({ branch: 'feat/x', detached: false, isWorktree: true, worktreePath: CWD, ahead: 2, behind: 0, dirty: 1 })
    expect(r.session.status).toBe('running') // the fork still runs
    expect(r.session.waitReason).toBeNull()
    const all = w.posts.flatMap((p) => p.events)
    expect(all.some((e) => e.kind === 'skill' && e.text === 'repo-map loaded into orchestrator')).toBe(true)
    expect(all.filter((e) => e.kind === 'blow').map((e) => e.data?.kind)).toEqual(['window-exceeded', 'auto-compact'])
    expect(all.some((e) => e.kind === 'fail' && e.agentId === 'a-fail')).toBe(true)
    expect(all.some((e) => e.kind === 'wait')).toBe(true)
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length)

    // session.end flushes the final report before the hook returns
    const before = w.posts.length
    await $.session.end({ reason: 'prompt_input_exit', sessionId: SID, resume: { id: SID } })
    expect(w.posts.length).toBe(before + 1)
    expect(w.posts.at(-1)!.session).toMatchObject({ status: 'done', endReason: 'prompt_input_exit', resumeId: SID })
    expect(agent('a-fork').status).toBe('running')
    expect(w.posts.at(-1)!.agents.find((a) => a.id === 'a-fork')!.status).toBe('aborted')
    // timers stop with the process
    await w.clock.advance(10_000)
    expect(w.posts.length).toBe(before + 1)
  })

  test('the token header is sent only when configured', { options: { token: 's3cret' } }, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.headers[0]!['X-Podium-Token']).toBe('s3cret')
  })

  // A tool's result must be text, content blocks or nothing: Claude Code turns any other shape into an error,
  // and an errored call never sets the title.
  test('the plan tool answers in text and the console gets the title', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const res = await $.tool.call({ tool: 'mcp__podium-reporter__plan', title: 'Ship the booth game', phase: 'M1' } as never)
    expect(res).not.toHaveProperty('isError', true)
    expect(typeof (res as { result?: unknown }).result).toBe('string')
    // A plan is reported once it has a step.
    await $.tool.call({ tool: 'TaskCreate', subject: 'Engine', description: 'build it' })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.plan).toMatchObject({ title: 'Ship the booth game · M1' })
  })

  test('every hook passes the engine result through unchanged', async ($, on) => {
    world(on)
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    expect(await $.tool.call({ tool: 'Bash', command: 'npm test' })).toMatchObject({ isError: true, text: 'Exit code 1\nFAIL src/a.test.ts' })
    expect(await $.tool.call({ tool: 'Read', file_path: '/x' })).toMatchObject({ result: { ok: true }, text: 'ok' })
    expect(await $.turn.start({ text: 'x', turnId: 'q' })).toEqual({ turnId: 'q' })
    const st = await stepOnce($, { turnId: 'q', index: 0, model: 'opus', messageCount: 1 })
    expect(st.stopReason).toBe('end_turn')
    expect(await $.session.compact({ trigger: 'manual', messages: SUMMARY })).toMatchObject({ tokensAfter: 300_000 })
    expect(await $.agent.spawn(spawnInput({ tool_use_id: 'z' }))).toEqual({ model: 'claude-sonnet-5-5', agentId: 'a-sub' })
  })

  test('the tool path never waits for the network', async ($, on) => {
    const w = world(on)
    w.fetchMode.mode = 'hang'
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000) // a flush is now stuck in fetch
    const t0 = Date.now()
    const res = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(res).toMatchObject({ text: 'ok' })
    await $.turn.start({ text: 'x', turnId: 'q' })
    await stepOnce($, { turnId: 'q', index: 0, model: 'opus', messageCount: 1 })
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  test('with the server down, events wait in the queue and arrive once it is back', async ($, on) => {
    const w = world(on)
    w.fetchMode.mode = 'down'
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    for (let i = 0; i < 5; i++) await $.tool.call({ tool: 'Skill', skill: `skill-${i}` })
    await w.clock.advance(30_000)
    expect(w.posts.length).toBe(0)
    w.fetchMode.mode = 'ok'
    await w.clock.advance(11_000)
    const kinds = w.posts.flatMap((p) => p.events).map((e) => e.text)
    for (let i = 0; i < 5; i++) expect(kinds).toContain(`skill-${i} loaded into orchestrator`)
    const help = await $.command.run(podium(''))
    expect(help.text).toContain('Connection: online')
    expect(help.text).toMatch(/failed: [1-9]/)
  })

  test('with the server down the reporter adds under 5 ms per hook (its own time, measured)', async ($, on) => {
    const w = world(on)
    w.fetchMode.mode = 'down'
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    for (let i = 0; i < 300; i++) {
      await $.tool.call({ tool: 'Read', file_path: `/f${i % 7}` })
      if (i % 10 === 0) await w.clock.advance(1000)
      await stepOnce($, { turnId: 'q', index: i, model: 'claude-opus-5-5', effort: 'high', messageCount: i })
    }
    const text = (await $.command.run(podium(''))).text ?? ''
    const line = text.split('\n').find((l) => l.startsWith('Reporter time per hook:')) ?? ''
    console.log(`[podium-latency] ${line}`)
    const avgs = [...line.matchAll(/([\w.]+) ([\d.]+) ms avg, ([\d.]+) max/g)].map((m) => ({ hook: m[1]!, avg: Number(m[2]), max: Number(m[3]) }))
    expect(avgs.length).toBeGreaterThan(2)
    for (const a of avgs) expect(a.avg).toBeLessThan(5)
    expect(text).toContain('offline')
  })

  test('server down for 2 minutes, then up: no event is lost', async ($, on) => {
    const w = world(on)
    w.fetchMode.mode = 'down'
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    // events keep arriving all through the outage: 24 skills, one every 5 s
    for (let i = 0; i < 24; i++) {
      await $.tool.call({ tool: 'Skill', skill: `outage-${i}` })
      await w.clock.advance(5000)
    }
    expect(w.posts.length).toBe(0)
    w.fetchMode.mode = 'ok'
    await w.clock.advance(12_000)
    const texts = new Set(w.posts.flatMap((p) => p.events).map((e) => e.text))
    for (let i = 0; i < 24; i++) expect(texts.has(`outage-${i} loaded into orchestrator`)).toBe(true)
    expect(texts.has('session.start · Opus')).toBe(true)
  })

  test('fullPrompts off (default): only the 400-character excerpt leaves', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await $.agent.spawn(spawnInput({ tool_use_id: 'f1', prompt: '# Task\n\nDo it.' }))
    await w.clock.advance(3000)
    const a = w.posts.at(-1)!.agents[0]!
    expect(a.promptExcerpt).toBe('# Task Do it.')
    expect('promptText' in a).toBe(false)
  })

  test('fullPrompts on: the whole prompt goes out once, then not again', { options: { fullPrompts: true } }, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await $.agent.spawn(spawnInput({ tool_use_id: 'f1', prompt: '# Task\n\nDo it.' }))
    await w.clock.advance(3000)
    const first = w.posts.filter((p) => p.agents[0]?.promptText)
    expect(first.length).toBe(1)
    expect(first[0]!.agents[0]!.promptText).toBe('# Task\n\nDo it.')
    await w.clock.advance(12_000)
    expect(w.posts.filter((p) => p.agents[0]?.promptText).length).toBe(1)
    expect(w.posts.length).toBeGreaterThan(1)
  })

  test('explainFailures off (default): no model call', async ($, on) => {
    const w = world(on)
    let calls = 0
    on('model.complete', () => {
      calls++
      return { value: { isAnswered: true, text: 'x', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
    })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await $.agent.spawn(spawnInput({ tool_use_id: 'f1', description: 'Backfill dry run', subagentType: 'general-purpose' }))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', agentId: 'a-fail', reason: 'error' })
    await w.clock.advance(3000)
    expect(calls).toBe(0)
    expect(w.posts.at(-1)!.agents[0]!.failure!.explanation).toBeNull()
  })

  test('explainFailures on: one haiku call per failure, from the redacted record, never retried', { options: { explainFailures: true } }, async ($, on) => {
    const w = world(on)
    const prompts: string[] = []
    let fail = true
    on('model.complete', (_$, e) => {
      prompts.push(String(e.prompt))
      expect(e.model).toBe('haiku')
      expect(e.effort).toBe('low')
      if (fail) {
        fail = false
        return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
      }
      return { value: { isAnswered: true, text: 'The staging database was not reachable.   Start it first.', usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
    })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    // first failure: the call errors, and is not retried
    await $.agent.spawn(spawnInput({ tool_use_id: 'f1', description: 'Backfill dry run', subagentType: 'general-purpose', prompt: 'password=hunter2 run it' }))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', agentId: 'a-fail', reason: 'error' })
    await w.clock.advance(1000)
    await w.clock.advance(5000)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Class: Model API error')
    expect(prompts[0]).not.toContain('hunter2')
    expect(w.posts.at(-1)!.agents.find((a) => a.id === 'a-fail')!.failure!.explanation).toBeNull()
    // second failure (another agent): explained once
    await $.agent.spawn(spawnInput({ tool_use_id: 'f2', description: 'Second', subagentType: 'general-purpose' }))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'y', agentId: 'a-sub', reason: 'error' })
    await w.clock.advance(1000)
    await w.clock.advance(2000)
    expect(prompts).toHaveLength(2)
    const a = w.posts.at(-1)!.agents.find((x) => x.id === 'a-sub')!
    expect(a.failure!.explanation).toBe('The staging database was not reachable. Start it first.')
    expect(a.costUsdEst).toBeGreaterThan(0)
  })

  test('explainFailures on: a later failure of the same agent is explained again, but one failure only once', { options: { explainFailures: true } }, async ($, on) => {
    const w = world(on)
    const prompts: string[] = []
    on('model.complete', (_$, e) => {
      prompts.push(String(e.prompt))
      return { value: { isAnswered: true, text: `explanation ${prompts.length}`, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
    })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await $.agent.spawn(spawnInput({ tool_use_id: 'r1', description: 'Backfill dry run', subagentType: 'general-purpose' }))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', agentId: 'a-fail', reason: 'error' })
    await w.clock.advance(1000)
    await w.clock.advance(3000)
    await w.clock.advance(3000) // several flushes later: still one call for this failure
    expect(prompts).toHaveLength(1)
    expect(w.posts.at(-1)!.agents.find((a) => a.id === 'a-fail')!.failure!.explanation).toBe('explanation 1')
    // the same agent id is retried and fails again later: a new failure, a new explanation
    await $.agent.spawn(spawnInput({ tool_use_id: 'r2', description: 'Backfill dry run', subagentType: 'general-purpose' }))
    await w.clock.advance(5000)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'y', agentId: 'a-fail', reason: 'error' })
    await w.clock.advance(1000)
    await w.clock.advance(3000)
    expect(prompts).toHaveLength(2)
    expect(w.posts.at(-1)!.agents.find((a) => a.id === 'a-fail')!.failure!.explanation).toBe('explanation 2')
  })

  test('a throw inside the reporter leaves the session unaffected', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    // a malformed classic payload makes the reporter's own reducer throw
    const res = await $.classic.Notification({ notification_type: 'idle_prompt', message: undefined as unknown as string })
    expect(res).toEqual({})
    // the session goes on, and the reporter keeps reporting
    expect(await $.tool.call({ tool: 'Read', file_path: '/x' })).toMatchObject({ text: 'ok' })
    await w.clock.advance(1000)
    expect(w.posts.length).toBe(1)
  })

  test('/podium shows the dashboard URL and state; /podium name sets and keeps the name', { options: { serverUrl: 'http://127.0.0.1:5999' } }, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    const info = await $.command.run(podium(''))
    expect(info.text).toContain('Podium fleet console: http://127.0.0.1:5999/#/')
    expect(info.text).toContain('Connection: online (3 live sessions)')
    expect(info.text).toContain('Reports sent: 1, failed: 0')
    expect(info.text).toContain('Last error: none')
    const named = await $.command.run(podium('name invoice work'))
    expect(named.text).toContain('"invoice work"')
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.name).toBe('invoice work')
    // the name is kept in $.store: a reload (session.start again) still has it
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.name).toBe('invoice work')
  })

  test('a mod run from a dev checkout reports its commit and shows it after the version in the status line, /podium and the report (#400)', async ($, on) => {
    const w = world(on)
    w.devBuild.value = 'a1b2c3d4'
    w.serverBuild.value = '9f8e7d6c'
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(w.posts[0]!.reporter.build).toBe('a1b2c3d4')
    expect(w.statuses.at(-1)).toBe(`podium v${VERSION} | dev: a1b2c3d4 ● 3 live`)
    const info = await $.command.run(podium(''))
    expect(info.text).toContain(`Versions: reporter ${VERSION} · Dev: a1b2c3d4, server 1.1.0 · Dev: 9f8e7d6c`)
    expect(w.ran.filter((a) => a[1] === '-C').length).toBeGreaterThan(0)
  })

  test('an installed mod, which is a release, reports no build and shows the version alone (#400)', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(w.posts[0]!.reporter).not.toHaveProperty('build')
    expect(w.statuses.at(-1)).toBe(`podium v${VERSION} ● 3 live`)
    const info = await $.command.run(podium(''))
    expect(info.text).toContain(`Versions: reporter ${VERSION}, server 1.1.0`)
  })

  test("Claude Code's own session name is the display name once a hook carries it (#322)", async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    // nothing named yet: the worktree branch, as before
    expect(w.posts.at(-1)!.session.name).toBe('x')
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_title: '  Calendar filters  ' })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.name).toBe('Calendar filters')
    // a prompt with no title leaves the name alone
    await $.classic.UserPromptSubmit({ prompt: 'again' })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.name).toBe('Calendar filters')
    // a rename shows on the next prompt
    await $.classic.UserPromptSubmit({ prompt: 'more', session_title: 'Pi display' })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.name).toBe('Pi display')
  })

  test("a title on classic.SessionStart names the session too, and /podium name still wins (#322)", { options: { sessionName: 'from option' } }, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'resume', session_title: 'Pi display' })
    await w.clock.advance(1000)
    // above the sessionName option
    expect(w.posts.at(-1)!.session.name).toBe('Pi display')
    await $.command.run(podium('name explicit'))
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.name).toBe('explicit')
  })

  test("background work comes only from classic.Stop; where Claude Code skips that hook the card shows none (#740)", async ($, on) => {
    const w = world(on)
    on('classic.Stop', () => ({}))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await $.turn.start({ turnId: 't1', prompt: 'watch the build', agentId: undefined } as never)
    // a background shell and a wake-up are launched; the engine offers no event or call that lists them
    await $.tool.call({ tool: 'Bash', command: 'npm run watch', run_in_background: true } as never)
    await $.turn.complete({ answer: 'started', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await w.clock.advance(1000)
    // classic.Stop was skipped (Team/Enterprise guard): the session looks like one with nothing running, and waits on the person
    expect(w.posts.at(-1)!.session.background ?? null).toBeNull()
    expect(w.posts.at(-1)!.session).toMatchObject({ status: 'waiting', waitReason: 'input' })
    // where the hook runs, the same session shows what it waits on
    await $.classic.Stop({
      stop_hook_active: false,
      background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm run watch' }],
      session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check' }],
    })
    await w.clock.advance(1000)
    const shown = w.posts.at(-1)!.session
    expect(shown.waitReason).toBeNull()
    expect(shown.background!.tasks[0]).toMatchObject({ type: 'shell', description: 'npm run watch' })
    expect(shown.background!.wakeAt).not.toBeNull()
    // a Stop with no lists clears it
    await $.classic.Stop({ stop_hook_active: false })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.background ?? null).toBeNull()
  })

  test("the app's title from `claude agents --json` names a session no hook gave a title (#595)", async ($, on) => {
    const w = world(on)
    w.agents.value = [
      { sessionId: 'someone-else', name: 'Other session' },
      { sessionId: SID, name: '  Panel de agentes  ' },
    ]
    await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
    await w.clock.advance(11_000)
    expect(w.ran).toContainEqual(['claude', 'agents', '--json'])
    expect(w.posts.at(-1)!.session.name).toBe('Panel de agentes')
    // the app's rename shows from the next poll
    w.agents.value = [{ sessionId: SID, name: 'Renamed in the sidebar' }]
    await w.clock.advance(30_000)
    expect(w.posts.at(-1)!.session.name).toBe('Renamed in the sidebar')
  })

  test("a hook's title outranks the app's, and /podium name outranks both (#595)", async ($, on) => {
    const w = world(on)
    w.agents.value = [{ sessionId: SID, name: 'From the app' }]
    await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
    await w.clock.advance(11_000)
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_title: 'From the hook' })
    await w.clock.advance(11_000)
    expect(w.posts.at(-1)!.session.name).toBe('From the hook')
    await $.command.run(podium('name explicit'))
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.name).toBe('explicit')
  })

  test("a failing or unlisted `claude agents --json` leaves the name alone, and the app's title does not carry over to a new id (#595)", async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
    await w.clock.advance(11_000)
    expect(w.posts.at(-1)!.session.name).toBe('x')
    w.agents.value = [{ sessionId: SID, name: 'From the app' }]
    await w.clock.advance(30_000)
    expect(w.posts.at(-1)!.session.name).toBe('From the app')
    w.sessionId.value = 'sess-after-clear'
    w.agents.value = null
    await w.clock.advance(11_000)
    expect(w.posts.at(-1)!.session.id).toBe('sess-after-clear')
    expect(w.posts.at(-1)!.session.name).toBe('x')
  })

  test("Claude Code's name does not carry over to a new session id (#322)", async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_title: 'Calendar filters' })
    await w.clock.advance(1000)
    w.sessionId.value = 'sess-after-clear'
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.id).toBe('sess-after-clear')
    expect(w.posts.at(-1)!.session.name).toBe('x')
  })

  test('a spare the app moves to a project reports the project once $.session answers it (#382)', async ($, on) => {
    const w = world(on)
    w.place.cwd = SPARE
    w.place.root = SPARE
    w.place.repo = null
    w.gitAt[SPARE] = null
    w.gitAt[PROJECT] = PROJECT_GIT
    await $.session.start({ cwd: SPARE, surface: 'desktop', isInteractive: true })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session).toMatchObject({ name: 'spare-eB3Cs1', cwd: SPARE, projectRoot: SPARE, git: null })
    w.place.cwd = PROJECT
    w.place.root = PROJECT
    w.place.repo = { root: PROJECT, remote: 'git@github.com:acme/podium.git', internal: false, name: null }
    await w.clock.advance(10_000)
    expect(w.posts.at(-1)!.session).toMatchObject({ name: 'podium', cwd: PROJECT, projectRoot: PROJECT, repoName: 'acme/podium', git: { branch: 'main' } })
  })

  test('a spare whose $.session keeps the spare folder takes the folder a hook carries, from git (#382)', async ($, on) => {
    const w = world(on)
    w.place.cwd = SPARE
    w.place.root = SPARE
    w.place.repo = null
    w.gitAt[SPARE] = null
    w.gitAt[PROJECT] = PROJECT_GIT
    await $.session.start({ cwd: SPARE, surface: 'desktop', isInteractive: true })
    await $.classic.UserPromptSubmit({ prompt: 'hi', cwd: PROJECT })
    await w.clock.advance(10_000)
    expect(w.posts.at(-1)!.session).toMatchObject({ name: 'podium', cwd: PROJECT, projectRoot: PROJECT, repoName: 'acme/podium', git: { branch: 'main' } })
    // $.session still answers the spare folder: a later poll does not take the session back there
    await w.clock.advance(10_000)
    expect(w.posts.at(-1)!.session).toMatchObject({ cwd: PROJECT, projectRoot: PROJECT, git: { branch: 'main' } })
  })

  test('a hook cwd inside the place already reported is a cd, not a move (#382)', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await $.classic.UserPromptSubmit({ prompt: 'hi', cwd: `${CWD}/src` })
    await w.clock.advance(10_000)
    expect(w.posts.at(-1)!.session).toMatchObject({ cwd: CWD, projectRoot: '/Users/dev/app' })
  })

  test('a session moved to a folder that is not a repository reports that folder (#382)', async ($, on) => {
    const w = world(on)
    w.place.cwd = SPARE
    w.place.root = SPARE
    w.place.repo = null
    w.gitAt[SPARE] = null
    w.gitAt['/Users/dev/notes'] = null
    await $.session.start({ cwd: SPARE, surface: 'desktop', isInteractive: true })
    await $.classic.SessionStart({ source: 'startup', cwd: '/Users/dev/notes' })
    await w.clock.advance(10_000)
    expect(w.posts.at(-1)!.session).toMatchObject({ name: 'notes', cwd: '/Users/dev/notes', projectRoot: '/Users/dev/notes', repoName: 'notes', git: null })
  })

  test('reports whether any client is attached, from the roster', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.attached).toBe(true)
    w.surfaces.value = []
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.attached).toBe(false)
    w.surfaces.value = ['terminal']
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.attached).toBe(true)
  })

  test('a session the desktop app keeps open stays attached when another session is on screen (#594)', async ($, on) => {
    const w = world(on)
    w.surfaces.value = ['desktop']
    await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.attached).toBe(true)
    w.surfaces.value = []
    await w.clock.advance(6000)
    expect(w.posts.at(-1)!.session.attached).toBe(true)
    // Deleting the session from the app ends it, and that is what takes it off the wall.
    await $.session.end({ reason: 'prompt_input_exit', sessionId: SID, resume: { id: SID } })
    expect(w.posts.at(-1)!.session.status).toBe('done')
  })

  test('a session that starts on the desktop surface is attached even when its first roster read is empty (#594)', async ($, on) => {
    const w = world(on)
    w.surfaces.value = []
    await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.attached).toBe(true)
  })

  test('a desktop client seen on the roster survives a failed roster read and a restart of the same session (#594)', async ($, on) => {
    const w = world(on)
    w.surfaces.value = ['desktop']
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    w.surfaces.fail = true
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.attached).toBe(true)
    w.surfaces.fail = false
    w.surfaces.value = []
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.attached).toBe(true)
  })

  test('a terminal session that never had the desktop app on it still reads as detached once its roster empties (#594)', async ($, on) => {
    const w = world(on)
    w.surfaces.value = ['terminal']
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    w.surfaces.value = []
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.attached).toBe(false)
  })

  test('session.detach and session.attach pass through and the next report follows the roster', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    w.surfaces.value = []
    expect(await $.session.detach({ surface: 'terminal', clientId: 'terminal:default', reason: 'detach' })).toEqual({ clientId: 'terminal:default' })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.attached).toBe(false)
    w.surfaces.value = ['terminal']
    expect(await $.session.attach({ surface: 'terminal', clientId: 'terminal:default' })).toEqual({ clientId: 'terminal:default' })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.attached).toBe(true)
  })

  test('a failing roster read leaves the flag unknown rather than detached', async ($, on) => {
    const w = world(on)
    w.surfaces.fail = true
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.attached).toBeNull()
  })

  test('a /clear: the old id gets a final done report and reporting continues under the new id', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } })
    expect(w.posts.at(-1)!.session).toMatchObject({ id: SID, status: 'done', endReason: 'clear' })
    w.sessionId.value = 'sess-after-clear'
    await w.clock.advance(1000)
    const next = w.posts.at(-1)!
    expect(next.session.id).toBe('sess-after-clear')
    expect(next.session.status).not.toBe('done')
    expect(next.events.map((e) => e.kind)).toContain('start')
    expect(next.events.every((e) => e.id.startsWith('sess-after-clear:'))).toBe(true)
  })

  test('a session id change without session.end still closes the old id', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    w.sessionId.value = 'sess-resumed'
    await w.clock.advance(1000)
    const ids = w.posts.map((p) => [p.session.id, p.session.status])
    expect(ids).toContainEqual([SID, 'done'])
    expect(w.posts.at(-1)!.session.id).toBe('sess-resumed')
  })

  test('the userName option is sent with every report, and is left out when empty', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.userName).toBe('Dana')
  })

  test('PODIUM_USER and PODIUM_TOKEN name this terminal ahead of the shared options (#226)', { options: { userName: 'Admin', token: 'admin-secret' } }, async ($, on) => {
    const w = world(on)
    mock.env(on, { PODIUM_USER: 'Ed', PODIUM_TOKEN: 'ed-token' })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.userName).toBe('Ed')
    expect(w.headers[0]!['X-Podium-Token']).toBe('ed-token')
  })

  test('without PODIUM_USER the shared options apply, so a single terminal works as before (#226)', { options: { userName: 'Dana', token: 'dana-token' } }, async ($, on) => {
    const w = world(on)
    mock.env(on, {})
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.userName).toBe('Dana')
    expect(w.headers[0]!['X-Podium-Token']).toBe('dana-token')
  })

  test('no userName is sent when the option is empty', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect('userName' in w.posts[0]!).toBe(false)
  })

  test('with a userName the report names the machine: its short host name and a random id that stays', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    const m = w.posts[0]!.machine!
    expect(m.name).toBe('Devs-MBP')
    expect(m.id).toMatch(/^[0-9a-f]{12}$/)
    await w.clock.advance(5000)
    expect(w.posts.at(-1)!.machine).toEqual(m)
  })

  test('a machine id already kept in the store is reused', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on, { machineId: 'abcdef012345' })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.machine).toEqual({ name: 'Devs-MBP', id: 'abcdef012345' })
  })

  const SHARED = '/Users/dev/.claude/podium-machine-id'

  test('a machine id in the shared file wins over the one in this load\'s store, so two plugin loads agree (#267)', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on, { machineId: 'aaaaaaaaaaaa' }, { [SHARED]: 'cccccccccccc\n' })
    mock.env(on, { HOME: '/Users/dev' })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.machine!.id).toBe('cccccccccccc')
  })

  test('an id from this load\'s store is kept and shared, so the next load adopts it (#267)', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on, { machineId: 'abcdef012345' })
    mock.env(on, { HOME: '/Users/dev' })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.machine!.id).toBe('abcdef012345')
    expect(w.files.text[SHARED]!.trim()).toBe('abcdef012345')
  })

  test('a new id is written to the shared file and reported (#267)', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on)
    mock.env(on, { HOME: '/Users/dev' })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    const id = w.posts[0]!.machine!.id
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    expect(w.files.text[SHARED]!.trim()).toBe(id)
  })

  test('the shared file is under CLAUDE_CONFIG_DIR when that is set (#267)', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on)
    mock.env(on, { HOME: '/Users/dev', CLAUDE_CONFIG_DIR: '/cfg' })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.files.text['/cfg/podium-machine-id']!.trim()).toBe(w.posts[0]!.machine!.id)
    expect(SHARED in w.files.text).toBe(false)
  })

  test('a junk shared file is ignored and the store id is used (#267)', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on, { machineId: 'abcdef012345' }, { [SHARED]: '<b>not-mine</b>' })
    mock.env(on, { HOME: '/Users/dev' })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.machine!.id).toBe('abcdef012345')
  })

  test('when the shared file cannot be read or written the store id still works (#267)', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on, { machineId: 'abcdef012345' })
    mock.env(on, { HOME: '/Users/dev' })
    w.files.broken = true
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.machine).toEqual({ name: 'Devs-MBP', id: 'abcdef012345' })
  })

  test('a kept id that is not one the mod made is replaced', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on, { machineId: '<b>not-mine</b>' })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.machine!.id).toMatch(/^[0-9a-f]{12}$/)
  })

  const NAME_FILE = '/Users/dev/.claude/podium-machine-name'

  test('on a Mac the name is LocalHostName, not `hostname`, which follows the network and can read "Mac" (#715)', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on)
    mock.env(on, { HOME: '/Users/dev' })
    w.hosts.hostname = 'Mac\n'
    w.hosts.local = 'Dana-MacBook-Pro\n'
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.machine!.name).toBe('Dana-MacBook-Pro')
  })

  test('the name is kept in a shared file, so a load started after the host name changed reports the first name (#715)', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on, {}, { [NAME_FILE]: 'Dana-MacBook-Pro\n' })
    mock.env(on, { HOME: '/Users/dev' })
    w.hosts.hostname = 'Mac\n'
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.machine!.name).toBe('Dana-MacBook-Pro')
    expect(w.ran.some((argv) => argv[0] === 'hostname')).toBe(false)
  })

  test('the first name read is written to the shared file beside the id file, under CLAUDE_CONFIG_DIR when set (#715)', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on)
    mock.env(on, { HOME: '/Users/dev', CLAUDE_CONFIG_DIR: '/cfg' })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.machine!.name).toBe('Devs-MBP')
    expect(w.files.text['/cfg/podium-machine-name']!.trim()).toBe('Devs-MBP')
  })

  test('a junk name file is ignored and the live name is used and written over it (#715)', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on, {}, { [NAME_FILE]: '   \n' })
    mock.env(on, { HOME: '/Users/dev' })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.machine!.name).toBe('Devs-MBP')
    expect(w.files.text[NAME_FILE]!.trim()).toBe('Devs-MBP')
  })

  test('where the name file cannot be used the live name is reported as before (#715)', { options: { userName: 'Dana' } }, async ($, on) => {
    const w = world(on, { machineId: 'abcdef012345' })
    mock.env(on, { HOME: '/Users/dev' })
    w.files.broken = true
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.machine).toEqual({ name: 'Devs-MBP', id: 'abcdef012345' })
  })

  test('without a userName nothing about the machine is read or sent', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect('machine' in w.posts[0]!).toBe(false)
    expect(w.ran.some((argv) => argv[0] === 'hostname')).toBe(false)
  })

  test('the sessionName option names the session', { options: { sessionName: 'from-option' } }, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
    await w.clock.advance(1000)
    expect(w.posts[0]!.session.name).toBe('from-option')
  })

  describe('activity command and output (#431)', () => {
    const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'
    const ESC = String.fromCharCode(27)
    const inAgent = <const T extends object>(input: T, agentId = 'a-sub'): T => ({ ...input, agentId })
    /** A session with one subagent, the loops the reply lists as watched and as watched for output, and one report taken in. */
    async function started($: Engine, on: On, watch: string[], watchOutput: string[] | null) {
      const w = world(on)
      w.watch.value = watch
      w.watchOutput.value = watchOutput
      await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
      await $.agent.spawn(spawnInput({ tool_use_id: 'f1' }))
      await w.clock.advance(1000)
      return w
    }
    const sent = (w: World) => JSON.stringify(w.posts)
    const last = (w: World) => w.posts.at(-1)!
    const subFeed = (w: World) => last(w).agents.find((a) => a.id === 'a-sub')!.activity!
    const ON = { options: { activityFeed: true, activityOutput: true } }

    test('the whole command rides activityFeed alone: id, redacted, line breaks kept, with the 300-character summary beside it', { options: { activityFeed: true } }, async ($, on) => {
      const w = await started($, on, ['a-sub'], null)
      await $.tool.call(inAgent({ tool: 'Bash', command: `echo one\ncurl -H "x-api-key: ${SECRET}" http://localhost\necho three` }))
      await w.clock.advance(1000)
      const [e] = subFeed(w)
      expect(e!.kind).toBe('tool')
      expect(e!.id).toBe(w.lastToolUseId())
      expect(e!.command).toMatch(/^echo one\ncurl -H "x-api-key: \[redacted\]/)
      expect(e!.command).toMatch(/\necho three$/)
      expect(e!.text).toMatch(/^Bash echo one curl/)
      expect(e!.output).toBeUndefined()
      expect(last(w).session.activityOutput).toBe(false)
      expect(sent(w)).not.toContain(SECRET)
    })

    test('a command over 20,000 characters is cut with the marker and commandCut', { options: { activityFeed: true } }, async ($, on) => {
      const w = await started($, on, ['a-sub'], null)
      await $.tool.call(inAgent({ tool: 'Bash', command: 'a'.repeat(25_000) }))
      await w.clock.advance(1000)
      const [e] = subFeed(w)
      expect(e!.commandCut).toBe(true)
      expect(e!.command!.endsWith('\n\n[cut off at 20,000 characters]')).toBe(true)
      expect(e!.text).toHaveLength(300)
    })

    test('a call that is not Bash has no id or command, and a command is not sent for an unwatched loop', { options: { activityFeed: true } }, async ($, on) => {
      const w = await started($, on, ['a-sub'], null)
      await $.tool.call(inAgent({ tool: 'Read', file_path: '/x' }))
      await $.tool.call({ tool: 'Bash', command: 'ls main' }) // the orchestrator is not watched
      await w.clock.advance(1000)
      expect(subFeed(w)[0]).toEqual({ at: expect.any(Number), kind: 'tool', text: 'Read /x' })
      expect('activity' in last(w).session).toBe(false)
      expect(sent(w)).not.toContain('ls main')
    })

    test('output goes only with activityOutput on, the loop in watchOutput: the same entry is sent again carrying it, redacted', ON, async ($, on) => {
      const w = await started($, on, ['a-sub', MAIN_LOOP], ['a-sub'])
      w.bash.results['printenv'] = { result: { stdout: `HOME=/Users/x\nANTHROPIC_API_KEY=${SECRET}\n${ESC}[32mok${ESC}[0m\n`, stderr: `warn ghp_${'a1B2'.repeat(10)}`, interrupted: false }, text: 'ignored' }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'printenv' }))
      await w.clock.advance(1000)
      const feed = subFeed(w)
      expect(feed).toHaveLength(1)
      expect(feed[0]!.id).toBe(w.lastToolUseId())
      expect(feed[0]!.command).toBe('printenv')
      expect(feed[0]!.done).toBe(true)
      expect(feed[0]!.output).toMatch(/^HOME=\/Users\/x\nANTHROPIC_API_KEY=\[redacted\]\nok\nwarn /)
      expect(feed[0]!.output).not.toContain(ESC)
      expect(feed[0]!.failed).toBeUndefined()
      expect(feed[0]!.exitCode).toBeUndefined()
      expect(last(w).session.activityOutput).toBe(true)
      expect(sent(w)).not.toContain(SECRET)
      expect(sent(w)).not.toContain('ghp_a1B2')
      // the orchestrator is watched for its feed but not for output: its command and done go, its output does not
      w.bash.results['whoami'] = { result: { stdout: 'root', stderr: '', interrupted: false }, text: 'root' }
      await $.tool.call({ tool: 'Bash', command: 'whoami' })
      await w.clock.advance(1000)
      expect(last(w).session.activity).toEqual([{ at: expect.any(Number), kind: 'tool', text: 'Bash whoami', id: w.lastToolUseId(), command: 'whoami', done: true }])
    })

    test('a secret in a long output (past the bounded redaction pieces) never leaves the mod', ON, async ($, on) => {
      const w = await started($, on, ['a-sub'], ['a-sub'])
      const long = `${'some build output line '.repeat(80)}\nexport AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\ntoken ${SECRET}\n${'more output '.repeat(200)}`
      w.bash.results['dump'] = { result: { stdout: long, stderr: '', interrupted: false } }
      await $.tool.call(inAgent({ tool: 'Bash', command: `dump # ${'x'.repeat(1500)} ${SECRET}` }))
      await w.clock.advance(1000)
      const e = subFeed(w)[0]!
      expect(e.output).toContain('some build output line')
      expect(e.output).toContain('[redacted]')
      expect(sent(w)).not.toContain(SECRET)
      expect(sent(w)).not.toContain('wJalrXUtnFEMI')
    })

    test('output over 20,000 characters is cut with the marker and outputCut', ON, async ($, on) => {
      const w = await started($, on, ['a-sub'], ['a-sub'])
      w.bash.results['big'] = { result: { stdout: 'z'.repeat(60_000), stderr: '', interrupted: false } }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'big' }))
      await w.clock.advance(1000)
      const e = subFeed(w)[0]!
      expect(e.outputCut).toBe(true)
      expect(e.output!.endsWith('\n\n[cut off at 20,000 characters]')).toBe(true)
      expect(e.output).toHaveLength(20_000 + '\n\n[cut off at 20,000 characters]'.length)
    })

    test('a failing call sets failed and done, with the exit code only when its text says it', ON, async ($, on) => {
      const w = await started($, on, ['a-sub'], ['a-sub'])
      await $.tool.call(inAgent({ tool: 'Bash', command: 'npm test -- x' }))
      w.bash.results['nocode'] = { isError: true, result: 'it broke', text: 'it broke' }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'nocode' }))
      await w.clock.advance(1000)
      const [a, b] = subFeed(w)
      expect(a).toMatchObject({ done: true, failed: true, exitCode: 1, output: 'FAIL src/a.test.ts' })
      expect(b).toMatchObject({ done: true, failed: true, output: 'it broke' })
      expect(b!.exitCode).toBeUndefined()
    })

    test('a denied call is done and failed with the reason as its output (#431)', ON, async ($, on) => {
      const w = await started($, on, ['a-sub'], ['a-sub'])
      w.bash.results['nope'] = { deny: 'Permission denied by a rule' }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'nope' }))
      await w.clock.advance(1000)
      expect(subFeed(w)[0]).toMatchObject({ done: true, failed: true, output: 'Permission denied by a rule' })
    })

    test('a call that printed nothing is done with an empty output', ON, async ($, on) => {
      const w = await started($, on, ['a-sub'], ['a-sub'])
      w.bash.results['quiet'] = { result: { stdout: '', stderr: '', interrupted: false } }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'quiet' }))
      await w.clock.advance(1000)
      expect(subFeed(w)[0]).toMatchObject({ done: true, output: '' })
    })

    test('a result with nothing to read gets no output and is done', ON, async ($, on) => {
      const w = await started($, on, ['a-sub'], ['a-sub'])
      w.bash.results['odd'] = { result: { ok: true } }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'odd' }))
      await w.clock.advance(1000)
      expect(subFeed(w)[0]!.output).toBeUndefined()
      expect(subFeed(w)[0]!.done).toBe(true)
    })

    test('the option off: the command goes with done and how it ended, but no output, even in watchOutput (#598)', { options: { activityFeed: true } }, async ($, on) => {
      const w = await started($, on, ['a-sub'], ['a-sub'])
      w.bash.results['secretsout'] = { isError: true, result: `Exit code 2\nprivate stuff ${SECRET}`, text: `Exit code 2\nprivate stuff ${SECRET}` }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'secretsout' }))
      await w.clock.advance(1000)
      expect(subFeed(w)[0]).toMatchObject({ command: 'secretsout', done: true, failed: true, exitCode: 2 })
      expect(subFeed(w)[0]!.output).toBeUndefined()
      expect(sent(w)).not.toContain('private stuff')
      expect(sent(w)).not.toContain(SECRET)
      expect(last(w).session.activityOutput).toBe(false)
    })

    test('the loop not in watchOutput: done and no output (#598)', ON, async ($, on) => {
      const w = await started($, on, ['a-sub'], [])
      w.bash.results['secretsout'] = { result: { stdout: 'private stuff', stderr: '', interrupted: false } }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'secretsout' }))
      await w.clock.advance(1000)
      expect(subFeed(w)[0]!.command).toBe('secretsout')
      expect(subFeed(w)[0]!.done).toBe(true)
      expect(subFeed(w)[0]!.failed).toBeUndefined()
      expect(sent(w)).not.toContain('private stuff')
    })

    test('a reply with no watchOutput (an older server): done and no output (#598)', ON, async ($, on) => {
      const w = await started($, on, ['a-sub'], null)
      w.bash.results['secretsout'] = { result: { stdout: 'private stuff', stderr: '', interrupted: false } }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'secretsout' }))
      await w.clock.advance(1000)
      expect(subFeed(w)[0]!.done).toBe(true)
      expect(sent(w)).not.toContain('private stuff')
      expect(last(w).session.activityOutput).toBe(true)
    })

    test('a denied call without output is done and failed, with no reason sent (#598)', { options: { activityFeed: true } }, async ($, on) => {
      const w = await started($, on, ['a-sub'], null)
      w.bash.results['nope'] = { deny: 'Permission denied by a rule' }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'nope' }))
      await w.clock.advance(1000)
      expect(subFeed(w)[0]).toMatchObject({ done: true, failed: true })
      expect(sent(w)).not.toContain('Permission denied by a rule')
    })

    test('a call that throws is not marked done: its status is unknown (#598)', { options: { activityFeed: true } }, async ($, on) => {
      const w = await started($, on, ['a-sub'], null)
      w.bash.results['explode'] = { throws: true }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'explode' })).catch(() => undefined)
      await w.clock.advance(1000)
      expect(subFeed(w)[0]).toMatchObject({ command: 'explode' })
      expect(subFeed(w)[0]!.done).toBeUndefined()
    })

    test('an unwatched loop and a non-Bash call get no status (#598)', { options: { activityFeed: true } }, async ($, on) => {
      const w = await started($, on, ['a-sub'], null)
      await $.tool.call(inAgent({ tool: 'Read', file_path: '/x' }))
      await $.tool.call({ tool: 'Bash', command: 'ls main' })
      await w.clock.advance(1000)
      expect(subFeed(w)).toEqual([{ at: expect.any(Number), kind: 'tool', text: 'Read /x' }])
      expect('activity' in last(w).session).toBe(false)
    })

    test('a loop in watchOutput that is not in watch gets no output', ON, async ($, on) => {
      const w = await started($, on, [], ['a-sub'])
      w.bash.results['secretsout'] = { result: { stdout: 'private stuff', stderr: '', interrupted: false } }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'secretsout' }))
      await w.clock.advance(1000)
      expect(sent(w)).not.toContain('private stuff')
    })

    test('a loop that leaves watchOutput forgets the output it held but keeps the command', ON, async ($, on) => {
      const w = await started($, on, ['a-sub'], ['a-sub'])
      w.bash.results['secretsout'] = { result: { stdout: 'private stuff', stderr: '', interrupted: false } }
      await $.tool.call(inAgent({ tool: 'Bash', command: 'secretsout' }))
      await w.clock.advance(1000)
      expect(subFeed(w)[0]!.output).toBe('private stuff')
      w.watchOutput.value = []
      await w.clock.advance(5000) // the heartbeat's reply takes it off the list
      await w.clock.advance(5000)
      expect(subFeed(w)[0]!.command).toBe('secretsout')
      expect(subFeed(w)[0]!.output).toBeUndefined()
      expect(subFeed(w)[0]!.done).toBe(true)
    })

    test('older entries are unchanged: a text entry and a non-Bash call keep their shape with the option on', ON, async ($, on) => {
      const w = await started($, on, ['a-sub'], ['a-sub'])
      await $.tool.call(inAgent({ tool: 'Read', file_path: '/x' }))
      await w.clock.advance(1000)
      expect(subFeed(w)).toEqual([{ at: expect.any(Number), kind: 'tool', text: 'Read /x' }])
    })
  })

  describe('activity feed (#118)', () => {
    /** Starts a session with one subagent (a-sub) and posts once, so the reply's watch list reaches the mod. */
    async function started($: Engine, on: On, watch: string[]) {
      const w = world(on)
      w.watch.value = watch
      await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
      await $.agent.spawn(spawnInput({ tool_use_id: 'f1' }))
      await w.clock.advance(1000)
      return w
    }
    /** A tool call made inside an agent's loop: the engine sets agentId, which the typed input does not list. */
    const inAgent = <const T extends object>(input: T, agentId = 'a-sub'): T => ({ ...input, agentId })
    const SECRET = 'sk-ant-api03-abcdefghijklmnop'
    const text = (t: string): TurnStepChunk => ({ kind: 'text', index: 0, text: t })
    /** Work in the subagent and in the orchestrator: a tool call each and a step that writes text. */
    async function work($: Engine, w: World) {
      await $.tool.call(inAgent({ tool: 'Bash', command: `curl -H "x-api-key: ${SECRET}" http://localhost` }))
      w.chunks.value = [text('Two failures. '), { kind: 'thinking', index: 1, text: 'private thoughts' }, text(`The key ${SECRET} works.`)]
      await stepOnce($, { turnId: 'ta', index: 0, model: 'claude-sonnet-5-5', messageCount: 2, agentId: 'a-sub' })
      w.chunks.value = []
      await $.tool.call({ tool: 'Read', file_path: 'docs/spec/README.md' })
      await w.clock.advance(1000)
    }
    const sent = (w: World) => JSON.stringify(w.posts)

    test('off (default): nothing is captured or sent, even for a loop the server says is watched', async ($, on) => {
      const w = await started($, on, ['a-sub', MAIN_LOOP])
      await work($, w)
      await w.clock.advance(5000)
      expect(w.posts.every((p) => p.session.activityFeed === false)).toBe(true)
      expect(w.posts.some((p) => 'activity' in p.session || p.agents.some((a) => 'activity' in a))).toBe(false)
      expect(sent(w)).not.toContain('Two failures')
    })

    test('on but nobody watching: nothing is sent', { options: { activityFeed: true } }, async ($, on) => {
      const w = await started($, on, [])
      await work($, w)
      expect(w.posts.at(-1)!.session.activityFeed).toBe(true)
      expect(w.posts.some((p) => 'activity' in p.session || p.agents.some((a) => 'activity' in a))).toBe(false)
      expect(sent(w)).not.toContain('Two failures')
    })

    test('on and watched: the tool calls and text are sent, redacted, and thinking is not', { options: { activityFeed: true } }, async ($, on) => {
      const w = await started($, on, ['a-sub', MAIN_LOOP])
      await work($, w)
      const r = w.posts.at(-1)!
      const sub = r.agents.find((a) => a.id === 'a-sub')!
      expect(sub.activity!.map((e) => e.kind)).toEqual(['tool', 'text'])
      expect(sub.activity![0]!.text).toMatch(/^Bash curl -H "x-api-key: \[redacted\]/)
      expect(sub.activity![1]!.text).toBe('Two failures. The key [redacted] works.')
      expect(r.session.activity!.map((e) => e.text)).toEqual(['Read docs/spec/README.md'])
      expect(sent(w)).not.toContain(SECRET)
      expect(sent(w)).not.toContain('private thoughts')
    })

    test('only the watched loop is sent, and a loop that stops being watched is dropped', { options: { activityFeed: true } }, async ($, on) => {
      const w = await started($, on, ['a-sub'])
      await work($, w)
      expect('activity' in w.posts.at(-1)!.session).toBe(false)
      expect(w.posts.at(-1)!.agents[0]!.activity).toHaveLength(2)
      w.watch.value = []
      await w.clock.advance(5000) // the heartbeat's reply takes it off the list
      await $.tool.call(inAgent({ tool: 'Read', file_path: '/x' }))
      await w.clock.advance(1000)
      expect('activity' in w.posts.at(-1)!.agents[0]!).toBe(false)
    })

    test('a loop keeps only its last 20 entries', { options: { activityFeed: true } }, async ($, on) => {
      const w = await started($, on, ['a-sub'])
      for (let i = 0; i < 25; i++) await $.tool.call(inAgent({ tool: 'Read', file_path: `/f${i}` }))
      await w.clock.advance(1000)
      const got = w.posts.at(-1)!.agents[0]!.activity!
      expect(got).toHaveLength(20)
      expect(got[0]!.text).toBe('Read /f5')
    })

    test('a watched step passes every chunk on unchanged, in order, and its result', { options: { activityFeed: true } }, async ($, on) => {
      const w = await started($, on, ['a-sub'])
      const chunks: TurnStepChunk[] = [text('a'), { kind: 'thinking', index: 1, text: 't' }, { kind: 'tool', index: 2, id: 'tu1', name: 'Read' }, { kind: 'input', index: 2, json: '{"file_path":"/x"}' }, text('b')]
      w.chunks.value = chunks
      const seen: TurnStepChunk[] = []
      const s = $.turn.step({ turnId: 'ta', index: 0, model: 'claude-sonnet-5-5', messageCount: 2, agentId: 'a-sub' })
      let r = await s.next()
      while (!r.done) {
        seen.push(r.value)
        r = await s.next()
      }
      expect(seen).toEqual(chunks)
      expect(r.value).toMatchObject({ answer: 'ab', stopReason: 'end_turn' })
    })
  })
})

// ---- the TLS helper (#584) --------------------------------------------------------------------------

const CONFIG_PATH = '/Users/dev/.podium/reporter-config-Dana-1767225600.pem'
const configText = (user: string, expires = '2099-01-01T00:00:00.000Z') =>
  `# podium-reporter-config v1\n# user: ${user}\n# server: https://podium.lan:4318\n# issued-at: 2026-01-01T00:00:00.000Z 1767225600\n# expires: ${expires}\n# fingerprint: AA\n-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n`

/** The environment and the helper process beneath the plugin: `node` is at NODE, the helper prints what `helperSays` holds. */
function helperWorld(on: On, o: { files: Record<string, string>; node: string | null; helperSays?: string[]; env?: Record<string, string> }) {
  const spawned: { argv: readonly string[]; env?: Record<string, string> }[] = []
  on('env.get', (_$, e) => ({ value: { HOME: '/Users/dev', PODIUM_NODE: o.node ?? undefined, ...o.env }[e.name] }))
  on('fs.list', (_$, e) => {
    const names = Object.keys(o.files).filter((f) => f.startsWith(`${e.path}/`)).map((f) => ({ name: f.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
    if (!names.length) throw new Error('ENOENT')
    return { value: names }
  })
  let seen: { files: { text: Record<string, string> } } | null = null
  on('fs.exists', (_$, e) => ({ value: e.path === o.node || e.path in (seen?.files.text ?? o.files) }))
  on('process.spawn', async function* (_$, e) {
    spawned.push({ argv: e.argv, env: e.env })
    for (const text of o.helperSays ?? ['ready\n']) yield { stream: 'stdout' as const, text }
    await new Promise(() => {})
  })
  const w = world(on, {}, o.files)
  seen = w
  return { w, spawned }
}

describe('podium-reporter over the TLS helper (#584)', () => {
  test('with a config file, reports go through the helper on its socket, to the address in the file, and say so in /podium', async ($, on) => {
    const { w, spawned } = helperWorld(on, { files: { [CONFIG_PATH]: configText('Dana') }, node: '/usr/local/bin/node' })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(spawned[0]?.argv[0]).toBe('/usr/local/bin/node')
    expect(spawned[0]?.argv[2]).toBe(CONFIG_PATH)
    expect(w.fetched[0]?.url).toBe('http://podium/api/fleet/report')
    expect(w.fetched[0]?.socketPath).toBe(spawned[0]?.argv[3])
    expect(w.fetched.every((f) => f.socketPath)).toBe(true)
    const info = await $.command.run(podium(''))
    expect(info.text).toContain('Podium fleet console: https://podium.lan:4318/#/')
    expect(info.text).toContain('TLS: connected over HTTPS')
    // the session had no name of its own, so it reports as the person the file was issued to
    expect(w.posts[0]?.userName).toBe('Dana')
  })

  test('with no config file nothing is spawned and reports go out as before', async ($, on) => {
    const { w, spawned } = helperWorld(on, { files: {}, node: '/usr/local/bin/node' })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(spawned).toEqual([])
    expect(w.fetched[0]?.url).toBe('http://127.0.0.1:4317/api/fleet/report')
    expect(w.fetched[0]?.socketPath).toBeUndefined()
  })

  test('with a config file and no node, the status line and /podium say so, and nothing is sent', async ($, on) => {
    const { w, spawned } = helperWorld(on, { files: { [CONFIG_PATH]: configText('Dana') }, node: null })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(spawned).toEqual([])
    expect(w.fetched).toEqual([])
    expect(w.statuses.at(-1)).toContain('no node')
    const info = await $.command.run(podium(''))
    expect(info.text).toContain('TLS: Podium needs node')
  })

  test('a config file for another name than the session’s is refused, and the status line says so', { options: { userName: 'Ed', token: 't' } }, async ($, on) => {
    const { w, spawned } = helperWorld(on, { files: { [CONFIG_PATH]: configText('Dana') }, node: '/usr/local/bin/node' })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(spawned).toEqual([])
    expect(w.fetched).toEqual([])
    expect(w.statuses.at(-1)).toContain('wrong config for this name')
  })

  test('a name from the userName option that the file is not for is named as the cause, with what to change (#647)', { options: { userName: 'Ed', token: 't' } }, async ($, on) => {
    helperWorld(on, { files: { [CONFIG_PATH]: configText('Dana') }, node: '/usr/local/bin/node' })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const info = await $.command.run(podium(''))
    expect(info.text).toContain('"Ed" comes from the userName option')
    expect(info.text).toContain('empty')
  })

  test('a name from PODIUM_USER that the file is not for is named as the cause (#647)', async ($, on) => {
    helperWorld(on, { files: { [CONFIG_PATH]: configText('Dana') }, node: '/usr/local/bin/node', env: { PODIUM_USER: 'Ed' } })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const info = await $.command.run(podium(''))
    expect(info.text).toContain('"Ed" comes from PODIUM_USER')
  })

  test('a name the session already holds is named as the cause, and is not called something to empty (#647)', async ($, on) => {
    on('state.get', () => ({ value: { value: { userName: 'Ed', token: 't' }, version: 1 } }))
    helperWorld(on, { files: { [CONFIG_PATH]: configText('Dana') }, node: '/usr/local/bin/node' })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const info = await $.command.run(podium(''))
    expect(info.text).toContain('"Ed" comes from the identity this session already holds')
    expect(info.text).toContain('or change the name')
    expect(info.text).not.toContain('leave that empty')
  })

  test('a PODIUM_REPORTER_CONFIG naming a missing file says config unreadable and sends nothing over http (#645)', async ($, on) => {
    const { w, spawned } = helperWorld(on, { files: { [CONFIG_PATH]: configText('Dana') }, node: '/usr/local/bin/node', env: { PODIUM_REPORTER_CONFIG: '/nowhere/mine.pem' } })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(spawned).toEqual([])
    expect(w.fetched).toEqual([])
    expect(w.statuses.at(-1)).toContain('config unreadable')
    const info = await $.command.run(podium(''))
    expect(info.text).toContain('/nowhere/mine.pem')
  })

  describe('contexts (#606)', () => {
    const HOME_CFG = '/Users/dev/.podium/reporter-config-Dana-1000.pem'
    const WORK_CFG = '/Users/dev/.podium/reporter-config-Dana-2000.pem'
    const NEWEST_CFG = '/Users/dev/.podium/reporter-config-Dana-9000.pem'
    const CONTEXTS = '/Users/dev/.podium/contexts.json'
    const contexts = (current: string | null) => JSON.stringify({ current, contexts: { home: 'reporter-config-Dana-1000.pem', work: 'reporter-config-Dana-2000.pem' } })
    const files = (current: string | null) => ({ [HOME_CFG]: configText('Dana'), [WORK_CFG]: configText('Dana'), [NEWEST_CFG]: configText('Dana'), [CONTEXTS]: contexts(current) })

    test('the current context chooses the file, and the status line and /podium name it', async ($, on) => {
      const { w, spawned } = helperWorld(on, { files: files('work'), node: '/usr/local/bin/node' })
      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      await w.clock.advance(1000)
      expect(spawned[0]?.argv[2]).toBe(WORK_CFG)
      expect(w.statuses.at(-1)).toContain('[work]')
      const info = await $.command.run(podium(''))
      expect(info.text).toContain('Context: work (https://podium.lan:4318)')
    })

    test('PODIUM_REPORTER_CONTEXT picks another for this terminal', async ($, on) => {
      const { w, spawned } = helperWorld(on, { files: files('work'), node: '/usr/local/bin/node', env: { PODIUM_REPORTER_CONTEXT: 'home' } })
      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      await w.clock.advance(1000)
      expect(spawned[0]?.argv[2]).toBe(HOME_CFG)
      expect(w.statuses.at(-1)).toContain('[home]')
    })

    test('a context that cannot be used falls back to the newest file and /podium says why', async ($, on) => {
      const { w, spawned } = helperWorld(on, { files: files('work'), node: '/usr/local/bin/node', env: { PODIUM_REPORTER_CONTEXT: 'nope' } })
      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      await w.clock.advance(1000)
      expect(spawned[0]?.argv[2]).toBe(NEWEST_CFG)
      expect(w.statuses.at(-1)).toContain('[context unusable]')
      const info = await $.command.run(podium(''))
      expect(info.text).toContain('Context problem:')
      expect(info.text).toContain('"nope"')
    })

    test('with no contexts file nothing changes: the newest file, no context line', async ($, on) => {
      const { w, spawned } = helperWorld(on, { files: { [HOME_CFG]: configText('Dana'), [NEWEST_CFG]: configText('Dana') }, node: '/usr/local/bin/node' })
      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      await w.clock.advance(1000)
      expect(spawned[0]?.argv[2]).toBe(NEWEST_CFG)
      const info = await $.command.run(podium(''))
      expect(info.text).not.toContain('Context:')
    })

    test('/podium context use changes the file for the next session and leaves the running one alone', async ($, on) => {
      const { w, spawned } = helperWorld(on, { files: files('home'), node: '/usr/local/bin/node' })
      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      await w.clock.advance(1000)
      const out = await $.command.run(podium('context use work'))
      expect(out.text).toContain('next session')
      expect(JSON.parse(w.files.text[CONTEXTS] as string).current).toBe('work')
      expect(spawned).toHaveLength(1)
      expect(spawned[0]?.argv[2]).toBe(HOME_CFG)
      expect(w.statuses.at(-1)).toContain('[home]')
    })

    test('a reload keeps the file the context chose at the start, so a later use moves only the next session', async ($, on) => {
      const held: Record<string, unknown> = { 'podium-reporter.chosenConfig': { path: HOME_CFG, context: 'home' } }
      on('state.get', (_$, e) => ({ value: { value: held[`${e.plugin}.${e.key}`] ?? null, version: 1 } }))
      on('state.set', (_$, e) => {
        held[`${e.plugin}.${e.key}`] = e.value
        return { value: e.value as never }
      })
      const { w, spawned } = helperWorld(on, { files: files('work'), node: '/usr/local/bin/node' })
      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      await w.clock.advance(1000)
      expect(spawned[0]?.argv[2]).toBe(HOME_CFG)
      expect(w.statuses.at(-1)).toContain('[home]')
    })

    test('a session with nothing held takes the current context and holds it', async ($, on) => {
      const held: Record<string, unknown> = {}
      on('state.get', (_$, e) => ({ value: { value: held[`${e.plugin}.${e.key}`] ?? null, version: 1 } }))
      on('state.set', (_$, e) => {
        held[`${e.plugin}.${e.key}`] = e.value
        return { value: e.value as never }
      })
      const { w, spawned } = helperWorld(on, { files: files('work'), node: '/usr/local/bin/node' })
      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      await w.clock.advance(1000)
      expect(spawned[0]?.argv[2]).toBe(WORK_CFG)
      expect(held['podium-reporter.chosenConfig']).toEqual({ path: WORK_CFG, context: 'work' })
    })

    test('a context that cannot be used shows in the status line, not only in /podium', async ($, on) => {
      const { w } = helperWorld(on, { files: files('work'), node: '/usr/local/bin/node', env: { PODIUM_REPORTER_CONTEXT: 'wrok' } })
      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      await w.clock.advance(1000)
      expect(w.statuses.at(-1)).toContain('[context unusable]')
    })

    test('/podium context lists the contexts', async ($, on) => {
      helperWorld(on, { files: files('home'), node: '/usr/local/bin/node' })
      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      const out = await $.command.run(podium('context'))
      expect(out.text).toContain('* home')
      expect(out.text).toContain('work')
    })
  })

  test('a 401 over the helper says certificate refused in the status line, /podium and the toast, never the token (#646)', async ($, on) => {
    const { w } = helperWorld(on, { files: { [CONFIG_PATH]: configText('Dana') }, node: '/usr/local/bin/node' })
    w.fetchMode.mode = 'denied'
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(w.statuses.at(-1)).toContain('certificate refused')
    const info = await $.command.run(podium(''))
    expect(info.text).toContain('TLS: The server did not accept your certificate')
    expect(w.toasts.some((t) => t.includes('did not accept your certificate'))).toBe(true)
    expect(w.toasts.some((t) => t.includes('token'))).toBe(false)
  })

  test('a /clear (session.end with reason clear, then session.start) keeps the helper that is running', async ($, on) => {
    const { w, spawned } = helperWorld(on, { files: { [CONFIG_PATH]: configText('Dana') }, node: '/usr/local/bin/node' })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: 'sess-after-clear' } })
    w.sessionId.value = 'sess-after-clear'
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.advance(1000)
    expect(spawned.length).toBe(1)
    expect(w.fetched.at(-1)?.socketPath).toBe(spawned[0]?.argv[3])
  })
})
