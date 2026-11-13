// The report and rollup queries behind Admin > Reporting on MariaDB (#823): the SQLite `SqliteReportQueries` over `MariaDbConn`. Every ordering
// SQLite got from a primary-key index or a group is stated here.
import type { AgentDay, CostDay, ToolCostDay, FailureDay, FleetDay, FeatureVersionDay, HarnessVersionDay, HourPeakDay, PlaceDay, SkillDay, PersonDay, SessionTimeDay, SessionsDay, ToolDay, ToolSessionDay, ToolStatDay, UsageDay } from '../../fleet/rollups.js';
import type { RollupRaw, RollupTable, StoredSession, ReportQueries } from '../reportQueries.js';
import type { SessionWaitRow } from '../rows.js';
import type { Async } from '../types.js';
import type { MariaDbConn } from './conn.js';

const TABLES: RollupTable[] = ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily', 'tools_daily', 'tool_sessions_daily', 'harness_versions_daily', 'tool_stats_daily', 'session_time_daily', 'agents_daily', 'person_sessions_daily', 'hour_peaks_daily', 'cost_daily', 'tool_cost_daily', 'feature_versions_daily', 'skills_daily', 'person_places_daily', 'answers_daily'];
/** The tables that are rebuilt from the stored sessions (the fleet table and the hour peaks are upserted, so a peak never goes down). */
const REBUILT: RollupTable[] = ['usage_daily', 'sessions_daily', 'failures_daily', 'tools_daily', 'tool_sessions_daily', 'harness_versions_daily', 'tool_stats_daily', 'session_time_daily', 'agents_daily', 'person_sessions_daily', 'cost_daily', 'tool_cost_daily', 'feature_versions_daily', 'skills_daily', 'person_places_daily'];

/** Each rollup table's primary key, which is the order SQLite read a day range in. */
const ORDER: Record<RollupTable, string> = {
  usage_daily: 'day, owner, model, project',
  sessions_daily: 'day, outcome, model, effort, plan',
  failures_daily: 'day, owner, class, tool',
  fleet_daily: 'day',
  tools_daily: 'day, harness, tool',
  tool_sessions_daily: 'day, harness, bucket',
  harness_versions_daily: 'day, harness, version',
  tool_stats_daily: 'day, harness, tool',
  feature_versions_daily: 'day, harness, version, feature',
  skills_daily: 'day, owner, harness, skill',
  person_places_daily: 'day, owner, harness, project, branch',
  answers_daily: 'day, harness, kind, bucket',
  session_time_daily: 'day, harness',
  agents_daily: 'day, harness, type, depth',
  person_sessions_daily: 'day, owner, harness',
  hour_peaks_daily: 'day, harness, hour',
  cost_daily: 'day, harness, model, effort',
  tool_cost_daily: 'day, harness, tool',
};

/** Only the sessions chosen by the period, so the cost of a report follows its period and not the whole history (#529). */
const CHOSEN = 'SELECT id FROM sessions WHERE last_seen_at >= ?';

export class MariaReportQueries implements Async<ReportQueries> {
  constructor(private readonly db: MariaDbConn) {}

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

  skillsSince(fromMs: number): Promise<{ id: string; k: string }[]> {
    return this.db.all<{ id: string; k: string }>(`SELECT session_id AS id, skills_json AS k FROM agents WHERE skills_json IS NOT NULL AND skills_json <> '[]' AND session_id IN (${CHOSEN}) ORDER BY session_id, id`, [fromMs]);
  }

  toolCountsSince(fromMs: number): Promise<{ id: string; c: string }[]> {
    return this.db.all<{ id: string; c: string }>(`SELECT session_id AS id, tool_counts_json AS c FROM agents WHERE tool_counts_json IS NOT NULL AND session_id IN (${CHOSEN}) ORDER BY session_id, id`, [fromMs]);
  }

  toolStatsSince(fromMs: number): Promise<{ id: string; s: string }[]> {
    return this.db.all<{ id: string; s: string }>(`SELECT session_id AS id, tool_stats_json AS s FROM agents WHERE tool_stats_json IS NOT NULL AND session_id IN (${CHOSEN}) ORDER BY session_id, id`, [fromMs]);
  }

