import { describe, test, expect } from 'claude-code/testing'
import { findConfig, findNode, problemFor, problemFromStartup, REPLY_MS, startLink, type FoundConfig, type LinkEngine } from './tlsLink.ts'

const NOW = Date.parse('2026-02-01T00:00:00Z')

const text = (user: string, issued: number, expires = '2026-04-01T00:00:00.000Z') =>
  `# podium-reporter-config v1\n# user: ${user}\n# server: https://podium.lan:4318\n# issued-at: x ${issued}\n# expires: ${expires}\n# fingerprint: AA\n-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n`

interface Fake {
  $: LinkEngine
  fetched: { url: string; socketPath?: string; headers?: Record<string, string> }[]
  spawned: { argv: readonly string[]; env?: Record<string, string> }[]
  finishHelper: () => void
  /** Say something on the helper's stdout. */
  emit: (text: string) => void
  /** What the mod wrote through $.fs.write. */
  written: { path: string; text: string }[]
  /** The sleeps that are waiting, resolved by the test. */
  sleeps: { ms: number; wake: () => void }[]
}

/** A stand-in for `$`: files by path, the PATH's `node`, what the helper prints, and what the helper answers. */
function fake(o: {
  files?: Record<string, string>
  env?: Record<string, string>
  pathNode?: string | null
  helperOut?: string[]
  helperExits?: boolean
  answers?: Array<{ status: number; headers?: Record<string, string> }>
  /** Called after each $.fs.write, to let the helper answer. */
  onWrite?: (path: string, text: string, emit: (text: string) => void) => void
}): Fake {
  const files = o.files ?? {}
  const fetched: Fake['fetched'] = []
  const spawned: Fake['spawned'] = []
  let finished = false
  let wake: () => void = () => {}
  const queue: string[] = [...(o.helperOut ?? ['ready\n'])]
  const emit = (t: string) => {
    queue.push(t)
    wake()
  }
  const end = () => {
    finished = true
    wake()
  }
  const written: Fake['written'] = []
  const sleeps: Fake['sleeps'] = []
  const answers = [...(o.answers ?? [])]
  const $: LinkEngine = {
    env: { get: async (n) => o.env?.[n] },
    fs: {
      read: async (p) => {
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
      write: async (p, t) => {
        written.push({ path: p, text: t })
        o.onWrite?.(p, t, emit)
      },
    },
    process: {
      run: async () => {
        if (o.pathNode) return { exitCode: 0, stdout: `${o.pathNode}\n` }
        throw new Error('ENOENT')
      },
      spawn: (req) => {
        spawned.push(req)
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                for (;;) {
                  if (queue.length) return { done: false as const, value: { stream: 'stdout', text: queue.shift() as string } }
                  if (o.helperExits || finished) return { done: true as const, value: undefined }
                  await new Promise<void>((r) => (wake = r))
                }
              },
              async return() {
                end()
                return { done: true as const, value: undefined }
              },
            }
          },
        }
      },
    },
    http: {
      fetch: async (url, init) => {
        fetched.push({ url, socketPath: init?.socketPath, headers: init?.headers })
        const a = answers.shift() ?? { status: 200 }
        return { status: a.status, ok: a.status < 300, text: '{}', headers: a.headers ?? {} }
      },
    },
    clock: { sleep: (ms) => new Promise<void>((wakeUp) => sleeps.push({ ms, wake: wakeUp })) },
    plugin: { root: '/plugin' },
  }
  return { $, fetched, spawned, finishHelper: () => end(), emit, written, sleeps }
}

