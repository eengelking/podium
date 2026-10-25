---
title: "Spec questions"
description: "The numbered places where the spec was silent, ambiguous or wrong, the reading chosen and why."
group: "Project internals"
order: 3
---

# Spec questions

Places where the spec was silent, ambiguous or wrong, the reading chosen, and why. Other documents cite these
numbers, so they stay fixed.

1. **"Identical type declarations" in both `protocol.ts` files (T0.1).** The mod has no use for the view
   types (`SessionView`, `Kpis`, ...). Reading chosen: the Report family (`Report`, `SessionReport`, `Plan`,
   `AgentReport`, `Failure`, `ActivityEvent` and their small helper types) lives between
   `// <protocol:begin>` and `// <protocol:end>` markers in both files, and the comparison covers that block.
   The view types live only in the server's file.
2. **Where the "sibling file" comparison runs (T0.1).** `claude plugin test` runs the mod's tests in the
   hooks sandbox, which has no file system, so a mod test cannot read the server's file. Reading chosen: the
   comparison lives in `server/src/fleet/protocol.test.ts` and reads both files. The comparison is
   symmetric, so one test covers both directions.
3. **Named sub-types.** Sections 6.2 and 7.4 write some shapes inline (`tokens`, `context`, `git`). The code
   names them (`TokenCounts`, `ContextFill`, `GitInfo`, `RateLimit`, `PlanStep`, `SessionReport`) so the
   validator, the server and the UI share them. The structure is unchanged.
