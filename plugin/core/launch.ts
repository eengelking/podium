// The launch announce (#1112). A harness reaches the chat's People and agents list when its reporter reports a session. Claude Code has one the
// moment it starts (its SessionStart hook), so its first report is the announce. A harness that makes no session until the first prompt (OpenCode)
// reports a placeholder under an id of this shape and ends it when its first real session starts. The server keeps a session that has done nothing
// off the wall (`isUnused`, #42), so the announce is in the chat and has no card. Pure: no clock, no network, no harness.
import { lastSegment } from './git.ts';

export const LAUNCH_PREFIX = 'launch-';

/** The most characters of the random part: the whole id stays within 32, as short as a session id the wall shows. */
const RANDOM_MAX = 24;

/** The placeholder's session id for a harness that has none at launch. `random` is any unique text; characters the server refuses in an id are dropped. */
export function launchId(random: string): string {
  const cut = random.replaceAll(/[^A-Za-z0-9_-]/g, '').slice(0, RANDOM_MAX);
  // A hyphen left at the end by the cut is dropped by hand: a regular expression for it backtracks (S8786).
  let end = cut.length;
  while (end > 0 && cut[end - 1] === '-') end--;
  return `${LAUNCH_PREFIX}${cut.slice(0, end)}`;
}

/** Whether `id` is a placeholder from `launchId`, never a session the harness made. */
export function isLaunchId(id: string): boolean {
  return id.startsWith(LAUNCH_PREFIX);
}

/** What the chat calls a launched agent that has no title yet: the folder it started in, else the harness's own name. */
export function launchName(cwd: string | null, harnessName: string): string {
  const folder = cwd ? lastSegment(cwd) : '';
  return folder && folder !== '/' ? folder : harnessName;
}

/** Why the placeholder ended: the harness started a real session, which the chat lists from now on. */
export const LAUNCH_ENDED = 'launched';
