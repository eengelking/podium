// More states of the real screens (#354): responding from the wall, the board signed in, the activity list with every kind of
// event, and an orchestrator's page in the states a card or a row can be in. Fixture data, the app's own components.
import { act, fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";
import { FleetView } from "../FleetApp";
import { makeAgent, makeEvent, makeKpis, makeSession } from "../fixtures";
import type { RespondApi } from "../respondApi";
import { stateFrom } from "../testState";
import type { ActivityView, RespondMe, SessionView } from "../types";
import type { Screen } from "./screens";

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 60)); });
const ME: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false };
const respondApi = (me: RespondMe = ME) => ({ me: async () => me }) as unknown as RespondApi;
const ALL = ["question", "message", "plan-approve", "plan-feedback", "permission", "command"] as const;
const asks = [{ id: "q1", kind: "question" as const, agentId: null, openedAt: 1_900_000, count: 2, state: "open" as const }];
const responding = (over: Partial<SessionView> = {}) => makeSession({ status: "waiting", waitReason: "input", activityFeed: true, reporterVersion: "0.14.0", respond: { level: "everything", accepts: [...ALL], limits: [] }, asks, ...over });

const feedEntries = [
  { seq: 1, at: 1_950_000, kind: "tool", text: "Read src/invoice.ts" },
  { seq: 2, at: 1_960_000, kind: "text", text: "The schema has two nullable columns." },
  { seq: 3, at: 1_970_000, kind: "reasoning", text: "Checking the migration order first." },
  { seq: 4, at: 1_980_000, kind: "tool", text: "Bash npm test" },
  { seq: 5, at: 1_985_000, kind: "text", text: "Using the key [redacted] for the staging API." },
];

function fleet(sessions: SessionView[], opts: { events?: ActivityView[]; me?: RespondMe; board?: boolean; entries?: typeof feedEntries; prefs?: object; act?: (body: HTMLElement) => Promise<void> | void } = {}): Screen {
  return {
    make: () => {
      if (opts.prefs) localStorage.setItem("podium.people", JSON.stringify(opts.prefs));
      if (opts.board) localStorage.setItem("podium.board", JSON.stringify({ group: true, me: false }));
      // The feed skips what the server already held at the first answer and shows only what arrives after, so the first
      // reply is empty and every later one holds the entries.
      let calls = 0;
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ entries: calls++ === 0 ? [] : (opts.entries ?? []), since: 1, live: true, enabled: true, serverTime: 2_000_000 }) })));
      const state = stateFrom({ sessions, events: opts.events ?? [makeEvent()], features: { "activity-feed": true, respond: true }, kpis: makeKpis({ live: sessions.length }) });
      return <FleetView state={state} board={opts.board} respondApi={respondApi(opts.me)} />;
    },
    act: async (body) => {
      await flush();
      await opts.act?.(body);
    },
  };
}

const ev = (id: string, kind: ActivityView["kind"], text: string, over: Partial<ActivityView> = {}) => makeEvent({ id, kind, text, t: 1_990_000, ...over });
const events = [
  ev("e1", "start", "Session started"),
  ev("e2", "spawn", "Launched Explore", { agentId: "a1" }),
  ev("e3", "skill", "Used frontend-design"),
  ev("e4", "plan", "Plan updated: 2 of 5 done"),
  ev("e5", "wait", "Waiting on you", { data: { answered: true } }),
  ev("e6", "blow", "Context exceeded 3 times"),
  ev("e7", "compact", "Compacted to 12%"),
  ev("e8", "fail", "npm test failed", { agentId: "a1" }),
  ev("e9", "done", "Agent finished", { agentId: "a1" }),
  ev("e10", "end", "Session ended", { sessionId: "gone1", sessionName: "old-session" }),
  ev("e11", "note", "A note from the session"),
];

