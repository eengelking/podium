// A loop's background shells and monitors as a report carries them (#897). Pure apart from `readTail`, and the same for every harness: the Claude
// Code and the OpenCode reporter each find their own items and their output files, and send them through here, so the limits, the redaction, the
// wording of a cut and the rule for which files may be read cannot differ between them. See docs/decisions/ (the entry for #897).
import { redactBounded } from './diffRedact.ts';
import { stripControl } from './feed.ts';
import { cap, clip } from './failures.ts';
import type { BackgroundItem, BackgroundItemKind, Report } from './protocol.ts';

/** Characters of a command or of an output sent, before the cut-off marker, as the activity feed's. */
export const BACKGROUND_DETAIL_LIMIT = 20_000;
/** Bytes read from the end of an output file, so a huge file costs bounded work; the cut at BACKGROUND_DETAIL_LIMIT comes after redaction. */
export const BACKGROUND_TAIL_BYTES = 100_000;
/** Finished items a loop keeps; every running item is kept as well. */
export const BACKGROUND_KEPT_FINISHED = 20;
/** Items a loop sends at most, the server's `LIMITS.backgroundItems`. */
export const BACKGROUND_MAX_ITEMS = 60;
/** The longest label (the command's first word) an item carries, the server's `LIMITS.backgroundLabel`. */
export const BACKGROUND_LABEL = 80;
/** Characters of commands and output over one report, the server's `LIMITS.backgroundDetailChars`. */
export const BACKGROUND_DETAIL_CHARS_PER_REPORT = 200_000;
/** An id is an identifier, not free text: cut at the server's limit. */
const ID_MAX = 200;

/** Said at the start of an output that began before what is shown: the newest text is kept, so the cut is at the front. */
export const BACKGROUND_CUT_MARKER = '[older output cut off, newest 20,000 characters shown]\n';
/** Said at the end of a command that is longer than the limit. */
export const BACKGROUND_COMMAND_CUT_MARKER = '\n\n[cut off at 20,000 characters]';

/** What a harness found about one background item, before anything is redacted or cut. */
export interface RawBackgroundItem {
  id: string;
  kind: BackgroundItemKind;
  state: 'running' | 'exited';
  exitCode?: number;
  startedAt: number;
  /** False when `startedAt` is the time the reporter first saw the item, because the harness reports no start time. */
  startedKnown: boolean;
  lastOutputAt?: number;
  /** When the item ended, as the reporter learned it; only meaningful for an exited item. */
  endedAt?: number;
  /** The whole command as the harness has it. */
  command?: string;
  /** The text of the output file's tail, and whether the file held more before it. Present only when the output was read. */
  output?: string;
  outputCutAtStart?: boolean;
}

/** The first word of a command that is not a NAME=value assignment, so an inline secret (API_KEY=...) is never the label. Redacted and cut. */
export function labelOf(command: string | undefined, kind: BackgroundItemKind): string {
  // Leading NAME=value assignments go whole, a quoted value with spaces included, so no part of an inline secret is left to be the label.
  const rest = (command ?? '').trim().replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  const word = rest.split(/\s+/).find((w) => w !== '' && !w.includes('='))?.split('/').pop() ?? '';
  return clip(redactBounded(stripControl(word)).text, BACKGROUND_LABEL) || kind;
}

/** Control characters out, redacted, cut at the limit with the visible marker at the end (a command is read from its start). */
function commandText(raw: string): { text: string; cut: boolean } {
  const clean = redactBounded(stripControl(raw.length > BACKGROUND_TAIL_BYTES ? raw.slice(0, BACKGROUND_TAIL_BYTES) : raw)).text;
  return clean.length > BACKGROUND_DETAIL_LIMIT ? { text: clean.slice(0, BACKGROUND_DETAIL_LIMIT) + BACKGROUND_COMMAND_CUT_MARKER, cut: true } : { text: clean, cut: false };
}

/** Control characters out, redacted, then cut from the front at the limit: an output's newest lines are the ones a person wants. */
function outputText(raw: string, cutAtStart: boolean): { text: string; cut: boolean } {
  const clean = redactBounded(stripControl(raw)).text;
  if (clean.length > BACKGROUND_DETAIL_LIMIT) return { text: BACKGROUND_CUT_MARKER + clean.slice(clean.length - BACKGROUND_DETAIL_LIMIT), cut: true };
  return cutAtStart ? { text: BACKGROUND_CUT_MARKER + clean, cut: true } : { text: clean, cut: false };
}

/**
 * One item as the report carries it. The label (the command's first word) always goes; the whole command and the output go only with
 * `withDetail`, which a caller sets when the `backgroundOutput` option is on and the loop is in `watchBackground`.
 */
