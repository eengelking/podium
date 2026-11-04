import { describe, test, expect } from 'claude-code/testing'
import { commandDetail, DETAIL_LIMIT, outputDetail, stripControl } from './feed.ts'

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

