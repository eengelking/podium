---
title: "The console's GPU use goes up after adding an animation"
description: "An endless smooth CSS animation redraws on every display refresh; drive repeating motion from the shared heartbeat instead."
group: "Project internals"
area: "What the console shows"
date: "2026-10-25"
status: "open"
order: 30
---

# The console's GPU use goes up after adding an animation

**You see:** GPU use climbs after a UI change that adds a CSS animation.

**Why:** A CSS animation that repeats forever and uses a smooth timing function (`ease`, `linear`) makes the browser
draw a frame on every display refresh, 120 or more a second, for as long as the tab is open, however small the element
is. Several at different phases are worse, because together they change the screen on almost every refresh.

**Do (contributors):**

- Drive repeating motion from the shared `data-beat` that `useHeartbeat` steps four times every 1.8 seconds, as the
  pulse and blink in `fleet.css` do.
- Build a pulse ring as a pseudo-element that is scaled and faded, not a `box-shadow`.
- Avoid a progress bar that slides between values. It redraws after each update the same way.
- `gpuLoad.test.tsx` fails on any infinite CSS animation and on a bar transition.
- To measure a change, close other tabs and windows that use the GPU, run the simulator
  (`npm run podium:sim -- --sessions 10 --agents 10`) and run `scripts/gpu-sample.sh`.

Applying incoming data on the same beat was tried and gained nothing you could measure, so it is not done. The viewer's
own **Refresh every** choice (#138) holds incoming data back between redraws on purpose: `useHeldState` shows the
newest state once per interval, and `FleetView` is memoized so a parent render does not redraw it in between.

<!-- nav:start -->
---

Previous: [Elapsed times freeze when the tab is in the background](elapsed-times-freeze-in-a-background-tab.md) · Up: [Gotchas](README.md) · Next: [A resumed session's running time starts when Podium first saw it](resumed-session-running-time-starts-late.md)
<!-- nav:end -->
