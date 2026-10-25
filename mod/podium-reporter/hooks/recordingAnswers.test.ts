import { describe, test, expect, mock, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { MAIN_LOOP, type Ask, type Delivery, type RecordingBatch, type RecordingEntry, type RecordingGrant, type Report } from './protocol.ts'

// Answers and approvals sent from Podium in a recording (#353): a question's answer, a plan's approval, a tool's allow or deny, and
// /clear and /compact. The mod records each where it takes it, once, in order, with who sent it. The world beneath the plugin is a
// fake Podium server (report replies, held answer requests, recording requests) and a terminal whose dialogs the test answers by hand.

const SID = 'sess-ans-1'
const CWD = '/Users/dev/app'
const NOW = 1_800_000_000_000
const ON = { respond: 'everything', activityFeed: true, sessionRecording: true, userName: 'Ed', token: 'tok-ed' }
const SECRET = 'sk-ant-api03-abcdefghijklmnop'

const GRANT: RecordingGrant = {
  state: 'recording',
  consent: { admin: true, chosen: true, owner: true },
  loops: [MAIN_LOOP],
  limit: null,
  startedBy: 'Maya',
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
}

function world(on: On, grant: RecordingGrant | null = GRANT) {
  const calls: Call[] = []
  const server = { deliveries: [] as Delivery[] }
  const holds: ((d: Delivery | null) => void)[] = []
  let waiting: Delivery | null = null
  const dialog: { resolve: ((r: unknown) => void) | null } = { resolve: null }
  const toolRun: { resolve: ((r: unknown) => void) | null } = { resolve: null }
  /** A command held while it "runs", so the test fires the hooks the real command would (a hook cannot call them itself). */
  const commandRuns: { hold: boolean; release: (() => void) | null; fail: boolean } = { hold: false, release: null, fail: false }
  const submitted: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {})
  const ok = (body: unknown, status = 200) => ({ value: { status, ok: status < 300, headers: {}, text: body === undefined ? '' : JSON.stringify(body) } })
  const values: Record<string, unknown> = {
    'session.id': SID,
    'session.model': 'claude-opus-5-5',
    'session.root': CWD,
    'session.repo': null,
    'session.version': { version: '2.1.305' },
    'session.usage': { startedAt: NOW, context: { tokens: 1000, window: 1_000_000, percent: 0.1 }, rateLimits: [], cost: { usd: 0.1 } },
    'session.surfaces': ['terminal'],
    'agent.list': [],
    'command.register': { command: 'podium' },
    'tool.register': { tool: 'mcp__podium-reporter__plan' },
    'ui.status': undefined,
    'ui.toast': undefined,
  }
  const stub = on as unknown as (event: string, handler: () => unknown) => void
  for (const [event, value] of Object.entries(values)) stub(event, () => ({ value }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    calls.push({ method, path: url.pathname + url.search, body })
    if (url.pathname === '/api/fleet/report') {
      const deliveries = server.deliveries.splice(0)
      return ok({ ok: true, ackedEvents: (body as Report).events.length, liveSessions: 1, watch: [], respond: true, deliveries, ...(grant ? { recording: grant } : {}) })
    }
    if (url.pathname.endsWith('/recording')) return ok({ ok: true, stored: (body as RecordingBatch).entries.length, recording: grant })
    if (method === 'GET' && url.pathname.endsWith('/answer')) {
      if (waiting) {
        const d = waiting
        waiting = null
        return ok({ delivery: d })
      }
      return new Promise((resolve) => holds.push((d) => resolve(d ? ok({ delivery: d }) : ok({ ok: false, error: 'closed', outcome: 'ended' }, 410))))
    }
    return ok({ ok: true })
  })
  on('session.start', () => ({ cwd: CWD }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'Summary.', toolUses: [] }], tokensBefore: 1000, tokensAfter: 100 }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('command.run', async () => {
    if (commandRuns.fail) throw new Error('refused')
    if (commandRuns.hold) await new Promise<void>((resolve) => (commandRuns.release = resolve))
    return { text: '' }
  })
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Read') throw new Error('the tool failed to run')
    if (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode') return new Promise((resolve) => (dialog.resolve = resolve as (r: unknown) => void))
    if (e.tool === 'Bash') return new Promise((resolve) => (toolRun.resolve = resolve as (r: unknown) => void))
    return { result: { ok: true }, text: 'ok' }
  })
  on('classic.PermissionRequest', () => ({}))
  on('classic.Notification', () => ({}))
  return {
    calls,
    server,
    clock,
    dialog,
    toolRun,
    commandRuns,
    submitted,
    deliver: (d: Delivery) => {
      const all = holds.splice(0)
      if (!all.length) waiting = d
      for (const h of all) h(d)
    },
  }
}

