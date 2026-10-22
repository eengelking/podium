import { describe, test, expect, mock, type Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On, TurnStepChunk } from 'claude-code'
import { MAIN_LOOP, type RecordingBatch, type RecordingEntry, type RecordingGrant, type Report } from './protocol.ts'

// Session recording in the reporter (#353, SPEC 5.3 "Session recording from the reporter"). The world beneath the plugin is a fake
// Podium server whose report replies and recording replies carry the grant a test sets.

const SID = 'sess-rec-1'
const NEW_SID = 'sess-rec-2'
const CWD = '/Users/dev/app'
const NOW = 1_800_000_000_000
const ON = { sessionRecording: true, userName: 'Ed', token: 'tok-ed' }
const SECRET = 'sk-ant-api03-abcdefghijklmnop'

const GRANT: RecordingGrant = {
  state: 'recording',
  consent: { admin: true, chosen: true, owner: true },
  loops: [MAIN_LOOP, 'a-sub'],
  limit: null,
  startedBy: 'Maya Okafor',
  startedAt: NOW,
  stoppedBy: null,
  stoppedAt: null,
  keptUntil: NOW + 6 * 3_600_000,
  bytes: 0,
}

interface Call {
  method: string
  path: string
  body: unknown
  headers: Record<string, string>
}

function world(on: On) {
  const calls: Call[] = []
  const posts: Report[] = []
  const logs: string[] = []
  const sessionId = { value: SID }
  const server = {
    grant: null as RecordingGrant | null,
    /** What a recording request is answered with; 200 carries `recording` as the grant below. */
    recStatus: 200,
    /** The grant the recording route answers with; the report's own when null. */
    recGrant: undefined as RecordingGrant | null | undefined,
    down: false,
    /** A raw answer to a recording request, instead of JSON. */
    recRaw: null as string | null,
    /** Tool results by tool name. */
    results: {} as Record<string, { text?: string; isError?: true; deny?: string }>,
  }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {})
  const ok = (body: unknown, status = 200) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
  const stub = on as unknown as (event: string, handler: () => unknown) => void
  const values: Record<string, unknown> = {
    'session.model': 'claude-opus-5-5',
    'session.root': CWD,
    'session.repo': null,
    'session.version': { version: '2.1.304' },
    'session.usage': { startedAt: NOW, context: { tokens: 1000, window: 1_000_000, percent: 0.1 }, rateLimits: [], cost: { usd: 0.1 } },
    'session.surfaces': ['terminal'],
    'agent.list': [],
    'command.register': { command: 'podium' },
    'tool.register': { tool: 'mcp__podium-reporter__plan' },
    'ui.status': undefined,
    'ui.toast': undefined,
    'fs.write': undefined,
  }
  for (const [event, value] of Object.entries(values)) stub(event, () => ({ value }))
  on('session.id', () => ({ value: sessionId.value }))
  on('ui.log', (_$, e) => {
    if (e.to !== 'debug') logs.push(e.text)
    return { value: undefined }
  })
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    calls.push({ method, path: url.pathname, body, headers: e.init?.headers ?? {} })
    if (server.down) throw new Error('ECONNREFUSED')
    if (url.pathname === '/api/fleet/report') {
      posts.push(body as Report)
      return ok({ ok: true, ackedEvents: (body as Report).events.length, liveSessions: 1, watch: [], respond: false, deliveries: [], ...(server.grant ? { recording: server.grant } : {}) })
    }
    if (url.pathname.endsWith('/recording')) {
      if (server.recStatus !== 200) return ok({ ok: false }, server.recStatus)
      if (server.recRaw !== null) return { value: { status: 200, ok: true, headers: {}, text: server.recRaw } }
      const entries = (body as RecordingBatch).entries
      return ok({ ok: true, stored: entries.length, recording: server.recGrant === undefined ? server.grant : server.recGrant })
    }
    return ok({ ok: true })
  })
  on('session.start', () => ({ cwd: CWD }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'Summary.', toolUses: [] }], tokensBefore: 1000, tokensAfter: 100 }))
  on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: e.description === 'other' ? 'a-other' : 'a-sub' }))
  on('tool.call', (_$, e) => {
    const r = server.results[String(e.tool)]
    if (r?.deny) return { deny: r.deny }
    if (r?.isError) return { isError: true, result: r.text ?? '', text: r.text ?? '' }
    return { result: { ok: true }, text: r?.text ?? 'ok' }
  })
  const chunks = { value: [] as TurnStepChunk[] }
  on('turn.step', async function* (_$, e) {
    for (const c of chunks.value) yield c
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model },
    }
  })
  return { calls, posts, logs, server, clock, sessionId, chunks }
}