const found = (user = 'Dana Lee', expires = '2026-04-01T00:00:00.000Z'): FoundConfig => ({
  path: '/home/d/.podium/reporter-config-Dana-Lee-1.pem',
  headers: { user, server: 'https://podium.lan:4318', issuedAt: 1, expires, fingerprint: 'AA' },
})
const env = { config: undefined, context: undefined, home: '/home/d', node: undefined, tmp: undefined }

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
    const reads: string[] = []
    const read = f.$.fs.read
    f.$.fs.read = async (p) => {
      reads.push(p)
      return read(p)
    }
    const r = await findConfig(f.$, env)
    expect(r.found?.path).toBe(`${dir}/reporter-config-Dana-500.pem`)
    // The contexts file is looked for first (#606); no config file but the newest is read.
    expect(reads.filter((r) => !r.endsWith('/contexts.json'))).toEqual([`${dir}/reporter-config-Dana-500.pem`])
  })

  test('a newest file that is not a usable config falls through to the next newest (#607)', async () => {
    const dir = '/home/d/.podium'
    const f = fake({ files: { [`${dir}/reporter-config-Dana-9.pem`]: 'garbage', [`${dir}/reporter-config-Dana-5.pem`]: text('Dana', 5), [`${dir}/reporter-config-Dana-3.pem`]: text('Dana', 3) } })
    expect((await findConfig(f.$, env)).found?.path).toBe(`${dir}/reporter-config-Dana-5.pem`)
  })

  test('a file whose name carries no epoch is read only when no file with one is usable (#607)', async () => {
    const dir = '/home/d/.podium'
    const odd = `${dir}/reporter-config-Dana-copy.pem`
    const withOdd = fake({ files: { [odd]: text('Dana', 999), [`${dir}/reporter-config-Dana-5.pem`]: text('Dana', 5) } })
    expect((await findConfig(withOdd.$, env)).found?.path).toBe(`${dir}/reporter-config-Dana-5.pem`)
    const onlyOdd = fake({ files: { [odd]: text('Dana', 999) } })
    expect((await findConfig(onlyOdd.$, env)).found?.path).toBe(odd)
  })

  test('PODIUM_REPORTER_CONFIG names the file and the folder is not read', async () => {
    const f = fake({ files: { '/x/mine.pem': text('Dana', 5), '/home/d/.podium/reporter-config-Dana-9.pem': text('Dana', 900) } })
    const r = await findConfig(f.$, { ...env, config: '/x/mine.pem' })
    expect(r.found?.path).toBe('/x/mine.pem')
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

  test('PODIUM_REPORTER_CONFIG still comes first, and no context is named', async () => {
    const f = fake({ files: { ...files('home'), '/x/mine.pem': text('Dana', 5) } })
    const r = await findConfig(f.$, { ...env, config: '/x/mine.pem', context: 'work' })
    expect(r.found?.path).toBe('/x/mine.pem')
    expect(r.found?.context).toBeUndefined()
  })

  test('only the chosen context\'s file is read, so another key is never read', async () => {
    const f = fake({ files: files('home') })
    const reads: string[] = []
    const read = f.$.fs.read
    f.$.fs.read = async (p) => {
      reads.push(p)
      return read(p)
    }
    await findConfig(f.$, env)
    expect(reads).toEqual([`${dir}/contexts.json`, home])
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
    const other = (user: string, server: string, issued: number) => text(user, issued).replace('https://podium.lan:4318', server).replace(`# user: ${user}`, `# user: ${user}`)
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
})

describe('finding node (#584)', () => {
  test('PODIUM_NODE wins, and a path that is not there is no node', async () => {
    expect(await findNode(fake({ files: { '/opt/n': '' }, pathNode: '/usr/bin/node' }).$, { ...env, node: '/opt/n' })).toBe('/opt/n')
    expect(await findNode(fake({ pathNode: '/usr/bin/node' }).$, { ...env, node: '/nowhere' })).toBeNull()
  })

  test('the PATH comes next, then the usual places', async () => {
    expect(await findNode(fake({ pathNode: '/p/node' }).$, env)).toBe('/p/node')
    expect(await findNode(fake({ files: { '/opt/homebrew/bin/node': '' } }).$, env)).toBe('/opt/homebrew/bin/node')
    expect(await findNode(fake({ files: { '/home/d/.nvm/versions/node/v20.1.0/bin/node': '', '/home/d/.nvm/versions/node/v22.2.0/bin/node': '' } }).$, env)).toBe('/home/d/.nvm/versions/node/v22.2.0/bin/node')
  })

  test('none anywhere is null', async () => {
    expect(await findNode(fake({}).$, env)).toBeNull()
  })

  test('a Windows path from the PATH is a node (#834)', async () => {
    expect(await findNode(fake({ pathNode: 'C:\\Program Files\\nodejs\\node.exe' }).$, env)).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(await findNode(fake({ pathNode: 'D:/tools/node.exe' }).$, env)).toBe('D:/tools/node.exe')
    expect(await findNode(fake({ pathNode: 'node.exe' }).$, env)).toBeNull()
  })

  test('on Windows the usual places are Program Files, the per-user installer and Volta (#834)', async () => {
    const win = { ...env, home: 'C:\\Users\\dana', programFiles: 'C:\\Program Files', localAppData: 'C:\\Users\\dana\\AppData\\Local' }
    expect(await findNode(fake({ files: { 'C:\\Program Files/nodejs/node.exe': '' } }).$, win)).toBe('C:\\Program Files/nodejs/node.exe')
    expect(await findNode(fake({ files: { 'C:\\Users\\dana\\AppData\\Local/Programs/nodejs/node.exe': '' } }).$, win)).toBe('C:\\Users\\dana\\AppData\\Local/Programs/nodejs/node.exe')
    expect(await findNode(fake({ files: { 'C:\\Users\\dana\\AppData\\Local/Volta/bin/node.exe': '' } }).$, win)).toBe('C:\\Users\\dana\\AppData\\Local/Volta/bin/node.exe')
    expect(await findNode(fake({}).$, win)).toBeNull()
  })

  test('readEnv takes ProgramFiles and LOCALAPPDATA for those places (#834)', async () => {
    const r = await findConfig(fake({ env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\L' } }).$)
    expect(r.env.programFiles).toBe('C:\\Program Files')
    expect(r.env.localAppData).toBe('C:\\L')
  })
})

describe('what a helper error means to the person (#584)', () => {
  test('each failure a person can act on has words, and an outage has none', () => {
    expect(problemFor('CLIENT_CERT_REJECTED', 'h')?.text).toContain('Admin')
    expect(problemFor('ALTNAME', 'podium.lan:4318')?.text).toContain('podium.lan:4318')
    expect(problemFor('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'h')?.text).toContain('CA')
    expect(problemFor('CERT_HAS_EXPIRED', 'h')?.status).toBe('server certificate expired')
    expect(problemFor('ECONNREFUSED', 'h')).toBeNull()
  })

  test('an expired or not-yet-valid server certificate with the server\'s time unknown says the clock may be wrong, with this machine\'s date (#650)', () => {
    const clock = { now: NOW }
    for (const code of ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID']) {
      const p = problemFor(code, 'h', clock)
      expect(p).toMatchObject({ code, status: 'check the clock' })
      expect(p?.text).toContain('2026-02-01 00:00 UTC')
      expect(p?.text).toMatch(/check the system (date|clock)/i)
      expect(p?.text).not.toMatch(/is wrong\b|is certainly/i)
    }
  })

  test('with the server\'s time known, only a clock that disagrees with it is blamed (#650)', () => {
    const apart = problemFor('CERT_HAS_EXPIRED', 'h', { now: NOW, serverNow: NOW - 2 * 86_400_000 })
    expect(apart?.status).toBe('check the clock')
    expect(apart?.text).toContain('2026-02-01 00:00 UTC')
    expect(apart?.text).toContain('2026-01-30 00:00 UTC')
    // Within a few minutes the clock is not the cause: the certificate really is expired.
    expect(problemFor('CERT_HAS_EXPIRED', 'h', { now: NOW, serverNow: NOW - 60_000 })?.status).toBe('server certificate expired')
    expect(problemFor('CERT_NOT_YET_VALID', 'h', { now: NOW, serverNow: NOW })?.status).toBe('server certificate refused')
  })

  test('an expired certificate names the date and asks for a new config, and a renewal the server refused asks for a reissue (#585, #665)', () => {
    expect(problemFor('CERT_EXPIRED', 'h', undefined, '2026-01-15')).toMatchObject({ status: 'certificate expired' })
    expect(problemFor('CERT_EXPIRED', 'h', undefined, '2026-01-15')?.text).toBe('Your Podium certificate expired on 2026-01-15. Ask an Admin to generate a new reporter config.')
    expect(problemFor('CERT_EXPIRED', 'h')?.text).toContain('Admin')
    expect(problemFor('CERT_PAST_GRACE', 'h')).not.toMatchObject({ status: 'certificate expired' })
    expect(problemFor('CERT_RENEWAL_REFUSED', 'h')).toMatchObject({ status: 'certificate refused' })
    expect(problemFor('CERT_RENEWAL_REFUSED', 'h')?.text).toContain('reissue')
  })
})

describe('starting the helper (#584)', () => {
  const opts = { sessionName: 'Dana Lee', now: () => NOW }

  test('starts node on the helper with the config, a socket and the https address, and clears the two variables that turn verification off', async () => {
    const f = fake({ pathNode: '/p/node' })
    const link = await startLink(f.$, found(), env, opts)
    expect(link.problem()).toBeNull()
    const s = f.spawned[0]
    expect(s?.argv[0]).toBe('/p/node')
    expect(s?.argv[1]).toBe('/plugin/hooks/helper.mjs')
    expect(s?.argv[2]).toBe('/home/d/.podium/reporter-config-Dana-Lee-1.pem')
    expect(s?.argv[3]).toMatch(/^\/home\/d\/\.podium\/run\/[0-9a-f]{8}\.sock$/)
    expect(s?.argv[4]).toBe('https://podium.lan:4318')
    expect(s?.env).toEqual({ NODE_TLS_REJECT_UNAUTHORIZED: '', NODE_OPTIONS: '' })
  })

  describe('on Windows the requests go through a mailbox folder, not a socket (#834)', () => {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    /** Base64 of the UTF-8 of `text`; the mod sandbox has no Buffer. */
    const base64 = (text: string): string => {
      const bytes: number[] = []
      for (const part of encodeURIComponent(text).split(/(%[0-9A-F]{2})/)) {
        if (part.length === 3 && part.startsWith('%')) bytes.push(parseInt(part.slice(1), 16))
        else for (const ch of part) bytes.push(ch.charCodeAt(0))
      }
      let out = ''
      for (let i = 0; i < bytes.length; i += 3) {
        const [a, b, c] = [bytes[i] as number, bytes[i + 1], bytes[i + 2]]
        const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
        out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63) + (b === undefined ? '=' : ALPHABET.charAt((n >> 6) & 63)) + (c === undefined ? '=' : ALPHABET.charAt(n & 63))
      }
      return out
    }
    const reply = (status: number, headers: Record<string, string>, body: string) => base64(JSON.stringify({ status, headers, body }))
    /** Lets the promises that are ready run; the sandbox has no setTimeout. */
    const settle = async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve()
    }
    const winFound: FoundConfig = { ...found(), path: 'C:\\Users\\dana/.podium/reporter-config-Dana-Lee-1.pem' }
    const winEnv = { ...env, home: 'C:\\Users\\dana' }
    /** A helper that answers every request file with `status` and `body`. */
    const answering = (status = 200, headers: Record<string, string> = {}, body = '{"ok":true}') => (_p: string, text: string, emit: (t: string) => void) => {
      const { id } = JSON.parse(text) as { id: string }
      emit(`res ${id} ${reply(status, headers, body)}\n`)
    }
    const start = async (o: Parameters<typeof fake>[0] = {}) => {
      const f = fake({ pathNode: 'C:\\Program Files\\nodejs\\node.exe', onWrite: answering(), ...o })
      const link = await startLink(f.$, winFound, winEnv, opts)
      return { f, link }
    }
    const get = (link: Awaited<ReturnType<typeof start>>['link'], path = '/a') => link.fetch(`https://podium.lan:4318${path}`, { method: 'GET', headers: {} })

    test('the helper is given a mailbox folder under the Podium folder, and no Unix socket path', async () => {
      const { f, link } = await start()
      expect(link.problem()).toBeNull()
      expect(f.spawned[0]?.argv[3]).toMatch(/^mailbox:C:\\Users\\dana\/\.podium\/run\/[0-9a-f]{8}$/)
    })

    test('a request is written as a file, the reply line resolves it, and $.http.fetch is not used', async () => {
      const { f, link } = await start({ onWrite: answering(201, { date: 'Sun, 01 Feb 2026 00:00:00 GMT' }, '{"n":1}') })
      const dir = (f.spawned[0]?.argv[3] as string).slice('mailbox:'.length)
      const res = await link.fetch('https://podium.lan:4318/api/fleet/report?x=1', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Podium-Token': 'secret' }, body: '{"a":1}' })
      expect(res).toMatchObject({ status: 201, ok: true, text: '{"n":1}' })
      expect(res.headers?.date).toBe('Sun, 01 Feb 2026 00:00:00 GMT')
      expect(f.fetched).toEqual([])
      expect(f.written).toHaveLength(1)
      const w = f.written[0] as { path: string; text: string }
      const sent = JSON.parse(w.text) as { id: string; method: string; path: string; body: string }
      expect(w.path).toBe(`${dir}/req-${sent.id}.json`)
      expect(sent).toMatchObject({ method: 'POST', path: '/api/fleet/report?x=1', body: '{"a":1}' })
      expect(sent.id).toMatch(/^[0-9a-z]+-1$/)
      expect(sent).not.toHaveProperty('headers')
      expect(w.text).not.toContain('secret')
    })

    test('a reply line that arrives in two pieces is put together', async () => {
      const { link } = await start({
        onWrite: (_p, text, emit) => {
          const { id } = JSON.parse(text) as { id: string }
          const line = `res ${id} ${reply(200, {}, 'hello')}\n`
          emit(line.slice(0, 20))
          emit(line.slice(20))
        },
      })
      expect((await get(link)).text).toBe('hello')
    })

    test('two requests in flight are each given their own reply, whatever the order', async () => {
      const held: Array<() => void> = []
      const { link } = await start({
        onWrite: (_p, text, emit) => {
          const { id, path } = JSON.parse(text) as { id: string; path: string }
          held.push(() => emit(`res ${id} ${reply(200, {}, path)}\n`))
        },
      })
      const a = get(link, '/one')
      const b = get(link, '/two')
      await settle()
      held[1]?.()
      held[0]?.()
      expect([(await a).text, (await b).text]).toEqual(['/one', '/two'])
    })

    test('a line that is not a reply, and a reply nobody is waiting for, are ignored', async () => {
      const { link } = await start({
        onWrite: (_p, text, emit) => {
          const { id } = JSON.parse(text) as { id: string }
          emit('some log line\n')
          emit(`res nobody ${reply(200, {}, 'x')}\n`)
          emit('res bad-base64 !!!\n')
          emit(`res ${id} ${reply(200, {}, 'mine')}\n`)
        },
      })
      expect((await get(link)).text).toBe('mine')
    })

    test('a helper error header in the reply becomes a problem, as over a socket', async () => {
      const { link } = await start({ onWrite: answering(502, { 'x-podium-helper-error': 'CLIENT_CERT_REJECTED' }, '{}') })
      await get(link)
      expect(link.problem()?.code).toBe('CLIENT_CERT_REJECTED')
    })

    test('a 401 from the server is a certificate the server turned away', async () => {
      const { link } = await start({ onWrite: answering(401, {}, '{}') })
      await get(link)
      expect(link.problem()?.code).toBe('CLIENT_CERT_REJECTED')
    })

    test('a helper that stops while a request waits fails that request with the reason', async () => {
      const { f, link } = await start({ onWrite: () => {} })
      const pending = get(link)
      await settle()
      f.finishHelper()
      await expect(pending).rejects.toThrow()
    })

    test('a reply that never comes fails the request after the wait', async () => {
      const { f, link } = await start({ onWrite: () => {} })
      const pending = get(link)
      await settle()
      f.sleeps.filter((x) => x.ms === REPLY_MS).forEach((x) => x.wake())
      await expect(pending).rejects.toThrow(/did not answer/)
    })

    test('a request file that cannot be written fails that request', async () => {
      const { f, link } = await start()
      f.$.fs.write = async () => {
        throw new Error('EACCES')
      }
      await expect(get(link)).rejects.toThrow('EACCES')
    })

    test('without a home folder to hold the mailbox, the link says so', async () => {
      const f = fake({ pathNode: 'C:\\node\\node.exe' })
      const link = await startLink(f.$, winFound, { ...env, home: undefined }, opts)
      expect(link.problem()?.code).toBe('SOCKET_PATH')
      expect(f.spawned).toEqual([])
    })
  })

  test('requests go to the helper on its socket, with the path kept, and never to http://<server>', async () => {
    const f = fake({ pathNode: '/p/node' })
    const link = await startLink(f.$, found(), env, opts)
    await link.fetch('https://podium.lan:4318/api/fleet/report', { method: 'POST', headers: { a: 'b' }, body: '{}' })
    expect(f.fetched[0]?.url).toBe('http://podium/api/fleet/report')
    expect(f.fetched[0]?.socketPath).toBe(f.spawned[0]?.argv[3])
  })

  test('a request to any other server is refused, and so is the same name with a different port', async () => {
    const f = fake({ pathNode: '/p/node' })
    const link = await startLink(f.$, found(), env, opts)
    await expect(link.fetch('https://evil.example/api/fleet/report', { method: 'POST', headers: {}, body: '' })).rejects.toThrow(/other than the one/)
    await expect(link.fetch('https://podium.lan:43180/x', { method: 'GET', headers: {} })).rejects.toThrow(/other than the one/)
    expect(f.fetched).toEqual([])
  })

  test('a helper error header becomes a problem with words, and the next good answer clears it', async () => {
    const f = fake({ pathNode: '/p/node', answers: [{ status: 502, headers: { 'x-podium-helper-error': 'CLIENT_CERT_REJECTED' } }, { status: 200 }] })
    const link = await startLink(f.$, found(), env, opts)
    await link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })
    expect(link.problem()?.code).toBe('CLIENT_CERT_REJECTED')
    await link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })
    expect(link.problem()).toBeNull()
  })

  test('a certificate valid at the server\'s time and not at this machine\'s shows the clock message (#650)', async () => {
    const serverTime = new Date(NOW - 2 * 86_400_000).toUTCString()
    const f = fake({ pathNode: '/p/node', answers: [{ status: 200, headers: { date: serverTime } }, { status: 502, headers: { 'x-podium-helper-error': 'CERT_HAS_EXPIRED' } }] })
    const link = await startLink(f.$, found(), env, opts)
    await link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })
    await link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })
    expect(link.problem()?.status).toBe('check the clock')
    expect(link.problem()?.text).toContain('2026-02-01 00:00 UTC')
    expect(link.problem()?.text).toContain('2026-01-30 00:00 UTC')
  })

  test('a handshake that fails before any reply says the clock may be wrong, and a server that agrees on the time is blamed (#650)', async () => {
    const f = fake({ pathNode: '/p/node', answers: [{ status: 502, headers: { 'x-podium-helper-error': 'CERT_HAS_EXPIRED' } }] })
    const link = await startLink(f.$, found(), env, opts)
    await link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })
    expect(link.problem()?.status).toBe('check the clock')
    const g = fake({ pathNode: '/p/node', answers: [{ status: 200, headers: { date: new Date(NOW).toUTCString() } }, { status: 502, headers: { 'x-podium-helper-error': 'CERT_HAS_EXPIRED' } }] })
    const agreed = await startLink(g.$, found(), env, opts)
    await agreed.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })
    await agreed.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })
    expect(agreed.problem()?.status).toBe('server certificate expired')
  })

  test('a 401 over the certificate connection is a certificate problem, not a token one (#646)', async () => {
    const f = fake({ pathNode: '/p/node', answers: [{ status: 401 }, { status: 200 }] })
    const link = await startLink(f.$, found(), env, opts)
    await link.fetch('https://podium.lan:4318/a', { method: 'POST', headers: {}, body: '{}' })
    expect(link.problem()?.code).toBe('CLIENT_CERT_REJECTED')
    expect(link.problem()?.status).toBe('certificate refused')
    expect(link.problem()?.text).toContain('reissue')
    await link.fetch('https://podium.lan:4318/a', { method: 'POST', headers: {}, body: '{}' })
    expect(link.problem()).toBeNull()
  })

  test('an outage (connection refused) is not a problem the person must fix', async () => {
    const f = fake({ pathNode: '/p/node', answers: [{ status: 502, headers: { 'x-podium-helper-error': 'ECONNREFUSED' } }] })
    const link = await startLink(f.$, found(), env, opts)
    await link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })
    expect(link.problem()).toBeNull()
  })

  test('no node says so plainly, spawns nothing, and sends nothing', async () => {
    const f = fake({})
    const link = await startLink(f.$, found(), env, opts)
    expect(link.problem()?.status).toBe('no node')
    expect(link.problem()?.text).toContain('PODIUM_NODE')
    await expect(link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })).rejects.toThrow(/node/)
    expect(f.spawned).toEqual([])
    expect(f.fetched).toEqual([])
  })

  test('a file for another name is refused before anything starts', async () => {
    const f = fake({ pathNode: '/p/node' })
    const link = await startLink(f.$, found('Ed'), env, opts)
    expect(link.problem()?.code).toBe('NAME_MISMATCH')
    expect(f.spawned).toEqual([])
  })

  test('a session with no name takes the file’s', async () => {
    const f = fake({ pathNode: '/p/node' })
    const link = await startLink(f.$, found('Ed'), env, { ...opts, sessionName: '' })
    expect(link.problem()).toBeNull()
    expect(link.user).toBe('Ed')
  })

  test('an expired certificate says so from the start, with the date, before any request (#665)', async () => {
    const f = fake({ pathNode: '/p/node', answers: [] })
    const link = await startLink(f.$, found('Dana Lee', '2026-01-15T00:00:00.000Z'), env, opts)
    await Promise.resolve()
    await Promise.resolve()
    expect(link.problem()?.code).toBe('CERT_EXPIRED')
    expect(link.problem()?.status).toBe('certificate expired')
    expect(link.problem()?.text).toBe('Your Podium certificate expired on 2026-01-15. Ask an Admin to generate a new reporter config.')
  })

  test('the helper refusing to send with an expired certificate keeps the same words, and a reply does not clear them', async () => {
    const f = fake({ pathNode: '/p/node', answers: [{ status: 502, headers: { 'x-podium-helper-error': 'CERT_EXPIRED' } }] })
    const link = await startLink(f.$, found('Dana Lee', '2026-01-15T00:00:00.000Z'), env, opts)
    await link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })
    expect(link.problem()?.code).toBe('CERT_EXPIRED')
    expect(link.problem()?.text).toContain('2026-01-15')
    expect(link.problem()?.text).toMatch(/Ask an Admin to generate a new reporter config/)
  })

  test('a helper that stops at start with an error line is said to have failed, with the fix for a loose file mode', async () => {
    const f = fake({ pathNode: '/p/node', helperOut: ['error CONFIG_PERMISSIONS file is readable by others\n'], helperExits: true })
    const link = await startLink(f.$, found(), env, opts)
    // the first request waits for the helper to start, and learns why it did not
    await expect(link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })).rejects.toThrow(/chmod 600/)
    expect(link.problem()?.code).toBe('CONFIG_PERMISSIONS')
    expect(link.problem()?.text).toContain('chmod 600')
  })

  test('an outage keeps a standing certificate problem instead of wiping it', async () => {
    const f = fake({ pathNode: '/p/node', answers: [{ status: 502, headers: { 'x-podium-helper-error': 'ALTNAME' } }, { status: 502, headers: { 'x-podium-helper-error': 'ECONNRESET' } }] })
    const link = await startLink(f.$, found(), env, opts)
    await link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })
    await link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })
    expect(link.problem()?.code).toBe('ALTNAME')
  })

  test('an answer with no headers at all is read as an answer, not a crash', async () => {
    const f = fake({ pathNode: '/p/node' })
    const raw = f.$.http.fetch
    f.$.http.fetch = async (u, i) => ({ ...(await raw(u, i)), headers: undefined as never })
    const link = await startLink(f.$, found(), env, opts)
    expect((await link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })).status).toBe(200)
  })

  test('a connection closed right after the handshake is worded as a maybe, not as a revoked certificate', () => {
    const t = problemFor('CLOSED_AFTER_HANDSHAKE', 'h')
    expect(t?.text).toContain('restarted')
    expect(t?.text).toContain('did not accept your certificate')
  })

  test('startLink does not wait for the helper: a helper that never says ready does not hold up the session', async () => {
    const f = fake({ pathNode: '/p/node', helperOut: [] })
    const link = await startLink(f.$, found(), env, opts)
    expect(link.problem()).toBeNull()
    expect(f.spawned.length).toBe(1)
  })

  test('stop ends the helper', async () => {
    const f = fake({ pathNode: '/p/node' })
    const link = await startLink(f.$, found(), env, opts)
    link.stop()
    await expect(link.fetch('https://podium.lan:4318/a', { method: 'GET', headers: {} })).rejects.toThrow()
  })
})

