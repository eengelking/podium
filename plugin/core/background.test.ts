import { describe, test, expect } from 'claude-code/testing'
import {
  BACKGROUND_CUT_MARKER,
  BACKGROUND_DETAIL_CHARS_PER_REPORT,
  BACKGROUND_DETAIL_LIMIT,
  BACKGROUND_KEPT_FINISHED,
  BACKGROUND_MAX_ITEMS,
  BACKGROUND_TAIL_BYTES,
  backgroundItem,
  exitCodeOf,
  keepBackground,
  labelOf,
  outputTimes,
  readTail,
  WHOLE_FILE_MAX_BYTES,
  withinBackgroundBudget,
  type OutputFs,
  type OutputStat,
  type RawBackgroundItem,
} from './background.ts'
import type { BackgroundItem, Report } from './protocol.ts'

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'
const T0 = 1_791_648_000_000

const raw = (over: Partial<RawBackgroundItem> = {}): RawBackgroundItem => ({ id: 'b1', kind: 'shell', state: 'running', startedAt: T0, startedKnown: false, ...over })
const done = (id: string, startedAt: number): BackgroundItem => ({ id, kind: 'shell', state: 'exited', startedAt, startedKnown: false, label: 'x' })
const live = (id: string, startedAt: number): BackgroundItem => ({ id, kind: 'shell', state: 'running', startedAt, startedKnown: false, label: 'x' })

describe('the label (#897)', () => {
  test('is the first word that is not an assignment, without its folder, so an inline secret is never the label', () => {
    expect(labelOf('API_KEY=abc ./scripts/seed.sh --rows 5', 'shell')).toBe('seed.sh')
    expect(labelOf('  npm run test', 'shell')).toBe('npm')
    expect(labelOf(undefined, 'monitor')).toBe('monitor')
    expect(labelOf('FOO=1', 'shell')).toBe('shell')
  })

  test('is redacted and cut', () => {
    expect(labelOf(SECRET, 'shell')).toBe('[redacted]')
    expect(labelOf('x'.repeat(500), 'shell')).toHaveLength(80)
  })
})

describe('an item as a report carries it (#897)', () => {
  test('without detail, holds the label and the times and nothing of the command or the output', () => {
    const item = backgroundItem(raw({ command: `curl -H "Authorization: Bearer ${SECRET}" x`, output: `TOKEN=${SECRET}`, lastOutputAt: T0 + 9 }), false)
    expect(item).toEqual({ id: 'b1', kind: 'shell', state: 'running', startedAt: T0, startedKnown: false, label: 'curl', lastOutputAt: T0 + 9 })
  })

  test('with detail, redacts the command and the output and strips terminal codes', () => {
    const esc = String.fromCharCode(27)
    const item = backgroundItem(raw({ command: `echo ${SECRET}`, output: `${esc}[31mred${esc}[0m ${SECRET}\n` }), true)
    expect(item.command).toBe('echo [redacted]')
    expect(item.output).toBe('red [redacted]\n')
    expect(JSON.stringify(item)).not.toContain(SECRET)
  })

  test('cuts a long command at its end and a long output at its start, each with a visible marker', () => {
    const long = 'a'.repeat(BACKGROUND_DETAIL_LIMIT + 500)
    const item = backgroundItem(raw({ command: long, output: `${'o'.repeat(BACKGROUND_DETAIL_LIMIT)}NEWEST` }), true)
    expect(item.command!.startsWith('a'.repeat(100))).toBe(true)
    expect(item.command!.endsWith('[cut off at 20,000 characters]')).toBe(true)
    expect(item.commandCut).toBe(true)
    expect(item.output!.startsWith(BACKGROUND_CUT_MARKER)).toBe(true)
    expect(item.output!.endsWith('NEWEST')).toBe(true)
    expect(item.outputCut).toBe(true)
  })

  test('marks an output cut at the front when the file held more than was read', () => {
    const item = backgroundItem(raw({ output: 'tail\n', outputCutAtStart: true }), true)
    expect(item.output).toBe(`${BACKGROUND_CUT_MARKER}tail\n`)
    expect(item.outputCut).toBe(true)
  })

  test('keeps an empty output as an empty string, an item that printed nothing', () => {
    expect(backgroundItem(raw({ output: '' }), true).output).toBe('')
  })

  test('carries an exit code only on an item that exited, and none for one that ended without one', () => {
    expect(backgroundItem(raw({ state: 'exited', exitCode: 2 }), false).exitCode).toBe(2)
    expect(backgroundItem(raw({ state: 'running', exitCode: 2 }), false)).not.toHaveProperty('exitCode')
    expect(backgroundItem(raw({ state: 'exited' }), false)).not.toHaveProperty('exitCode')
  })
})

