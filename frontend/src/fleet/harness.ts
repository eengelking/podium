// What the console knows about each harness (#853). The map is keyed by the `harness` id a session carries, and lives here because
// it is about how the console draws a session, not about what a reporter sends. A harness with no entry is drawn with its id and a
// plain square, and every field is shown, since nothing says it cannot report one.

import type { Capabilities } from "../../../plugin/core/protocol";

export type HarnessShape = "square" | "diamond";

export interface HarnessDisplay {
  id: string;
  /** The name on the badge. */
  name: string;
  /** The badge's mark. A shape and the name, never a color. */
  shape: HarnessShape;
  /** The tool name the harness gives its shell tool, drawn as a command; null when it is not known. */
  shell: string | null;
  /** Whether the harness marks a recommended option by ending its label with "(Recommended)". */
  recommendedMark: boolean;
  /** Whether it reports how full the context window is. When false the Context cell is absent, not zero. */
  context: boolean;
  /** Whether it reports an effort level. When false the effort meter is absent. */
  effort: boolean;
}

/** The harness of a session from before the harness was stored. */
export const DEFAULT_HARNESS = "claude-code";

const KNOWN: Readonly<Record<string, Omit<HarnessDisplay, "id">>> = {
  "claude-code": { name: "Claude Code", shape: "square", shell: "Bash", recommendedMark: true, context: true, effort: true },
  opencode: { name: "OpenCode", shape: "diamond", shell: "shell", recommendedMark: false, context: false, effort: false },
};

/** How to draw a session from `harness`; a missing or empty id is Claude Code's, the way the server reads it. */
export function harnessOf(harness: string | null | undefined): HarnessDisplay {
  const id = harness || DEFAULT_HARNESS;
  if (Object.hasOwn(KNOWN, id)) return { id, ...KNOWN[id]! };
  return { id, name: id, shape: "square", shell: null, recommendedMark: false, context: true, effort: true };
}

/**
 * How to draw a session: what its harness declared (#940) wins over the table above, field by field, and the table answers only for a field the
 * session does not declare. A session with nothing declared (Claude Code's, a v1 report, one stored before this) is drawn from the table alone.
 */
export function harnessOfSession(s: { harness?: string | null; capabilities?: Capabilities | null }): HarnessDisplay {
  const base = harnessOf(s.harness);
  const declared = s.capabilities;
  if (!declared) return base;
  return { ...base, context: declared.context ?? base.context, effort: declared.effort ?? base.effort };
}

/** The name of the harness's shell tool; null when Podium does not know it. */
export const shellToolOf = (harness: string | null | undefined): string | null => harnessOf(harness).shell;

/** Whether `tool` is the harness's shell tool, which the console draws as the command it runs. */
export const isShellTool = (harness: string | null | undefined, tool: string | null | undefined): boolean => {
  const shell = shellToolOf(harness);
  return shell !== null && tool === shell;
};

/** Whether the harness ends a recommended option's label with "(Recommended)", which the console shows as a tag instead. */
export const recommendedMark = (harness: string | null | undefined): boolean => harnessOf(harness).recommendedMark;

/** Whether the sessions come from more than one harness. The badge is drawn only then, so a wall of one harness looks as it always did. */
export function mixedHarnesses(sessions: ReadonlyArray<{ harness?: string | null }>): boolean {
  return new Set(sessions.map((s) => s.harness || DEFAULT_HARNESS)).size > 1;
}
