// The daily rollups behind Admin > Reporting (#484, SPEC 7.2 "Migration 22" and "Retention").
//
// A rollup holds counts, tokens, cost and names (a person, group, model, project, effort), never a prompt, an answer, a
// tool's input or a path. A day is a calendar day in the server's time zone, `YYYY-MM-DD`; a session counts on the day it
// was last seen, so one that runs past midnight is not split. The hourly retention writes the rollups before it deletes
// anything (`writeRollups`); the reports read today straight from the live tables with the same builder (`buildRollups`).
import { repriced } from './derive.js';
import { ROLLUP_KEEP_MS, type CostOf, type FleetDb, type SessionRow } from './db.js';
import type { Pricing } from './pricing.js';

// ---- days ---------------------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of the server-local calendar day `ms` falls in. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The parts of a `YYYY-MM-DD`, or null when it is not a real calendar day. */
export function parseDay(day: string): { y: number; m: number; d: number } | null {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!hit) return null;
  const [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  const probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d ? { y, m, d } : null;
}

/** Server-local midnight that starts `day` (which must be a valid day). */
export function dayStart(day: string): number {
  const p = parseDay(day)!;
  return new Date(p.y, p.m - 1, p.d).getTime();
}

/** `day` moved by `n` calendar days (a day with 23 or 25 hours is still one day). */
export function addDays(day: string, n: number): string {
  const p = parseDay(day)!;
  return localDay(new Date(p.y, p.m - 1, p.d + n).getTime());
}

/** Whole calendar days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  const x = parseDay(a)!;
  const y = parseDay(b)!;
  return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86_400_000);
}

/** The server's time zone, as every report states it. */
export const serverZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// ---- shapes -------------------------------------------------------------------------------------

export interface UsageDay {
  day: string;
  owner: string;
  group: string;
  model: string;
  project: string;
  sessions: number;
  agents: number;
  costUsd: number;
  unpricedSessions: number;
  tokIn: number;
  tokOut: number;
  tokCr: number;
  tokCw: number;
}

export interface SessionsDay {
  day: string;
  outcome: string;
  model: string;
  effort: string;
  plan: string;
  sessions: number;
  durationS: number;
  maxDurationS: number;
  agents: number;
  blowouts: number;
  maxContextPct: number;
}

export interface FailureDay {
  day: string;
  owner: string;
  cls: string;
  tool: string;
  count: number;
}

export interface FleetDay {
  day: string;
  activePeople: number;
  activeReporters: number;
  sessionsStarted: number;
  peakLive: number;
  reporterVersions: Record<string, number>;
  engineVersions: Record<string, number>;
}

export interface DayRollups {
  usage: UsageDay[];
  sessions: SessionsDay[];
  failures: FailureDay[];
  fleet: FleetDay[];
  /** Which stored sessions had each failure (not kept in a rollup; the History link reads it while the sessions last). */
  failureSessions: { day: string; owner: string; cls: string; tool: string; sessionId: string }[];
}

/** What a stored session costs with the Admin's prices, as every cost figure on the wall does. */
export const costFn =
  (pricing: Pricing | undefined): CostOf =>
  (r) =>
    repriced(pricing, r.usage_json, r.cost_usd);

const safeParse = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

// ---- building -----------------------------------------------------------------------------------

type StoredSession = SessionRow & { grp: string | null };

/** How long a session ran, in whole seconds. */
const durationS = (s: SessionRow): number => Math.max(0, Math.round(((s.ended_at ?? s.last_seen_at) - s.started_at) / 1000));

/** The plan a session works from: where its plan came from, or `none`. */
const planOf = (s: SessionRow): string => safeParse<{ source?: string } | null>(s.plan_json ?? s.plan_kept_json ?? null, null)?.source ?? 'none';

const outcomeOf = (s: SessionRow): string => s.end_reason ?? (s.ended_at === null && s.dropped_at === null && s.status !== 'done' ? 'running' : 'ended');

/**
 * The rollups of every stored session last seen at or after `fromMs`. `sessionsStarted` counts the sessions started on a
 * day, wherever they were last seen. The peak of live sessions is left at 0: `peakLiveByDay` reads it from the samples.
 */
