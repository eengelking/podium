// The MariaDB connection the adapter's stores share (#823): a pool, the transaction a call runs in, and the few conversions at the
// edge that make MariaDB hand back what the interfaces declare. Nothing outside `storage/mariadb/` imports `mariadb`.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import * as mariadb from 'mariadb';
import { AsyncLock } from '../lock.js';

/** A value the stores bind. `undefined` is bound as NULL. */
export type Param = string | number | boolean | null | undefined | bigint;
export type Params = readonly Param[] | Readonly<Record<string, Param>>;

/** The one collation of every text column, the connection and the database: bytes compare as they are, and trailing spaces count. */
export const COLLATION = 'utf8mb4_nopad_bin';

/**
 * What each connection runs first. `utf8mb4` with the byte collation, so a literal or a bound value compares as the columns do. The SQL
 * mode makes MariaDB read the stores' SQL as standard SQL: `"x"` is a name and `||` joins text (as on the other adapters), and a value
 * that does not fit its column is an error, not a silent cut. READ COMMITTED is what the other server adapter runs at.
 */
export const SESSION_SQL = [
  `SET NAMES utf8mb4 COLLATE ${COLLATION}`,
  "SET SESSION sql_mode = 'STRICT_ALL_TABLES,ANSI_QUOTES,PIPES_AS_CONCAT,NO_ENGINE_SUBSTITUTION'",
  'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED',
];

/**
 * A BIGINT comes back from the driver as a `bigint` and a DECIMAL (a SUM, an AVG) as a string. The app expects numbers, so they are
 * converted here, and a whole number beyond `Number.MAX_SAFE_INTEGER` is an error and not a silent loss of its low digits.
 */
export function toSafeNumber(text: string): number {
  const n = Number(text);
  if (/^-?\d+$/.test(text) && !Number.isSafeInteger(n)) throw new RangeError(`MariaDB returned ${text}, which a JavaScript number cannot hold exactly`);
  return n;
}

/** Decodes a DECIMAL column to a value `numbers()` converts. Run by the driver for each column; it must not throw, or the stream breaks. */
export const typeCast: mariadb.TypeCastFunction = (field, next) => {
  const v = next();
  if (field.type === 'NEWDECIMAL' && typeof v === 'string') return /^-?\d+$/.test(v) ? BigInt(v) : Number(v);
  return v;
};

/** A row with each `bigint` made a number, which throws for one outside the safe range. */
export function numbers<T extends object>(row: T): T {
  const out = row as Record<string, unknown>;
  for (const k of Object.keys(out)) if (typeof out[k] === 'bigint') out[k] = toSafeNumber(String(out[k]));
  return row;
}

/** Column names the stores use that MariaDB reserves. Written in lower case outside quotes, they are quoted (SQL keywords are written in upper case). */
const RESERVED = new Set(['key', 'loop', 'by']);

/**
 * Turns the placeholders the stores use (`?` in order, `:name`) into MariaDB's `?`, leaving quoted text alone, and quotes a column name
 * MariaDB reserves (`key`, `loop`, `by`). A name used twice binds twice. Returns the SQL and the values in `?` order.
 */
export function positional(sql: string, params: Params | undefined): { text: string; values: Param[] } {
  const values: Param[] = [];
  const list = Array.isArray(params) ? (params as readonly Param[]) : null;
  const map = list ? null : (params as Record<string, Param> | undefined);
  let used = 0;
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
      if (!list || used >= list.length) throw new Error('storage: more ? placeholders than values');
      values.push(list[used++]);
      out += '?';
    } else if (c === ':' && sql[i + 1] !== ':' && sql[i - 1] !== ':' && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /\w/.test(sql[j]!)) j++;
      const name = sql.slice(i + 1, j);
      if (!map || !(name in map)) throw new Error(`storage: no value for :${name}`);
      values.push(map[name]);
      out += '?';
      skipTo = j;
    } else if (/[A-Za-z_]/.test(c) && !/[\w$]/.test(sql[i - 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /\w/.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      out += RESERVED.has(word) ? `"${word}"` : word;
      skipTo = j;
    } else out += c;
  }
  if (list && used !== list.length) throw new Error('storage: fewer ? placeholders than values');
  return { text: out, values: values.map(bound) };
}

