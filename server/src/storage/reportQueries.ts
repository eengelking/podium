// The report and rollup queries behind Admin > Reporting (#484, #313). They were SQL written inside reports.ts and
// rollups.ts; here they are named methods of the fleet store, so the reports read through the same async interface as
// everything else and nothing outside an adapter names a table's SQL.
import type { SessionRow } from './sqlite/db.js';
import type { FailureDay, FleetDay, SessionsDay, UsageDay } from '../fleet/rollups.js';

/** One rollup table row as stored. */
export type RollupRaw = Record<string, string | number | null>;

/** A stored session with the name of its owner's group. */
export type StoredSession = SessionRow & { grp: string | null };

/** The four daily rollup tables. */
export type RollupTable = 'usage_daily' | 'sessions_daily' | 'failures_daily' | 'fleet_daily';

export interface ReportQueries {
  /** Rows of a rollup table for the days `from` to `to`, oldest first. */
  rollupRows(table: RollupTable, from: string, to: string): RollupRaw[];
  /** The oldest day a rollup table holds, or null when it is empty. */
  rollupOldestDay(table: RollupTable): string | null;
  /** How many rows a rollup table holds and its oldest day. */
  rollupStats(table: RollupTable): { n: number; d: string | null };
  /** The stored peak of live sessions on `day`, if a run wrote one. */
  storedPeak(day: string): number | undefined;
  /** Each person's name with the name of their group ('' when none). */
  ownerGroupNames(): { n: string; g: string }[];
  /** Each person with their group name (null when none) and the time of their last report. */
  knownPeople(): { name: string; grp: string | null; last: number | null }[];
  countReporters(): number;
  countGroups(): number;
  /** Admin log rows from `from` up to `to`, newest first, at most `limit`, of one kind when `kind` is given. */
  adminLogRows(from: number, to: number, kind: string | undefined, limit: number): RollupRaw[];

  /** Every stored session last seen at or after `fromMs`, with its owner's group. */
  sessionsSince(fromMs: number): StoredSession[];
  agentCountsSince(fromMs: number): { id: string; n: number }[];
  reporterKeysSince(fromMs: number): { id: string; k: string }[];
  failureRowsSince(fromMs: number): { id: string; f: string }[];
  /** The first and last sample second of every session. */
  sampleSpans(): { a: number; b: number }[];
  /** When the oldest stored session was last seen, or null with no sessions. */
  oldestSessionSeen(): number | null;

  /** The days before `day` that any rollup table already holds. */
  rollupDaysBefore(day: string): string[];
  deleteRollupsFrom(day: string): void;
  insertUsage(rows: UsageDay[]): void;
  insertSessionsDaily(rows: SessionsDay[]): void;
  insertFailures(rows: FailureDay[]): void;
  /** Writes each day's fleet row with its peak of live sessions (a stored peak never goes down). */
  upsertFleetDays(rows: { day: FleetDay; peak: number }[]): void;
  /** Deletes the rollup rows older than `day`; returns how many went. */
  deleteRollupsBefore(day: string): number;
}
