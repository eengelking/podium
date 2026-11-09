// What the OpenCode reporter tells the person (#969): the transport's notices as console lines said once, the text of `/podium`, and the
// toast the TUI part shows when the connection changes. Pure; index.ts and tui.ts only carry the text to where it is shown.
import { connectionLine } from '../core/podiumCommand.ts';
import { podiumSays, SERVER_FLAG_OFF } from '../core/messagingStatus.ts';
import { ADMIN_NOTICE_TOAST_MS } from '../core/adminNotice.ts';
import type { NoticeEvent } from './bridge.ts';
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
  /** The commit of a dev build, or null/absent for a release (#987). */
  build?: string | null;
  /** How the reporter signs in: the reporter config file, and whether there is a plain token (#987). Never the token. */
  signIn: { configPath: string | null; tokenSet: boolean };
  /** Whether the person is signed in as someone: a reporter config file, or a user name with a token. Messaging needs it. */
  signedIn: boolean;
  /** The context that chose the reporter config file, or null. */
  context: string | null;
}

const connection = (online: boolean | null): string => (online === null ? 'not tried yet' : online ? 'online' : 'offline, retrying');

/** Why messaging is off, in the order the reporter can know it, in plain words; null when it is on. */
export function messagingOffReason(m: Summary['messaging'], signedIn: boolean): string | null {
  if (!m.option) return 'PODIUM_PEERS is off on this machine: turn it on in the environment or ~/.podium/config.env';
  if (!m.canPrompt) return 'this OpenCode cannot submit a prompt, so no message could enter a session';
  if (!signedIn) return "there is no per-person token with a user name, or reporter config file: messaging is only between one person's own reporters, so set both";
  if (!m.reported) return 'no session has reported yet: send it a prompt';
  if (!m.serverSays) return SERVER_FLAG_OFF;
  return null;
}

/** The `Messaging:` line of `/podium`: the verdict, then each fact behind it. */
export function messagingLine(m: Summary['messaging'], signedIn: boolean): string {
  const why = messagingOffReason(m, signedIn);
  const says = podiumSays(m.reported, m.serverSays);
  return `Messaging: ${why === null ? 'on' : `off, because ${why}`}. PODIUM_PEERS: ${m.option ? 'on' : 'off'}; Podium says: ${says}`;
}