/**
 * What one bound value becomes, so MariaDB stores what SQLite does: `undefined` and NaN are NULL, and a NUL is removed from text (as
 * the other adapters do, #1007). A lone surrogate is made U+FFFD, which is what the other adapters hand back for it (the driver would
 * send a `?`). An infinity has no SQL literal: the driver would write `Infinity`, which MariaDB reads as a column name, so it is
 * refused here with a plain message (the report validator and the routes refuse it before any store is called).
 */
export function bound(v: Param): Param {
  if (v === undefined || (typeof v === 'number' && Number.isNaN(v))) return null;
  if (typeof v === 'number' && !Number.isFinite(v)) throw new RangeError(`storage: MariaDB cannot store ${v}`);
  if (typeof v !== 'string') return v;
  const text = v.includes('\0') ? v.replaceAll('\0', '') : v;
  // Under the `u` flag a surrogate pair is one code point, so only a lone half matches.
  return text.replace(/\p{Surrogate}/gu, '\uFFFD');
}

/** Whether the connection that ran a failed statement is no longer good (the driver marks those errors fatal). */
function isFatal(err: unknown): boolean {
  return (err as { fatal?: unknown } | null)?.fatal === true || !(typeof (err as { sqlState?: unknown } | null)?.sqlState === 'string');
}

/** What a `mariadb://user:password@host:port/database` URL names, decoded. Its query may set `ssl=true`; any other parameter is refused. */
export interface Target { host: string; port: number; user: string; password: string; database: string; ssl: boolean }

export function parseTarget(url: string): Target {
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) throw new Error(`PODIUM_DB: a MariaDB URL names its database (mariadb://user:password@host:3306/database), and ${mariaLabel(url)} names none`);
  let ssl = false;
  for (const [k, v] of u.searchParams) {
    if (k === 'ssl' && (v === 'true' || v === 'false')) ssl = v === 'true';
    else throw new Error(`PODIUM_DB: the MariaDB URL parameter "${k}" is not supported (only ssl=true or ssl=false)`);
  }
  return { host: u.hostname.replace(/^\[(.*)\]$/, '$1') || 'localhost', port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database, ssl };
}

/** `host:port/dbname` for a MariaDB URL, with no user and no password, so it is safe to log and to show. */
export function mariaLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return 'mariadb://<unparseable>';
  }
}

/** What the driver is given to connect, from a target, with the conversions every connection uses. */
export function connectionConfig(t: Target): mariadb.ConnectionConfig {
  return {
    host: t.host, port: t.port, user: t.user, password: t.password || undefined, database: t.database,
    ssl: t.ssl || undefined, charset: 'utf8mb4', typeCast, insertIdAsNumber: true, checkNumberRange: true, connectTimeout: 10_000,
    // A failed statement's error carries its SQL, never its values (a token hash, a message).
    logParam: false,
    initSql: SESSION_SQL,
  };
}

/** The name of the lock that keeps a second Podium off a database. `GET_LOCK` names are per server, so the database is in it (hashed, as a name is at most 64 characters). */
export function singleProcessLockName(database: string): string {
  return `podium:${createHash('sha256').update(database).digest('hex').slice(0, 40)}`;
}

/** What a pool asks of the server. */
export interface PoolOptions { target: Target; max: number }

type Conn = mariadb.PoolConnection;

/**
 * One pool, and the transaction a call runs in. A call made inside `tx` (and inside a `savepoint`) sees its connection through the async
 * context and uses it; any other call takes a connection from the pool for that statement. Every statement outside a transaction and
 * every transaction takes its turn through `gate`, so a transaction is exclusive and a read followed by a write is one step, as under
 * the SQLite lock (#1007). The cost is the same as there: calls made outside a transaction run one at a time.
 */