type World = ReturnType<typeof world>

async function started($: Engine, w: World) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await w.clock.advance(1000)
}

async function settle(w: World, rounds = 30) {
  for (let i = 0; i < rounds; i++) await w.clock.advance(0)
}

/** Lets the flush timer take the reply, then send what was recorded. */
async function tick(w: World, times = 2) {
  for (let i = 0; i < times; i++) {
    await w.clock.advance(1000)
    await settle(w, 10)
  }
}

type StepArgs = Parameters<Engine['turn']['step']>[0]
async function stepOnce($: Engine, input: StepArgs) {
  const s = $.turn.step(input)
  let r = await s.next()
  while (!r.done) r = await s.next()
  return r.value
}
const step = (agentId?: string): StepArgs => ({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 2, ...(agentId ? { agentId } : {}) })
const text = (t: string, index = 0): TurnStepChunk => ({ kind: 'text', index, text: t })
const inAgent = <const T extends object>(input: T, agentId = 'a-sub'): T => ({ ...input, agentId })
const spawn = (over: Partial<AgentSpawnInput> = {}): AgentSpawnInput => ({
  prompt: 'Map the call sites.',
  description: 'Map',
  subagentType: 'Explore',
  tool_use_id: 'tu-spawn',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
  ...over,
})

const recPosts = (w: World) => w.calls.filter((c) => c.path.endsWith('/recording'))
const recEntries = (w: World): RecordingEntry[] => recPosts(w).flatMap((c) => (c.body as RecordingBatch).entries)
const kinds = (w: World) => recEntries(w).map((e) => `${e.loop === MAIN_LOOP ? 'main' : e.loop}:${e.seq}:${e.kind}`)

