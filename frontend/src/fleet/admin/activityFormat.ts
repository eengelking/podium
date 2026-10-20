// Activity history (#432): how the Data and Stored activity pages write a size, a count, a day and an error.
import { fmtCount } from "../format";
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

/** The UTC day of an epoch time, as 2026-10-09. */
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * What a person is told when a call failed, the same on both pages. `what` is the verb phrase ("load the stored activity").
 * A 400 carries the server's own words about what to fix, so those stay; anything else is never printed raw.
 */
export function activityErrorText(e: unknown, what: string): string {
  if (e instanceof AdminError && e.status === 400 && e.message) return `${e.message.replace(/\.?$/, ".")} Change it and try again.`;
  return `Could not ${what}. Check that the server is running, then try again.`;
}
