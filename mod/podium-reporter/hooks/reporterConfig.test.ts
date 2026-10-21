import { describe, test, expect } from 'claude-code/testing'
import { newestConfig, parseConfigHeaders, podiumHome, socketPathFor, SOCKET_PATH_MAX, utf8Length } from './reporterConfig.ts'

const file = (user: string, issued: number, extra = '') =>
  [
    '# podium-reporter-config v1',
    `# user: ${user}`,
    '# server: https://podium.local:3443',
    `# issued-at: ${new Date(issued * 1000).toISOString()} ${issued}`,
    '# expires: 2026-04-01T00:00:00.000Z',
    '# fingerprint: AB:CD',
    extra,
    '-----BEGIN CERTIFICATE-----',
    'MIIB',
    '-----END CERTIFICATE-----',
  ].join('\n')

describe('the reporter config file (#584, SPEC 5.9)', () => {
  test('headers are read by name, and one it does not know is ignored', () => {
    const h = parseConfigHeaders(file('Dana Lee', 1767225600, '# future-key: whatever'))
    expect(h).toEqual({ user: 'Dana Lee', server: 'https://podium.local:3443', issuedAt: 1767225600, expires: '2026-04-01T00:00:00.000Z', fingerprint: 'AB:CD' })
  })

  test('a file that does not start with the version line is not a config', () => {
    expect(parseConfigHeaders(file('Dana', 1).replace('# podium-reporter-config v1', '# something else'))).toBeNull()
    expect(parseConfigHeaders('')).toBeNull()
  })

  test('a file with no user, no server or no issued-at is refused', () => {
    expect(parseConfigHeaders(file('Dana', 1).replace('# user: Dana\n', ''))).toBeNull()
    expect(parseConfigHeaders(file('Dana', 1).replace('# server: https://podium.local:3443\n', ''))).toBeNull()
    expect(parseConfigHeaders(file('Dana', 1).replace(/# issued-at: .*\n/, ''))).toBeNull()
  })

  test('a server address that is not https is refused: a credential never goes over http', () => {
    expect(parseConfigHeaders(file('Dana', 1).replace('https://', 'http://'))).toBeNull()
  })

  test('the newest by issued-at wins, whatever the names say, and other files are ignored', () => {
    const picked = newestConfig([
      { path: '/h/reporter-config-Dana-9999999999.pem', text: file('Dana', 100) },
      { path: '/h/reporter-config-Dana-5.pem', text: file('Dana', 300) },
      { path: '/h/reporter-config-Dana-7.pem', text: 'garbage' },
      { path: '/h/notes.pem', text: file('Dana', 900) },
    ])
    expect(picked?.path).toBe('/h/reporter-config-Dana-5.pem')
    expect(picked?.headers.issuedAt).toBe(300)
  })

  test('no file, or none that parses, is no config', () => {
    expect(newestConfig([])).toBeNull()
    expect(newestConfig([{ path: '/h/reporter-config-x-1.pem', text: 'nope' }])).toBeNull()
  })

  test('the Podium folder is under the home folder', () => {
    expect(podiumHome('/home/dana')).toBe('/home/dana/.podium')
    expect(podiumHome('/home/dana/')).toBe('/home/dana/.podium')
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
