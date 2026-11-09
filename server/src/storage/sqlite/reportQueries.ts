import type { DatabaseSync } from 'node:sqlite';
import type { AgentDay, FailureDay, FleetDay, HarnessVersionDay, HourPeakDay, PersonDay, SessionTimeDay, SessionsDay, ToolDay, ToolSessionDay, UsageDay } from '../../fleet/rollups.js';
import type { ReportQueries, RollupRaw, RollupTable, StoredSession } from '../reportQueries.js';
import type { SessionWaitRow } from '../rows.js';

const TABLES: RollupTable[] = ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily', 'tools_daily', 'tool_sessions_daily', 'harness_versions_daily', 'session_time_daily', 'agents_daily', 'person_sessions_daily', 'hour_peaks_daily'];
/** The tables that are rebuilt from the stored sessions (the fleet table and the hour peaks are upserted, so a peak never goes down). */
const REBUILT: RollupTable[] = ['usage_daily', 'sessions_daily', 'failures_daily', 'tools_daily', 'tool_sessions_daily', 'harness_versions_daily', 'session_time_daily', 'agents_daily', 'person_sessions_daily'];

/** The columns after `day` that make a rollup row unique, so rows of one day come back in one order everywhere. */
const ROW_KEY: Record<RollupTable, string> = {
  usage_daily: ', owner, model, project',
  sessions_daily: ', outcome, model, effort, plan',
  failures_daily: ', owner, class, tool',
  fleet_daily: '',
  tools_daily: ', harness, tool',
  tool_sessions_daily: ', harness, bucket',
  harness_versions_daily: ', harness, version',
  session_time_daily: ', harness',
  agents_daily: ', harness, type, depth',
  person_sessions_daily: ', owner, harness',
  hour_peaks_daily: ', harness, hour',
};

/** The SQL the reports and rollups ran from reports.ts and rollups.ts, moved here unchanged. */
export class SqliteReportQueries implements ReportQueries {
  constructor(private readonly db: DatabaseSync) {}

  rollupRows(table: RollupTable, from: string, to: string): RollupRaw[] {
    return this.db.prepare(`SELECT * FROM ${table} WHERE day >= ? AND day <= ? ORDER BY day${ROW_KEY[table]}`).all(from, to) as unknown as RollupRaw[];
  }

  rollupOldestDay(table: RollupTable): string | null {
    return (this.db.prepare(`SELECT MIN(day) AS d FROM ${table}`).get() as { d: string | null }).d;
  }

  rollupStats(table: RollupTable): { n: number; d: string | null } {
    return this.db.prepare(`SELECT COUNT(*) AS n, MIN(day) AS d FROM ${table}`).get() as { n: number; d: string | null };
  }

  storedPeak(day: string): number | undefined {
    return (this.db.prepare('SELECT peak_live_sessions AS p FROM fleet_daily WHERE day = ?').get(day) as { p: number } | undefined)?.p;
  }

  ownerGroupNames(): { n: string; g: string }[] {
    return this.db.prepare('SELECT p.name AS n, COALESCE(g.name, \'\') AS g FROM people p LEFT JOIN groups g ON g.id = p.group_id ORDER BY p.id').all() as unknown as { n: string; g: string }[];
  }

  knownPeople(): { name: string; grp: string | null; last: number | null }[] {
    return this.db.prepare('SELECT p.name AS name, g.name AS grp, p.last_report_at AS last FROM people p LEFT JOIN groups g ON g.id = p.group_id ORDER BY p.id').all() as unknown as { name: string; grp: string | null; last: number | null }[];
  }

  countReporters(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM reporters').get() as { n: number }).n;
  }

  countGroups(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n;
  }

  adminLogRows(from: number, to: number, kind: string | undefined, limit: number): RollupRaw[] {
    const sql = `SELECT t, kind, detail, source FROM admin_log WHERE t >= ? AND t < ?${kind ? ' AND kind = ?' : ''} ORDER BY id DESC LIMIT ${limit}`;
    const args = [from, to, ...(kind ? [kind] : [])];
    return this.db.prepare(sql).all(...args) as unknown as RollupRaw[];
  }

