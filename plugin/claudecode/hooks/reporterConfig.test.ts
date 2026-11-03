import { describe, test, expect } from 'claude-code/testing'
import { decodeBase64Utf8, isWindowsPath, mailboxDirFor, socketPathFor, SOCKET_PATH_MAX, utf8Length } from './reporterConfig.ts'

// The config file's headers, names and home folder are tested where they live, in plugin/core/tls/reporterConfig.test.ts.
describe('the Claude reporter\'s socket and mailbox paths (#584, #834)', () => {
  test('a drive path or a UNC path is a Windows path, a POSIX path is not (#834)', () => {
    expect(isWindowsPath('C:\\Users\\dana\\.podium\\a.pem')).toBe(true)
    expect(isWindowsPath('d:/x')).toBe(true)
    expect(isWindowsPath('\\\\server\\share\\a')).toBe(true)
    expect(isWindowsPath('/home/dana/a.pem')).toBe(false)
    expect(isWindowsPath('relative/a.pem')).toBe(false)
  })

  test('base64 is decoded as UTF-8 without Buffer or atob (#834)', () => {
    const cases: Array<[string, string]> = [
      ["", ""],
      ["a", "YQ=="],
      ["ab", "YWI="],
      ["abc", "YWJj"],
      ["{\"status\":200,\"body\":\"é€😀 ok\"}", "eyJzdGF0dXMiOjIwMCwiYm9keSI6IsOp4oKs8J+YgCBvayJ9"],
    ]
    for (const [text, b64] of cases) expect(decodeBase64Utf8(b64)).toBe(text)
    expect(decodeBase64Utf8('YWI')).toBe('ab')
    expect(decodeBase64Utf8(`YQ${'='.repeat(200000)}`)).toBe('a')
    expect(() => decodeBase64Utf8('a')).toThrow()
    expect(() => decodeBase64Utf8('ab!d')).toThrow()
    expect(() => decodeBase64Utf8('/w==')).toThrow()
  })

  test('each session gets its own mailbox folder under the run folder (#834)', () => {
    const a = mailboxDirFor('C:\\Users\\dana/.podium/run/', 'sess-1')
    expect(a).toMatch(/^C:\\Users\\dana\/\.podium\/run\/[0-9a-f]{8}$/)
    expect(mailboxDirFor('C:\\Users\\dana/.podium/run', 'sess-1')).toBe(a)
    expect(mailboxDirFor('C:\\Users\\dana/.podium/run', 'sess-2')).not.toBe(a)
  })

  test('a socket path stays under the macOS limit even for a long session id', () => {
    const p = socketPathFor('/var/folders/zz/abcdefghijklmnopqrstuvwxyz0123456789/T/podium-helper-abc123', 'a'.repeat(80))
    expect(p.length).toBeLessThan(SOCKET_PATH_MAX)
    expect(p.startsWith('/var/folders/')).toBe(true)
  })

  test('a path is measured in bytes, so a home folder with accents or an emoji counts for more than its characters', () => {
    expect(utf8Length('/Users/dana')).toBe(11)
    expect(utf8Length('/Users/josé')).toBe(12)
    expect(utf8Length('/Users/日本')).toBe(13)
    expect(utf8Length('/Users/😀')).toBe(11)
  })
})

// S8786: `/\/+$/` took 3.4 s on 100000 slashes and a final character (quadratic); string methods take well under a millisecond.
describe('long runs of one character (S8786)', () => {
  test('a folder name made of a long run of slashes is trimmed in linear time', () => {
    const slashes = `${'/'.repeat(100000)}x`
    const t = performance.now()
    socketPathFor(slashes, 'id')
    expect(performance.now() - t).toBeLessThan(250)
    expect(socketPathFor('/run///', 'id').startsWith('/run/')).toBe(true)
  })
})