describe('which items a loop keeps (#897)', () => {
  test('keeps every running item and the 20 latest finished ones, oldest first', () => {
    const items = [...Array.from({ length: 30 }, (_, i) => done(`d${i}`, T0 + i)), live('r1', T0 - 1000), live('r2', T0 + 500)]
    const kept = keepBackground(items)
    expect(kept.filter((i) => i.state === 'exited')).toHaveLength(BACKGROUND_KEPT_FINISHED)
    expect(kept.filter((i) => i.state === 'running').map((i) => i.id)).toEqual(['r1', 'r2'])
    expect(kept.map((i) => i.startedAt)).toEqual([...kept.map((i) => i.startedAt)].sort((a, b) => a - b))
    expect(kept.find((i) => i.id === 'd9')).toBeUndefined()
    expect(kept.find((i) => i.id === 'd10')).toBeDefined()
  })

  test('never passes the most the server takes', () => {
    const kept = keepBackground(Array.from({ length: 100 }, (_, i) => live(`r${i}`, T0 + i)))
    expect(kept).toHaveLength(BACKGROUND_MAX_ITEMS)
    expect(kept[kept.length - 1]!.id).toBe('r99')
  })
})

describe('the report budget (#897)', () => {
  const big = (id: string) => ({ ...live(id, T0), command: 'c'.repeat(20_000), output: 'o'.repeat(20_000) })
  const report = (session: BackgroundItem[], agent: BackgroundItem[]) => ({ session: { backgroundItems: session }, agents: [{ backgroundItems: agent }] }) as unknown as Report

  test('keeps the newest items inside 200,000 characters and drops output before command', () => {
    const r = withinBackgroundBudget(report(Array.from({ length: 4 }, (_, i) => big(`s${i}`)), Array.from({ length: 4 }, (_, i) => big(`a${i}`))))
    const all = [...r.session.backgroundItems!, ...r.agents[0]!.backgroundItems!]
    expect(all.reduce((n, i) => n + (i.command?.length ?? 0) + (i.output?.length ?? 0), 0)).toBeLessThanOrEqual(BACKGROUND_DETAIL_CHARS_PER_REPORT)
    expect(r.session.backgroundItems![3]).toHaveProperty('output')
    expect(r.agents[0]!.backgroundItems![0]).not.toHaveProperty('output')
    expect(r.agents[0]!.backgroundItems![0]).toHaveProperty('label')
  })
})

type Entry = { kind: 'file' | 'dir' | 'other'; text?: string; size?: number; mtimeMs?: number; link?: string }

/** A file system in memory with the shape of the host's: a path may be a link, and `realPath` is where it lands. */
function fakeFs(files: Record<string, Entry>, tail = false): OutputFs {
  const norm = (p: string): string => {
    const out: string[] = []
    for (const part of p.split('/')) {
      if (part === '..') out.pop()
      else if (part !== '' && part !== '.') out.push(part)
    }
    return '/' + out.join('/')
  }
  const stat = async (p: string, options?: { resolve?: boolean }): Promise<OutputStat> => {
    const path = norm(p)
    const e = files[path]
    if (!e) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    const target = e.link ? files[norm(e.link)] : e
    return {
      kind: target?.kind ?? 'other',
      size: target?.size ?? target?.text?.length ?? 0,
      mtimeMs: target?.mtimeMs ?? 0,
      isLink: !!e.link,
      ...(options?.resolve && target ? { realPath: e.link ? norm(e.link) : path } : {}),
    }
  }
  const text = (p: string) => files[norm(p)]?.text ?? ''
  return {
    stat,
    read: async (p) => text(p),
    ...(tail ? { tail: async (p: string, bytes: number) => text(p).slice(-bytes) } : {}),
  }
}

