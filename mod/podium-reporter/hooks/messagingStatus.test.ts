import { describe, test, expect } from 'claude-code/testing'
import { connectionLine, messagingLine, messagingOffReason, nonBooleanOptions, optionProblem, type MessagingFacts } from './messagingStatus.ts'

const ON: MessagingFacts = {
  option: true,
  interactive: true,
  surface: 'terminal',
  serverSays: true,
  signedIn: true,
  reported: true,
  ended: false,
}

describe('messagingOffReason: the one cause, in the order the mod can know it', () => {
  test('null when messaging is on', () => {
    expect(messagingOffReason(ON)).toBeNull()
  })

  test('the option is off', () => {
    expect(messagingOffReason({ ...ON, option: false })).toContain("the peers option is off on this machine")
  })

  test('the session is not interactive', () => {
    expect(messagingOffReason({ ...ON, interactive: false, surface: null })).toContain('not interactive')
  })

  test('no per-person token or userName', () => {
    expect(messagingOffReason({ ...ON, signedIn: false })).toContain('userName')
  })

  test('the session has not reported yet', () => {
    expect(messagingOffReason({ ...ON, reported: false, serverSays: false })).toContain('has not reported yet')
  })

  test('the server says no after a report: the flag is off or the admin secret is used', () => {
    const why = messagingOffReason({ ...ON, serverSays: false }) ?? ''
    expect(why).toContain("Podium's messaging flag is off")
    expect(why).toContain('admin secret')
  })

  test('the session has ended', () => {
    expect(messagingOffReason({ ...ON, ended: true })).toContain('ended')
  })

  test('the option comes before the others', () => {
    expect(messagingOffReason({ ...ON, option: false, interactive: false, signedIn: false, serverSays: false })).toContain('peers option is off')
  })
})

describe('messagingLine', () => {
  test('on: names the option, the surface and what the server said', () => {
    expect(messagingLine(ON)).toBe('Messaging: on. peers option: on; interactive: yes (started on terminal); Podium says: takes part')
  })

  test('off: the line carries the reason', () => {
    expect(messagingLine({ ...ON, option: false, serverSays: false })).toBe(
      'Messaging: off, because the peers option is off on this machine: turn it on in podium-reporter\'s settings. peers option: off; interactive: yes (started on terminal); Podium says: does not take part',
    )
  })

  test('a session with no surface says none', () => {
    expect(messagingLine({ ...ON, interactive: false, surface: null })).toContain('interactive: no (started on no surface)')
  })

  test('before the first reply the server has said nothing', () => {
    expect(messagingLine({ ...ON, reported: false, serverSays: false })).toContain('Podium says: nothing yet')
  })
})

describe('nonBooleanOptions', () => {
  test('names each boolean option whose value is not a boolean', () => {
    expect(nonBooleanOptions({ peers: 'true', fileDiff: 1, showStatus: false, userName: 'Ed' })).toEqual([
      { name: 'fileDiff', got: '1' },
      { name: 'peers', got: '"true"' },
    ])
  })

  test('an unset option is not a mistake', () => {
    expect(nonBooleanOptions({})).toEqual([])
    expect(nonBooleanOptions({ peers: undefined, sessionRecording: null })).toEqual([])
  })

  test('any text but true or false is not echoed, and an object is named by its kind', () => {
    const got = nonBooleanOptions({ peers: 'x'.repeat(40), activityFeed: {}, fileDiff: [] })
    expect(got.find((g) => g.name === 'peers')!.got).toBe('a text')
    expect(got.find((g) => g.name === 'activityFeed')!.got).toBe('an object')
    expect(got.find((g) => g.name === 'fileDiff')!.got).toBe('a list')
  })
})

describe('connectionLine: token or reporter config file', () => {
  test('a plain token names the user and says so without the token', () => {
    expect(connectionLine({ configPath: null, tokenSet: true })).toBe('Sign-in: a plain token (not a reporter config file)')
  })

  test('a reporter config file names the file', () => {
    expect(connectionLine({ configPath: '/home/ed/.podium/ed.json', tokenSet: true })).toBe('Sign-in: reporter config file /home/ed/.podium/ed.json (mTLS)')
  })

  test('neither', () => {
    expect(connectionLine({ configPath: null, tokenSet: false })).toBe('Sign-in: none (no token and no reporter config file)')
  })
})

describe('optionProblem', () => {
  test('names the option and what the mod got', () => {
    expect(optionProblem({ name: 'peers', got: '"true"' })).toBe(
      "Option problem: peers must be true or false, but the mod got \"true\", so it ignores it and uses the default. Fix it in podium-reporter's settings.",
    )
  })
})
