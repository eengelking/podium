// The screens the standards samples are cut from (#354). Each one renders the real app with fixture data, and a sample picks
// out one part of it with a CSS selector. So a sample is the app's own markup, never a copy that can drift.
import type { ReactElement } from "react";
import { FleetView } from "../FleetApp";
import { makeAgent, makeEvent, makeKpis, makeSession } from "../fixtures";
import { stateFrom } from "../testState";

/** The wall with one session in each of the states a card can show. */
function wall(): ReactElement {
  const sessions = [
    makeSession({ id: "s1", name: "api-refactor" }),
    makeSession({ id: "s2", name: "docs-rewrite", model: "claude-sonnet-5-5", modelFamily: "sonnet", effort: "medium", status: "waiting", waitReason: "input", costUsd: 3.2, context: { tokens: 120_000, window: 1_000_000, percent: 12 } }),
    makeSession({ id: "s3", name: "release-prep", model: "claude-haiku-5-5", modelFamily: "haiku", effort: "low", status: "done", costUsd: 0.4, agents: [makeAgent({ id: "a1", status: "done" })] }),
    makeSession({ id: "s4", name: "spare-session", status: "stale", secondsSinceSeen: 40, attached: false }),
  ];
  const kpis = makeKpis({ live: 4, running: 1, waiting: 1, stale: 1, agentsRunning: 2, agentsTotal: 3, planDone: 5, planTotal: 12, costToday: 18.42 });
  return <FleetView state={stateFrom({ sessions, kpis, events: [makeEvent()] })} />;
}

export const SCREENS: Record<string, () => ReactElement> = { wall };
