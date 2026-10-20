// The second SQLite file (activity.sqlite, beside podium.sqlite) that holds the Activity history (#432). It is opened only
// for its own tables: nothing here references the main database, so a session's rows are removed by code, not by a
// foreign key. See activityHistory.ts for what is stored and when it goes.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const sqlite = process.getBuiltinModule('node:sqlite');

/** The schema version, kept in `PRAGMA user_version`. Raise it and add a step to `STEPS` to change the schema. */
export const ACTIVITY_SCHEMA_VERSION = 1;

/**
 * `entries`: one row per feed entry. `at` is the entry's own time as the feed shows it; `t` is the same instant on the
 * server's clock (`at` minus the reporter's clock skew), which the purge and the filters use. `stored_sessions` carries the
 * name, project and owner so the Stored activity table and its filters need no join into the main database.
 */
const STEPS: readonly string[] = [
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
  for (let v = version; v < STEPS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(STEPS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