/** The `/podium` answer: the same facts the Claude Code `/podium` gives that OpenCode has. */
export function podiumText(s: Summary, f: PodiumFacts): string {
  return [
    `Podium fleet console: ${withoutTrailingSlashes(f.serverUrl)}/#/`,
    f.tls ? `TLS: ${f.tls}` : '',
    f.context ? `Context: ${f.context} (${withoutTrailingSlashes(f.serverUrl)}). Switch it for the next session with /podium context use <name>.` : '',
    `Home folder: ${f.home}`,
    `Connection: ${connection(s.online)}${s.liveSessions === null ? '' : ` (${s.liveSessions} live sessions)`}`,
    `Versions: reporter ${f.version}${f.build ? ` · Dev: ${f.build}` : ''}${s.serverVersion ? `, server ${s.serverVersion}` : ''}`,
    ...s.notices,
    connectionLine(f.signIn),
    messagingLine(s.messaging, f.signedIn),
    `Reports sent: ${s.sent}, failed: ${s.failed}, rejected: ${s.rejected}; events queued: ${s.queued}${s.dropped ? `, dropped: ${s.dropped}` : ''}`,
    `Last error: ${s.lastError ?? 'none'}`,
    `Sessions: ${s.sessions}`,
    'Name this session: /podium name <text>. Contexts (which Podium server): /podium context',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The address without the slashes at its end. A loop, because a regular expression for this backtracks badly on a long run of slashes. */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/** The count of live sessions changes all the time and is no news. Drops the digits before the first ` live`; a loop for the same reason as above. */
function withoutCount(text: string): string {
  for (let at = text.indexOf(' live'); at !== -1; at = text.indexOf(' live', at + 1)) {
    let start = at;
    while (start > 0 && text.charCodeAt(start - 1) >= 48 && text.charCodeAt(start - 1) <= 57) start--;
    if (start < at) return text.slice(0, start) + text.slice(at + 1);
  }
  return text;
}

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

/**
 * The status line for the prompt's footer (#999): sent when the text changes and when a TUI part attaches, not on every flush. A status
 * that goes away is sent as an empty text, so the footer clears; a status that was never there is not sent at all.
 */
export class StatusRelay {
  private current = '';
  constructor(public send?: (s: { text: string }) => Promise<void>) {}
  push(text: string | null): void {
    const next = text ?? '';
    if (next === this.current) return;
    this.current = next;
    this.emit();
  }
  /** A TUI part attached: it gets the current text, when there is one. */
  attached(): void {
    if (this.current) this.emit();
  }
  private emit(): void {
    void this.send?.({ text: this.current }).catch(() => undefined);
  }
}

/** How long a toast that is not an Admin callout is taken to stay up, when it names no time (the host's own default is about this). */
export const OTHER_TOAST_MS = 5000;
const RESHOW_GAP_MS = 300;

/**
 * The TUI part's toasts. The host shows one toast at a time: a new one replaces the one up (found in a live run, where the connection's status toast, 14 ms behind
 * an Admin callout, replaced it). The Admin callout is the one thing the person must see (#1051), so any other toast is shown as it comes, and the callout is shown
 * again, for the time it has left, once the last of them has had its time.
 */
export class ToastKeeper {
  private readonly admin: { n: NoticeEvent; until: number }[] = [];
  private generation = 0;

  constructor(
    private readonly show: (n: NoticeEvent) => void,
    private readonly now: () => number,
    private readonly later: (ms: number, fn: () => void) => void,
  ) {}

  offer(n: NoticeEvent): void {
    const now = this.now();
    if (n.admin) {
      this.admin.push({ n, until: now + (n.duration ?? ADMIN_NOTICE_TOAST_MS) });
      this.generation++;
      this.show(n);
      return;
    }
    const mine = ++this.generation;
    this.show(n);
    if (!this.live(now)) return;
    this.later((n.duration ?? OTHER_TOAST_MS) + RESHOW_GAP_MS, () => {
      if (mine !== this.generation) return;
      const at = this.now();
      const up = this.live(at);
      if (up && up.until - at > 1000) this.show({ ...up.n, duration: up.until - at });
    });
  }

  /** The newest Admin toast with time left, or null. */
  private live(now: number): { n: NoticeEvent; until: number } | null {
    for (let i = this.admin.length - 1; i >= 0; i--) if (this.admin[i]!.until > now) return this.admin[i]!;
    this.admin.length = 0;
    return null;
  }
}

/** How many lines the board holds. */
const BOARD_LINES = 5;
/** How long a line stays on the board: twice the time the server hands a callout over, so it is there for as long as the reading is. */
export const BOARD_KEEP_MS = 10 * 60_000;

/**
 * The Admin callouts that stay in view (#1051). OpenCode has no transcript a plugin may write to without the model reading it, so a toast, which passes, is
 * backed by a board in the session screen that stays. Content-free lines, each once, oldest first.
 */
export class AdminBoard {
  private readonly rows = new Map<string, { text: string; at: number }>();

  constructor(
    private readonly keepMs = BOARD_KEEP_MS,
    private readonly max = BOARD_LINES,
  ) {}

  add(id: string, text: string, now: number): void {
    if (this.rows.has(id)) return;
    this.rows.set(id, { text, at: now });
    while (this.rows.size > this.max) this.rows.delete(this.rows.keys().next().value as string);
  }

  lines(now: number): string[] {
    for (const [id, r] of this.rows) if (now - r.at >= this.keepMs) this.rows.delete(id);
    return [...this.rows.values()].map((r) => r.text);
  }
}
