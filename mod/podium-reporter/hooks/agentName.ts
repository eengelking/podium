// The title the Claude desktop app shows for a session (#595, SPEC 6.6). A Team or Enterprise login (or managed settings)
// has Claude Code's own guard skip the `classic.*` hooks that carry `session_title`, so the name is read from
// `claude agents --json`, which lists every session with the app's title as `name`. Parsing is pure; `readAppTitle` runs
// the command through an injected runner (the mod passes `$.process.run`).
import type { Runner } from './git.ts';

export type { Runner };

const MAX_TITLE = 80;

/** The trimmed, clipped `name` of the entry whose `sessionId` is `id`; null for no such entry, no name or output that is not a list. */
export function appTitleOf(stdout: string, id: string): string | null {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || (entry as { sessionId?: unknown }).sessionId !== id) continue;
    const name = (entry as { name?: unknown }).name;
    const title = typeof name === 'string' ? name.trim().slice(0, MAX_TITLE) : '';
    return title || null;
  }
  return null;
}

/** The app's title for session `id`; null when the command is missing, fails or does not list the session. */
export async function readAppTitle(run: Runner, id: string): Promise<string | null> {
  try {
    const res = await run(['claude', 'agents', '--json']);
    return res.exitCode === 0 ? appTitleOf(res.stdout, id) : null;
  } catch {
    return null;
  }
}
