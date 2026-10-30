// Test-only timings for the end-to-end suite (#791): shorter idle and lock times, only behind PODIUM_TEST_TIMINGS=1.
import { describe, expect, it } from 'vitest';
import { ADMIN_IDLE_MS } from './admin/adminRouter.js';
import { Lockout } from './fleet/lockout.js';
import { SIGN_IN_IDLE_MS } from './fleet/respondRoutes.js';
import { createLogger } from './logging/logger.js';
import { parseTestTimings, readTestTimings } from './testTimings.js';

describe('readTestTimings', () => {
  const logsFor = (env: Record<string, string | undefined>) => {
    const logs: Array<{ event: string; level: string; lockMs?: number }> = [];
    const logger = createLogger({ format: 'json', write: (line: string) => void logs.push(JSON.parse(line)) });
    return { timings: readTestTimings(env, logger), logs };
  };

  it('warns once, with the timings in effect, when any is on', () => {
    const { timings, logs } = logsFor({ PODIUM_TEST_TIMINGS: '1', PODIUM_TEST_LOCK_MS: '6000' });
    expect(timings).toEqual({ lockMs: 6000 });
    const warns = logs.filter((l) => l.event === 'server.test_timings');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ level: 'warn', lockMs: 6000 });
  });

  it('says nothing and changes nothing when none is set', () => {
    const { timings, logs } = logsFor({});
    expect(timings).toEqual({});
    expect(logs).toEqual([]);
  });

  it('says nothing when the flag is on and no timing is set', () => {
    expect(logsFor({ PODIUM_TEST_TIMINGS: '1' }).logs).toEqual([]);
  });
});

describe('the defaults', () => {
  it('stay 10 minutes for the Admin idle lock, 12 hours for the sign-in to respond and 15 minutes (after 5 wrong tries) for the lockout', () => {
    expect(ADMIN_IDLE_MS).toBe(10 * 60_000);
    expect(SIGN_IN_IDLE_MS).toBe(12 * 3_600_000);
    const lockout = new Lockout();
    expect(lockout.maxFails).toBe(5);
    expect(lockout.lockMs).toBe(15 * 60_000);
  });
});

describe('parseTestTimings', () => {
  it('changes nothing when nothing is set', () => {
    expect(parseTestTimings({})).toEqual({});
  });

  it('reads the three timings, in milliseconds, when the test flag is on', () => {
    const env = { PODIUM_TEST_TIMINGS: '1', PODIUM_TEST_ADMIN_IDLE_MS: '4000', PODIUM_TEST_SIGN_IN_IDLE_MS: '5000', PODIUM_TEST_LOCK_MS: '6000' };
    expect(parseTestTimings(env)).toEqual({ adminIdleMs: 4000, signInIdleMs: 5000, lockMs: 6000 });
  });

  it('reads only the ones that are set', () => {
    expect(parseTestTimings({ PODIUM_TEST_TIMINGS: '1', PODIUM_TEST_LOCK_MS: '6000' })).toEqual({ lockMs: 6000 });
  });

  it('ignores the flag when it is on and no timing is set', () => {
    expect(parseTestTimings({ PODIUM_TEST_TIMINGS: '1' })).toEqual({});
  });

  it('refuses a timing without the flag, so a stray variable cannot shorten a real server', () => {
    expect(() => parseTestTimings({ PODIUM_TEST_LOCK_MS: '6000' })).toThrow(/PODIUM_TEST_LOCK_MS.*PODIUM_TEST_TIMINGS=1/);
    expect(() => parseTestTimings({ PODIUM_TEST_TIMINGS: '0', PODIUM_TEST_ADMIN_IDLE_MS: '4000' })).toThrow(/PODIUM_TEST_ADMIN_IDLE_MS/);
  });

  it.each(['abc', '0', '-5', '1.5', '1e3', '1234567890123'])('stops the server at start on a timing of "%s"', (bad) => {
    expect(() => parseTestTimings({ PODIUM_TEST_TIMINGS: '1', PODIUM_TEST_SIGN_IN_IDLE_MS: bad })).toThrow(/PODIUM_TEST_SIGN_IN_IDLE_MS/);
  });

  it('stops the server at start on a flag that is neither unset, 0 nor 1', () => {
    expect(() => parseTestTimings({ PODIUM_TEST_TIMINGS: 'yes' })).toThrow(/PODIUM_TEST_TIMINGS/);
  });
});
