// What a Bash entry in the activity feed carries beyond its summary (#431, SPEC 6.4): the whole command and, when asked for, what
// the call printed. Pure: no `$` here. Redaction is `redactBounded` from recording.ts, the one path a recording and a diff use.
import { activityCall, parseExitCode } from '../../core/failures.ts';
import { commandDetail, outputDetail } from '../../core/feed.ts';
import type { ActivityEntry } from '../../core/protocol.ts';
// The limits and the text clean-up moved to core/feed.ts for the OpenCode reporter (#969); they are still exported from here.
export { commandDetail, DETAIL_CHARS_PER_REPORT, DETAIL_LIMIT, outputDetail, stripControl, type Detail } from '../../core/feed.ts';

/** The first line of a failed Bash call's text, with its line break (or alone, when nothing was printed). */
const EXIT_LINE = /^Exit code -?\d{1,3}(?:\n|$)/;
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