export function backgroundItem(raw: RawBackgroundItem, withDetail: boolean): BackgroundItem {
  const item: BackgroundItem = {
    id: cap(raw.id, ID_MAX),
    kind: raw.kind,
    state: raw.state,
    startedAt: Math.round(raw.startedAt),
    startedKnown: raw.startedKnown,
    label: labelOf(raw.command, raw.kind),
  };
  if (raw.state === 'exited' && typeof raw.exitCode === 'number' && Number.isInteger(raw.exitCode)) item.exitCode = raw.exitCode;
  if (typeof raw.lastOutputAt === 'number') item.lastOutputAt = Math.round(raw.lastOutputAt);
  if (raw.state === 'exited' && typeof raw.endedAt === 'number') item.endedAt = Math.round(raw.endedAt);
  if (!withDetail) return item;
  if (raw.command !== undefined) {
    const c = commandText(raw.command);
    item.command = c.text;
    if (c.cut) item.commandCut = true;
  }
  if (raw.output !== undefined) {
    const o = outputText(raw.output, raw.outputCutAtStart === true);
    item.output = o.text;
    if (o.cut) item.outputCut = true;
  }
  return item;
}

/**
 * The items a loop keeps: every running item, and the latest finished ones, oldest first as the feed is. An item that ended is dropped
 * once more than BACKGROUND_KEPT_FINISHED have ended after it, and the list never passes the server's limit.
 */
export function keepBackground(items: readonly BackgroundItem[]): BackgroundItem[] {
  const byTime = (a: BackgroundItem, b: BackgroundItem) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);
  const finished = items.filter((i) => i.state === 'exited').sort(byTime);
  const dropped = new Set(finished.slice(0, Math.max(0, finished.length - BACKGROUND_KEPT_FINISHED)));
  const kept = items.filter((i) => !dropped.has(i)).sort(byTime);
  return kept.length > BACKGROUND_MAX_ITEMS ? kept.slice(kept.length - BACKGROUND_MAX_ITEMS) : kept;
}

const DETAIL_FIELDS = ['command', 'commandCut', 'output', 'outputCut'] as const;
const OUTPUT_ONLY_FIELDS = ['output', 'outputCut'] as const;
const detailChars = (i: BackgroundItem): number => (i.command?.length ?? 0) + (i.output?.length ?? 0);

/**
 * Keeps commands and output within the report's own 200,000 characters, the orchestrator's items first and each loop from its newest item
 * back, as the server counts them. An item that does not fit loses its output, then its command, and keeps its state and times.
 */
export function withinBackgroundBudget(r: Report): Report {
  let room = BACKGROUND_DETAIL_CHARS_PER_REPORT;
  const trim = (list: BackgroundItem[]) => {
    for (let n = list.length - 1; n >= 0; n--) {
      const i = list[n]!;
      if (detailChars(i) <= room) {
        room -= detailChars(i);
        continue;
      }
      for (const k of OUTPUT_ONLY_FIELDS) delete i[k];
      if (detailChars(i) <= room) room -= detailChars(i);
      else for (const k of DETAIL_FIELDS) delete i[k];
    }
  };
  if (r.session.backgroundItems) trim(r.session.backgroundItems);
  for (const a of r.agents) if (a.backgroundItems) trim(a.backgroundItems);
  return r;
}

// ---- reading an output file ------------------------------------------------------------------------------------------------------

/** What a host's file system says about a path (the shape of Claude Code's `$.fs.stat`, which OpenCode's Node adapter matches). */
export interface OutputStat {
  /** What the path leads to: a link is followed. */
  kind: 'file' | 'dir' | 'other';
  size: number;
  mtimeMs: number;
  /** The path itself is a symbolic link. */
  isLink: boolean;
  /** Where the path lands, when asked with `resolve`. */
  realPath?: string;
}

/** The file system a harness gives `readTail`. Every call may reject (a missing file, a refusal); core turns that into a result. */
export interface OutputFs {
  /** Rejects when the path is missing. With `resolve`, answers `realPath` as well. */
  stat(path: string, options?: { resolve?: boolean }): Promise<OutputStat>;
  /** The whole file as text; rejects over the host's own limit (Claude Code: 4 MiB). */
  read(path: string): Promise<string>;
  /** The last `bytes` of a file as text, for a host that can read part of a file (Node can; Claude Code's sandbox cannot). */
  tail?(path: string, bytes: number): Promise<string>;
}

/** Why an output file was not read. `too-large` is a file past what the host reads whole and cannot be read in part. */
export type NotRead = 'missing' | 'outside' | 'not-a-file' | 'too-large' | 'unreadable';

/** The result of reading the tail of an output file the harness named. */
export type TailRead =
  | { ok: true; text: string; cutAtStart: boolean; mtimeMs: number; size: number }
  | { ok: false; reason: NotRead };

/** The most a host without partial reads is asked to read whole: Claude Code's `$.fs.read` rejects over 4 MiB. */
export const WHOLE_FILE_MAX_BYTES = 4 * 1024 * 1024;

/** `p` without the path separators at its end. A loop, not a regex, so a long run of separators cannot make it slow. */
function trimEnd(p: string): string {
  let end = p.length;
  while (end > 0 && (p[end - 1] === '/' || p[end - 1] === '\\')) end--;
  return p.slice(0, end);
}
const sepOf = (p: string): string => (p.includes('\\') && !p.includes('/') ? '\\' : '/');

