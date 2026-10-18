// The screens the standards samples are cut from (#354). Each one renders the real app with fixture data, and a sample picks
// out one part of it with a CSS selector. So a sample is the app's own markup, never a copy that can drift.
import { fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { FleetView } from "../FleetApp";
import { FocusView } from "../components/FocusView";
import { makeAgent, makeEvent, makeKpis, makeSession } from "../fixtures";
import { stateFrom } from "../testState";
import type { Failure, LifecycleConfig, SessionView } from "../types";
import { ADMIN_SCREENS } from "./screens.admin";
import { APP_SCREENS } from "./screens.app";
import { RESPOND_SCREENS } from "./screens.respond";
import { STATE_SCREENS } from "./screens.states";

export interface Screen {
  make: () => ReactElement;
  /** Runs after the first render, for a screen that needs a click or a keypress to reach its state. */
  act?: (body: HTMLElement) => void | Promise<void>;
}

const CONFIG: LifecycleConfig = { staleAfterMs: 15_000, dropAfterMs: 60_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };
const NOW = 2_000_000;
const blow = (orch: number, agents: number, level: 0 | 1 | 2) => ({ orchestrator: orch, agents, total: orch + agents, level, loopsHit: 1, loopsTotal: 3, log: [{ t: NOW - 60_000, agentId: null, kind: "compact", tokensBefore: 910_000, tokensAfter: 120_000 }] });
const failure = (over: Partial<Failure> = {}): Failure => ({
  class: "command failed",
  at: NOW - 30_000,
  tool: "Bash",
  call: "npm test -w frontend",
  exitCode: 1,
  outputTail: ["Error: 3 tests failed", "  at invoice.test.ts:41"],
  evidence: ["exit code 1", "no output after the failure"],
  explanation: "A test run failed, so the build did not go on.",
  retriedAs: "npm test -w frontend -- invoice",
  ...over,
} as Failure);

/** The wall with one session in each of the states a card can show. */
function wallSessions(): SessionView[] {
  return [
    makeSession({ id: "s1", name: "api-refactor" }),
    makeSession({ id: "s2", name: "docs-rewrite", model: "claude-sonnet-5-5", modelFamily: "sonnet", effort: "medium", status: "waiting", waitReason: "input", costUsd: 3.2, context: { tokens: 120_000, window: 1_000_000, percent: 12 } }),
    makeSession({ id: "s3", name: "release-prep", model: "claude-haiku-5-5", modelFamily: "haiku", effort: "low", status: "done", costUsd: 0.4, agents: [makeAgent({ id: "a1", status: "done" })] }),
    makeSession({ id: "s4", name: "spare-session", status: "stale", secondsSinceSeen: 40, attached: false }),
    makeSession({ id: "s5", name: "permission-prompt", status: "waiting", waitReason: "permission", blowouts: blow(1, 0, 1) }),
    makeSession({ id: "s6", name: "context-risk", blowouts: blow(2, 1, 2), context: { tokens: 910_000, window: 1_000_000, percent: 91 } }),
    makeSession({ id: "s7", name: "hooks-only", reporter: "hooks", reporterVersion: null, compat: "outdated", plan: null }),
  ];
}

function wall(): ReactElement {
  const kpis = makeKpis({ live: 7, running: 3, waiting: 2, stale: 1, agentsRunning: 2, agentsTotal: 3, planDone: 5, planTotal: 12, costToday: 18.42, blowoutsTotal: 5, sessionsAtLevel2: 1 });
  return <FleetView state={stateFrom({ sessions: wallSessions(), kpis, events: [makeEvent()] })} />;
}

function board(): ReactElement {
  return <FleetView board state={stateFrom({ sessions: wallSessions(), events: [makeEvent()] })} />;
}

const nested = [
  makeAgent({ id: "p", description: "Port the invoice endpoints", status: "running", toolCounts: { Read: 4, Edit: 2 }, skills: ["frontend-design"] }),
  makeAgent({ id: "c", parentId: "p", description: "Update the schema tests", status: "done", endedAt: 1_900_000 }),
  makeAgent({ id: "f", kind: "fork", description: "Try the second approach", status: "running", effort: "max", failure: failure() }),
];

function focus(over: Partial<SessionView> = {}, agent: string | null = null): ReactElement {
  return (
    <FocusView
      s={makeSession({ agents: nested, ...over })}
      now={NOW}
      config={CONFIG}
      sort={{ key: null, dir: 1 }}
      onSort={() => {}}
      selectedAgent={agent}
      flashAgent={null}
      onAgent={() => {}}
      onRemove={() => {}}
    />
  );
}

export const SCREENS: Record<string, Screen> = {
  wall: { make: wall },
  board: { make: board },
  "focus-running": { make: () => focus() },
  "focus-waiting": { make: () => focus({ status: "waiting", waitReason: "input" }) },
  "focus-done": { make: () => focus({ status: "done" }) },
  "focus-stale": { make: () => focus({ status: "stale", dropAt: NOW + 37_000, attached: false }) },
  "focus-blowouts": { make: () => focus({ blowouts: blow(2, 2, 2) }) },
  "focus-bare": { make: () => focus({ plan: null, files: null, agents: [], reporter: "hooks", reporterVersion: null }) },
  "focus-agent": { make: () => focus({}, "f") },
  "focus-agent-done": { make: () => focus({}, "c") },
  ...ADMIN_SCREENS,
  ...RESPOND_SCREENS,
  ...APP_SCREENS,
  ...STATE_SCREENS,
};

export { fireEvent };
