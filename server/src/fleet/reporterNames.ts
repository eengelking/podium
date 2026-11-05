import type { ReporterName } from '../../../plugin/core/protocol.js';

// The names a reporter sends in `reporter.name` (#967). The product, the plugin and the MCP tools are `podium-reporter`; each
// harness's reporter has its own wire name, the way an API keeps a v1 and a v2 apart. No imports, so storage and protocol share it.

/** What every reporter sent before a second harness existed: the Claude Code reporter. Still accepted, and meant as Claude Code. */
export const LEGACY_REPORTER_NAME = 'podium-reporter' as const;
export const CLAUDE_REPORTER_NAME = 'podium-reporter-claudecode' as const;
export const OPENCODE_REPORTER_NAME = 'podium-reporter-opencode' as const;

/** The names a v2 report may carry. */
export const KNOWN_REPORTER_NAMES: readonly ReporterName[] = [LEGACY_REPORTER_NAME, CLAUDE_REPORTER_NAME, OPENCODE_REPORTER_NAME];

/** The one name a reporter is known by: the legacy name is the Claude Code reporter, and an absent name means it too. */
export function canonicalReporterName(name: string | null | undefined): string {
  return !name || name === LEGACY_REPORTER_NAME ? CLAUDE_REPORTER_NAME : name;
}

/** Every name a stored row of this reporter may hold: rows made before the rename keep the legacy name until the reporter next reports. */
export function storedReporterNames(name: string | null | undefined): [string, string] {
  const canonical = canonicalReporterName(name);
  return [canonical, canonical === CLAUDE_REPORTER_NAME ? LEGACY_REPORTER_NAME : canonical];
}
