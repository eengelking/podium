import { describe, expect, it } from "vitest";
import { makeSession } from "./fixtures";
import { BOARD_COLUMNS, buildBoard, columnOf, groupBySession, orderCards, planFigures, sessionFinished, waitWhy } from "./board";
import type { PlanStep, RespondMe, SessionView } from "./types";

const step = (id: string, state: PlanStep["state"], over: Partial<PlanStep> = {}): PlanStep => ({ id, text: `step ${id}`, state, activeText: null, ownerAgentId: null, ownerLabel: null, ...over });
const withSteps = (over: Partial<SessionView>, ...steps: PlanStep[]) => makeSession({ ...over, plan: { title: "t", source: "TaskCreate", steps } });

describe("board columns", () => {
  it("are Pending, In progress, Review, Blocked and Done, in that order", () => {
    expect(BOARD_COLUMNS.map((c) => c.label)).toEqual(["Pending", "In progress", "Review", "Blocked", "Done"]);
  });
});

describe("columnOf", () => {
  it("puts a step in the column of its state", () => {
    const s = makeSession();
    expect(columnOf(s, step("1", "pending"))).toBe("pending");
    expect(columnOf(s, step("2", "active"))).toBe("active");
    expect(columnOf(s, step("3", "blocked"))).toBe("blocked");
    expect(columnOf(s, step("4", "done"))).toBe("done");
  });

  it("moves an in-progress step to Review while its session waits on its person", () => {
    const waiting = makeSession({ status: "waiting", waitReason: "input" });
    expect(columnOf(waiting, step("1", "active"))).toBe("review");
    expect(columnOf(waiting, step("2", "pending"))).toBe("pending");
    expect(columnOf(waiting, step("3", "blocked"))).toBe("blocked");
  });
});

describe("waitWhy", () => {
  it("names the question a session asks, from the note's first question", () => {
    const note = 'AskUserQuestion([{"question":"Which fruit would you like?","header":"Fruit","options":[{"label":"a) apple"';
    expect(waitWhy({ waitReason: "permission", waitNote: note })).toEqual({ lead: "Waiting for your input", detail: "Which fruit would you like?" });
  });

  it("names the tool a permission prompt is for", () => {
    expect(waitWhy({ waitReason: "permission", waitNote: "Bash(rm -rf dist)" })).toEqual({ lead: "Waiting for your approval", detail: "Tool: Bash" });
  });

  it("says only that it waits when the note is empty", () => {
    expect(waitWhy({ waitReason: null, waitNote: null })).toEqual({ lead: "Waiting on you", detail: null });
    expect(waitWhy({ waitReason: "input", waitNote: "" })).toEqual({ lead: "Waiting for your input", detail: null });
  });
});

describe("sessionFinished", () => {
  it("needs a plan with every step done and a session that is no longer running or waiting", () => {
    const done = [step("1", "done"), step("2", "done")];
    expect(sessionFinished(withSteps({ status: "running" }, ...done))).toBe(false);
    expect(sessionFinished(withSteps({ status: "waiting" }, ...done))).toBe(false);
    expect(sessionFinished(withSteps({ status: "stale" }, ...done))).toBe(true);
    expect(sessionFinished(withSteps({ status: "done" }, ...done))).toBe(true);
    expect(sessionFinished(withSteps({ status: "stale" }, step("1", "done"), step("2", "pending")))).toBe(false);
    expect(sessionFinished(makeSession({ status: "done", plan: null }))).toBe(false);
  });
});

