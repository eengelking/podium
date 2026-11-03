// findConfig.ts: which reporter config file a reporter uses, over an in-memory ConfigSource (#584, #606, #607, #834, #948).
import { describe, test, expect } from 'claude-code/testing'
import { envValue, findConfig, readEnv, readHome, type ConfigSource } from './findConfig.ts'

const text = (user: string, issued: number, expires = '2026-04-01T00:00:00.000Z') =>
  `# podium-reporter-config v1\n# user: ${user}\n# server: https://podium.lan:4318\n# issued-at: x ${issued}\n# expires: ${expires}\n# fingerprint: AA\n-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n`

/** An in-memory ConfigSource: files by path (a folder is whatever the paths imply), environment variables by name. Every read is recorded. */
function fake(o: { files?: Record<string, string>; env?: Record<string, string> }): { $: ConfigSource; reads: string[] } {
  const files = o.files ?? {}
  const reads: string[] = []
  const $: ConfigSource = {
    env: { get: async (n) => o.env?.[n] },
    fs: {
      read: async (p) => {
        reads.push(p)
        if (!(p in files)) throw new Error('ENOENT')
        return files[p]
      },
      list: async (p) => {
        const dir = (p ?? '').replace(/\/$/, '')
        const below = Object.keys(files)
          .filter((f) => f.startsWith(`${dir}/`))
          .map((f) => f.slice(dir.length + 1))
        const names = [...new Set(below.map((f) => f.split('/')[0] as string))].map((name) => ({ name, kind: below.includes(name) ? 'file' : 'dir' }))
        if (!names.length) throw new Error('ENOENT')
        return names
      },
      exists: async (p) => p in files,
    },
  }
  return { $, reads }
}

const env = { config: undefined, context: undefined, home: '/home/d' }