describe('S8786: no regex that backtracks on a long input', () => {
  test('a home folder ending in a long run of slashes is trimmed in linear time', async () => {
    const t = performance.now()
    await findNode(fake({}).$, { home: `${'/'.repeat(100000)}x` } as never)
    expect(performance.now() - t).toBeLessThan(250)
  })

  test('the helper’s startup line gives its code and message, and anything else is the helper having stopped', () => {
    expect(problemFromStartup('error CONFIG_PERMISSIONS', '/p').code).toBe('CONFIG_PERMISSIONS')
    expect(problemFromStartup('  error CONFIG_INVALID   no key here ', '/p').text).toContain('cannot be used: no key here.')
    expect(problemFromStartup('error CONFIG_MISSING', '/p').code).toBe('CONFIG_MISSING')
    // the status line carries the short reason, not only "config unreadable" (#672)
    expect(problemFromStartup('error CONFIG_INVALID the config file holds more than one person certificate', '/p').status).toBe('config unreadable: the config file holds more than one person certificate')
    expect(problemFromStartup('error CONFIG_INVALID', '/p').status).toBe('config unreadable')
    expect(problemFromStartup(`error CONFIG_INVALID ${'x'.repeat(200)}`, '/p').status).toBe(`config unreadable: ${'x'.repeat(59)}…`)
    expect(problemFromStartup('error X boom', '/p').text).toBe('The Podium connection helper stopped: boom. It restarts on the next session.')
    expect(problemFromStartup('error X', '/p').text).toContain('stopped: X.')
    expect(problemFromStartup('what', '/p').code).toBe('HELPER_EXITED')
    expect(problemFromStartup('error ', '/p').code).toBe('HELPER_EXITED')
    const t = performance.now()
    problemFromStartup(`error ${'a'.repeat(100000)}${' '.repeat(100000)}!`, '/p')
    expect(performance.now() - t).toBeLessThan(250)
  })
})

