import { describe, test, expect } from 'claude-code/testing'
import { MAIN_LOOP, RECORDING_LIMITS, type RecordingEntry, type RecordingGrant } from './protocol.ts'
import { isRecordingGrant } from './transport.ts'
import {
  CUT_MARK,
  inputText,
  limitLine,
  RECORDING_BATCH_INTERVAL_MS,
  Recorder,
  redactBounded,
  refusedLine,
  startLine,
  stoppedLine,
  clockOn,
  timeWithDay,
  utf8Bytes,
  WITHHELD,
} from './recording.ts'

const SECRET = 'sk-ant-api03-abcdefghijklmnop'
const GRANT: RecordingGrant = {
  state: 'recording',
  consent: { admin: true, chosen: true, owner: true },
  loops: [MAIN_LOOP, 'a1'],
  limit: null,
  startedBy: 'Maya',
  startedAt: 1_800_000_000_000,
  stoppedBy: null,
  stoppedAt: null,
  keptUntil: 1_800_000_000_000 + 6 * 3_600_000,
  bytes: 0,
}
const grant = (over: Partial<RecordingGrant> = {}): RecordingGrant => ({ ...GRANT, ...over })

function on(): Recorder {
  const r = new Recorder()
  r.begin('s1')
  r.apply(GRANT, true)
  return r
}

describe('isRecordingGrant', () => {
  test('accepts a grant and refuses anything else', () => {
    expect(isRecordingGrant(GRANT)).toBe(true)
    expect(isRecordingGrant(null)).toBe(false)
    expect(isRecordingGrant('x')).toBe(false)
    expect(isRecordingGrant({ ...GRANT, state: 'maybe' })).toBe(false)
    expect(isRecordingGrant({ ...GRANT, loops: 'a' })).toBe(false)
    expect(isRecordingGrant({ ...GRANT, consent: null })).toBe(false)
    expect(isRecordingGrant({ ...GRANT, consent: { admin: true } })).toBe(false)
  })
  test('keeps only the loops that are strings', () => {
    expect(isRecordingGrant({ ...GRANT, loops: [MAIN_LOOP, 3] })).toBe(false)
  })
})

describe('redactBounded', () => {
  test('a text of any size comes back the same but for its secrets, and a long line is fast', () => {
    const long = 'y'.repeat(90_000)
    const started = Date.now()
    expect(redactBounded(long)).toEqual({ text: long, redactions: 0 })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(redactBounded('short')).toEqual({ text: 'short', redactions: 0 })
  })
  test('lines, empty lines and a final newline survive; a secret in a long line goes', () => {
    const filler = 'word '.repeat(1000)
    const text = `${filler} ${SECRET} ${filler}\n\n${filler}\nend\n`
    const r = redactBounded(text)
    expect(r.text).not.toContain(SECRET)
    expect(r.redactions).toBe(1)
    expect(r.text.split('\n').length).toBe(5)
    expect(r.text.endsWith('\nend\n')).toBe(true)
    expect(r.text.replace('[redacted]', SECRET)).toBe(text)
  })
  test('a private key block across lines is still one block', () => {
    const key = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', 'abcdef', '-----END RSA PRIVATE KEY-----'].join('\n')
    const r = redactBounded(`${'z '.repeat(1500)}\n${key}\nafter`)
    expect(r.text).not.toContain('MIIEowIBAAKCAQEA')
    expect(r.text.endsWith('\nafter')).toBe(true)
  })
})

describe('utf8Bytes', () => {
  test('counts bytes, not characters', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('é')).toBe(2)
    expect(utf8Bytes('€')).toBe(3)
    expect(utf8Bytes('😀')).toBe(4)
    expect(utf8Bytes('\ud800')).toBe(3)
  })
})