const waitEvents = [
  ev("w1", "wait", "waiting on you: permission", { sessionId: "s2", sessionName: "docs-rewrite", t: 1_980_000 }),
  ev("w0", "wait", "waiting on you: permission", { sessionId: "s1", sessionName: "api-refactor", t: 1_900_000 }),
  ev("w2", "wait", "waiting on background: 2 shell", { sessionId: "s7", sessionName: "background-wait", t: 1_985_000 }),
];
const bgSession = makeSession({ id: "s2", name: "background-wait", status: "waiting", waitReason: null, background: { tasks: [{ type: "shell", description: "npm run dev", status: "running" }, { type: "agent", description: "nightly build", status: "running" }], wakeAt: 2_060_000 } });
const delegating = makeSession({ id: "s3", name: "delegating", agents: [makeAgent({ id: "d1", status: "running", description: "Map call sites" })] });
const agentStates = makeSession({
  id: "s4",
  name: "agent-states",
  agents: [makeAgent({ id: "q", status: "queued", description: "Queued agent" }), makeAgent({ id: "x", status: "aborted", description: "Aborted agent" }), makeAgent({ id: "k", status: "failed", description: "Failed agent" })],
  plan: { title: "Plan", source: "TaskCreate", steps: [{ id: "1", text: "Inferred next step", state: "pending", activeText: null, ownerAgentId: null, ownerLabel: null }] },
  files: { files: [{ path: "src/a.ts", status: "deleted", added: 0, removed: 12, from: null }, { path: "src/b.ts", status: "renamed", added: 2, removed: 1, from: "src/old.ts" }, { path: "assets/logo.png", status: "added", added: null, removed: null, from: null }], total: 3, added: 2, removed: 13, since: "start" },
});

const stepOf = (id: string, state: "pending" | "active" | "done" | "blocked") => ({ id, text: `step ${id}`, state, activeText: state === "active" ? "Working" : null, ownerAgentId: null, ownerLabel: null });
const planOf = (...steps: ReturnType<typeof stepOf>[]) => ({ title: "Plan", source: "TaskCreate" as const, steps });
const pick = (b: HTMLElement, id: string) => void fireEvent.click(b.querySelector(`[data-session="${id}"]`)!);
const many = Array.from({ length: 30 }, (_, i) => ({ path: `src/module-${String(i).padStart(2, "0")}/file.ts`, status: "modified" as const, added: i + 1, removed: i, from: null }));
const crowded = makeSession({ id: "s5", name: "many-files", effort: "high", git: { branch: "main", detached: false, isWorktree: false, worktreePath: null, ahead: 0, behind: 0, dirty: 0 }, blowouts: { orchestrator: 1, agents: 1, total: 2, level: 1, loopsHit: 1, loopsTotal: 3, log: [{ t: 1_900_000, agentId: null, kind: "compact", tokensBefore: 900_000, tokensAfter: 100_000 }] }, files: { files: Array.from({ length: 45 }, (_, i) => ({ path: `src/module-${String(i).padStart(2, "0")}/file.ts`, status: "modified" as const, added: i + 1, removed: i, from: null })), total: 45, added: 465, removed: 435, since: "start" }, agents: [makeAgent({ id: "a1", description: "Watch me", activityFeed: true } as never)] });

