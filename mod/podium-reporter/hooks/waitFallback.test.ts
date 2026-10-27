import { describe, test, expect, mock, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Report } from './protocol.ts'

// #741: on a Team or Enterprise login Claude Code skips classic.Notification and classic.PermissionRequest, so a
// session waiting on a permission prompt is read from tool.check's `ask` instead.

const SID = 'sess-wait-0001'
const CWD = '/Users/dev/app'

function world(on: On) {
  const posts: Report[] = []
  const check = { decision: 'ask' as 'ask' | 'allow' }
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on, {})
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: SID }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.root', () => ({ value: CWD }))
  on('session.repo', () => ({ value: null }))
  on('session.version', () => ({ value: { version: '2.1.296' } }))
  on('session.usage', () => ({ value: { startedAt: 1_800_000_000_000, context: { tokens: 1, window: 1_000_000, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.detach', (_$, e) => ({ clientId: e.clientId }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'podium' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__podium-reporter__plan' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', (_$, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as Report
    posts.push(body)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, ackedEvents: body.events.length, liveSessions: 1, watch: [], serverVersion: '1.1.0', serverBuild: null }) } }
  })
  on('session.start', () => ({ cwd: CWD }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.check', () => ({ decision: check.decision }))
  // The engine gives each call its id; a test that needs the call to stay open holds it and reads the id.
  const call: { id: string; hold: boolean; release: (() => void) | null } = { id: '', hold: false, release: null }
  on('tool.call', (_$, e) => {
    call.id = e.tool_use_id
    if (call.hold) return new Promise((resolve) => (call.release = () => resolve({ result: { ok: true }, text: 'ok' })))
    return { result: { ok: true }, text: 'ok' }
  })
  // Claude Code skips these two on such a login: the mod's handlers are never reached, so the world answers them itself.
  on('classic.PermissionRequest', () => ({}))
  on('classic.Notification', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  return { posts, check, clock, call }
}

type W = ReturnType<typeof world>

async function started($: Engine, w: W) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await w.clock.advance(1000)
}

const waits = (w: W) => w.posts.flatMap((p) => p.events).filter((e) => e.kind === 'wait' && e.text.startsWith('waiting on you'))
const BASH = { tool: 'Bash', input: { command: 'rm -rf dist' } }

describe('waiting on a permission prompt without classic hooks (#741)', () => {
  test('an ask with no PermissionRequest after it marks the session waiting, with responding off (the default)', async ($, on) => {
    const w = world(on)
    await started($, w)
    await $.tool.check({ ...BASH, tool_use_id: 'toolu_w1' } as never)
    await w.clock.advance(2500)
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session).toMatchObject({ status: 'waiting', waitReason: 'permission', waitNote: 'Bash(rm -rf dist)' })
    expect(waits(w)).toHaveLength(1)
    // the call running ends the wait
    await $.tool.call({ tool: 'Bash', command: 'rm -rf dist' } as never)
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session.waitReason).not.toBe('permission')
  })

  test('a PermissionRequest that follows the ask is the only source: one event, not two', async ($, on) => {
    const w = world(on)
    await started($, w)
    await $.tool.check({ ...BASH, tool_use_id: 'toolu_w2' } as never)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } } as never)
    await w.clock.advance(2500)
    await w.clock.advance(1000)
    expect(w.posts.at(-1)!.session).toMatchObject({ status: 'waiting', waitReason: 'permission' })
    expect(waits(w)).toHaveLength(1)
  })

  test('an ask answered before the wait is read leaves the session running', async ($, on) => {
    const w = world(on)
    await started($, w)
    w.call.hold = true
    w.check.decision = 'allow' // the engine's own check before the call
    const running = $.tool.call({ tool: 'Bash', command: 'rm -rf dist' } as never)
    for (let i = 0; i < 200 && !w.call.release; i++) await w.clock.advance(10)
    w.check.decision = 'ask'
    await $.tool.check({ ...BASH, tool_use_id: w.call.id } as never)
    w.call.release!()
    await running
    await w.clock.advance(2500)
    await w.clock.advance(1000)
    expect(waits(w)).toHaveLength(0)
    expect(w.posts.at(-1)!.session.waitReason).not.toBe('permission')
  })

  test('a tool.check that allows is not a wait', async ($, on) => {
    const w = world(on)
    await started($, w)
    w.check.decision = 'allow'
    await $.tool.check({ ...BASH, tool_use_id: 'toolu_w4' } as never)
    await w.clock.advance(2500)
    expect(waits(w)).toHaveLength(0)
  })
})