  sampleSpans(): Promise<{ a: number; b: number }[]> {
    return this.db.all<{ a: number; b: number }>('SELECT MIN(t) AS a, MAX(t) AS b FROM samples GROUP BY session_id ORDER BY session_id');
  }

  sampleSpansByHarness(): Promise<{ a: number; b: number; harness: string }[]> {
    return this.db.all<{ a: number; b: number; harness: string }>('SELECT MIN(x.t) AS a, MAX(x.t) AS b, s.harness AS harness FROM samples x JOIN sessions s ON s.id = x.session_id GROUP BY x.session_id, s.harness ORDER BY x.session_id');
  }

  waitsSince(fromMs: number): Promise<SessionWaitRow[]> {
    return this.db.all<SessionWaitRow>(`SELECT * FROM session_waits WHERE session_id IN (${CHOSEN}) ORDER BY session_id`, [fromMs]);
  }

  agentLinksSince(fromMs: number): Promise<{ id: string; agent: string; parent: string | null; type: string }[]> {
    return this.db.all<{ id: string; agent: string; parent: string | null; type: string }>(`SELECT session_id AS id, id AS agent, parent_id AS parent, type FROM agents WHERE session_id IN (${CHOSEN}) ORDER BY session_id, id`, [fromMs]);
  }

  async oldestSessionSeen(): Promise<number | null> {
    return (await this.db.get<{ t: number | null }>('SELECT MIN(last_seen_at) AS t FROM sessions'))!.t;
  }

