// What the OpenCode reporter tells the person (#969): the transport's notices as console lines said once, the text of `/podium`, and the
// toast the TUI part shows when the connection changes. Pure; index.ts and tui.ts only carry the text to where it is shown.
import type { Summary } from './reporter.ts';

/** A logger that says each distinct line once. It remembers at most `max` lines, so a long run cannot make it grow without end. */
export function dedupe(sink: (line: string) => void, max = 100): (line: string) => void {
  const said = new Set<string>();
  return (line) => {
    if (said.has(line)) return;
    said.add(line);
    if (said.size > max) said.delete(said.values().next().value as string);
    sink(line);
  };
}

export interface PodiumFacts {
  /** The address reports go to (the reporter config file's, when there is one). */
  serverUrl: string;
  home: string;
  /** What the secure connection says, or null when there is no reporter config file. */
  tls: string | null;
  version: string;
}

const connection = (online: boolean | null): string => (online === null ? 'not tried yet' : online ? 'online' : 'offline, retrying');

/** The `/podium` answer: the same facts the Claude Code `/podium` gives that OpenCode has. */
export function podiumText(s: Summary, f: PodiumFacts): string {
  return [
    `Podium fleet console: ${f.serverUrl.replace(/\/+$/, '')}/#/`,
    f.tls ? `TLS: ${f.tls}` : '',
    `Home folder: ${f.home}`,
    `Connection: ${connection(s.online)}${s.liveSessions === null ? '' : ` (${s.liveSessions} live sessions)`}`,
    `Versions: reporter ${f.version}${s.serverVersion ? `, server ${s.serverVersion}` : ''}`,
    ...s.notices,
    `Reports sent: ${s.sent}, failed: ${s.failed}, rejected: ${s.rejected}; events queued: ${s.queued}${s.dropped ? `, dropped: ${s.dropped}` : ''}`,
    `Last error: ${s.lastError ?? 'none'}`,
    `Sessions: ${s.sessions}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The count of live sessions changes all the time and is no news. */
const withoutCount = (text: string): string => text.replace(/\d+ live/, 'live');

/** The status text to show now, or null when it is not news: no status yet, still connecting, or the same apart from the live count. */
export function statusChange(prev: string | null, next: string | null): string | null {
  if (!next || next.endsWith('connecting')) return null;
  return prev !== null && withoutCount(prev) === withoutCount(next) ? null : next;
}

/** A toast for a status text: a warning for any state marked `○`, information otherwise. */
export function noticeOf(text: string): { title: string; message: string; variant: 'info' | 'warning' } {
  return { title: 'Podium', message: text, variant: text.includes('○') ? 'warning' : 'info' };
}

export type Notice = ReturnType<typeof noticeOf>;

/** Turns the reporter's status into toasts: one per change worth showing. */
export class StatusWatcher {
  private last: string | null = null;
  poll(text: string | null): Notice | null {
    const next = statusChange(this.last, text);
    if (next === null) return null;
    this.last = next;
    return noticeOf(next);
  }
}

/** Shows a notice in the TUI part when one is attached. With none, or when the send fails, the fallback gets the text instead. */
export async function deliver(n: Notice, emit: ((n: Notice) => Promise<void>) | undefined, fallback: (line: string) => void): Promise<void> {
  if (!emit) return fallback(n.message);
  try {
    await emit(n);
  } catch {
    fallback(n.message);
  }
}
