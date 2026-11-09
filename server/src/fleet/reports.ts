// The reports behind Admin > Reporting (#484), the Spend breakdown (#482) and the Spend projection (#483), SPEC 7.1 "Reports".
// Pure over the database: today is read live with the rollup builder, every earlier day from the rollup tables.
import { startOfDay } from './derive.js';
import { ROLLUP_KEEP_MS, type CostOf, type RetentionPolicy } from '../storage/rows.js';
import type { FleetStore } from '../storage/types.js';
import type { RollupRaw, RollupTable } from '../storage/reportQueries.js';
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
  type HarnessVersionDay,
  type SessionsDay,
  type ToolDay,
  type ToolSessionDay,
  type ToolStatDay,
  type UsageDay,
} from './rollups.js';
import { bucketMs } from './protocol.js';

export interface ReportDeps {
  db: FleetStore;
  /** Runs `fn` in one storage transaction, so a report reads the rollups, the live build and the sessions as of one moment. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  now: () => number;
  pricing: () => Pricing | undefined;
  retention: RetentionPolicy;
  /**
   * Whether the viewer may open a stored session in History (#721). A failure row links only to the sessions the viewer may open, and shows its count
   * without a link when it may open none. Absent means the viewer may open every session, as the Admin may.
   */
  mayOpenSession?: (sessionId: string) => boolean;
}

/** A report was asked for something it cannot give: the route answers 400 with the message. */
export class ReportError extends Error {}

export type ReportName = 'usage' | 'spend' | 'people' | 'sessions' | 'failures' | 'tools' | 'activity';
const ROLLUP_TABLES: readonly RollupTable[] = ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily', 'tools_daily', 'tool_sessions_daily', 'harness_versions_daily', 'tool_stats_daily'];

