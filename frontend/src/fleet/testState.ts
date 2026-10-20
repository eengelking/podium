// Builds a FleetState for component tests without a server.
import { fleetReducer, initialState, type FleetState } from "./store";
import type { StateBody } from "./types";
import { makeState } from "./fixtures";

/** Starts the console at the wall: one that opened an orchestrator earlier in the test left it in the address (`#/?open=<id>`). */
export function atWall(): void {
  window.history.replaceState(null, "", "#/");
}

export function stateFrom(over: Partial<StateBody> = {}): FleetState {
  return fleetReducer(initialState, { type: "snapshot", body: makeState(over) });
}
