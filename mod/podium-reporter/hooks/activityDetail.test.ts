import { describe, test, expect } from 'claude-code/testing'
import { activityEntry, bashOutput, finishedCall, commandDetail, DETAIL_LIMIT, exitStatus, outputDetail, stripControl } from './activityDetail.ts'

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

describe('bashOutput and exitStatus (#431)', () => {
  test('stdout then stderr from the result record, joined by a line break', () => {
    expect(bashOutput({ result: { stdout: 'out', stderr: 'err' }, text: 'ignored' })).toBe('out\nerr')
    expect(bashOutput({ result: { stdout: 'out\n', stderr: 'err' } })).toBe('out\nerr')
    expect(bashOutput({ result: { stdout: '', stderr: 'err' } })).toBe('err')
    expect(bashOutput({ result: { stdout: 'out', stderr: '' } })).toBe('out')
    expect(bashOutput({ result: { stdout: '', stderr: '' } })).toBe('')
  })

  test('the text the model reads when the result is not a record', () => {
    expect(bashOutput({ isError: true, result: 'Exit code 1\nFAIL', text: 'Exit code 1\nFAIL' })).toBe('FAIL')
    expect(bashOutput({ isError: true, text: 'Exit code 2' })).toBe('')
    expect(bashOutput({ isError: true, text: 'Error: it broke' })).toBe('Error: it broke')
    expect(bashOutput({ text: 'Exit code 3\nnot an error result' })).toBe('Exit code 3\nnot an error result')
    expect(bashOutput({ text: 'from text' })).toBe('from text')
    expect(bashOutput({ result: 'from result' })).toBe('from result')
  })

  test('a denied call prints the denial; a result with nothing to read is null', () => {
    expect(bashOutput({ deny: 'not allowed' })).toBe('not allowed')
    expect(bashOutput({})).toBeNull()
    expect(bashOutput({ result: { ok: true } })).toBeNull()
  })

  test('failed comes from isError or a denial, the exit code only from text that says it', () => {
    expect(exitStatus({ result: { stdout: 'x', stderr: '' } })).toEqual({ failed: false })
    expect(exitStatus({ isError: true, text: 'Exit code 2\nboom' })).toEqual({ failed: true, exitCode: 2 })
    expect(exitStatus({ isError: true, text: 'no code here' })).toEqual({ failed: true })
    expect(exitStatus({ deny: 'nope' })).toEqual({ failed: true })
    expect(exitStatus({ isError: true, result: 'Exit code 127\nnot found' })).toEqual({ failed: true, exitCode: 127 })
  })
})

describe('activityEntry and finishedCall (#431)', () => {
  test('a Bash call carries its id and command; a cut command says so; any other tool is the plain summary', () => {
    expect(activityEntry('Bash', { command: 'ls -la' }, 'tu1', 5)).toEqual({ at: 5, kind: 'tool', text: 'Bash ls -la', id: 'tu1', command: 'ls -la' })
    expect(activityEntry('Bash', { command: 'ls' }, undefined, 5)).toEqual({ at: 5, kind: 'tool', text: 'Bash ls', command: 'ls' })
    expect(activityEntry('Bash', {}, 'tu1', 5)).toEqual({ at: 5, kind: 'tool', text: 'Bash', id: 'tu1' })
    expect(activityEntry('Bash', { command: 'q'.repeat(21_000) }, 'tu1', 5).commandCut).toBe(true)
    expect(activityEntry('Read', { file_path: '/x' }, 'tu1', 5)).toEqual({ at: 5, kind: 'tool', text: 'Read /x' })
  })

  test('a finished call adds its output, done and what failed; a result with nothing to read is still done', () => {
    expect(finishedCall({ result: { stdout: 'hi', stderr: '' } }, true)).toEqual({ output: 'hi', done: true })
    expect(finishedCall({ isError: true, text: 'Exit code 3\nboom' }, true)).toEqual({ output: 'boom', done: true, failed: true, exitCode: 3 })
    expect(finishedCall({ text: 'y'.repeat(21_000) }, true).outputCut).toBe(true)
    expect(finishedCall({}, true)).toEqual({ done: true })
  })

  test('without output a finished call is done, failed and exitCode only, and none of its text is kept (#598)', () => {
    const SECRET = 'sk-live-STATUS-ONLY-1234'
    expect(finishedCall({ result: { stdout: `TOKEN=${SECRET}`, stderr: '' } }, false)).toEqual({ done: true })
    expect(finishedCall({}, false)).toEqual({ done: true })
    const failed = finishedCall({ isError: true, text: `Exit code 3\nTOKEN=${SECRET}` }, false)
    expect(failed).toEqual({ done: true, failed: true, exitCode: 3 })
    expect(JSON.stringify(failed)).not.toContain(SECRET)
    expect(finishedCall({ isError: true, text: 'no code' }, false)).toEqual({ done: true, failed: true })
    expect(finishedCall({ deny: `no ${SECRET}` }, false)).toEqual({ done: true, failed: true })
  })
})
