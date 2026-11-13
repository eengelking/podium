// `/podium config` in Claude Code (#1001): the command opens the settings pane, the pane draws the rows, and a pick saves through
// `$.config.set`. Each hook here stands for the engine beneath the plugin.
import { describe, test, expect, mock } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

const config = (args: string): CommandRunInput => ({ command: 'podium', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

const PANE = (bodyColumns: number) =>
  ({
    plugin: 'podium-reporter',
    component: 'Pane',
    requestId: 'podium-config',
    props: { title: 'Podium settings', isFocused: true, bodyColumns, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  }) as const

interface Engine {
  rows: { key: string; label: string; kind: string; value: unknown; options?: string[]; provider: unknown; isLocked: boolean }[]
  sets: { key: string; value: unknown }[]
  opens: { id: string; focus?: boolean; rows?: number }[]
  toasts: string[]
  logs: string[]
  placed: { value: boolean }
  deny: { value: string | null }
  clock: ReturnType<typeof mock.clock>
}

const row = (field: string, kind: string, value: unknown, isLocked = false, options?: string[]) => ({ key: `podium-reporter.${field}`, label: field, kind, value, provider: { kind: 'plugin', name: 'podium-reporter' }, isLocked, ...(options ? { options } : {}) })

function engine(on: On): Engine {
  const w: Engine = {
    rows: [
      row('respond', 'choice', 'off', false, ['off', 'questions', 'questions-and-plans', 'everything']),
      row('peers', 'boolean', false),
      row('activityFeed', 'boolean', true, true),
      row('serverUrl', 'string', 'http://127.0.0.1:4317'),
      row('userName', 'string', ''),
      row('flushIntervalMs', 'number', 1000),
      row('heartbeatMs', 'number', 5000),
    ],
    sets: [],
    opens: [],
    toasts: [],
    logs: [],
    placed: { value: true },
    deny: { value: null },
    clock: mock.clock(on, { now: 1_800_000_000_000 }),
  }
  on('config.list', () => ({ value: w.rows }) as never)
  on('config.set', (_$, e) => {
    if (w.deny.value === 'throw') throw new Error('settings file is busy')
    if (w.deny.value) return { deny: w.deny.value } as never
    w.sets.push({ key: e.key, value: e.value })
    const r = w.rows.find((x) => x.key === e.key)
    if (r) r.value = e.value
    return { value: e.value } as never
  })
  on('ui.open', (_$, e) => {
    w.opens.push({ id: e.id, ...(e.focus ? { focus: true } : {}), ...(e.rows ? { rows: e.rows } : {}) })
    return { value: w.placed.value ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface: this is a -p run' } } as never
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  return w
}

describe('/podium config in Claude Code (#1001)', () => {
  test('opens the pane asking for the keyboard, says nothing in the transcript, and asks again once the command is done', async ($, on) => {
    const w = engine(on)
    const out = await $.command.run(config('config'))
    expect(out.text).toBeUndefined()
    expect(w.opens[0]).toMatchObject({ id: 'podium-config', focus: true })
    expect(w.opens[0]!.rows).toBeGreaterThan(10)
    for (let i = 0; i < 5 && w.logs.length === 0; i++) await w.clock.advance(100)
    expect(w.opens).toHaveLength(2)
    expect(w.opens[1]).toMatchObject({ id: 'podium-config', focus: true })
    // Then it moves the ring to the first control. The test kit has no site holding the keys to move it in (a live session has), so
    // the call is refused here, and a refusal is only a debug line. Whether a live pane takes the keys this way is not checked here.
    expect(w.logs).toEqual(['podium-reporter: settings pane focus: no implementation for ui.focus'])
  })

  test('with no surface to draw it on, says where the settings are', async ($, on) => {
    const w = engine(on)
    w.placed.value = false
    const out = await $.command.run(config(' config '))
    expect(out.text).toBe('No settings window in this mode.\nRun /plugin configure podium-reporter.')
  })

  test('draws the groups and rows, the read-only connection, a locked row and the next-start note', async ($, on) => {
    engine(on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE(100), surface })
      expect(await ui.find({ type: 'Text', text: 'Consent (your choice)' })).toBeDefined()
      expect((await ui.find({ key: 'respond' }))?.type).toBe('Select')
      expect((await ui.find({ key: 'peers' }))?.type).toBe('Select')
      expect((await ui.find({ key: 'flushIntervalMs' }))?.type).toBe('Input')
      // Managed settings decide this one: shown with that, and no control.
      expect(await ui.find({ key: 'activityFeed' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /set by managed settings/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Change it where it is set/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /http:\/\/127\.0\.0\.1:4317/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Token and server: \/plugin configure podium-reporter/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Switch it with \/podium context use/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Changes take effect at the next start/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /No keyboard here\? Click the pane, or use \/plugin configure podium-reporter/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('takes the short labels at a narrow width', async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...PANE(50), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Consent (yours)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^next start$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a pick saves that row, in its own kind, and says it takes effect at the next start', async ($, on) => {
    const w = engine(on)
    const ui = await $.ui.mount({ ...PANE(100), surface: 'terminal' })
    await ui.select({ key: 'respond', value: 'everything' })
    await ui.select({ key: 'peers', value: 'true' })
    await ui.input({ key: 'flushIntervalMs', text: '2500' })
    expect(w.sets).toEqual([
      { key: 'podium-reporter.respond', value: 'everything' },
      { key: 'podium-reporter.peers', value: true },
      { key: 'podium-reporter.flushIntervalMs', value: 2500 },
    ])
    expect(w.toasts[0]).toBe('Podium: saved Respond from Podium. Changes take effect at the next start.')
    await ui.unmount()
  })

  test('a value out of bounds, or one the engine refuses, is not saved and says why', async ($, on) => {
    const w = engine(on)
    const ui = await $.ui.mount({ ...PANE(100), surface: 'terminal' })
    await ui.input({ key: 'flushIntervalMs', text: '10' })
    expect(w.sets).toEqual([])
    expect(w.toasts.at(-1)).toBe('Podium: Report interval (ms) is a whole number of at least 200.')
    w.deny.value = 'policy'
    await ui.select({ key: 'respond', value: 'questions' })
    expect(w.sets).toEqual([])
    expect(w.toasts.at(-1)).toBe('Podium: Respond from Podium not saved: policy')
    w.deny.value = 'throw'
    await ui.select({ key: 'peers', value: 'true' })
    expect(w.sets).toEqual([])
    expect(w.toasts.at(-1)).toMatch(/^Podium: Message my other orchestrators not saved \(.+\)\.$/)
    await ui.unmount()
  })

  test('/podium without config still gives the status', async ($, on) => {
    engine(on)
    on('command.register', () => ({ value: { command: 'podium' } }))
    const out = await $.command.run(config(''))
    expect(out.text ?? '').toMatch(/Podium reporter is loaded|Podium fleet console/)
  })
})
