// The reports behind Admin > Reporting (#484), the Spend breakdown (#482) and the Spend projection (#483), SPEC 7.1 "Reports".
// Pure over the database: today is read live with the rollup builder, every earlier day from the rollup tables.
import { startOfDay } from './derive.js';
import type { CostOf, FleetDb, RetentionPolicy } from './db.js';
import { ROLLUP_KEEP_MS } from './db.js';
import type { ModelUsage } from './protocol.js';
import type { Pricing } from './pricing.js';
import {
  addDays,
  buildRollups,
  costFn,
  dayStart,
  daysBetween,
  localDay,
  parseDay,
  peakLiveByDay,
  serverZone,
  type DayRollups,
  type FailureDay,
  type FleetDay,
  type SessionsDay,
  type UsageDay,
} from './rollups.js';

export interface ReportDeps {
  db: FleetDb;
  now: () => number;
  pricing: () => Pricing | undefined;
  retention: RetentionPolicy;
}

/** A report was asked for something it cannot give: the route answers 400 with the message. */
export class ReportError extends Error {}

export type ReportName = 'usage' | 'spend' | 'people' | 'sessions' | 'failures' | 'activity';
export const REPORT_NAMES: readonly ReportName[] = ['usage', 'spend', 'people', 'sessions', 'failures', 'activity'];

export interface Column {
  key: string;
  label: string;
  unit: 'date' | 'text' | 'count' | 'tokens' | 'usd' | 'seconds' | 'percent' | 'time';
}

export type Row = Record<string, string | number | null | string[]>;

export interface ReportReply {
  report: string;
  from: string;
  to: string;
  by: string | null;
  tz: string;
  basedOn: string;
  oldestDay: string;
  partial: boolean;
  columns: Column[];
  rows: Row[];
  total: Row;
  [extra: string]: unknown;
}

export const MAX_SPAN_DAYS = 400;
const NAME_MAX = 200;
export const BREAKDOWNS: Record<'spend' | 'sessions' | 'failures', readonly string[]> = {
  spend: ['none', 'person', 'group', 'model', 'project'],
  sessions: ['outcome', 'model', 'effort', 'plan'],
  failures: ['class', 'tool', 'person'],
};

const round = (n: number, places = 6): number => Math.round(n * 10 ** places) / 10 ** places;
/** An empty name is shown as a dash, and a dash in a filter means the empty name. */
const label = (s: string): string => (s === '' ? '-' : s);
const unlabel = (s: string): string => (s === '-' ? '' : s);
const col = (key: string, name: string, unit: Column['unit']): Column => ({ key, label: name, unit });

type Query = Record<string, unknown>;