export const REPORT_NAMES: readonly ReportName[] = ['usage', 'spend', 'people', 'sessions', 'failures', 'tools', 'activity'];

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
export const BREAKDOWNS: Record<'spend' | 'sessions' | 'failures' | 'tools', readonly string[]> = {
  spend: ['none', 'person', 'group', 'model', 'project'],
  sessions: ['outcome', 'model', 'effort', 'plan'],
  failures: ['class', 'tool', 'person'],
  tools: ['tool', 'session', 'version', 'failures', 'prompts', 'duration'],
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

function pick(q: Query, name: 'spend' | 'sessions' | 'failures' | 'tools'): string {
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
  tools: ToolDay[];
  toolSessions: ToolSessionDay[];
  harnessVersions: HarnessVersionDay[];
  toolStats: ToolStatDay[];
  oldestDay: string;
  live: DayRollups;
}

type Raw = RollupRaw;

const usageOf = (r: Raw): UsageDay => ({ day: String(r.day), owner: String(r.owner), group: String(r.group_name), model: String(r.model), project: String(r.project), sessions: Number(r.sessions), agents: Number(r.agents), costUsd: Number(r.cost_usd), unpricedSessions: Number(r.unpriced_sessions), tokIn: Number(r.tok_in), tokOut: Number(r.tok_out), tokCr: Number(r.tok_cr), tokCw: Number(r.tok_cw) });
const sessionsOf = (r: Raw): SessionsDay => ({ day: String(r.day), outcome: String(r.outcome), model: String(r.model), effort: String(r.effort), plan: String(r.plan), sessions: Number(r.sessions), durationS: Number(r.duration_s), maxDurationS: Number(r.max_duration_s), agents: Number(r.agents), blowouts: Number(r.blowouts), maxContextPct: Number(r.max_context_pct) });
const failureOf = (r: Raw): FailureDay => ({ day: String(r.day), owner: String(r.owner), cls: String(r.class), tool: String(r.tool), count: Number(r.count) });
const fleetOf = (r: Raw): FleetDay => ({ day: String(r.day), activePeople: Number(r.active_people), activeReporters: Number(r.active_reporters), sessionsStarted: Number(r.sessions_started), peakLive: Number(r.peak_live_sessions), reporterVersions: JSON.parse(String(r.reporter_versions_json)) as Record<string, number>, engineVersions: JSON.parse(String(r.engine_versions_json)) as Record<string, number> });

const toolOf = (r: Raw): ToolDay => ({ day: String(r.day), harness: String(r.harness), tool: String(r.tool), calls: Number(r.calls) });
const toolSessionOf = (r: Raw): ToolSessionDay => ({ day: String(r.day), harness: String(r.harness), bucket: Number(r.bucket), sessions: Number(r.sessions) });
const toolStatOf = (r: Raw): ToolStatDay => ({ day: String(r.day), harness: String(r.harness), tool: String(r.tool), failed: Number(r.failed), asked: Number(r.asked), allowed: Number(r.allowed), denied: Number(r.denied), podium: Number(r.podium), timesJson: String(r.times_json) });
const harnessVersionOf = (r: Raw): HarnessVersionDay => ({ day: String(r.day), harness: String(r.harness), version: String(r.version), reporters: Number(r.reporters) });

const select = (db: FleetStore, table: RollupTable, from: string, to: string): Promise<RollupRaw[]> => db.rollupRows(table, from, to);

/** The first day the rollups hold, or today when they hold none yet (today is always read live). */
export async function oldestRollupDay(db: FleetStore, today: string): Promise<string> {
  let oldest = today;
  for (const t of ROLLUP_TABLES) {
    const d = await db.rollupOldestDay(t);
    if (d !== null && d < oldest) oldest = d;
  }
  return oldest;
}

async function loadFacts(deps: ReportDeps, from: string, to: string, today: string, cost: CostOf, withSessions = false, withTools = false): Promise<Facts> {
  const { db } = deps;
  const stored = to < today ? to : addDays(today, -1);
  const f: Facts = { usage: [], sessions: [], failures: [], fleet: [], tools: [], toolSessions: [], harnessVersions: [], toolStats: [], oldestDay: await oldestRollupDay(db, today), live: { usage: [], sessions: [], failures: [], fleet: [], tools: [], toolSessions: [], harnessVersions: [], toolStats: [], failureSessions: [] } };
  if (from <= stored) {
    f.usage = (await select(db, 'usage_daily', from, stored)).map(usageOf);
    f.sessions = (await select(db, 'sessions_daily', from, stored)).map(sessionsOf);
    f.failures = (await select(db, 'failures_daily', from, stored)).map(failureOf);
    f.fleet = (await select(db, 'fleet_daily', from, stored)).map(fleetOf);
    if (withTools) {
      f.tools = (await select(db, 'tools_daily', from, stored)).map(toolOf);
      f.toolSessions = (await select(db, 'tool_sessions_daily', from, stored)).map(toolSessionOf);
      f.harnessVersions = (await select(db, 'harness_versions_daily', from, stored)).map(harnessVersionOf);
      f.toolStats = (await select(db, 'tool_stats_daily', from, stored)).map(toolStatOf);
    }
  }
  // Failures keep which sessions had them only while the sessions are stored, so the History link reads those live.
  const floor = addDays(today, -31);
  // A period that ends before today needs nothing live unless the History links want the stored sessions.
  if (to === today || withSessions) f.live = await buildRollups(db, cost, dayStart(withSessions ? (from > floor ? from : floor) : today));
  if (to === today) {
    const peaks = await peakLiveByDay(db);
    const keep = (d: string) => d === today;
    f.usage.push(...f.live.usage.filter((r) => keep(r.day)));
    f.sessions.push(...f.live.sessions.filter((r) => keep(r.day)));
    f.failures.push(...f.live.failures.filter((r) => keep(r.day)));
    if (withTools) {
      f.tools.push(...f.live.tools.filter((r) => keep(r.day)));
      f.toolSessions.push(...f.live.toolSessions.filter((r) => keep(r.day)));
      f.harnessVersions.push(...f.live.harnessVersions.filter((r) => keep(r.day)));
      f.toolStats.push(...f.live.toolStats.filter((r) => keep(r.day)));
    }
    const storedPeak = (await db.storedPeak(today)) ?? 0;
    const liveFleet = f.live.fleet.find((r) => keep(r.day));
    if (liveFleet) f.fleet.push({ ...liveFleet, peakLive: Math.max(storedPeak, peaks.get(today) ?? 0) });
    else if (storedPeak || peaks.get(today)) f.fleet.push({ day: today, activePeople: 0, activeReporters: 0, sessionsStarted: 0, peakLive: Math.max(storedPeak, peaks.get(today) ?? 0), reporterVersions: {}, engineVersions: {} });
  }
  return f;
}

const ownerGroups = async (db: FleetStore): Promise<Map<string, string>> => new Map((await db.ownerGroupNames()).map((r) => [r.n, r.g]));

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

async function usageReport(deps: ReportDeps, q: Query, cost: CostOf): Promise<ReportReply> {
  const p = parseParams(q, localDay(deps.now()));
  const f = await loadFacts(deps, p.from, p.to, p.today, cost);
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

async function spendReport(deps: ReportDeps, q: Query, cost: CostOf): Promise<ReportReply> {
  const p = parseParams(q, localDay(deps.now()));
  const breakdown = pick(q, 'spend');
  const f = await loadFacts(deps, p.from, p.to, p.today, cost);
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

async function peopleReport(deps: ReportDeps, q: Query, cost: CostOf): Promise<ReportReply> {
  const p = parseParams(q, localDay(deps.now()));
  const f = await loadFacts(deps, p.from, p.to, p.today, cost);
  const db = deps.db;
  const sessions = new Map<string, number>();
  const groupOf = new Map<string, string>();
  for (const r of f.usage) {
    if (!r.owner) continue;
    sessions.set(r.owner, (sessions.get(r.owner) ?? 0) + r.sessions);
    if (r.group) groupOf.set(r.owner, r.group);
  }
  const known = await db.knownPeople();
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
  const reporters = await db.countReporters();
  const groups = await db.countGroups();
  const out = envelope(p, 'people', null, f, [col('person', 'Person', 'text'), col('group', 'Group', 'text'), col('sessions', 'Sessions', 'count'), col('lastReportAt', 'Last report', 'time'), col('state', 'State', 'text')], kept, { people: kept.length, sessions: kept.reduce((n, r) => n + Number(r.sessions), 0) });
  out.summary = { people: known.length, groups, reporters, reporterVersions: versions((d) => d.reporterVersions), engineVersions: versions((d) => d.engineVersions) };
  return out;
}

async function sessionsReport(deps: ReportDeps, q: Query, cost: CostOf): Promise<ReportReply> {
  const p = parseParams(q, localDay(deps.now()));
  const breakdown = pick(q, 'sessions');
  const f = await loadFacts(deps, p.from, p.to, p.today, cost);
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

async function failuresReport(deps: ReportDeps, q: Query, cost: CostOf): Promise<ReportReply> {
  const p = parseParams(q, localDay(deps.now()));
  const breakdown = pick(q, 'failures');
  const f = await loadFacts(deps, p.from, p.to, p.today, cost, true);
  const groups = await ownerGroups(deps.db);
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

// ---- tools (#720) -----------------------------------------------------------------------------------

const HARNESS_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;

function harnessFilter(q: Query): string | null {
  const v = one(q, 'harness');
  if (v === undefined || v === '') return null;
  if (!HARNESS_ID.test(v)) throw new ReportError('harness must be the id of a harness, such as claude-code or opencode');
  return v;
}

/** An MCP tool is `mcp__<server>__<tool>`; every other name has no server. */
export function mcpSplit(name: string): { server: string; tool: string } {
  if (!name.startsWith('mcp__')) return { server: '', tool: name };
  const end = name.indexOf('__', 5);
  return end > 5 && end + 2 < name.length ? { server: name.slice(5, end), tool: name.slice(end + 2) } : { server: '', tool: name };
}

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Dotted parts compared one by one: numbers as numbers (2.1.10 is after 2.1.9), anything else as text, a missing part as 0. */
function compareParts(pa: string[], pb: string[]): number {
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    const c = nx !== null && ny !== null ? nx - ny : byCode(x, y);
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
}

/** `a` against `b` as versions: 2.1.10 is after 2.1.9, and a release is after its own pre-release (2.1.0 after 2.1.0-beta). Build metadata after `+` is ignored. */
export function compareVersions(a: string, b: string): number {
  const [coreA = '', preA] = a.split('+')[0]!.split(/-(.*)/s);
  const [coreB = '', preB] = b.split('+')[0]!.split(/-(.*)/s);
  const core = compareParts(coreA.split('.'), coreB.split('.'));
  if (core !== 0) return core;
  if (preA === undefined && preB === undefined) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return compareParts(preA.split('.'), preB.split('.'));
}

/** The calls-per-session class that holds the `share` of sessions, counting from the smallest (the nearest rank). */
function nearestRank(sizes: Map<number, number>, share: number): number {
  let total = 0;
  for (const n of sizes.values()) total += n;
  if (total === 0) return 0;
  const need = Math.ceil(total * share);
  let seen = 0;
  for (const bucket of [...sizes.keys()].sort((a, b) => a - b)) {
    seen += sizes.get(bucket)!;
    if (seen >= need) return bucket;
  }
  return 0;
}

const addSizes = (into: Map<number, number>, bucket: number, sessions: number): void => void into.set(bucket, (into.get(bucket) ?? 0) + sessions);

/** The oldest day the tool counts cover, or today when none exist yet: they started later than the other rollups, and a gap is never drawn as zeros. */
async function oldestToolDay(db: FleetStore, today: string): Promise<string> {
  let oldest = today;
  for (const t of ['tools_daily', 'tool_sessions_daily', 'harness_versions_daily', 'tool_stats_daily'] as const) {
    const d = await db.rollupOldestDay(t);
    if (d !== null && d < oldest) oldest = d;
  }
  return oldest;
}

/** One row per period, harness and tool, with the calls beside what a breakdown adds up. */
interface ToolKey {
  period: string;
  harness: string;
  server: string;
  tool: string;
  name: string;
}
const toolKeyOf = (period: string, harness: string, name: string): ToolKey => ({ period, harness, name, ...mcpSplit(name) });
const toolRowOrder = (a: ToolKey, b: ToolKey): number => byCode(a.period, b.period) || byCode(a.harness, b.harness) || byCode(a.server, b.server) || byCode(a.tool, b.tool);

/** The share of `whole` that `part` is, in percent to one decimal place; 0 when there is no whole. */
const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/** The failure rate (#721) and the permission prompts (#721) of each tool: both are counts beside the tool's calls. */
function toolOutcomesReport(deps: ReportDeps, p: Params, f: Facts, breakdown: 'failures' | 'prompts', extra: Record<string, unknown>, keep: (h: string) => boolean): ReportReply {
  interface Acc extends ToolKey {
    calls: number;
    failed: number;
    asked: number;
    allowed: number;
    denied: number;
    podium: number;
    ids: Set<string>;
    stored: Set<string>;
  }
  const acc = new Map<string, Acc>();
  const at = (period: string, h: string, name: string): Acc => {
    const k = `${period}\u0000${h}\u0000${name}`;
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { ...toolKeyOf(period, h, name), calls: 0, failed: 0, asked: 0, allowed: 0, denied: 0, podium: 0, ids: new Set(), stored: new Set() }));
    return a;
  };
  for (const r of f.tools) if (keep(r.harness)) at(bucketOf(r.day, p.by), r.harness, r.tool).calls += r.calls;
  for (const r of f.toolStats) {
    if (!keep(r.harness)) continue;
    const a = at(bucketOf(r.day, p.by), r.harness, r.tool);
    a.failed += r.failed;
    a.asked += r.asked;
    a.allowed += r.allowed;
    a.denied += r.denied;
    a.podium += r.podium;
  }
  if (breakdown === 'failures') {
    // The sessions that recorded a failure in a tool and are still stored: the row links to those the viewer may open, and counts them either way.
    for (const s of f.live.failureSessions) {
      if (s.day < p.from || s.day > p.to || !keep(s.harness) || s.tool === '') continue;
      const a = acc.get(`${bucketOf(s.day, p.by)}\u0000${s.harness}\u0000${s.tool}`);
      if (!a) continue;
      a.stored.add(s.sessionId);
      if (a.ids.size < SESSION_IDS_MAX && (deps.mayOpenSession?.(s.sessionId) ?? true)) a.ids.add(s.sessionId);
    }
  }
  const noAnswer = (a: { asked: number; allowed: number; denied: number }): number => Math.max(0, a.asked - a.allowed - a.denied);
  const all = [...acc.values()].sort(toolRowOrder);
  let calls = 0;
  for (const a of all) calls += a.calls;
  if (breakdown === 'failures') {
    const rows: Row[] = all.map((a) => ({ period: a.period, harness: a.harness, server: a.server, tool: a.tool, calls: a.calls, failed: a.failed, rate: pct(a.failed, a.calls), stored: a.stored.size, ...(a.ids.size ? { sessionIds: [...a.ids] } : {}) }));
    const failed = all.reduce((n, a) => n + a.failed, 0);
    const cols = [col('period', 'Period', 'date'), col('harness', 'Harness', 'text'), col('server', 'MCP server', 'text'), col('tool', 'Tool', 'text'), col('calls', 'Calls', 'count'), col('failed', 'Failures', 'count'), col('rate', 'Failure rate', 'percent'), col('stored', 'Sessions in History', 'count'), col('sessionIds', 'Sessions', 'text')];
    return { ...envelope(p, 'tools', p.by, f, cols, rows, { calls, failed }), ...extra };
  }
  const asking = all.filter((a) => a.asked > 0 || a.allowed > 0 || a.denied > 0);
  const rows: Row[] = asking.map((a) => ({ period: a.period, harness: a.harness, server: a.server, tool: a.tool, calls: a.calls, asked: a.asked, allowed: a.allowed, denied: a.denied, noAnswer: noAnswer(a), podium: a.podium }));
  const sum = (k: 'asked' | 'allowed' | 'denied' | 'podium'): number => asking.reduce((n, a) => n + a[k], 0);
  const total = { calls, asked: sum('asked'), allowed: sum('allowed'), denied: sum('denied'), noAnswer: asking.reduce((n, a) => n + noAnswer(a), 0), podium: sum('podium') };
  const cols = [col('period', 'Period', 'date'), col('harness', 'Harness', 'text'), col('server', 'MCP server', 'text'), col('tool', 'Tool', 'text'), col('calls', 'Calls', 'count'), col('asked', 'Asked', 'count'), col('allowed', 'Allowed', 'count'), col('denied', 'Denied', 'count'), col('noAnswer', 'No answer', 'count'), col('podium', 'Answered in Podium', 'count')];
  return { ...envelope(p, 'tools', p.by, f, cols, rows, total), ...extra };
}

/** The call lengths (#721) as a median and a 95th percentile per tool, read from buckets, so they are within 10% of the real length. */
function toolDurationReport(p: Params, f: Facts, extra: Record<string, unknown>, keep: (h: string) => boolean): ReportReply {
  const parse = (json: string): Map<number, number> => {
    const out = new Map<number, number>();
    let o: unknown = null;
    try {
      o = JSON.parse(json);
    } catch {
      return out;
    }
    if (o && typeof o === 'object') for (const [b, n] of Object.entries(o)) if (Number.isInteger(Number(b)) && typeof n === 'number' && n > 0) out.set(Number(b), n);
    return out;
  };
  const add = (into: Map<number, number>, from: Map<number, number>): void => void from.forEach((n, b) => into.set(b, (into.get(b) ?? 0) + n));
  const size = (m: Map<number, number>): number => [...m.values()].reduce((n, v) => n + v, 0);
  const lengths = (m: Map<number, number>): { timed: number; p50Ms: number; p95Ms: number } => ({ timed: size(m), p50Ms: bucketMs(nearestRank(m, 0.5)), p95Ms: bucketMs(nearestRank(m, 0.95)) });
  const per = new Map<string, ToolKey & { m: Map<number, number> }>();
  const byTool = new Map<string, { server: string; tool: string; m: Map<number, number> }>();
  const whole = new Map<number, number>();
  const timedBy = new Set<string>();
  for (const r of f.toolStats) {
    if (!keep(r.harness)) continue;
    const m = parse(r.timesJson);
    if (m.size === 0) continue;
    timedBy.add(r.harness);
    const key = toolKeyOf(bucketOf(r.day, p.by), r.harness, r.tool);
    const k = `${key.period}\u0000${key.harness}\u0000${r.tool}`;
    const a = per.get(k) ?? { ...key, m: new Map<number, number>() };
    add(a.m, m);
    per.set(k, a);
    const t = byTool.get(r.tool) ?? { server: key.server, tool: key.tool, m: new Map<number, number>() };
    add(t.m, m);
    byTool.set(r.tool, t);
    add(whole, m);
  }
  const rows: Row[] = [...per.values()].sort(toolRowOrder).map((a) => ({ period: a.period, harness: a.harness, server: a.server, tool: a.tool, ...lengths(a.m) }));
  // An MCP server has a row of its own, read from every call of its tools: a percentile of the server is not a figure of its tools.
  const servers = new Map<string, Map<number, number>>();
  for (const t of byTool.values()) if (t.server !== '') add(servers.get(t.server) ?? servers.set(t.server, new Map()).get(t.server)!, t.m);
  const slowest = [...[...byTool.values()].map((t) => ({ server: t.server, tool: t.tool, m: t.m })), ...[...servers].map(([server, m]) => ({ server, tool: '', m }))]
    .map((t) => ({ server: t.server, tool: t.tool, ...lengths(t.m) })).sort((a, b) => b.p95Ms - a.p95Ms || b.timed - a.timed || byCode(a.server, b.server) || byCode(a.tool, b.tool));
  const cols = [col('period', 'Period', 'date'), col('harness', 'Harness', 'text'), col('server', 'MCP server', 'text'), col('tool', 'Tool', 'text'), col('timed', 'Calls timed', 'count'), col('p50Ms', 'Median (ms)', 'count'), col('p95Ms', '95th percentile (ms)', 'count')];
  return { ...envelope(p, 'tools', p.by, f, cols, rows, whole.size ? lengths(whole) : { timed: 0, p50Ms: 0, p95Ms: 0 }), ...extra, byTool: slowest, timedHarnesses: [...timedBy].sort(byCode) };
}

async function toolsReport(deps: ReportDeps, q: Query, cost: CostOf): Promise<ReportReply> {
  const p = parseParams(q, localDay(deps.now()));
  // The tool counts are kept per harness and day, not per person, so a person, group or model filter cannot be honored and is not ignored quietly.
  if (p.person !== null || p.group !== null || p.model !== null) throw new ReportError('the tools report cannot be filtered by person, group or model');
  const breakdown = pick(q, 'tools');
  const harness = harnessFilter(q);
  const f = await loadFacts(deps, p.from, p.to, p.today, cost, breakdown === 'failures', true);
  f.oldestDay = await oldestToolDay(deps.db, p.today);
  const harnesses = [...new Set([...f.tools.map((r) => r.harness), ...f.toolSessions.map((r) => r.harness), ...f.harnessVersions.map((r) => r.harness), ...f.toolStats.map((r) => r.harness)])].sort(byCode);
  const keep = (h: string): boolean => harness === null || h === harness;
  const extra = { harnesses };

  if (breakdown === 'session') {
    const sizes = new Map<string, { period: string; harness: string; sizes: Map<number, number>; sessions: number }>();
    const whole = new Map<number, number>();
    const perHarness = new Map<string, Map<number, number>>();
    let sessions = 0;
    for (const r of f.toolSessions) {
      if (!keep(r.harness)) continue;
      const period = bucketOf(r.day, p.by);
      const k = `${period}\u0000${r.harness}`;
      let b = sizes.get(k);
      if (!b) sizes.set(k, (b = { period, harness: r.harness, sizes: new Map(), sessions: 0 }));
      addSizes(b.sizes, r.bucket, r.sessions);
      b.sessions += r.sessions;
      addSizes(whole, r.bucket, r.sessions);
      const h = perHarness.get(r.harness) ?? new Map<number, number>();
      addSizes(h, r.bucket, r.sessions);
      perHarness.set(r.harness, h);
      sessions += r.sessions;
    }
    const count = (m: Map<number, number>): number => [...m.values()].reduce((n, v) => n + v, 0);
    const rows: Row[] = [...sizes.values()]
      .sort((a, b) => byCode(a.period, b.period) || byCode(a.harness, b.harness))
      .map((b) => ({ period: b.period, harness: b.harness, sessions: b.sessions, median: nearestRank(b.sizes, 0.5), p90: nearestRank(b.sizes, 0.9) }));
    const byHarness: Row[] = [...perHarness].sort(([a], [b]) => byCode(a, b)).map(([h, m]) => ({ harness: h, sessions: count(m), median: nearestRank(m, 0.5), p90: nearestRank(m, 0.9) }));
    const cols = [col('period', 'Period', 'date'), col('harness', 'Harness', 'text'), col('sessions', 'Sessions', 'count'), col('median', 'Median calls', 'count'), col('p90', '90th percentile calls', 'count')];
    return { ...envelope(p, 'tools', p.by, f, cols, rows, { sessions, median: nearestRank(whole, 0.5), p90: nearestRank(whole, 0.9) }), ...extra, byHarness };
  }

  if (breakdown === 'version') {
    const seen = new Map<string, { period: string; harness: string; version: string; reporters: number }>();
    for (const r of f.harnessVersions) {
      if (!keep(r.harness)) continue;
      const period = bucketOf(r.day, p.by);
      const k = `${period}\u0000${r.harness}\u0000${r.version}`;
      const b = seen.get(k) ?? { period, harness: r.harness, version: r.version, reporters: 0 };
      // the most reporters on one day: a reporter seen on two days of a period is still one
      b.reporters = Math.max(b.reporters, r.reporters);
      seen.set(k, b);
    }
    const newestOf = new Map<string, string>();
    for (const b of seen.values()) {
      const have = newestOf.get(b.harness);
      if (have === undefined || compareVersions(b.version, have) > 0) newestOf.set(b.harness, b.version);
    }
    const ordered = [...seen.values()].sort((a, b) => byCode(a.period, b.period) || byCode(a.harness, b.harness) || compareVersions(a.version, b.version) || byCode(a.version, b.version));
    const rows: Row[] = ordered.map((b) => ({ period: b.period, harness: b.harness, version: b.version, reporters: b.reporters, newest: b.version === newestOf.get(b.harness) ? 'Newest seen' : 'Older' }));
    // how many reporters of each harness run an older version than its newest, in the last period that harness reported in
    const behind: Row[] = [...newestOf].sort(([a], [b]) => byCode(a, b)).map(([h, newest]) => {
      const mine = ordered.filter((b) => b.harness === h);
      const last = mine[mine.length - 1]!.period;
      const inLast = mine.filter((b) => b.period === last);
      return { harness: h, newest, behind: inLast.filter((b) => b.version !== newest).reduce((n, b) => n + b.reporters, 0), reporters: inLast.reduce((n, b) => n + b.reporters, 0) };
    });
    const cols = [col('period', 'Period', 'date'), col('harness', 'Harness', 'text'), col('version', 'Version', 'text'), col('reporters', 'Reporters', 'count'), col('newest', 'Newest', 'text')];
    return { ...envelope(p, 'tools', p.by, f, cols, rows, {}), ...extra, behind };
  }

  if (breakdown === 'failures' || breakdown === 'prompts') return toolOutcomesReport(deps, p, f, breakdown, extra, keep);
  if (breakdown === 'duration') return toolDurationReport(p, f, extra, keep);

  const calls = new Map<string, { period: string; harness: string; server: string; tool: string; calls: number }>();
  let total = 0;
  for (const r of f.tools) {
    if (!keep(r.harness)) continue;
    const period = bucketOf(r.day, p.by);
    const { server, tool } = mcpSplit(r.tool);
    const k = `${period}\u0000${r.harness}\u0000${server}\u0000${tool}`;
    const b = calls.get(k) ?? { period, harness: r.harness, server, tool, calls: 0 };
    b.calls += r.calls;
    calls.set(k, b);
    total += r.calls;
  }
  const rows: Row[] = [...calls.values()]
    .sort((a, b) => byCode(a.period, b.period) || byCode(a.harness, b.harness) || byCode(a.server, b.server) || byCode(a.tool, b.tool))
    .map((b) => ({ period: b.period, harness: b.harness, server: b.server, tool: b.tool, calls: b.calls }));
  const cols = [col('period', 'Period', 'date'), col('harness', 'Harness', 'text'), col('server', 'MCP server', 'text'), col('tool', 'Tool', 'text'), col('calls', 'Calls', 'count')];
  return { ...envelope(p, 'tools', p.by, f, cols, rows, { calls: total }), ...extra };
}

/** The most entries the Admin activity report returns; a longer log is cut and says so (`truncated`). */
const ACTIVITY_MAX = 1000;

async function activityReport(deps: ReportDeps, q: Query): Promise<ReportReply> {
  const today = localDay(deps.now());
  const p = parseParams({ ...q, by: undefined }, today);
  const kind = one(q, 'kind');
  if (kind !== undefined && kind !== '' && !/^[A-Za-z0-9_.-]{1,64}$/.test(kind)) throw new ReportError('kind is not a kind of Admin log entry');
  const found = (await deps.db.adminLogRows(dayStart(p.from), dayStart(addDays(p.to, 1)), kind || undefined, ACTIVITY_MAX + 1)) as unknown as Row[];
  const truncated = found.length > ACTIVITY_MAX;
  const rows = truncated ? found.slice(0, ACTIVITY_MAX) : found;
  const facts = { oldestDay: await oldestRollupDay(deps.db, today) } as Facts;
  const out = envelope(p, 'activity', null, facts, [col('t', 'Time', 'time'), col('kind', 'Kind', 'text'), col('detail', 'Detail', 'text'), col('source', 'Source', 'text')], rows, { count: rows.length });
  out.partial = false;
  out.truncated = truncated;
  out.basedOn = 'admin log';
  return out;
}

/** Each rollup table with its rows and oldest day, and how long retention keeps the other tables (Data kept). */
export const retentionReport = (deps: ReportDeps): Promise<Record<string, unknown>> => deps.tx(() => retentionOf(deps));

async function retentionOf(deps: ReportDeps): Promise<Record<string, unknown>> {
  const keepMs = deps.retention.rollupMs ?? ROLLUP_KEEP_MS;
  const days = (ms: number) => Math.round(ms / 86_400_000);
  const tables = [];
  for (const name of ROLLUP_TABLES) {
    const r = await deps.db.rollupStats(name);
    tables.push({ name, rows: r.n, oldestDay: r.d, keptDays: days(keepMs) });
  }
  const r = deps.retention;
  return { report: 'retention', tz: serverZone(), tables, detail: [{ name: 'samples', keptDays: round(r.samplesMs / 86_400_000, 2) }, { name: 'events', keptDays: days(r.eventsMs) }, { name: 'sessions', keptDays: days(r.sessionsMs) }, { name: 'admin_log', keptDays: days(r.adminLogMs) }] };
}

/** Each report reads in one transaction: an hourly rollup write or a retention pass cannot land between two of its reads. */
export const runReport = (deps: ReportDeps, name: ReportName, q: Query): Promise<ReportReply> => deps.tx(() => reportOf(deps, name, q));

function reportOf(deps: ReportDeps, name: ReportName, q: Query): Promise<ReportReply> {
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
    case 'tools':
      return toolsReport(deps, q, cost);
    default:
      return activityReport(deps, q);
  }
}

// ---- projection (#483) -----------------------------------------------------------------------------

export const PROJECTION_MIN_DAYS = 7;
export const PROJECTION_MIN_ACTIVE_DAYS = 3;
const HORIZONS = ['month', '30d'] as const;
const WINDOWS = [7, 14, 30] as const;

export const projectionReport = (deps: ReportDeps, q: Query): Promise<ReportReply> => deps.tx(() => projectionOf(deps, q));

async function projectionOf(deps: ReportDeps, q: Query): Promise<ReportReply> {
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
  const oldest = await oldestRollupDay(deps.db, today);
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
    ...(await select(deps.db, 'usage_daily', winFrom < monthFrom ? winFrom : monthFrom, winTo)).map(usageOf),
    ...(await buildRollups(deps.db, cost, dayStart(today))).usage.filter((r) => r.day === today),
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
export const spendToday = (deps: ReportDeps, owner: string, isGroup: boolean): Promise<SpendTodayReply> => deps.tx(() => spendTodayOf(deps, owner, isGroup));

async function spendTodayOf(deps: ReportDeps, owner: string, isGroup: boolean): Promise<SpendTodayReply> {
  const since = startOfDay(deps.now());
  const pricing = deps.pricing();
  const cost = costFn(pricing);
  const want = unlabel(owner);
  const mine = (await deps.db.sessionSpendSince(since, cost)).filter((r) => {
    const name = isGroup ? r.grp : r.owner;
    return want === '' ? name === null : name === want;
  });
  const total = mine.reduce((n, r) => n + r.usd, 0);
  const share = (n: number) => (total > 0 ? n / total : 0);
  const spent = mine.filter((r) => r.priced && r.usd > 0);
  const unpriced = mine.filter((r) => !r.priced && r.lastSeenAt >= since).length;
  const agentCosts = await deps.db.agentCostsSince(since, cost);

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
    const whole = r.whole ?? 0;
    agents += whole > 0 ? r.usd * Math.min(1, (agentCosts.get(r.id) ?? 0) / whole) : 0;
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
  if (typeof v === 'string' && s !== '-' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** The report's `columns` as a header row and its `rows` under them, CRLF-separated. */
export function toCsv(columns: Column[], rows: Row[]): string {
  const lines = [columns.map((c) => csvCell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c.key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