4. **Omitted optional fields.** 6.2 says missing optional fields are `null`, never omitted. The validator
   accepts an omitted nullable field as `null` rather than rejecting the report (7.7: "reject, never crash,
   on junk" is about junk; a missing nullable is not junk). Required fields must be present.
5. **Over-long line lists.** `outputTail` keeps the **last** 12 lines and `evidence` the **first** 5;
   each line is clamped to 240 characters. These are clamped, not rejected, like other strings.
6. **Control characters.** Every reported string has C0 control characters (except tab) and DEL replaced
   by a space before it is stored. Newlines in single-line fields would break the UI's one-line layouts.
7. **Extra server files.** Besides the files 4.1 lists, `server/src/fleet/` has `fleet.ts` (the service
   that owns the live set and turns ingests and sweeps into SSE messages, used by `routes.ts` and
   `sweeper.ts`) and `testing.ts` (fixture loader for tests). `server/vitest.config.ts` adds
   `scripts/*.test.ts` to the server suite so the simulator is tested by `npm test`, and loads
   `server/src/testSetup.ts`, which binds the tests' own servers to `127.0.0.1` (GOTCHAS, "A server test
   fails now and then").
8. **Samples between reports.** 7.2 says one sample row per second per live session, but a quiet session
   reports only every 5 s. The sweeper writes a carry-forward sample (same totals, delta 0) for each
   second a live, non-stale session has none, so its charts do not drop to zero between heartbeats.
   Missing seconds (server down, stale session) are still zero-filled.
9. **First sample of a session.** `tokens_delta` of a session's first sample is 0, not its whole total,
   so a session first seen with 2M tokens (say after a server restart) does not show a 2M spike.
10. **Series end.** The 60-point series end at the last complete second, not the second in progress,
    whose sample is partial. `blowoutSecondsAgo` counts back from that point (a blowout in the second in
    progress is age 0).
11. **`tokensTotal`** counts all four token kinds (input, output, cache read, cache write) for the main
    loop and every agent. Cache reads dominate, which is what the requests really processed.
    It feeds the samples and the tokens-per-second series, a throughput. No "Tokens" figure in the UI
    shows it: those show context held now (`agentTokens` and `sessionTokens` in `logic.ts`), which is what
    Claude Code shows, because a running total re-counts the cached context on every request (#96).
12. **`costPerMinute`** (the KPI sparkline) is 60 one-minute buckets of fleet cost added, from the
    samples' cumulative cost, repriced from each sample's `usage_json` (kept in full only when it changed or at a
    minute's first sample, `=` otherwise) with the Admin's prices (#270; the ledger's `cost_usd` for a sample
    from a reporter that sends no usage). **`tokensPerSec`** is 60 one-second points of Σ `tokens_delta`.
13. **`clearedToday`** is a count: sessions that ended or were dropped since local midnight and are no
    longer in the live set.
14. **`session` throttle.** One message per session per 500 ms, trailing edge: the first change in a
    window schedules a send 500 ms later carrying the latest state. Ten ingests in 200 ms give one
    message. Activity messages are not throttled.
15. **Stale and drop after a restart.** Stored, not-done sessions are stale until they report. A session
    never heard since the restart is dropped `DROP_AFTER_MS` after `max(last_seen + STALE_AFTER_MS,
    server start)`, so reporters get a full minute to come back after the server was down. `Fleet.dropAtFor`
    holds that rule once: `sweep` and the `SessionView.dropAt` field both use it, so the card's countdown
    matches the drop. `Fleet.dropSession` (Remove, `POST /sessions/:id/drop`) runs the same exit early (#41).
16. **A repeated final report.** A `done` report for a session that already ended and left the live set
    is stored but does not bring the session back for another linger.
17. **Retention env names.** 7.2 says the three thresholds are env-configurable but names none:
    `RETAIN_SAMPLES_MS`, `RETAIN_EVENTS_MS`, `RETAIN_SESSIONS_MS`. `RETAIN_ADMIN_LOG_MS` joined them in #303.
18. **`GET /history`** is listed under Phase 4 in 7.1 but has no Phase 4 task. It was cheap, so it exists
    from T1.5: summary rows for sessions that ended or were dropped on a local day.
19. **Simulator haiku window.** The simulator runs its haiku agents as `claude-haiku-4-5` (200K window)
    so blowouts happen often, as 1.6.2 asks; the current Haiku 5.5 has a 1M window.
20. **View fields the UI needed.** All additive.
    - `SessionView` gained `cwd`: the home-shortened working directory, for the page header. In a container the
      home is the host's, passed in as `PODIUM_HOST_HOME` (DECISIONS 16).
    - `SessionView` gained `waitReason`, to word the orchestrator page's waiting band: "Waiting for your
      approval." versus "Waiting for your input.", with the tool name or a short question under it (#64). The
      card and the activity feed use the same two sentences, picked by `waitLead` in
      `frontend/src/fleet/waiting.ts`: a question tool such as `AskUserQuestion` reads as input, any other
      permission wait as approval (#50, #68). The feed reads the tool name out of the event text, so the report
      format is unchanged. `readableEvent` in `eventText.ts` does the same for a failing-call turn end, a
      session start or end and a hook-seen spawn.
    - `/state` gained `config` (stale, drop and linger timings), so a stale card can say "dropped from the fleet
      at 1:15" without hard-coding server settings. Since #41 the card counts down to the per-session `dropAt`
      instead, which stays right after a restart and for hook-only sessions.
21. **CSS scoping.** Every Podium rule is scoped under `.podium` and the tokens are defined on `.podium`, not
    `:root`, apart from a small document base (`html`, `body`, `#root` height and margin) in `fleet.css`.
    The theme attributes live on `<html>`: `data-theme` (resolved light or dark, as in the mockup),
    `data-theme-name` (the palette) and `data-mode` (light, dark or system). Every palette, Podium's
    and the other five, is a set of token blocks in `tokens.css`, the one source of color tokens (#354), selected
    by `[data-theme-name][data-theme]`. The blocks also apply on `<html>`, which is how the page background reads `--bg`. `useTheme` sets the attributes and an inline script in
    `index.html` sets them before first paint from the same `podium.theme` value (`themes.test.ts` checks the
    two lists agree).
22. **Routing.** `main.tsx` picks the view with `routeFor` (`route.ts`): `#/history` is the history view and
    every other hash, including the retired `#/usage`, is the fleet console. The mockup's Pause, Start session
    and Clear buttons are left out (8.1 says they belong to the simulator).
23. **Resync on reconnect.** The server sends a full `snapshot` (the `/state` body) on every SSE connect,
    so a reconnect resyncs from it rather than issuing a separate `GET /state`. The first paint still
    fetches `/state`.
24. **"N reporters live"** counts live sessions that are not stale. One `ConnectionPill` component and one
    `reportersLive` helper in `store.ts` produce it for both the fleet top bar and the Admin top bar, so the two
    cannot drift. Admin opens its own `useFleet` stream to get the number (#187).
25. **Activity rows of ended sessions.** A session that leaves the live set stays in the reducer's
    `gone` map, so its activity rows stay greyed and inert even after its card is gone.
26. **Failure class order.** Read strictly, 6.4 ranks "`error` without a candidate ⇒ Model API error"
    above "window exceeded or 3 blowouts ⇒ Context window exhausted". The engine's `error` reason
    explicitly includes running out of context (`TurnCompleteUnrefused`: "dead on an API error
    (retries exhausted, the context limit)"), so a loop whose last stop was
    `model_context_window_exceeded` and then died on `error` ran out of context. Chosen order: denial,
    refusal, exhausted window, API error with no failing call, abort, tool error, Unknown. Every other
    pair keeps the spec's order. A loop that ends `aborted` also gets a failure record (class per the
    same rules) so the UI can say why.
27. **Plan `source` and the plan tool.** `podium_plan` would hide whether the steps came from TaskCreate
    or TodoWrite, so the plan tool only sets the title and `source` stays the steps' source. `podium_plan`
    is never sent.
28. **TaskCreate/TaskUpdate from any loop, TodoWrite from the main loop only.** The task list is the
    session's; a subagent's TodoWrite would otherwise replace the orchestrator's plan.
29. **Plan owners stick.** A step is matched to a running agent when the agent spawns or the plan
    changes, and keeps that owner after the agent finishes (6.3 matches "the running agent").
30. **`session.end` deadline is 1 s, not 2 s.** The types say one ~1.5 s bound covers every
    `session.end` hook and core together (`SessionEndInput` doc), so a 2 s wait would always be cut.
31. **Extra option `showStatus`** (boolean, default on) turns the status line off. 3.3.4 says "(if
    enabled) status line" without naming the switch.
32. **`skill.prompt` attribution.** It has no `agentId`, so it is attributed to the main loop only when no
    Skill tool call is in flight (that call records the right loop itself) and no agent is running (an
    agent may be preloading the skill). Otherwise it is ignored.
33. **The ack carries `liveSessions`.** `POST /report` answers `{ ok, serverTime, ackedEvents, sessionId,
    liveSessions }` so the status line can say `podium ● N live` (5.4) without another request.
34. **Waiting from start.** A new session is `waiting` (for input) until its first turn, and a session
    whose main loop is idle is `running` while any agent still runs, `waiting` otherwise.
35. **Plan tool registration.** The `plan` tool is registered deferred (behind ToolSearch, the default),
    so it costs a session nothing unless the model looks for it.
36. **Settings-hook snippet location (T5.1).** The spec asks for a `docs/` snippet; this repo's CLAUDE.md
    says not to start a new standing doc when an existing one can hold the content, so the
    `.claude/settings.json` snippet is in [REPORTER.md](../REPORTER.md#sessions-without-the-mod).
37. **Hook ingest merges with stored rows.** Each settings hook is one event, so `POST /hook` reads the
    stored session and agents, applies the event, and ingests the result through the normal path
    (`reporter.version: "hooks"`, shown as `SessionView.reporter: 'hooks'`). It never takes
    `last_assistant_message` or prompts, so hooks send no excerpts at all. Unknown hook events are
    heartbeats.
38. **Where an explanation's cost counts (T5.2).** "Usage cost counted in the session estimate": the
    session's own figure is the engine's ledger (which already includes `$.model.complete` calls made on
    the session's client), so the explanation's estimated cost is added to the failed agent's
    `costUsdEst`, the one estimate the report carries. Explanations are requested from the flush timer,
    never from a hook, at most once per failure; a call that errors is not retried. Since #117 its tokens
    also go into the agent's `usageByModel`, so the server's price of the session total includes them.
39. **The mod is installable from a marketplace (section 11 deferred it).** The first spec listed "installing
    the mod through a marketplace" as deferred until the repo is public, with a `marketplace.json` in this
    repo. It is done a different way: `eengelking/skills` already publishes `eengelking-marketplace`, and its
    `.claude-plugin/marketplace.json` lists `podium-reporter` with a `git-subdir` source pointing at
    `mod/podium-reporter` in this repo (full `https://` URL, because the `owner/repo` shorthand clones over
    SSH). Install with `/plugin install podium-reporter@eengelking-marketplace`. This repo has no
    marketplace file of its own. docs/spec/ was amended to match (4.4, and the deferred item removed).
40. **Inside the container the server binds `0.0.0.0`.** The first spec said the server binds `127.0.0.1`
    by default. In the image it has to listen on all interfaces for the published port to reach it, so
    `podiumctl` publishes it only on the host's `127.0.0.1` (or the `--bind` address). The server's own
    default outside the container is unchanged. docs/spec/ was amended to match (3, 4.2, 4.4, 7.7).
41. **A session that has done nothing is not on the wall (#42).** Claude Code's background daemon runs a
    parked twin for each interactive window and keeps a pool of pre-warmed spares. They are real
    processes, they load the mod, and they report as sessions that have no tokens, cost, agents or plan, so
    one window could show three identical cards. The mod cannot tell, because the engine exposes neither
    the session kind nor the parked job. `isUnused` in `derive.ts` decides it from the stored row, and
    `Fleet` applies it in one place per output: the live list, the SSE messages, the activity feed,
    `/history`, `clearedToday` and the `liveSessions` count (`visibleCount`). The session shows the moment it
    is running or has any usage. Settings-hook sessions are exempt. The mod needed no change: its status
    line shows the server's `liveSessions`. A hidden session's own status line reads `0 live` until it is
    prompted. docs/spec/ 7.5 was amended to match. Known limits: a session whose first prompt is aborted
    before any token is counted goes from running back to idle, and an open browser keeps its card until
    the next reload. `/events` filters hidden sessions after the page limit is applied, so a page can come
    back short. `visibleCount` reads each live session once per report.
42. **A session nobody is attached to is dimmed, then set aside (#45).** After `/exit` under the daemon the
    conversation keeps running as a background job. The mod reads the roster from `$.session.surfaces()` on
    every flush and again on `session.attach` and `session.detach`, and reports `attached` (null until the
    first read, and when a read fails). The server stores `attached` and `detached_at`, the time of the
    first report with nobody attached, and serves `hideAt = detached_at + DETACHED_HIDE_AFTER_MS`. The hide
    itself is the wall's: `splitDetached` in `frontend/src/fleet/logic.ts` sets those cards aside once
    `now >= hideAt`, so the session stays live, in the totals and in History, and a client attaching again
    clears `hideAt` on the next report. Unlike #42 this is not an `isUnused`-style server filter, because a
    hidden session is still spending. Known limit: a non-interactive `claude -p` run has no client and reads
    as nobody attached.

<!-- nav:start -->
---

Previous: [Components](02-components/README.md) · Up: [Architecture](README.md) · Next: [Deviations from the spec](04-deviations-from-the-spec.md)
<!-- nav:end -->