const one = (q: Query, k: string): string | undefined => {
  const v = q[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new ReportError(`${k} must be a single value`);
  return v;
};

function filterOf(q: Query, k: 'person' | 'group' | 'model'): string | null {
  const v = one(q, k);
  if (v === undefined || v === '') return null;
  if (v.length > NAME_MAX) throw new ReportError(`${k} is too long`);
  return unlabel(v);
}

interface Params {
  from: string;
  to: string;
  by: 'day' | 'week' | 'month';
  person: string | null;
  group: string | null;
  model: string | null;
  today: string;
}

function parseParams(q: Query, today: string): Params {
  const to = one(q, 'to') ?? today;
  const from = one(q, 'from') ?? addDays(to, -29);
  if (!parseDay(from)) throw new ReportError('from must be a day as YYYY-MM-DD');
  if (!parseDay(to)) throw new ReportError('to must be a day as YYYY-MM-DD');
  if (to > today) throw new ReportError('to must not be after today');
  if (from > to) throw new ReportError('from must not be after to');
  if (daysBetween(from, to) > MAX_SPAN_DAYS) throw new ReportError(`the period must be at most ${MAX_SPAN_DAYS} days`);
  const by = one(q, 'by') ?? 'day';
  if (by !== 'day' && by !== 'week' && by !== 'month') throw new ReportError('by must be day, week or month');
  return { from, to, by, person: filterOf(q, 'person'), group: filterOf(q, 'group'), model: filterOf(q, 'model'), today };
}

function pick(q: Query, name: 'spend' | 'sessions' | 'failures'): string {
  const v = one(q, 'breakdown') ?? BREAKDOWNS[name][0]!;
  if (!BREAKDOWNS[name].includes(v)) throw new ReportError(`breakdown must be ${BREAKDOWNS[name].join(', ')}`);
  return v;
}

/** The first day of the week, month or day `day` falls in; weeks start on Monday. */
export function bucketOf(day: string, by: 'day' | 'week' | 'month'): string {
  if (by === 'day') return day;
  if (by === 'month') return day.slice(0, 7);
  const p = parseDay(day)!;
  const dow = (new Date(p.y, p.m - 1, p.d).getDay() + 6) % 7;
  return addDays(day, -dow);
}

// ---- reading the facts ----------------------------------------------------------------------------

interface Facts {
  usage: UsageDay[];
  sessions: SessionsDay[];
  failures: FailureDay[];
  fleet: FleetDay[];
  oldestDay: string;
  live: DayRollups;
}

type Raw = Record<string, string | number | null>;

const usageOf = (r: Raw): UsageDay => ({ day: String(r.day), owner: String(r.owner), group: String(r.group_name), model: String(r.model), project: String(r.project), sessions: Number(r.sessions), agents: Number(r.agents), costUsd: Number(r.cost_usd), unpricedSessions: Number(r.unpriced_sessions), tokIn: Number(r.tok_in), tokOut: Number(r.tok_out), tokCr: Number(r.tok_cr), tokCw: Number(r.tok_cw) });
const sessionsOf = (r: Raw): SessionsDay => ({ day: String(r.day), outcome: String(r.outcome), model: String(r.model), effort: String(r.effort), plan: String(r.plan), sessions: Number(r.sessions), durationS: Number(r.duration_s), maxDurationS: Number(r.max_duration_s), agents: Number(r.agents), blowouts: Number(r.blowouts), maxContextPct: Number(r.max_context_pct) });
const failureOf = (r: Raw): FailureDay => ({ day: String(r.day), owner: String(r.owner), cls: String(r.class), tool: String(r.tool), count: Number(r.count) });
const fleetOf = (r: Raw): FleetDay => ({ day: String(r.day), activePeople: Number(r.active_people), activeReporters: Number(r.active_reporters), sessionsStarted: Number(r.sessions_started), peakLive: Number(r.peak_live_sessions), reporterVersions: JSON.parse(String(r.reporter_versions_json)) as Record<string, number>, engineVersions: JSON.parse(String(r.engine_versions_json)) as Record<string, number> });

function select(db: FleetDb, table: string, from: string, to: string): Raw[] {
  return db.db.prepare(`SELECT * FROM ${table} WHERE day >= ? AND day <= ? ORDER BY day`).all(from, to) as unknown as Raw[];
}

/** The first day the rollups hold, or today when they hold none yet (today is always read live). */
export function oldestRollupDay(db: FleetDb, today: string): string {
  let oldest = today;
  for (const t of ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily']) {
    const d = (db.db.prepare(`SELECT MIN(day) AS d FROM ${t}`).get() as { d: string | null }).d;
    if (d !== null && d < oldest) oldest = d;
  }
  return oldest;
}

function loadFacts(deps: ReportDeps, from: string, to: string, today: string, cost: CostOf, withSessions = false): Facts {
  const { db } = deps;
  const stored = to < today ? to : addDays(today, -1);
  const f: Facts = { usage: [], sessions: [], failures: [], fleet: [], oldestDay: oldestRollupDay(db, today), live: { usage: [], sessions: [], failures: [], fleet: [], failureSessions: [] } };
  if (from <= stored) {
    f.usage = select(db, 'usage_daily', from, stored).map(usageOf);
    f.sessions = select(db, 'sessions_daily', from, stored).map(sessionsOf);
    f.failures = select(db, 'failures_daily', from, stored).map(failureOf);
    f.fleet = select(db, 'fleet_daily', from, stored).map(fleetOf);
  }
  // Failures keep which sessions had them only while the sessions are stored, so the History link reads those live.
  const floor = addDays(today, -31);
  f.live = buildRollups(db, cost, dayStart(withSessions ? (from > floor ? from : floor) : today));
  if (to === today) {
    const peaks = peakLiveByDay(db);
    const keep = (d: string) => d === today;
    f.usage.push(...f.live.usage.filter((r) => keep(r.day)));
    f.sessions.push(...f.live.sessions.filter((r) => keep(r.day)));
    f.failures.push(...f.live.failures.filter((r) => keep(r.day)));
    const storedPeak = (db.db.prepare('SELECT peak_live_sessions AS p FROM fleet_daily WHERE day = ?').get(today) as { p: number } | undefined)?.p ?? 0;
    const liveFleet = f.live.fleet.find((r) => keep(r.day));
    if (liveFleet) f.fleet.push({ ...liveFleet, peakLive: Math.max(storedPeak, peaks.get(today) ?? 0) });
    else if (storedPeak || peaks.get(today)) f.fleet.push({ day: today, activePeople: 0, activeReporters: 0, sessionsStarted: 0, peakLive: Math.max(storedPeak, peaks.get(today) ?? 0), reporterVersions: {}, engineVersions: {} });
  }
  return f;
}

const ownerGroups = (db: FleetDb): Map<string, string> =>
  new Map((db.db.prepare('SELECT p.name AS n, COALESCE(g.name, \'\') AS g FROM people p LEFT JOIN groups g ON g.id = p.group_id').all() as unknown as { n: string; g: string }[]).map((r) => [r.n, r.g]));

function envelope(p: Params, report: string, by: string | null, f: Facts, columns: Column[], rows: Row[], total: Row): ReportReply {
  return {
    report,
    from: p.from,
    to: p.to,
    by,
    tz: serverZone(),
    basedOn: p.to === p.today ? 'rollups and live' : 'rollups',
    oldestDay: f.oldestDay,
    partial: p.from < f.oldestDay,
    columns,
    rows,
    total,
  };
}

// ---- the reports ----------------------------------------------------------------------------------

const keyedSort = <T extends Row>(rows: T[]): T[] => rows.sort((a, b) => String(a.period ?? '').localeCompare(String(b.period ?? '')) || String(a.key ?? '').localeCompare(String(b.key ?? '')));

function usageReport(deps: ReportDeps, q: Query, cost: CostOf): ReportReply {
  const p = parseParams(q, localDay(deps.now()));
  const f = loadFacts(deps, p.from, p.to, p.today, cost);
  const match = (r: UsageDay) => (p.person === null || r.owner === p.person) && (p.group === null || r.group === p.group) && (p.model === null || r.model === p.model);
  const filtered = p.person !== null || p.group !== null || p.model !== null;
  interface Acc { people: Set<string>; reporters: number; sessions: number; peak: number }
  const buckets = new Map<string, Acc>();
  const all: Acc = { people: new Set(), reporters: 0, sessions: 0, peak: 0 };
  const at = (day: string): Acc => {
    const k = bucketOf(day, p.by);
    let a = buckets.get(k);
    if (!a) buckets.set(k, (a = { people: new Set(), reporters: 0, sessions: 0, peak: 0 }));
    return a;
  };
  for (const r of f.usage.filter(match)) {
    for (const a of [at(r.day), all]) {
      if (r.owner) a.people.add(r.owner);
      if (filtered) a.sessions += r.sessions;
    }
  }
  for (const r of f.fleet) {
    for (const a of [at(r.day), all]) {
      a.reporters = Math.max(a.reporters, r.activeReporters);
      a.peak = Math.max(a.peak, r.peakLive);
      if (!filtered) a.sessions += r.sessionsStarted;
    }
  }
  const rows: Row[] = [...buckets].map(([period, a]) => ({ period, people: a.people.size, reporters: a.reporters, sessions: a.sessions, peakLive: a.peak }));
  keyedSort(rows);
  return envelope(p, 'usage', p.by, f, [col('period', 'Period', 'date'), col('people', 'People', 'count'), col('reporters', 'Reporters', 'count'), col('sessions', 'Sessions', 'count'), col('peakLive', 'Peak live', 'count')], rows, { people: all.people.size, reporters: all.reporters, sessions: all.sessions, peakLive: all.peak });
}

function spendKey(r: UsageDay, breakdown: string): string {
  switch (breakdown) {
    case 'person':
      return r.owner;
    case 'group':
      return r.group;
    case 'model':
      return r.model;
    default:
      return r.project;
  }
}

function spendReport(deps: ReportDeps, q: Query, cost: CostOf): ReportReply {
  const p = parseParams(q, localDay(deps.now()));
  const breakdown = pick(q, 'spend');
  const f = loadFacts(deps, p.from, p.to, p.today, cost);
  interface Acc { sessions: number; tokIn: number; tokOut: number; costUsd: number; unpriced: number }
  const add = (a: Acc, r: UsageDay) => {
    a.sessions += r.sessions;
    a.tokIn += r.tokIn;
    a.tokOut += r.tokOut;
    a.costUsd += r.costUsd;
    a.unpriced += r.unpricedSessions;
  };
  const row = (period: string | null, key: string | null, a: Acc): Row => {
    const out: Row = {};
    if (period !== null) out.period = period;
    if (key !== null) out.key = label(key);
    // A money field is null when no priced model was involved.
    return { ...out, sessions: a.sessions, tokIn: a.tokIn, tokOut: a.tokOut, costUsd: a.sessions > 0 && a.unpriced === a.sessions ? null : round(a.costUsd), unpricedSessions: a.unpriced };
  };
  const buckets = new Map<string, Acc & { period: string; key: string }>();
  const all: Acc = { sessions: 0, tokIn: 0, tokOut: 0, costUsd: 0, unpriced: 0 };
  for (const r of f.usage) {
    if ((p.person !== null && r.owner !== p.person) || (p.group !== null && r.group !== p.group) || (p.model !== null && r.model !== p.model)) continue;
    const period = bucketOf(r.day, p.by);
    const key = breakdown === 'none' ? '' : spendKey(r, breakdown);
    const k = `${period}\u0000${key}`;
    let a = buckets.get(k);
    if (!a) buckets.set(k, (a = { period, key, sessions: 0, tokIn: 0, tokOut: 0, costUsd: 0, unpriced: 0 }));
    add(a, r);
    add(all, r);
  }
  const rows = keyedSort([...buckets.values()].map((a) => row(a.period, breakdown === 'none' ? null : a.key, a)));
  const columns = [col('period', 'Period', 'date'), ...(breakdown === 'none' ? [] : [col('key', breakdown[0]!.toUpperCase() + breakdown.slice(1), 'text')]), col('sessions', 'Sessions', 'count'), col('tokIn', 'Tokens in', 'tokens'), col('tokOut', 'Tokens out', 'tokens'), col('costUsd', 'Cost (USD)', 'usd'), col('unpricedSessions', 'Sessions without a price', 'count')];
  return envelope(p, 'spend', p.by, f, columns, rows, row(null, null, all));
}

function peopleReport(deps: ReportDeps, q: Query, cost: CostOf): ReportReply {
  const p = parseParams(q, localDay(deps.now()));
  const f = loadFacts(deps, p.from, p.to, p.today, cost);
  const db = deps.db;
  const sessions = new Map<string, number>();
  const groupOf = new Map<string, string>();
  for (const r of f.usage) {
    if (!r.owner) continue;
    sessions.set(r.owner, (sessions.get(r.owner) ?? 0) + r.sessions);
    if (r.group) groupOf.set(r.owner, r.group);
  }
  const known = db.db.prepare('SELECT p.name AS name, g.name AS grp, p.last_report_at AS last FROM people p LEFT JOIN groups g ON g.id = p.group_id').all() as unknown as { name: string; grp: string | null; last: number | null }[];
  const rows: Row[] = known.map((k) => ({ person: k.name, group: k.grp, sessions: sessions.get(k.name) ?? 0, lastReportAt: k.last, state: sessions.has(k.name) ? 'active' : k.last === null ? 'never' : 'quiet' }));
  const names = new Set(known.map((k) => k.name));
  // Someone the rollups name who is no longer a person (the Admin, or a deleted account) is still a row.
  for (const [name, n] of sessions) if (!names.has(name)) rows.push({ person: name, group: groupOf.get(name) ?? null, sessions: n, lastReportAt: null, state: 'active' });
  const kept = rows.filter((r) => (p.person === null || r.person === p.person) && (p.group === null || (r.group ?? '') === p.group));
  kept.sort((a, b) => String(a.person).localeCompare(String(b.person)));
  const versions = (pick: (d: FleetDay) => Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const d of f.fleet) for (const [v, n] of Object.entries(pick(d))) out[v] = Math.max(out[v] ?? 0, n);
    return out;
  };
  const reporters = (db.db.prepare('SELECT COUNT(*) AS n FROM reporters').get() as { n: number }).n;
  const groups = (db.db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n;
  const out = envelope(p, 'people', null, f, [col('person', 'Person', 'text'), col('group', 'Group', 'text'), col('sessions', 'Sessions', 'count'), col('lastReportAt', 'Last report', 'time'), col('state', 'State', 'text')], kept, { people: kept.length, sessions: kept.reduce((n, r) => n + Number(r.sessions), 0) });
  out.summary = { people: known.length, groups, reporters, reporterVersions: versions((d) => d.reporterVersions), engineVersions: versions((d) => d.engineVersions) };
  return out;
}

function sessionsReport(deps: ReportDeps, q: Query, cost: CostOf): ReportReply {
  const p = parseParams(q, localDay(deps.now()));
  const breakdown = pick(q, 'sessions');
  const f = loadFacts(deps, p.from, p.to, p.today, cost);
  interface Acc { sessions: number; dur: number; max: number; agents: number; blow: number; ctx: number }
  const fresh = (): Acc => ({ sessions: 0, dur: 0, max: 0, agents: 0, blow: 0, ctx: 0 });
  const add = (a: Acc, r: SessionsDay) => {
    a.sessions += r.sessions;
    a.dur += r.durationS;
    a.max = Math.max(a.max, r.maxDurationS);
    a.agents += r.agents;
    a.blow += r.blowouts;
    a.ctx = Math.max(a.ctx, r.maxContextPct);
  };
  const row = (period: string | null, key: string | null, a: Acc): Row => ({
    ...(period === null ? {} : { period }),
    ...(key === null ? {} : { key: label(key) }),
    sessions: a.sessions,
    avgDurationS: a.sessions ? Math.round(a.dur / a.sessions) : null,
    maxDurationS: a.max,
    agentsPerSession: a.sessions ? round(a.agents / a.sessions, 2) : null,
    blowouts: a.blow,
    maxContextPct: round(a.ctx, 1),
  });
  const buckets = new Map<string, Acc & { period: string; key: string }>();
  const all = fresh();
  for (const r of f.sessions) {
    if (p.model !== null && r.model !== p.model) continue;
    const period = bucketOf(r.day, p.by);
    const key = breakdown === 'outcome' ? r.outcome : breakdown === 'model' ? r.model : breakdown === 'effort' ? r.effort : r.plan;
    const k = `${period}\u0000${key}`;
    let a = buckets.get(k);
    if (!a) buckets.set(k, (a = { ...fresh(), period, key }));
    add(a, r);
    add(all, r);
  }
  const rows = keyedSort([...buckets.values()].map((a) => row(a.period, a.key, a)));
  const columns = [col('period', 'Period', 'date'), col('key', breakdown[0]!.toUpperCase() + breakdown.slice(1), 'text'), col('sessions', 'Sessions', 'count'), col('avgDurationS', 'Average duration', 'seconds'), col('maxDurationS', 'Longest duration', 'seconds'), col('agentsPerSession', 'Agents per session', 'count'), col('blowouts', 'Context blowouts', 'count'), col('maxContextPct', 'Fullest context', 'percent')];
  return envelope(p, 'sessions', p.by, f, columns, rows, row(null, null, all));
}

const SESSION_IDS_MAX = 10;

function failuresReport(deps: ReportDeps, q: Query, cost: CostOf): ReportReply {
  const p = parseParams(q, localDay(deps.now()));
  const breakdown = pick(q, 'failures');
  const f = loadFacts(deps, p.from, p.to, p.today, cost, true);
  const groups = ownerGroups(deps.db);
  const match = (owner: string) => (p.person === null || owner === p.person) && (p.group === null || (groups.get(owner) ?? '') === p.group);
  const keyOf = (r: { owner: string; cls: string; tool: string }) => (breakdown === 'class' ? r.cls : breakdown === 'tool' ? r.tool : r.owner);
  const buckets = new Map<string, { period: string; key: string; count: number; people: Set<string>; ids: Set<string> }>();
  let total = 0;
  const everyone = new Set<string>();
  const at = (period: string, key: string) => {
    const k = `${period}\u0000${key}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { period, key, count: 0, people: new Set(), ids: new Set() }));
    return b;
  };
  for (const r of f.failures) {
    if (!match(r.owner)) continue;
    const b = at(bucketOf(r.day, p.by), keyOf(r));
    b.count += r.count;
    if (r.owner) {
      b.people.add(r.owner);
      everyone.add(r.owner);
    }
    total += r.count;
  }
  for (const s of f.live.failureSessions) {
    if (s.day < p.from || s.day > p.to || !match(s.owner)) continue;
    const b = buckets.get(`${bucketOf(s.day, p.by)}\u0000${keyOf(s)}`);
    if (b && b.ids.size < SESSION_IDS_MAX) b.ids.add(s.sessionId);
  }
  const rows: Row[] = keyedSort([...buckets.values()].map((b) => ({ period: b.period, key: label(b.key), count: b.count, people: b.people.size, ...(b.ids.size ? { sessionIds: [...b.ids] } : {}) })));
  const heading = breakdown === 'class' ? 'Failure class' : breakdown === 'tool' ? 'Tool' : 'Person';
  return envelope(p, 'failures', p.by, f, [col('period', 'Period', 'date'), col('key', heading, 'text'), col('count', 'Failures', 'count'), col('people', 'People', 'count'), col('sessionIds', 'Sessions', 'text')], rows, { count: total, people: everyone.size });
}

function activityReport(deps: ReportDeps, q: Query): ReportReply {
  const today = localDay(deps.now());
  const p = parseParams({ ...q, by: undefined }, today);
  const kind = one(q, 'kind');
  if (kind !== undefined && kind !== '' && !/^[A-Za-z0-9_.-]{1,64}$/.test(kind)) throw new ReportError('kind is not a kind of Admin log entry');
  const sql = `SELECT t, kind, detail, source FROM admin_log WHERE t >= ? AND t < ?${kind ? ' AND kind = ?' : ''} ORDER BY id DESC LIMIT 1000`;
  const args = [dayStart(p.from), dayStart(addDays(p.to, 1)), ...(kind ? [kind] : [])];
  const rows = deps.db.db.prepare(sql).all(...args) as unknown as Row[];
  const facts = { oldestDay: oldestRollupDay(deps.db, today) } as Facts;
  const out = envelope(p, 'activity', null, facts, [col('t', 'Time', 'time'), col('kind', 'Kind', 'text'), col('detail', 'Detail', 'text'), col('source', 'Source', 'text')], rows, { count: rows.length });
  out.partial = false;
  out.basedOn = 'admin log';
  return out;
}

/** Each rollup table with its rows and oldest day, and how long retention keeps the other tables (Data kept). */
export function retentionReport(deps: ReportDeps): Record<string, unknown> {
  const keepMs = deps.retention.rollupMs ?? ROLLUP_KEEP_MS;
  const days = (ms: number) => Math.round(ms / 86_400_000);
  const tables = ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily'].map((name) => {
    const r = deps.db.db.prepare(`SELECT COUNT(*) AS n, MIN(day) AS d FROM ${name}`).get() as { n: number; d: string | null };
    return { name, rows: r.n, oldestDay: r.d, keptDays: days(keepMs) };
  });
  const r = deps.retention;
  return { report: 'retention', tz: serverZone(), tables, detail: [{ name: 'samples', keptDays: round(r.samplesMs / 86_400_000, 2) }, { name: 'events', keptDays: days(r.eventsMs) }, { name: 'sessions', keptDays: days(r.sessionsMs) }, { name: 'admin_log', keptDays: days(r.adminLogMs) }] };
}

export function runReport(deps: ReportDeps, name: ReportName, q: Query): ReportReply {
  const cost = costFn(deps.pricing());
  switch (name) {
    case 'usage':
      return usageReport(deps, q, cost);
    case 'spend':
      return spendReport(deps, q, cost);
    case 'people':
      return peopleReport(deps, q, cost);
    case 'sessions':
      return sessionsReport(deps, q, cost);
    case 'failures':
      return failuresReport(deps, q, cost);
    default:
      return activityReport(deps, q);
  }
}

// ---- projection (#483) -----------------------------------------------------------------------------

export const PROJECTION_MIN_DAYS = 7;
export const PROJECTION_MIN_ACTIVE_DAYS = 3;
const HORIZONS = ['month', '30d'] as const;
const WINDOWS = [7, 14, 30] as const;

export function projectionReport(deps: ReportDeps, q: Query): ReportReply {
  const now = deps.now();
  const today = localDay(now);
  const horizon = one(q, 'horizon') ?? 'month';
  if (!(HORIZONS as readonly string[]).includes(horizon)) throw new ReportError('horizon must be month or 30d');
  const windowRaw = one(q, 'window') ?? '14';
  const windowDays = Number(windowRaw);
  if (!(WINDOWS as readonly number[]).includes(windowDays)) throw new ReportError('window must be 7, 14 or 30');
  const by = one(q, 'by') ?? 'person';
  if (by !== 'person' && by !== 'group') throw new ReportError('by must be person or group');

  const winTo = addDays(today, -1);
  const winFrom = addDays(winTo, -(windowDays - 1));
  const monthFrom = `${today.slice(0, 8)}01`;
  const oldest = oldestRollupDay(deps.db, today);
  const historyDays = Math.max(0, Math.min(windowDays, daysBetween(oldest, winTo) + 1));
  const cost = costFn(deps.pricing());
  const keyOf = (r: UsageDay) => label(by === 'person' ? r.owner : r.group);

  interface Acc { window: number; month: number; days: Set<string> }
  const keys = new Map<string, Acc>();
  const acc = (k: string): Acc => {
    let a = keys.get(k);
    if (!a) keys.set(k, (a = { window: 0, month: 0, days: new Set() }));
    return a;
  };
  const sum: Acc = { window: 0, month: 0, days: new Set() };
  let unpriced = 0;
  const rows = [
    ...select(deps.db, 'usage_daily', winFrom < monthFrom ? winFrom : monthFrom, winTo).map(usageOf),
    ...buildRollups(deps.db, cost, dayStart(today)).usage.filter((r) => r.day === today),
  ];
  for (const r of rows) {
    const a = acc(keyOf(r));
    for (const x of [a, sum]) {
      if (r.day >= monthFrom) x.month += r.costUsd;
      if (r.day >= winFrom && r.day <= winTo) {
        x.window += r.costUsd;
        if (r.sessions > 0) x.days.add(r.day);
      }
    }
    if (r.day >= winFrom && r.day <= winTo) unpriced += r.unpricedSessions;
  }
  const dim = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  const daysLeft = dim - Number(today.slice(8, 10));
  const make = (key: string, a: Acc, needActive: boolean): Row => {
    const enough = historyDays >= PROJECTION_MIN_DAYS && (!needActive || a.days.size >= PROJECTION_MIN_ACTIVE_DAYS);
    const run = enough ? a.window / historyDays : null;
    const projected = run === null ? null : horizon === 'month' ? a.month + run * daysLeft : 30 * run;
    return { key, runRatePerDay: run === null ? null : round(run), spentThisMonth: round(a.month), projected: projected === null ? null : round(projected), ...(run === null ? { reason: 'history' } : {}) };
  };
  const out: Row[] = [...keys].map(([k, a]) => make(k, a, true));
  out.sort((a, b) => Number(b.projected ?? -1) - Number(a.projected ?? -1) || String(a.key).localeCompare(String(b.key)));
  const reply: ReportReply = {
    report: 'spend/projection',
    from: winFrom,
    to: winTo,
    by,
    tz: serverZone(),
    basedOn: 'rollups and live',
    oldestDay: oldest,
    partial: false,
    columns: [col('key', by === 'person' ? 'Person' : 'Group', 'text'), col('runRatePerDay', 'Run rate per day', 'usd'), col('spentThisMonth', 'Spent this month', 'usd'), col('projected', 'Projected', 'usd')],
    rows: out,
    total: make('Total', sum, false),
  };
  reply.horizon = horizon;
  reply.window = { from: winFrom, to: winTo, days: windowDays };
  reply.unpricedSessions = unpriced;
  reply.historyDays = historyDays;
  return reply;
}

// ---- the Spend breakdown (#482) ---------------------------------------------------------------------

export interface SpendTodayReply {
  owner: string;
  total: number;
  bySession: { id: string; name: string; model: string | null; costUsd: number; share: number }[];
  byModel: { model: string; costUsd: number | null; share: number | null }[];
  bySource: { orchestrator: number; agents: number };
  unpriced: number;
  byPerson?: { owner: string; costUsd: number; share: number }[];
}

/**
 * One person's (or group's) spend since local midnight, cut by session, by model and by orchestrator against agents. It
 * reads the same per-session figure `kpis.costTodayByOwner` adds up, in the same order, so every cut adds up to the table's row.
 */
export function spendToday(deps: ReportDeps, owner: string, isGroup: boolean): SpendTodayReply {
  const since = startOfDay(deps.now());
  const pricing = deps.pricing();
  const cost = costFn(pricing);
  const want = unlabel(owner);
  const mine = deps.db.sessionSpendSince(since, cost).filter((r) => {
    const name = isGroup ? r.grp : r.owner;
    return want === '' ? name === null : name === want;
  });
  const total = mine.reduce((n, r) => n + r.usd, 0);
  const share = (n: number) => (total > 0 ? n / total : 0);
  const spent = mine.filter((r) => r.priced && r.usd > 0);
  const unpriced = mine.filter((r) => !r.priced && deps.db.getSession(r.id)!.last_seen_at >= since).length;

  const bySession = spent.map((r) => ({ id: r.id, name: r.name, model: r.model, costUsd: r.usd, share: share(r.usd) })).sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name));

  const models = new Map<string, number | null>();
  let agents = 0;
  for (const r of spent) {
    const usage = r.usageJson ? safeUsage(r.usageJson) : [];
    const weights = new Map<string, number>();
    const dash: string[] = [];
    for (const u of usage) {
      const w = pricing?.costOf([u]);
      if (w === null || w === undefined) {
        if (w === null) dash.push(u.model);
        continue;
      }
      weights.set(u.model, (weights.get(u.model) ?? 0) + w);
    }
    const weighed = [...weights.values()].reduce((n, w) => n + w, 0);
    if (weighed > 0) for (const [m, w] of weights) models.set(m, (models.get(m) ?? 0) + (r.usd * w) / weighed);
    else models.set(r.model ?? '-', (models.get(r.model ?? '-') ?? 0) + r.usd);
    for (const m of dash) if (!models.has(m)) models.set(m, null);
    const row = deps.db.getSession(r.id)!;
    const whole = cost(row) ?? 0;
    agents += whole > 0 ? r.usd * Math.min(1, deps.db.agentCostOf(r.id, cost) / whole) : 0;
  }
  const byModel = [...models].map(([model, usd]) => ({ model, costUsd: usd, share: usd === null ? null : share(usd) })).sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.model.localeCompare(b.model));

  const reply: SpendTodayReply = { owner: label(want), total, bySession, byModel, bySource: { orchestrator: Math.max(0, total - agents), agents }, unpriced };
  if (isGroup) {
    const people = new Map<string, number>();
    for (const r of mine) people.set(r.owner ?? '', (people.get(r.owner ?? '') ?? 0) + r.usd);
    reply.byPerson = [...people].map(([o, usd]) => ({ owner: label(o), costUsd: usd, share: share(usd) })).sort((a, b) => b.costUsd - a.costUsd || a.owner.localeCompare(b.owner));
  }
  return reply;
}

function safeUsage(text: string): ModelUsage[] {
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? (v as ModelUsage[]) : [];
  } catch {
    return [];
  }
}

// ---- CSV --------------------------------------------------------------------------------------------

/** One cell as RFC 4180 text; a cell that starts like a formula gets a `'` in front so a spreadsheet will not run it. */
export function csvCell(v: string | number | null | string[] | undefined): string {
  if (v === null || v === undefined) return '';
  let s = Array.isArray(v) ? v.join(' ') : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** The report's `columns` as a header row and its `rows` under them, CRLF-separated. */
export function toCsv(columns: Column[], rows: Row[]): string {
  const lines = [columns.map((c) => csvCell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c.key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
