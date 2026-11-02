import { describe, test, expect } from 'claude-code/testing'
import { appTitleOf, readAppTitle, type Runner } from './agentName.ts'

const LIST = JSON.stringify([
  { pid: 1, sessionId: 'aaa', name: 'First' },
  { pid: 2, sessionId: 'bbb', name: '  Second one  ' },
  { pid: 3, sessionId: 'ccc' },
])

describe('agentName', () => {
  test('takes the trimmed name of the entry whose sessionId matches (#595)', () => {
    expect(appTitleOf(LIST, 'bbb')).toBe('Second one')
    expect(appTitleOf(LIST, 'aaa')).toBe('First')
  })

  test('no match, no name, or an unusable list gives null', () => {
    expect(appTitleOf(LIST, 'zzz')).toBeNull()
    expect(appTitleOf(LIST, 'ccc')).toBeNull()
    expect(appTitleOf('not json', 'aaa')).toBeNull()
    expect(appTitleOf('{"sessionId":"aaa","name":"x"}', 'aaa')).toBeNull()
    expect(appTitleOf('[null, 3, {"sessionId":"aaa","name":"   "}]', 'aaa')).toBeNull()
  })

  test('a name is clipped to 80 characters', () => {
    expect(appTitleOf(JSON.stringify([{ sessionId: 'a', name: 'x'.repeat(100) }]), 'a')).toBe('x'.repeat(80))
  })

  test('readAppTitle runs `claude agents --json`; a failed or missing command gives null', async () => {
    const seen: string[][] = []
    const ok: Runner = async (argv) => {
      seen.push(argv)
      return { exitCode: 0, stdout: LIST }
    }
    expect(await readAppTitle(ok, 'bbb')).toBe('Second one')
    expect(seen).toEqual([['claude', 'agents', '--json']])
    expect(await readAppTitle(async () => ({ exitCode: 1, stdout: LIST }), 'bbb')).toBeNull()
    expect(
      await readAppTitle(async () => {
        throw new Error('no claude on the PATH')
      }, 'bbb'),
    ).toBeNull()
  })
})
