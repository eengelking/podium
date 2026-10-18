import { describe, test, expect, mock, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { DiffRequest, FileDiffReply, Report } from './protocol.ts'

// A file's diff on request (#319, SPEC 6.4). The world beneath the plugin is a fake Podium server that lists requests in
// its report replies, and a fake git whose answers the test sets.

const SID = 'sess-diff-1'
const CWD = '/repo'
const NOW = 1_800_000_000_000
const BODY = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const x = 1\n-const apiKey = "abcd1234efgh5678"\n+const apiKey = process.env.KEY\n+const other = 2\n'

interface Call {
  method: string
  path: string
  body: unknown
}

function world(on: On) {
  const calls: Call[] = []
  const posts: Report[] = []
  const server = { diffs: [] as DiffRequest[] }
  const git = { diffOut: BODY, diffCalls: 0 }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {})
  const ok = (body: unknown, status = 200) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
  const values: Record<string, unknown> = {
    'session.id': SID,
    'session.model': 'claude-opus-5-5',
    'session.root': CWD,
    'session.repo': null,
    'session.version': { version: '2.1.301' },
    'session.usage': { startedAt: NOW, context: { tokens: 1000, window: 1_000_000, percent: 0.1 }, rateLimits: [], cost: { usd: 0.1 } },
    'session.surfaces': ['terminal'],
    'agent.list': [],
    'command.register': { command: 'podium' },
    'tool.register': { tool: 'mcp__podium-reporter__plan' },
    'ui.status': undefined,
    'ui.toast': undefined,
    'ui.log': undefined,
  }
  const stub = on as unknown as (event: string, handler: () => unknown) => void
  for (const [event, value] of Object.entries(values)) stub(event, () => ({ value }))
  on('process.run', (_$, e) => {
    const a = e.argv.join(' ')
    const res = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a.endsWith('rev-parse --show-toplevel')) return res('/repo\n')
    if (a.endsWith('rev-parse HEAD')) return res('headheadhead\n')
    if (a.includes('merge-base --is-ancestor')) return res('')
    if (a.includes('--name-status')) return res('M\0src/a.ts\0M\0.env\0')
    if (a.includes('--numstat')) return res('2\t1\tsrc/a.ts\0')
    if (a.includes('ls-files')) return res('')
    if (a.includes(' diff ')) {
      git.diffCalls++
      return res(git.diffOut)
    }
    return res('', 128)
  })
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    calls.push({ method, path: url.pathname, body })
    if (url.pathname === '/api/fleet/report') {
      posts.push(body as Report)
      const diffs = server.diffs.splice(0)
      return ok({ ok: true, ackedEvents: (body as Report).events.length, liveSessions: 1, watch: [], respond: false, deliveries: [], diffs })
    }
    return ok({ ok: true })
  })
  on('session.start', () => ({ cwd: CWD }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  return { calls, posts, server, git, clock }
}

type World = ReturnType<typeof world>

async function started($: Engine, w: World) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await w.clock.advance(1000)
  await w.clock.advance(1000)
}

async function settle(w: World, rounds = 30) {
  for (let i = 0; i < rounds; i++) await w.clock.advance(0)
}

const diffPuts = (w: World) => w.calls.filter((c) => c.method === 'PUT' && c.path.includes('/diffs/'))
const reply = (c: Call) => c.body as FileDiffReply

describe('file diff on request', () => {
  test('with the option on, a listed request is read, redacted and answered once', { options: { fileDiff: true } }, async ($, on) => {
    const w = world(on)
    await started($, w)
    expect(w.posts.at(-1)!.session.fileDiff).toBe(true)
    w.server.diffs.push({ id: 'req1', path: 'src/a.ts' })
    await w.clock.advance(5000)
    await settle(w)
    const puts = diffPuts(w)
    expect(puts.length).toBe(1)
    expect(puts[0]!.path).toBe(`/api/fleet/sessions/${SID}/diffs/req1`)
    const r = reply(puts[0]!)
    expect(r).toMatchObject({ path: 'src/a.ts', status: 'ok', truncated: false, redactions: 1 })
    expect(r.text!.startsWith('@@ -1,2 +1,3 @@')).toBe(true)
    expect(r.text!.includes('abcd1234efgh5678')).toBe(false)
    expect(r.text!.includes('[redacted]')).toBe(true)
  })

  test('a request listed in two replies is read once', { options: { fileDiff: true } }, async ($, on) => {
    const w = world(on)
    await started($, w)
    w.server.diffs.push({ id: 'req1', path: 'src/a.ts' })
    await w.clock.advance(5000)
    await settle(w)
    w.server.diffs.push({ id: 'req1', path: 'src/a.ts' })
    await w.clock.advance(5000)
    await settle(w)
    expect(diffPuts(w).length).toBe(1)
    expect(w.git.diffCalls).toBe(1)
  })

  for (const [name, path, status] of [
    ['a path the Files list does not name is unavailable', 'src/never-changed.ts', 'unavailable'],
    ['a secret-holding path is withheld', '.env', 'withheld'],
  ] as const) {
    test(`${name}, and git is not asked for it`, { options: { fileDiff: true } }, async ($, on) => {
      const w = world(on)
      await started($, w)
      w.server.diffs.push({ id: 'req2', path })
      await w.clock.advance(5000)
      await settle(w)
      expect(reply(diffPuts(w)[0]!)).toMatchObject({ status, text: null })
      expect(w.git.diffCalls).toBe(0)
    })
  }

  test('with the option off nothing is read or sent, and the report says so', async ($, on) => {
    const w = world(on)
    await started($, w)
    expect(w.posts.at(-1)!.session.fileDiff).toBe(false)
    w.server.diffs.push({ id: 'req4', path: 'src/a.ts' })
    await w.clock.advance(5000)
    await settle(w)
    expect(diffPuts(w)).toEqual([])
    expect(w.git.diffCalls).toBe(0)
  })
})