describe('session recording', () => {
  test('captures every loop, in order, once the reply says the session is chosen and consented', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    expect(w.posts.at(-1)!.session.sessionRecording).toBe(true)
    expect(w.logs.some((l) => l.startsWith('This session is being recorded by Maya Okafor, from '))).toBe(true)
    w.server.results.Bash = { text: `out\nline2 ${SECRET}` }
    await $.turn.start({ text: 'Run the tests', turnId: 't1' })
    w.chunks.value = [text('Let me '), { kind: 'thinking', index: 1, text: '' }, text('run it.', 2)]
    await stepOnce($, step())
    await $.tool.call({ tool: 'Bash', command: `curl -H "x-api-key: ${SECRET}" localhost` })
    await $.agent.spawn(spawn())
    await $.turn.start(inAgent({ text: 'Map the call sites.', turnId: 't2' }))
    w.chunks.value = [text('Found 3.')]
    await stepOnce($, step('a-sub'))
    await $.tool.call(inAgent({ tool: 'Read', file_path: '/x/a.ts' }))
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'x', toolUses: [] }] })
    await tick(w)
    const e = recEntries(w)
    expect(kinds(w)).toEqual([
      'main:1:prompt',
      'main:2:text',
      'main:3:thinking',
      'main:4:text',
      'main:5:tool',
      'main:6:result',
      'a-sub:1:prompt',
      'a-sub:2:text',
      'a-sub:3:tool',
      'a-sub:4:result',
      'main:7:compact',
    ])
    expect(e[0]!.text).toBe('Run the tests')
    expect(e[1]!.text).toBe('Let me ')
    expect(e[3]!.text).toBe('run it.')
    expect(e[2]!.text).toBe('')
    expect(e[5]).toMatchObject({ name: 'Bash', callSeq: 5 })
    expect(JSON.stringify(e)).not.toContain(SECRET)
    expect(e[5]!.text).toContain('line2 [redacted]')
    expect(e[6]!.text).toBe('Map the call sites.')
    expect(e[9]).toMatchObject({ callSeq: 3, text: 'ok' })
    // posted to the session's route with the token, a second at the soonest
    const posts = recPosts(w)
    expect(posts[0]!.path).toBe(`/api/fleet/sessions/${SID}/recording`)
    expect(posts[0]!.method).toBe('POST')
    expect(posts[0]!.headers['X-Podium-Token']).toBe('tok-ed')
    expect((posts[0]!.body as RecordingBatch).v).toBe(1)
    // the transcript told the owner again after the compaction
    expect(w.logs.filter((l) => l.startsWith('This session is being recorded')).length).toBe(2)
  })

  test('the option off: nothing is captured, queued or sent, and the owner is told once that a chosen session is not recorded', async ($, on) => {
    const w = world(on)
    w.server.grant = { ...GRANT, consent: { admin: true, chosen: true, owner: false } }
    await started($, w)
    expect(w.posts.at(-1)!.session.sessionRecording).toBe(false)
    await $.turn.start({ text: 'secret plans', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await tick(w, 4)
    expect(recPosts(w)).toEqual([])
    expect(w.logs.filter((l) => l === 'Maya Okafor chose to record this session, but sessionRecording is off here, so nothing is recorded.').length).toBe(1)
    expect(JSON.stringify(w.calls)).not.toContain('secret plans')
  })

  test('the option on but the server sends no grant: nothing is recorded, and nothing is said', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    await $.turn.start({ text: 'hello', turnId: 't1' })
    await tick(w, 3)
    expect(recPosts(w)).toEqual([])
    expect(w.logs).toEqual([])
  })

  test('the grant must say recording and all three yes answers; the option off wins over a grant that says yes', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = { ...GRANT, state: 'off', consent: { admin: true, chosen: false, owner: true } }
    await started($, w)
    await $.turn.start({ text: 'hello', turnId: 't1' })
    await tick(w, 3)
    expect(recPosts(w)).toEqual([])
  })

  test('nothing from before the first reply that allows it is kept', { options: ON }, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'before', turnId: 't0' })
    w.server.grant = GRANT
    await w.clock.advance(1000)
    await settle(w)
    await $.turn.start({ text: 'after', turnId: 't1' })
    await tick(w)
    expect(recEntries(w).map((e) => e.text)).toEqual(['after'])
  })

  test('a loop the grant does not list is not recorded', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = { ...GRANT, loops: ['a-sub'] }
    await started($, w)
    await $.turn.start({ text: 'main prompt', turnId: 't1' })
    await $.tool.call(inAgent({ tool: 'Read', file_path: '/x' }, 'a-other'))
    await $.tool.call(inAgent({ tool: 'Read', file_path: '/y' }))
    await tick(w)
    expect(recEntries(w).map((e) => e.kind + ':' + e.loop)).toEqual(['tool:a-sub', 'result:a-sub'])
  })

  test('a file on the never-send list is recorded as a call with its path and a withheld result', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    w.server.results.Read = { text: 'API_KEY=hunter2hunter2' }
    await $.tool.call({ tool: 'Read', file_path: '/app/.env' })
    await $.tool.call({ tool: 'Write', file_path: '/app/server.key', content: 'PRIVATE' })
    await tick(w)
    const e = recEntries(w)
    expect(e[0]).toMatchObject({ kind: 'tool', text: '{"file_path":"/app/.env"}' })
    expect(e[1]).toMatchObject({ kind: 'result', text: '[withheld: this file is on the never-send list]' })
    expect(e[2]!.text).toBe('{"file_path":"/app/server.key"}')
    expect(JSON.stringify(e)).not.toContain('PRIVATE')
    expect(JSON.stringify(e)).not.toContain('hunter2')
  })

  test('a failed call and a refused call are failed results', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    w.server.results.Bash = { isError: true, text: 'Exit code 1' }
    w.server.results.Edit = { deny: 'blocked by policy' }
    await $.tool.call({ tool: 'Bash', command: 'false' })
    await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })
    await tick(w)
    expect(recEntries(w).filter((e) => e.kind === 'result').map((e) => [e.text, e.failed])).toEqual([
      ['Exit code 1', true],
      ['blocked by policy', true],
    ])
  })

  test('stop in a reply: the owner is told, the queue gets one last send, and capture ends', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    await $.turn.start({ text: 'one', turnId: 't1' })
    w.server.grant = { ...GRANT, state: 'stopped', stoppedBy: 'Maya Okafor', stoppedAt: NOW + 5000 }
    w.server.recGrant = undefined
    await tick(w, 3)
    expect(recEntries(w).map((e) => e.text)).toEqual(['one'])
    expect(w.logs.some((l) => l.startsWith('Recording stopped by Maya Okafor at '))).toBe(true)
    await $.turn.start({ text: 'two', turnId: 't2' })
    await tick(w, 3)
    expect(recEntries(w).map((e) => e.text)).toEqual(['one'])
  })

  test('the owner turning consent off in a reply ends capture without a word', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    const lines = w.logs.length
    w.server.grant = { ...GRANT, consent: { admin: false, chosen: true, owner: true } }
    await tick(w, 6)
    await $.turn.start({ text: 'after', turnId: 't1' })
    await tick(w, 6)
    expect(recEntries(w)).toEqual([])
    expect(w.logs.length).toBe(lines)
  })

  test('a limit in the batch reply stops capture and says so', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    await $.turn.start({ text: 'one', turnId: 't1' })
    w.server.recGrant = { ...GRANT, state: 'limit', limit: 'session', bytes: 256 * 1_048_576 }
    await tick(w, 2)
    expect(w.logs).toContain('Recording stopped: this session reached its 256 MB limit. Nothing after this point is kept.')
    const before = recPosts(w).length
    w.server.grant = GRANT
    w.server.recGrant = undefined
    await $.turn.start({ text: 'two', turnId: 't2' })
    await tick(w, 3)
    expect(recPosts(w).length).toBe(before + 0)
  })

  test('the disk budget is named as the server\'s', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    await $.turn.start({ text: 'one', turnId: 't1' })
    w.server.recGrant = { ...GRANT, state: 'limit', limit: 'budget' }
    await tick(w, 2)
    expect(w.logs).toContain("Recording stopped: this session reached the server's disk budget. Nothing after this point is kept.")
  })

  test('an answer to a batch that carries no readable grant ends capture, as a server that sends none does', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    w.server.recRaw = 'not json'
    await $.turn.start({ text: 'one', turnId: 't1' })
    await tick(w, 2)
    await $.turn.start({ text: 'two', turnId: 't2' })
    await tick(w, 6)
    expect(recEntries(w).map((e) => e.text)).toEqual(['one'])
  })

  test('403 stops capture and drops the queue', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    w.server.recStatus = 403
    await $.turn.start({ text: 'one', turnId: 't1' })
    await tick(w, 2)
    const sent = recPosts(w).length
    expect(sent).toBe(1)
    w.server.recStatus = 200
    await tick(w, 4)
    expect(recPosts(w).length).toBe(sent)
  })

  test('a batch the server will never take (400) is dropped, and the next one goes', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    w.server.recStatus = 400
    await $.turn.start({ text: 'bad', turnId: 't1' })
    await tick(w, 1)
    w.server.recStatus = 200
    await $.turn.start({ text: 'good', turnId: 't2' })
    await tick(w, 6)
    const posts = recPosts(w).map((c) => (c.body as RecordingBatch).entries.map((e) => e.text))
    expect(posts).toEqual([['bad'], ['good']])
  })

  test('while the server cannot be reached entries queue, are retried as they were, and arrive once it is back', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    w.server.recStatus = 503
    await $.turn.start({ text: 'one', turnId: 't1' })
    await tick(w, 3)
    await $.turn.start({ text: 'two', turnId: 't2' })
    await tick(w, 3)
    const failed = recPosts(w).length
    expect(failed).toBeGreaterThan(1)
    w.server.recStatus = 200
    await tick(w, 8)
    const last = (recPosts(w).at(-1)!.body as RecordingBatch).entries
    expect(last.map((e) => [e.seq, e.text])).toEqual([
      [1, 'one'],
      [2, 'two'],
    ])
  })

  test('a down server (no answer at all) backs off like a failure', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    await $.turn.start({ text: 'one', turnId: 't1' })
    w.server.down = true
    await tick(w, 3)
    w.server.down = false
    await tick(w, 12)
    expect(recEntries(w).filter((e) => e.text === 'one').length).toBeGreaterThanOrEqual(1)
  })

  test('past the queue bound the oldest entries go and one gap entry says how many', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    w.server.recStatus = 503
    const big = 'x '.repeat(45_000)
    for (let i = 0; i < 100; i++) {
      w.chunks.value = [text(`${i} ${big}`)]
      await stepOnce($, step())
    }
    await tick(w, 1)
    w.server.recStatus = 200
    await tick(w, 40)
    // a failed request is sent again as it was: the server keeps an entry once, by (loop, seq)
    const got = [...new Map(recEntries(w).map((e) => [`${e.loop}:${e.seq}`, e])).values()]
    const gaps = got.filter((e) => e.kind === 'gap')
    expect(gaps.length).toBe(1)
    expect(gaps[0]!.lost).toBeGreaterThan(0)
    expect(gaps[0]!.lost! + got.filter((e) => e.kind === 'text').length).toBe(100)
  })

  test('the session ending sends what is queued, with its clear mark, and stops', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    await $.turn.start({ text: 'last words', turnId: 't1' })
    await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } })
    await settle(w)
    expect(kinds(w)).toEqual(['main:1:prompt', 'main:2:clear'])
    expect(recPosts(w)[0]!.path).toBe(`/api/fleet/sessions/${SID}/recording`)
    // the reply that went with the final report does not start capture again
    await $.turn.start({ text: 'ignored', turnId: 't2' })
    await tick(w, 3)
    expect(recEntries(w).length).toBe(2)
  })

  test('a quit sends what is queued and stops', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    await $.turn.start({ text: 'bye', turnId: 't1' })
    await $.session.end({ reason: 'prompt_input_exit', sessionId: SID, resume: { id: SID } })
    await settle(w)
    expect(kinds(w)).toEqual(['main:1:prompt'])
  })

  test('after a /clear the new id is recorded only when its own replies say so, numbered from 1', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    await $.turn.start({ text: 'old', turnId: 't1' })
    w.sessionId.value = NEW_SID
    await tick(w, 2)
    expect(recPosts(w)[0]!.path).toBe(`/api/fleet/sessions/${SID}/recording`)
    expect(kinds(w)).toEqual(['main:1:prompt', 'main:2:clear'])
    await $.turn.start({ text: 'new', turnId: 't2' })
    await tick(w, 3)
    const last = recPosts(w).at(-1)!
    expect(last.path).toBe(`/api/fleet/sessions/${NEW_SID}/recording`)
    expect((last.body as RecordingBatch).entries.map((e) => [e.seq, e.text])).toEqual([[1, 'new']])
    expect(w.logs.filter((l) => l.startsWith('This session is being recorded')).length).toBe(2)
  })

  test('a spawn prompt and the agent\'s first turn are one entry', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    await $.turn.start(inAgent({ text: 'Map the call sites.', turnId: 't2' }))
    await $.agent.spawn(spawn())
    await $.turn.start(inAgent({ text: 'Map the call sites.', turnId: 't3' }))
    await tick(w)
    expect(recEntries(w).map((e) => e.kind)).toEqual(['prompt'])
  })

  test('hooks answer as before while recording: results pass through untouched', { options: ON }, async ($, on) => {
    const w = world(on)
    w.server.grant = GRANT
    await started($, w)
    w.server.results.Bash = { text: 'plain output' }
    expect(await $.tool.call({ tool: 'Bash', command: 'echo' })).toMatchObject({ text: 'plain output', result: { ok: true } })
    w.chunks.value = [text('hi')]
    expect(await stepOnce($, step())).toMatchObject({ stopReason: 'end_turn' })
  })
})
