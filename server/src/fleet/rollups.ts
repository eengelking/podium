// The daily rollups behind Admin > Reporting (#484, SPEC 7.2 "Migration 22" and "Retention").
//
// A rollup holds counts, tokens, cost and names (a person, group, model, project, effort), never a prompt, an answer, a
// tool's input or a path. A day is a calendar day in the server's time zone, `YYYY-MM-DD`; a session counts on the day it
// was last seen, so one that runs past midnight is not split. The hourly retention writes the rollups before it deletes
// anything (`writeRollups`); the reports read today straight from the live tables with the same builder (`buildRollups`).
import { repriced } from './derive.js';
import { ROLLUP_KEEP_MS, type CostOf, type SessionRow, type SessionWaitRow } from '../storage/rows.js';
import { waitOfOpen } from './waits.js';
import type { FleetStore, Storage } from '../storage/types.js';
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

/** Calls of one tool by one harness on a day (#720). A name and a count: never a tool's input, a path or a command. */
export interface ToolDay {
  day: string;
  harness: string;
  tool: string;
  calls: number;
}

/** How many sessions of one harness made about `bucket` tool calls on a day (#720), so a median and a 90th percentile can be read across days. */
export interface ToolSessionDay {
  day: string;
  harness: string;
  bucket: number;
  sessions: number;
}

/** How many reporters ran one version of one harness on a day (#720). */
export interface HarnessVersionDay {
  day: string;
  harness: string;
  version: string;
  reporters: number;
}

/**
 * The size class a session's tool calls are counted in: its own number up to 100, then the next ten up to 1,000, then the next hundred.
 * A median or percentile read from the classes is exact up to 100 calls and at most 10 (then 100) calls above the truth beyond that.
 */
export function callsBucket(n: number): number {
  const calls = Math.max(0, Math.floor(n));
  if (calls <= 100) return calls;
  if (calls <= 1000) return Math.ceil(calls / 10) * 10;
  return Math.ceil(calls / 100) * 100;
}

/**
 * How long the sessions of one harness ran, and how long they waited on a person, on a day (#722). Waiting is recorded from the upgrade on, so only the
 * sessions with a wait record (`trackedSessions`) say how long they waited, and `trackedS` is how long those ran since the record began: a share of time
 * is waiting over `trackedS`, never over the whole duration. Names and times only.
 */
export interface SessionTimeDay {
  day: string;
  harness: string;
  sessions: number;
  durationS: number;
  maxDurationS: number;
  trackedSessions: number;
  trackedS: number;
  permissionS: number;
  permissionN: number;
  questionS: number;
  questionN: number;
  planS: number;
  planN: number;
}

/** How many agents of one type a harness launched on a day, and how many levels down the chain they sit (#722). 1 is launched by the session itself. */
export interface AgentDay {
  day: string;
  harness: string;
  type: string;
  depth: number;
  agents: number;
}

/** How many sessions one person ran on a harness on a day (#722). A session counts on the day it was last seen. */
export interface PersonDay {
  day: string;
  owner: string;
  group: string;
  harness: string;
  sessions: number;
}

/** The most sessions live at once in one hour of one day (#722). `harness` is '' for all of them together: the peak of the whole is not the sum of the peaks of the parts. */
export interface HourPeakDay {
  day: string;
  harness: string;
  hour: number;
  peak: number;
}

/** The deepest an agent chain is told apart: a chain deeper than this is stored as this. */
export const MAX_AGENT_DEPTH = 10;

/** How many levels down each agent sits, from the links of one session's agents. A parent that is not stored counts as one level (it is at least a child). */
export function agentDepths(links: { agent: string; parent: string | null }[]): Map<string, number> {
  const parentOf = new Map(links.map((l) => [l.agent, l.parent] as const));
  const depth = new Map<string, number>();
  for (const { agent } of links) {
    let d = 1;
    let at = parentOf.get(agent) ?? null;
    // a loop of parents (a report that names itself) stops at the cap
    while (at !== null && d < MAX_AGENT_DEPTH) {
      d += 1;
      at = parentOf.get(at) ?? null;
    }
    depth.set(agent, d);
  }
  return depth;
}

