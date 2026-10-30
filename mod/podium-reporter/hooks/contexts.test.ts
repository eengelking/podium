import { describe, test, expect } from 'claude-code/testing'
import { addContext, contextCommand, parseContexts, removeContext, renameContext, serializeContexts, useContext, validContextName, type ContextIO, type Contexts } from './contexts.ts'

const HOME = '/home/d'
const DIR = `${HOME}/.podium`
const config = (user: string, server: string, issued: number) =>
  `# podium-reporter-config v1\n# user: ${user}\n# server: ${server}\n# issued-at: x ${issued}\n# expires: 2027-01-01T00:00:00.000Z\n# fingerprint: AA\n`

const two: Contexts = { current: 'home', contexts: { home: 'reporter-config-Dana-100.pem', work: 'reporter-config-Dana-200.pem' } }

function io(files: Record<string, string> = {}): ContextIO & { files: Record<string, string> } {
  return {
    files,
    read: async (p) => files[p] ?? null,
    write: async (p, t) => {
      files[p] = t
    },
  }
}

describe('the contexts file (#606)', () => {
  test('round-trips through its text', () => {
    expect(parseContexts(serializeContexts(two))).toEqual(two)
  })

  test('anything that is not a contexts file reads as none, so the newest-file rule applies', () => {
    for (const bad of ['', 'nope', '[]', '{"current":1,"contexts":{}}', '{"current":null,"contexts":{"a b":"reporter-config-x-1.pem"}}', '{"current":null,"contexts":{"a":"../x.pem"}}', '{"current":null,"contexts":{"a":""}}']) {
      expect(parseContexts(bad)).toBeNull()
    }
  })

  test('a current that names no context is dropped, not trusted', () => {
    expect(parseContexts('{"current":"gone","contexts":{"a":"reporter-config-x-1.pem"}}')).toEqual({ current: null, contexts: { a: 'reporter-config-x-1.pem' } })
  })

  test('a context points at a file in ~/.podium by name, or at an absolute path', () => {
    expect(parseContexts('{"current":null,"contexts":{"a":"/srv/podium/mine.pem"}}')?.contexts.a).toBe('/srv/podium/mine.pem')
  })

  test('names are short words a person can type', () => {
    expect(validContextName('work-2.lan')).toBe(true)
    for (const bad of ['', ' ', 'a b', '-x', 'a/b', 'x'.repeat(65)]) expect(validContextName(bad)).toBe(false)
  })
})

describe('changing contexts (#606)', () => {
  test('add makes the first context current and refuses a name already used', () => {
    const r = addContext({ current: null, contexts: {} }, 'home', 'reporter-config-Dana-100.pem')
    expect(r).toMatchObject({ ok: true, contexts: { current: 'home', contexts: { home: 'reporter-config-Dana-100.pem' } } })
    expect(addContext(two, 'home', 'reporter-config-Dana-300.pem')).toMatchObject({ ok: false })
    expect(addContext(two, 'bad name', 'reporter-config-Dana-300.pem')).toMatchObject({ ok: false })
  })

  test('add to a file with contexts leaves the current one alone', () => {
    const r = addContext(two, 'test', 'reporter-config-Dana-300.pem')
    expect(r.ok && r.contexts.current).toBe('home')
  })

  test('rename moves the name and follows current', () => {
    const r = renameContext(two, 'home', 'house')
    expect(r).toMatchObject({ ok: true, contexts: { current: 'house' } })
    expect(r.ok && Object.keys(r.contexts.contexts)).toEqual(['house', 'work'])
    expect(renameContext(two, 'nope', 'x')).toMatchObject({ ok: false })
    expect(renameContext(two, 'home', 'work')).toMatchObject({ ok: false })
  })

  test('remove clears current when it was the current one, and never touches the file', () => {
    const r = removeContext(two, 'home')
    expect(r).toMatchObject({ ok: true, contexts: { current: null, contexts: { work: 'reporter-config-Dana-200.pem' } } })
    expect(removeContext(two, 'nope')).toMatchObject({ ok: false })
  })

  test('use sets current, and says it applies from the next session', () => {
    const r = useContext(two, 'work')
    expect(r).toMatchObject({ ok: true, contexts: { current: 'work' } })
    expect(r.ok && r.note).toMatch(/next session/)
    expect(useContext(two, 'nope')).toMatchObject({ ok: false })
  })
})

