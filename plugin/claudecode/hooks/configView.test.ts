// What the `/podium config` pane shows in Claude Code (#1001), from the engine's `/config` rows.
import { describe, test, expect } from 'claude-code/testing'
import { changeable, engineValue, paneHeight, paneRows, rowFor, type EngineRow } from './configView.ts'

const ROWS: EngineRow[] = [
  { key: 'podium-reporter@eengelking-marketplace.respond', value: 'questions', isLocked: false },
  { key: 'podium-reporter@eengelking-marketplace.peers', value: true, isLocked: false },
  { key: 'podium-reporter@eengelking-marketplace.activityFeed', value: 'true', isLocked: true },
  { key: 'podium-reporter@eengelking-marketplace.flushIntervalMs', value: 1000, isLocked: false },
  { key: 'other-plugin.heartbeatMs', value: 9, isLocked: false },
  { key: 'theme', value: 'dark', isLocked: false },
]
const LIVE = { serverUrl: 'https://podium.local:4317', userName: 'dana', context: 'work' }

describe('the pane rows (#1001)', () => {
  test('a row is found under the plugin\'s own name, installed or loaded from a folder, never another plugin\'s', () => {
    expect(rowFor(ROWS, 'respond')?.value).toBe('questions')
    expect(rowFor([{ key: 'podium-reporter.peers', value: false, isLocked: false }], 'peers')?.key).toBe('podium-reporter.peers')
    expect(rowFor(ROWS, 'heartbeatMs')).toBeUndefined()
  })
  test('values, locks and the live connection', () => {
    const rows = paneRows(ROWS, LIVE)
    const by = Object.fromEntries(rows.map((r) => [r.setting.id, r]))
    expect(rows.map((r) => r.setting.id)).toEqual(['respond', 'peers', 'activityFeed', 'server', 'userName', 'flushIntervalMs', 'heartbeatMs', 'context'])
    expect(by.respond).toMatchObject({ value: 'questions', lock: null, key: 'podium-reporter@eengelking-marketplace.respond' })
    expect(by.peers!.value).toBe('true')
    // A switch the engine holds as text is not on, as readOptions reads it; managed settings decide this one.
    expect(by.activityFeed).toMatchObject({ value: 'false', lock: 'managed settings' })
    expect(by.server).toMatchObject({ value: 'https://podium.local:4317', key: null })
    expect(by.userName!.value).toBe('dana')
    expect(by.context!.value).toBe('work')
    expect(by.flushIntervalMs!.value).toBe('1000')
    // No row in the engine: shown, not offered.
    expect(by.heartbeatMs).toMatchObject({ value: '', key: null })
    expect(paneRows([], { ...LIVE, context: null }).find((r) => r.setting.id === 'context')!.value).toBe('')
  })
  test('only a writable row with an engine key and no lock is changeable', () => {
    const by = Object.fromEntries(paneRows(ROWS, LIVE).map((r) => [r.setting.id, r]))
    expect(changeable(by.respond!)).toBe(true)
    expect(changeable(by.activityFeed!)).toBe(false)
    expect(changeable(by.server!)).toBe(false)
    expect(changeable(by.heartbeatMs!)).toBe(false)
  })
  test('the value set is the row\'s own kind, checked first', () => {
    const by = Object.fromEntries(paneRows(ROWS, LIVE).map((r) => [r.setting.id, r]))
    expect(engineValue(by.respond!, 'everything')).toEqual({ ok: true, value: 'everything' })
    expect(engineValue(by.peers!, 'false')).toEqual({ ok: true, value: false })
    expect(engineValue(by.flushIntervalMs!, '2500')).toEqual({ ok: true, value: 2500 })
    expect(engineValue(by.flushIntervalMs!, '100')).toEqual({ ok: false, reason: 'Report interval (ms) is a whole number of at least 200.' })
    expect(engineValue(by.respond!, 'off\nx').ok).toBe(false)
    expect(engineValue(by.server!, 'http://elsewhere')).toEqual({ ok: false, reason: 'Server cannot be changed here.' })
  })
  test('the pane asks for room for every line and the longest list', () => {
    // 8 rows, 4 groups, the connection and context hints, 2 footer lines, and the 4 choices of Respond.
    expect(paneHeight(paneRows(ROWS, LIVE))).toBe(8 + 4 + 2 + 2 + 4)
    expect(paneHeight([])).toBe(2)
  })
})
