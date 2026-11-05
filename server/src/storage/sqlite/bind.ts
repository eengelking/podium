// What every value bound to a SQLite statement goes through (#1007), so SQLite stores what the other adapters do. PostgreSQL cannot hold
// a NUL in text, so a NUL is removed from a string here as it is there (the report validator already strips one, and the Admin ignore
// route refuses one, so this changes only input that never arrives over HTTP). A NaN needs nothing here: SQLite stores it as NULL.
import type { DatabaseSync, StatementSync } from 'node:sqlite';

function clean(v: unknown): unknown {
  return typeof v === 'string' && v.includes('\0') ? v.replaceAll('\0', '') : v;
}

const hasNul = (v: unknown): boolean => typeof v === 'string' && v.includes('\0');
const isNamed = (a: unknown): a is Record<string, unknown> => a !== null && typeof a === 'object' && !ArrayBuffer.isView(a) && !(a instanceof ArrayBuffer);

/** Positional values, or one object of named values. A Buffer or any other value that is not text is passed as it is. Nothing is copied when no value has a NUL (the usual case). */
function cleanArgs(args: unknown[]): unknown[] {
  if (!args.some((a) => (isNamed(a) ? Object.values(a).some(hasNul) : hasNul(a)))) return args;
  return args.map((a) => (isNamed(a) ? Object.fromEntries(Object.entries(a).map(([k, x]) => [k, clean(x)])) : clean(a)));
}

/** Makes every statement the connection prepares clean its values before it binds them. */
export function cleanBinds(db: DatabaseSync): DatabaseSync {
  const prepare = db.prepare.bind(db) as (sql: string) => StatementSync;
  db.prepare = ((sql: string): StatementSync => {
    const s = prepare(sql);
    for (const m of ['run', 'get', 'all'] as const) {
      const original = s[m].bind(s) as (...a: unknown[]) => unknown;
      (s as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => original(...cleanArgs(args));
    }
    return s;
  }) as DatabaseSync['prepare'];
  return db;
}
