import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { openIn } from "./route";

// The fleet console keeps the open orchestrator in the address (`#/?open=<id>`); a test that opened one leaves the wall's.
afterEach(() => {
  if (openIn(window.location.hash)) window.history.replaceState(null, "", "#/");
});

// React 19 finishes some updates in a later commit than 18 did, and the CI runner is slower than a laptop: a findBy or waitFor that
// gives up after the default second fails on a screen that is about to be right (#290).
configure({ asyncUtilTimeout: 5000 });