export function buildRollups(db: FleetDb, cost: CostOf, fromMs: number): DayRollups {
  const sessions = db.db
    .prepare(
      `SELECT s.*, g.name AS grp FROM sessions s LEFT JOIN people p ON p.name = s.owner LEFT JOIN groups g ON g.id = p.group_id
       WHERE s.last_seen_at >= ? ORDER BY s.last_seen_at, s.id`,
    )
    .all(fromMs) as unknown as StoredSession[];
  // Only the sessions chosen above, so the cost of a report follows its period and not the whole history (#529).
  const chosen = 'SELECT id FROM sessions WHERE last_seen_at >= ?';
  const agentCount = new Map<string, number>();
  for (const r of db.db.prepare(`SELECT session_id AS id, COUNT(*) AS n FROM agents WHERE session_id IN (${chosen}) GROUP BY session_id`).all(fromMs) as unknown as { id: string; n: number }[]) agentCount.set(r.id, r.n);
  const reporterOf = new Map<string, string>();
  for (const r of db.db.prepare(`SELECT session_id AS id, MIN(reporter_key) AS k FROM reporter_sessions WHERE session_id IN (${chosen}) GROUP BY session_id`).all(fromMs) as unknown as { id: string; k: string }[]) reporterOf.set(r.id, r.k);
  const failureRows = db.db.prepare(`SELECT session_id AS id, failure_json AS f FROM agents WHERE failure_json IS NOT NULL AND session_id IN (${chosen})`).all(fromMs) as unknown as { id: string; f: string }[];
  const failuresOf = new Map<string, { cls: string; tool: string }[]>();
  for (const r of failureRows) {
    const f = safeParse<{ class?: string; tool?: string | null } | null>(r.f, null);
    if (!f?.class) continue;
    const list = failuresOf.get(r.id) ?? [];
    list.push({ cls: f.class, tool: f.tool ?? '' });
    failuresOf.set(r.id, list);
  }

  const usage = new Map<string, UsageDay>();
  const sess = new Map<string, SessionsDay>();
  const fail = new Map<string, FailureDay>();
  const failSessions: DayRollups['failureSessions'] = [];
  interface FleetAcc {
    people: Set<string>;
    reporters: Set<string>;
    started: number;
    rv: Map<string, Set<string>>;
    ev: Map<string, Set<string>>;
  }
  const fleet = new Map<string, FleetAcc>();
  const fleetOf = (day: string): FleetAcc => {
    let f = fleet.get(day);
    if (!f) fleet.set(day, (f = { people: new Set(), reporters: new Set(), started: 0, rv: new Map(), ev: new Map() }));
    return f;
  };
  const fromDay = localDay(fromMs);

  for (const s of sessions) {
    const day = localDay(s.last_seen_at);
    const owner = s.owner ?? '';
    const model = s.model ?? '';
    const c = cost({ cost_usd: s.cost_usd, usage_json: s.usage_json });
    const agents = agentCount.get(s.id) ?? 0;

    const uk = `${day}\u0000${owner}\u0000${model}\u0000${s.repo_name ?? ''}`;
    const u =
      usage.get(uk) ??
      ({ day, owner, group: s.grp ?? '', model, project: s.repo_name ?? '', sessions: 0, agents: 0, costUsd: 0, unpricedSessions: 0, tokIn: 0, tokOut: 0, tokCr: 0, tokCw: 0 } satisfies UsageDay);
    u.sessions += 1;
    u.agents += agents;
    if (c === null) u.unpricedSessions += 1;
    else u.costUsd += c;
    u.tokIn += s.tok_in ?? 0;
    u.tokOut += s.tok_out ?? 0;
    u.tokCr += s.tok_cr ?? 0;
    u.tokCw += s.tok_cw ?? 0;
    usage.set(uk, u);

    const outcome = outcomeOf(s);
    const effort = s.effort ?? '';
    const plan = planOf(s);
    const sk = `${day}\u0000${outcome}\u0000${model}\u0000${effort}\u0000${plan}`;
    const d = durationS(s);
    const x =
      sess.get(sk) ?? ({ day, outcome, model, effort, plan, sessions: 0, durationS: 0, maxDurationS: 0, agents: 0, blowouts: 0, maxContextPct: 0 } satisfies SessionsDay);
    x.sessions += 1;
    x.durationS += d;
    x.maxDurationS = Math.max(x.maxDurationS, d);
    x.agents += agents;
    x.blowouts += s.blowouts ?? 0;
    x.maxContextPct = Math.max(x.maxContextPct, s.context_percent ?? 0);
    sess.set(sk, x);

    for (const f of failuresOf.get(s.id) ?? []) {
      const fk = `${day}\u0000${owner}\u0000${f.cls}\u0000${f.tool}`;
      const row = fail.get(fk) ?? ({ day, owner, cls: f.cls, tool: f.tool, count: 0 } satisfies FailureDay);
      row.count += 1;
      fail.set(fk, row);
      failSessions.push({ day, owner, cls: f.cls, tool: f.tool, sessionId: s.id });
    }

    const fl = fleetOf(day);
    if (owner) fl.people.add(owner);
    const machine = safeParse<{ id?: string } | null>(s.machine_json, null)?.id;
    const reporter = reporterOf.get(s.id) ?? (machine ? `${machine}#${owner}` : null);
    if (reporter) {
      fl.reporters.add(reporter);
      for (const [version, into] of [
        [s.reporter_version, fl.rv],
        [s.engine_version, fl.ev],
      ] as const) {
        if (!version) continue;
        const set = into.get(version) ?? new Set<string>();
        set.add(reporter);
        into.set(version, set);
      }
    }
  }
  // Sessions started on a day count there even when last seen on a later one (the sessions list above starts at fromMs).
  for (const s of sessions) {
    const day = localDay(s.started_at);
    if (day >= fromDay) fleetOf(day).started += 1;
  }

  const counts = (m: Map<string, Set<string>>): Record<string, number> => Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.size]));
  return {
    usage: [...usage.values()],
    sessions: [...sess.values()],
    failures: [...fail.values()],
    fleet: [...fleet].sort(([a], [b]) => a.localeCompare(b)).map(([day, f]) => ({ day, activePeople: f.people.size, activeReporters: f.reporters.size, sessionsStarted: f.started, peakLive: 0, reporterVersions: counts(f.rv), engineVersions: counts(f.ev) })),
    failureSessions: failSessions,
  };
}

