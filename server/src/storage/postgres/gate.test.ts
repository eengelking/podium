import { describe, expect, it } from 'vitest';
import { pgGate, PG_SKIP_NOTICE } from './gate.js';

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
});