export class MariaDbConn {
  readonly pool: mariadb.Pool;
  private readonly client = new AsyncLocalStorage<Conn>();
  private readonly gate = new AsyncLock();

  constructor(opts: PoolOptions) {
    this.pool = mariadb.createPool({ ...connectionConfig(opts.target), connectionLimit: opts.max, minimumIdle: 1, idleTimeout: 600 });
    // An idle connection that is lost must not take the process down.
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
    const { text, values } = positional(sql, params);
    const r = await this.statement(text, values);
    if (Array.isArray(r)) return { rows: r.map((row) => numbers(row as T)), count: r.length };
    return { rows: [], count: Number((r as mariadb.UpsertResult).affectedRows) };
  }

  /**
   * Runs one statement. Inside a `tx` it runs on the transaction's connection at once. Outside one it takes its turn at the gate, so it
   * waits while another task's transaction is open, as every call waited on the SQLite lock; it is then never a step between a
   * transaction's read and its write.
   */
  private statement(text: string, values?: Param[]): Promise<unknown> {
    const conn = this.client.getStore();
    if (conn) return conn.query(text, values);
    return this.gate.run(() => this.pool.query(text, values));
  }

  async all<T extends object = Record<string, unknown>>(sql: string, params?: Params): Promise<T[]> {
    return (await this.query<T>(sql, params)).rows;
  }

  async get<T extends object = Record<string, unknown>>(sql: string, params?: Params): Promise<T | undefined> {
    return (await this.query<T>(sql, params)).rows[0];
  }

  /** Runs a statement and resolves with the number of rows it matched (the driver counts a row an UPDATE leaves as it was, as the other adapters do). */
  async run(sql: string, params?: Params): Promise<number> {
    return (await this.query(sql, params)).count;
  }

  /** Runs one statement that takes no values, such as a step of a migration. */
  async exec(statement: string): Promise<void> {
    if (this.failure) throw this.failure;
    await this.statement(statement);
  }

  /** Commits when `fn` resolves, rolls back when it rejects. Inside a `tx` it joins that one. Each `tx` holds one pooled connection from its first statement to its last. */
  tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.inTx()) return fn();
    return this.gate.run(async () => {
      const conn = await this.pool.getConnection();
      // Set when the connection is no longer good: it is then destroyed and not handed back to the pool.
      let broken: Error | undefined;
      const note = (err: unknown): void => {
        if (isFatal(err)) broken ??= err instanceof Error ? err : new Error(String(err));
      };
      try {
        await conn.query('START TRANSACTION');
        const out = await this.client.run(conn, fn);
        try {
          await conn.query('COMMIT');
        } catch (err) {
          // A COMMIT that fails leaves the connection in an unknown state, even when the server answered.
          broken ??= err instanceof Error ? err : new Error(String(err));
          throw err;
        }
        return out;
      } catch (err) {
        note(err);
        await conn.query('ROLLBACK').catch((e: unknown) => {
          broken ??= e instanceof Error ? e : new Error(String(e));
        });
        throw err;
      } finally {
        if (broken) conn.destroy();
        else await conn.release();
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
      // The caller needs the error that sent us here; a failed cleanup must not replace it. MariaDB keeps the savepoint after a
      // rollback to it, so it is released too, as the other adapters do.
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

/** The rows of one `COUNT`-like column as a number. */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * ASCII-only lowercase of a SQL expression, as SQLite's `lower()` folds and PostgreSQL's `podium_lower` does: MariaDB's `LOWER()` also
 * folds `É`, which the other adapters keep. `REPLACE` matches bytes under the byte collation, so each letter is replaced on its own.
 */
export function asciiLower(expr: string): string {
  let out = expr;
  for (let c = 65; c <= 90; c++) out = `REPLACE(${out}, '${String.fromCharCode(c)}', '${String.fromCharCode(c + 32)}')`;
  return out;
}

/** The LIKE escape the stores' patterns use: a backslash, written so the driver's parser and MariaDB both read one backslash. */
export const LIKE_ESCAPE = "ESCAPE '\\\\'";