describe('finding the reporter config on Windows (#834)', () => {
  const win = 'C:\\Users\\dana'
  const file = `${win}/.podium/reporter-config-Dana-5.pem`

  test('with no HOME, USERPROFILE names the home folder', async () => {
    const f = fake({ env: { USERPROFILE: win }, files: { [file]: text('Dana', 5) } })
    const r = await findConfig(f.$)
    expect(r.found?.path).toBe(file)
    expect(r.env.homeFrom).toBe('USERPROFILE')
    expect(r.homeNote).toBeNull()
  })

  test('with only HOMEDRIVE and HOMEPATH, they name the home folder', async () => {
    const f = fake({ env: { HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\dana' }, files: { [file]: text('Dana', 5) } })
    const r = await findConfig(f.$)
    expect(r.found?.path).toBe(file)
    expect(r.env.homeFrom).toBe('HOMEDRIVE+HOMEPATH')
  })

  test('HOME still wins where it is set, so macOS and Linux are unchanged', async () => {
    const r = await findConfig(fake({ env: { HOME: '/home/d', USERPROFILE: win }, files: { '/home/d/.podium/reporter-config-Dana-5.pem': text('Dana', 5) } }).$)
    expect(r.found?.path).toBe('/home/d/.podium/reporter-config-Dana-5.pem')
    expect(r.env.homeFrom).toBe('HOME')
  })

  test('no home folder at all is said, not silent, and does not block the plain-token path', async () => {
    const r = await findConfig(fake({}).$)
    expect(r.found).toBeNull()
    expect(r.problem).toBeNull()
    expect(r.homeNote).toContain('HOME')
    expect(r.homeNote).toContain('USERPROFILE')
  })
})

describe('finding the reporter config (#584)', () => {
  test('no file means no link: the reporter works as today', async () => {
    const r = await findConfig(fake({}).$, env)
    expect(r.found).toBeNull()
    expect(r.problem).toBeNull()
  })

  test('the newest file in ~/.podium wins, by its issued-at line', async () => {
    const f = fake({ files: { '/home/d/.podium/reporter-config-Dana-1.pem': text('Dana', 100), '/home/d/.podium/reporter-config-Dana-2.pem': text('Dana', 200), '/home/d/.podium/other.txt': 'x' } })
    expect((await findConfig(f.$, env)).found?.path).toBe('/home/d/.podium/reporter-config-Dana-2.pem')
  })

  test('with five files, only the newest by the epoch in its name is read, and the others\' keys never are (#607)', async () => {
    const dir = '/home/d/.podium'
    const files: Record<string, string> = {}
    for (const e of [100, 200, 500, 300, 400]) files[`${dir}/reporter-config-Dana-${e}.pem`] = text('Dana', e)
    const f = fake({ files })
    const r = await findConfig(f.$, env)
    expect(r.found?.path).toBe(`${dir}/reporter-config-Dana-500.pem`)
    // The contexts file is looked for first (#606); no config file but the newest is read.
    expect(f.reads.filter((p) => !p.endsWith('/contexts.json'))).toEqual([`${dir}/reporter-config-Dana-500.pem`])
  })

  test('a file that is not a config file by its name is skipped and never read', async () => {
    const dir = '/home/d/.podium'
    const f = fake({ files: { [`${dir}/other.txt`]: text('Dana', 999), [`${dir}/notes.pem`]: text('Dana', 998), [`${dir}/reporter-config-Dana-5.pem`]: text('Dana', 5) } })
    const r = await findConfig(f.$, env)
    expect(r.found?.path).toBe(`${dir}/reporter-config-Dana-5.pem`)
    expect(f.reads.filter((p) => !p.endsWith('/contexts.json'))).toEqual([`${dir}/reporter-config-Dana-5.pem`])
  })

  test('a folder in ~/.podium is not a config file, and no config file at all is no config', async () => {
    const dir = '/home/d/.podium'
    const f = fake({ files: { [`${dir}/reporter-config-Dana-5.pem/inner`]: text('Dana', 5) } })
    const r = await findConfig(f.$, env)
    expect(r.found).toBeNull()
    expect(f.reads.filter((p) => !p.endsWith('/contexts.json'))).toEqual([])
  })

  test('a newest file that is not a usable config falls through to the next newest (#607)', async () => {
    const dir = '/home/d/.podium'
    const f = fake({ files: { [`${dir}/reporter-config-Dana-9.pem`]: 'garbage', [`${dir}/reporter-config-Dana-5.pem`]: text('Dana', 5), [`${dir}/reporter-config-Dana-3.pem`]: text('Dana', 3) } })
    expect((await findConfig(f.$, env)).found?.path).toBe(`${dir}/reporter-config-Dana-5.pem`)
    expect(f.reads.filter((p) => !p.endsWith('/contexts.json'))).toEqual([`${dir}/reporter-config-Dana-9.pem`, `${dir}/reporter-config-Dana-5.pem`])
  })

  test('a file whose name carries no epoch is read only when no file with one is usable (#607)', async () => {
    const dir = '/home/d/.podium'
    const odd = `${dir}/reporter-config-Dana-copy.pem`
    const withOdd = fake({ files: { [odd]: text('Dana', 999), [`${dir}/reporter-config-Dana-5.pem`]: text('Dana', 5) } })
    expect((await findConfig(withOdd.$, env)).found?.path).toBe(`${dir}/reporter-config-Dana-5.pem`)
    expect(withOdd.reads).not.toContain(odd)
    const onlyOdd = fake({ files: { [odd]: text('Dana', 999) } })
    expect((await findConfig(onlyOdd.$, env)).found?.path).toBe(odd)
  })

  test('PODIUM_REPORTER_CONFIG names the file and the folder is not read', async () => {
    const f = fake({ files: { '/x/mine.pem': text('Dana', 5), '/home/d/.podium/reporter-config-Dana-9.pem': text('Dana', 900) } })
    const r = await findConfig(f.$, { ...env, config: '/x/mine.pem' })
    expect(r.found?.path).toBe('/x/mine.pem')
    expect(f.reads).toEqual(['/x/mine.pem'])
  })

  test('PODIUM_REPORTER_CONFIG read from the environment names the file', async () => {
    const f = fake({ env: { HOME: '/home/d', PODIUM_REPORTER_CONFIG: '/x/mine.pem' }, files: { '/x/mine.pem': text('Dana', 5) } })
    const r = await findConfig(f.$)
    expect(r.found?.path).toBe('/x/mine.pem')
    expect(r.env.config).toBe('/x/mine.pem')
  })

  test('PODIUM_REPORTER_CONFIG naming something that is not a config is a problem, not silence', async () => {
    const r = await findConfig(fake({ files: { '/x/mine.pem': 'nope' } }).$, { ...env, config: '/x/mine.pem' })
    expect(r.found).toBeNull()
    expect(r.problem?.code).toBe('CONFIG_INVALID')
  })
})

describe('finding the reporter config by context (#606)', () => {
  const dir = '/home/d/.podium'
  const home = `${dir}/reporter-config-Dana-100.pem`
  const work = `${dir}/reporter-config-Dana-200.pem`
  const newest = `${dir}/reporter-config-Dana-900.pem`
  const contexts = (current: string | null) => JSON.stringify({ current, contexts: { home: 'reporter-config-Dana-100.pem', work: 'reporter-config-Dana-200.pem' } })
  const files = (current: string | null) => ({ [home]: text('Dana', 100), [work]: text('Dana', 200), [newest]: text('Dana', 900), [`${dir}/contexts.json`]: contexts(current) })

  test('the current context wins over a newer file', async () => {
    const r = await findConfig(fake({ files: files('home') }).$, env)
    expect(r.found?.path).toBe(home)
    expect(r.found?.context).toBe('home')
    expect(r.contextProblem).toBeNull()
  })

  test('PODIUM_REPORTER_CONTEXT picks another for one terminal', async () => {
    const r = await findConfig(fake({ files: files('home') }).$, { ...env, context: 'work' })
    expect(r.found?.path).toBe(work)
    expect(r.found?.context).toBe('work')
  })

  test('PODIUM_REPORTER_CONTEXT is read from the environment', async () => {
    const r = await findConfig(fake({ env: { HOME: '/home/d', PODIUM_REPORTER_CONTEXT: 'work' }, files: files('home') }).$)
    expect(r.found?.context).toBe('work')
    expect(r.env.context).toBe('work')
  })

  test('PODIUM_REPORTER_CONFIG still comes first, and no context is named', async () => {
    const f = fake({ files: { ...files('home'), '/x/mine.pem': text('Dana', 5) } })
    const r = await findConfig(f.$, { ...env, config: '/x/mine.pem', context: 'work' })
    expect(r.found?.path).toBe('/x/mine.pem')
    expect(r.found?.context).toBeUndefined()
  })

  test('only the chosen context\'s file is read, so another key is never read', async () => {
    const f = fake({ files: files('home') })
    await findConfig(f.$, env)
    expect(f.reads).toEqual([`${dir}/contexts.json`, home])
  })

  test('no contexts file, or none current: the newest file wins as before, with no problem', async () => {
    const none = await findConfig(fake({ files: { [home]: text('Dana', 100), [newest]: text('Dana', 900) } }).$, env)
    expect(none.found?.path).toBe(newest)
    expect(none.found?.context).toBeUndefined()
    expect(none.contextProblem).toBeNull()
    const noCurrent = await findConfig(fake({ files: files(null) }).$, env)
    expect(noCurrent.found?.path).toBe(newest)
    expect(noCurrent.contextProblem).toBeNull()
  })

  test('a context that does not exist is a problem, and the newest file is used', async () => {
    const r = await findConfig(fake({ files: files('home') }).$, { ...env, context: 'nope' })
    expect(r.found?.path).toBe(newest)
    expect(r.found?.context).toBeUndefined()
    expect(r.contextProblem?.code).toBe('CONTEXT_INVALID')
    expect(r.contextProblem?.text).toContain('"nope"')
  })

  test('PODIUM_REPORTER_CONTEXT with no contexts file is a problem, and the newest file is used', async () => {
    const r = await findConfig(fake({ files: { [home]: text('Dana', 100), [newest]: text('Dana', 900) } }).$, { ...env, context: 'work' })
    expect(r.found?.path).toBe(newest)
    expect(r.contextProblem?.code).toBe('CONTEXT_INVALID')
    expect(r.contextProblem?.text).toBe('PODIUM_REPORTER_CONTEXT names "work", but there is no /home/d/.podium/contexts.json. The newest reporter config file is used instead. Check it with /podium context.')
  })

  test('a context whose file is gone or is not a config is a problem, and the newest file is used', async () => {
    const gone = files('home')
    delete (gone as Record<string, string>)[home]
    const a = await findConfig(fake({ files: gone }).$, env)
    expect(a.found?.path).toBe(newest)
    expect(a.contextProblem?.code).toBe('CONTEXT_INVALID')
    expect(a.contextProblem?.text).toContain('"home"')
    const b = await findConfig(fake({ files: { ...files('home'), [home]: 'garbage' } }).$, env)
    expect(b.found?.path).toBe(newest)
    expect(b.contextProblem?.code).toBe('CONTEXT_INVALID')
  })

  test('an unreadable contexts file is a problem too, and the newest file is used', async () => {
    const r = await findConfig(fake({ files: { ...files('home'), [`${dir}/contexts.json`]: 'garbage' } }).$, env)
    expect(r.found?.path).toBe(newest)
    expect(r.contextProblem?.code).toBe('CONTEXT_INVALID')
  })

  test('a file this session already holds from a context is kept when the current context changes (a reload)', async () => {
    const f = fake({ files: files('work') })
    const r = await findConfig(f.$, env, { path: home, context: 'home' })
    expect(r.found?.path).toBe(home)
    expect(r.found?.context).toBe('home')
    const gone = await findConfig(fake({ files: files('work') }).$, env, { path: `${dir}/reporter-config-Dana-5.pem`, context: 'old' })
    expect(gone.found?.path).toBe(work)
  })

  test('a contexts file that is there but cannot be read is a problem, not an absent file', async () => {
    const f = fake({ files: files('home') })
    const read = f.$.fs.read
    f.$.fs.read = async (p) => {
      if (p.endsWith('contexts.json')) throw new Error('EACCES')
      return read(p)
    }
    const r = await findConfig(f.$, env)
    expect(r.contextProblem?.code).toBe('CONTEXT_INVALID')
    expect(r.contextProblem?.text).toContain('cannot be read')
    expect(r.found?.path).toBe(newest)
  })

  test('two contexts reach two different servers and people', async () => {
    const other = (user: string, server: string, issued: number) => text(user, issued).replace('https://podium.lan:4318', server)
    const f = fake({
      files: {
        [home]: other('Dana', 'https://home.lan:4318', 100),
        [work]: other('dana.e', 'https://work.lan:4318', 200),
        [`${dir}/contexts.json`]: contexts('home'),
      },
    })
    const a = await findConfig(f.$, env)
    expect([a.found?.headers.user, a.found?.headers.server]).toEqual(['Dana', 'https://home.lan:4318'])
    const b = await findConfig(f.$, { ...env, context: 'work' })
    expect([b.found?.headers.user, b.found?.headers.server]).toEqual(['dana.e', 'https://work.lan:4318'])
  })

  test('a context may name a file by absolute path', async () => {
    const f = fake({ files: { '/srv/p.pem': text('Dana', 7), [`${dir}/contexts.json`]: JSON.stringify({ current: 'srv', contexts: { srv: '/srv/p.pem' } }) } })
    expect((await findConfig(f.$, env)).found?.path).toBe('/srv/p.pem')
  })

  test('a home folder with no ~/.podium folder at all is no config and no problem', async () => {
    const r = await findConfig(fake({}).$, env)
    expect(r.found).toBeNull()
    expect(r.contextProblem).toBeNull()
  })
})

describe('reading the environment that chooses a config (#834, #948)', () => {
  test('a lookup that throws, in its call or in its promise, reads as unset', async () => {
    expect(await envValue(async () => 'x')).toBe('x')
    expect(await envValue(async () => Promise.reject(new Error('no')))).toBeUndefined()
    expect(
      await envValue(() => {
        throw new Error('no')
      }),
    ).toBeUndefined()
  })

  test('the home folder and the variable it came from are read as one', async () => {
    expect(await readHome(fake({ env: { USERPROFILE: 'C:\\Users\\dana' } }).$)).toEqual({ home: 'C:\\Users\\dana', from: 'USERPROFILE' })
    expect(await readHome(fake({}).$)).toEqual({ home: undefined, from: undefined })
  })

  test('readEnv reads the four variables and nothing that belongs to one harness', async () => {
    const e = await readEnv(fake({ env: { HOME: '/h', PODIUM_REPORTER_CONFIG: '/c.pem', PODIUM_REPORTER_CONTEXT: 'work', PODIUM_NODE: '/n' } }).$)
    expect(e).toEqual({ config: '/c.pem', context: 'work', home: '/h', homeFrom: 'HOME' })
  })

  test('a source whose lookup throws leaves each variable unset, so nothing is chosen from the environment', async () => {
    const throwing: ConfigSource = { ...fake({}).$, env: { get: async () => Promise.reject(new Error('denied')) } }
    expect(await readEnv(throwing)).toEqual({ config: undefined, context: undefined, home: undefined, homeFrom: undefined })
    expect((await findConfig(throwing)).homeNote).toContain('no home folder found')
  })

  test('a file whose text is not a string reads as absent', async () => {
    const f = fake({ files: { '/x/mine.pem': text('Dana', 5) } })
    f.$.fs.read = async () => new Uint8Array([1, 2])
    const r = await findConfig(f.$, { ...env, config: '/x/mine.pem' })
    expect(r.problem?.code).toBe('CONFIG_INVALID')
  })
})
