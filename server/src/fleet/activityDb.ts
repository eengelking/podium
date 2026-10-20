// The second SQLite file (activity.sqlite, beside podium.sqlite) that holds the Activity history (#432). It is opened only
// for its own tables: nothing here references the main database, so a session's rows are removed by code, not by a
// foreign key. See activityHistory.ts for what is stored and when it goes.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const sqlite = process.getBuiltinModule('node:sqlite');

/** The schema version, kept in `PRAGMA user_version`. Raise it and add a step to `STEPS` to change the schema. */
export const ACTIVITY_SCHEMA_VERSION = 2;

/** The size of one stored entry as the Stored activity table counts it: its text and labels, plus 48 bytes of row overhead. `a` is a table alias with its dot, or ''. */
export const entryBytesSql = (a = ''): string =>
  `(length(${a}text) + length(${a}kind) + length(${a}loop) + COALESCE(length(${a}"by"), 0) + COALESCE(length(${a}note), 0) + COALESCE(length(${a}ref), 0) + 48)`;

/** Sets each stored session's entries, bytes and oldest_t from its rows. One pass over `entries`; used by the v2 migration and the seeder. */
export function recomputeAggregates(db: DatabaseSync): void {
  db.exec('UPDATE stored_sessions SET entries = 0, bytes = 0, oldest_t = NULL');
  const rows = db.prepare(`SELECT session_id AS sid, COUNT(*) AS n, SUM(${entryBytesSql()}) AS b, MIN(t) AS oldest FROM entries GROUP BY session_id`).all() as { sid: string; n: number; b: number; oldest: number }[];
  const put = db.prepare('UPDATE stored_sessions SET entries = ?, bytes = ?, oldest_t = ? WHERE session_id = ?');
  for (const r of rows) put.run(r.n, r.b, r.oldest, r.sid);
}

/**
 * `entries`: one row per feed entry. `at` is the entry's own time as the feed shows it; `t` is the same instant on the
 * server's clock (`at` minus the reporter's clock skew), which the purge and the filters use. `stored_sessions` carries the
 * name, project and owner so the Stored activity table and its filters need no join into the main database.
 */
export const ACTIVITY_SCHEMA_STEPS: readonly string[] = [
  `CREATE TABLE entries (
     id INTEGER PRIMARY KEY,
     session_id TEXT NOT NULL,
     loop TEXT NOT NULL,
     seq INTEGER NOT NULL,
     at INTEGER NOT NULL,
     t INTEGER NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     "by" TEXT,
     note TEXT,
     ref TEXT
   );
   CREATE UNIQUE INDEX entries_loop_seq ON entries (session_id, loop, seq);
   CREATE INDEX entries_t ON entries (t);
   CREATE INDEX entries_ref ON entries (session_id, ref);
   CREATE TABLE stored_sessions (
     session_id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     project TEXT,
     owner TEXT,
     first_t INTEGER NOT NULL,
     last_t INTEGER NOT NULL
   );`,
  // v2 (#432): per-session aggregates, so the Stored activity table and the totals never scan `entries`; an index for a
  // session's entries by time; and the ref index only over the few rows that have a ref.
  `ALTER TABLE stored_sessions ADD COLUMN entries INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE stored_sessions ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE stored_sessions ADD COLUMN oldest_t INTEGER;
   DROP INDEX entries_ref;
   CREATE INDEX entries_ref ON entries (session_id, ref) WHERE ref IS NOT NULL;
   CREATE INDEX entries_session_t ON entries (session_id, t, loop);`,
];

/** Where the activity file lives: beside the main database, or in memory when the main one is. */
export function activityDbPath(dbPath: string): string {
  return dbPath === ':memory:' ? ':memory:' : path.join(path.dirname(dbPath), 'activity.sqlite');
}

/** Opens (and migrates) the activity database. `:memory:` for tests; a file path gets WAL and its folder made. */
export function openActivityDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  // Incremental auto-vacuum only takes effect on a file with no table yet, so it is set before anything else is written.
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < ACTIVITY_SCHEMA_STEPS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(ACTIVITY_SCHEMA_STEPS[v]!);
      if (v === 1) recomputeAggregates(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
