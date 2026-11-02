// The report and rollup queries behind Admin > Reporting on PostgreSQL (#822): the SQLite `SqliteReportQueries` over `PgDb`. Every ordering
// SQLite got from a primary-key index or a group is stated here.
import type { FailureDay, FleetDay, SessionsDay, UsageDay } from '../../fleet/rollups.js';
import type { RollupRaw, RollupTable, StoredSession, ReportQueries } from '../reportQueries.js';
import type { Async } from '../types.js';
import type { PgDb } from './conn.js';

const TABLES: RollupTable[] = ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily'];

/** Each rollup table's primary key, which is the order SQLite read a day range in. */
const ORDER: Record<RollupTable, string> = {
  usage_daily: 'day, owner, model, project',
  sessions_daily: 'day, outcome, model, effort, plan',
  failures_daily: 'day, owner, class, tool',
  fleet_daily: 'day',
};

/** Only the sessions chosen by the period, so the cost of a report follows its period and not the whole history (#529). */
const CHOSEN = 'SELECT id FROM sessions WHERE last_seen_at >= ?';

export class PgReportQueries implements Async<ReportQueries> {
  constructor(private readonly db: PgDb) {}

  rollupRows(table: RollupTable, from: string, to: string): Promise<RollupRaw[]> {
    return this.db.all<RollupRaw>(`SELECT * FROM ${table} WHERE day >= ? AND day <= ? ORDER BY ${ORDER[table]}`, [from, to]);
  }

  async rollupOldestDay(table: RollupTable): Promise<string | null> {
    return (await this.db.get<{ d: string | null }>(`SELECT MIN(day) AS d FROM ${table}`))!.d;
  }

  async rollupStats(table: RollupTable): Promise<{ n: number; d: string | null }> {
    return (await this.db.get<{ n: number; d: string | null }>(`SELECT COUNT(*) AS n, MIN(day) AS d FROM ${table}`))!;
  }

  async storedPeak(day: string): Promise<number | undefined> {
    return (await this.db.get<{ p: number }>('SELECT peak_live_sessions AS p FROM fleet_daily WHERE day = ?', [day]))?.p;
  }

  ownerGroupNames(): Promise<{ n: string; g: string }[]> {
    return this.db.all<{ n: string; g: string }>("SELECT p.name AS n, COALESCE(g.name, '') AS g FROM people p LEFT JOIN groups g ON g.id = p.group_id ORDER BY p.id");
  }

  knownPeople(): Promise<{ name: string; grp: string | null; last: number | null }[]> {
    return this.db.all<{ name: string; grp: string | null; last: number | null }>('SELECT p.name AS name, g.name AS grp, p.last_report_at AS last FROM people p LEFT JOIN groups g ON g.id = p.group_id ORDER BY p.id');
  }