describe('Recorder.apply', () => {
  test('starts only with all three yes answers, the grant recording and the option on', () => {
    const r = new Recorder()
    r.begin('s1')
    expect(r.apply(grant({ consent: { admin: true, chosen: true, owner: false } }), true).started).toBe(false)
    expect(r.apply(grant({ consent: { admin: false, chosen: true, owner: true } }), true).started).toBe(false)
    expect(r.apply(grant({ consent: { admin: true, chosen: false, owner: true } }), true).started).toBe(false)
    expect(r.apply(grant({ state: 'off' }), true).started).toBe(false)
    expect(r.apply(GRANT, false).started).toBe(false)
    expect(r.apply(null, true).started).toBe(false)
    expect(r.capturing).toBe(false)
    expect(r.apply(GRANT, true)).toEqual({ started: true, ended: null, refused: false })
    expect(r.capturing).toBe(true)
    expect(r.apply(GRANT, true).started).toBe(false)
  })

  test('the loops follow each reply', () => {
    const r = on()
    expect(r.want(MAIN_LOOP)).toBe(true)
    expect(r.want('a2')).toBe(false)
    r.apply(grant({ loops: ['a2'] }), true)
    expect(r.want(MAIN_LOOP)).toBe(false)
    expect(r.want('a2')).toBe(true)
  })

  test('says why capture ended, and closes the queue', () => {
    for (const [g, why] of [
      [grant({ state: 'stopped' }), 'stopped'],
      [grant({ state: 'limit', limit: 'session' }), 'limit'],
      [grant({ consent: { admin: true, chosen: true, owner: false } }), 'consent'],
      [null, 'consent'],
    ] as const) {
      const r = on()
      r.said(MAIN_LOOP, 'hello', 1)
      const out = r.apply(g, true)
      expect(out.ended).toBe(why)
      expect(r.capturing).toBe(false)
      expect(r.closing).toBe(true)
      expect(r.want(MAIN_LOOP)).toBe(false)
    }
  })

  test('chosen but the option is off: refused, once', () => {
    const r = new Recorder()
    r.begin('s1')
    const g = grant({ consent: { admin: true, chosen: true, owner: false } })
    expect(r.apply(g, false).refused).toBe(true)
    expect(r.apply(g, false).refused).toBe(false)
    r.apply(grant({ state: 'off', consent: { admin: true, chosen: false, owner: false } }), false)
    expect(r.apply(g, false).refused).toBe(true)
  })

  test('with nothing captured and nothing chosen it ends nothing', () => {
    const r = new Recorder()
    r.begin('s1')
    expect(r.apply(grant({ state: 'stopped' }), true)).toEqual({ started: false, ended: null, refused: false })
    expect(r.closing).toBe(false)
  })
})

