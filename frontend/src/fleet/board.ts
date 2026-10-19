// The kanban board (#346): every session's plan steps sorted into one column per state. Pure, so the page and its tests share it.
import { idleOnBackground, toolOfNote, waitLead } from "./waiting";
import type { PlanStep, SessionView } from "./types";

export type BoardColumn = "pending" | "active" | "review" | "blocked" | "done";

export const BOARD_COLUMNS: readonly { key: BoardColumn; label: string; hint: string }[] = [
  { key: "pending", label: "Pending", hint: "Not started" },
  { key: "active", label: "In progress", hint: "" },
  { key: "review", label: "Review", hint: "Waiting on a person" },
  { key: "blocked", label: "Blocked", hint: "Needs something" },
  { key: "done", label: "Done", hint: "Until its orchestrator finishes" },
];

export const EMPTY_COLUMN: Record<BoardColumn, string> = {
  pending: "Nothing waiting. Every step has started or finished.",
  active: "Nothing in progress. Sessions are idle or between steps.",
  review: "Nothing waiting on a person right now.",
  blocked: "No blocked steps. Claude Code marks a step blocked when it cannot proceed.",
  done: "Nothing done yet.",
};

/** Cards a column shows before it pages. */
export const CARDS_PER_PAGE = 25;

export interface BoardCard {
  /** Stable across updates, so a card can be followed from one column to another. */
  key: string;
  session: SessionView;
  step: PlanStep;
  column: BoardColumn;
  /** A card for the session itself, not for one of its steps: it waits on its person and has no step in progress to move to Review. */
  waiting?: boolean;
  /** Why a Review card waits: what the session needs from its person, and the question or tool when it says. */
  why?: { lead: string; detail: string | null };
}

/** Whether the session waits on its person, as the rail and the wall count it: a wait on background work is not one. */
function waitsOnPerson(s: SessionView): boolean {
  return s.status === "waiting" && !idleOnBackground(s);
}

/** Review holds an in-progress step while its session waits on its person; every other step sits in its own state's column. */
export function columnOf(s: SessionView, step: PlanStep): BoardColumn {
  return step.state === "active" && waitsOnPerson(s) ? "review" : step.state;
}

const WAIT_NOTE_LIMIT = 160;
const QUESTION = /"question"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/** What a session that waits on its person needs, in the card's words: the lead, plus the question it asks, the tool it wants to use, or the message it sent. */
export function waitWhy(s: Pick<SessionView, "waitReason" | "waitNote">): { lead: string; detail: string | null } {
  const note = s.waitNote?.trim() ?? "";
  const tool = toolOfNote(note, s.waitReason);
  const lead = waitLead(s.waitReason, tool).replace(/\.$/, "");
  const q = QUESTION.exec(note);
  if (q) {
    try {
      return { lead, detail: JSON.parse(`"${q[1]}"`) as string };
    } catch {
      // A clipped escape: fall through to the tool's name.
    }
  }
  if (tool) return { lead, detail: `Tool: ${tool}` };
  // A message is shown only if it arrived whole; a clipped one would read as the full prompt.
  return { lead, detail: note && (s.waitNote?.length ?? 0) < WAIT_NOTE_LIMIT ? note : null };
}

const waitingStep = (text: string): PlanStep => ({ id: "waiting", text, state: "active", activeText: null, ownerAgentId: null, ownerLabel: null });

/** A plan with every step done on a session that is no longer running or waiting: its Done cards leave the board. */
export function sessionFinished(s: SessionView): boolean {
  const steps = s.plan?.steps;
  return !!steps?.length && steps.every((x) => x.state === "done") && (s.status === "stale" || s.status === "done");
}

export interface Board {
  columns: Record<BoardColumn, BoardCard[]>;
  /** Sessions with no plan, an empty one, or a finished one, and (except on the Plans view) not waiting on a person: on the board's page, but with nothing to put in a column. */
  withoutSteps: SessionView[];
}

/** `plansOnly` is the Plans view (#443): a session with no steps gets no card in any column, so a planless session that asks its person something shows only on All. */
export function buildBoard(sessions: readonly SessionView[], plansOnly = false): Board {
  const columns: Record<BoardColumn, BoardCard[]> = { pending: [], active: [], review: [], blocked: [], done: [] };
  const withoutSteps: SessionView[] = [];
  for (const s of sessions) {
    const steps = s.plan?.steps.length && !sessionFinished(s) ? s.plan.steps : [];
    const why = waitsOnPerson(s) ? waitWhy(s) : undefined;
    for (const step of steps) {
      const column = columnOf(s, step);
      columns[column].push({ key: `${s.id}:${step.id}`, session: s, step, column, ...(column === "review" ? { why } : {}) });
    }
    // A session that asks its person something belongs in Review whether or not it has a plan, except on the Plans view; with an in-progress step, that step is the card.
    const asking = waitsOnPerson(s) && !steps.some((x) => columnOf(s, x) === "review");
    if (asking && why && !(plansOnly && !steps.length)) columns.review.push({ key: `${s.id}:waiting`, session: s, step: waitingStep(why.lead), column: "review", waiting: true, why });
    if (!steps.length && !(asking && !plansOnly)) withoutSteps.push(s);
  }
  return { columns, withoutSteps };
}

/** What the plan tiles state (#426): sessions with a plan on the board, the steps in those plans, and how many of them are done. A no-plan session waiting on its person has a Review card but no plan, so it is not counted. */
export interface PlanFigures {
  orchestrators: number;
  steps: number;
  done: number;
}

export function planFigures(board: Board): PlanFigures {
  const steps = BOARD_COLUMNS.flatMap((c) => board.columns[c.key]).filter((c) => !c.waiting);
  return { orchestrators: new Set(steps.map((c) => c.session.id)).size, steps: steps.length, done: steps.filter((c) => c.column === "done").length };
}

/** The step that changed last first; steps that have not changed since the page opened keep their order. */
export function orderCards(cards: readonly BoardCard[], changedAt: ReadonlyMap<string, number>): BoardCard[] {
  return cards.map((c, i) => ({ c, i })).sort((a, b) => (changedAt.get(b.c.key) ?? 0) - (changedAt.get(a.c.key) ?? 0) || a.i - b.i).map((x) => x.c);
}

/** Cards of one session next to each other, sessions in the order their first card appears; each session keeps its cards' order. */
export function groupBySession(cards: readonly BoardCard[]): BoardCard[] {
  const by = new Map<string, BoardCard[]>();
  for (const c of cards) {
    const list = by.get(c.session.id);
    if (list) list.push(c);
    else by.set(c.session.id, [c]);
  }
  return [...by.values()].flat();
}
