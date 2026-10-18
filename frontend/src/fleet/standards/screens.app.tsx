// The app's own screens beyond the plain wall (#354): an orchestrator's page with its side panel, an agent's detail, the
// wall's notices, the people view, the board's states and the History page. Each one is the real component with fixture data.
import { act, fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";
import { FleetView } from "../FleetApp";
import { HistoryView } from "../HistoryView";
import { makeAgent, makeEvent, makeKpis, makeSession } from "../fixtures";
import { stateFrom } from "../testState";
import type { HistoryRow, PlanStep, SessionView } from "../types";
import type { Screen } from "./screens";

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const click = (el: Element | null) => {
  if (!el) throw new Error("screen: nothing to click");
  fireEvent.click(el);
};

const failure = {
  class: "command failed",
  at: 1_970_000,
  tool: "Bash",
  call: "npm test -w frontend",
  exitCode: 1,
  outputTail: ["Error: 3 tests failed", "  at invoice.test.ts:41"],
  evidence: ["exit code 1", "no output after the failure"],
  explanation: "A test run failed, so the build did not go on.",
  retriedAs: "npm test -w frontend -- invoice",
} as const;

const agents = [
  makeAgent({ id: "p", description: "Port the invoice endpoints", status: "running", toolCounts: { Read: 4, Edit: 2 }, skills: ["frontend-design"] }),
  makeAgent({ id: "c", parentId: "p", description: "Update the schema tests", status: "done", endedAt: 1_900_000 }),
  makeAgent({ id: "f", kind: "fork", description: "Try the second approach", status: "running", effort: "max", failure: failure as never, blowouts: 2 }),
];

const withAgents = (over: Partial<SessionView> = {}) => makeSession({ id: "s1", name: "api-refactor", agents, ...over });
const events = [makeEvent({ id: "e1", kind: "note", text: "Started the port" }), makeEvent({ id: "e2", kind: "spawn", text: "Launched Port the invoice endpoints", agentId: "p" })];

function app(sessions: SessionView[], after?: (body: HTMLElement) => Promise<void> | void, features: Record<string, boolean> = { "activity-feed": true }, wall = { notices: { "background-sessions": true }, showBackgroundSessions: false }): Screen {
  return {
    make: () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], since: 0, live: true, enabled: true, serverTime: 2_000_000 }) })));
      return <FleetView state={stateFrom({ sessions, events, features, wall, kpis: makeKpis({ live: sessions.length }) })} />;
    },
    act: async (body) => {
      await flush();
      await after?.(body);
    },
  };
}

const openSession = (body: HTMLElement, id = "s1") => click(body.querySelector(`[data-session="${id}"]`));
const openAgent = async (body: HTMLElement, id: string) => {
  openSession(body);
  await flush();
  click(body.querySelector(`#row-${id}`));
  await flush();
};

const step = (id: string, state: PlanStep["state"], text = `step ${id}`, over: Partial<PlanStep> = {}): PlanStep => ({ id, text, state, activeText: null, ownerAgentId: null, ownerLabel: null, ...over });
const planned = (over: Partial<SessionView>, ...steps: PlanStep[]) => makeSession({ ...over, plan: { title: "Plan", source: "TaskCreate", steps } });

const row: HistoryRow = { id: "h1", name: "api-refactor", project: "~/dev/billing", model: "claude-opus-5-5", modelFamily: "opus", startedAt: 1_000_000, endedAt: 4_600_000, durationSec: 3600, costUsd: 12.84, blowouts: 2, agents: 3, endReason: "prompt_input_exit", clearedFrom: "238da512ffeeddcc", clearedInto: "9c1e2f4a5b6c7d8e" };

export const APP_SCREENS: Record<string, Screen> = {
  "app-orchestrator": app([withAgents()], openSession),
  "app-agent": app([withAgents()], (b) => openAgent(b, "p")),
  "app-agent-failed": app([withAgents()], (b) => openAgent(b, "f")),
  "app-agent-done": app([withAgents()], (b) => openAgent(b, "c")),
  "app-notices": app(
    [makeSession({ id: "s1", name: "api-refactor" }), makeSession({ id: "s9", name: "spare", attached: false, hideAt: 1_000_000, status: "stale" })],
  ),
  "app-notice-closed": app(
    [makeSession({ id: "s1", name: "api-refactor" }), makeSession({ id: "s9", name: "spare", attached: false, hideAt: 1_000_000, status: "stale" })],
    async (b) => {
      click(b.querySelector(".notices .x"));
      await flush();
    },
  ),
  "app-people": app([
    makeSession({ id: "s1", name: "api-refactor", owner: "Dana", ownerGroup: "Platform", machine: { id: "m1", name: "studio-m2" } as never }),
    makeSession({ id: "s2", name: "docs-rewrite", owner: "Priya", ownerGroup: "Data", status: "waiting", waitReason: "input" }),
    makeSession({ id: "s3", name: "scratch", owner: null }),
  ]),
  "app-board": app([
    planned({ id: "s1", name: "api-refactor" }, step("1", "done"), step("2", "active", "Port endpoints", { activeText: "Porting" }), step("3", "blocked"), step("4", "pending")),
    planned({ id: "s2", name: "docs-rewrite", status: "waiting", waitReason: "input" }, step("1", "pending")),
    makeSession({ id: "s3", name: "no-plan", plan: null }),
  ]),
  "history-pages": {
    make: () => {
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.includes("/history?day=")) return new Response(JSON.stringify({ day: "2026-10-10", sessions: [row], total: 120, page: 1, pageSize: 50 }), { status: 200 });
        return new Response("{}", { status: 404 });
      }));
      return <HistoryView initialDay="2026-10-10" />;
    },
    act: async () => {
      await screen.findByRole("button", { name: "api-refactor" });
    },
  },
  "history-day": {
    make: () => {
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.includes("/history?day=")) return new Response(JSON.stringify({ day: "2026-10-10", sessions: [row, { ...row, id: "h2", name: "docs-rewrite", clearedFrom: null, clearedInto: null, modelFamily: "sonnet", model: "claude-sonnet-5-5" }], total: 2, page: 1, pageSize: 50 }), { status: 200 });
        return new Response("{}", { status: 404 });
      }));
      return <HistoryView initialDay="2026-10-10" />;
    },
    act: async () => {
      await screen.findByRole("button", { name: "docs-rewrite" });
    },
  },
};
