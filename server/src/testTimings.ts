// Test-only timings (#791, DECISIONS 50). The end-to-end suite cannot wait 10 minutes for the Admin idle lock, 12 hours for the sign-in
// to respond to end, or 15 minutes for a lockout to lift, so it starts its throwaway server with shorter ones. They are read once at start
// and only count behind PODIUM_TEST_TIMINGS=1; a timing set without it stops the server, so a stray variable can never shorten the lock or
// the idle time of a real one. Nothing a person sees changes: only the numbers do.
import type { Logger } from './logging/logger.js';

export interface TestTimings {
  /** Idle time before Admin locks. */
  adminIdleMs?: number;
  /** Idle time before a sign-in to respond ends. */
  signInIdleMs?: number;
  /** How long five wrong tries lock an address. */
  lockMs?: number;
}

const FLAG = 'PODIUM_TEST_TIMINGS';
const KNOBS = [
  ['PODIUM_TEST_ADMIN_IDLE_MS', 'adminIdleMs'],
  ['PODIUM_TEST_SIGN_IN_IDLE_MS', 'signInIdleMs'],
  ['PODIUM_TEST_LOCK_MS', 'lockMs'],
] as const;

/** parseTestTimings, and a warning in the log when any timing is in effect, so a test server is never mistaken for a real one. */
export function readTestTimings(env: Record<string, string | undefined>, logger: Logger): TestTimings {
  const timings = parseTestTimings(env);
  if (Object.keys(timings).length > 0) logger.warn('server.test_timings', 'podium: TEST TIMINGS are on (PODIUM_TEST_TIMINGS=1): idle and lock times are shortened. Never set this on a real server.', { ...timings });
  return timings;
}

/** Reads the test timings from the environment: none when unset, a whole number of milliseconds (1 to 999999999) each when the flag is on. Throws on anything else. */
export function parseTestTimings(env: Record<string, string | undefined>): TestTimings {
  const flag = (env[FLAG] ?? '').trim();
  if (flag !== '' && flag !== '0' && flag !== '1') throw new Error(`${FLAG}: "${flag}" is not 0 or 1`);
  const out: TestTimings = {};
  for (const [name, key] of KNOBS) {
    const value = (env[name] ?? '').trim();
    if (value === '') continue;
    if (flag !== '1') throw new Error(`${name} is for tests and needs ${FLAG}=1`);
    if (!/^\d{1,9}$/.test(value) || Number(value) < 1) throw new Error(`${name}: "${value}" is not a whole number of milliseconds of at least 1`);
    out[key] = Number(value);
  }
  return out;
}
