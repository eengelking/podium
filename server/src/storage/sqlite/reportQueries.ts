import type { DatabaseSync } from 'node:sqlite';
import type { FailureDay, FleetDay, SessionsDay, UsageDay } from '../../fleet/rollups.js';
import type { ReportQueries, RollupRaw, RollupTable, StoredSession } from '../reportQueries.js';

const TABLES: RollupTable[] = ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily'];

/** The SQL the reports and rollups ran from reports.ts and rollups.ts, moved here unchanged. */
export class SqliteReportQueries implements ReportQueries {
  constructor(private readonly db: DatabaseSync) {}

  rollupRows(table: RollupTable, from: string, to: string): RollupRaw[] {
    return this.db.prepare(`SELECT * FROM ${table} WHERE day >= ? AND day <= ? ORDER BY day`).all(from, to) as unknown as RollupRaw[];
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
    return this.db.prepare('SELECT p.name AS n, COALESCE(g.name, \'\') AS g FROM people p LEFT JOIN groups g ON g.id = p.group_id').all() as unknown as { n: string; g: string }[];
  }

  knownPeople(): { name: string; grp: string | null; last: number | null }[] {
    return this.db.prepare('SELECT p.name AS name, g.name AS grp, p.last_report_at AS last FROM people p LEFT JOIN groups g ON g.id = p.group_id').all() as unknown as { name: string; grp: string | null; last: number | null }[];
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
    return this.db.prepare(`SELECT session_id AS id, COUNT(*) AS n FROM agents WHERE session_id IN (${CHOSEN}) GROUP BY session_id`).all(fromMs) as unknown as { id: string; n: number }[];
  }

  reporterKeysSince(fromMs: number): { id: string; k: string }[] {
    return this.db.prepare(`SELECT session_id AS id, MIN(reporter_key) AS k FROM reporter_sessions WHERE session_id IN (${CHOSEN}) GROUP BY session_id`).all(fromMs) as unknown as { id: string; k: string }[];
  }

  failureRowsSince(fromMs: number): { id: string; f: string }[] {
    return this.db.prepare(`SELECT session_id AS id, failure_json AS f FROM agents WHERE failure_json IS NOT NULL AND session_id IN (${CHOSEN})`).all(fromMs) as unknown as { id: string; f: string }[];
  }

  sampleSpans(): { a: number; b: number }[] {
    return this.db.prepare('SELECT MIN(t) AS a, MAX(t) AS b FROM samples GROUP BY session_id').all() as unknown as { a: number; b: number }[];
  }

  oldestSessionSeen(): number | null {
    return (this.db.prepare('SELECT MIN(last_seen_at) AS t FROM sessions').get() as { t: number | null }).t;
  }

  rollupDaysBefore(day: string): string[] {
    const written = new Set<string>();
    for (const table of TABLES) for (const r of this.db.prepare(`SELECT DISTINCT day FROM ${table} WHERE day < ?`).all(day) as unknown as { day: string }[]) written.add(r.day);
    return [...written];
  }

  deleteRollupsFrom(day: string): void {
    for (const table of ['usage_daily', 'sessions_daily', 'failures_daily']) this.db.prepare(`DELETE FROM ${table} WHERE day >= ?`).run(day);
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
