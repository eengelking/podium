// The reporter lookup the peer service reads, on PostgreSQL (#822): the SQLite `ReporterStore.peerLookup()` over `PgDb`. A hooks-only reporter
// has no orchestrator to message, so every read here is of mod reporters; owners compare without regard to (ASCII) case.
import { checkReporter } from '../../fleet/compat.js';
import type { ReporterRef } from '../../fleet/peerTypes.js';
import { ADMIN_SECRET, IDLE_MS, REPORTING_MS, type ReporterState } from '../rows.js';
import type { AsyncPeerReporterLookup } from '../types.js';
import type { PgDb } from './conn.js';

/** The state, in SQL, from the last report, the time the server started and now. Needs `:started` and `:now`. */
export const STATE_SQL = `CASE WHEN r.last_seen_at < :started THEN 'restart'
  WHEN :now - r.last_seen_at < ${REPORTING_MS} THEN 'reporting'
  WHEN :now - r.last_seen_at < ${IDLE_MS} THEN 'idle' ELSE 'silent' END`;

interface DbPeerRef {
  key: string;
  machine_name: string | null;
  owner: string | null;
  credential: string | null;
  os: string | null;
  peers: number | null;
  reporter_version: string;
}

const ref = (r: DbPeerRef): ReporterRef => ({
  key: r.key,
  machine: r.machine_name ?? r.key,
  owner: r.owner,
  adminSecret: r.credential === ADMIN_SECRET,
  os: r.os,
  peers: r.peers === null ? null : r.peers === 1,
  version: r.reporter_version,
});

const COLS = 'key, machine_name, owner, credential, os, peers, reporter_version';
const MINE = `podium_lower(owner) = podium_lower(:owner) AND kind = 'mod' ORDER BY podium_lower(COALESCE(machine_name, key)), key`;

/** `startedAt` is when the server started: a reporter last heard before it is "Not since restart". */
export function pgPeerLookup(db: PgDb, startedAt: number = Date.now()): AsyncPeerReporterLookup {
  return {
    startedAt,
    ofOwnerSeen: async (owner, now) => {
      const rows = await db.all<DbPeerRef & { last_seen_at: number; state: ReporterState }>(
        `SELECT ${COLS}, last_seen_at, ${STATE_SQL} AS state FROM reporters r WHERE ${MINE}`,
        { owner, now, started: startedAt },
      );
      return rows.map((r) => ({ ...ref(r), state: r.state, lastSeenAt: r.last_seen_at, compat: checkReporter(r.reporter_version) }));
    },
    get: async (key) => {
      const r = await db.get<DbPeerRef>(`SELECT ${COLS} FROM reporters WHERE key = ? AND kind = 'mod'`, [key]);
      return r ? ref(r) : null;
    },
    ofOwner: async (owner) => (await db.all<DbPeerRef>(`SELECT ${COLS} FROM reporters WHERE ${MINE}`, { owner })).map(ref),
  };
}
