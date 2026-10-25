---
title: "Activity feed"
description: "How the activity feed is built on the server and in the UI, and how the Admin can keep it durably."
group: "Project internals"
order: 8
---

# Activity feed

Files: `server/src/fleet/activity.ts`, `featureFlags.ts`, `frontend/src/fleet/useActivityFeed.ts`. Issue #118.
The reasoning is in DECISIONS 24 and 25; mod option `activityFeed` arrived in mod 0.13.0. Since #432 the Admin can
also keep the feed durably; that is the *Activity history* below and DECISIONS 39.

The live window is observed only. Under the default policy nothing about an agent's activity is captured, sent or
kept unless a viewer is watching that loop. There is no table for the live feed, no migration, and no entries in
the state or the stream. `ingest.ts` never sees the entries, because it copies named fields only.

**Server**

- `ActivityStore` lives on the `Fleet` and holds two maps in process memory. One holds leases (session, then loop
  key: an agent id or `@orchestrator`), each with its start, its expiry and a ring of the last 20 entries numbered
  by `seq`. The other records whether each session's reporter has the option on (`SessionView.activityFeed`).
- `GET .../agents/:agentId/activity?every=` takes or renews a lease for `every` seconds plus
  `ACTIVITY_LEASE_SLACK_MS` (15 s).
- The report route answers with `watch`, the loops under a live lease.
- `Fleet.ingest` hands each validated report to the store, which merges only watched loops' entries. It skips any
  entry stamped (through the session's clock skew) before the lease began and any it already has.
- The sweeper expires leases every second. A session leaving the live set or being deleted drops its leases.

**The Admin flag**

- The `activity-feed` flag (`server/src/fleet/featureFlags.ts`) sits above all of this. It is a `feature.<id>` row
  in the settings table, '1' or '0', or unset for the flag's `defaultOn` in `FEATURES`.
- The store asks `Fleet.features` on each call. While the flag is off, `watched` is empty, `ingest` keeps only
  the reporter's option and no entries, and the route answers `enabled: false` without a lease.
- The flag's `onChange` in `Fleet` calls `ActivityStore.clear()` when it goes off and sends every browser a fresh
  snapshot, whose `features` map tells the panels.

**Mod**

- `transport.ts` keeps the reply's `watch` list, and `flushOnce` hands it to `setWatched` in `state.ts` (an empty
  list when the option is off). A loop dropping off the list forgets its ring.
- `tool.call` adds an entry (`activityCall` in `failures.ts`). A watched `turn.step` reads its text chunks as they
  pass (`activityText`). Both go through `addActivity`, which does nothing for a loop that is not watched.
- `report.ts` sends `session.activityFeed` always, and a loop's `activity` only when the option is on and the
  ring is not empty, within a 60,000-character budget per report.
- Since #431 an entry may also carry a Bash call's `id`, whole `command` and, with the `activityOutput` option and the
  reply's `watchOutput` listing the loop, its `output` and exit status. They have a separate 200,000-character budget
  per report, enforced by `withinActivityBudget` in `protocol.ts`, which also drops output the session's option does
  not allow. DECISIONS 41 has the reasoning.
- The mod (#431): `activityDetail.ts` builds the pieces. `tool.call` adds a Bash entry with its `id` and `commandDetail`
  (control characters stripped, `redactBounded` from `recording.ts`, cut at 20,000 characters with the marker). When the call
  returns, `finishActivity` adds `done`, `failed` and `exitCode` to the entry with that `id` (#598; the exit line is read from
  the result and no output is kept), and, only with both options on and the loop in `watchOutput` (`setWatchedOutput`, from the
  transport's `watchOutput`, never wider than `watch`), `output` and `outputCut` as well, so the next report carries it again. `bashOutput` reads the result record's `stdout` and `stderr`, else the text
  the model reads; the types have no numeric exit code, so `exitCode` is parsed only from an "Exit code N" in that text.
  `report.ts` keeps commands and output to 200,000 characters (`withinDetailBudget`) and the body to 480,000 bytes
  (`withinSize`), output first, then commands, oldest first.
- The server (#431): `ActivityStore` merges an entry that carries an `id` into the one it already holds, so output that
  arrives after the entry first went out attaches to it. It holds `output` and `outputCut` on the lease
  only, takes them only while the `activity-output` and `activity-feed` flags and the session's `activityOutput` option are
  on, serves them only while the flags are on, and drops them with the lease, the session, a flag turned off, and a
  restart (`dropOutput`). `done`, `exitCode` and `failed` (`statusOf`) are not output (#598): they are held and served with the
  entry under `activity-feed` alone, survive `dropOutput`, and are dropped with the lease like the entry. `watchedOutput` is the reply's `watchOutput`: the lease loops, never the loops the history lists.
  The Activity history (schema version 5) stores `command` and `command_cut`, and has no column for output, status or id.
- The console (#431): `BashRow.tsx` is the one Bash row, shared by the feed's `Entry` (panel, Expand modal and Respond modal) and the
  replay's `Row`. Only Bash rows open; the open state is the row's own React state, so it follows the entry's key across the refresh.
  `useRowAnchor` keeps the list's place when a row opens or closes. `useActivityFeed` takes a changed `output`, `done`, `failed` or
  `exitCode` on a seq it already has, and lays a live twin's output over a stored row. A row with no `output` says why in order: stored
  history, the Admin's flag (`ActivityOutputFlag`, from the state's features), the session's `activityOutput`, then "Running." or "not
  collected" (`missingOutput`). Since #598 the mod sends `done` without output too, so a finished call shows its status mark whatever the
  reason it has no output, and a call with no `done` is told by the loop: `FeedList` takes `active` and marks running only the newest
  entry, when it is a Bash call with no `done` and no output and the loop is active. An older mod's earlier calls, a call a later entry
  follows and every call of a loop that has ended read as not collected, with no mark. The replay knows from the recording whether a call
  has a result and keeps its own wording, "No output was recorded."; it never says running.

**UI**

- `useActivityFeed.ts` runs the fetch loop. It runs only while `ActivityFeed.tsx` is mounted, the feed is on and
  `usePageVisible` says the tab is shown. For a finished loop it fetches once more and then stops.
- It keeps a cursor. The first answer's highest `seq` is skipped, so a viewer never sees entries from before they
  looked, and a changed `since` means the lease was started again.
- A reply with `enabled: false` empties the hook's list and sets `adminOff`. The loop keeps running.
- `FleetApp` passes the flag from `StateBody.features` down through `SidePanel` (`activityFeedOn`) as the
  section's `adminOn`. That shows the Admin's note ahead of the reporter notes and, when it changes, makes the
  hook ask again at once.
- The section sits in `AgentDetail` and `OrchestratorDetail` (loop `@orchestrator`, which is also
  `ORCHESTRATOR_ROW`).

**Simulator**

`scripts/podium-sim.ts` reads `watch` from each reply too and sends a scripted entry a second for each watched
loop that is still working, so the panel can be seen filling without a real session.

<!-- nav:start -->
---

Previous: [Prompt and answer modal](07-prompt-and-answer-modal.md) · Up: [Components](README.md) · Next: [Activity history](09-activity-history.md)
<!-- nav:end -->
