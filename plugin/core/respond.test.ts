import { describe, test, expect } from 'claude-code/testing'
import type { Ask, Delivery } from './protocol.ts'
import { ACTED_KEPT, OUTBOX_MAX, Responder, deliveryOf, newResponderState, sessionPath } from './respond.ts'
import type { FetchLike } from './transport.ts'

const ASK: Ask = { id: 'per_1', kind: 'permission', agentId: null, openedAt: 1, tool: { name: 'read', input: {}, cut: false } }
const DELIVERY: Delivery = { id: 'd1', askId: 'per_1', by: 'Ed', at: 5, kind: 'allow-once' }

interface Call { method: string; url: string; body: unknown; token: string | undefined }

/** A responder over a fake server that answers each request with the next scripted reply (an Error is a network failure). */
function world(replies: ({ status: number; text?: string } | Error)[], token = 'tok') {
  const calls: Call[] = []
  const sleeps: number[] = []
  let sleepOk = true
  const fetch: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined, token: init.headers['X-Podium-Token'] })
    const r = replies.shift() ?? { status: 204 }
    if (r instanceof Error) throw r
    return { status: r.status, ok: r.status < 300, text: r.text ?? '' }
  }
  const r = new Responder(fetch, { serverUrl: 'http://podium.test/', token }, { now: () => 42, sleep: async (ms) => { sleeps.push(ms); return sleepOk } })
  return { r, calls, sleeps, stopSleeping: () => { sleepOk = false } }
}

const delivery = (d: Partial<Delivery> = {}) => ({ status: 200, text: JSON.stringify({ delivery: { ...DELIVERY, ...d } }) })

describe('Responder: calls and announce (#858)', () => {
  test('announce puts the ask with the token and returns the status', async () => {
    const w = world([{ status: 200 }])
    expect(await w.r.announce('s 1', ASK)).toBe(200)
    expect(w.calls[0]).toMatchObject({ method: 'PUT', url: `http://podium.test${sessionPath('s 1')}/asks/per_1`, token: 'tok', body: ASK })
    expect(w.calls[0]!.url).toContain('s%201')
  })

  test('an unreachable server is status 0, and no token sends no token header', async () => {
    const w = world([new Error('offline')], '')
    expect(await w.r.announce('s', ASK)).toBe(0)
    expect(w.calls[0]!.token).toBeUndefined()
  })

  test('a call with no body sends none', async () => {
    const w = world([{ status: 204 }])
    expect(await w.r.call('GET', '/x')).toEqual({ status: 204, text: '' })
    expect(w.calls[0]!.body).toBeUndefined()
  })
})

describe('Responder: acted ids and the outbox', () => {
  test('a delivery id acts once, and only the last ones are kept', () => {
    const w = world([])
    expect(w.r.markActed('a')).toBe(true)
    expect(w.r.markActed('a')).toBe(false)
    for (let i = 0; i < ACTED_KEPT; i++) w.r.markActed(`x${i}`)
    expect(w.r.markActed('a')).toBe(true)
  })

  test('results and closes go out in order; an offline pass keeps the rest', async () => {
    const w = world([{ status: 200 }, new Error('offline'), { status: 200 }, { status: 404 }])
    w.r.queueResult('s', 'd 1', 'took')
    w.r.queueClose('s', 'per_1', 'terminal', { answer: 'allowed' })
    await w.r.flush()
    expect(w.r.outbox).toHaveLength(1)
    expect(w.calls[0]).toMatchObject({ method: 'POST', body: { result: 'took', at: 42 } })
    expect(w.calls[0]!.url).toContain('/deliveries/d%201/result')
    await w.r.flush()
    expect(w.r.outbox).toHaveLength(0)
    expect(w.calls[2]).toMatchObject({ body: { outcome: 'terminal', at: 42, answer: 'allowed' } })
    expect(w.calls[2]!.url).toContain('/asks/per_1/close')
  })

  test('flushes from two places at once send each item once', async () => {
    const w = world([{ status: 200 }, { status: 200 }, { status: 200 }])
    w.r.queueResult('s', 'd1', 'took')
    w.r.queueResult('s', 'd2', 'took')
    await Promise.all([w.r.flush(), w.r.flush(), w.r.flush()])
    expect(w.calls.map((c) => c.url.split('/').slice(-2, -1)[0])).toEqual(['d1', 'd2'])
    expect(w.r.outbox).toHaveLength(0)
  })

  test('a server error drops the item instead of retrying it forever', async () => {
    const w = world([{ status: 500 }])
    w.r.queueResult('s', 'd', 'refused')
    await w.r.flush()
    expect(w.r.outbox).toHaveLength(0)
  })

  test('the outbox keeps the newest OUTBOX_MAX', () => {
    const w = world([])
    for (let i = 0; i < OUTBOX_MAX + 5; i++) w.r.queueResult('s', `d${i}`, 'took')
    expect(w.r.outbox).toHaveLength(OUTBOX_MAX)
    expect((w.r.outbox[0]!.path)).toContain('d5')
  })
})

