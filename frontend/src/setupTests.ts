import "@testing-library/jest-dom";
import { createRequire } from "node:module";
import { configure, getConfig } from "@testing-library/react";
import { afterEach } from "vitest";
import { openIn } from "./route";

// The fleet console keeps the open orchestrator in the address (`#/?open=<id>`); a test that opened one leaves the wall's.
afterEach(() => {
  if (openIn(window.location.hash)) window.history.replaceState(null, "", "#/");
});

// React 19's scheduler yields to the host after every commit, so a component's mount effects run in a later task than the commit.
// A findBy or waitFor can resolve as soon as the DOM changes, and a test that then edits a form does it while those effects are
// pending: they run on the next render and write the saved value back over the edit. Whether the effects or the test's next step
// goes first depends on the clock, so it came and went, and more on a slow runner. Every async query now also waits until React's
// scheduler has nothing left to run, so a test starts from a settled page. React 18 ran most of those effects in the commit's own
// task, which is why this did not show before (#290).
const Scheduler = createRequire(import.meta.url)("scheduler") as {
  unstable_scheduleCallback: (priority: number, run: () => void) => unknown;
  unstable_IdlePriority: number;
};
const settled = () => new Promise<void>((done) => Scheduler.unstable_scheduleCallback(Scheduler.unstable_IdlePriority, () => done()));
const wrapAsync = getConfig().asyncWrapper;
// A slow page, such as the people table paging through 50 rows, can also take longer than the default second to draw on a busy
// runner, and that is a different problem from the order of effects, so the wait gets room as well.
configure({
  asyncUtilTimeout: 5000,
  asyncWrapper: (cb) =>
    wrapAsync(async () => {
      const result = await cb();
      await settled();
      return result;
    }),
});