export const STATE_SCREENS: Record<string, Screen> = {
  "app-respond-wall": fleet([responding({ id: "s1", name: "mine", owner: "Ed" }), responding({ id: "s2", name: "theirs", owner: "Alex" }), makeSession({ id: "s3", name: "running", owner: "Ed" })]),
  "app-signed-out": fleet([responding({ id: "s1", name: "mine", owner: "Ed" })], { me: { enabled: true, signedIn: false, name: null, admin: false } }),
  "app-board-me": fleet([responding({ id: "s1", name: "mine", owner: "Ed" }), makeSession({ id: "s2", name: "theirs", owner: "Alex" })], { board: true }),
  "app-board-empty": fleet([], { board: true }),
  "app-board-quiet": fleet([makeSession({ id: "s1", name: "api-refactor", plan: planOf(stepOf("1", "active"), stepOf("2", "pending")) })], { board: true }),
  "app-board-grouped": fleet(
    [
      makeSession({ id: "s1", name: "api-refactor", owner: "Ed", ownerGroup: "Platform", plan: planOf(stepOf("1", "active"), stepOf("2", "done")) }),
      makeSession({ id: "s2", name: "docs-rewrite", owner: "Alex", ownerGroup: "Data", plan: planOf(stepOf("1", "pending")) }),
    ],
    { board: true, prefs: undefined },
  ),
  "app-effort-none": fleet([makeSession({ id: "s1", name: "no-effort", effort: null }), makeSession({ id: "s2", name: "low-effort", effort: "low" })]),
  "app-activity": fleet([makeSession({ id: "s1", name: "api-refactor", agents: [makeAgent({ id: "a1", description: "Explore" }), makeAgent({ id: "a2", parentId: "a1", description: "Read the schema" })] })], { events: [...events, ev("e12", "spawn", "Launched Read the schema", { agentId: "a2" })] }),
  "app-other-model": fleet([makeSession({ id: "s1", name: "local-model", model: "llama-3-70b", modelFamily: "other", effort: null, costUsd: null as never })]),
  "app-activity-waits": fleet(
    [makeSession({ id: "s1", name: "api-refactor" }), makeSession({ id: "s2", name: "docs-rewrite", status: "waiting", waitReason: "permission" }), { ...bgSession, id: "s7", name: "background-wait" }],
    { events: waitEvents },
  ),
  "app-remove-failed": fleet([makeSession({ id: "s4", name: "spare-session", status: "stale", secondsSinceSeen: 40 })], {
    act: async (b) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
      fireEvent.click(b.querySelector(".card-slot .btn.remove")!);
      await settle();
    },
  }),
  "app-report-modal": fleet([makeSession({ id: "s8", name: "report", agents: [makeAgent({ id: "a1", description: "Map call sites", promptExcerpt: "Find every call site of the invoice API.", answerExcerpt: "Found 14 call sites in 6 files." })] })], {
    act: async (b) => {
      pick(b, "s8");
      await flush();
      fireEvent.click(b.querySelector("#row-a1")!);
      await flush();
      fireEvent.click(b.querySelector(".docbtn:not([disabled])")!);
      await settle();
    },
  }),
  "app-agent-tools": fleet([makeSession({ id: "s9", name: "tools", agents: [makeAgent({ id: "a1", description: "Many tools", lastTool: "WebFetch", toolCounts: { Read: 9, Edit: 7, Bash: 6, Grep: 5, Glob: 4, Write: 3, WebFetch: 1 } })] })], {
    act: async (b) => { pick(b, "s9"); await flush(); fireEvent.click(b.querySelector("#row-a1")!); await flush(); },
  }),
  "app-wall-bg": fleet([{ ...bgSession, id: "s7", name: "background-wait" }, makeSession({ id: "s1", name: "api-refactor" })]),
  "app-wall-deleg": fleet([delegating, makeSession({ id: "s1", name: "api-refactor" })]),
  "app-collapsed": fleet([makeSession()], { act: async (b) => { for (const btn of b.querySelectorAll('button[aria-label^="Collapse"]')) fireEvent.click(btn); await flush(); } }),
  "app-bg-wait": fleet([bgSession], { act: (b) => void fireEvent.click(b.querySelector('[data-session="s2"]')!) }),
  "app-delegating": fleet([delegating], { act: (b) => void fireEvent.click(b.querySelector('[data-session="s3"]')!) }),
  "app-wall-mode": fleet([makeSession()], { act: (b) => void fireEvent.click(b.querySelector(".wall-enter")!) }),
  "app-files-tab": fleet([crowded], { act: async (b) => { pick(b, "s5"); await flush(); fireEvent.click(screen.getByRole("tab", { name: /Files/ })); await flush(); } }),
  "app-blowout-open": fleet([crowded], { act: async (b) => { pick(b, "s5"); await flush(); fireEvent.click(b.querySelector(".facts [aria-expanded]")!); await flush(); } }),
  "app-agent-feed": fleet([makeSession({ id: "s6", name: "feed", activityFeed: true, reporterVersion: "0.14.0", agents: [makeAgent({ id: "a1", description: "Watch me", status: "running" })] })], {
    entries: feedEntries,
    act: async (b) => { pick(b, "s6"); await flush(); fireEvent.click(b.querySelector("#row-a1")!); await settle(); if (vi.isFakeTimers()) await act(async () => { await vi.advanceTimersByTimeAsync(5100); }); await settle(); },
  }),
  "app-sign-in-dialog": fleet([makeSession()], { me: { enabled: true, signedIn: false, name: null, admin: false }, act: async () => { fireEvent.click(screen.getByRole("button", { name: /^Sign in/ })); await flush(); } }),
  "app-people-groups": fleet([
    makeSession({ id: "s1", name: "api-refactor", owner: "Dana", ownerGroup: "Platform" }),
    makeSession({ id: "s2", name: "docs", owner: "Priya", ownerGroup: null }),
  ], { prefs: { groupBy: "group", order: "name", collapsed: [] } }),
  "app-agent-states": fleet([agentStates], { act: (b) => void fireEvent.click(b.querySelector('[data-session="s4"]')!) }),
};
