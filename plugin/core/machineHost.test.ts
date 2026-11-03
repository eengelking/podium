import { describe, test, expect } from 'claude-code/testing'
import { pinnedMachineName, readOsName, type HostIO } from './machineHost.ts'

const io = (files: Record<string, string> = {}, out: Record<string, string | null> = {}): HostIO & { files: Record<string, string> } => ({
  files,
  read: async (p) => {
    if (!(p in files)) throw new Error('ENOENT')
    return files[p]!
  },
  write: async (p, t) => {
    files[p] = t
  },
  run: async (argv) => {
    const v = out[argv[0]!]
    if (v === undefined) throw new Error('ENOENT')
    return v
  },
})
const SHARED = '/Users/dev/.podium/machine-name'
const CLAUDE = '/Users/dev/.claude/podium-machine-name'

describe('the shared machine name and OS (#967)', () => {
  test('the shared pin wins, and the Claude Code pin is the fallback that gets shared', async () => {
    expect(await pinnedMachineName(io({ [SHARED]: 'Shared\n', [CLAUDE]: 'Claude\n' }), '/Users/dev', CLAUDE)).toBe('Shared')
    const h = io({ [CLAUDE]: 'Claude\n' })
    expect(await pinnedMachineName(h, '/Users/dev', CLAUDE)).toBe('Claude')
    expect(h.files[SHARED]).toBe('Claude\n')
  })
  test('with no pin, scutil LocalHostName then hostname, and the name is pinned in both places', async () => {
    const h = io({}, { scutil: 'Studio-Mac\n', hostname: 'other\n' })
    expect(await pinnedMachineName(h, '/Users/dev', CLAUDE)).toBe('Studio-Mac')
    expect(h.files[SHARED]).toBe('Studio-Mac\n')
    expect(h.files[CLAUDE]).toBe('Studio-Mac\n')
    expect(await pinnedMachineName(io({}, { hostname: 'box.local\n' }), '/Users/dev', null)).toBe('box')
  })
  test('null when nothing names the machine', async () => {
    expect(await pinnedMachineName(io(), '/Users/dev', CLAUDE)).toBeNull()
  })
  test('the OS is the first of sw_vers, os-release and ver that works', async () => {
    expect(await readOsName(io({}, { sw_vers: 'ProductName:\tmacOS\nProductVersion:\t27.0.1\n' }))).toBe('macOS 27.0.1')
    expect(await readOsName(io({ '/etc/os-release': 'PRETTY_NAME="Debian 12"\n' }))).toBe('Debian 12')
    expect(await readOsName(io({}, { cmd: 'Microsoft Windows [Version 10.0.26100.1]\n' }))).toBe('Microsoft Windows [Version 10.0.26100.1]')
    expect(await readOsName(io())).toBeNull()
  })
})
