import { describe, expect, it, vi } from 'vitest';
import { pgGate, PG_SKIP_NOTICE } from './gate.js';
import { TEST_PG } from './testing.js';

describe('the PostgreSQL test gate (#891)', () => {
  it('says the suite is skipped, and how to run it, when PODIUM_TEST_PG is not set', async () => {
    const lines: string[] = [];
    await pgGate({}, async () => { throw new Error('must not connect'); }, (l) => lines.push(l));
    expect(lines.join('\n')).toBe(PG_SKIP_NOTICE);
    expect(PG_SKIP_NOTICE).toContain('SKIPPED');
    expect(PG_SKIP_NOTICE).toContain('scripts/test-pg.sh');
  });

  it('treats an empty PODIUM_TEST_PG as not set', async () => {
    const lines: string[] = [];
    await pgGate({ PODIUM_TEST_PG: '' }, async () => { throw new Error('no'); }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
  });

  it('passes quietly when the server answers', async () => {
    const lines: string[] = [];
    await pgGate({ PODIUM_TEST_PG: 'postgres://u:secret@h:1/postgres' }, async () => undefined, (l) => lines.push(l));
    expect(lines).toEqual([]);
  });

  it('fails, and never prints the password, when the server is unreachable', async () => {
    const run = pgGate({ PODIUM_TEST_PG: 'postgres://u:secret@h:1/postgres' }, async () => { throw new Error('connect ECONNREFUSED'); }, () => undefined);
    await expect(run).rejects.toThrow(/PODIUM_TEST_PG.*h:1\/postgres.*unreachable|unreachable.*h:1\/postgres/s);
    await expect(run).rejects.not.toThrow(/secret/);
  });

  it('names the server without the user or the password, and copes with a value that is not a URL', async () => {
    const run = pgGate({ PODIUM_TEST_PG: 'not a url' }, async () => { throw 'refused'; }, () => undefined);
    await expect(run).rejects.toThrow(/\(not a valid URL\).*unreachable.*unknown error/s);
  });

  it('tries a real connection by default, and fails when nothing listens', async () => {
    await expect(pgGate({ PODIUM_TEST_PG: 'postgres://u:secret@127.0.0.1:1/postgres' })).rejects.toThrow(/127\.0\.0\.1:1\/postgres.*unreachable/s);
  });

  it('reads the variable from the environment when given no env, and prints the notice or passes', async () => {
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((l: string) => { lines.push(l); });
    try {
      await pgGate(undefined, undefined, undefined);
    } finally { warn.mockRestore(); }
    expect(lines.length).toBe(TEST_PG ? 0 : 1);
  });
});
