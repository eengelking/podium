// The PostgreSQL connection the adapter's stores share (#822): a pool, the transaction a call runs in, and the few conversions at the
// edge that make PostgreSQL hand back what the interfaces declare. Nothing outside `storage/postgres/` imports `pg`.
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { AsyncLock } from '../lock.js';

/** A value the stores bind. `undefined` is bound as NULL. */
export type Param = string | number | boolean | null | undefined | bigint;
export type Params = readonly Param[] | Readonly<Record<string, Param>>;

const INT8 = 20;
const NUMERIC = 1700;

/**
 * `bigint` and `numeric` come back from `pg` as strings. The app expects numbers, so they are converted here, and a whole number
 * beyond `Number.MAX_SAFE_INTEGER` is an error and not a silent loss of its low digits.
 */
export function toSafeNumber(text: string): number {
  const n = Number(text);
  if (/^-?\d+$/.test(text) && !Number.isSafeInteger(n)) throw new RangeError(`PostgreSQL returned ${text}, which a JavaScript number cannot hold exactly`);
  return n;
}

const types = {
  getTypeParser: ((oid: number, format?: string) => {
    if (oid === INT8 || oid === NUMERIC) return toSafeNumber;
    return pg.types.getTypeParser(oid, format as 'text');
  }) as pg.CustomTypesConfig['getTypeParser'],
} satisfies pg.CustomTypesConfig;

/**
 * Turns the placeholders the SQLite stores use (`?` in order, `:name`) into PostgreSQL's `$n`, leaving quoted text alone. A name
 * used twice binds once. Returns the SQL and the values in `$n` order.
 */
export function numbered(sql: string, params: Params | undefined): { text: string; values: Param[] } {
  const values: Param[] = [];
  const named = new Map<string, number>();
  const list = Array.isArray(params) ? (params as readonly Param[]) : null;
  const map = list ? null : (params as Record<string, Param> | undefined);
  let out = '';
  let quote = '';
  let skipTo = 0; // the loop counter is not changed inside the loop: a name that was just read is skipped by position
  for (let i = 0; i < sql.length; i++) {
    if (i < skipTo) continue;
    const c = sql[i]!;
    if (quote) {
      out += c;
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === '?') {
      if (!list || values.length >= list.length) throw new Error('storage: more ? placeholders than values');
      values.push(list[values.length]);
      out += `$${values.length}`;
    } else if (c === ':' && sql[i + 1] !== ':' && sql[i - 1] !== ':' && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /\w/.test(sql[j]!)) j++;
      const name = sql.slice(i + 1, j);
      let at = named.get(name);
      if (at === undefined) {
        if (!map || !(name in map)) throw new Error(`storage: no value for :${name}`);
        values.push(map[name]);
        at = values.length;
        named.set(name, at);
      }
      out += `$${at}`;
      skipTo = j;
    } else out += c;
  }
  if (list && values.length !== list.length) throw new Error('storage: fewer ? placeholders than values');
  return { text: out, values: values.map((v) => (v === undefined ? null : v)) };
}

/** Whether the error came from the server (it carries a SQLSTATE `code`), as opposed to a lost or broken connection. */
function isDatabaseError(err: unknown): boolean {
  return typeof (err as { code?: unknown } | null)?.code === 'string' && (err as { code: string }).code.length === 5;
}

/** The key of the session advisory lock that keeps a second Podium off a database. Advisory locks are per database, so one constant is enough. */
export const SINGLE_PROCESS_LOCK_KEY = '7366773961';

/**
 * `pg` lets what the URL carries override the settings given beside it, so a URL with `?options=-c search_path=public` would move the
 * tables to `public`. The two parameters the adapter sets itself are taken out of the URL, so nothing can override them.
 */
export function withoutSettings(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('options');
    u.searchParams.delete('application_name');
    return u.toString();
  } catch {
    return url;
  }
}

/** What a pool asks of the server's settings. */
export interface PoolOptions { connectionString: string; schema: string; max: number; name: string }

/**
 * One pool, and the transaction a call runs in. A call made inside `tx` (and inside a `savepoint`) sees its client through the async
 * context and uses it; any other call takes a client from the pool for that statement. Transactions are taken one at a time through
 * `gate`: the server is one process, and a read followed by a write is one step, as it was under the SQLite lock.
 */
