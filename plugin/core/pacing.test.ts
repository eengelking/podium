// #752: a large report that only counted waits (SPEC 6.7). The pacing rule, the transport's hold and the single serialization both reporters share.
import { describe, test, expect } from 'claude-code/testing'
import { attentionKey, holdMs, HOLD_FROM_BYTES } from './pacing.ts'
import { reportBody, withinSize } from './feed.ts'
import { EVENTS_PER_REPORT, Transport, type FetchLike } from './transport.ts'
import type { ActivityEvent, AgentReport, Report } from './protocol.ts'

/** A session of `n` agents as a reporter sends it: only the fields the pacing rule reads are real, the rest is padding to give the report a size. */
function agent(i: number, over: Partial<AgentReport> = {}): AgentReport {
  return {
    id: `a${i}`,
    status: 'running',
    tokens: { input: 1000, output: 100, cacheRead: 5000, cacheWrite: 0 },
    costUsdEst: 0.01,
    lastTool: 'Bash',
    toolCalls: 3,
    toolCounts: { Bash: 3 },
    steps: { done: 1, total: null },
    failure: null,
    promptExcerpt: 'x'.repeat(600),
    ...over,
  } as unknown as AgentReport
}

function report(n: number, over: { signals?: Record<string, number>; session?: object; agents?: AgentReport[]; events?: ActivityEvent[]; sentAt?: number } = {}): Report {
  return {
    v: 1,
    sentAt: over.sentAt ?? 0,
    reporter: { name: 'podium-reporter', version: '1.0.0', engineVersion: null, hostSurface: null },
    session: { id: 's', status: 'running', waitReason: null, endReason: null, costUsd: 1, tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }, ...over.session },
    agents: over.agents ?? Array.from({ length: n }, (_, i) => agent(i)),
    events: over.events ?? [],
    ...(over.signals ? { signals: over.signals } : {}),
  } as unknown as Report
}

const ev = (i: number): ActivityEvent => ({ id: `e${i}`, t: i, kind: 'note', agentId: null, text: `n${i}`, data: null })

describe('attentionKey (#752)', () => {
  test('counters, the last tool, the send time and the events do not change it', () => {
    const a = report(3)
    const b = report(3, {
      sentAt: 9,
      signals: { 'hook:x': 4 },
      events: [ev(1)],
      session: { costUsd: 2, tokens: { input: 9, output: 9, cacheRead: 9, cacheWrite: 0 } },
      agents: [0, 1, 2].map((i) => agent(i, { toolCalls: 9, lastTool: 'Read', costUsdEst: 0.5, toolCounts: { Bash: 3, Read: 6 }, steps: { done: 4, total: null }, tokens: { input: 5, output: 5, cacheRead: 5, cacheWrite: 0 } })),
    })
    expect(attentionKey(b)).toBe(attentionKey(a))
  })

  test('a status, a failure, an ended session, a plan or a new agent changes it', () => {
    const base = attentionKey(report(3))
    expect(attentionKey(report(3, { agents: [agent(0), agent(1, { status: 'done' }), agent(2)] }))).not.toBe(base)
    expect(attentionKey(report(3, { agents: [agent(0), agent(1), agent(2, { failure: { class: 'x' } as never })] }))).not.toBe(base)
    expect(attentionKey(report(3, { session: { status: 'waiting', waitReason: 'input' } }))).not.toBe(base)
    expect(attentionKey(report(3, { session: { endReason: 'exit' } }))).not.toBe(base)
    expect(attentionKey(report(3, { session: { plan: { items: [] } } }))).not.toBe(base)
    expect(attentionKey(report(4))).not.toBe(base)
  })

  test('a field it does not know counts as a change, so a new field is never held back', () => {
    expect(attentionKey(report(1, { session: { somethingNew: 1 } }))).not.toBe(attentionKey(report(1)))
  })
})

describe('holdMs (#752)', () => {
  test('a small report is never held, a large one is held in steps and never past the heartbeat', () => {
    expect(holdMs(HOLD_FROM_BYTES, 5000)).toBe(0)
    expect(holdMs(HOLD_FROM_BYTES + 1, 5000)).toBe(2000)
    expect(holdMs(3 * HOLD_FROM_BYTES, 5000)).toBe(3000)
    expect(holdMs(143 * 1024, 5000)).toBe(5000)
    expect(holdMs(143 * 1024, 2000)).toBe(2000)
  })
})

