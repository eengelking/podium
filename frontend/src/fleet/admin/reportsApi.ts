// Admin > Reporting (#484, #482, #483): the report reply as docs/spec/ describes it, a small client for it, the period
// choices, what the page remembers in this browser, and the one place a cell is turned into text. No component is here.
import { fmtDur, fmtTok } from "../format";
import { readJson, writeJson } from "../storage";
import { AdminError, type AdminApi } from "./adminApi";

export type ReportId = "usage" | "spend" | "people" | "sessions" | "failures" | "activity";
export type By = "day" | "week" | "month";

export interface ReportColumn {
  key: string;
  label: string;
  /** What the figure is. The page reads it as a hint and falls back to the column's key, so an unknown unit still draws. */
  unit?: string;
}
/** A row is an object; `columns` names its keys in order. A figure that is unknown is `null`, never 0. */
export type ReportRow = Record<string, unknown> & { sessionIds?: string[] };
export interface ReportReply {
  report: string;
  from: string;
  to: string;
  by?: By;
  /** The server's time zone, in which days, weeks and months are drawn. */
  tz: string;
  basedOn?: unknown;
  /** The first day the rollups hold, or null when they hold none. */
  oldestDay: string | null;
  columns: ReportColumn[];
  rows: ReportRow[];
  total: ReportRow | null;
  /** True when the period reaches before `oldestDay`: the rows cover only what Podium has. */
  partial?: boolean;
  /** The Admin activity report only: the log held more entries than the report returns, so these are the newest. */
  truncated?: boolean;
  /** The People and groups report only. */
  summary?: { people: number; groups: number; reporters: number; reporterVersions: Record<string, number>; engineVersions: Record<string, number> };
}
export interface RetentionReply {
  tables: { name: string; rows: number; oldestDay: string | null; keptDays: number }[];
  detail: { name: string; keptDays: number }[];
}
/** `GET reports/spend/today/:owner` (#482). Each cut adds up to `total`; a part on a model with no price has a null `costUsd`. */
export interface BreakdownReply {
  owner: string;
  total: number | null;
  bySession: { id: string; name: string; model: string; costUsd: number | null; share?: number | null }[];
  byModel: { model: string; costUsd: number | null; share?: number | null }[];
  bySource: { orchestrator: number | { costUsd: number | null } | null; agents: number | { costUsd: number | null } | null };
  byPerson?: { owner: string; costUsd: number | null; share?: number | null }[];
  /** How many sessions were left out for want of a price. */
  unpriced: number;
}
/** `GET reports/spend/projection` (#483): rows and a total row of `key, runRatePerDay, spentThisMonth, projected`. */
export interface ProjectionReply {
  columns: ReportColumn[];
  rows: { key: string; runRatePerDay: number | null; spentThisMonth: number | null; projected: number | null; reason?: string }[];
  total: { runRatePerDay: number | null; spentThisMonth: number | null; projected: number | null; reason?: string } | null;
  window: { from: string; to: string; days: number };
  horizon: string;
  unpricedSessions: number;
  historyDays: number;
}

export interface ReportsClient {
  get: <T>(path: string) => Promise<T>;
  /** The same query as text, for the CSV download. */
  text: (path: string) => Promise<string>;
}

export function makeReportsClient(base: string, api: AdminApi): ReportsClient {
  return {
    get: <T>(path: string) => api<T>("GET", path),
    text: async (path: string) => {
      const res = await fetch(`${base}${path}`, { credentials: "same-origin", headers: { "X-Podium-Admin": "1" } });
      if (!res.ok) throw new AdminError(res.status, `HTTP ${res.status}`);
      return res.text();
    },
  };
}

/** What a person is told when a report did not load. Never a status code. */
export function reportErrorText(e: unknown, what = "this report"): string {
  if (e instanceof AdminError && e.status === 400) return `The server did not accept that period or filter for ${what}. Choose another and try again.`;
  return `Could not load ${what}. Check that the server is running, then try again.`;
}

/* ---- the period ------------------------------------------------------------------------------------------------ */