  sessionsSince(fromMs: number): StoredSession[] {
    return this.db
      .prepare(
        `SELECT s.*, g.name AS grp FROM sessions s LEFT JOIN people p ON p.name = s.owner LEFT JOIN groups g ON g.id = p.group_id
       WHERE s.last_seen_at >= ? ORDER BY s.last_seen_at, s.id`,
      )
      .all(fromMs) as unknown as StoredSession[];
  }

  agentCountsSince(fromMs: number): { id: string; n: number }[] {
    return this.db.prepare(`SELECT session_id AS id, COUNT(*) AS n FROM agents WHERE session_id IN (${CHOSEN}) GROUP BY session_id ORDER BY session_id`).all(fromMs) as unknown as { id: string; n: number }[];
  }

  reporterKeysSince(fromMs: number): { id: string; k: string }[] {
    return this.db.prepare(`SELECT session_id AS id, MIN(reporter_key) AS k FROM reporter_sessions WHERE session_id IN (${CHOSEN}) GROUP BY session_id ORDER BY session_id`).all(fromMs) as unknown as { id: string; k: string }[];
  }

  failureRowsSince(fromMs: number): { id: string; f: string }[] {
    return this.db.prepare(`SELECT session_id AS id, failure_json AS f FROM agents WHERE failure_json IS NOT NULL AND session_id IN (${CHOSEN}) ORDER BY session_id, id`).all(fromMs) as unknown as { id: string; f: string }[];
  }

  toolCountsSince(fromMs: number): { id: string; c: string }[] {
    return this.db.prepare(`SELECT session_id AS id, tool_counts_json AS c FROM agents WHERE tool_counts_json IS NOT NULL AND session_id IN (${CHOSEN}) ORDER BY session_id, id`).all(fromMs) as unknown as { id: string; c: string }[];
  }

  sampleSpans(): { a: number; b: number }[] {
    return this.db.prepare('SELECT MIN(t) AS a, MAX(t) AS b FROM samples GROUP BY session_id ORDER BY session_id').all() as unknown as { a: number; b: number }[];
  }

  sampleSpansByHarness(): { a: number; b: number; harness: string }[] {
    return this.db.prepare('SELECT MIN(x.t) AS a, MAX(x.t) AS b, s.harness AS harness FROM samples x JOIN sessions s ON s.id = x.session_id GROUP BY x.session_id ORDER BY x.session_id').all() as unknown as { a: number; b: number; harness: string }[];
  }

  waitsSince(fromMs: number): SessionWaitRow[] {
    return this.db.prepare(`SELECT * FROM session_waits WHERE session_id IN (${CHOSEN}) ORDER BY session_id`).all(fromMs) as unknown as SessionWaitRow[];
  }

  agentLinksSince(fromMs: number): { id: string; agent: string; parent: string | null; type: string }[] {
    return this.db.prepare(`SELECT session_id AS id, id AS agent, parent_id AS parent, type FROM agents WHERE session_id IN (${CHOSEN}) ORDER BY session_id, id`).all(fromMs) as unknown as { id: string; agent: string; parent: string | null; type: string }[];
  }

  oldestSessionSeen(): number | null {
    return (this.db.prepare('SELECT MIN(last_seen_at) AS t FROM sessions').get() as { t: number | null }).t;
  }

