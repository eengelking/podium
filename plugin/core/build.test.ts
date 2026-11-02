import { describe, test, expect } from 'claude-code/testing'
import { buildId, modBuild, withBuild } from './build.ts'
import type { Runner } from './git.ts'

const ROOT = '/dev/podium/mod/podium-reporter'

function runner(map: Record<string, { exitCode?: number; stdout?: string }>): Runner {
  return async (argv) => {
    const r = map[argv.slice(3).join(' ')]
    return { exitCode: r?.exitCode ?? (r ? 0 : 128), stdout: r?.stdout ?? '' }
  }
}

const checkout = {
  'ls-files --error-unmatch .claude-plugin/plugin.json': { stdout: '.claude-plugin/plugin.json\n' },
  'rev-parse --short=8 HEAD': { stdout: 'a1b2c3d4\n' },
  'status --porcelain -- .': { stdout: '' },
}

describe('buildId (#400)', () => {
  test('is none at a clean release tag and the hash anywhere else', () => {
    expect(buildId('a1b2c3d4', 'v1.1.0', false)).toBeNull()
    expect(buildId('a1b2c3d4', '', false)).toBe('a1b2c3d4')
    expect(buildId('a1b2c3d4', 'v1.1.0-rc1', false)).toBe('a1b2c3d4')
  })

  test('marks local edits, even on a release tag', () => {
    expect(buildId('a1b2c3d4', '', true)).toBe('a1b2c3d4-dirty')
    expect(buildId('a1b2c3d4', 'v1.1.0', true)).toBe('a1b2c3d4-dirty')
  })
})

describe('modBuild (#400)', () => {
  test('is the commit when the mod runs from a dev checkout', async () => {
    expect(await modBuild(runner(checkout), ROOT)).toBe('a1b2c3d4')
  })

  test('is none at a release tag', async () => {
    expect(await modBuild(runner({ ...checkout, 'describe --exact-match --tags HEAD': { stdout: 'v1.1.0\n' } }), ROOT)).toBeNull()
  })

  test('marks a checkout with edits under the mod folder', async () => {
    expect(await modBuild(runner({ ...checkout, 'status --porcelain -- .': { stdout: ' M hooks/register.ts\n' } }), ROOT)).toBe('a1b2c3d4-dirty')
  })

  test('is none for an installed copy, which is a release', async () => {
    expect(await modBuild(runner({}), ROOT)).toBeNull()
  })

  test('is none when the mod folder sits in some other repository, such as one that holds a home directory', async () => {
    const { 'ls-files --error-unmatch .claude-plugin/plugin.json': _tracked, ...other } = checkout
    expect(await modBuild(runner(other), ROOT)).toBeNull()
  })

  test('is none when git cannot name a commit, or the runner throws', async () => {
    expect(await modBuild(runner({ 'ls-files --error-unmatch .claude-plugin/plugin.json': { stdout: 'x' } }), ROOT)).toBeNull()
    expect(await modBuild(async () => { throw new Error('no git') }, ROOT)).toBeNull()
  })
})

describe('withBuild (#400)', () => {
  test('puts a dev build after the version, set off by a pipe, and leaves a release as it was', () => {
    expect(withBuild('podium v1.1.0', 'a1b2c3d4')).toBe('podium v1.1.0 | dev: a1b2c3d4')
    expect(withBuild('podium v1.1.0', null)).toBe('podium v1.1.0')
    expect(withBuild('podium v1.1.0', undefined)).toBe('podium v1.1.0')
  })
})
