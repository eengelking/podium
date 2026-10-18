// Turns the unified diff the server returns (SPEC 6.4, "File diff", #319) into rows the modal draws. Pure, so the modal
// only places text nodes: nothing here builds markup from a diff line.

export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "ctx"; old: number; now: number; text: string }
  | { kind: "del"; old: number; text: string }
  | { kind: "add"; now: number; text: string }
  | { kind: "note"; text: string };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses the hunks of a unified diff. The text the mod sends starts at the first hunk; any file header before one is dropped. */
export function parseDiff(diff: string): DiffRow[] {
  if (!diff) return [];
  const rows: DiffRow[] = [];
  let old = 0;
  let now = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const h = HUNK.exec(line);
    if (h) {
      old = Number(h[1]);
      now = Number(h[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) continue;
    const mark = line[0];
    const body = line.slice(1);
    if (mark === "-") rows.push({ kind: "del", old: old++, text: body });
    else if (mark === "+") rows.push({ kind: "add", now: now++, text: body });
    else if (mark === "\\") rows.push({ kind: "note", text: line.slice(2) });
    else rows.push({ kind: "ctx", old: old++, now: now++, text: mark === " " ? body : line });
  }
  return rows;
}

const MARK = "[redacted]";

/** A line split around each `[redacted]` the mod put in, so the modal can mark it. */
export function splitRedacted(line: string): { text: string; redacted: boolean }[] {
  if (!line) return [];
  const out: { text: string; redacted: boolean }[] = [];
  let at = 0;
  for (let i = line.indexOf(MARK); i >= 0; i = line.indexOf(MARK, at)) {
    if (i > at) out.push({ text: line.slice(at, i), redacted: false });
    out.push({ text: MARK, redacted: true });
    at = i + MARK.length;
  }
  if (at < line.length) out.push({ text: line.slice(at), redacted: false });
  return out;
}

/** One cell of a side-by-side pane. `fill` holds the place of a line the other side has; `hunk-fill` sits across from a hunk header. */
export interface SideCell {
  kind: "hunk" | "hunk-fill" | "ctx" | "del" | "add" | "fill" | "note";
  no?: number;
  text: string;
}

/**
 * The two panes of a side-by-side diff, level line for line: old on the left, new on the right. A run of removed lines
 * is paired with the added lines that follow it; the shorter side is filled out. Both arrays always have the same length.
 */
export function sideBySide(rows: DiffRow[]): { left: SideCell[]; right: SideCell[] } {
  const left: SideCell[] = [];
  const right: SideCell[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.kind === "hunk") {
      left.push({ kind: "hunk", text: r.text });
      right.push({ kind: "hunk-fill", text: "" });
    } else if (r.kind === "ctx") {
      left.push({ kind: "ctx", no: r.old, text: r.text });
      right.push({ kind: "ctx", no: r.now, text: r.text });
    } else if (r.kind === "note") {
      left.push({ kind: "note", text: r.text });
      right.push({ kind: "note", text: r.text });
    } else {
      const dels: Extract<DiffRow, { kind: "del" }>[] = [];
      const adds: Extract<DiffRow, { kind: "add" }>[] = [];
      for (; i < rows.length && rows[i]!.kind === "del"; i++) dels.push(rows[i] as Extract<DiffRow, { kind: "del" }>);
      for (; i < rows.length && rows[i]!.kind === "add"; i++) adds.push(rows[i] as Extract<DiffRow, { kind: "add" }>);
      i--;
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const d = dels[k];
        const a = adds[k];
        left.push(d ? { kind: "del", no: d.old, text: d.text } : { kind: "fill", text: "" });
        right.push(a ? { kind: "add", no: a.now, text: a.text } : { kind: "fill", text: "" });
      }
    }
  }
  return { left, right };
}
