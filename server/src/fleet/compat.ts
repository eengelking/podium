import { readFileSync } from "node:fs";
import path from "node:path";
import { serverDir } from "../serverRoot.js";
import type { ReporterCompat, ReporterSupport } from "./protocol.js";

/** The reporter every report came from before reporters had names, and the one an absent name means. */
export const DEFAULT_REPORTER = "podium-reporter";

/**
 * The versions of each reporter this server reads correctly, by `reporter.name` (#852). A range changes only when the
 * report format or that reporter's behaviour requires it, not on every release. Only major.minor is compared, so a
 * patch fix never warns. A reporter with no entry here is not checked (`unknown`), so a new one starts at its first
 * release with an entry of its own and never inherits another's range.
 */
export const REPORTER_SUPPORT: Readonly<Record<string, ReporterSupport>> = {
  [DEFAULT_REPORTER]: { min: "0.2.0", max: "1.4.0" },
};

/** The name of the reporter that serves each harness (a session stores its harness, not its reporter). */
const REPORTER_OF_HARNESS: Readonly<Record<string, string>> = { "claude-code": DEFAULT_REPORTER };

/** The range for one reporter, or null when this server has none for that name. */
export function supportFor(reporterName: string | null | undefined): ReporterSupport | null {
  const name = reporterName || DEFAULT_REPORTER;
  return Object.hasOwn(REPORTER_SUPPORT, name) ? REPORTER_SUPPORT[name] : null;
}

/** The reporter that serves a harness; the harness id itself when none is known, so the warning still names something. */
export function reporterOfHarness(harness: string | null | undefined): string {
  return (harness && Object.hasOwn(REPORTER_OF_HARNESS, harness) ? REPORTER_OF_HARNESS[harness] : harness) || DEFAULT_REPORTER;
}

export type { ReporterCompat, ReporterSupport };

function minor(version: string | null | undefined): [number, number] | null {
  const m = /^(\d+)\.(\d+)\.\d+$/.exec(version ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function cmp(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** `support` defaults to the named reporter's own range; a reporter with none is `unknown`, never judged by another's. */
export function checkReporter(
  version: string | null | undefined,
  reporterName: string | null | undefined = DEFAULT_REPORTER,
  support: ReporterSupport | null = supportFor(reporterName),
): ReporterCompat {
  if (!support) return "unknown";
  const v = minor(version);
  const lo = minor(support.min);
  const hi = minor(support.max);
  if (!v || !lo || !hi) return "unknown";
  if (cmp(v, lo) < 0) return "outdated";
  if (cmp(v, hi) > 0) return "newer";
  return "ok";
}

let cached: string | null = null;

/** The server's own version, from server/package.json (the same relative path from src/ and dist/). */
export function serverVersion(): string {
  if (cached) return cached;
  const here = serverDir(import.meta.url);
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // keep "unknown"
  }
  cached = version;
  return version;
}
