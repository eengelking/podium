// The single-process lock (#823): GET_LOCK on a connection held outside the pool, taken again once when that connection drops, or the
// storage fails closed and says so; a second server is refused, and the first one's exit frees the lock.
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openMariaDbStorage } from './index.js';
import { parseTarget, singleProcessLockName } from './conn.js';
import { acquireSingleProcessLock, exitOnLockLost } from './singleProcess.js';
import { TEST_MARIADB, createTestDatabase, withConnection, type TestDatabase } from './testing.js';

const target = (td: TestDatabase): string => td.url.replace(/^mariadb:\/\//, '');
const FAST = { attempts: 4, delayMs: 100 };

/** The connection that holds the lock now, or null. */
const holder = (td: TestDatabase) =>
  withConnection(td.url, async (c) => {
    const r = await c.query<{ id: bigint | null }[]>('SELECT IS_USED_LOCK(?) AS id', [singleProcessLockName(td.name)]);
    return r[0]!.id === null ? null : Number(r[0]!.id);
  });

/** Polls (at most `ms`) until `ok()` holds; throws with `what` when it does not. */
async function until(what: string, ok: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe.skipIf(!TEST_MARIADB)('single-process lock on MariaDB', () => {
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
  const killLock = async (td: TestDatabase) => {
    const id = await holder(td);
    if (id !== null) await withConnection(td.url, (c) => c.query(`KILL CONNECTION ${id}`));
    return id;
  };

  it('holds the lock on a connection that is not one of the pools, so the pools can come and go', async () => {
    const td = await fresh();
    const s = await openMariaDbStorage(target(td), Date.now(), vi.fn(), FAST);
    closers.push(() => s.close());
    const id = await holder(td);
    expect(id).not.toBeNull();
    // The pools' connections are others: a statement through the store runs on a connection that is not the lock's.
    const used = await withConnection(td.url, async (c) => (await c.query<{ n: bigint }[]>('SELECT COUNT(*) AS n FROM information_schema.processlist WHERE db = ? AND id <> ?', [td.name, id]))[0]!.n);
    expect(Number(used)).toBeGreaterThan(1);
  });

  it('takes the lock again on a new connection and keeps serving', async () => {
    const td = await fresh();
    const lost = vi.fn();
    const s = await openMariaDbStorage(target(td), Date.now(), lost, FAST);
    closers.push(() => s.close());
    const before = await killLock(td);
    await until('the lock to be held by a new connection', async () => {
      const h = await holder(td);
      return h !== null && h !== before;
    });
    expect(lost).not.toHaveBeenCalled();
    await s.people.createGroup('After the drop', 1);
    expect((await s.people.allGroups()).map((g) => g.name)).toContain('After the drop');
    // The new connection holds it: a second server is still refused.
    await expect(openMariaDbStorage(target(td), Date.now(), lost, FAST)).rejects.toThrow(/already using this database/);
  });

  it('fails closed when another server took the lock in between, and calls the hook once', async () => {
    const td = await fresh();
    const lost = vi.fn();
    const s = await openMariaDbStorage(target(td), Date.now(), lost, { attempts: 3, delayMs: 300 });
    closers.push(() => s.close());
    await killLock(td);
    // Another server takes it in the window before this one tries again.
    const other = await acquireSingleProcessLock(td.url);
    closers.push(() => other.release());
    await until('the hook to be called', () => lost.mock.calls.length > 0);
    expect(lost).toHaveBeenCalledTimes(1);
    const err = lost.mock.calls[0]![0] as Error;
    const u = new URL(td.url);
    expect(err.message).toContain(`${u.host}${u.pathname}`);
    expect(err.message).not.toContain('@');
    expect(err.message).not.toContain(`${u.username}:`);
    // Every later call rejects with that message, on the stores and on a transaction.
    await expect(s.people.allGroups()).rejects.toThrow(/lost/i);
    await expect(s.tx(async () => 1)).rejects.toThrow(/lost/i);
  });

  it('fails closed when the lock cannot be taken again within the attempts', async () => {
    const td = await fresh();
    const lost = vi.fn();
    const s = await openMariaDbStorage(target(td), Date.now(), lost, { attempts: 2, delayMs: 50 });
    closers.push(() => s.close());
    // Dropping the database first and then ending its connections leaves nothing to connect to (MariaDB has no DROP ... FORCE).
    await withConnection(TEST_MARIADB!, async (c) => {
      await c.query(`DROP DATABASE ${td.name}`);
      const ids = await c.query<{ id: bigint }[]>('SELECT id FROM information_schema.processlist WHERE db = ? AND id <> CONNECTION_ID()', [td.name]);
      for (const { id } of ids) await c.query(`KILL CONNECTION ${Number(id)}`).catch(() => undefined);
    });
    await until('the hook to be called', () => lost.mock.calls.length > 0);
    expect((lost.mock.calls[0]![0] as Error).message).toMatch(/lost.*could not be re-established in 2 tries/i);
    await expect(s.people.allGroups()).rejects.toThrow(/lost/i);
  });

  it('does not treat a release as a loss, and frees the lock', async () => {
    const td = await fresh();
    const lost = vi.fn();
    const s = await openMariaDbStorage(target(td), Date.now(), lost, FAST);
    await s.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(lost).not.toHaveBeenCalled();
    expect(await holder(td)).toBeNull();
  });

  it('is freed when the process holding it exits without closing anything', async () => {
    const td = await fresh();
    // A child process takes the lock the way the server does and is then killed: its connection goes, and with it the lock.
    const code = `import('mariadb').then(async (m) => { const c = await m.createConnection(${JSON.stringify({ ...parseTarget(td.url), password: parseTarget(td.url).password || undefined })}); await c.query('SELECT GET_LOCK(?, 0)', [${JSON.stringify(singleProcessLockName(td.name))}]); process.stdout.write('held\\n'); setInterval(() => {}, 1000); });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.on('data', (d: Buffer) => d.toString().includes('held') && resolve()));
    await expect(openMariaDbStorage(target(td), Date.now(), vi.fn(), FAST)).rejects.toThrow(/already using this database/);
    child.kill('SIGKILL');
    await until('the lock to be free', async () => (await holder(td)) === null);
    const s = await openMariaDbStorage(target(td), Date.now(), vi.fn(), FAST);
    await s.close();
  });
});

describe('the default reaction to a lost lock', () => {
  it('writes one line with the label, sets the exit code and asks the process to stop', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const code = process.exitCode;
    try {
      exitOnLockLost(new Error('Podium lost its lock on db.lan:3306/podium.'));
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]![0])).toContain('db.lan:3306/podium');
      expect(process.exitCode).toBe(1);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } finally {
      process.exitCode = code;
      write.mockRestore();
      kill.mockRestore();
    }
  });
});
