// The single-process lock when its connection drops (#822): taken again once, or the storage fails closed and says so.
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPostgresStorage } from './index.js';
import { SINGLE_PROCESS_LOCK_KEY } from './conn.js';
import { exitOnLockLost } from './singleProcess.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

const target = (td: TestDatabase): string => td.url.replace(/^postgres:\/\//, '');
const FAST = { attempts: 4, delayMs: 100 };

/** Runs `fn` on a client of its own, and ends it. */
async function withClient<T>(td: TestDatabase, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: td.url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** The backends that hold the advisory lock now. */
const holders = (td: TestDatabase) =>
  withClient(td, async (c) => (await c.query<{ pid: number; application_name: string }>(
    `SELECT l.pid, a.application_name FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND l.granted AND a.datname = current_database()`,
  )).rows);

/** Polls (at most `ms`) until `ok()` holds; throws with `what` when it does not. */
async function until(what: string, ok: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe.skipIf(!TEST_PG)('single-process lock on a dropped connection', () => {
  const dbs: TestDatabase[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await Promise.race([c().catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
    for (const d of dbs.splice(0)) await d.drop();
  });
  const fresh = async (): Promise<TestDatabase> => {
    const td = await createTestDatabase();
    dbs.push(td);
    return td;
  };
  const killLock = (td: TestDatabase) =>
    withClient(td, (c) => c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'podium-lock' AND datname = current_database()`));

  it('takes the lock again on a new connection and keeps serving', async () => {
    const td = await fresh();
    const lost = vi.fn();
    const s = await openPostgresStorage(target(td), Date.now(), lost, FAST);
    closers.push(() => s.close());
    const [before] = await holders(td);
    await killLock(td);
    await until('the lock to be held by a new connection', async () => {
      const h = await holders(td);
      return h.length === 1 && h[0]!.pid !== before!.pid && h[0]!.application_name === 'podium-lock';
    });
    expect(lost).not.toHaveBeenCalled();
    await s.people.createGroup('After the drop', 1);
    expect((await s.people.allGroups()).map((g) => g.name)).toContain('After the drop');
    // The new connection holds it: a second server is still refused.
    await expect(openPostgresStorage(target(td), Date.now(), lost, FAST)).rejects.toThrow(/already using this database/);
  });

  it('fails closed when another server took the lock in between, and calls the hook once', async () => {
    const td = await fresh();
    const lost = vi.fn();
    const s = await openPostgresStorage(target(td), Date.now(), lost, { attempts: 3, delayMs: 300 });
    closers.push(() => s.close());
    const other = new pg.Client({ connectionString: td.url });
    await other.connect();
    closers.push(() => other.end());
    await killLock(td);
    // The dropped session frees the lock a moment after the kill; the other server takes it in that window.
    await until('the other server to get the lock', async () => (await other.query('SELECT pg_try_advisory_lock($1) AS ok', [SINGLE_PROCESS_LOCK_KEY])).rows[0].ok === true);
    await until('the hook to be called', () => lost.mock.calls.length > 0);
    expect(lost).toHaveBeenCalledTimes(1);
    const err = lost.mock.calls[0]![0] as Error;
    expect(err.message).toContain(`${new URL(td.url).host}${new URL(td.url).pathname}`);
    expect(err.message).not.toContain('@');
    expect(err.message).not.toContain(`${new URL(td.url).username}:`);
    // Every later call rejects with that message, on the stores and on a transaction.
    await expect(s.people.allGroups()).rejects.toThrow(/lost/i);
    await expect(s.tx(async () => 1)).rejects.toThrow(/lost/i);
  });

  it('fails closed when the lock cannot be taken again within the attempts', async () => {
    const td = await fresh();
    const lost = vi.fn();
    const s = await openPostgresStorage(target(td), Date.now(), lost, { attempts: 2, delayMs: 50 });
    closers.push(() => s.close());
    // Dropping the database ends every connection and leaves nothing to connect to.
    await withClient({ ...td, url: TEST_PG! }, (c) => c.query(`DROP DATABASE ${new URL(td.url).pathname.slice(1)} WITH (FORCE)`));
    await until('the hook to be called', () => lost.mock.calls.length > 0);
    expect((lost.mock.calls[0]![0] as Error).message).toMatch(/lost/i);
    await expect(s.people.allGroups()).rejects.toThrow(/lost/i);
  });

  it('does not treat a release as a loss', async () => {
    const td = await fresh();
    const lost = vi.fn();
    const s = await openPostgresStorage(target(td), Date.now(), lost, FAST);
    await s.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(lost).not.toHaveBeenCalled();
    expect(await holders(td)).toEqual([]);
  });
});

describe('the default reaction to a lost lock', () => {
  it('writes one line with the label, sets the exit code and asks the process to stop', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const code = process.exitCode;
    try {
      exitOnLockLost(new Error('Podium lost its lock on db.lan:5432/podium.'));
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]![0])).toContain('db.lan:5432/podium');
      expect(process.exitCode).toBe(1);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } finally {
      process.exitCode = code;
      write.mockRestore();
      kill.mockRestore();
    }
  });
});
