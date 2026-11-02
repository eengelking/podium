import { describe, test, expect } from 'claude-code/testing'
import { cleanOs, hostOf, isMachineId, trimTrailingSlashes, machineIdPath, machineInfo, newMachineId, platformRandom, osFromOsRelease, osFromSwVers, osFromVer, parseMachineIdFile, machineNamePath, parseMachineNameFile, localHostNameOf } from './machine.ts'

describe('machine', () => {
  test('trailing slashes are dropped from a URL, in linear time (#362)', () => {
    expect(trimTrailingSlashes('http://h:1///')).toBe('http://h:1')
    expect(trimTrailingSlashes('http://h:1')).toBe('http://h:1')
    expect(trimTrailingSlashes('///')).toBe('')
    expect(trimTrailingSlashes('')).toBe('')
    expect(trimTrailingSlashes('a / ')).toBe('a / ')
    expect(trimTrailingSlashes('/a/b/')).toBe('/a/b')
    const long = '/'.repeat(100_000) + 'x'
    const start = Date.now()
    expect(trimTrailingSlashes(long)).toBe(long)
    expect(Date.now() - start).toBeLessThan(1000)
  })

  test('the host name is the first line up to the first dot, with no control characters', () => {
    expect(hostOf('Eds-MacBook-Pro.local\n')).toBe('Eds-MacBook-Pro')
    expect(hostOf('build-01.corp.example.com')).toBe('build-01')
    expect(hostOf('  devbox  \r\nsecond line')).toBe('devbox')
    expect(hostOf('dev\u0007box')).toBe('devbox')
    expect(hostOf('x'.repeat(100))).toHaveLength(64)
  })

  test('no host name from empty or missing output', () => {
    expect(hostOf('')).toBeNull()
    expect(hostOf('   \n')).toBeNull()
    expect(hostOf('.local')).toBeNull()
    expect(hostOf(null)).toBeNull()
  })

  test('a new id is 12 hex characters and passes the check; junk does not', () => {
    let n = 0
    const id = newMachineId(() => (n++ % 16) / 16)
    expect(id).toBe('0123456789ab')
    expect(isMachineId(id)).toBe(true)
    expect(isMachineId(newMachineId(() => 0.9999999))).toBe(true)
    expect(isMachineId('short')).toBe(false)
    expect(isMachineId('ABCDEF012345')).toBe(false)
    expect(isMachineId('<script>0000')).toBe(false)
    expect(isMachineId(42)).toBe(false)
    expect(isMachineId(undefined)).toBe(false)
  })

  test('a machine with no host name is labelled by its id', () => {
    expect(machineInfo('devbox', 'abcdef012345')).toEqual({ name: 'devbox', id: 'abcdef012345' })
    expect(machineInfo(null, 'abcdef012345')).toEqual({ name: 'machine-abcd', id: 'abcdef012345' })
  })

  test('the shared id file sits in CLAUDE_CONFIG_DIR, else in ~/.claude; with neither there is no path', () => {
    expect(machineIdPath('/cfg', '/Users/dev')).toBe('/cfg/podium-machine-id')
    expect(machineIdPath(undefined, '/Users/dev')).toBe('/Users/dev/.claude/podium-machine-id')
    expect(machineIdPath('', '/Users/dev/')).toBe('/Users/dev/.claude/podium-machine-id')
    expect(machineIdPath('/cfg/', undefined)).toBe('/cfg/podium-machine-id')
    expect(machineIdPath(undefined, undefined)).toBeNull()
    expect(machineIdPath('', '')).toBeNull()
    expect(machineIdPath('relative/cfg', undefined)).toBeNull()
  })

  test('the shared id file holds one id; anything else reads as no id', () => {
    expect(parseMachineIdFile('abcdef012345\n')).toBe('abcdef012345')
    expect(parseMachineIdFile('  abcdef012345  ')).toBe('abcdef012345')
    expect(parseMachineIdFile('')).toBeNull()
    expect(parseMachineIdFile('<b>not-mine</b>')).toBeNull()
    expect(parseMachineIdFile('abcdef012345\nabcdef012346')).toBeNull()
    expect(parseMachineIdFile(null)).toBeNull()
  })

  test('the OS rides with the machine only when it was read (#414)', () => {
    expect(machineInfo('devbox', 'abcdef012345', 'macOS 27.0.1')).toEqual({ name: 'devbox', id: 'abcdef012345', os: 'macOS 27.0.1' })
    expect('os' in machineInfo('devbox', 'abcdef012345', null)).toBe(false)
  })

  test('macOS: sw_vers gives the product name and version', () => {
    expect(osFromSwVers('ProductName:\t\tmacOS\nProductVersion:\t\t27.0.1\nBuildVersion:\t\t26A434\n')).toBe('macOS 27.0.1')
    expect(osFromSwVers('ProductName: Mac OS X\nProductVersion: 10.15.7\n')).toBe('Mac OS X 10.15.7')
    expect(osFromSwVers('ProductName: macOS\n')).toBe('macOS')
    expect(osFromSwVers('BuildVersion: 26A434\n')).toBeNull()
    expect(osFromSwVers('')).toBeNull()
    expect(osFromSwVers(null)).toBeNull()
  })

  test('Linux: PRETTY_NAME from /etc/os-release, its quotes taken off', () => {
    expect(osFromOsRelease('NAME="Debian GNU/Linux"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nVERSION_ID="12"\n')).toBe('Debian GNU/Linux 12 (bookworm)')
    expect(osFromOsRelease("PRETTY_NAME='Ubuntu 24.04.1 LTS'\n")).toBe('Ubuntu 24.04.1 LTS')
    expect(osFromOsRelease('PRETTY_NAME=Alpine\n')).toBe('Alpine')
    expect(osFromOsRelease('NAME=Arch\n')).toBeNull()
    expect(osFromOsRelease(undefined)).toBeNull()
  })

  test('Windows: the one line cmd /c ver prints', () => {
    expect(osFromVer('\r\nMicrosoft Windows [Version 10.0.26100.1742]\r\n')).toBe('Microsoft Windows [Version 10.0.26100.1742]')
    expect(osFromVer('\r\n\r\n')).toBeNull()
    expect(osFromVer(null)).toBeNull()
  })

  test('an OS string is one line of at most 80 characters, with no control characters', () => {
    expect(cleanOs(`Linux\u0007 ${'x'.repeat(200)}`)!.length).toBeLessThanOrEqual(80)
    expect(cleanOs('a\tb\nc\u001b[31m')).toBe('a b c [31m')
    expect(cleanOs('   ')).toBeNull()
  })

  test('the random source is the platform generator, and without one still gives distinct values in [0, 1) (#515)', () => {
    const fixed = { getRandomValues: (a: Uint32Array) => { a[0] = 2 ** 31; return a } }
    expect(platformRandom(fixed)).toBe(0.5)
    const draws = Array.from({ length: 50 }, () => platformRandom(undefined))
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(1)
    }
    expect(new Set(draws).size).toBeGreaterThan(40)
    expect(newMachineId(() => platformRandom(undefined))).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('the pinned machine name (#715)', () => {
  test('machineNamePath sits beside the id file', () => {
    expect(machineNamePath('/cfg', '/Users/dev')).toBe('/cfg/podium-machine-name')
    expect(machineNamePath(undefined, '/Users/dev')).toBe('/Users/dev/.claude/podium-machine-name')
    expect(machineNamePath('relative/cfg', undefined)).toBeNull()
    expect(machineNamePath(undefined, undefined)).toBeNull()
  })

  test('parseMachineNameFile takes the first line as a short host name, null when empty', () => {
    expect(parseMachineNameFile('Dana-MacBook-Pro\n')).toBe('Dana-MacBook-Pro')
    expect(parseMachineNameFile('devbox.local\nsecond')).toBe('devbox')
    expect(parseMachineNameFile('  \n')).toBeNull()
    expect(parseMachineNameFile(null)).toBeNull()
  })

  test('localHostNameOf is the same cleaning as hostOf, for scutil output', () => {
    expect(localHostNameOf('Dana-MacBook-Pro\n')).toBe('Dana-MacBook-Pro')
    expect(localHostNameOf('')).toBeNull()
  })
})
