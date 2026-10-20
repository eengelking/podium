// The second SQLite file (activity.sqlite, beside podium.sqlite) that holds the Activity history (#432). It is opened only
// for its own tables: nothing here references the main database, so a session's rows are removed by code, not by a
// foreign key. See activityHistory.ts for what is stored and when it goes.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const sqlite = process.getBuiltinModule('node:sqlite');

/** The schema version, kept in `PRAGMA user_version`. Raise it and add a step to `STEPS` to change the schema. */
export const ACTIVITY_SCHEMA_VERSION = 4;

/** The size of one stored entry as the Stored activity table counts it: its text and labels, plus 48 bytes of row overhead. `a` is a table alias with its dot, or ''. */
export const entryBytesSql = (a = ''): string =>
  `(length(${a}text) + length(${a}kind) + length(${a}loop) + COALESCE(length(${a}"by"), 0) + COALESCE(length(${a}note), 0) + COALESCE(length(${a}ref), 0) + 48)`;

/**
 * Sets each loop's entry count, the `at` of its first entry and the `t` of its last (by sequence) from its rows, so the live
 * feed's note and the history page never count a loop. Used by the v3 migration and the seeder.
 */
export function recomputeLoops(db: DatabaseSync): void {
  db.exec('DELETE FROM loops');
  db.exec(`INSERT INTO loops (session_id, loop, entries, first_at, last_t)
    SELECT g.session_id, g.loop, g.n,
      (SELECT at FROM entries e WHERE e.session_id = g.session_id AND e.loop = g.loop ORDER BY seq LIMIT 1),
      (SELECT t FROM entries e WHERE e.session_id = g.session_id AND e.loop = g.loop ORDER BY seq DESC LIMIT 1)
    FROM (SELECT session_id, loop, COUNT(*) AS n FROM entries GROUP BY session_id, loop) g`);
}

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
  // v3 (#432): per-loop aggregates, so the note on the live feed and the history page read one row instead of counting a loop.
  `CREATE TABLE loops (
     session_id TEXT NOT NULL,
     loop TEXT NOT NULL,
     entries INTEGER NOT NULL,
     first_at INTEGER,
     last_t INTEGER,
     PRIMARY KEY (session_id, loop)
   ) WITHOUT ROWID;`,
  // v4 (#353): session recordings, in their own tables so the Activity history's aggregates never count them. `rec_sessions` is
  // one row per recorded session (its state, chosen loops and aggregates); `rec_entries` one row per recorded entry. `n` is the
  // server's order. `t` is the server's time when the entry was stored, which the per-part expiry counts from. `b` is the
  // entry's size in bytes, kept so a purge or a delete settles the aggregates exactly. The server's own marks (stopped, limit)
  // and a prompt it wrote itself have a `seq` of 0 or less, so they never meet the mod's numbering, which starts at 1.
  `CREATE TABLE rec_sessions (
     session_id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     project TEXT,
     owner TEXT,
     state TEXT NOT NULL,
     limit_kind TEXT,
     loops TEXT NOT NULL,
     started_by TEXT,
     started_at INTEGER,
     stopped_by TEXT,
     stopped_at INTEGER,
     entries INTEGER NOT NULL DEFAULT 0,
     bytes INTEGER NOT NULL DEFAULT 0,
     oldest_t INTEGER,
     last_t INTEGER
   );
   CREATE TABLE rec_entries (
     n INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     loop TEXT NOT NULL,
     seq INTEGER NOT NULL,
     at INTEGER NOT NULL,
     t INTEGER NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     name TEXT,
     call_seq INTEGER,
     failed INTEGER,
     cut INTEGER,
     lost INTEGER,
     "by" TEXT,
     b INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX rec_entries_loop_seq ON rec_entries (session_id, loop, seq);
   CREATE INDEX rec_entries_session_n ON rec_entries (session_id, n);
   CREATE INDEX rec_entries_t ON rec_entries (t);`,
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
      if (v === 2) recomputeLoops(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
