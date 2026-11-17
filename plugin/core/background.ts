// A loop's background shells and monitors as a report carries them (#897). Pure apart from `readTail`, and the same for every harness: the Claude
// Code and the OpenCode reporter each find their own items and their output files, and send them through here, so the limits, the redaction, the
// wording of a cut and the rule for which files may be read cannot differ between them. See docs/decisions/ (the entry for #897).
import { open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
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
  /** The whole command as the harness has it. */
  command?: string;
  /** The text of the output file's tail, and whether the file held more before it. Present only when the output was read. */
  output?: string;
  outputCutAtStart?: boolean;
}

/** The first word of a command that is not a NAME=value assignment, so an inline secret (API_KEY=...) is never the label. Redacted and cut. */
export function labelOf(command: string | undefined, kind: BackgroundItemKind): string {
  const word = (command ?? '').trim().split(/\s+/).find((w) => w !== '' && !w.includes('='))?.split('/').pop() ?? '';
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

/** The result of reading the tail of an output file the harness named. */
export type TailRead =
  | { ok: true; text: string; cutAtStart: boolean; mtimeMs: number; size: number }
  | { ok: false; reason: 'missing' | 'outside' | 'not-a-file' | 'unreadable' };

type Checked = { ok: true; real: string } | { ok: false; reason: 'missing' | 'outside' | 'not-a-file' | 'unreadable' };

/** The real path of `file`, but only when it is a regular file (not a link) inside `dir`; otherwise why not. */
async function checked(file: string, dir: string): Promise<Checked> {
  try {
    const link = await lstat(file);
    if (link.isSymbolicLink() || !link.isFile()) return { ok: false, reason: 'not-a-file' };
    const [real, root] = await Promise.all([realpath(file), realpath(dir)]);
    const rel = path.relative(root, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'outside' };
    return { ok: true, real };
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

/**
 * Reads the last BACKGROUND_TAIL_BYTES of `file`, but only when it is a regular file inside `dir`, the folder the harness reports its output
 * files in. A path is never taken from message text: a caller passes the path the harness itself reported (OpenCode's `info.file`, Claude
 * Code's `tasks/<id>.output` beside its scratchpad). A link is refused whether it points out of the folder or not, because a Claude Code
 * subagent's `.output` links to its transcript, not to shell output. A missing, moved or unreadable file is a result, never a throw.
 */
export async function readTail(file: string, dir: string): Promise<TailRead> {
  const c = await checked(file, dir);
  if (!c.ok) return c;
  try {
    const handle = await open(c.real, 'r');
    try {
      const { size, mtimeMs } = await handle.stat();
      const length = Math.min(size, BACKGROUND_TAIL_BYTES);
      const buf = Buffer.alloc(length);
      if (length > 0) await handle.read(buf, 0, length, size - length);
      let text = buf.toString('utf8');
      // The read may start inside a multi-byte character; that one broken character is not text.
      if (size > length) text = text.replace(/^\uFFFD+/, '');
      return { ok: true, text, cutAtStart: size > length, mtimeMs, size };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

/**
 * When the output file last changed, and how big it is, under the same rules as `readTail` but without reading a byte of it: what the list
 * shows ("last output 4 s ago") needs only this, so it needs no consent for the output itself.
 */
export async function outputTimes(file: string, dir: string): Promise<{ ok: true; mtimeMs: number; size: number } | { ok: false; reason: 'missing' | 'outside' | 'not-a-file' | 'unreadable' }> {
  const c = await checked(file, dir);
  if (!c.ok) return c;
  try {
    const st = await lstat(c.real);
    return { ok: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** The exit code a Claude Code output file ends with (`[exited with code N]`); null when the file does not end that way. */
export function exitCodeOf(text: string): number | null {
  const m = /\[exited with code (-?\d+)\]\s*$/.exec(text);
  return m ? Number(m[1]) : null;
}
