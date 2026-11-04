import { describe, test, expect } from 'claude-code/testing'
import { commandDetail, DETAIL_LIMIT, feedOf, outputDetail, stripControl, withinActivityBudget, withinDetailBudget, withinSize, withinTextBudget } from './feed.ts'
import type { ActivityEntry, AgentReport, Report } from './protocol.ts'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'

describe('stripControl (#431)', () => {
  test('removes colour, cursor and OSC sequences and other control characters, keeps line breaks and tabs', () => {
    const raw = `${ESC}[31mred${ESC}[0m\tcol\r\nnext${ESC}]0;title${BEL}${ESC}[2K${ESC}[1;32mok${ESC}[m${String.fromCharCode(0, 8, 127)}end`
    expect(stripControl(raw)).toBe('red\tcol\nnextokend')
  })

  test('removes a string sequence ended by ESC backslash and a lone trailing ESC', () => {
    expect(stripControl(`a${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\b${ESC}`)).toBe('alinkb')
  })

  test('a lone carriage return (a progress bar) is dropped, and C1 controls go', () => {
    expect(stripControl(`10%\r20%\r30%${String.fromCharCode(0x9b)}x`)).toBe('10%20%30%x')
  })

  test('a two-character escape and an unterminated sequence are dropped', () => {
    expect(stripControl(`a${ESC}7b${ESC}[31`)).toBe('ab')
  })

  test('text with nothing to strip comes back as it is', () => {
    expect(stripControl('plain\n\ttext')).toBe('plain\n\ttext')
  })
})

describe('commandDetail (#431)', () => {
  test('keeps line breaks and redacts a secret', () => {
    const d = commandDetail(`curl -H "x-api-key: ${SECRET}" \\\n  http://x\necho done`)
    expect(d.cut).toBe(false)
    expect(d.text).toContain('\n  http://x\necho done')
    expect(d.text).not.toContain(SECRET)
    expect(d.text).toContain('[redacted]')
  })

  test('redacts a secret in a command longer than 1,000 characters, past the bounded pieces', () => {
    const d = commandDetail(`${'echo hello world '.repeat(200)}\nexport API_TOKEN=${SECRET}\n${'echo again '.repeat(200)}`)
    expect(d.text).not.toContain(SECRET)
    expect(d.text).toContain('[redacted]')
    expect(d.cut).toBe(false)
  })

  test('cuts at 20,000 characters with the visible marker', () => {
    const d = commandDetail('x'.repeat(DETAIL_LIMIT + 500))
    expect(d.cut).toBe(true)
    expect(d.text).toBe(`${'x'.repeat(DETAIL_LIMIT)}\n\n[cut off at 20,000 characters]`)
  })

  test('strips control characters from a command', () => {
    expect(commandDetail(`ls ${ESC}[31m-la${ESC}[0m`).text).toBe('ls -la')
  })
})

describe('outputDetail (#431)', () => {
  test('redacts an env-dump line and a bare token, and keeps the other lines', () => {
    const d = outputDetail(`HOME=/Users/x\nANTHROPIC_API_KEY=${SECRET}\nGITHUB_TOKEN=ghp_${'a1B2'.repeat(10)}\nPATH=/usr/bin\n`)
    expect(d.text).not.toContain(SECRET)
    expect(d.text).not.toContain('ghp_a1B2')
    expect(d.text).toContain('HOME=/Users/x')
    expect(d.text).toContain('PATH=/usr/bin')
  })

  test('redacts in an output longer than 1,000 characters', () => {
    const d = outputDetail(`${'line of output '.repeat(100)}\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n${SECRET}\n${'tail '.repeat(300)}`)
    expect(d.text).not.toContain('wJalrXUtnFEMI')
    expect(d.text).not.toContain(SECRET)
  })

  test('strips ANSI before redacting, so a coloured secret is still caught', () => {
    const d = outputDetail(`${ESC}[32mtoken=${ESC}[0m${SECRET}`)
    expect(d.text).not.toContain(SECRET)
    expect(d.text).not.toContain(ESC)
  })

  test('cuts at 20,000 characters with the marker and says so', () => {
    const d = outputDetail('y'.repeat(30_000))
    expect(d.cut).toBe(true)
    expect(d.text.endsWith('\n\n[cut off at 20,000 characters]')).toBe(true)
    expect(d.text).toHaveLength(DETAIL_LIMIT + '\n\n[cut off at 20,000 characters]'.length)
  })

  test('output that printed nothing is an empty string, not cut', () => {
    expect(outputDetail('')).toEqual({ text: '', cut: false })
  })
})