export class PgDb {
  readonly pool: pg.Pool;
  private readonly client = new AsyncLocalStorage<pg.PoolClient>();
  private readonly gate = new AsyncLock();

  constructor(opts: PoolOptions) {
    this.pool = new pg.Pool({ connectionString: withoutSettings(opts.connectionString), max: opts.max, types, application_name: `podium-${opts.name}`, options: `-c search_path=${opts.schema}` });
    // An idle client that loses its connection must not take the process down.
    this.pool.on('error', () => undefined);
  }

  private failure: Error | undefined;

  /** Shuts the connection for good: every later call rejects with `err`. Used when the single-process lock is lost. */
  fail(err: Error): void {
    this.failure ??= err;
  }

  /** Whether the caller is inside a `tx`. */
  inTx(): boolean {
    return this.client.getStore() !== undefined;
  }

  async query<T extends object = Record<string, unknown>>(sql: string, params?: Params): Promise<{ rows: T[]; count: number }> {
    if (this.failure) throw this.failure;
    const { text, values } = numbered(sql, params);
    const r = await (this.client.getStore() ?? this.pool).query(text, values);
    return { rows: r.rows as T[], count: r.rowCount ?? 0 };
  }

  async all<T extends object = Record<string, unknown>>(sql: string, params?: Params): Promise<T[]> {
    return (await this.query<T>(sql, params)).rows;
  }

  async get<T extends object = Record<string, unknown>>(sql: string, params?: Params): Promise<T | undefined> {
    return (await this.query<T>(sql, params)).rows[0];
  }

  /** Runs a statement and resolves with the number of rows it changed. */
  async run(sql: string, params?: Params): Promise<number> {
    return (await this.query(sql, params)).count;
  }

  /** Runs statements that take no values, such as a migration's script. */
  async exec(script: string): Promise<void> {
    if (this.failure) throw this.failure;
    await (this.client.getStore() ?? this.pool).query(script);
  }

  /** Commits when `fn` resolves, rolls back when it rejects. Inside a `tx` it joins that one. Each `tx` holds one pooled client from its first statement to its last. */
  tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.inTx()) return fn();
    return this.gate.run(async () => {
      const client = await this.pool.connect();
      // The pool listens to an idle client only; while this one is held, a lost connection must not become an uncaught exception.
      const swallow = (): void => undefined;
      client.on('error', swallow);
      // Set when the connection is no longer good: the client is then destroyed and not handed back to the pool.
      let broken: Error | undefined;
      const note = (err: unknown): void => {
        if (!isDatabaseError(err)) broken ??= err instanceof Error ? err : new Error(String(err));
      };
      try {
        await client.query('BEGIN');
        const out = await this.client.run(client, fn);
        try {
          await client.query('COMMIT');
        } catch (err) {
          // A COMMIT that fails leaves the client in an unknown state, even when the server answered.
          broken ??= err instanceof Error ? err : new Error(String(err));
          throw err;
        }
        return out;
      } catch (err) {
        note(err);
        await client.query('ROLLBACK').catch((e: unknown) => {
          broken ??= e instanceof Error ? e : new Error(String(e));
        });
        throw err;
      } finally {
        // The client lives on in the pool: take the handler off so a long-lived client does not collect one per transaction.
        client.off('error', swallow);
        client.release(broken);
      }
    });
  }

  /** A step inside the open transaction that can be undone alone (or a transaction of its own when none is open). */
  async savepoint<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this.inTx()) return this.tx(() => this.savepoint(name, fn));
    await this.exec(`SAVEPOINT ${name}`);
    try {
      const out = await fn();
      await this.exec(`RELEASE SAVEPOINT ${name}`);
      return out;
    } catch (err) {
      // The caller needs the error that sent us here; a failed cleanup must not replace it. The transaction then fails at its end.
      await this.exec(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
      await this.exec(`RELEASE SAVEPOINT ${name}`).catch(() => undefined);
      throw err;
    }
  }

  /** Resolves when every transaction taken so far has finished. */
  drain(): Promise<void> {
    return this.gate.drain();
  }

  async close(): Promise<void> {
    await this.gate.drain();
    await this.pool.end();
  }
}

/** The rows of one `COUNT`-like column as a number; PostgreSQL returns the count of an empty table as 0, so this only narrows the type. */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