  async rollupDaysBefore(day: string): Promise<string[]> {
    const written = new Set<string>();
    // order-insensitive: the days are collected into a set.
    for (const table of TABLES) for (const r of await this.db.all<{ day: string }>(`SELECT DISTINCT day FROM ${table} WHERE day < ?`, [day])) written.add(r.day);
    // by code unit, not by locale: the days are ISO dates and every adapter answers in the same order
    return [...written].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  async deleteRollupsFrom(day: string): Promise<void> {
    for (const table of REBUILT) await this.db.run(`DELETE FROM ${table} WHERE day >= ?`, [day]);
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

  insertToolsDaily(rows: ToolDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) await this.db.run('INSERT INTO tools_daily (day, harness, tool, calls) VALUES (?, ?, ?, ?)', [r.day, r.harness, r.tool, r.calls]);
    });
  }

  insertToolSessionsDaily(rows: ToolSessionDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) await this.db.run('INSERT INTO tool_sessions_daily (day, harness, bucket, sessions) VALUES (?, ?, ?, ?)', [r.day, r.harness, r.bucket, r.sessions]);
    });
  }

  insertHarnessVersionsDaily(rows: HarnessVersionDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) await this.db.run('INSERT INTO harness_versions_daily (day, harness, version, reporters) VALUES (?, ?, ?, ?)', [r.day, r.harness, r.version, r.reporters]);
    });
  }

  insertSkillsDaily(rows: SkillDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) await this.db.run('INSERT INTO skills_daily (day, owner, harness, skill, sessions) VALUES (?, ?, ?, ?, ?)', [r.day, r.owner, r.harness, r.skill, r.sessions]);
    });
  }

  insertPlacesDaily(rows: PlaceDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) await this.db.run('INSERT INTO person_places_daily (day, owner, group_name, harness, project, branch, sessions) VALUES (?, ?, ?, ?, ?, ?, ?)', [r.day, r.owner, r.group, r.harness, r.project, r.branch, r.sessions]);
    });
  }

  insertFeatureVersionsDaily(rows: FeatureVersionDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) await this.db.run('INSERT INTO feature_versions_daily (day, harness, version, feature, sessions) VALUES (?, ?, ?, ?, ?)', [r.day, r.harness, r.version, r.feature, r.sessions]);
    });
  }

  insertToolStatsDaily(rows: ToolStatDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) await this.db.run('INSERT INTO tool_stats_daily (day, harness, tool, failed, asked, allowed, denied, podium, times_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [r.day, r.harness, r.tool, r.failed, r.asked, r.allowed, r.denied, r.podium, r.timesJson]);
    });
  }

  insertSessionTimeDaily(rows: SessionTimeDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) {
        await this.db.run(
          'INSERT INTO session_time_daily (day, harness, sessions, duration_s, max_duration_s, tracked_sessions, tracked_s, permission_s, permission_n, question_s, question_n, plan_s, plan_n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [r.day, r.harness, r.sessions, r.durationS, r.maxDurationS, r.trackedSessions, r.trackedS, r.permissionS, r.permissionN, r.questionS, r.questionN, r.planS, r.planN],
        );
      }
    });
  }

  insertAgentsDaily(rows: AgentDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) await this.db.run('INSERT INTO agents_daily (day, harness, type, depth, agents) VALUES (?, ?, ?, ?, ?)', [r.day, r.harness, r.type, r.depth, r.agents]);
    });
  }

  insertPersonSessionsDaily(rows: PersonDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) await this.db.run('INSERT INTO person_sessions_daily (day, owner, group_name, harness, sessions) VALUES (?, ?, ?, ?, ?)', [r.day, r.owner, r.group, r.harness, r.sessions]);
    });
  }

  insertCostDaily(rows: CostDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) {
        await this.db.run(
          'INSERT INTO cost_daily (day, harness, model, effort, sessions, priced_sessions, calls, priced_calls, cost_usd, call_cost_usd, tok_in, tok_out, tok_cr, tok_cw, ended_low, ended_mid, ended_high, ended_unknown, compacted, cleared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [r.day, r.harness, r.model, r.effort, r.sessions, r.pricedSessions, r.calls, r.pricedCalls, r.costUsd, r.callCostUsd, r.tokIn, r.tokOut, r.tokCr, r.tokCw, r.endedLow, r.endedMid, r.endedHigh, r.endedUnknown, r.compacted, r.cleared],
        );
      }
    });
  }

  insertToolCostDaily(rows: ToolCostDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) await this.db.run('INSERT INTO tool_cost_daily (day, harness, tool, sessions, priced_sessions, cost_usd, calls) VALUES (?, ?, ?, ?, ?, ?, ?)', [r.day, r.harness, r.tool, r.sessions, r.pricedSessions, r.costUsd, r.calls]);
    });
  }

  async addAnswer(day: string, harness: string, kind: string, bucket: number): Promise<void> {
    await this.db.run('INSERT INTO answers_daily (day, harness, kind, bucket, count) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE count = answers_daily.count + 1', [day, harness, kind, bucket]);
  }

  async markAnswerDay(day: string): Promise<void> {
    await this.db.run("INSERT INTO answers_daily (day, harness, kind, bucket, count) VALUES (?, '', 'none', -1, 0) ON DUPLICATE KEY UPDATE count = count", [day]);
  }

  upsertHourPeaks(rows: HourPeakDay[]): Promise<void> {
    return this.db.tx(async () => {
      for (const r of rows) {
        await this.db.run('INSERT INTO hour_peaks_daily (day, harness, hour, peak) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE peak = GREATEST(hour_peaks_daily.peak, VALUES(peak))', [r.day, r.harness, r.hour, r.peak]);
      }
    });
  }

  upsertFleetDays(rows: { day: FleetDay; peak: number }[]): Promise<void> {
    return this.db.tx(async () => {
      for (const { day: f, peak } of rows) {
        await this.db.run(
          `INSERT INTO fleet_daily (day, active_people, active_reporters, sessions_started, peak_live_sessions, reporter_versions_json, engine_versions_json) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE active_people = VALUES(active_people), active_reporters = VALUES(active_reporters), sessions_started = VALUES(sessions_started),
             peak_live_sessions = GREATEST(fleet_daily.peak_live_sessions, VALUES(peak_live_sessions)), reporter_versions_json = VALUES(reporter_versions_json), engine_versions_json = VALUES(engine_versions_json)`,
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