type Checked = { ok: true; real: string; stat: OutputStat } | { ok: false; reason: NotRead };

const missing = (err: unknown): boolean => /ENOENT|not found|no such file|missing/i.test(String((err as { code?: unknown; message?: unknown })?.code ?? '') + String((err as { message?: unknown })?.message ?? ''));

/** The real path of `file`, but only when it is a regular file (not a link) inside `dir`; otherwise why not. */
async function checked(fs: OutputFs, file: string, dir: string): Promise<Checked> {
  try {
    const own = await fs.stat(file, { resolve: true });
    if (own.isLink || own.kind !== 'file' || !own.realPath) return { ok: false, reason: 'not-a-file' };
    const folder = await fs.stat(dir, { resolve: true });
    if (folder.kind !== 'dir' || !folder.realPath) return { ok: false, reason: 'outside' };
    const root = trimEnd(folder.realPath);
    if (!own.realPath.startsWith(root + sepOf(root)) || own.realPath.slice(root.length + 1).split(/[\\/]/).includes('..')) return { ok: false, reason: 'outside' };
    return { ok: true, real: own.realPath, stat: own };
  } catch (err) {
    return { ok: false, reason: missing(err) ? 'missing' : 'unreadable' };
  }
}

/**
 * Reads the last BACKGROUND_TAIL_BYTES of `file`, but only when it is a regular file inside `dir`, the folder the harness reports its output
 * files in. A path is never taken from message text: a caller passes the path the harness itself reported (OpenCode's `info.file`, Claude
 * Code's `tasks/<id>.output` beside its scratchpad). A link is refused whether it points out of the folder or not, because a Claude Code
 * subagent's `.output` links to its transcript, not to shell output. A missing, moved or unreadable file is a result, never a throw.
 */
export async function readTail(fs: OutputFs, file: string, dir: string): Promise<TailRead> {
  const c = await checked(fs, file, dir);
  if (!c.ok) return c;
  const { size, mtimeMs } = c.stat;
  try {
    let text: string;
    let cutAtStart = false;
    if (fs.tail) {
      text = size > 0 ? await fs.tail(c.real, BACKGROUND_TAIL_BYTES) : '';
      cutAtStart = size > BACKGROUND_TAIL_BYTES;
    } else {
      if (size > WHOLE_FILE_MAX_BYTES) return { ok: false, reason: 'too-large' };
      const whole = size > 0 ? await fs.read(c.real) : '';
      cutAtStart = whole.length > BACKGROUND_TAIL_BYTES;
      text = cutAtStart ? whole.slice(whole.length - BACKGROUND_TAIL_BYTES) : whole;
    }
    // A read that starts inside a multi-byte character begins with a broken one; that is not text.
    if (cutAtStart) text = text.replace(/^\uFFFD+/, '');
    return { ok: true, text, cutAtStart, mtimeMs, size };
  } catch (err) {
    return { ok: false, reason: missing(err) ? 'missing' : 'unreadable' };
  }
}

/**
 * When the output file last changed, and how big it is, under the same rules as `readTail` but without reading a byte of it: what the list
 * shows ("last output 4 s ago") needs only this, so it needs no consent for the output itself.
 */
export async function outputTimes(fs: OutputFs, file: string, dir: string): Promise<{ ok: true; mtimeMs: number; size: number } | { ok: false; reason: NotRead }> {
  const c = await checked(fs, file, dir);
  return c.ok ? { ok: true, mtimeMs: c.stat.mtimeMs, size: c.stat.size } : c;
}

/** The output without the `[exited with code N]` line Claude Code's file ends with: the exit is shown as a status, not as part of what the shell printed. */
export function withoutExitLine(text: string): string {
  // Walks back from the end in one pass each (whitespace, `]`, digits, `-`, the marker, line breaks), so no input can make it slow.
  const marker = '[exited with code ';
  let end = text.length;
  while (end > 0 && /\s/.test(text.charAt(end - 1))) end--;
  if (text.charAt(end - 1) !== ']') return text;
  let at = end - 1;
  const digitsEnd = at;
  while (at > 0 && text.charAt(at - 1) >= '0' && text.charAt(at - 1) <= '9') at--;
  if (at === digitsEnd) return text;
  if (text.charAt(at - 1) === '-') at--;
  if (at < marker.length || text.slice(at - marker.length, at) !== marker) return text;
  at -= marker.length;
  while (at > 0 && text.charAt(at - 1) === '\n') at--;
  return text.slice(0, at) + (text.endsWith('\n') ? '\n' : '');
}

/** The exit code a Claude Code output file ends with (`[exited with code N]`); null when the file does not end that way. */
export function exitCodeOf(text: string): number | null {
  const m = /\[exited with code (-?\d+)\]\s*$/.exec(text);
  return m ? Number(m[1]) : null;
}
