---
title: "Deviations from the spec"
description: "The deviations from the spec that change behavior a reader of the spec would expect."
group: "Project internals"
order: 4
---

# Deviations from the spec

The numbered Spec questions above are the full list, each with its reason. These are the ones that change
behavior a reader of the spec would expect:

- The failure class order ranks an exhausted context window above a generic API error (26).
- `session.end` waits at most 1 s, not 2 s, because the engine bounds the whole event to ~1.5 s (30).
- Haiku's window is 1M (Haiku 5.5). 200K is used only for Haiku 4.5 and older ids (see Mod API findings).
- The plan tool never sets `source: 'podium_plan'`. It only names the plan (27).
- Escaped control characters in reported strings are stripped and the report accepted. Raw control characters
  make the JSON invalid and get a 400 (T4.3.1 reading, in the Phase 4 log).
- The mod is installed through a marketplace (39) and the container listens on all interfaces behind a host-side
  `127.0.0.1` publish (40). Both were written back into docs/spec/ (4.4) after the first build.
- Background waits (#119): `classic.Stop` carries `background_tasks` and `session_crons`.
  - The mod keeps them in `SessionState.background` and sends `session.background`. The server stores it in
    `sessions.background_json` and serves it as `SessionView.background`.
  - `backgroundSummary` and `idleOnBackground` are defined once, in the shared protocol block, so the mod, the
    server and the UI cannot disagree about them.
  - The status stays `waiting` with `waitReason: null`. The UI words it (`frontend/src/fleet/waiting.ts`) and
    leaves it out of the waiting count.
  - Artifact live-update watchers (monitors named `live updates for artifact ...`) are skipped on both paths
    (#128).
  - The settings-hook path reads the same Stop fields but leaves `wakeAt` null, because the server may not share
    the cron's time zone.
- Extra fields, all additive: `SessionView.cwd` and `waitReason`, `/state.config`, `liveSessions` in the report
  ack, `HistoryRow` for `/history`, and a `showStatus` mod option (20, 31, 33).
- Extra files: `server/src/fleet/fleet.ts`, `testing.ts`, `server/vitest.config.ts`, `frontend/src/fleet/`
  helpers (`logic.ts`, `chart.ts`, `storage.ts`, `useNow.ts`, `fixtures.ts`, `testState.ts`),
  `mod/podium-reporter/hooks/scripted.ts`, `mod/podium-reporter/hooks/peerChecks.ts`,
  `mod/podium-reporter/tsconfig.json`, and the scripts
  `podium-mod-typecheck.sh`, `podium-soak.sh`, `mod-report.test.ts` (7).

<!-- nav:start -->
---

Previous: [Spec questions](03-spec-questions.md) · Up: [Architecture](README.md) · Next: [Known issues](05-known-issues.md)
<!-- nav:end -->
