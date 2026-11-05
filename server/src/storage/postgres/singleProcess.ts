// One Podium server per database (#822). The stores keep the SQLite lock's promise (a read followed by a write is one step) inside one
// process only, so two servers on one database are not supported. A session advisory lock on a dedicated connection enforces it: the
// second server finds the lock taken and refuses to start. The lock goes when the connection does, including when the process dies.
import pg from 'pg';
import { SINGLE_PROCESS_LOCK_KEY } from './conn.js';

/** `host:port/dbname` for a PostgreSQL URL, with no user and no password, so it is safe to log and to show. */
export function pgLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return 'postgres://<unparseable>';
  }
}

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

/**
 * Takes the lock on a client of its own (not one from a pool), or throws that another server holds it. When that connection drops
 * while the lock is held, the lock is gone and another server could take it, so it is taken again on a new connection (a few tries);
 * if that fails or another server now holds it, `onLost` is called and the caller must stop using the database.
 */
export async function acquireSingleProcessLock(url: string, opts: LockOptions = {}): Promise<SingleProcessLock> {
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 500;
  const label = pgLabel(url);
  let released = false;
  let lostOnce = false;
  let client: pg.Client;

  const lose = (why: string): void => {
    if (lostOnce || released) return;
    lostOnce = true;
    opts.onLost?.(new Error(`Podium lost its lock on the database ${label}: ${why}. Its storage is closed to protect the data; restart Podium once the database is reachable and no other server uses it.`));
  };

  /** Ends a client we are done with, without its end or error reaching the handlers. */
  const discard = async (c: pg.Client): Promise<void> => {
    c.removeAllListeners('end');
    c.removeAllListeners('error');
    c.on('error', () => undefined);
    await c.end().catch(() => undefined);
  };

  /** One connection with the lock on it, or null when another server holds it. Throws when it cannot connect. */
  const take = async (): Promise<pg.Client | null> => {
    const c = new pg.Client({ connectionString: url, application_name: 'podium-lock' });
    let dropped = false;
    const onDrop = (): void => {
      if (dropped || released || c !== client) return;
      dropped = true;
      void retake();
    };
    c.on('error', onDrop);
    c.on('end', onDrop);
    try {
      await c.connect();
      const r = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [SINGLE_PROCESS_LOCK_KEY]);
      if (r.rows[0]?.ok === true) return c;
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
        client = c;
        return;
      } catch {
        // The database may be restarting; try again until the attempts are used up.
      }
    }
    lose(`the connection dropped and could not be re-established in ${attempts} tries`);
  };

  const first = await take();
  if (first === null) throw new Error(`Another Podium server is already using this database (${label}). Stop it first; two servers on one database are not supported.`);
  client = first;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await client.query('SELECT pg_advisory_unlock($1)', [SINGLE_PROCESS_LOCK_KEY]).catch(() => undefined);
      await discard(client);
    },
  };
}