describe('Recorder capture', () => {
  test('numbers each loop from 1, in order, and keeps the kinds', () => {
    const r = on()
    r.prompt(MAIN_LOOP, 'do it', 10)
    r.said(MAIN_LOOP, 'ok', 11)
    r.thinking(MAIN_LOOP, 12)
    r.prompt('a1', 'task', 13)
    r.clear(MAIN_LOOP, 14)
    r.compact('a1', 15)
    const batch = r.nextBatch(0)!.batch
    expect(batch.v).toBe(1)
    expect(batch.entries.map((e) => [e.loop, e.seq, e.kind, e.at])).toEqual([
      [MAIN_LOOP, 1, 'prompt', 10],
      [MAIN_LOOP, 2, 'text', 11],
      [MAIN_LOOP, 3, 'thinking', 12],
      ['a1', 1, 'prompt', 13],
      [MAIN_LOOP, 4, 'clear', 14],
      ['a1', 2, 'compact', 15],
    ])
    expect(batch.entries[2]!.text).toBe('')
  })

  test('captures nothing for a loop that is not chosen, or while off', () => {
    const r = on()
    r.prompt('a9', 'x', 1)
    expect(r.nextBatch(0)).toBeNull()
    const off = new Recorder()
    off.begin('s')
    off.prompt(MAIN_LOOP, 'x', 1)
    off.said(MAIN_LOOP, 'x', 1)
    expect(off.call(MAIN_LOOP, 'Bash', { command: 'ls' }, 1)).toBeNull()
    expect(off.nextBatch(0)).toBeNull()
  })

  test('an empty text is not an entry', () => {
    const r = on()
    r.prompt(MAIN_LOOP, '', 1)
    r.said(MAIN_LOOP, '', 1)
    expect(r.nextBatch(0)).toBeNull()
  })

  test('the same prompt twice in a row is one entry', () => {
    const r = on()
    r.prompt('a1', 'task', 1)
    r.prompt('a1', 'task', 2)
    r.said('a1', 'working', 3)
    r.prompt('a1', 'task', 4)
    expect(r.nextBatch(0)!.batch.entries.map((e) => e.kind)).toEqual(['prompt', 'text', 'prompt'])
  })

  test('a call and its result are paired by callSeq, whole', () => {
    const r = on()
    const seq = r.call(MAIN_LOOP, 'Bash', { tool: 'Bash', tool_use_id: 'tu', agentId: undefined, command: 'ls -la' }, 5)
    expect(seq).toBe(1)
    r.outcome(MAIN_LOOP, 'Bash', { command: 'ls' }, seq, { text: 'a\nb\nc', result: 'a\nb\nc' }, 6)
    const [call, result] = r.nextBatch(0)!.batch.entries
    expect(call).toMatchObject({ kind: 'tool', name: 'Bash', seq: 1, text: '{"command":"ls -la"}' })
    expect(result).toMatchObject({ kind: 'result', name: 'Bash', seq: 2, callSeq: 1, text: 'a\nb\nc' })
    expect(result!.failed).toBeUndefined()
  })

  test('an error and a refusal are failed results', () => {
    const r = on()
    const seq = r.call(MAIN_LOOP, 'Bash', { command: 'x' }, 1)
    r.outcome(MAIN_LOOP, 'Bash', { command: 'x' }, seq, { isError: true, text: 'Exit code 1' }, 2)
    r.outcome(MAIN_LOOP, 'Bash', { command: 'x' }, seq, { deny: 'not allowed' }, 3)
    const entries = r.nextBatch(0)!.batch.entries
    expect(entries[1]).toMatchObject({ text: 'Exit code 1', failed: true })
    expect(entries[2]).toMatchObject({ text: 'not allowed', failed: true })
  })

  test('a result the mod cannot read is recorded without one', () => {
    const r = on()
    const seq = r.call(MAIN_LOOP, 'Mystery', { a: 1 }, 1)
    r.outcome(MAIN_LOOP, 'Mystery', { a: 1 }, seq, { result: { blob: true } }, 2)
    r.outcome(MAIN_LOOP, 'Mystery', { a: 1 }, seq, undefined, 3)
    r.outcome(MAIN_LOOP, 'Mystery', { a: 1 }, null, { text: 'late' }, 4)
    expect(r.nextBatch(0)!.batch.entries.map((e) => e.kind)).toEqual(['tool'])
  })

  test('a result that is only text in `result` is read from there', () => {
    const r = on()
    const seq = r.call(MAIN_LOOP, 'T', {}, 1)
    r.outcome(MAIN_LOOP, 'T', {}, seq, { result: 'plain' }, 2)
    expect(r.nextBatch(0)!.batch.entries[1]!.text).toBe('plain')
  })

  test('secrets are replaced everywhere and counted', () => {
    const r = on()
    r.prompt(MAIN_LOOP, 'use sk-ant-abcdefghijklmnop1234 please', 1)
    r.said(MAIN_LOOP, 'the key is ghp_abcdefghijklmnopqrstuvwxyz0123', 2)
    const seq = r.call(MAIN_LOOP, 'Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789"' }, 3)
    r.outcome(MAIN_LOOP, 'Bash', {}, seq, { text: 'AKIAABCDEFGHIJKLMNOP' }, 4)
    const out = JSON.stringify(r.nextBatch(0)!.batch)
    expect(out).not.toContain('sk-ant-abcdefghijklmnop1234')
    expect(out).not.toContain('ghp_abcdefghijklmnop')
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
    expect(out).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(out).toContain('[redacted]')
    expect(r.redactions).toBeGreaterThanOrEqual(4)
  })

  test('a text past the limit is cut with the marker', () => {
    const r = on()
    r.said(MAIN_LOOP, 'a '.repeat(RECORDING_LIMITS.text), 1)
    r.said(MAIN_LOOP, 'short', 2)
    const [big, small] = r.nextBatch(0)!.batch.entries
    expect(big!.cut).toBe(true)
    expect(big!.text.endsWith(CUT_MARK)).toBe(true)
    expect(big!.text.length).toBe(RECORDING_LIMITS.text + 1 + CUT_MARK.length)
    expect(small!.cut).toBeUndefined()
  })

  test('an entry that still would not fit a request is cut further', () => {
    const r = on()
    r.said(MAIN_LOOP, '\u0001'.repeat(RECORDING_LIMITS.text), 1)
    const { batch } = r.nextBatch(0)!
    expect(utf8Bytes(JSON.stringify(batch))).toBeLessThanOrEqual(RECORDING_LIMITS.bodyBytes)
    expect(batch.entries[0]!.cut).toBe(true)
    expect(batch.entries[0]!.text).toContain('[cut off at ')
  })
})

