import { describe, test, expect } from 'claude-code/testing'
import { findConfig, findNode, problemFor, problemFromStartup, startLink, type FoundConfig, type LinkEngine } from './tlsLink.ts'

const NOW = Date.parse('2026-02-01T00:00:00Z')

const text = (user: string, issued: number, expires = '2026-04-01T00:00:00.000Z') =>
  `# podium-reporter-config v1\n# user: ${user}\n# server: https://podium.lan:4318\n# issued-at: x ${issued}\n# expires: ${expires}\n# fingerprint: AA\n-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n`

interface Fake {
  $: LinkEngine
  fetched: { url: string; socketPath?: string; headers?: Record<string, string> }[]
  spawned: { argv: readonly string[]; env?: Record<string, string> }[]
  finishHelper: () => void
}

/** A stand-in for `$`: files by path, the PATH's `node`, what the helper prints, and what the helper answers. */
function fake(o: {
  files?: Record<string, string>
  env?: Record<string, string>
  pathNode?: string | null
  helperOut?: string[]
  helperExits?: boolean
  answers?: Array<{ status: number; headers?: Record<string, string> }>
}): Fake {
  const files = o.files ?? {}
  const fetched: Fake['fetched'] = []
  const spawned: Fake['spawned'] = []
  let end: () => void = () => {}
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
    },
    process: {
      run: async () => {
        if (o.pathNode) return { exitCode: 0, stdout: `${o.pathNode}\n` }
        throw new Error('ENOENT')
      },
      spawn: (req) => {
        spawned.push(req)
        const lines = o.helperOut ?? ['ready\n']
        const done = new Promise<void>((r) => (end = r))
        return {
          [Symbol.asyncIterator]() {
            let i = 0
            return {
              async next() {
                if (i < lines.length) return { done: false as const, value: { stream: 'stdout', text: lines[i++] as string } }
                if (o.helperExits) return { done: true as const, value: undefined }
                await done
                return { done: true as const, value: undefined }
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
    clock: { sleep: () => new Promise<void>(() => {}) },
    plugin: { root: '/plugin' },
  }
  return { $, fetched, spawned, finishHelper: () => end() }
}

const found = (user = 'Dana Lee', expires = '2026-04-01T00:00:00.000Z'): FoundConfig => ({
  path: '/home/d/.podium/reporter-config-Dana-Lee-1.pem',
  headers: { user, server: 'https://podium.lan:4318', issuedAt: 1, expires, fingerprint: 'AA' },
})
const env = { config: undefined, context: undefined, home: '/home/d', node: undefined, tmp: undefined }

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

