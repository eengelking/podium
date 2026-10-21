// The replay's rows (#353): what the stored entries of a recording become on the page. Pure, so the pairing and the wording are tested apart.
import type { RecordingRow } from "./types";

/** One row of the replay. A tool call carries its result when both are loaded. */
export interface ReplayItem {
  /** The server's order of the row (`n`), unique within a recording. */
  key: number;
  kind: "prompt" | "text" | "thinking" | "tool" | "result" | "decision" | "mark";
  row: RecordingRow;
  /** For a tool call: the result that answered it, when it is loaded. */
  result?: RecordingRow;
  /** A failed call (its result says so), or a result of a call that failed. */
  failed: boolean;
  /** The words of a marked row. */
  mark?: string;
  /** Who a marked row is from: `Podium` for the server's own, otherwise the row's loop. */
  podium?: boolean;
  /** Who sent the row from Podium (a decision, a prompt, a /clear or a /compact), when the recording says. */
  by?: string;
  /** The words of a decision: what was done with the call it answers. */
  label?: string;
}

/** The characters after which a long text is collapsed behind a button. */
export const COLLAPSE_AT = 600;

/** What a marked row says. */
export function markWords(r: RecordingRow): string {
  switch (r.kind) {
    case "clear":
      return "The conversation was cleared. What follows starts from an empty context.";
    case "compact":
      return "The conversation was compacted to fit the context window.";
    case "decision":
      return decisionLabel(r);
    case "gap":
      return `${r.lost ?? 0} ${r.lost === 1 ? "entry was" : "entries were"} lost: the machine could not reach the server for a while.`;
    case "limit":
      return r.text ? `${r.text} Nothing after this point was kept.` : "The recording stopped at its limit. Nothing after this point was kept.";
    case "stopped":
      return `Recording stopped${r.by ? ` by ${r.by}` : ""}. Everything up to here was kept.`;
    default:
      return r.text || "Something happened here.";
  }
}

/** What an answer or approval sent from Podium did: "Answered a question", "Sent a plan back", "Denied a tool". */
export function decisionLabel(r: RecordingRow): string {
  if (r.name === "question") return "Answered a question";
  if (r.name === "plan") return r.failed ? "Sent a plan back" : "Approved a plan";
  if (r.name === "permission") return r.failed ? "Denied a tool" : "Allowed a tool once";
  return "Answered from Podium";
}

/**
 * The rows in the server's order, a result placed under the call it answers. A result names its call by `callSeq`, the `seq` of a
 * `tool` row in the same loop, so overlapping calls get their own results. A result with no `callSeq` goes to the oldest call of
 * the same loop and tool still waiting for one. A result whose call is on an older page that is not loaded yet stands as a row.
 */
export function buildItems(rows: readonly RecordingRow[]): ReplayItem[] {
  const waiting = new Map<string, ReplayItem[]>();
  const bySeq = new Map<string, ReplayItem>();
  const items: ReplayItem[] = [];
  for (const row of rows) {
    if (row.kind === "tool") {
      const item: ReplayItem = { key: row.n, kind: "tool", row, failed: false };
      const k = JSON.stringify([row.loop, row.name ?? ""]);
      waiting.set(k, [...(waiting.get(k) ?? []), item]);
      bySeq.set(JSON.stringify([row.loop, row.seq]), item);
      items.push(item);
    } else if (row.kind === "result") {
      const k = JSON.stringify([row.loop, row.name ?? ""]);
      let call: ReplayItem | undefined;
      if (row.callSeq === undefined) call = waiting.get(k)?.shift();
      else {
        call = bySeq.get(JSON.stringify([row.loop, row.callSeq]));
        if (call && !call.result) waiting.set(k, (waiting.get(k) ?? []).filter((w) => w !== call));
        else call = undefined;
      }
      if (call) {
        call.result = row;
        call.failed = row.failed === true;
      } else items.push({ key: row.n, kind: "result", row, failed: row.failed === true });
    } else if (row.kind === "decision") {
      items.push({ key: row.n, kind: "decision", row, failed: row.failed === true, label: decisionLabel(row), by: row.by ?? "" });
    } else if (row.kind === "prompt" || row.kind === "text") {
      items.push({ key: row.n, kind: row.kind, row, failed: false, ...(row.kind === "prompt" && row.by ? { by: row.by } : {}) });
    } else if (row.kind === "thinking") {
      items.push({ key: row.n, kind: "thinking", row, failed: false });
    } else {
      items.push({ key: row.n, kind: "mark", row, failed: false, mark: markWords(row), podium: row.kind === "stopped" || row.kind === "limit", ...(row.by && (row.kind === "clear" || row.kind === "compact") ? { by: row.by } : {}) });
    }
  }
  return items;
}

/** The first line of a text, cut to `max` characters, and whether anything was left out. */
export function firstLine(text: string, max = 200): { line: string; more: boolean } {
  const nl = text.indexOf("\n");
  const head = nl < 0 ? text : text.slice(0, nl);
  const line = head.length > max ? head.slice(0, max) : head;
  return { line, more: line.length < text.length };
}

/** The last `n` lines of an output, for the failure box. */
export function tailLines(text: string, n = 12): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

/** The index of the next failed item after `from`, wrapping round; -1 when none failed. */
export function nextFailure(items: readonly ReplayItem[], from: number): number {
  for (let i = 1; i <= items.length; i++) {
    const k = (from + i) % items.length;
    if (items[k]!.failed) return k;
  }
  return -1;
}