type World = ReturnType<typeof world>

async function settle(w: World, rounds = 30) {
  for (let i = 0; i < rounds; i++) await w.clock.advance(0)
}

async function started($: Engine, w: World) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await w.clock.advance(1000)
}

/** Lets the flush timer send what was recorded, and returns every entry sent so far. */
async function sent(w: World): Promise<RecordingEntry[]> {
  for (let i = 0; i < 3; i++) {
    await w.clock.advance(1000)
    await settle(w, 10)
  }
  return w.calls.filter((c) => c.path.endsWith('/recording')).flatMap((c) => (c.body as RecordingBatch).entries)
}

const shape = (e: RecordingEntry[]) => e.map((x) => [x.seq, x.kind, x.name, x.callSeq, x.failed, x.by])

const QUESTIONS = [
  { question: 'How many rows per page?', header: 'Page size', multiSelect: false, options: [{ label: '25/50/100', description: 'Choices' }, { label: 'Fixed 50', description: 'No choice' }] },
  { question: 'What should Back restore?', header: 'Back state', multiSelect: true, options: [{ label: 'The page', description: '' }, { label: 'The rows', description: '' }] },
]
const by = (kind: Delivery['kind'], askId: string | null, over: Partial<Delivery> = {}): Delivery => ({ id: `dlv_${kind}_${askId ?? 'msg'}`, askId, by: 'Boss', at: NOW, kind, ...over })
const asksOf = (w: World) => w.calls.filter((c) => c.method === 'PUT').map((c) => c.body as Ask)

describe('a question answered from Podium', () => {
  test('is recorded once, right after the question, with who answered and what', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    const call = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS } as never)
    await settle(w)
    w.deliver(by('question', asksOf(w)[0]!.id, { answers: [{ options: [1] }, { options: [0, 1] }] }))
    await call
    const e = await sent(w)
    expect(shape(e)).toEqual([
      [1, 'tool', 'AskUserQuestion', undefined, undefined, undefined],
      [2, 'decision', 'question', 1, undefined, 'Boss'],
    ])
    expect(e[1]!.text).toBe('How many rows per page?: Fixed 50\nWhat should Back restore?: The page, The rows')
    expect(e[0]!.text).toContain('How many rows per page?')
  })

  test('a message sent in place of an answer is recorded as that, redacted', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    const call = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS } as never)
    await settle(w)
    w.deliver(by('reply', asksOf(w)[0]!.id, { text: `use ${SECRET} for it` }))
    await call
    const e = await sent(w)
    expect(shape(e).at(-1)).toEqual([2, 'decision', 'question', 1, undefined, 'Boss'])
    expect(e[1]!.text).toBe('Replied in place of an answer: use [redacted] for it')
    expect(JSON.stringify(e)).not.toContain(SECRET)
  })

  test('answered in the terminal first: no decision from Podium is recorded, even if one arrives later', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    const call = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS } as never)
    await settle(w)
    const id = asksOf(w)[0]!.id
    w.dialog.resolve!({ result: { questions: QUESTIONS, answers: { 'How many rows per page?': 'Fixed 50' } }, text: 'answered' })
    await call
    w.deliver(by('question', id, { answers: [{ options: [0] }, null] }))
    await settle(w)
    expect((await sent(w)).map((x) => x.kind)).toEqual(['tool', 'result'])
  })
})