describe('inputText', () => {
  test('keeps a call whole and drops the event fields', () => {
    expect(inputText('Write', { tool: 'Write', tool_use_id: 'x', agentId: 'a', consent: 'c', requestMeta: {}, file_path: '/x/a.ts', content: 'line1\nline2' }).text).toBe('{"file_path":"/x/a.ts","content":"line1\\nline2"}')
  })
  test('redacts string values nested in arrays and objects', () => {
    const t = inputText('Edit', { file_path: 'a.ts', edits: [{ old: 'k=sk-ant-abcdefghijklmnop1234', n: 1, ok: true, nothing: null }] })
    expect(t.text).not.toContain('abcdefghijklmnop1234')
    expect(t.text).toContain('"n":1')
    expect(t.redactions).toBeGreaterThan(0)
  })
  test('a path on the never-send list keeps the path and nothing else', () => {
    for (const tool of ['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit']) {
      const t = inputText(tool, { file_path: '/p/.env', old_string: 'SECRET=1', new_string: 'SECRET=2', content: 'SECRET=3', notebook_path: undefined })
      expect(t.withheld).toBe(true)
      expect(t.text).toBe('{"file_path":"/p/.env"}')
    }
    const nb = inputText('NotebookEdit', { notebook_path: '/p/id_rsa', new_source: 'x' })
    expect(nb).toMatchObject({ withheld: true, text: '{"notebook_path":"/p/id_rsa"}' })
  })
  test('another tool with such a path is only redacted, and an ordinary path is not withheld', () => {
    expect(inputText('Bash', { command: 'cat .env' }).withheld).toBe(false)
    expect(inputText('Read', { file_path: '/p/a.ts' }).withheld).toBe(false)
    expect(inputText('Read', { file_path: 7 }).withheld).toBe(false)
  })
  test('survives very deep nesting', () => {
    let v: unknown = 'x'
    for (let i = 0; i < 40; i++) v = { v }
    expect(inputText('T', { v }).text.length).toBeGreaterThan(0)
  })
  test('a withheld file records the call and withholds the result', () => {
    const r = on()
    const seq = r.call(MAIN_LOOP, 'Read', { file_path: '/p/.env' }, 1)
    r.outcome(MAIN_LOOP, 'Read', { file_path: '/p/.env' }, seq, { text: 'SECRET=hunter2 and more', result: {} }, 2)
    const [call, result] = r.nextBatch(0)!.batch.entries
    expect(call!.text).toBe('{"file_path":"/p/.env"}')
    expect(result).toMatchObject({ kind: 'result', text: WITHHELD, callSeq: 1 })
  })
})

