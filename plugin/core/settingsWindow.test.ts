// The settings window's shared description (#1001): the same rows and words for every harness, and the allow-list a write goes through.
import { describe, test, expect } from 'claude-code/testing'
import {
  checkValue,
  envLock,
  hintOf,
  isConfigArgs,
  isNarrow,
  labelOf,
  lockedBy,
  noWindowText,
  rowLine,
  settingById,
  settingByEnv,
  settingsFor,
  shownValue,
  SETTINGS,
  WRITABLE_KEYS,
  WRITABLE_OPTIONS,
  writeSettingsLine,
} from './settingsWindow.ts'

const row = (id: string) => settingById(id)!

describe('the rows each harness shows (#1001)', () => {
  test('Claude Code: its options, in group order, with the context row', () => {
    expect(settingsFor('claudecode').map((s) => s.id)).toEqual(['respond', 'peers', 'activityFeed', 'server', 'userName', 'flushIntervalMs', 'heartbeatMs', 'context'])
  })
  test('OpenCode: its PODIUM_* settings, with the context row', () => {
    expect(settingsFor('opencode').map((s) => s.id)).toEqual(['respond', 'peers', 'activityFeed', 'server', 'userName', 'idleSeconds', 'context'])
  })
  test('the token is never a row, and the connection is shown only', () => {
    expect(SETTINGS.some((s) => /token/i.test(`${s.id} ${s.option} ${s.env}`))).toBe(false)
    expect(row('server').editable).toBe(false)
    expect(row('userName').editable).toBe(false)
  })
  test('the allow-lists hold the consent and timing rows only', () => {
    expect([...WRITABLE_KEYS].sort()).toEqual(['PODIUM_ACTIVITY_FEED', 'PODIUM_IDLE_SECONDS', 'PODIUM_PEERS', 'PODIUM_RESPOND'])
    expect([...WRITABLE_OPTIONS].sort()).toEqual(['activityFeed', 'flushIntervalMs', 'heartbeatMs', 'peers', 'respond'])
  })
})

describe('words', () => {
  test('narrow widths take the short label', () => {
    expect(isNarrow(50)).toBe(true)
    expect(isNarrow(100)).toBe(false)
    expect(isNarrow(undefined)).toBe(false)
    expect(isNarrow(0)).toBe(false)
    expect(labelOf(row('respond'), true)).toBe('Respond')
    expect(labelOf(row('respond'), false)).toBe('Respond from Podium')
  })
  test('a value reads as on or off, or not set', () => {
    expect(shownValue(row('peers'), 'true')).toBe('on')
    expect(shownValue(row('peers'), 'false')).toBe('off')
    expect(shownValue(row('userName'), '')).toBe('not set')
    expect(shownValue(row('respond'), 'everything')).toBe('everything')
  })
  test('a menu line names what decides a locked row', () => {
    expect(rowLine(row('respond'), 'everything', false, null)).toBe('Respond from Podium: everything')
    expect(rowLine(row('peers'), 'true', true, 'PODIUM_PEERS')).toBe('Peers: on ▲ set by PODIUM_PEERS')
    expect(lockedBy('managed settings')).toBe('set by managed settings')
  })
  test('each kind has its hint', () => {
    expect(hintOf(row('respond'), 'opencode')).toBe('off, questions, questions-and-plans, everything')
    expect(hintOf(row('peers'), 'opencode')).toBe('on or off')
    expect(hintOf(row('idleSeconds'), 'opencode')).toBe('at least 5')
    expect(hintOf(row('context'), 'claudecode')).toMatch(/\/podium context use/)
    expect(hintOf(row('server'), 'claudecode')).toMatch(/\/plugin configure podium-reporter/)
    expect(hintOf(row('server'), 'opencode')).toMatch(/PODIUM_SERVER/)
  })
  test('with no window, each harness says where its settings are, read at the next start', () => {
    expect(noWindowText('claudecode', null)).toBe('No settings window in this mode.\nRun /plugin configure podium-reporter.')
    expect(noWindowText('opencode', '/h/.podium/config.env')).toContain('Your settings are in /h/.podium/config.env.')
    expect(noWindowText('opencode', null)).toContain('~/.podium/config.env')
    expect(noWindowText('opencode', null)).toContain('They are read at the next start.')
  })
  test('/podium config is the word alone, in any case', () => {
    expect(isConfigArgs(' config ')).toBe(true)
    expect(isConfigArgs('CONFIG')).toBe(true)
    expect(isConfigArgs('config x')).toBe(false)
    expect(isConfigArgs(undefined)).toBe(false)
  })
})

