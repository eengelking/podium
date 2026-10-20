// Activity history (#432): how the Data and Stored activity pages write a size, a count, a day and an error.
import { fmtCount, fmtDay } from "../format";
import { AdminError } from "./adminApi";

/** "96 KB", "7.9 MB", "1.2 GB": the size the way the mockup writes it. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export { fmtCount };

/** "1 session", "52 sessions". */
export const sessionsText = (n: number) => `${fmtCount(n)} ${n === 1 ? "session" : "sessions"}`;

/** "1 hour", "30 days": the unit in the singular when there is one. */
export const unitText = (n: number, unit: string) => `${n} ${n === 1 ? unit.replace(/s$/, "") : unit}`;

/** The entries' size estimate, said as an estimate: "about 1.8 MB". */
export const aboutBytes = (bytes: number) => `about ${fmtBytes(bytes)}`;

/** The local day of an epoch time, as 2026-10-09: the same day the Activity window footer writes. */
export const dayOf = fmtDay;

/**
 * What a person is told when a call failed, the same on both pages. `what` is the verb phrase ("load the stored activity").
 * A 400 carries the server's own words about what to fix, so those stay; anything else is never printed raw.
 */
export function activityErrorText(e: unknown, what: string): string {
  if (e instanceof AdminError && e.status === 400 && e.message) return `${e.message.replace(/\.?$/, ".")} Change it and try again.`;
  return `Could not ${what}. Check that the server is running, then try again.`;
}

/** How often the Data and Stored activity pages ask again while open, so the totals and the badge do not go stale. */
export const ACTIVITY_REFRESH_MS = 30_000;