export type PeriodId = "7d" | "30d" | "90d" | "month" | "last-month" | "custom";
export const PERIODS: [PeriodId, string][] = [
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["90d", "Last 90 days"],
  ["month", "This month"],
  ["last-month", "Last month"],
  ["custom", "Custom"],
];
export const BYS: [By, string][] = [
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
];
const MAX_DAYS = 400;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, "0");
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Whole days from `a` to `b`, both `YYYY-MM-DD`; null when either is not a real date. */
function daysBetween(a: string, b: string): number | null {
  const parse = (s: string) => {
    if (!DAY.test(s)) return null;
    const t = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
    return new Date(t).toISOString().slice(0, 10) === s ? t : null;
  };
  const x = parse(a);
  const y = parse(b);
  return x === null || y === null ? null : Math.round((y - x) / 86_400_000);
}

/** The first and last day a period names, in this browser's calendar. */
export function periodRange(period: PeriodId, custom: { from: string; to: string }, now = new Date()): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const day = (yy: number, mm: number, dd: number) => ymd(new Date(yy, mm, dd));
  switch (period) {
    case "7d":
      return { from: day(y, m, d - 6), to: day(y, m, d) };
    case "30d":
      return { from: day(y, m, d - 29), to: day(y, m, d) };
    case "90d":
      return { from: day(y, m, d - 89), to: day(y, m, d) };
    case "month":
      return { from: day(y, m, 1), to: day(y, m, d) };
    case "last-month":
      return { from: day(y, m - 1, 1), to: day(y, m, 0) };
    default:
      return custom;
  }
}

/** Why a range cannot be asked for, in words, or null when it can. */
export function rangeProblem(from: string, to: string, now = new Date()): string | null {
  const span = daysBetween(from, to);
  if (span === null) return "Enter From and To as dates, like 2026-10-01.";
  if (span < 0) return "From must be on or before To.";
  if (span + 1 > MAX_DAYS) return `A period can cover at most ${MAX_DAYS} days. Move From closer to To.`;
  if ((daysBetween(ymd(now), to) ?? 0) > 0) return "To cannot be after today.";
  return null;
}

/* ---- what the page remembers (localStorage `podium.adminReporting`, read and written with try/catch) ------------- */

export const REPORTING_KEY = "podium.adminReporting";
export interface ReportPrefs {
  period: PeriodId;
  from: string;
  to: string;
  by: By;
  breakdown: string;
  person: string;
  group: string;
  model: string;
  kind: string;
  pageSize: number;
}
const PAGE_SIZES = [25, 50, 100];

function section(name: string): Record<string, unknown> {
  const all = readJson<unknown>(REPORTING_KEY, null);
  const o = all && typeof all === "object" && !Array.isArray(all) ? (all as Record<string, unknown>)[name] : null;
  return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
}
function writeSection(name: string, value: unknown): void {
  const all = readJson<unknown>(REPORTING_KEY, null);
  const base = all && typeof all === "object" && !Array.isArray(all) ? (all as Record<string, unknown>) : {};
  writeJson(REPORTING_KEY, { ...base, [name]: value });
}
const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);

/** Stored choices for one report, with anything unreadable or unknown replaced by its default (Last 30 days, by day). */
export function readReportPrefs(report: string, defaultBreakdown = ""): ReportPrefs {
  const o = section(report);
  const period = PERIODS.some(([id]) => id === o.period) ? (o.period as PeriodId) : "30d";
  const by = BYS.some(([id]) => id === o.by) ? (o.by as By) : "day";
  return {
    period,
    from: str(o.from, ""),
    to: str(o.to, ""),
    by,
    breakdown: str(o.breakdown, defaultBreakdown),
    person: str(o.person, ""),
    group: str(o.group, ""),
    model: str(o.model, ""),
    kind: str(o.kind, ""),
    pageSize: PAGE_SIZES.includes(o.pageSize as number) ? (o.pageSize as number) : PAGE_SIZES[0]!,
  };
}
export function writeReportPrefs(report: string, prefs: ReportPrefs): void {
  writeSection(report, prefs);
}