describe("buildBoard", () => {
  it("fills the columns from every session's steps, keeping each step's session and key", () => {
    const a = withSteps({ id: "a", name: "alpha" }, step("1", "done"), step("2", "active"));
    const b = withSteps({ id: "b", name: "beta" }, step("1", "pending"), step("2", "blocked"));
    const { columns, withoutSteps } = buildBoard([a, b]);
    expect(columns.done.map((c) => c.key)).toEqual(["a:1"]);
    expect(columns.active.map((c) => c.key)).toEqual(["a:2"]);
    expect(columns.pending.map((c) => c.key)).toEqual(["b:1"]);
    expect(columns.blocked.map((c) => c.key)).toEqual(["b:2"]);
    expect(columns.review).toEqual([]);
    expect(columns.active[0].session).toBe(a);
    expect(withoutSteps).toEqual([]);
  });

  it("lists a session with no plan, or an empty one, apart from the columns", () => {
    const none = makeSession({ id: "n", plan: null });
    const empty = withSteps({ id: "e" });
    const { columns, withoutSteps } = buildBoard([none, empty]);
    expect(Object.values(columns).flat()).toEqual([]);
    expect(withoutSteps.map((s) => s.id)).toEqual(["n", "e"]);
  });

  it("keeps the Done steps of a running session whose steps are all done, and drops those of a finished one", () => {
    const running = withSteps({ id: "r", status: "running" }, step("1", "done"));
    const finished = withSteps({ id: "f", status: "stale" }, step("1", "done"));
    const { columns, withoutSteps } = buildBoard([running, finished]);
    expect(columns.done.map((c) => c.key)).toEqual(["r:1"]);
    expect(withoutSteps.map((s) => s.id)).toEqual(["f"]);
  });

  it("puts a session that waits on its person in Review even when it has no plan", () => {
    const asking = makeSession({ id: "q", name: "asker", status: "waiting", waitReason: "permission", plan: null });
    const { columns, withoutSteps } = buildBoard([asking]);
    expect(columns.review.map((c) => c.key)).toEqual(["q:waiting"]);
    expect(columns.review[0].waiting).toBe(true);
    expect(columns.review[0].step.text).toBe("Waiting for your approval");
    expect(columns.review[0].why).toEqual({ lead: "Waiting for your approval", detail: null });
    expect(withoutSteps).toEqual([]);
  });

  it("adds a waiting card beside the steps of a waiting session that has none in progress, and none when a step is", () => {
    const idle = withSteps({ id: "i", status: "waiting", waitReason: "input" }, step("1", "pending"), step("2", "done"));
    expect(buildBoard([idle]).columns.review.map((c) => c.key)).toEqual(["i:waiting"]);
    expect(buildBoard([idle]).columns.pending.map((c) => c.key)).toEqual(["i:1"]);
    const busy = withSteps({ id: "b", status: "waiting", waitReason: "input" }, step("1", "active"));
    expect(buildBoard([busy]).columns.review.map((c) => c.key)).toEqual(["b:1"]);
  });

  it("does not count a wait on background work as a wait on a person", () => {
    const bg = makeSession({ id: "g", status: "waiting", waitReason: null, background: { tasks: 1, agents: 0, shells: 1, monitors: 0, since: 1_000_000, items: [] } as never, plan: null });
    expect(buildBoard([bg]).columns.review).toEqual([]);
  });

  it("shows a stale session's open steps in their columns", () => {
    const stale = withSteps({ id: "s", status: "stale" }, step("1", "done"), step("2", "active"));
    expect(buildBoard([stale]).columns.active.map((c) => c.key)).toEqual(["s:2"]);
  });
});

describe("orderCards", () => {
  it("puts the most recently changed step first and leaves the rest in plan order", () => {
    const s = withSteps({ id: "a" }, step("1", "pending"), step("2", "pending"), step("3", "pending"));
    const cards = buildBoard([s]).columns.pending;
    const changed = new Map([["a:3", 500], ["a:2", 200]]);
    expect(orderCards(cards, changed).map((c) => c.key)).toEqual(["a:3", "a:2", "a:1"]);
    expect(orderCards(cards, new Map()).map((c) => c.key)).toEqual(["a:1", "a:2", "a:3"]);
  });
});