export interface DayRollups {
  usage: UsageDay[];
  sessions: SessionsDay[];
  failures: FailureDay[];
  fleet: FleetDay[];
  tools: ToolDay[];
  toolSessions: ToolSessionDay[];
  harnessVersions: HarnessVersionDay[];
  sessionTime: SessionTimeDay[];
  agentTypes: AgentDay[];
  personDays: PersonDay[];
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

/** How long a session ran, in whole seconds. */
const durationS = (s: SessionRow): number => Math.max(0, Math.round(((s.ended_at ?? s.last_seen_at) - s.started_at) / 1000));

/** The plan a session works from: where its plan came from, or `none`. */
const planOf = (s: SessionRow): string => safeParse<{ source?: string } | null>(s.plan_json ?? s.plan_kept_json ?? null, null)?.source ?? 'none';

const outcomeOf = (s: SessionRow): string => s.end_reason ?? (s.ended_at === null && s.dropped_at === null && s.status !== 'done' ? 'running' : 'ended');

/**
 * The rollups of every stored session last seen at or after `fromMs`. `sessionsStarted` counts the sessions started on a
 * day, wherever they were last seen. The peak of live sessions is left at 0: `peakLiveByDay` reads it from the samples.
 */
export async function buildRollups(db: FleetStore, cost: CostOf, fromMs: number): Promise<DayRollups> {
  const sessions = await db.sessionsSince(fromMs);
  const agentCount = new Map<string, number>();
  for (const r of await db.agentCountsSince(fromMs)) agentCount.set(r.id, r.n);
  const reporterOf = new Map<string, string>();
  for (const r of await db.reporterKeysSince(fromMs)) reporterOf.set(r.id, r.k);
  const failureRows = await db.failureRowsSince(fromMs);
  // Waiting on a person (#722) and who launched each agent: names, times and links only.
  const waitsOf = new Map((await db.waitsSince(fromMs)).map((w) => [w.session_id, w] as const));
  const linksOf = new Map<string, { agent: string; parent: string | null; type: string }[]>();
  for (const r of await db.agentLinksSince(fromMs)) {
    const list = linksOf.get(r.id) ?? [];
    list.push({ agent: r.agent, parent: r.parent, type: r.type });
    linksOf.set(r.id, list);
  }
  // Each session's tool calls by name, added up over its agents (#720). Only names and counts are read, from a column that holds only those.
  const callsOf = new Map<string, Map<string, number>>();
  for (const r of await db.toolCountsSince(fromMs)) {
    const counts = safeParse<Record<string, unknown> | null>(r.c, null);
    if (!counts || typeof counts !== 'object') continue;
    const into = callsOf.get(r.id) ?? new Map<string, number>();
    for (const [tool, n] of Object.entries(counts)) if (typeof n === 'number' && Number.isFinite(n) && n > 0) into.set(tool, (into.get(tool) ?? 0) + n);
    callsOf.set(r.id, into);
  }
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
  const tools = new Map<string, ToolDay>();
  const toolSessions = new Map<string, ToolSessionDay>();
  const harnessReporters = new Map<string, { day: string; harness: string; version: string; reporters: Set<string> }>();
  const timeAcc = new Map<string, SessionTimeDay & { ms: Record<'permission' | 'question' | 'plan', number> }>();
  const agentTypes = new Map<string, AgentDay>();
  const personDays = new Map<string, PersonDay>();
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

    const harness = s.harness;
    const calls = callsOf.get(s.id);
    let total = 0;
    for (const [tool, n] of calls ?? []) {
      const tk = `${day}\u0000${harness}\u0000${tool}`;
      const row = tools.get(tk) ?? ({ day, harness, tool, calls: 0 } satisfies ToolDay);
      row.calls += n;
      tools.set(tk, row);
      total += n;
    }
    // A session with no tool counts is left out: one stored before they were kept and one that called no tool look the same, so it is not a session of zero calls.
    if (calls) {
      const bucket = callsBucket(total);
      const bk = `${day}\u0000${harness}\u0000${bucket}`;
      const sized = toolSessions.get(bk) ?? ({ day, harness, bucket, sessions: 0 } satisfies ToolSessionDay);
      sized.sessions += 1;
      toolSessions.set(bk, sized);
    }

    // How long it ran and waited, per harness (#722). A wait still open counts to the last time the session was seen.
    const tk = `${day}\u0000${harness}`;
    const t =
      timeAcc.get(tk) ??
      ({ day, harness, sessions: 0, durationS: 0, maxDurationS: 0, trackedSessions: 0, trackedS: 0, permissionS: 0, permissionN: 0, questionS: 0, questionN: 0, planS: 0, planN: 0, ms: { permission: 0, question: 0, plan: 0 } } satisfies SessionTimeDay & { ms: Record<'permission' | 'question' | 'plan', number> });
    t.sessions += 1;
    t.durationS += d;
    t.maxDurationS = Math.max(t.maxDurationS, d);
    const wr: SessionWaitRow | undefined = waitsOf.get(s.id);
    if (wr) {
      t.trackedSessions += 1;
      t.trackedS += Math.max(0, Math.round(((s.ended_at ?? s.last_seen_at) - wr.tracked_since) / 1000));
      t.ms.permission += wr.permission_ms;
      t.ms.question += wr.question_ms;
      t.ms.plan += wr.plan_ms;
      t.permissionN += wr.permission_n;
      t.questionN += wr.question_n;
      t.planN += wr.plan_n;
      const open = waitOfOpen(wr, s.last_seen_at);
      if (open) {
        t.ms[open.kind] += open.ms;
        t[`${open.kind}N`] += 1;
      }
    }
    timeAcc.set(tk, t);

    // Agents by type and how deep their chain is (#722).
    const links = linksOf.get(s.id) ?? [];
    const depth = agentDepths(links);
    for (const l of links) {
      const ak = `${day}\u0000${harness}\u0000${l.type}\u0000${depth.get(l.agent)}`;
      const a = agentTypes.get(ak) ?? ({ day, harness, type: l.type, depth: depth.get(l.agent) ?? 1, agents: 0 } satisfies AgentDay);
      a.agents += 1;
      agentTypes.set(ak, a);
    }

    // Sessions per person per day (#722).
    const pk = `${day}\u0000${owner}\u0000${harness}`;
    const pd = personDays.get(pk) ?? ({ day, owner, group: s.grp ?? '', harness, sessions: 0 } satisfies PersonDay);
    pd.sessions += 1;
    personDays.set(pk, pd);

    const fl = fleetOf(day);
    if (owner) fl.people.add(owner);
    const machine = safeParse<{ id?: string } | null>(s.machine_json, null)?.id;
    const reporter = reporterOf.get(s.id) ?? (machine ? `${machine}#${owner}` : null);
    if (reporter) {
      if (s.engine_version) {
        const vk = `${day}\u0000${harness}\u0000${s.engine_version}`;
        const v = harnessReporters.get(vk) ?? { day, harness, version: s.engine_version, reporters: new Set<string>() };
        v.reporters.add(reporter);
        harnessReporters.set(vk, v);
      }
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
    tools: [...tools.values()],
    toolSessions: [...toolSessions.values()],
    harnessVersions: [...harnessReporters.values()].map((v) => ({ day: v.day, harness: v.harness, version: v.version, reporters: v.reporters.size })),
    sessionTime: [...timeAcc.values()].map(({ ms, ...row }) => ({ ...row, permissionS: Math.round(ms.permission / 1000), questionS: Math.round(ms.question / 1000), planS: Math.round(ms.plan / 1000) })),
    agentTypes: [...agentTypes.values()],
    personDays: [...personDays.values()],
    failureSessions: failSessions,
  };
}

/**
 * The most sessions live at one second on each day the samples cover. A session is live from its first sample to its last,
 * and a session that lives across midnight counts on both days.
 */
export async function peakLiveByDay(db: FleetStore): Promise<Map<string, number>> {
  const spans = await db.sampleSpans();
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

/** The most sessions live at once in each local hour of each day the samples cover, for each harness and for all together (#722). */
export async function peaksByHour(db: FleetStore): Promise<HourPeakDay[]> {
  const windows = new Map<string, { day: string; hour: number; spans: { lo: number; hi: number; harness: string }[] }>();
  for (const { a, b, harness } of await db.sampleSpansByHarness()) {
    // one piece for each local hour the span touches; the clock, not 3,600 seconds, ends an hour, so a day with 23 or 25 hours still has 24 of them
    for (let at = a * 1000; at <= b * 1000; ) {
      const d = new Date(at);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
      const day = localDay(start);
      const key = `${day}\u0000${d.getHours()}`;
      const w = windows.get(key) ?? { day, hour: d.getHours(), spans: [] };
      w.spans.push({ lo: Math.max(a, Math.floor(start / 1000)), hi: Math.min(b, Math.floor(end / 1000) - 1), harness });
      windows.set(key, w);
      at = end;
    }
  }
  const peakOf = (spans: { lo: number; hi: number }[]): number => {
    const edges = spans.flatMap(({ lo, hi }) => [[lo, 1] as const, [hi + 1, -1] as const]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let now = 0;
    let peak = 0;
    for (const [, delta] of edges) {
      now += delta;
      peak = Math.max(peak, now);
    }
    return peak;
  };
  const out: HourPeakDay[] = [];
  for (const w of windows.values()) {
    out.push({ day: w.day, harness: '', hour: w.hour, peak: peakOf(w.spans) });
    for (const harness of [...new Set(w.spans.map((x) => x.harness))].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))) out.push({ day: w.day, harness, hour: w.hour, peak: peakOf(w.spans.filter((x) => x.harness === harness)) });
  }
  return out.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : x.hour - y.hour || (x.harness < y.harness ? -1 : x.harness > y.harness ? 1 : 0)));
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
export function writeRollups(storage: Storage, now: number, cost: CostOf, p: RollupPolicy): Promise<{ days: number; deleted: number }> {
  const db = storage.fleet;
  return storage.tx(async () => {
    let rebuilt = 0;
    const oldest = await db.oldestSessionSeen();
    if (oldest !== null) {
      const sessionCutoff = now - p.sessionsMs;
      const firstDay = localDay(oldest);
      let fromDay = firstDay;
      while (dayStart(fromDay) < sessionCutoff && fromDay < localDay(now)) fromDay = addDays(fromDay, 1);
      // The day the cutoff falls in is half swept. It is written when no earlier run did (the first run after an upgrade): a
      // partly built day is better than a hole, and a fuller one written earlier stays. Days wholly before it stay as they are (#529).
      const written = new Set(await db.rollupDaysBefore(fromDay));
      const cutoffDay = localDay(sessionCutoff);
      const wanted = (day: string): boolean => day >= fromDay || (day === cutoffDay && !written.has(day));
      // Build only from the earliest day that will be written, so an ordinary run does not read the whole retained history.
      const buildFrom = cutoffDay < fromDay && !written.has(cutoffDay) ? (cutoffDay > firstDay ? cutoffDay : firstDay) : fromDay;
      const built = await buildRollups(db, cost, dayStart(buildFrom));
      const peaks = await peakLiveByDay(db);
      await db.deleteRollupsFrom(fromDay);
      await db.insertUsage(built.usage.filter((r) => wanted(r.day)));
      await db.insertSessionsDaily(built.sessions.filter((r) => wanted(r.day)));
      await db.insertFailures(built.failures.filter((r) => wanted(r.day)));
      await db.insertToolsDaily(built.tools.filter((r) => wanted(r.day)));
      await db.insertToolSessionsDaily(built.toolSessions.filter((r) => wanted(r.day)));
      await db.insertHarnessVersionsDaily(built.harnessVersions.filter((r) => wanted(r.day)));
      await db.insertSessionTimeDaily(built.sessionTime.filter((r) => wanted(r.day)));
      await db.insertAgentsDaily(built.agentTypes.filter((r) => wanted(r.day)));
      await db.insertPersonSessionsDaily(built.personDays.filter((r) => wanted(r.day)));
      // the peak of an hour never goes down, as the peak of a day does not: the samples that made it are kept only a day
      await db.upsertHourPeaks((await peaksByHour(db)).filter((r) => wanted(r.day)));
      const days = built.fleet.filter((f) => wanted(f.day));
      await db.upsertFleetDays(days.map((f) => ({ day: f, peak: peaks.get(f.day) ?? 0 })));
      rebuilt += days.length;
    }
    const keepFrom = localDay(now - (p.rollupMs ?? ROLLUP_KEEP_MS));
    const deleted = await db.deleteRollupsBefore(keepFrom);
    return { days: rebuilt, deleted };
  });
}