  rollupDaysBefore(day: string): string[] {
    const written = new Set<string>();
    // order-insensitive: the days are collected into a set.
    for (const table of TABLES) for (const r of this.db.prepare(`SELECT DISTINCT day FROM ${table} WHERE day < ?`).all(day) as unknown as { day: string }[]) written.add(r.day);
    // by code unit, not by locale: the days are ISO dates and every adapter answers in the same order
    return [...written].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  deleteRollupsFrom(day: string): void {
    for (const table of REBUILT) this.db.prepare(`DELETE FROM ${table} WHERE day >= ?`).run(day);
  }

  insertUsage(rows: UsageDay[]): void {
    const putUsage = this.db.prepare('INSERT INTO usage_daily (day, owner, group_name, model, project, sessions, agents, cost_usd, unpriced_sessions, tok_in, tok_out, tok_cr, tok_cw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const u of rows) putUsage.run(u.day, u.owner, u.group, u.model, u.project, u.sessions, u.agents, u.costUsd, u.unpricedSessions, u.tokIn, u.tokOut, u.tokCr, u.tokCw);
  }

  insertSessionsDaily(rows: SessionsDay[]): void {
    const putSessions = this.db.prepare('INSERT INTO sessions_daily (day, outcome, model, effort, plan, sessions, duration_s, max_duration_s, agents, blowouts, max_context_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of rows) putSessions.run(s.day, s.outcome, s.model, s.effort, s.plan, s.sessions, s.durationS, s.maxDurationS, s.agents, s.blowouts, s.maxContextPct);
  }

  insertFailures(rows: FailureDay[]): void {
    const putFailure = this.db.prepare('INSERT INTO failures_daily (day, owner, class, tool, count) VALUES (?, ?, ?, ?, ?)');
    for (const f of rows) putFailure.run(f.day, f.owner, f.cls, f.tool, f.count);
  }

  insertToolsDaily(rows: ToolDay[]): void {
    const put = this.db.prepare('INSERT INTO tools_daily (day, harness, tool, calls) VALUES (?, ?, ?, ?)');
    for (const r of rows) put.run(r.day, r.harness, r.tool, r.calls);
  }

  insertToolSessionsDaily(rows: ToolSessionDay[]): void {
    const put = this.db.prepare('INSERT INTO tool_sessions_daily (day, harness, bucket, sessions) VALUES (?, ?, ?, ?)');
    for (const r of rows) put.run(r.day, r.harness, r.bucket, r.sessions);
  }

  insertHarnessVersionsDaily(rows: HarnessVersionDay[]): void {
    const put = this.db.prepare('INSERT INTO harness_versions_daily (day, harness, version, reporters) VALUES (?, ?, ?, ?)');
    for (const r of rows) put.run(r.day, r.harness, r.version, r.reporters);
  }

  insertSessionTimeDaily(rows: SessionTimeDay[]): void {
    const put = this.db.prepare(
      'INSERT INTO session_time_daily (day, harness, sessions, duration_s, max_duration_s, tracked_sessions, tracked_s, permission_s, permission_n, question_s, question_n, plan_s, plan_n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) put.run(r.day, r.harness, r.sessions, r.durationS, r.maxDurationS, r.trackedSessions, r.trackedS, r.permissionS, r.permissionN, r.questionS, r.questionN, r.planS, r.planN);
  }

  insertAgentsDaily(rows: AgentDay[]): void {
    const put = this.db.prepare('INSERT INTO agents_daily (day, harness, type, depth, agents) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) put.run(r.day, r.harness, r.type, r.depth, r.agents);
  }

  insertPersonSessionsDaily(rows: PersonDay[]): void {
    const put = this.db.prepare('INSERT INTO person_sessions_daily (day, owner, group_name, harness, sessions) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) put.run(r.day, r.owner, r.group, r.harness, r.sessions);
  }

  upsertHourPeaks(rows: HourPeakDay[]): void {
    const put = this.db.prepare('INSERT INTO hour_peaks_daily (day, harness, hour, peak) VALUES (?, ?, ?, ?) ON CONFLICT(day, harness, hour) DO UPDATE SET peak = MAX(hour_peaks_daily.peak, excluded.peak)');
    for (const r of rows) put.run(r.day, r.harness, r.hour, r.peak);
  }

  upsertFleetDays(rows: { day: FleetDay; peak: number }[]): void {
    const putFleet = this.db.prepare(
      `INSERT INTO fleet_daily (day, active_people, active_reporters, sessions_started, peak_live_sessions, reporter_versions_json, engine_versions_json) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET active_people = excluded.active_people, active_reporters = excluded.active_reporters, sessions_started = excluded.sessions_started,
           peak_live_sessions = MAX(fleet_daily.peak_live_sessions, excluded.peak_live_sessions), reporter_versions_json = excluded.reporter_versions_json, engine_versions_json = excluded.engine_versions_json`,
    );
    for (const { day: f, peak } of rows) putFleet.run(f.day, f.activePeople, f.activeReporters, f.sessionsStarted, peak, JSON.stringify(f.reporterVersions), JSON.stringify(f.engineVersions));
  }

  deleteRollupsBefore(day: string): number {
    let deleted = 0;
    for (const table of TABLES) deleted += Number(this.db.prepare(`DELETE FROM ${table} WHERE day < ?`).run(day).changes);
    return deleted;
  }
}

/** Only the sessions chosen by the period, so the cost of a report follows its period and not the whole history (#529). */
const CHOSEN = 'SELECT id FROM sessions WHERE last_seen_at >= ?';
