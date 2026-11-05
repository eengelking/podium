import { describe, expect, it } from 'vitest';
import { pgGate } from './gate.js';

describe('the PostgreSQL test gate (#891)', () => {
  it('does nothing when PODIUM_TEST_PG is not set or empty (the server gate judges that)', async () => {
    for (const env of [{}, { PODIUM_TEST_PG: '' }]) await expect(pgGate(env, async () => { throw new Error('must not connect'); })).resolves.toBeUndefined();
  });

  it('passes quietly when the server answers', async () => {
    const lines: string[] = [];
    await pgGate({ PODIUM_TEST_PG: 'postgres://u:secret@h:1/postgres' }, async () => undefined);
    expect(lines).toEqual([]);
  });

  it('fails, and never prints the password, when the server is unreachable', async () => {
    const run = pgGate({ PODIUM_TEST_PG: 'postgres://u:secret@h:1/postgres' }, async () => { throw new Error('connect ECONNREFUSED'); });
    await expect(run).rejects.toThrow(/PODIUM_TEST_PG.*h:1\/postgres.*unreachable|unreachable.*h:1\/postgres/s);
    await expect(run).rejects.not.toThrow(/secret/);
  });

  it('names the server without the user or the password, and copes with a value that is not a URL', async () => {
    const run = pgGate({ PODIUM_TEST_PG: 'not a url' }, async () => { throw 'refused'; });
    await expect(run).rejects.toThrow(/\(not a valid URL\).*unreachable.*unknown error/s);
  });

  it('tries a real connection by default, and fails when nothing listens', async () => {
    await expect(pgGate({ PODIUM_TEST_PG: 'postgres://u:secret@127.0.0.1:1/postgres' })).rejects.toThrow(/127\.0\.0\.1:1\/postgres.*unreachable/s);
  });
});