describe('reportBody (#752)', () => {
  test('withinSize leaves the body it serialized, so the transport does not serialize the report again', () => {
    const r = report(2)
    ;(r.session as { activity?: unknown }).activity = [{ at: 1, kind: 'tool', text: 'x' }]
    withinSize(r)
    expect(reportBody(r)).toBe(JSON.stringify(r))
  })
})

function transport(responses: { sent: string[] } = { sent: [] }) {
  const fetch: FetchLike = async (_url, init) => {
    responses.sent.push(init.body ?? '')
    return { status: 200, ok: true, text: '{"ok":true}' }
  }
  return { t: new Transport(fetch, { serverUrl: 'http://h', token: '', heartbeatMs: 5000, version: '1.0.0' }), sent: responses.sent }
}

const T = 1_800_000_000_000 // a real clock: 0 means never sent
const BIG = 200 // agents: about 160 KB, past HOLD_FROM_BYTES
const counters = (n: number) => report(n, { agents: Array.from({ length: n }, (_, i) => agent(i, { toolCalls: 99, costUsdEst: 0.9 })) })

describe('Transport holds a large report that only counted (#752)', () => {
  test('the second report one second later waits, and goes at the hold, with its events kept meanwhile', async () => {
    const { t, sent } = transport()
    expect(await t.send(() => report(BIG), T + 0)).toBe('ok')
    t.enqueue([ev(1)])
    expect(await t.send((events) => ({ ...counters(BIG), events }), T + 1000)).toBe('held')
    expect(sent).toHaveLength(1)
    expect(t.queue).toHaveLength(1)
    expect(await t.send((events) => ({ ...counters(BIG), events }), T + 4999)).toBe('held')
    expect(await t.send((events) => ({ ...counters(BIG), events }), T + 5000)).toBe('ok')
    expect(sent).toHaveLength(2)
    expect(t.queue).toHaveLength(0)
  })

  test('a status change goes at once', async () => {
    const { t, sent } = transport()
    await t.send(() => report(BIG), T + 0)
    const changed = report(BIG, { agents: Array.from({ length: BIG }, (_, i) => agent(i, i === 7 ? { status: 'done' } : {})) })
    expect(await t.send(() => changed, 1000)).toBe('ok')
    expect(sent).toHaveLength(2)
  })

  test('a full batch of events goes at once, so events never pile up behind the hold', async () => {
    const { t, sent } = transport()
    await t.send(() => report(BIG), T + 0)
    t.enqueue(Array.from({ length: EVENTS_PER_REPORT }, (_, i) => ev(i)))
    expect(await t.send(() => counters(BIG), T + 1000)).toBe('ok')
    expect(sent).toHaveLength(2)
  })

  test('a small report is never held', async () => {
    const { t, sent } = transport()
    await t.send(() => report(2), T + 0)
    expect(await t.send(() => counters(2), T + 1000)).toBe('ok')
    expect(sent).toHaveLength(2)
  })

  test('force sends a held report', async () => {
    const { t, sent } = transport()
    await t.send(() => report(BIG), T + 0)
    expect(await t.send(() => counters(BIG), T + 1000, true)).toBe('ok')
    expect(sent).toHaveLength(2)
  })

  test('the first report, and the first after a failure, are never held', async () => {
    const { t, sent } = transport()
    expect(await t.send(() => counters(BIG), T + 0)).toBe('ok')
    expect(sent).toHaveLength(1)
  })

  test('the body posted is the report as serialized once, and a held report leaves the transport free', async () => {
    const { t, sent } = transport()
    const r = report(BIG)
    await t.send(() => r, T)
    expect(sent[0]).toBe(JSON.stringify(r))
    expect(await t.send(() => counters(BIG), T + 1000)).toBe('held')
    expect(t.inFlight).toBe(false)
  })

  test('the retry after a failed send is not held, even when only counters moved since the last report the server took', async () => {
    let fail = false
    const sent: string[] = []
    const fetch: FetchLike = async (_url, init) => {
      if (fail) throw new Error('down')
      sent.push(init.body ?? '')
      return { status: 200, ok: true, text: '{"ok":true}' }
    }
    const t = new Transport(fetch, { serverUrl: 'http://h', token: '', heartbeatMs: 5000, version: '1.0.0' })
    await t.send(() => report(BIG), T)
    fail = true
    expect(await t.send(() => counters(BIG), T + 1000, true)).toBe('failed') // a forced send reaches the network and fails
    fail = false
    expect(await t.send(() => counters(BIG), T + 2500)).toBe('ok') // inside the hold, but the first report after a failure is never held
    expect(sent).toHaveLength(2)
  })
})
