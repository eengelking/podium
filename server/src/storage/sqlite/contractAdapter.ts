// The SQLite adapter as the storage tests see it (#1008): one entry of the registry in `../index.ts`, like any other adapter.
import { rmSync } from 'node:fs';
import type { ContractAdapter, PhysicalDifference, SchemaNames } from '../contractAdapter.js';
import { StatementSync, type DatabaseSync } from 'node:sqlite';
import { countCalls } from '../statementCount.js';
import { openSqliteStorage } from './index.js';
import { openUpgradedSqlite } from './upgradeTesting.js';
import { sqliteSamplesPerf } from './samplesPerf.js';

// The stores run every statement through a prepared one, so counting its three ways of running gives the number the other adapters count in their connection (#1309).
countCalls(StatementSync.prototype, ['run', 'get', 'all']);

/** Tables the database keeps for itself, not part of the schema the app uses. */
const INTERNAL = /^(sqlite_|schema_migrations$)/;

function namesOf(db: DatabaseSync, into: SchemaNames): void {
  const rows = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all() as { type: string; name: string }[];
  for (const r of rows) {
    if (INTERNAL.test(r.name)) continue;
    if (r.type === 'index') into.indexes.push(r.name);
    else into.tables[r.name] = (db.prepare(`PRAGMA table_info(${r.name})`).all() as { name: string }[]).map((c) => c.name).sort((a, b) => a.localeCompare(b));
  }
}

/**
 * The tables this adapter lays out another way than the others (DECISIONS 78): `WITHOUT ROWID` keeps a table's row in its primary key's own order, so a table whose key is most of its row
 * is stored once and not twice (the row, and the key's index). Nothing a store call returns changes: `adapters.test.ts` reads the layouts back from the database and fails for one that is
 * here and not in the database or in the database and not here, and each entry names the contract case that holds the data the same on every adapter. The gain is the table and its indexes
 * for 100,000 messages with 2 deliveries each, and for 100,000 rows of each of the others, measured on a seeded file after `VACUUM`, the table and every index on it.
 * Every entry is a table every adapter has, and MariaDB (InnoDB) keeps each of them once, in its primary key; PostgreSQL keeps a key beside its row and has no layout that keeps it once.
 */
export const PHYSICAL: PhysicalDifference[] = [
  {
    id: 'deliveries-without-rowid', table: 'conversation_deliveries', option: 'WITHOUT ROWID', issue: '#1296',
    why: 'the key is a message id, a kind and a reference, and the row holds little more',
    gain: '59.1 MB to 24.1 MB for 200,000 rows (-59%)',
    case: { file: 'contractConversations.ts', title: 'agrees on every adapter for deliveries staying with their own conversation (#1296)' },
  },
  {
    id: 'owed-without-rowid', table: 'chat_admin_owed', option: 'WITHOUT ROWID', issue: '#1296',
    why: 'every column of a row is in its key, and the one other index is on the record the key ends with',
    gain: '223 to 144 bytes a row (-36%), 22.3 MB to 14.4 MB for 100,000 rows',
    case: { file: 'contractChat.ts', title: 'removes the Admin records owed only to a deleted person, keeps those owed to others too' },
  },
  {
    id: 'read-state-without-rowid', table: 'chat_read_state', option: 'WITHOUT ROWID', issue: '#1296',
    why: 'the key is the person and the thread, and a row is two counts beside it',
    gain: '155 to 99 bytes a row (-36%), 15.5 MB to 9.9 MB for 100,000 rows',
    case: { file: 'contractChat.ts', title: 'agrees on every adapter for the unread and mention counts of one person in one thread, and keeps no row for a thread at zero (#1296)' },
  },
  {
    id: 'loops-without-rowid', table: 'loops', option: 'WITHOUT ROWID', issue: '#432',
    why: 'the Activity history\'s per-loop totals: the key is the session and the loop, and a row is three numbers beside it. Made so by Activity step 3, before this list existed; declared when the list was made (#1296)',
    gain: '135 to 72 bytes a row (-47%), 13.5 MB to 7.2 MB for 100,000 rows',
    case: { file: 'contractActivity.ts', title: 'agrees on every adapter for the Activity history: ingesting, Podium entries, paging, notes, totals and the list' },
  },
];

/** The tables of one database whose rows are kept in their key's order. */
function layoutsOf(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND wr = 1 ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

export function sqliteContractAdapter(): ContractAdapter {
  const dirs: string[] = [];
  return {
    name: 'sqlite',
    serverVar: null,
    available: () => true,
    open: async () => openSqliteStorage(':memory:', 0),
    openUpgraded: async (rows, reporters, sessions, messages, rights, adminReads, publicMessages, extras, chat, daily) => {
      const { storage, dir } = openUpgradedSqlite(rows, reporters, sessions, messages, rights, adminReads, publicMessages, extras, chat, daily);
      dirs.push(dir);
      return storage;
    },
    schema: async () => {
      const s = openSqliteStorage(':memory:', 0) as unknown as { sqliteHandle: DatabaseSync; activityHandle(): DatabaseSync; close(): Promise<void> };
      const out: SchemaNames = { tables: {}, indexes: [] };
      try {
        namesOf(s.sqliteHandle, out);
        namesOf(s.activityHandle(), out);
      } finally {
        await s.close();
      }
      out.indexes.sort((a, b) => a.localeCompare(b));
      return out;
    },
    layouts: async () => {
      const s = openSqliteStorage(':memory:', 0) as unknown as { sqliteHandle: DatabaseSync; activityHandle(): DatabaseSync; close(): Promise<void> };
      try {
        return [...layoutsOf(s.sqliteHandle), ...layoutsOf(s.activityHandle())].sort((a, b) => a.localeCompare(b));
      } finally {
        await s.close();
      }
    },
    physical: PHYSICAL,
    samplesPerf: async () => sqliteSamplesPerf(),
    known: [],
    dispose: async () => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}
