// #1113: the days a harness lets a person resume a session, which is how long Podium keeps its chat.
import { describe, test, expect } from 'claude-code/testing'
import { DEFAULT_RESUME_WINDOW_DAYS, MAX_RESUME_WINDOW_DAYS, resumeWindowDays, resumeWindowFromSettings, claudeSettingsPath } from './resumeWindow.ts'

describe('resumeWindowDays', () => {
  test('a harness with no expiry gets the Claude Code default of 30 days', () => {
    expect(DEFAULT_RESUME_WINDOW_DAYS).toBe(30)
    expect(resumeWindowDays(undefined)).toBe(30)
    expect(resumeWindowDays(null)).toBe(30)
  })

  test('a whole number of days from the harness is the window', () => {
    expect(resumeWindowDays(7)).toBe(7)
    expect(resumeWindowDays(90)).toBe(90)
    expect(resumeWindowDays(2.9)).toBe(2)
  })

  test('a value that is not a usable number of days falls back to the default', () => {
    for (const bad of [0, -5, Number.NaN, Infinity, '30', true, {}, []]) expect(resumeWindowDays(bad)).toBe(30)
  })

  test('a window is capped so a stray number cannot keep chat for ever', () => {
    expect(resumeWindowDays(MAX_RESUME_WINDOW_DAYS)).toBe(MAX_RESUME_WINDOW_DAYS)
    expect(resumeWindowDays(MAX_RESUME_WINDOW_DAYS + 1)).toBe(MAX_RESUME_WINDOW_DAYS)
    expect(resumeWindowDays(1e12)).toBe(MAX_RESUME_WINDOW_DAYS)
  })
})

describe('resumeWindowFromSettings', () => {
  test('reads cleanupPeriodDays from Claude Code settings text', () => {
    expect(resumeWindowFromSettings('{"cleanupPeriodDays": 14}')).toBe(14)
  })

  test('no file, bad JSON, a non-object or no key all mean the default', () => {
    for (const text of [null, '', 'not json', '[]', '7', 'null', '{}', '{"cleanupPeriodDays":"x"}', '{"cleanupPeriodDays":0}']) expect(resumeWindowFromSettings(text)).toBe(30)
  })
})

describe('claudeSettingsPath', () => {
  test('is under CLAUDE_CONFIG_DIR when set, else ~/.claude', () => {
    expect(claudeSettingsPath('/cfg/', '/home/a')).toBe('/cfg/settings.json')
    expect(claudeSettingsPath(undefined, '/home/a/')).toBe('/home/a/.claude/settings.json')
    expect(claudeSettingsPath('C:\\cfg', undefined)).toBe('C:\\cfg/settings.json')
  })

  test('is null when the directory is not absolute, so each session cannot read its own', () => {
    expect(claudeSettingsPath('rel', '/home/a')).toBeNull()
    expect(claudeSettingsPath(undefined, undefined)).toBeNull()
    expect(claudeSettingsPath(undefined, 'home')).toBeNull()
  })
})