export interface ProjectionPrefs {
  horizon: "month" | "30d";
  window: 7 | 14 | 30;
  by: "person" | "group";
  pageSize: number;
}
export function readProjectionPrefs(): ProjectionPrefs {
  const o = section("projection");
  return {
    horizon: o.horizon === "30d" ? "30d" : "month",
    window: o.window === 7 || o.window === 30 ? o.window : 14,
    by: o.by === "group" ? "group" : "person",
    pageSize: PAGE_SIZES.includes(o.pageSize as number) ? (o.pageSize as number) : PAGE_SIZES[0]!,
  };
}
export function writeProjectionPrefs(p: ProjectionPrefs): void {
  writeSection("projection", p);
}

/* ---- text for a cell ---------------------------------------------------------------------------------------------- */

export const DASH = "–";
/** Dollars with cents and a thousands separator, as a report reads: "$1,134.80". A null is a dash, never $0.00. */
export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const fmtInt = (v: number) => v.toLocaleString("en-US");

/** The kind of figure a column holds: its unit when the server names one we know, else a guess from its key. */
function kindOf(col: ReportColumn): "usd" | "tokens" | "seconds" | "percent" | "time" | "count" | "text" {
  const unit = (col.unit ?? "").toLowerCase();
  if (unit === "usd" || unit === "$" || unit === "dollars") return "usd";
  if (unit === "tokens" || unit === "tok") return "tokens";
  if (unit === "seconds" || unit === "s" || unit === "sec") return "seconds";
  if (unit === "percent" || unit === "pct" || unit === "%") return "percent";
  if (unit === "time" || unit === "ms" || unit === "datetime" || unit === "timestamp") return "time";
  if (unit === "count" || unit === "number" || unit === "int") return "count";
  if (unit === "text" || unit === "date" || unit === "string") return "text";
  if (/Usd$/.test(col.key)) return "usd";
  if (/^tok[A-Z]/.test(col.key)) return "tokens";
  if (/DurationS$/.test(col.key)) return "seconds";
  if (/Pct$/.test(col.key)) return "percent";
  if (col.key === "t" || /At$/.test(col.key)) return "time";
  return "count";
}
/** Whether a column's figures line up on the right: a number, or a column of unknowns that would be one. */
export function isNumericColumn(col: ReportColumn, sample: unknown): boolean {
  const kind = kindOf(col);
  if (kind === "time") return false;
  if (typeof sample === "number") return true;
  return (sample === null || sample === undefined) && (kind === "usd" || kind === "tokens" || kind === "seconds" || kind === "percent");
}

export function whenAt(t: number): string {
  return new Date(t).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** A cell as text. An unknown figure (null) is a dash. */
export function formatCell(col: ReportColumn, v: unknown): string {
  if (v === null || v === undefined) return DASH;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v !== "number") return String(v);
  if (!Number.isFinite(v)) return DASH;
  switch (kindOf(col)) {
    case "usd":
      return fmtMoney(v);
    case "tokens":
      return fmtTok(v);
    case "seconds":
      return fmtDur(v);
    case "percent":
      return `${Math.round(v)}%`;
    case "time":
      return whenAt(v);
    default:
      return fmtInt(v);
  }
}

/* ---- the chart's points ------------------------------------------------------------------------------------------- */

export interface ChartPoint {
  period: string;
  /** Null when every row of the period was unknown: it is drawn as a gap, never as zero. */
  value: number | null;
}
/** One value per period, summing the rows of a break-down. Rows without a period make no points. */
export function chartPoints(rows: ReportRow[], key: string): ChartPoint[] {
  const by = new Map<string, number | null>();
  for (const r of rows) {
    const period = r.period;
    if (typeof period !== "string") continue;
    const v = r[key];
    const prev = by.get(period) ?? null;
    by.set(period, typeof v === "number" ? (prev ?? 0) + v : prev);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([period, value]) => ({ period, value }));
}

/* ---- download ----------------------------------------------------------------------------------------------------- */

/** Saves text as a file from this page. The object URL is revoked once the click has been handed to the browser. */
export function saveFile(name: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
