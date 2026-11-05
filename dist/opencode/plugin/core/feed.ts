// The activity feed and the full texts as a report carries them (#118, #431, #969). Pure, and the same for every harness: the Claude
// Code and the OpenCode reporter both capture entries their own way and send them through here, so the limits, the redaction and the
// budgets cannot differ between them. Moved out of the Claude Code reporter's `activityDetail.ts` and `report.ts`.
import { redactBounded } from './diffRedact.ts';
import { cap, clip, CUT_MARKER, LIMITS } from './failures.ts';
import { RECORDING_LIMITS, type ActivityEntry, type AgentReport, type Report } from './protocol.ts';
import { utf8Bytes } from './recording.ts';

/** Characters of a command or of an output sent, before the cut-off marker. */
export const DETAIL_LIMIT = 20_000;
/** Raw characters read before redaction, so a huge output costs bounded work; the cut at DETAIL_LIMIT comes after redaction. */
const RAW_LIMIT = 100_000;
/** Characters of commands and output over one report (the server's `activityDetailChars`), apart from the 60,000 of summaries. */
export const DETAIL_CHARS_PER_REPORT = 200_000;
/** Full prompt and answer characters in one report; the server accepts a 512 kB body. The rest goes in later reports. */
export const MAX_FULL_TEXT_PER_REPORT = 120_000;
/** Activity-feed characters in one report (#118), as the server takes them: the orchestrator's first, then the agents'. */
export const MAX_ACTIVITY_PER_REPORT = 60_000;
/** Activity entries a watched loop keeps (#118). */
export const ACTIVITY_KEPT = 20;

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

/** A shell call's whole command, as an entry carries it. */
export function commandDetail(command: string): Detail {
  return detail(command);
}

/** A shell call's output, as an entry carries it. */
export function outputDetail(output: string): Detail {
  return detail(output);
}

// ---- a feed as a report carries it ---------------------------------------------------------------

/** The most a command or an output may hold as the server takes it: the 20,000-character cut plus the marker. */
const DETAIL_MAX = 20_100;

/** A loop's feed as it is sent: every summary redacted and cut again here, like every other free-text field. A command and an output were redacted and cut when captured; here they are only held to the server's limit. */
export function feedOf(list: readonly ActivityEntry[], withOutput: boolean): ActivityEntry[] {
  return list.map((e) => {
    const out: ActivityEntry = { at: e.at, kind: e.kind, text: clip(e.text, LIMITS.activity) };
    if (e.kind !== 'tool') return out;
    if (e.id !== undefined) out.id = cap(e.id, 200);
    if (e.command !== undefined) {
      out.command = e.command.slice(0, DETAIL_MAX);
      if (e.commandCut) out.commandCut = true;
    }
    if (withOutput && e.output !== undefined) {
      out.output = e.output.slice(0, DETAIL_MAX);
      if (e.outputCut) out.outputCut = true;
    }
    // How the call ended is not output: it goes with the feed (#598).
    if (e.done) out.done = true;
    if (e.exitCode !== undefined) out.exitCode = e.exitCode;
    if (e.failed) out.failed = true;
    return out;
  });
}

/** Drops full texts past the per-report budget (oldest agents first kept); they are still unsent, so a later report carries them. */
export function withinTextBudget(reports: AgentReport[]): AgentReport[] {
  let left = MAX_FULL_TEXT_PER_REPORT;
  return reports.map((r) => {
    const { promptText, answerText, ...rest } = r;
    const out: AgentReport = rest;
    for (const [k, v] of [['promptText', promptText], ['answerText', answerText]] as const) {
      if (v === undefined) continue;
      if (v.length <= left || left === MAX_FULL_TEXT_PER_REPORT) {
        out[k] = v;
        left -= v.length;
      }
    }
    return out;
  });
}

/** Leaves out the feeds past the per-report budget, the orchestrator's first, then the agents' in order, as the server would. */
export function withinActivityBudget(r: Report): Report {
  let left = MAX_ACTIVITY_PER_REPORT;
  const fits = (list: ActivityEntry[]) => {
    const n = list.reduce((sum, e) => sum + e.text.length, 0);
    if (n > left) return false;
    left -= n;
    return true;
  };
  if (r.session.activity && !fits(r.session.activity)) delete r.session.activity;
  for (const a of r.agents) if (a.activity && !fits(a.activity)) delete a.activity;
  return r;
}

const OUTPUT_FIELDS = ['output', 'outputCut'] as const;
const COMMAND_FIELDS = ['command', 'commandCut'] as const;

/** The feeds of a report, the orchestrator's first, then each agent's in order, as the server reads them. */
function feeds(r: Report): ActivityEntry[][] {
  const lists: ActivityEntry[][] = [];
  if (r.session.activity) lists.push(r.session.activity);
  for (const a of r.agents) if (a.activity) lists.push(a.activity);
  return lists;
}

const detailChars = (e: ActivityEntry): number => (e.command?.length ?? 0) + (e.output?.length ?? 0);

/**
 * Keeps commands and output within the report's own 200,000 characters (#431), apart from the summaries' 60,000: in feed order and
 * newest entry first, as the server counts them. An entry that does not fit loses its output, and then its command, and keeps its summary.
 */
export function withinDetailBudget(r: Report): Report {
  let room = DETAIL_CHARS_PER_REPORT;
  for (const list of feeds(r)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      if (detailChars(e) <= room) {
        room -= detailChars(e);
        continue;
      }
      for (const k of OUTPUT_FIELDS) delete e[k];
      if (detailChars(e) <= room) room -= detailChars(e);
      else for (const k of COMMAND_FIELDS) delete e[k];
    }
  }
  return r;
}

/**
 * Keeps the serialized report under the server's 512 KB body, as a recording's request does (480,000 bytes): the character budget
 * does not see a multi-byte text. Output goes first, then commands, from the last loop's oldest entry back, until it fits.
 */
export function withinSize(r: Report): void {
  const lists = feeds(r);
  if (!lists.length || utf8Bytes(JSON.stringify(r)) <= RECORDING_LIMITS.bodyBytes) return;
  const order = lists.slice().reverse().flatMap((list) => list);
  for (const fields of [OUTPUT_FIELDS, COMMAND_FIELDS]) {
    for (const e of order) {
      if (!fields.some((k) => k in e)) continue;
      for (const k of fields) delete e[k];
      if (utf8Bytes(JSON.stringify(r)) <= RECORDING_LIMITS.bodyBytes) return;
    }
  }
}
