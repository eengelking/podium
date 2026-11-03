// problems.ts: what an error code means to the person, word for word (#584, #650, #672, #948).
import { describe, test, expect } from 'claude-code/testing'
import { CLOCK_SKEW_MS, configProblemFor, problemFor } from './problems.ts'

const NOW = Date.parse('2026-02-01T00:00:00Z')

describe('what a helper error means to the person (#584)', () => {
  test('each failure a person can act on has words, and an outage has none', () => {
    expect(problemFor('CLIENT_CERT_REJECTED', 'h')?.text).toContain('Admin')
    expect(problemFor('ALTNAME', 'podium.lan:4318')?.text).toContain('podium.lan:4318')
    expect(problemFor('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'h')?.text).toContain('CA')
    expect(problemFor('CERT_HAS_EXPIRED', 'h')?.status).toBe('server certificate expired')
    expect(problemFor('ECONNREFUSED', 'h')).toBeNull()
  })

  test('the three ways a server certificate fails to chain to the CA read the same', () => {
    for (const code of ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
      expect(problemFor(code, 'h')).toEqual({ code, status: 'server not trusted', text: 'The server’s certificate is not signed by the CA in your reporter config file. Ask an Admin for a new file.' })
    }
  })

  test('a wrong server name, a refused certificate and any other certificate code have their own words', () => {
    expect(problemFor('ALTNAME', 'podium.lan:4318')).toEqual({ code: 'ALTNAME', status: 'wrong server name', text: "The server's certificate is not for podium.lan:4318. The address in the reporter config file does not match the server." })
    expect(problemFor('CLIENT_CERT_REJECTED', 'h')).toMatchObject({ status: 'certificate refused' })
    expect(problemFor('CERT_HAS_EXPIRED', 'h')?.text).toBe("The server's own certificate has expired. Tell whoever runs the Podium server.")
    expect(problemFor('CERT_REVOKED', 'h')).toEqual({ code: 'CERT_REVOKED', status: 'server certificate refused', text: "The server's certificate was refused (CERT_REVOKED)." })
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
    expect(problemFor('CERT_HAS_EXPIRED', 'h', { now: NOW, serverNow: NOW - CLOCK_SKEW_MS })?.status).toBe('server certificate expired')
    expect(problemFor('CERT_HAS_EXPIRED', 'h', { now: NOW, serverNow: NOW - CLOCK_SKEW_MS - 1 })?.status).toBe('check the clock')
  })

  test('an expired certificate names the date and asks for a new config, and a renewal the server refused asks for a reissue (#585, #665)', () => {
    expect(problemFor('CERT_EXPIRED', 'h', undefined, '2026-01-15')).toMatchObject({ status: 'certificate expired' })
    expect(problemFor('CERT_EXPIRED', 'h', undefined, '2026-01-15')?.text).toBe('Your Podium certificate expired on 2026-01-15. Ask an Admin to generate a new reporter config.')
    expect(problemFor('CERT_EXPIRED', 'h')?.text).toContain('Admin')
    expect(problemFor('CERT_PAST_GRACE', 'h')).not.toMatchObject({ status: 'certificate expired' })
    expect(problemFor('CERT_RENEWAL_REFUSED', 'h')).toMatchObject({ status: 'certificate refused' })
    expect(problemFor('CERT_RENEWAL_REFUSED', 'h')?.text).toContain('reissue')
  })

  test('a connection closed right after the handshake is worded as a maybe, not as a revoked certificate', () => {
    const t = problemFor('CLOSED_AFTER_HANDSHAKE', 'h')
    expect(t?.status).toBe('server closed connection')
    expect(t?.text).toContain('restarted')
    expect(t?.text).toContain('did not accept your certificate')
  })
})

describe('what a config file failure means to the person (#672, #948)', () => {
  test('a config file other people can read says how to close it', () => {
    expect(configProblemFor('CONFIG_PERMISSIONS', undefined, '/p')).toEqual({ code: 'CONFIG_PERMISSIONS', status: 'config too open', text: 'The reporter config file /p can be read by other people, and it holds your private key. Run: chmod 600 /p' })
  })

  test('a file that cannot be used says why, in the status line cut to fit and in the sentence whole', () => {
    expect(configProblemFor('CONFIG_INVALID', 'x', '/p')).toEqual({ code: 'CONFIG_INVALID', status: 'config unreadable: x', text: 'The reporter config file /p cannot be used: x.' })
    expect(configProblemFor('CONFIG_MISSING', undefined, '/p')).toEqual({ code: 'CONFIG_MISSING', status: 'config unreadable', text: 'The reporter config file /p cannot be used: CONFIG_MISSING.' })
    expect(configProblemFor('CONFIG_INVALID', '', '/p')?.status).toBe('config unreadable')
    const long = configProblemFor('CONFIG_INVALID', 'x'.repeat(200), '/p')
    expect(long?.status).toBe(`config unreadable: ${'x'.repeat(59)}…`)
    expect(long?.text).toBe(`The reporter config file /p cannot be used: ${'x'.repeat(200)}.`)
    expect(configProblemFor('CONFIG_INVALID', 'x'.repeat(60), '/p')?.status).toBe(`config unreadable: ${'x'.repeat(60)}`)
  })

  test('any other code is not about the config file, and each reporter words it for its own connection', () => {
    expect(configProblemFor('HELPER_EXITED', undefined, '/p')).toBeNull()
    expect(configProblemFor('CERT_EXPIRED', 'x', '/p')).toBeNull()
  })
})