describe("groupBySession", () => {
  it("puts each session's cards together, the session that appears first leading, and keeps each one's order", () => {
    const a = withSteps({ id: "a" }, step("1", "pending"), step("2", "pending"));
    const b = withSteps({ id: "b" }, step("1", "pending"));
    const cards = buildBoard([a, b]).columns.pending;
    // The most recent change is b's card, then a's second: grouped, b leads and a follows in its own order.
    const ordered = orderCards(cards, new Map([["b:1", 9], ["a:2", 5]]));
    expect(ordered.map((c) => c.key)).toEqual(["b:1", "a:2", "a:1"]);
    expect(groupBySession(ordered).map((c) => c.key)).toEqual(["b:1", "a:2", "a:1"]);
    const interleaved = orderCards(cards, new Map([["a:2", 9], ["b:1", 5]]));
    expect(interleaved.map((c) => c.key)).toEqual(["a:2", "b:1", "a:1"]);
    expect(groupBySession(interleaved).map((c) => c.key)).toEqual(["a:2", "a:1", "b:1"]);
  });
});

describe("planFigures", () => {
  it("counts the sessions with a plan, their steps and the done ones, and leaves out a no-plan session that only waits", () => {
    const a = withSteps({ id: "a" }, step("1", "pending"), step("2", "done"), step("3", "done"));
    const b = withSteps({ id: "b" }, step("1", "active"));
    const asker = makeSession({ id: "q", status: "waiting", waitReason: "input", plan: null });
    expect(buildBoard([a, b, asker]).columns.review).toHaveLength(1);
    expect(planFigures(buildBoard([a, b, asker]))).toEqual({ orchestrators: 2, steps: 4, done: 2 });
  });

  it("is zero for a fleet with no plans", () => {
    expect(planFigures(buildBoard([makeSession({ plan: null })]))).toEqual({ orchestrators: 0, steps: 0, done: 0 });
  });
});

describe("buildBoard with plansOnly (#443)", () => {
  const cols = (b: ReturnType<typeof buildBoard>) => BOARD_COLUMNS.flatMap((c) => b.columns[c.key]);
  const planless: [string, Partial<SessionView>][] = [
    ["no plan", { plan: null }],
    ["an empty plan", { plan: { title: "t", source: "TaskCreate", steps: [] } }],
  ];

  for (const status of ["waiting", "running", "stale", "done"] as const) {
    for (const [label, over] of planless) {
      it(`keeps a ${status} session with ${label} out of every column`, () => {
        const s = makeSession({ id: "p", status, waitReason: status === "waiting" ? "input" : null, ...over });
        const plans = buildBoard([s], true);
        expect(cols(plans)).toEqual([]);
        expect(plans.withoutSteps).toEqual([s]);
      });
    }
  }

  it("lists a waiting session with no plan in Review when plansOnly is off", () => {
    const s = makeSession({ id: "p", status: "waiting", waitReason: "input", plan: null });
    expect(buildBoard([s]).columns.review.map((c) => c.key)).toEqual(["p:waiting"]);
    expect(buildBoard([s], false).columns.review).toHaveLength(1);
  });

  it("keeps a waiting session that has a plan in Review, and fills the other columns, under plansOnly", () => {
    const pendingOnly = withSteps({ id: "a", status: "waiting", waitReason: "input" }, step("1", "pending"));
    const mixed = withSteps({ id: "b", status: "waiting", waitReason: "input" }, step("1", "active"), step("2", "blocked"), step("3", "done"));
    const b = buildBoard([pendingOnly, mixed], true);
    expect(b.columns.pending.map((c) => c.key)).toEqual(["a:1"]);
    expect(b.columns.review.map((c) => c.key)).toEqual(["a:waiting", "b:1"]);
    expect(b.columns.blocked.map((c) => c.key)).toEqual(["b:2"]);
    expect(b.columns.done.map((c) => c.key)).toEqual(["b:3"]);
  });

  it("keeps a finished plan off the board in both modes", () => {
    const s = withSteps({ id: "f", status: "done" }, step("1", "done"));
    expect(cols(buildBoard([s], true))).toEqual([]);
    expect(cols(buildBoard([s], false))).toEqual([]);
  });
});
