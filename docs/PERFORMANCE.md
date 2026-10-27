---
title: "Performance"
description: "What Podium costs to run at four fleet sizes, how to measure it again, and the ranked list of what the audit found."
group: Project internals
---

# Performance

This page records the performance audit of `development` (#682): the method, the baseline numbers, and what the numbers point to. It is for
a contributor or the maintainer who wants to change something that affects speed, memory or CPU, and needs a number to compare against.
What the product must do is in [docs/spec/](spec/); this page does not restate it.

Contents:

- [The shape of it](#the-shape-of-it)
- [How to measure](#how-to-measure)
- [Baselines](#baselines)
- [Findings, ranked](#findings-ranked)
- [Looked at and left alone](#looked-at-and-left-alone)
- [What is still open](#what-is-still-open)

## The shape of it

At a large fleet (52 sessions, about 20 agents each) the server uses about 11% of one core and 197 MB, and the browser tab holds about
5,600 DOM nodes and 12 MB of JavaScript heap at 60 frames a second with no long task. Nothing is slow today. The cost that grows fastest
with the fleet is the stream: 1.15 MB a second at 52 sessions, with no compression, and almost all of it is `session` events that each
carry the whole session, agents included. Most of the findings below are about sending less, or about sending it only to who is looking.

The audit changed no product code. Each finding is filed as its own issue, a sub-issue of #682, with a before and after measurement in its
validation.

## How to measure

Three scripts in `scripts/` take the numbers on this page. Each starts its own throwaway server on a free port with a temporary database and
stops everything it started. None of them touches a server you use. Build first with `npm run build`.

| Script | Measures |
|---|---|
| `scripts/podium-perf.mjs` | Server CPU and resident memory, event-loop delay, SSE bytes and messages per second by event type (raw and gzipped), the size of the full state. Idle, small, medium and large fleets, two runs each, and whether the two runs agree within a margin |
| `scripts/podium-perf-browser.sh` | An open tab in headless Chrome: DOM nodes, JavaScript heap, long tasks, frames per second, bytes transferred |
| `scripts/podium-perf-mod.mjs` | The reporter mod's own code: what one tool call adds to a session's state, and what building and serializing one report costs, by number of agents |

Existing scripts that belong with these: `scripts/podium-soak.sh` for resident memory over a long run, `scripts/gpu-sample.sh` for the GPU
(#280), `scripts/podium-sim.ts` for the fake fleet all of them use, and `scripts/page-shot.mjs` for a picture at a set width.

Fleet sizes: small is 5 sessions with 3 agents each, medium is 20 with 10, large is 50 with 20 (the simulator replaces ended sessions, so
the count drifts to 52). Each run waits 10 seconds, then measures for 60. Event-loop delay is `monitorEventLoopDelay` with its 10 ms timer
resolution taken off. Two runs agree when CPU, memory and bytes per second are each within 15% of each other.

## Baselines

Taken on the maintainer's Mac (Node 24.3.0, macOS arm64) on 2026-10-27, seed 682. Two runs per row; the figures are the two runs side by side.

| Fleet | Server CPU (% of one core) | Resident memory (MB) | Stream (bytes/s) | Messages/s | Gzipped stream (bytes/s) | Event-loop delay p99 (ms) |
|---|---|---|---|---|---|---|
| Idle | 0.48 / 0.39 | 120.5 / 120.6 | 285 / 286 | 0.5 | 10 | 1.4 / 1.2 |
| Small | 1.89 / 2.18 | 125.8 / 125.0 | 57,643 / 57,466 | 6.2 | 7,531 / 7,536 | 1.6 / 2.2 |
| Medium | 5.89 / 5.74 | 150.0 / 154.0 | 305,961 / 307,449 | 25.5 | 37,990 / 38,198 | 11.3 / 11.6 |
| Large | 11.41 / 11.19 | 197.1 / 196.5 | 1,151,978 / 1,151,472 | 66.7 | 136,167 / 136,121 | 39.5 / 40.7 |

All four pairs agree within the 15% margin. The largest single stall of the event loop was 96 ms, at the large size.

What is in the stream (large fleet, one client): `session` events are 45.8 a second at an average of 24.6 KB, which is 1.12 MB of the 1.15 MB.
`activity` events are 19 a second at 330 bytes, and `tick` is one every two seconds at about 940 bytes. Gzip with a flush after every message,
as an event stream would do it, brings the stream to about 12% of its size.

The full state (`/api/fleet/state`, and the snapshot a new client receives): 1.1 KB idle, 90 KB small, 380 KB medium, 1.39 MB large. Gzipped,
13 KB, 50 KB and 171 KB for the last three.

The tab, at 1440 px, 30 seconds watched, from `scripts/podium-perf-browser.sh`:

| Fleet | DOM nodes | JavaScript heap (MB) | Long tasks | Frames/s | Transferred (KB) |
|---|---|---|---|---|---|
| Small | 793 | 4.8 to 6.9 | 0 | 60 | 817 |
| Medium | 2,286 | 9.1 to 9.4 | 0 | 60 | 1,086 |
| Large | 5,631 | 10.6 to 11.6 | 0 | 60 | 1,902 |

The soak, from `scripts/podium-soak.sh --seconds 3600 --sessions 20 --agents 10 --clients 3`: one hour with about 20 live sessions and 290 to
335 agents. The server's resident memory over the hour:

| Time | 30 s | 5 min | 15 min | 30 min | 45 min | 50 min | 55 min | 60 min |
|---|---|---|---|---|---|---|---|---|
| Resident memory (MB) | 168 | 216 | 221 | 261 | 267 | 248 | 258 | 259 |

It rose 93 MB in the first half hour, then stayed between 248 and 268 MB, with a fall of about 20 MB at 50 minutes. All three
stream clients kept receiving to the end. The agent count stayed near 300 the whole time, so the rise is not the fleet growing. It looks like
a plateau, but one hour at one fleet size cannot rule out a slow leak (see below).

The build: one JavaScript file of 622 KB (183 KB gzipped) and one stylesheet of 141 KB (25 KB gzipped). The container image
(`localhost/podium`) is 271 MB. `server/dist` is 2.1 MB, of which 1.3 MB is 81 compiled test files.

The reporter, from `scripts/podium-perf-mod.mjs` (400 tool calls per count):

| Agents in the session | Tool call, median / p99 (µs) | `buildReport` (ms) | Report (KB) |
|---|---|---|---|
| 0 | 0.54 / 5.5 | 0.00 | 0.9 |
| 20 | 1.17 / 1.42 | 0.08 | 18.1 |
| 200 | 4.58 / 46.04 | 0.42 | 155.6 |

## Findings, ranked

Impact and risk are estimates from the code and the numbers above. Each was checked against the source before it was listed. A finding
that changes what the server sends to the reporter, or what the reporter sends, says whether it needs a protocol change (SPEC 6.8). None
touches a design standard.

| # | Finding | Impact | Risk | Where | Issue |
|---|---|---|---|---|---|
| 1 | The event stream and `/api/fleet/state` are not compressed. Gzip takes the large stream from 1.15 MB/s to about 136 KB/s and the state from 1.39 MB to 171 KB. The browser is the only consumer, so no reporter rule applies (SPEC 7.6) | High | Low | `server/src/fleet/routes.ts` | #745 |
| 2 | Every `session` event carries the whole session view, rebuilt from about six queries and every agent. It is 98% of the stream. Slimming the card view or sending only what changed needs a frontend change and a change to SPEC 7.6 | High | Medium | `server/src/fleet/fleet.ts`, `derive.ts` | #746 |
| 3 | The built page is served with no compression and no cache headers: 622 KB of script where 183 KB would do, and every visit fetches it again | High on a slow link | Low | `server/src/index.ts` | #747 |
| 4 | No backpressure on the stream. `res.write`'s return value is ignored, so a client that stops reading makes the server buffer every message for it without limit, at about 70 MB a minute at the large size | Medium | Medium | `server/src/fleet/sse.ts`, `routes.ts` | #748 |
| 5 | The two-second tick computes the fleet's KPIs, which rebuilds every session's view and runs fleet-wide queries, even with no client connected | Medium | Low | `server/src/fleet/fleet.ts` | #749 |
| 6 | The one-second sweep reads and writes one `samples` row for each live session, each in its own transaction | Medium | Low | `server/src/fleet/fleet.ts` | #750 |
| 7 | A tab in the background keeps parsing the stream and redraws the whole console every two seconds. `useHeldState` and `useNow` have no visibility check | Medium | Low | `frontend/src/fleet/useHeldState.ts`, `useNow.ts` | #751 |
| 8 | Every report is the whole session, every agent re-sent. A busy 200-agent session posts about 156 KB roughly once a second, and the report is serialized twice. Sending only what changed is a protocol change | Medium to high | Medium | `mod/podium-reporter/hooks/report.ts`, `transport.ts` | #752 |
| 9 | The reporter's git poll starts 11 to 13 git processes for each session every 10 seconds, on the developer's machine | Medium | Medium | `mod/podium-reporter/hooks/git.ts`, `register.ts` | #753 |
| 10 | Admin, history and the replay pages are in the one 622 KB script, though few viewers open them | Medium | Low | `frontend/src/main.tsx` | #754 |
| 11 | `samples` has no index on `t`. The fleet-wide token and cost queries and the hourly retention delete scan the whole table | Low now, grows with retention | Low | `server/src/fleet/db.ts` | #755 |
| 12 | 81 compiled test files (1.3 MB) ship in `server/dist` and the container image, because the server's tsconfig has no exclude | Low | Low | `server/tsconfig.json` | #756 |
| 13 | The reporter's report POST passes no timeout of its own, so a server that accepts the connection and never answers holds the in-flight slot until the host gives up | Low | Low | `mod/podium-reporter/hooks/transport.ts` | #757 |
| 14 | `SessionCard` is not memoized, so each redraw renders every card. No problem is measured at 52 sessions, so measure at 200 first | Low | Medium | `frontend/src/fleet/Wall.tsx`, `SessionCard.tsx` | #758 |

The browser GPU work stays in #280. The audit adds one number to it: the console redraws once every two seconds by default, not once a
second, because `useHeldState` and `useNow` share the "Refresh every" interval.

## Looked at and left alone

- `formatSse` serializes once per broadcast, not once per client (`server/src/fleet/sse.ts`). It is already the cheap way.
- The 100-client cap on the stream is in SPEC 7.6 and is a sound limit.
- The `session` throttle of 500 ms (`throttleMs`) is a deliberate trade of latency for volume. Raising it would halve the bytes and slow the
  console, so it is a product choice and not a defect.
- The 512 KB limit on a report body is a ceiling. The largest real report measured is 156 KB.
- Prepared statements are cached and reused (`stmt()` in `server/src/fleet/db.ts`).
- The main database already runs in WAL mode with `synchronous = NORMAL`. Adding `journal_size_limit` is a possible tidy-up, not a measured need.
- The server's own timers (sweep, tick, hourly retention, the daily update and certificate checks) cost about 1 ms of delay at the 99th
  percentile when idle, and the daily ones are `unref`'d.
- Memory: no map or buffer was found that grows without a bound in a reading of the code. `clockSkew`, the reporter list (capped at 1000),
  the activity tails and the pending timers are all released or bounded. The one-hour soak above is consistent with that, but it is not proof.
- The pollers in the frontend (`useTraffic`, `useMyPeers`, `tlsStatus`, the admin tabs) already skip their tick while the tab is hidden.
  `useRespond` is the one exception and costs one small request a minute.
- No unused dependency was found. React and react-dom are the only runtime dependencies of the frontend, the charts are hand-built SVG,
  and the Markdown renderer is hand-written.
- The Containerfile is already multi-stage, installs only the server's production dependencies and keeps build tools out of the image. A
  smaller base image would save space at a real compatibility risk.
- The reporter's tool path does no process or file work. The git and title reads happen on timers, and a slow or absent server is handled
  with a backoff of 1, 2, 5 and then 10 seconds.

## What is still open

- **The reporter's cost inside a real Claude Code session is not measured.** The server address is a shared plugin option, so pointing a
  live session at a throwaway server would mean changing the maintainer's own settings. `scripts/podium-perf-mod.mjs` times the mod's pure
  code only. The git and process cost in finding 9 is counted from the code, not measured. The maintainer chose to leave this as a gap.
- **The container's CPU and memory (`podman stats`) are not measured.** The image size is read from an existing image; a new build would
  re-tag the maintainer's `localhost/podium`.
- **The browser's own CPU and the GPU are not measured here.** The tab's JavaScript cost is (no long tasks), but the process CPU and the GPU
  load belong with #280, which has the sampling script.
- **The browser at 200 sessions is not measured.** The simulator stops at 50 sessions. Finding 14 depends on this.
- **The soak is one hour at 20 sessions with 10 agents each, not several hours, and it has no heap profile.** Memory climbed for the first half
  hour and then held, which is what a cache filling looks like, but a slow leak under 1 MB an hour would not show. A longer run with
  `--heap-prof` (or heap snapshots at the start and the end) would settle it. Nobody has filed this as an issue yet, because there is no
  finding to fix; it is a measurement still to take.
- **No finding has a before and after number yet.** The follow-up issues carry the before number from this page and name the script that
  takes the after number.