describe('a plan decided from Podium', () => {
  const PLAN = { plan: '# Plan\n\n1. Page it', planFilePath: '/Users/dev/.claude/plans/wise.md' }

  test('an approval is recorded once Claude Code took it, with the mode, before the call ends', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    const call = $.tool.call({ tool: 'ExitPlanMode', ...PLAN } as never)
    await settle(w)
    const pr = $.classic.PermissionRequest({ tool_name: 'ExitPlanMode', tool_input: PLAN } as never)
    await settle(w)
    w.deliver(by('plan-approve', asksOf(w)[0]!.id, { mode: 'acceptEdits' }))
    await pr
    // Not yet: the call has not resolved as approved.
    expect((await sent(w)).map((x) => x.kind)).toEqual(['tool'])
    w.dialog.resolve!({ result: { plan: PLAN.plan, isAgent: false } })
    await call
    const e = await sent(w)
    expect(shape(e)).toEqual([
      [1, 'tool', 'ExitPlanMode', undefined, undefined, undefined],
      [2, 'decision', 'plan', 1, undefined, 'Boss'],
    ])
    expect(e[1]!.text).toBe('Approved the plan (auto-accept edits)')
  })

  test('an approval Claude Code did not take is not recorded', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    const call = $.tool.call({ tool: 'ExitPlanMode', ...PLAN } as never)
    await settle(w)
    const pr = $.classic.PermissionRequest({ tool_name: 'ExitPlanMode', tool_input: PLAN } as never)
    await settle(w)
    w.deliver(by('plan-approve', asksOf(w)[0]!.id, { mode: 'auto' }))
    await pr
    w.dialog.resolve!({ isError: true, text: "The user doesn't want to proceed with this tool use.", result: "The user doesn't want to proceed with this tool use." })
    await call
    expect((await sent(w)).map((x) => x.kind)).toEqual(['tool', 'result'])
  })

  test('"No, keep planning" with feedback is recorded as sending the plan back', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    const call = $.tool.call({ tool: 'ExitPlanMode', ...PLAN } as never)
    await settle(w)
    w.deliver(by('plan-feedback', asksOf(w)[0]!.id, { text: 'Make it one step.' }))
    await call
    const e = await sent(w)
    expect(shape(e)[1]).toEqual([2, 'decision', 'plan', 1, true, 'Boss'])
    expect(e[1]!.text).toBe('Sent the plan back: Make it one step.')
  })
})

describe('a tool permission decided from Podium', () => {
  const CMD = { command: 'git push -u origin main', description: 'Push the branch' }

  async function prompt($: Engine, w: World) {
    const call = $.tool.call({ tool: 'Bash', ...CMD } as never)
    await settle(w)
    const pr = $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: CMD } as never)
    await settle(w)
    return { call, pr, id: asksOf(w)[0]!.id }
  }

  test('an allow is recorded between the call and its result, with who allowed it', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    const { call, pr, id } = await prompt($, w)
    w.deliver(by('allow-once', id))
    await pr
    w.toolRun.resolve!({ result: { stdout: 'pushed' }, text: 'pushed' })
    await call
    const e = await sent(w)
    expect(shape(e)).toEqual([
      [1, 'tool', 'Bash', undefined, undefined, undefined],
      [2, 'decision', 'permission', 1, undefined, 'Boss'],
      [3, 'result', 'Bash', 1, undefined, undefined],
    ])
    expect(e[1]!.text).toBe('Allowed once')
  })

  test('a deny is recorded with its reason, marked failed', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    const { call, pr, id } = await prompt($, w)
    w.deliver(by('deny', id, { text: 'Run the build first.' }))
    await pr
    w.toolRun.resolve!({ isError: true, text: 'Run the build first.', result: 'Run the build first.' })
    await call
    const e = await sent(w)
    expect(shape(e)[1]).toEqual([2, 'decision', 'permission', 1, true, 'Boss'])
    expect(e[1]!.text).toBe('Denied: Run the build first.')
    expect(shape(e)[2]).toEqual([3, 'result', 'Bash', 1, true, undefined])
  })

  test('a Podium Deny that the terminal beat is not recorded', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    const { call, pr, id } = await prompt($, w)
    w.deliver(by('deny', id))
    await pr
    w.toolRun.resolve!({ result: { stdout: 'pushed' }, text: 'pushed' })
    await call
    expect((await sent(w)).map((x) => x.kind)).toEqual(['tool', 'result'])
  })

  test('answered in the terminal: no decision from Podium', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    const { call } = await prompt($, w)
    w.toolRun.resolve!({ result: { stdout: 'pushed' }, text: 'pushed' })
    await call
    expect((await sent(w)).map((x) => x.kind)).toEqual(['tool', 'result'])
  })
})

