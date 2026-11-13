// #1113: how many days a harness lets a person resume a closed session. Podium keeps that session's chat for as long, then purges it.
// One rule for every harness (plugin/core/); each harness only supplies the raw number it has, if any.
// It imports nothing, because the server reads the window through it too and its build takes no `.ts` import path.

/** Claude Code's own default, and what a harness with no expiry of its own uses (OpenCode keeps sessions until the person deletes them). */
export const DEFAULT_RESUME_WINDOW_DAYS = 30

/** The longest window Podium accepts, ten years. A larger number is a stray one, not a wish to keep chat for ever. */
export const MAX_RESUME_WINDOW_DAYS = 3650

/** A raw value from a harness as a whole number of days in 1..MAX; anything else is the default. */
export function resumeWindowDays(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return DEFAULT_RESUME_WINDOW_DAYS
  return Math.min(Math.floor(raw), MAX_RESUME_WINDOW_DAYS)
}

/**
 * The window in effect from the text of Claude Code's `settings.json`: its `cleanupPeriodDays` when it is a usable number, else the default.
 * A Desktop or Cowork session has no expiry unless the person set one, and no expiry is the default too (#1113).
 */
export function resumeWindowFromSettings(text: string | null): number {
  if (!text) return DEFAULT_RESUME_WINDOW_DAYS
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_RESUME_WINDOW_DAYS
    return resumeWindowDays((parsed as Record<string, unknown>).cleanupPeriodDays)
  } catch {
    return DEFAULT_RESUME_WINDOW_DAYS
  }
}

/** A path without its trailing slashes, in linear time (the same rule as `trimTrailingSlashes` in machine.ts). */
function trimSlashes(p: string): string {
  let end = p.length
  while (end > 0 && p[end - 1] === '/') end--
  return p.slice(0, end)
}

/**
 * Where Claude Code's user settings live: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. Null when the directory is not absolute,
 * because a relative one would land under each session's own working directory and sessions would disagree.
 */
export function claudeSettingsPath(configDir: string | undefined, home: string | undefined): string | null {
  const trim = (p: string | undefined) => trimSlashes((p ?? '').trim())
  const dir = trim(configDir) || (trim(home) ? `${trim(home)}/.claude` : '')
  return /^(\/|[A-Za-z]:[\\/])/.test(dir) ? `${dir}/settings.json` : null
}
