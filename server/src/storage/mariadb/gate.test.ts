import { describe, expect, it } from 'vitest';
import { mariaGate } from './gate.js';

describe('the MariaDB test gate (#823, as #891)', () => {
  it('does nothing when PODIUM_TEST_MARIADB is not set or empty (the server gate judges that)', async () => {
    for (const env of [{}, { PODIUM_TEST_MARIADB: '' }]) await expect(mariaGate(env, async () => { throw new Error('must not connect'); })).resolves.toBeUndefined();
  });

  it('passes quietly when the server answers', async () => {
    await expect(mariaGate({ PODIUM_TEST_MARIADB: 'mariadb://u:secret@h:1/podium' }, async () => undefined)).resolves.toBeUndefined();
  });

  it('fails, and never prints the password, when the server is unreachable', async () => {
    const run = mariaGate({ PODIUM_TEST_MARIADB: 'mariadb://u:secret@h:1/podium' }, async () => { throw new Error('connect ECONNREFUSED (password secret)'); });
    await expect(run).rejects.toThrow(/PODIUM_TEST_MARIADB.*h:1\/podium.*unreachable/s);
    await expect(run).rejects.not.toThrow(/secret/);
  });

  it('names the server without the user or the password, and copes with a value that is not a URL', async () => {
    const run = mariaGate({ PODIUM_TEST_MARIADB: 'not a url' }, async () => { throw 'refused'; });
    await expect(run).rejects.toThrow(/\(not a valid URL\).*unreachable.*unknown error/s);
  });

  it('tries a real connection by default, and fails when nothing listens', async () => {
    await expect(mariaGate({ PODIUM_TEST_MARIADB: 'mariadb://u:secret@127.0.0.1:1/podium' })).rejects.toThrow(/127\.0\.0\.1:1\/podium.*unreachable/s);
  });
});
