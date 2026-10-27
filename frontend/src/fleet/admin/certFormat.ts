// The Certificates page's data and wording (#586, T8): what GET /api/admin/certificates answers, and the words for a date.
import { dayWord, daysUntil, plural } from "../tlsStatus";

export interface CertInfo {
  fingerprintSha256: string;
  subject: string;
  notBefore: string;
  notAfter: string;
  serial: string;
}
export interface CertsView {
  ca: CertInfo | null;
  serving: CertInfo;
  names: { dns: string[]; ip: string[] };
  /** The names on the certificate that is running; `names` is what a renewal would put on the next one. */
  certificateNames: { dns: string[]; ip: string[] };
  previous: CertInfo[];
  settings: { lifetimeDays: number; renewBeforeDays: number; headerCountdown: boolean };
  reporter: { lifetimeDays: number };
  /** Reporters over HTTP (#589): the switch, how many reporters are on HTTP now, and how many reported lately. */
  http: { allow: boolean; overHttp: number; total: number };
  lastRenewed: { at: string; trigger: string } | null;
  lastFailure: { at: string; reason: string; trigger: string } | null;
  /** How long a planned rotation's overlap lasts, for the confirmation's words. */
  overlapDays?: number;
  /** False for a CA made before #588 (`pathlen:0`): a planned rotation is refused for it, so the page offers only the hard cutover (#638). */
  canOverlap?: boolean;
  /** An overlap that is under way after a planned CA rotation (#588). */
  rotation?: { previousCa: CertInfo; cross: CertInfo; startedAt: number; reporters: { onOldCa: number; total: number } } | null;
}

/** The stage of one certificate: blue at `renewWithin` days or fewer (30), orange at 10, red at 5, then expired (mockup #573). */
export type CertStage = "ok" | "soon" | "serious" | "critical" | "expired";
export function stageOf(notAfter: string, now: number, renewWithin = 30): CertStage {
  if (Date.parse(notAfter) < now) return "expired";
  const d = daysUntil(notAfter, now);
  return d <= 5 ? "critical" : d <= 10 ? "serious" : d <= renewWithin ? "soon" : "ok";
}

/** How many days before its end a reporter renews its certificate: 30, or half the lifetime when that is shorter (SPEC 6.8). */
export function renewWithinDays(notBefore: string | undefined, notAfter: string): number {
  const lifetime = (Date.parse(notAfter) - Date.parse(notBefore ?? "")) / 86_400_000;
  return lifetime > 0 ? Math.min(30, lifetime / 2) : 30; // no start date, or one after the end: the usual 30
}

export const dateOf = (iso: string) => iso.slice(0, 10);

/** "28 days left", or "expired 2 days ago" (today, when it lapsed less than a day ago). */
export function leftText(notAfter: string, now: number): string {
  if (Date.parse(notAfter) >= now) return `${plural(daysUntil(notAfter, now), "day")} left`;
  const ago = Math.floor((now - Date.parse(notAfter)) / 86_400_000);
  return ago === 0 ? "expired today" : `expired ${plural(ago, "day")} ago`;
}

/** What the Status badge says for one certificate. */
export function statusText(notAfter: string, now: number): string {
  const stage = stageOf(notAfter, now);
  if (stage === "ok") return "valid";
  if (stage === "expired") return leftText(notAfter, now);
  return `expires ${dayWord(daysUntil(notAfter, now))}`;
}

/** How many whole years a certificate lasts, for "valid 10 years". */
export const yearsOf = (c: CertInfo) => Math.round((Date.parse(c.notAfter) - Date.parse(c.notBefore)) / (365.25 * 86_400_000));

/** Every name on a certificate, names before addresses, each with its kind. */
export function namesList(n: { dns: string[]; ip: string[] }): { name: string; kind: "Name" | "Address" }[] {
  return [...n.dns.map((name) => ({ name, kind: "Name" as const })), ...n.ip.map((name) => ({ name, kind: "Address" as const }))];
}