describe('a message sent from Podium', () => {
  // Claude Code starts the turn for a prompt a plugin submits between turns with the text inside its own frame (seen live on 2.1.305),
  // and the server marks the entry as "from Podium" only when it holds exactly the text it delivered, so the frame must not be recorded.
  const FRAMED = (t: string) =>
    `The podium-reporter plugin sent a message:\n${t}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`

  test('is recorded as the text Podium sent, not as the frame the engine put round it', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    w.server.deliveries.push(by('message', null, { text: 'Reply with only the word pong.' }))
    await w.clock.advance(5000)
    await settle(w)
    expect(w.submitted).toEqual(['Reply with only the word pong.'])
    await $.turn.start({ text: FRAMED('Reply with only the word pong.'), turnId: 't1' })
    const e = await sent(w)
    expect(shape(e)).toEqual([[1, 'prompt', undefined, undefined, undefined, undefined]])
    expect(e[0]!.text).toBe('Reply with only the word pong.')
  })

  test('a prompt the person types that merely contains a sent text is left as typed', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    w.server.deliveries.push(by('message', null, { text: 'pong' }))
    await w.clock.advance(5000)
    await settle(w)
    await $.turn.start({ text: 'Please say pong twice', turnId: 't1' })
    expect((await sent(w))[0]!.text).toBe('Please say pong twice')
  })
})

describe('/clear and /compact sent from Podium', () => {
  const command = (command: 'clear' | 'compact') => by('command', null, { id: `dlv_${command}`, command })

  test('a /compact is marked with who sent it', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    w.commandRuns.hold = true
    w.server.deliveries.push(command('compact'))
    await w.clock.advance(5000)
    await settle(w)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] })
    w.commandRuns.release!()
    await settle(w)
    expect(shape(await sent(w))).toEqual([[1, 'compact', undefined, undefined, undefined, 'Boss']])
  })

  test('a /clear is marked with who sent it', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    w.commandRuns.hold = true
    w.server.deliveries.push(command('clear'))
    await w.clock.advance(5000)
    await settle(w)
    await $.session.end({ reason: 'clear', sessionId: SID } as never)
    w.commandRuns.release!()
    await settle(w)
    expect(shape(await sent(w))).toEqual([[1, 'clear', undefined, undefined, undefined, 'Boss']])
  })

  test('a compaction the person ran, after a command that fired nothing, is not marked', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    w.server.deliveries.push(command('compact'))
    await w.clock.advance(5000)
    await settle(w)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] })
    expect(shape(await sent(w))).toEqual([[1, 'compact', undefined, undefined, undefined, undefined]])
  })

  test('a command that was refused marks nothing, and neither does the next compaction', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    w.commandRuns.fail = true
    w.server.deliveries.push(command('compact'))
    await w.clock.advance(5000)
    await settle(w)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] })
    expect(shape(await sent(w))).toEqual([[1, 'compact', undefined, undefined, undefined, undefined]])
  })

  test('a clear that is not the command sent is not marked', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    w.commandRuns.hold = true
    w.server.deliveries.push(command('compact'))
    await w.clock.advance(5000)
    await settle(w)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] })
    w.commandRuns.release!()
    await settle(w)
    await $.session.end({ reason: 'clear', sessionId: SID } as never)
    expect(shape(await sent(w))).toEqual([
      [1, 'compact', undefined, undefined, undefined, 'Boss'],
      [2, 'clear', undefined, undefined, undefined, undefined],
    ])
  })
})

describe('a call that ends in an error', () => {
  test('is recorded as a call, and leaves nothing behind for the next call that shares nothing with it', { options: ON }, async ($, on) => {
    const w = world(on)
    await started($, w)
    await $.tool.call({ tool: 'Read', tool_use_id: 'tu-boom' } as never).catch(() => undefined)
    const call = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS } as never)
    await settle(w)
    w.deliver(by('question', asksOf(w)[0]!.id, { answers: [{ options: [0] }, null] }))
    await call
    expect(shape(await sent(w)).map((r) => [r[1], r[3]])).toEqual([
      ['tool', undefined],
      ['tool', undefined],
      ['decision', 2],
    ])
  })
})

describe('with recording off', () => {
  test('nothing of an answer is captured or sent', { options: ON }, async ($, on) => {
    const w = world(on, null)
    await started($, w)
    const call = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS } as never)
    await settle(w)
    w.deliver(by('question', asksOf(w)[0]!.id, { answers: [{ options: [1] }, null] }))
    await call
    expect(await sent(w)).toEqual([])
    expect(w.calls.some((c) => c.path.endsWith('/recording'))).toBe(false)
  })
})