describe('environment locks', () => {
  test('a variable that is set, even to nothing, decides the row', () => {
    expect(envLock(row('respond'), { PODIUM_RESPOND: '' })).toBe('PODIUM_RESPOND')
    expect(envLock(row('respond'), {})).toBeNull()
    expect(envLock(row('flushIntervalMs'), { PODIUM_RESPOND: 'x' })).toBeNull()
  })
})

describe('checkValue', () => {
  test('a choice is one of its values', () => {
    expect(checkValue(row('respond'), 'everything')).toEqual({ ok: true, value: 'everything' })
    expect(checkValue(row('respond'), 'all').ok).toBe(false)
  })
  test('a switch is true or false', () => {
    expect(checkValue(row('peers'), 'true')).toEqual({ ok: true, value: 'true' })
    expect(checkValue(row('peers'), 'yes').ok).toBe(false)
  })
  test('a number is whole and at least its lowest', () => {
    expect(checkValue(row('idleSeconds'), ' 60 ')).toEqual({ ok: true, value: '60' })
    expect(checkValue(row('idleSeconds'), '4').ok).toBe(false)
    expect(checkValue(row('idleSeconds'), '6.5').ok).toBe(false)
    expect(checkValue(row('idleSeconds'), '1e3').ok).toBe(false)
    expect(checkValue(row('idleSeconds'), '0x20').ok).toBe(false)
    expect(checkValue(row('idleSeconds'), '+60').ok).toBe(false)
    expect(checkValue(row('idleSeconds'), '').ok).toBe(false)
    expect(checkValue(row('flushIntervalMs'), 'abc').ok).toBe(false)
  })
  test('a line break, a control character or a shown-only row is refused', () => {
    const broken = checkValue(row('respond'), 'off\nPODIUM_PEERS=true')
    expect(broken.ok).toBe(false)
    expect(broken.ok ? '' : broken.reason).toMatch(/line break/)
    expect(checkValue(row('peers'), 'true\r')).toMatchObject({ ok: false })
    expect(checkValue(row('peers'), 'true\u007f')).toMatchObject({ ok: false })
    expect(checkValue(row('server'), 'http://elsewhere')).toMatchObject({ ok: false, reason: 'Server cannot be changed here.' })
  })
})

describe('writeSettingsLine', () => {
  const file = '# mine\nPODIUM_SERVER=http://s\nPODIUM_TOKEN=secret\nexport PODIUM_RESPOND=off\nPODIUM_RESPOND = questions\n\n'
  test('replaces every line for the key, keeps the rest and the token as they were', () => {
    expect(writeSettingsLine(file, 'PODIUM_RESPOND', 'everything')).toBe('# mine\nPODIUM_SERVER=http://s\nPODIUM_TOKEN=secret\nPODIUM_RESPOND=everything\n')
  })
  test('starts a file that is not there', () => {
    expect(writeSettingsLine(null, 'PODIUM_PEERS', 'true')).toBe('PODIUM_PEERS=true\n')
  })
  test('a key off the allow-list is never written', () => {
    for (const key of ['PODIUM_TOKEN', 'PODIUM_SERVER', 'PODIUM_USER', 'PODIUM_SESSION_RECORDING', 'PATH']) expect(writeSettingsLine(file, key, 'true')).toBeNull()
  })
  test('a value checkValue refuses is never written', () => {
    expect(writeSettingsLine(file, 'PODIUM_RESPOND', 'off\nPODIUM_TOKEN=x')).toBeNull()
    expect(writeSettingsLine(file, 'PODIUM_IDLE_SECONDS', '1')).toBeNull()
  })
  test('a key that only starts with the same letters is kept', () => {
    expect(writeSettingsLine('PODIUM_PEERS_X=1\n', 'PODIUM_PEERS', 'false')).toBe('PODIUM_PEERS_X=1\nPODIUM_PEERS=false\n')
  })
  test('settingByEnv finds the row a key names', () => {
    expect(settingByEnv('PODIUM_IDLE_SECONDS')?.id).toBe('idleSeconds')
    expect(settingByEnv('NOPE')).toBeUndefined()
  })
})
