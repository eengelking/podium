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

/** Takes the lock on a client of its own (not one from a pool), or throws that another server holds it. */
export async function acquireSingleProcessLock(url: string): Promise<SingleProcessLock> {
  const client = new pg.Client({ connectionString: url, application_name: 'podium-lock' });
  // A dropped connection loses the lock; nothing is logged here, and `release` stays safe to call.
  client.on('error', () => undefined);
  await client.connect();
  let got = false;
  try {
    const r = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [SINGLE_PROCESS_LOCK_KEY]);
    got = r.rows[0]?.ok === true;
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  if (!got) {
    await client.end().catch(() => undefined);
    throw new Error(`Another Podium server is already using this database (${pgLabel(url)}). Stop it first; two servers on one database are not supported.`);
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await client.query('SELECT pg_advisory_unlock($1)', [SINGLE_PROCESS_LOCK_KEY]).catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}
