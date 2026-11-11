// One Podium server per database (#823), as on MariaDB (#823). The stores keep the SQLite lock's promise (a read followed by a write is
// one step) inside one process only, so two servers on one database are not supported. A named lock (`GET_LOCK`) on a connection of its
// own, held outside the pool for the life of the server, enforces it: the second server finds the lock taken and refuses to start. The
// lock goes when the connection does, including when the process dies.
import * as mariadb from 'mariadb';
import { SESSION_SQL, connectionConfig, mariaLabel, parseTarget, singleProcessLockName } from './conn.js';

export { mariaLabel };

export interface SingleProcessLock { release(): Promise<void> }

export interface LockOptions {
  /** Called once when the lock is lost for good: another server holds it, or it could not be taken again. */
  onLost?: (err: Error) => void;
  /** How many times to try to take it again on a new connection, and the wait before each try. */
  attempts?: number;
  delayMs?: number;
}

/**
 * The default reaction to a lost lock: one line on stderr with the database label (never a password), a failing exit code, and a
 * SIGTERM so the server's own shutdown path runs.
 */
export function exitOnLockLost(err: Error): void {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
  process.kill(process.pid, 'SIGTERM');
}

/** The longest MariaDB lets a connection sit idle before it closes it (a year): the lock's connection is idle for the life of the server. */
const IDLE_SECONDS = 31_536_000;

/**
 * Takes the lock on a connection of its own (not one from a pool), or throws that another server holds it. When that connection drops
 * while the lock is held, the lock is gone and another server could take it, so it is taken again on a new connection (a few tries);
 * if that fails or another server now holds it, `onLost` is called and the caller must stop using the database.
 */
export async function acquireSingleProcessLock(url: string, opts: LockOptions = {}): Promise<SingleProcessLock> {
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 500;
  const label = mariaLabel(url);
  const target = parseTarget(url);
  const name = singleProcessLockName(target.database);
  let released = false;
  let lostOnce = false;
  let conn: mariadb.Connection;

  const lose = (why: string): void => {
    if (lostOnce || released) return;
    lostOnce = true;
    opts.onLost?.(new Error(`Podium lost its lock on the database ${label}: ${why}. Its storage is closed to protect the data; restart Podium once the database is reachable and no other server uses it.`));
  };

  /** Ends a connection we are done with, without its end or error reaching the handlers. */
  const discard = async (c: mariadb.Connection): Promise<void> => {
    c.removeAllListeners('end');
    c.removeAllListeners('error');
    c.on('error', () => undefined);
    await c.end().catch(() => c.destroy());
  };

  /** One connection with the lock on it, or null when another server holds it. Throws when it cannot connect. */
  const take = async (): Promise<mariadb.Connection | null> => {
    const c = await mariadb.createConnection({ ...connectionConfig(target), initSql: [...SESSION_SQL, `SET SESSION wait_timeout = ${IDLE_SECONDS}`] });
    let dropped = false;
    const onDrop = (): void => {
      if (dropped || released || c !== conn) return;
      dropped = true;
      void retake();
    };
    c.on('error', onDrop);
    c.on('end', onDrop);
    try {
      const r = await c.query<{ ok: number | bigint | null }[]>('SELECT GET_LOCK(?, 0) AS ok', [name]);
      if (Number(r[0]?.ok) === 1) return c;
    } catch (err) {
      await discard(c);
      throw err;
    }
    await discard(c);
    return null;
  };

  const retake = async (): Promise<void> => {
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      if (released) return;
      try {
        const c = await take();
        if (c === null) return lose('another server holds it now');
        if (released) return await discard(c);
        conn = c;
        return;
      } catch {
        // The database may be restarting; try again until the attempts are used up.
      }
    }
    lose(`the connection dropped and could not be re-established in ${attempts} tries`);
  };

  const first = await take();
  if (first === null) throw new Error(`Another Podium server is already using this database (${label}). Stop it first; two servers on one database are not supported.`);
  conn = first;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await conn.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => undefined);
      await discard(conn);
    },
  };
}