  async countReporters(): Promise<number> {
    return Number((await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reporters'))!.n);
  }

  async countGroups(): Promise<number> {
    return Number((await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM groups'))!.n);
  }

  adminLogRows(from: number, to: number, kind: string | undefined, limit: number): Promise<RollupRaw[]> {
    const sql = `SELECT t, kind, detail, source FROM admin_log WHERE t >= ? AND t < ?${kind ? ' AND kind = ?' : ''} ORDER BY id DESC LIMIT ?`;
    return this.db.all<RollupRaw>(sql, [from, to, ...(kind ? [kind] : []), limit]);
  }

  sessionsSince(fromMs: number): Promise<StoredSession[]> {
    return this.db.all<StoredSession>(
      `SELECT s.*, g.name AS grp FROM sessions s LEFT JOIN people p ON p.name = s.owner LEFT JOIN groups g ON g.id = p.group_id
       WHERE s.last_seen_at >= ? ORDER BY s.last_seen_at, s.id`,
      [fromMs],
    );
  }

  agentCountsSince(fromMs: number): Promise<{ id: string; n: number }[]> {
    return this.db.all<{ id: string; n: number }>(`SELECT session_id AS id, COUNT(*) AS n FROM agents WHERE session_id IN (${CHOSEN}) GROUP BY session_id ORDER BY session_id`, [fromMs]);
  }

  reporterKeysSince(fromMs: number): Promise<{ id: string; k: string }[]> {
    return this.db.all<{ id: string; k: string }>(`SELECT session_id AS id, MIN(reporter_key) AS k FROM reporter_sessions WHERE session_id IN (${CHOSEN}) GROUP BY session_id ORDER BY session_id`, [fromMs]);
  }

  failureRowsSince(fromMs: number): Promise<{ id: string; f: string }[]> {
    return this.db.all<{ id: string; f: string }>(`SELECT session_id AS id, failure_json AS f FROM agents WHERE failure_json IS NOT NULL AND session_id IN (${CHOSEN}) ORDER BY session_id, id`, [fromMs]);
  }

  sampleSpans(): Promise<{ a: number; b: number }[]> {
    return this.db.all<{ a: number; b: number }>('SELECT MIN(t) AS a, MAX(t) AS b FROM samples GROUP BY session_id ORDER BY session_id');
  }

  async oldestSessionSeen(): Promise<number | null> {
    return (await this.db.get<{ t: number | null }>('SELECT MIN(last_seen_at) AS t FROM sessions'))!.t;
  }

  async rollupDaysBefore(day: string): Promise<string[]> {
    const written = new Set<string>();
    for (const table of TABLES) for (const r of await this.db.all<{ day: string }>(`SELECT DISTINCT day FROM ${table} WHERE day < ?`, [day])) written.add(r.day);
    // by code unit, not by locale: the days are ISO dates and every adapter answers in the same order
    return [...written].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  async deleteRollupsFrom(day: string): Promise<void> {
    for (const table of ['usage_daily', 'sessions_daily', 'failures_daily']) await this.db.run(`DELETE FROM ${table} WHERE day >= ?`, [day]);
  }

  insertUsage(rows: UsageDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const u of rows) {
        await this.db.run(
          'INSERT INTO usage_daily (day, owner, group_name, model, project, sessions, agents, cost_usd, unpriced_sessions, tok_in, tok_out, tok_cr, tok_cw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [u.day, u.owner, u.group, u.model, u.project, u.sessions, u.agents, u.costUsd, u.unpricedSessions, u.tokIn, u.tokOut, u.tokCr, u.tokCw],
        );
      }
    });
  }

  insertSessionsDaily(rows: SessionsDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const s of rows) {
        await this.db.run(
          'INSERT INTO sessions_daily (day, outcome, model, effort, plan, sessions, duration_s, max_duration_s, agents, blowouts, max_context_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [s.day, s.outcome, s.model, s.effort, s.plan, s.sessions, s.durationS, s.maxDurationS, s.agents, s.blowouts, s.maxContextPct],
        );
      }
    });
  }

  insertFailures(rows: FailureDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const f of rows) await this.db.run('INSERT INTO failures_daily (day, owner, class, tool, count) VALUES (?, ?, ?, ?, ?)', [f.day, f.owner, f.cls, f.tool, f.count]);
    });
  }

  upsertFleetDays(rows: { day: FleetDay; peak: number }[]): Promise<void> {
    return this.db.tx(async () => {
      for (const { day: f, peak } of rows) {
        await this.db.run(
          `INSERT INTO fleet_daily (day, active_people, active_reporters, sessions_started, peak_live_sessions, reporter_versions_json, engine_versions_json) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day) DO UPDATE SET active_people = excluded.active_people, active_reporters = excluded.active_reporters, sessions_started = excluded.sessions_started,
             peak_live_sessions = GREATEST(fleet_daily.peak_live_sessions, excluded.peak_live_sessions), reporter_versions_json = excluded.reporter_versions_json, engine_versions_json = excluded.engine_versions_json`,
          [f.day, f.activePeople, f.activeReporters, f.sessionsStarted, peak, JSON.stringify(f.reporterVersions), JSON.stringify(f.engineVersions)],
        );
      }
    });
  }

  async deleteRollupsBefore(day: string): Promise<number> {
    let deleted = 0;
    for (const table of TABLES) deleted += await this.db.run(`DELETE FROM ${table} WHERE day < ?`, [day]);
    return deleted;
  }
}