describe('Recorder batches and queue', () => {
  test('a batch holds at most 200 entries, then the rest', () => {
    const r = on()
    for (let i = 0; i < 250; i++) r.said(MAIN_LOOP, `m${i}`, i)
    const first = r.nextBatch(0)!
    expect(first.count).toBe(200)
    expect(r.nextBatch(0)).toBeNull() // one in flight at a time
    r.done(first.count, 0)
    const second = r.nextBatch(RECORDING_BATCH_INTERVAL_MS)!
    expect(second.count).toBe(50)
    expect(second.batch.entries[0]!.seq).toBe(201)
    expect(r.queued).toBe(50)
  })

  test('a batch stays under the byte limit and always takes one entry', () => {
    const r = on()
    for (let i = 0; i < 20; i++) r.said(MAIN_LOOP, 'x '.repeat(30_000), i)
    const { batch, count } = r.nextBatch(0)!
    expect(count).toBeLessThan(20)
    expect(count).toBeGreaterThan(1)
    expect(utf8Bytes(JSON.stringify(batch))).toBeLessThanOrEqual(RECORDING_LIMITS.bodyBytes)
  })

  test('the interval holds a batch back, and a failure backs off', () => {
    const r = on()
    r.said(MAIN_LOOP, 'a', 1)
    expect(r.due(0)).toBe(true)
    const b = r.nextBatch(0)!
    r.done(b.count, 10_000)
    r.said(MAIN_LOOP, 'b', 2)
    expect(r.due(10_000 + RECORDING_BATCH_INTERVAL_MS - 1)).toBe(false)
    expect(r.due(10_000 + RECORDING_BATCH_INTERVAL_MS)).toBe(true)
    const c = r.nextBatch(11_000)!
    expect(r.due(11_000)).toBe(false)
    r.failed(11_000)
    expect(r.queued).toBe(1)
    expect(r.due(11_500)).toBe(false)
    expect(r.due(12_000)).toBe(true)
    expect(c.batch.entries[0]!.seq).toBe(2)
    expect(r.nextBatch(12_000)!.batch.entries[0]!.seq).toBe(2) // the same entries again
    r.failed(12_000)
    r.failed(12_000)
    expect(r.nextAttemptAt).toBeGreaterThan(12_000 + 2000)
  })

  test('nothing is due with an empty queue', () => {
    const r = on()
    expect(r.due(1e9)).toBe(false)
    expect(r.nextBatch(1e9)).toBeNull()
  })

  test('a lost batch is dropped without a retry', () => {
    const r = on()
    r.said(MAIN_LOOP, 'a', 1)
    const b = r.nextBatch(0)!
    r.drop(b.count, 5)
    expect(r.queued).toBe(0)
    expect(r.nextAttemptAt).toBeGreaterThan(5)
  })

  test('past the queue bound the oldest entries go and one gap says how many', () => {
    const r = on()
    const chunk = 'y '.repeat(45_000)
    for (let i = 0; i < 100; i++) r.said(MAIN_LOOP, chunk, i)
    expect(r.queuedBytes).toBeLessThanOrEqual(RECORDING_LIMITS.queueBytes)
    const all: RecordingEntry[] = []
    for (let b = r.nextBatch(0); b; b = r.nextBatch(0)) {
      all.push(...b.batch.entries)
      r.done(b.count, 0)
    }
    const gaps = all.filter((e) => e.kind === 'gap')
    expect(gaps.length).toBe(1)
    expect(gaps[0]!.seq).toBe(1)
    expect(gaps[0]!.text).toBe('')
    expect(gaps[0]!.lost! + all.filter((e) => e.kind === 'text').length).toBe(100)
    expect(all[0]!.kind).toBe('gap')
    expect(all.map((e) => e.seq)).toEqual([...all.map((e) => e.seq)].sort((a, b) => a - b))
  })

  test('entries in flight are never dropped, and each loop gets its own gap', () => {
    const r = on()
    r.said(MAIN_LOOP, 'first', 1)
    const inflight = r.nextBatch(0)!
    const chunk = 'z '.repeat(45_000)
    for (let i = 0; i < 100; i++) r.said(i % 2 ? 'a1' : MAIN_LOOP, chunk, i)
    r.done(inflight.count, 0)
    const all: { loop: string; kind: string }[] = []
    for (let b = r.nextBatch(RECORDING_BATCH_INTERVAL_MS); b; b = r.nextBatch(RECORDING_BATCH_INTERVAL_MS)) {
      all.push(...b.batch.entries)
      r.done(b.count, 0)
    }
    expect(all.filter((e) => e.kind === 'gap').map((e) => e.loop).sort()).toEqual(['@orchestrator', 'a1'])
  })

  test('a gap that is already in flight is not merged into', () => {
    const r = on()
    const chunk = 'q '.repeat(45_000)
    for (let i = 0; i < 100; i++) r.said(MAIN_LOOP, chunk, i)
    const sending = r.nextBatch(0)!
    expect(sending.batch.entries[0]!.kind).toBe('gap')
    for (let i = 0; i < 100; i++) r.said(MAIN_LOOP, chunk, i)
    r.done(sending.count, 0)
    const next = r.nextBatch(RECORDING_BATCH_INTERVAL_MS)!
    expect(next.batch.entries.some((e) => e.kind === 'gap')).toBe(true)
  })
})