describe('Responder.wait', () => {
  const always = () => true

  test('returns the delivery that answers the ask', async () => {
    const w = world([{ status: 204 }, delivery()])
    const d = await w.r.wait('s', ASK, always, (x) => x.kind === 'allow-once')
    expect(d?.id).toBe('d1')
    expect(w.calls).toHaveLength(2)
    expect(w.calls[0]!.url).toContain('/asks/per_1/answer?wait=20')
  })

  test('stops at once when the ask is not active', async () => {
    const w = world([])
    expect(await w.r.wait('s', ASK, () => false, always)).toBeNull()
    expect(w.calls).toHaveLength(0)
  })

  test('an answer that arrives after the ask closed is reported closed', async () => {
    const w = world([delivery()])
    let open = true
    const first = w.r.wait('s', ASK, () => open, always)
    open = false
    expect(await first).toBeNull()
    expect(w.r.outbox).toHaveLength(1)
    expect(w.r.outbox[0]!.body).toMatchObject({ result: 'closed' })
  })

  test('a late reply that is not a delivery queues nothing', async () => {
    const w = world([{ status: 204 }])
    let open = true
    const p = w.r.wait('s', ASK, () => open, always)
    open = false
    expect(await p).toBeNull()
    expect(w.r.outbox).toHaveLength(0)
  })

  test('an offline server is retried after the first backoff, and a cut sleep ends the wait', async () => {
    const w = world([new Error('offline'), new Error('offline')])
    w.stopSleeping()
    expect(await w.r.wait('s', ASK, always, always)).toBeNull()
    expect(w.sleeps).toEqual([1000])
    expect(w.calls).toHaveLength(1)
  })

  test('a 404 announces the ask again, then asks again', async () => {
    const w = world([{ status: 404 }, { status: 200 }, delivery()])
    expect((await w.r.wait('s', ASK, always, always))?.id).toBe('d1')
    expect(w.calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET'])
    expect(w.sleeps).toEqual([])
  })

  test('a 404 whose announce fails waits before asking again, and a cut sleep ends the wait', async () => {
    const w = world([{ status: 404 }, { status: 500 }])
    w.stopSleeping()
    expect(await w.r.wait('s', ASK, always, always)).toBeNull()
    expect(w.sleeps).toEqual([2000])
  })

  test('an error status or a reply with no delivery ends the wait', async () => {
    expect(await world([{ status: 410 }]).r.wait('s', ASK, always, always)).toBeNull()
  })

  test('a delivery already acted on is not acted on again; the wait asks again after a pause', async () => {
    const w = world([delivery(), delivery({ id: 'd2' })])
    w.r.markActed('d1')
    expect((await w.r.wait('s', ASK, always, always))?.id).toBe('d2')
    expect(w.sleeps).toEqual([1000])
  })

  test('a pause cut short while waiting out an acted delivery ends the wait', async () => {
    const w = world([delivery()])
    w.r.markActed('d1')
    w.stopSleeping()
    expect(await w.r.wait('s', ASK, always, always)).toBeNull()
  })

  test('a delivery for another ask, or of a kind not wanted, is refused and the wait goes on', async () => {
    const w = world([delivery({ id: 'o', askId: 'other' }), delivery({ id: 'k', kind: 'deny' }), delivery({ id: 'ok' })])
    const d = await w.r.wait('s', ASK, always, (x) => x.kind === 'allow-once')
    expect(d?.id).toBe('ok')
    expect(w.r.outbox.map((i) => (i.body as { result: string }).result)).toEqual(['refused', 'refused'])
  })
})

describe('Responder: what a reporter with its own plumbing adds (#971)', () => {
  const always = () => true
  const clock = { now: () => 42, sleep: async () => true }
  const cfg = { serverUrl: 'http://podium.test', token: 't' }

  test('a wait hands a delivery that `other` takes over and goes on', async () => {
    const w = world([delivery({ id: 'fb', kind: 'plan-feedback' }), delivery({ id: 'ok' })])
    const seen: string[] = []
    const d = await w.r.wait('s', ASK, always, (x) => x.kind === 'allow-once', { other: (x) => void seen.push(x.id) })
    expect(d?.id).toBe('ok')
    expect(seen).toEqual(['fb'])
    expect(w.r.outbox).toEqual([])
  })

  test('a wait leaves a delivery that `skip` names alone, asks again after half a second, and does not mark it acted', async () => {
    const w = world([delivery({ id: 'sk' }), delivery({ id: 'sk' })])
    let skipping = true
    const d = await w.r.wait('s', ASK, always, always, { skip: () => { const s = skipping; skipping = false; return s } })
    expect(d?.id).toBe('sk')
    expect(w.sleeps).toEqual([500])
    expect(w.r.outbox).toEqual([])
  })

  test('a cut sleep while skipping ends the wait', async () => {
    const w = world([delivery()])
    w.stopSleeping()
    expect(await w.r.wait('s', ASK, always, always, { skip: () => true })).toBeNull()
  })

  test('state is shared between responders, and onActed sees each new id', async () => {
    const state = newResponderState()
    const kept: string[][] = []
    const a = new Responder(async () => ({ status: 200, ok: true, text: '' }), cfg, clock, state, { onActed: (ids) => kept.push([...ids]) })
    const b = new Responder(async () => ({ status: 200, ok: true, text: '' }), cfg, clock, state)
    expect(a.markActed('x')).toBe(true)
    expect(b.markActed('x')).toBe(false)
    a.queue({ path: '/p', body: 1 })
    expect(b.outbox).toEqual([{ path: '/p', body: 1 }])
    expect(kept).toEqual([['x']])
  })

  test('seedActed replaces the remembered ids and keeps the newest ACTED_KEPT', () => {
    const w = world([])
    w.r.seedActed(Array.from({ length: ACTED_KEPT + 5 }, (_, i) => `i${i}`))
    expect(w.r.markActed('i0')).toBe(true)
    expect(w.r.markActed(`i${ACTED_KEPT + 4}`)).toBe(false)
  })

  test('afterSend runs after each call the server took, and not after one that could not be made', async () => {
    let after = 0
    const r = new Responder(async () => ({ status: 200, ok: true, text: '' }), cfg, clock, newResponderState(), { afterSend: async () => { after++ } })
    r.queue({ path: '/a', body: {} })
    r.queue({ path: '/b', body: {} })
    await r.flush()
    expect(after).toBe(2)
    expect(r.outbox).toEqual([])
    const down = new Responder(async () => { throw new Error('down') }, cfg, clock, newResponderState(), { afterSend: async () => { after++ } })
    down.queue({ path: '/a', body: {} })
    await down.flush()
    expect(after).toBe(2)
    expect(down.outbox).toHaveLength(1)
  })
})

describe('deliveryOf', () => {
  test('reads only a 200 holding a delivery', () => {
    expect(deliveryOf(delivery())?.id).toBe('d1')
    expect(deliveryOf(null)).toBeNull()
    expect(deliveryOf({ status: 204, text: '' })).toBeNull()
    expect(deliveryOf({ status: 200, text: 'not json' })).toBeNull()
    expect(deliveryOf({ status: 200, text: '{"delivery":{"id":1}}' })).toBeNull()
  })
})
