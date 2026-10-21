// What a Bash entry in the activity feed carries beyond its summary (#431, SPEC 6.4): the whole command and, when asked for, what
// the call printed. Pure: no `$` here. Redaction is `redactBounded` from recording.ts, the one path a recording and a diff use.
import { redactBounded } from './recording.ts';
import { activityCall, CUT_MARKER, parseExitCode } from './failures.ts';
import type { ActivityEntry } from './protocol.ts';

/** Characters of a command or of an output sent, before the cut-off marker. */
export const DETAIL_LIMIT = 20_000;
/** Raw characters read before redaction, so a huge output costs bounded work; the cut at DETAIL_LIMIT comes after redaction. */
const RAW_LIMIT = 100_000;
/** Characters of commands and output over one report (the server's `activityDetailChars`), apart from the 60,000 of summaries. */
export const DETAIL_CHARS_PER_REPORT = 200_000;

/** The first line of a failed Bash call's text, with its line break (or alone, when nothing was printed). */
const EXIT_LINE = /^Exit code -?\d{1,3}(?:\n|$)/;

const ESC = 0x1b;
const BEL = 0x07;

/** Index just past the escape sequence that starts at `i` (a code point 0x1b), or `text.length` when it never ends. */
function sequenceEnd(text: string, i: number): number {
  const kind = text.charAt(i + 1);
  if (kind === '[') {
    // CSI: parameters and intermediates, then one final byte 0x40-0x7e.
    for (let j = i + 2; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j + 1;
    }
    return text.length;
  }
  if (kind === ']' || kind === 'P' || kind === '_' || kind === '^' || kind === 'X') {
    // OSC, DCS, APC, PM, SOS: a string ended by BEL or ESC backslash.
    for (let j = i + 2; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (c === BEL) return j + 1;
      if (c === ESC && text.charAt(j + 1) === '\\') return j + 2;
    }
    return text.length;
  }
  return Math.min(text.length, i + 2);
}

/**
 * The text without ANSI escape sequences or other control characters. Line breaks and tabs stay, `\r\n` becomes `\n` and a lone
 * `\r` (a progress bar's redraw) goes. The text is data, never markup, but a terminal's codes are noise in a row.
 */
export function stripControl(text: string): string {
  let out = '';
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if ((c >= 0x20 && c < 0x7f) || c > 0x9f || c === 0x0a || c === 0x09) {
      i++;
      continue;
    }
    out += text.slice(from, i);
    from = c === ESC ? sequenceEnd(text, i) : i + 1;
    i = from;
  }
  return from === 0 ? text : out + text.slice(from);
}

export interface Detail {
  text: string;
  cut: boolean;
}

/** Control characters out, redacted, cut at the limit with the visible marker. The text is not trimmed: a command's line breaks are its own. */
function detail(raw: string): Detail {
  const clean = redactBounded(stripControl(raw.length > RAW_LIMIT ? raw.slice(0, RAW_LIMIT) : raw)).text;
  return clean.length > DETAIL_LIMIT ? { text: clean.slice(0, DETAIL_LIMIT) + CUT_MARKER, cut: true } : { text: clean, cut: false };
}

/** A Bash call's whole command, as an entry carries it. */
export function commandDetail(command: string): Detail {
  return detail(command);
}

/** A Bash call's output, as an entry carries it. */
export function outputDetail(output: string): Detail {
  return detail(output);
}

/** What a `tool.call`'s `next(e)` resolves to, as far as an entry reads it. */
export interface BashResult {
  deny?: unknown;
  isError?: unknown;
  text?: unknown;
  result?: unknown;
}

/**
 * What a Bash call printed: stdout then stderr from the result record, in one string; else the text the model reads (an error's
 * result is that text); a denial prints its reason. Null when the result holds nothing to read. A result Claude Code replaced with
 * a `<persisted-output>` stub is that stub, read like any other text.
 */
export function bashOutput(res: BashResult): string | null {
  if (typeof res.deny === 'string') return res.deny;
  const r = res.result as { stdout?: unknown; stderr?: unknown } | string | undefined | null;
  if (r && typeof r === 'object' && (typeof r.stdout === 'string' || typeof r.stderr === 'string')) {
    const out = typeof r.stdout === 'string' ? r.stdout : '';
    const err = typeof r.stderr === 'string' ? r.stderr : '';
    return out && err && !out.endsWith('\n') ? `${out}\n${err}` : out + err;
  }
  const text = typeof res.text === 'string' ? res.text : typeof r === 'string' ? r : null;
  // A failed call's text starts with its own status line ("Exit code 1"); the entry shows the status apart from the output.
  return text !== null && res.isError === true ? text.replace(EXIT_LINE, '') : text;
}

/**
 * Whether the call failed and, only when its text says so ("Exit code 1"), its exit code. The tool's result types carry no
 * numeric exit code, so none is guessed: a failed call whose text names none has `failed` and no `exitCode`.
 */
export function exitStatus(res: BashResult): { failed: boolean; exitCode?: number } {
  const failed = typeof res.deny === 'string' || res.isError === true;
  if (!failed || typeof res.deny === 'string') return { failed };
  const text = typeof res.text === 'string' ? res.text : typeof res.result === 'string' ? res.result : null;
  const code = parseExitCode(text);
  return code === null ? { failed } : { failed, exitCode: code };
}

/**
 * The activity entry for a tool call that is about to run. A Bash call also carries its `id` and its whole command, so the same
 * entry can be sent again with the output once the call finishes.
 */
export function activityEntry(tool: string, input: Record<string, unknown>, id: string | undefined, at: number): ActivityEntry {
  const entry: ActivityEntry = { at, kind: 'tool', text: activityCall(tool, input) };
  if (tool !== 'Bash') return entry;
  if (id) entry.id = id;
  if (typeof input.command === 'string') {
    const c = commandDetail(input.command);
    entry.command = c.text;
    if (c.cut) entry.commandCut = true;
  }
  return entry;
}

/**
 * What a finished Bash call adds to its entry (#598): `done`, and `failed` and `exitCode` as the result says, always. The output
 * (see `bashOutput`) only when `withOutput`; then a result with nothing to read adds no output. Without it the result's text is
 * read for the exit line alone and none of it is kept.
 */
export function finishedCall(res: BashResult, withOutput: boolean): Partial<ActivityEntry> {
  const s = exitStatus(res);
  const status: Partial<ActivityEntry> = { done: true, ...(s.failed ? { failed: true } : {}), ...(s.exitCode === undefined ? {} : { exitCode: s.exitCode }) };
  const raw = withOutput ? bashOutput(res) : null;
  if (raw === null) return status;
  const o = outputDetail(raw);
  return { output: o.text, ...(o.cut ? { outputCut: true } : {}), ...status };
}
