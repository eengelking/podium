import "@testing-library/jest-dom";
import { afterEach } from "vitest";
import { openIn } from "./route";

// The fleet console keeps the open orchestrator in the address (`#/?open=<id>`); a test that opened one leaves the wall's.
afterEach(() => {
  if (openIn(window.location.hash)) window.history.replaceState(null, "", "#/");
});
