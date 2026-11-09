// The report and rollup queries behind Admin > Reporting (#484, #313). They were SQL written inside reports.ts and
// rollups.ts; here they are named methods of the fleet store, so the reports read through the same async interface as
// everything else and nothing outside an adapter names a table's SQL.
import type { AgentDay, FailureDay, FleetDay, HarnessVersionDay, HourPeakDay, PersonDay, SessionTimeDay, SessionsDay, ToolDay, ToolSessionDay, UsageDay } from '../fleet/rollups.js';
import type { SessionRow, SessionWaitRow } from './rows.js';

/** One rollup table row as stored. */
export type RollupRaw = Record<string, string | number | null>;

/** A stored session with the name of its owner's group. */
export type StoredSession = SessionRow & { grp: string | null };

/**
 * The daily rollup tables. `tools_daily`, `tool_sessions_daily` and `harness_versions_daily` are the tool counts (#720). `session_time_daily`, `agents_daily`,
 * `person_sessions_daily` and `hour_peaks_daily` are how long sessions ran and waited, which agents they launched, who ran them and when they overlapped (#722).
 * Names, counts and times only, kept per harness.
 */
export type RollupTable = 'usage_daily' | 'sessions_daily' | 'failures_daily' | 'fleet_daily' | 'tools_daily' | 'tool_sessions_daily' | 'harness_versions_daily' | 'session_time_daily' | 'agents_daily' | 'person_sessions_daily' | 'hour_peaks_daily';

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
  /** Each agent's tool counts (a JSON object of tool name to calls) for the sessions seen at or after `fromMs`, in session then agent order. An agent with none is left out. */
  toolCountsSince(fromMs: number): { id: string; c: string }[];
  /** The first and last sample second of every session. */
  sampleSpans(): { a: number; b: number }[];
  /** The same, with the harness of the session, in session order (#722). */
  sampleSpansByHarness(): { a: number; b: number; harness: string }[];
  /** What each session seen at or after `fromMs` has waited on its person for, in session order (#722). A session with no record is left out. */
  waitsSince(fromMs: number): SessionWaitRow[];
  /** Each agent of the sessions seen at or after `fromMs` with who launched it and its type, in session then agent order (#722). */
  agentLinksSince(fromMs: number): { id: string; agent: string; parent: string | null; type: string }[];
  /** When the oldest stored session was last seen, or null with no sessions. */
  oldestSessionSeen(): number | null;

  /** The days before `day` that any rollup table already holds. */
  rollupDaysBefore(day: string): string[];
  deleteRollupsFrom(day: string): void;
  insertUsage(rows: UsageDay[]): void;
  insertSessionsDaily(rows: SessionsDay[]): void;
  insertFailures(rows: FailureDay[]): void;
  insertToolsDaily(rows: ToolDay[]): void;
  insertToolSessionsDaily(rows: ToolSessionDay[]): void;
  insertHarnessVersionsDaily(rows: HarnessVersionDay[]): void;
  insertSessionTimeDaily(rows: SessionTimeDay[]): void;
  insertAgentsDaily(rows: AgentDay[]): void;
  insertPersonSessionsDaily(rows: PersonDay[]): void;
  /** Writes each hour's peak of live sessions (a stored peak never goes down). */
  upsertHourPeaks(rows: HourPeakDay[]): void;
  /** Writes each day's fleet row with its peak of live sessions (a stored peak never goes down). */
  upsertFleetDays(rows: { day: FleetDay; peak: number }[]): void;
  /** Deletes the rollup rows older than `day`; returns how many went. */
  deleteRollupsBefore(day: string): number;
}