/**
 * The most sessions live at one second on each day the samples cover. A session is live from its first sample to its last,
 * and a session that lives across midnight counts on both days.
 */
export function peakLiveByDay(db: FleetDb): Map<string, number> {
  const spans = db.db.prepare('SELECT MIN(t) AS a, MAX(t) AS b FROM samples GROUP BY session_id').all() as unknown as { a: number; b: number }[];
  const perDay = new Map<string, [number, number][]>();
  for (const { a, b } of spans) {
    for (let day = localDay(a * 1000); day <= localDay(b * 1000); day = addDays(day, 1)) {
      const list = perDay.get(day) ?? [];
      list.push([Math.max(a, Math.floor(dayStart(day) / 1000)), Math.min(b, Math.floor(dayStart(addDays(day, 1)) / 1000) - 1)]);
      perDay.set(day, list);
    }
  }
  const out = new Map<string, number>();
  for (const [day, list] of perDay) {
    const edges = list.flatMap(([a, b]) => [[a, 1] as const, [b + 1, -1] as const]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let now = 0;
    let peak = 0;
    for (const [, delta] of edges) {
      now += delta;
      peak = Math.max(peak, now);
    }
    out.set(day, peak);
  }
  return out;
}

// ---- writing ------------------------------------------------------------------------------------

export interface RollupPolicy {
  sessionsMs: number;
  rollupMs?: number;
}

/**
 * Rebuilds the daily rollups from the rows still stored, in one transaction, so a second run gives the same rows.
 * It runs inside the hourly retention before anything is deleted. It rebuilds each day from the oldest stored session's day
 * through today, except a day that retention may already have taken sessions from (it began before `sessionsMs` ago): that
 * day is left as it was last written, since rebuilding it from what is left would lower it, except the one the cutoff falls in, which is written
 * from what is left when no run has written it yet. A day's peak of live sessions
 * never goes down. Rollup rows older than `rollupMs` are deleted. Returns how many days it rebuilt and how many rows it dropped.
 */
export function writeRollups(db: FleetDb, now: number, cost: CostOf, p: RollupPolicy): { days: number; deleted: number } {
  return db.tx(() => {
    let rebuilt = 0;
    const oldest = (db.db.prepare('SELECT MIN(last_seen_at) AS t FROM sessions').get() as { t: number | null }).t;
    if (oldest !== null) {
      const sessionCutoff = now - p.sessionsMs;
      const firstDay = localDay(oldest);
      let fromDay = firstDay;
      while (dayStart(fromDay) < sessionCutoff && fromDay < localDay(now)) fromDay = addDays(fromDay, 1);
      // The day the cutoff falls in is half swept. It is written when no earlier run did (the first run after an upgrade): a
      // partly built day is better than a hole, and a fuller one written earlier stays. Days wholly before it stay as they are (#529).
      const written = new Set<string>();
      for (const table of ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily'])
        for (const r of db.db.prepare(`SELECT DISTINCT day FROM ${table} WHERE day < ?`).all(fromDay) as unknown as { day: string }[]) written.add(r.day);
      const cutoffDay = localDay(sessionCutoff);
      const wanted = (day: string): boolean => day >= fromDay || (day === cutoffDay && !written.has(day));
      // Build only from the earliest day that will be written, so an ordinary run does not read the whole retained history.
      const buildFrom = cutoffDay < fromDay && !written.has(cutoffDay) ? (cutoffDay > firstDay ? cutoffDay : firstDay) : fromDay;
      const built = buildRollups(db, cost, dayStart(buildFrom));
      const peaks = peakLiveByDay(db);
      for (const table of ['usage_daily', 'sessions_daily', 'failures_daily']) db.db.prepare(`DELETE FROM ${table} WHERE day >= ?`).run(fromDay);
      const putUsage = db.db.prepare('INSERT INTO usage_daily (day, owner, group_name, model, project, sessions, agents, cost_usd, unpriced_sessions, tok_in, tok_out, tok_cr, tok_cw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const u of built.usage.filter((r) => wanted(r.day))) putUsage.run(u.day, u.owner, u.group, u.model, u.project, u.sessions, u.agents, u.costUsd, u.unpricedSessions, u.tokIn, u.tokOut, u.tokCr, u.tokCw);
      const putSessions = db.db.prepare('INSERT INTO sessions_daily (day, outcome, model, effort, plan, sessions, duration_s, max_duration_s, agents, blowouts, max_context_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const s of built.sessions.filter((r) => wanted(r.day))) putSessions.run(s.day, s.outcome, s.model, s.effort, s.plan, s.sessions, s.durationS, s.maxDurationS, s.agents, s.blowouts, s.maxContextPct);
      const putFailure = db.db.prepare('INSERT INTO failures_daily (day, owner, class, tool, count) VALUES (?, ?, ?, ?, ?)');
      for (const f of built.failures.filter((r) => wanted(r.day))) putFailure.run(f.day, f.owner, f.cls, f.tool, f.count);
      const putFleet = db.db.prepare(
        `INSERT INTO fleet_daily (day, active_people, active_reporters, sessions_started, peak_live_sessions, reporter_versions_json, engine_versions_json) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET active_people = excluded.active_people, active_reporters = excluded.active_reporters, sessions_started = excluded.sessions_started,
           peak_live_sessions = MAX(fleet_daily.peak_live_sessions, excluded.peak_live_sessions), reporter_versions_json = excluded.reporter_versions_json, engine_versions_json = excluded.engine_versions_json`,
      );
      for (const f of built.fleet) {
        if (!wanted(f.day)) continue;
        putFleet.run(f.day, f.activePeople, f.activeReporters, f.sessionsStarted, peaks.get(f.day) ?? 0, JSON.stringify(f.reporterVersions), JSON.stringify(f.engineVersions));
        rebuilt += 1;
      }
    }
    const keepFrom = localDay(now - (p.rollupMs ?? ROLLUP_KEEP_MS));
    let deleted = 0;
    for (const table of ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily']) deleted += Number(db.db.prepare(`DELETE FROM ${table} WHERE day < ?`).run(keepFrom).changes);
    return { days: rebuilt, deleted };
  });
}
