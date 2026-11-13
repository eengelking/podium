// The report and rollup queries behind Admin > Reporting (#484, #313). They were SQL written inside reports.ts and
// rollups.ts; here they are named methods of the fleet store, so the reports read through the same async interface as
// everything else and nothing outside an adapter names a table's SQL.
import type { AgentDay, CostDay, ToolCostDay, FailureDay, FleetDay, FeatureVersionDay, HarnessVersionDay, HourPeakDay, PlaceDay, SkillDay, PersonDay, SessionTimeDay, SessionsDay, ToolDay, ToolSessionDay, ToolStatDay, UsageDay } from '../fleet/rollups.js';
import type { SessionRow, SessionWaitRow } from './rows.js';

/** One rollup table row as stored. */
export type RollupRaw = Record<string, string | number | null>;

/** A stored session with the name of its owner's group. */
export type StoredSession = SessionRow & { grp: string | null };

/**
 * The daily rollup tables. `tools_daily`, `tool_sessions_daily` and `harness_versions_daily` are the tool counts (#720), and `tool_stats_daily` how each tool failed, asked and
 * took (#721). `session_time_daily`, `agents_daily`, `person_sessions_daily` and `hour_peaks_daily` are how long sessions ran and waited, which agents they launched, who ran them
 * and when they overlapped (#722). `feature_versions_daily` is what each version of a harness sent, `skills_daily` the skills each person used and `person_places_daily` the projects and git branches each person ran in (#724). `cost_daily` and `tool_cost_daily` are what sessions cost and how they ended, by model, effort and tool (#723). Names, counts and times only, kept per harness.
 */
export type RollupTable = 'usage_daily' | 'sessions_daily' | 'failures_daily' | 'fleet_daily' | 'tools_daily' | 'tool_sessions_daily' | 'harness_versions_daily' | 'tool_stats_daily' | 'session_time_daily' | 'agents_daily' | 'person_sessions_daily' | 'hour_peaks_daily' | 'cost_daily' | 'tool_cost_daily' | 'feature_versions_daily' | 'skills_daily' | 'person_places_daily' | 'answers_daily';

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
  /** Each agent's skills (a JSON list of names) for the sessions seen at or after `fromMs`, in session then agent order. An agent with none is left out. */
  skillsSince(fromMs: number): { id: string; k: string }[];
  /** Each agent's per-tool stats (#721, a JSON object of tool name to counts) for the sessions seen at or after `fromMs`, in session then agent order. An agent with none is left out. */
  toolStatsSince(fromMs: number): { id: string; s: string }[];
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
  insertFeatureVersionsDaily(rows: FeatureVersionDay[]): void;
  insertSkillsDaily(rows: SkillDay[]): void;
  insertPlacesDaily(rows: PlaceDay[]): void;
  insertToolStatsDaily(rows: ToolStatDay[]): void;
  insertSessionTimeDaily(rows: SessionTimeDay[]): void;
  insertAgentsDaily(rows: AgentDay[]): void;
  insertPersonSessionsDaily(rows: PersonDay[]): void;
  insertCostDaily(rows: CostDay[]): void;
  insertToolCostDaily(rows: ToolCostDay[]): void;
  /** Counts one answer sent from Podium (#725) on its day, for its harness and kind, in its wait class (-1 for no wait). Written as the answer is taken, never rebuilt. */
  addAnswer(day: string, harness: string, kind: string, bucket: number): void;
  /** Leaves one row with no answer (kind `none`) for `day`, so the first day answers were counted is known when no one answered that day. Marking a day twice changes nothing. */
  markAnswerDay(day: string): void;
  /** Writes each hour's peak of live sessions (a stored peak never goes down). */
  upsertHourPeaks(rows: HourPeakDay[]): void;
  /** Writes each day's fleet row with its peak of live sessions (a stored peak never goes down). */
  upsertFleetDays(rows: { day: FleetDay; peak: number }[]): void;
  /** Deletes the rollup rows older than `day`; returns how many went. */
  deleteRollupsBefore(day: string): number;
}
