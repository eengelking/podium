---
title: "What it costs to run"
description: "Estimate what the server and the browser need as more sessions and agents report."
group: "Getting started"
order: 3
---

# What it costs to run

The more sessions and agents report, the more Podium needs. Every agent adds data that the server stores and sends to
the browser, and the browser draws it.

- The server's CPU and memory (ingest, SQLite, the state sent to every client) are used whether or not a browser is open.
- The browser's CPU, memory and GPU are used by each open tab.

As one example, Chrome on an M5 MacBook Pro used about 24% GPU with ten simulated sessions and a hundred agents on
screen, against about 15% for a plain page. That is one machine and one browser, so treat it as an example.
`scripts/gpu-sample.sh` (macOS) measures your own.

To lower it:

- Choose a longer **Refresh every** (in the bar above the wall, left of Theme). The page then redraws once every 5 to 60
  seconds instead of every 2, and anything that needs you still shows at once.
- Keep fewer sessions on screen.
- Leave the tab hidden. Animations pause while it is.
- Use wall mode, which hides the side panes and top bar so the browser stops drawing them.
- Close the console when nobody is looking.

<!-- nav:start -->
---

Previous: [Wall display](02-wall-display.md) · Up: [Reading the console](README.md) · Next: [The wall](04-the-wall.md)
<!-- nav:end -->