describe('Recorder lifecycle', () => {
  test('closing ends once the queue is cleared', () => {
    const r = on()
    r.said(MAIN_LOOP, 'a', 1)
    r.apply(grant({ state: 'stopped' }), true)
    expect(r.due(0)).toBe(true)
    r.finish()
    expect(r.closing).toBe(false)
    expect(r.queued).toBe(0)
    expect(r.nextBatch(0)).toBeNull()
  })
  test('begin starts a session over', () => {
    const r = on()
    r.said(MAIN_LOOP, 'a', 1)
    r.begin('s2')
    expect(r.sessionId).toBe('s2')
    expect(r.capturing).toBe(false)
    expect(r.queued).toBe(0)
    r.apply(GRANT, true)
    r.said(MAIN_LOOP, 'b', 2)
    expect(r.nextBatch(0)!.batch.entries[0]!.seq).toBe(1)
  })
  test('close ends capture for good: a later reply does not start it again', () => {
    const r = on()
    r.said(MAIN_LOOP, 'a', 1)
    r.close()
    expect(r.capturing).toBe(false)
    expect(r.closing).toBe(true)
    expect(r.apply(GRANT, true)).toEqual({ started: false, ended: null, refused: false })
    expect(r.capturing).toBe(false)
    expect(r.due(0)).toBe(true)
    r.begin('s2')
    expect(r.apply(GRANT, true).started).toBe(true)
  })
  test('stop ends capture and drops the queue', () => {
    const r = on()
    r.said(MAIN_LOOP, 'a', 1)
    r.stop()
    expect(r.capturing).toBe(false)
    expect(r.closing).toBe(false)
    expect(r.queued).toBe(0)
  })
})

describe('terminal texts', () => {
  const at = new Date(2026, 9, 20, 11, 42).getTime()
  const now = new Date(2026, 9, 20, 12, 0).getTime()
  const later = new Date(2026, 9, 20, 17, 42).getTime()
  test('timeWithDay', () => {
    expect(timeWithDay(later, now)).toBe('17:42 today')
    expect(timeWithDay(new Date(2026, 9, 21, 9, 5).getTime(), now)).toBe('09:05 on 2026-10-21')
  })
  test('clockOn', () => {
    expect(clockOn(at, now)).toBe('11:42')
    expect(clockOn(new Date(2026, 9, 19, 23, 59).getTime(), now)).toBe('23:59 on 2026-10-19')
  })
  test('start', () => {
    expect(startLine(grant({ startedBy: 'Maya Okafor', startedAt: at, keptUntil: later }), now)).toBe(
      'This session is being recorded by Maya Okafor, from 11:42. The whole history of this orchestrator and every agent and fork under it is kept in Podium for troubleshooting, and is deleted at 17:42 today. Either of you can stop it from Podium. To refuse recording on this machine, set sessionRecording to off in /plugin configure.',
    )
  })
  test('start without names or times', () => {
    const t = startLine(grant({ startedBy: null, startedAt: null, keptUntil: null }), now)
    expect(t).toContain('recorded by Podium, from now.')
    expect(t).toContain('and is deleted when its retention runs out.')
  })
  test('stopped', () => {
    expect(stoppedLine(grant({ state: 'stopped', stoppedBy: 'Maya Okafor', stoppedAt: at, keptUntil: later }), now)).toBe('Recording stopped by Maya Okafor at 11:42. What was recorded until then is kept until 17:42 today.')
    expect(stoppedLine(grant({ state: 'stopped', stoppedBy: null, stoppedAt: null, keptUntil: null }), now)).toBe('Recording stopped by Podium at an unknown time. What was recorded until then is kept until its retention runs out.')
  })
  test('limit', () => {
    expect(limitLine(grant({ state: 'limit', limit: 'session', bytes: 256 * 1_048_576 + 400_000 }))).toBe('Recording stopped: this session reached its 256 MB limit. Nothing after this point is kept.')
    expect(limitLine(grant({ state: 'limit', limit: 'budget' }))).toBe("Recording stopped: this session reached the server's disk budget. Nothing after this point is kept.")
  })
  test('refused', () => {
    expect(refusedLine(grant({ startedBy: 'Admin' }))).toBe('Admin chose to record this session, but sessionRecording is off here, so nothing is recorded.')
    expect(refusedLine(grant({ startedBy: null }))).toBe('Someone chose to record this session, but sessionRecording is off here, so nothing is recorded.')
  })
})