describe('/podium context (#606)', () => {
  const files = (): Record<string, string> => ({
    [`${DIR}/reporter-config-Dana-100.pem`]: config('Dana', 'https://home.lan:4318', 100),
    [`${DIR}/reporter-config-Dana-200.pem`]: config('Dana', 'https://work.lan:4318', 200),
  })

  test('with none, it says so and how to add one', async () => {
    const out = await contextCommand(io(files()), HOME, '', undefined)
    expect(out).toMatch(/No contexts/)
    expect(out).toMatch(/context add/)
  })

  test('add checks the file exists and is a reporter config before it writes anything', async () => {
    const i = io(files())
    expect(await contextCommand(i, HOME, 'add work reporter-config-Dana-200.pem', undefined)).toMatch(/Added context "work"/)
    expect(parseContexts(i.files[`${DIR}/contexts.json`] as string)?.contexts.work).toBe('reporter-config-Dana-200.pem')

    const j = io(files())
    expect(await contextCommand(j, HOME, 'add x reporter-config-Nobody-1.pem', undefined)).toMatch(/no such file/i)
    expect(j.files[`${DIR}/contexts.json`]).toBeUndefined()

    const k = io({ ...files(), [`${DIR}/reporter-config-Junk-1.pem`]: 'garbage' })
    expect(await contextCommand(k, HOME, 'add x reporter-config-Junk-1.pem', undefined)).toMatch(/not a Podium reporter config/)
    expect(k.files[`${DIR}/contexts.json`]).toBeUndefined()
  })

  test('add takes a name and a file, both', async () => {
    expect(await contextCommand(io(files()), HOME, 'add work', undefined)).toMatch(/usage/i)
  })

  test('list marks the current context and the one this terminal picks, with each server', async () => {
    const i = io({ ...files(), [`${DIR}/contexts.json`]: serializeContexts(two) })
    const out = await contextCommand(i, HOME, 'list', 'work')
    expect(out).toMatch(/\* home .*home\.lan:4318/)
    expect(out).toMatch(/work .*work\.lan:4318.*PODIUM_REPORTER_CONTEXT/)
    expect(await contextCommand(i, HOME, '', 'work')).toBe(out)
  })

  test('a context whose file is gone is listed as missing, not hidden', async () => {
    const i = io({ [`${DIR}/contexts.json`]: serializeContexts(two) })
    expect(await contextCommand(i, HOME, 'list', undefined)).toMatch(/home .*file missing/)
  })

  test('use switches the next session and leaves the running one', async () => {
    const i = io({ ...files(), [`${DIR}/contexts.json`]: serializeContexts(two) })
    const out = await contextCommand(i, HOME, 'use work', undefined)
    expect(out).toMatch(/next session/)
    expect(out).toMatch(/running/)
    expect(parseContexts(i.files[`${DIR}/contexts.json`] as string)?.current).toBe('work')
  })

  test('use warns when this terminal sets PODIUM_REPORTER_CONTEXT, which wins over current', async () => {
    const i = io({ ...files(), [`${DIR}/contexts.json`]: serializeContexts(two) })
    expect(await contextCommand(i, HOME, 'use work', 'home')).toMatch(/PODIUM_REPORTER_CONTEXT is "home"/)
  })

  test('show names the context, its file, the person and the server', async () => {
    const i = io({ ...files(), [`${DIR}/contexts.json`]: serializeContexts(two) })
    const out = await contextCommand(i, HOME, 'show', undefined)
    expect(out).toMatch(/home/)
    expect(out).toMatch(/Dana/)
    expect(out).toMatch(/home\.lan:4318/)
    expect(await contextCommand(i, HOME, 'show work', undefined)).toMatch(/work\.lan:4318/)
  })

  test('rename and remove write the file and say what they did', async () => {
    const i = io({ ...files(), [`${DIR}/contexts.json`]: serializeContexts(two) })
    expect(await contextCommand(i, HOME, 'rename home house', undefined)).toMatch(/house/)
    expect(parseContexts(i.files[`${DIR}/contexts.json`] as string)?.current).toBe('house')
    expect(await contextCommand(i, HOME, 'remove work', undefined)).toMatch(/Removed/)
    expect(Object.keys(parseContexts(i.files[`${DIR}/contexts.json`] as string)?.contexts ?? {})).toEqual(['house'])
    expect(i.files[`${DIR}/reporter-config-Dana-200.pem`]).toBeDefined()
  })

  test('a contexts file that is there but cannot be read is never rewritten from an empty set', async () => {
    const i = io(files())
    i.read = async (p) => {
      if (p.endsWith('contexts.json')) throw new Error('EACCES')
      return files()[p] ?? null
    }
    expect(await contextCommand(i, HOME, 'add work reporter-config-Dana-200.pem', undefined)).toMatch(/cannot be read, so nothing was changed/)
    expect(i.files[`${DIR}/contexts.json`]).toBeUndefined()
  })

  test('a context named like an object property is not found unless it was added', async () => {
    expect(await contextCommand(io({ [`${DIR}/contexts.json`]: serializeContexts(two) }), HOME, 'use constructor', undefined)).toMatch(/no context named "constructor"/)
    expect(useContext(two, 'toString')).toMatchObject({ ok: false })
  })

  test('an unknown verb lists the verbs', async () => {
    expect(await contextCommand(io(), HOME, 'frobnicate', undefined)).toMatch(/list, show, add, rename, remove, use/)
  })

  test('a contexts file it cannot read is reported, not overwritten', async () => {
    const i = io({ [`${DIR}/contexts.json`]: 'garbage' })
    expect(await contextCommand(i, HOME, 'add x reporter-config-Dana-1.pem', undefined)).toMatch(/not a valid contexts file/)
    expect(i.files[`${DIR}/contexts.json`]).toBe('garbage')
  })
})