describe('reading an output file (#897)', () => {
  const files: Record<string, Entry> = {
    '/tmp/s/tasks': { kind: 'dir' },
    '/tmp/s/tasks/a.output': { kind: 'file', text: 'hello\nworld\n', mtimeMs: 7000 },
    '/tmp/s/tasks/empty.output': { kind: 'file', text: '', mtimeMs: 1 },
    '/tmp/s/tasks/in-link.output': { kind: 'other', link: '/tmp/s/tasks/a.output' },
    '/tmp/s/tasks/out-link.output': { kind: 'other', link: '/tmp/s/transcript.jsonl' },
    '/tmp/s/tasks/sub': { kind: 'dir' },
    '/tmp/s/transcript.jsonl': { kind: 'file', text: 'secret' },
    '/tmp/s/outside.txt': { kind: 'file', text: 'secret' },
    '/tmp/s/tasks/big.output': { kind: 'file', text: 'é'.repeat(BACKGROUND_TAIL_BYTES + 10), mtimeMs: 9 },
    '/tmp/s/tasks/huge.output': { kind: 'file', text: 'x', size: WHOLE_FILE_MAX_BYTES + 1, mtimeMs: 9 },
  }
  const dir = '/tmp/s/tasks'

  test('reads a small file whole, with its time and size', async () => {
    expect(await readTail(fakeFs(files), `${dir}/a.output`, dir)).toEqual({ ok: true, text: 'hello\nworld\n', cutAtStart: false, mtimeMs: 7000, size: 12 })
  })

  test('reads an empty file as an empty text', async () => {
    expect(await readTail(fakeFs(files), `${dir}/empty.output`, dir)).toMatchObject({ ok: true, text: '', cutAtStart: false, size: 0 })
  })

  test('reads only the tail of a large file and says it cut the front, with or without a host that reads part of a file', async () => {
    for (const tail of [false, true]) {
      const r = await readTail(fakeFs(files, tail), `${dir}/big.output`, dir)
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.cutAtStart).toBe(true)
      expect(r.text.length).toBeLessThanOrEqual(BACKGROUND_TAIL_BYTES)
    }
  })

  test('refuses a path outside the folder, including one that climbs out with ..', async () => {
    expect(await readTail(fakeFs(files), '/tmp/s/outside.txt', dir)).toEqual({ ok: false, reason: 'outside' })
    expect(await readTail(fakeFs(files), `${dir}/../outside.txt`, dir)).toEqual({ ok: false, reason: 'outside' })
  })

  test('refuses a link, whether it points out of the folder or into it, and a folder', async () => {
    for (const name of ['in-link.output', 'out-link.output', 'sub']) expect(await readTail(fakeFs(files), `${dir}/${name}`, dir)).toEqual({ ok: false, reason: 'not-a-file' })
  })

  test('says a missing file is missing and a folder that is gone is not a place to read from, and never throws', async () => {
    expect(await readTail(fakeFs(files), `${dir}/gone.output`, dir)).toEqual({ ok: false, reason: 'missing' })
    expect(await readTail(fakeFs(files), `${dir}/a.output`, '/tmp/s/no-such-folder')).toEqual({ ok: false, reason: 'missing' })
    const broken: OutputFs = { stat: async () => { throw new Error('EACCES') }, read: async () => '' }
    expect(await readTail(broken, `${dir}/a.output`, dir)).toEqual({ ok: false, reason: 'unreadable' })
  })

  test('says a file too large for a host that cannot read part of a file is too large, and reads it where it can', async () => {
    expect(await readTail(fakeFs(files), `${dir}/huge.output`, dir)).toEqual({ ok: false, reason: 'too-large' })
    expect(await readTail(fakeFs(files, true), `${dir}/huge.output`, dir)).toMatchObject({ ok: true, cutAtStart: true })
  })

  test('reports a file’s time and size without reading it, under the same rules', async () => {
    expect(await outputTimes(fakeFs(files), `${dir}/a.output`, dir)).toEqual({ ok: true, mtimeMs: 7000, size: 12 })
    expect(await outputTimes(fakeFs(files), '/tmp/s/outside.txt', dir)).toEqual({ ok: false, reason: 'outside' })
    expect(await outputTimes(fakeFs(files), `${dir}/gone.output`, dir)).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('the exit code a Claude Code output file ends with (#897)', () => {
  test('reads the trailing marker and nothing else', () => {
    expect(exitCodeOf('done\n[exited with code 0]\n')).toBe(0)
    expect(exitCodeOf('ERROR\n[exited with code 2]')).toBe(2)
    expect(exitCodeOf('[exited with code -1]')).toBe(-1)
    expect(exitCodeOf('[exited with code 3]\nmore output')).toBeNull()
    expect(exitCodeOf('still running')).toBeNull()
  })
})
