import { describe, test, expect } from 'claude-code/testing'
import { parseSettingsFile, settingsPath, tooOpen, trustedSettings } from './settings.ts'

describe('trusted settings (#856)', () => {
  test('defaults: local server, no token, no name, every consent off', () => {
    const s = trustedSettings({}, null)
    expect(s).toMatchObject({ serverUrl: 'http://127.0.0.1:4317', token: '', userName: null })
    expect(Object.values(s.consent).every((v) => v === false)).toBe(true)
  })
  test('the environment wins over the file', () => {
    const s = trustedSettings({ PODIUM_TOKEN: 'env', PODIUM_SERVER: 'http://e' }, 'PODIUM_TOKEN=file\nPODIUM_SERVER=http://f\nPODIUM_USER=Dana\n')
    expect(s).toMatchObject({ token: 'env', serverUrl: 'http://e', userName: 'Dana' })
  })
  test('a variable set to nothing overrides the file, so one run can opt out', () => {
    expect(trustedSettings({ PODIUM_SESSION_RECORDING: '' }, 'PODIUM_SESSION_RECORDING=true').consent.sessionRecording).toBe(false)
  })
  test('a consent option is on only for exactly "true"', () => {
    const on = trustedSettings({ PODIUM_RESPOND: 'true', PODIUM_SESSION_RECORDING: 'yes', PODIUM_PEERS: '1' }, 'PODIUM_FILE_DIFF=true\nPODIUM_ACTIVITY_FEED=TRUE')
    expect(on.consent).toMatchObject({ respond: true, sessionRecording: false, peers: false, fileDiff: true, activityFeed: false })
  })
  test('PODIUM_RESPOND names how far answering goes, and a plain true is the lowest level', () => {
    const level = (v: string | undefined, file: string | null = null) => trustedSettings(v === undefined ? {} : { PODIUM_RESPOND: v }, file)
    expect(level(undefined).respondLevel).toBe('off')
    expect(level('true').respondLevel).toBe('questions')
    expect(level('questions').respondLevel).toBe('questions')
    expect(level('questions-and-plans').respondLevel).toBe('questions-and-plans')
    expect(level('everything').respondLevel).toBe('everything')
    expect(level(undefined, 'PODIUM_RESPOND=everything').respondLevel).toBe('everything')
    for (const v of ['', 'off', 'yes', 'EVERYTHING', 'all']) expect(level(v).respondLevel).toBe('off')
    expect(level('everything').consent.respond).toBe(true)
    expect(level('off').consent.respond).toBe(false)
  })
  test('explaining failures is a consent option, on only for "true"', () => {
    expect(trustedSettings({ PODIUM_EXPLAIN_FAILURES: 'true' }, null).consent.explainFailures).toBe(true)
    expect(trustedSettings({ PODIUM_EXPLAIN_FAILURES: '1' }, null).consent.explainFailures).toBe(false)
  })
  test('the reporter config file and context are trusted settings too (#948)', () => {
    expect(trustedSettings({}, null)).toMatchObject({ reporterConfig: '', reporterContext: '' })
    expect(trustedSettings({ PODIUM_REPORTER_CONFIG: '/e.pem' }, 'PODIUM_REPORTER_CONFIG=/f.pem\nPODIUM_REPORTER_CONTEXT=work')).toMatchObject({ reporterConfig: '/e.pem', reporterContext: 'work' })
  })
  test('the file is parsed leniently', () => {
    expect(parseSettingsFile('# c\n\nexport A="x y"\nB=\'z\'\nnoequals\n=bad\nC=1\nC=2')).toEqual({ A: 'x y', B: 'z', C: '2' })
    expect(parseSettingsFile(undefined)).toEqual({})
  })
  test('settingsPath needs an absolute home', () => {
    expect(settingsPath('/Users/dev/')).toBe('/Users/dev/.podium/config.env')
    expect(settingsPath('rel')).toBeNull()
    expect(settingsPath(undefined)).toBeNull()
  })
  test('tooOpen flags any group or other bit', () => {
    expect(tooOpen(0o600)).toBe(false)
    expect(tooOpen(0o640)).toBe(true)
    expect(tooOpen(0o604)).toBe(true)
  })
})
