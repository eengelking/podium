import { readFileSync } from "node:fs";
import path from "node:path";
import { serverDir } from "../serverRoot.js";
import type { ReporterCompat, ReporterSupport } from "./protocol.js";
import { CLAUDE_REPORTER_NAME, OPENCODE_REPORTER_NAME, canonicalReporterName } from "./reporterNames.js";

/** The reporter every report came from before reporters had names, and the one an absent name means. */
export const DEFAULT_REPORTER = CLAUDE_REPORTER_NAME;

/**
 * The versions of each reporter this server reads correctly, by `reporter.name` (#852). A range changes only when the
 * report format or that reporter's behaviour requires it, not on every release. Only major.minor is compared, so a
 * patch fix never warns. A reporter with no entry here is not checked (`unknown`), so a new one starts at its first
 * release with an entry of its own and never inherits another's range.
 */
export const REPORTER_SUPPORT: Readonly<Record<string, ReporterSupport>> = {
  [DEFAULT_REPORTER]: { min: "0.2.0", max: "1.5.0" },
  [OPENCODE_REPORTER_NAME]: { min: "1.4.0", max: "1.5.0" },
};

/** The name of the reporter that serves each harness (a session stores its harness, not its reporter). */
const REPORTER_OF_HARNESS: Readonly<Record<string, string>> = { "claude-code": DEFAULT_REPORTER, opencode: OPENCODE_REPORTER_NAME };

/** The range for one reporter, or null when this server has none for that name. */
export function supportFor(reporterName: string | null | undefined): ReporterSupport | null {
  const name = canonicalReporterName(reporterName);
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

/**
 * The first reporter release with the Chat person frame and the Admin callout (`adminNotices`, #1034). A reporter older than it shows a person's text
 * unframed and cannot tell its person that an Admin is reading, so the console does not send a person's text to its agent (#1051). It was unreleased when
 * this was written (the last tag was 1.5.1); change it here if the release that carries Chat has another number.
 */
export const CHAT_REPORTER_SINCE = "1.6.0";

/**
 * Whether a reporter of this version can show the Admin callout. A dev build (it carries its commit) is the code under test and counts as current; a
 * version that cannot be read does not count.
 */
export function showsAdminCallout(version: string | null | undefined, build: string | null | undefined): boolean {
  if (build) return true;
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  const need = CHAT_REPORTER_SINCE.split(".").map(Number);
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    const d = Number(v[i + 1]) - need[i]!;
    if (d !== 0) return d > 0;
  }
  return true;
}
