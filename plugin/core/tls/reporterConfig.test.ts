import { describe, test, expect } from 'claude-code/testing'
import { configNamesNewestFirst, nameEpoch, parseConfigHeaders, podiumHome, resolveHome } from './reporterConfig.ts'

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
    expect(parseConfigHeaders(file('Dana', 1).replace('https://podium.local:3443', 'podium.local'))).toBeNull()
  })

  test('the epoch is the number at the end of the name (#607)', () => {
    expect(nameEpoch('reporter-config-Dana-1770000000.pem')).toBe(1770000000)
    expect(nameEpoch('reporter-config-Dana-Lee-5.pem')).toBe(5)
    expect(nameEpoch('reporter-config-Dana-copy.pem')).toBeNull()
    expect(nameEpoch('reporter-config-.pem')).toBeNull()
    expect(nameEpoch('notes-5.pem')).toBeNull()
  })

  test('names are tried newest epoch first, names with no epoch last, and other files are ignored (#607)', () => {
    expect(configNamesNewestFirst(['reporter-config-D-5.pem', 'notes.pem', 'reporter-config-D-copy.pem', 'reporter-config-D-300.pem', 'reporter-config-A-copy.pem', 'reporter-config-D-70.pem'])).toEqual([
      'reporter-config-D-300.pem',
      'reporter-config-D-70.pem',
      'reporter-config-D-5.pem',
      'reporter-config-A-copy.pem',
      'reporter-config-D-copy.pem',
    ])
    expect(configNamesNewestFirst([])).toEqual([])
  })

  test('the Podium folder is under the home folder', () => {
    expect(podiumHome('/home/dana')).toBe('/home/dana/.podium')
    expect(podiumHome('/home/dana/')).toBe('/home/dana/.podium')
  })

  test('the home folder is HOME, else USERPROFILE, else HOMEDRIVE plus HOMEPATH (#834)', () => {
    expect(resolveHome({ HOME: '/home/dana', USERPROFILE: 'C:\\Users\\dana' })).toEqual({ home: '/home/dana', from: 'HOME' })
    expect(resolveHome({ USERPROFILE: 'C:\\Users\\dana' })).toEqual({ home: 'C:\\Users\\dana', from: 'USERPROFILE' })
    expect(resolveHome({ HOME: '', USERPROFILE: 'C:\\Users\\dana' })).toEqual({ home: 'C:\\Users\\dana', from: 'USERPROFILE' })
    expect(resolveHome({ HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\dana' })).toEqual({ home: 'C:\\Users\\dana', from: 'HOMEDRIVE+HOMEPATH' })
    expect(resolveHome({ HOMEDRIVE: 'C:' })).toEqual({ home: undefined, from: undefined })
    expect(resolveHome({})).toEqual({ home: undefined, from: undefined })
  })

  test('a Windows home with a trailing backslash gives the Podium folder under it (#834)', () => {
    expect(podiumHome('C:\\Users\\dana\\')).toBe('C:\\Users\\dana/.podium')
    expect(podiumHome('C:\\Users\\dana')).toBe('C:\\Users\\dana/.podium')
  })
})

// S8786: `/\/+$/` took 3.4 s on 100000 slashes and a final character (quadratic); string methods take well under a millisecond.
const ms = (run: () => void): number => {
  const t = performance.now()
  run()
  return performance.now() - t
}

describe('long runs of one character (S8786)', () => {
  test('a folder name made of a long run of slashes is trimmed in linear time', () => {
    const slashes = `${'/'.repeat(100000)}x`
    expect(ms(() => podiumHome(slashes))).toBeLessThan(250)
    expect(podiumHome('/home/dana//')).toBe('/home/dana/.podium')
  })

  test('a header line with a long run of blanks is read in linear time, and headers keep their meaning', () => {
    const long = ['# podium-reporter-config v1', `#${' '.repeat(100000)}x`, '#   user:   Dana Lee  ', '# server: https://podium.lan:4318', '# issued-at: t 1700000000', '# Bad Key: ignored', '#:nope', '# user: second wins nothing']
    const t = ms(() => parseConfigHeaders(long.join('\n')))
    expect(t).toBeLessThan(250)
    const h = parseConfigHeaders(long.join('\n'))
    expect(h?.user).toBe('Dana Lee')
    expect(h?.server).toBe('https://podium.lan:4318')
  })
})

