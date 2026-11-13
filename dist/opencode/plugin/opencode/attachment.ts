// Which TUI parts of the plugin are attached (#984, #1029). Pure: the time is passed in, so a test can set it.
//
// Each TUI part says it is attached every ATTACH_EVERY_MS, and counts for ATTACH_TTL_MS. When it closes it says it is leaving (`detach`),
// so the server part need not wait out the TTL: a terminal closed on a session served by OpenCode's background service leaves the plugin
// running, and without that word the card stayed for the TTL plus the idle wait (#1029). Several TUI parts may share one server part, so
// the last one to leave is the one that counts.
import { ATTACH_TTL_MS } from './bridge.ts';

/** The key for an attach that names no TUI part (an older TUI part): all of them count as one. */
const ANONYMOUS = '';

/** How many detached ids are remembered: a TUI part's id is a fresh UUID, so only the most recent ones can still have a call in flight. */
const MAX_LEFT = 64;

export class Attachments {
  private readonly seen = new Map<string, number>();
  /** Ids that have left, newest last: an `attach` still in flight when its part closed lands after the `detach` and must not bring the part back. */
  private readonly left = new Set<string>();

  /** A TUI part says it is attached. A part that has already detached stays gone. */
  attach(id: string | undefined, now: number): void {
    if (id !== undefined && this.left.has(id)) return;
    this.seen.set(id ?? ANONYMOUS, now);
    this.prune(now);
  }

  /** A TUI part says it is leaving. True when no TUI part is attached any more, so the quiet sessions of this location are over. */
  detach(id: string | undefined, now: number): boolean {
    this.seen.delete(id ?? ANONYMOUS);
    if (id !== undefined) {
      this.left.delete(id);
      this.left.add(id);
      if (this.left.size > MAX_LEFT) this.left.delete(this.left.values().next().value as string);
    }
    this.prune(now);
    return this.seen.size === 0;
  }

  /** Forgets a TUI part that has not said it is attached within the time limit (one killed without a detach), so the map stays small. */
  private prune(now: number): void {
    for (const [key, at] of this.seen) if (now - at >= ATTACH_TTL_MS) this.seen.delete(key);
  }

  /** When a TUI part last said it is attached; 0 when none is. */
  lastSeen(): number {
    let latest = 0;
    for (const at of this.seen.values()) latest = Math.max(latest, at);
    return latest;
  }

  /** Whether a TUI part has said it is attached within the time limit. */
  attached(now: number): boolean {
    const at = this.lastSeen();
    return at > 0 && now - at < ATTACH_TTL_MS;
  }
}

/** The TUI part's id from an `attach` or `detach` call: a non-empty string, else undefined (an older TUI part sends none). */
export function tuiId(input: unknown): string | undefined {
  const id = (input as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}