describe('a feed as a report carries it (#969)', () => {
  const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({ at: 1, kind: 'tool', text: 'Bash ls', ...over })
  const report = (session: Partial<Report['session']>, agents: Partial<AgentReport>[] = []): Report => ({ session: { ...session }, agents }) as unknown as Report

  test('feedOf redacts the summary, keeps the call fields, and leaves the output out unless asked', () => {
    const list = [
      entry({ text: `Bash echo ${SECRET}`, id: 'c1', command: 'ls', commandCut: true, output: 'out', outputCut: true, done: true, failed: true, exitCode: 2 }),
      { at: 2, kind: 'text' as const, text: 'said', id: 'ignored', command: 'ignored' },
    ]
    const bare = feedOf(list, false)
    expect(bare[0]).toEqual({ at: 1, kind: 'tool', text: 'Bash echo [redacted]', id: 'c1', command: 'ls', commandCut: true, done: true, failed: true, exitCode: 2 })
    expect(bare[1]).toEqual({ at: 2, kind: 'text', text: 'said' })
    expect(feedOf(list, true)[0]).toMatchObject({ output: 'out', outputCut: true })
    expect(feedOf([entry({ command: 'x'.repeat(30_000) })], false)[0]!.command).toHaveLength(20_100)
    expect(feedOf([entry({ output: 'y'.repeat(30_000) })], true)[0]!.output).toHaveLength(20_100)
  })

  test('withinTextBudget keeps the first text whole and drops one that no longer fits', () => {
    const big = 'a'.repeat(100_000)
    const out = withinTextBudget([{ id: '1', promptText: big, answerText: 'short' }, { id: '2', promptText: big, answerText: 'b' }, { id: '3', answerText: 'c' }] as AgentReport[])
    expect(out.map((a) => [a.promptText?.length, a.answerText])).toEqual([[100_000, 'short'], [undefined, 'b'], [undefined, 'c']])
    expect(withinTextBudget([{ id: '1', promptText: 'x'.repeat(130_000) }] as AgentReport[])[0]!.promptText).toHaveLength(130_000)
  })

  test('withinActivityBudget drops the feeds past 60,000 characters of summaries, the orchestrator first', () => {
    const long = (n: number) => [entry({ text: 'x'.repeat(n) })]
    const r = withinActivityBudget(report({ activity: long(40_000) }, [{ activity: long(30_000) }, { activity: long(10_000) }]))
    expect(r.session.activity).toHaveLength(1)
    expect(r.agents[0]!.activity).toBeUndefined()
    expect(r.agents[1]!.activity).toHaveLength(1)
  })

  test('withinDetailBudget takes the output off the entries that do not fit, then the command, newest first', () => {
    const e1 = entry({ command: 'c'.repeat(100_000), output: 'o'.repeat(50_000), commandCut: true, outputCut: true })
    const e2 = entry({ command: 'c'.repeat(40_000), output: 'o'.repeat(40_000) })
    const e3 = entry({ command: 'c'.repeat(30_000), output: 'o'.repeat(30_000) })
    withinDetailBudget(report({ activity: [e1, e2, e3] }))
    // e3 (60,000) and e2 (80,000) fit in 200,000; e1's 150,000 does not: its output goes, then its command (100,000 over the 60,000 left).
    expect(e3.output).toBeDefined()
    expect(e2.output).toBeDefined()
    expect(e1).not.toHaveProperty('output')
    expect(e1).not.toHaveProperty('outputCut')
    expect(e1).not.toHaveProperty('command')
    expect(e1).not.toHaveProperty('commandCut')
  })

  test('withinSize cuts output, then commands, until the body fits, counting bytes not characters', () => {
    const wide = '€'.repeat(100_000)
    const mk = () => entry({ command: wide, output: wide })
    const small = report({ activity: [entry()] })
    withinSize(small)
    expect(small.session.activity).toHaveLength(1)
    const a = mk()
    const b = mk()
    const r = report({ activity: [a] }, [{ activity: [b] }])
    withinSize(r)
    expect(JSON.stringify(r).length).toBeLessThan(480_000)
    expect(b).not.toHaveProperty('output')
    const nothing = report({})
    withinSize(nothing)
    expect(nothing.session).toEqual({})
    // Output alone is not enough here: the commands go too, oldest of the last feed first.
    const d1 = entry({ command: wide })
    const d2 = entry({ command: wide })
    const d3 = entry({ command: wide })
    withinSize(report({ activity: [d1, d2, d3] }))
    expect([d1, d2, d3].filter((e) => 'command' in e)).toEqual([d3])
    expect(d1).not.toHaveProperty('command')
  })
})
