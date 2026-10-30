---
title: "Activity history"
description: "How the durable activity history is stored in its own database file, set by the Admin and purged."
group: "Project internals"
order: 9
---

# Activity history

Files: `server/src/storage/sqlite/activityHistory.ts` (the store), `activityDb.ts` (the second database file),
`activityHistorySettings.ts` (both in `server/src/storage/sqlite/`; the Admin's choice), `activityHistoryTypes.ts` (the shapes shared with the routes and
the Admin pages), `sweeper.ts` (`purgeActivityHistory`), `frontend/src/fleet/admin/DataPage.tsx` and
`StoredActivityTab.tsx`, and the window changes in `useActivityFeed.ts` and `ActivityFeed.tsx`. Issue #432; the
reasoning and the alternatives are DECISIONS 39. The seeder for load tests is `scripts/podium-seed-activity.ts`.

- **A second SQLite file.** `activity.sqlite` sits beside `podium.sqlite` (`activityDbPath`), with its own schema
  version in `PRAGMA user_version`, WAL, and incremental auto-vacuum (set before the first table exists). Nothing in
  the main database references it and no foreign key crosses files, so code removes a session's rows. It lives in
  the same `/data` volume, so the container and `podiumctl` need no change. Nothing is written to it under the
  default policy.
- **The policy** is one JSON row in the main `settings` table (`activity_history`), read through
  `ActivityHistorySettingsStore`. A server without a token reads it as `default` and refuses to save another.
- **Capture needs no lease.** `Fleet` passes `ActivityStore` a function that lists the orchestrator and every
  running agent of a session, and `watched()` appends them for a session whose reporter has the option on. The mod
  already sends whatever `watch` lists, so it is unchanged. `Fleet.ingest` hands each report to
  `ActivityHistory.ingest`, which stores what is new. The mod resends its last 20 entries every report with no
  ids, so a loop keeps a small tail in memory (the newest stored time and the entries at it), reloaded from the
  file after a restart, and skips an entry it already has or one older than that. Each entry gets the next `seq` for
  its session and loop, and two times: `at` as the feed shows it, and `t` on the server's clock (`at` minus the
  report's clock skew), which the purge and the filters use. Entries sent from Podium are written through the
  respond bridge with their ref, sender and note.
- **Aggregates, so nothing scans the table.** `stored_sessions` also holds each session's `entries`, `bytes` (an
  estimate: text, a Bash command and labels plus 48 bytes a row) and `oldest_t` (schema version 2), and a `loops` table
  holds each loop's entry count and its first and last times (schema version 3), kept in step in the same
  transaction as every insert, Podium-entry change and removal chunk. The live feed's `history` note and a history page
  therefore cost one indexed read, whatever the loop's size. `totals()` and a `list` that filters only on a
  session's name, project, owner or state read that small table. A filter that changes which entries count (`loop`,
  `olderThanDays`, `from`, `to`) counts per session through the covering index `entries_session_t (session_id, t,
  loop)` in slices of about 20,000 rows with a turn for the event loop between them; its `bytes` is then an estimate
  from the session's average entry size. Times in `list` are on the server's clock (`t`).
- **Purge and removal run in chunks.** `startSweeper` runs `purgeActivityHistory` every 5 minutes and once at start;
  a run that starts while one is still going is skipped. A run applies the policy (`after`: older than the period;
  `end`: sessions that are not live; the cap: oldest first) a chunk at a time: each chunk is its own transaction
  that selects some rows, deletes them and takes them off their sessions' aggregates, then yields to the event loop.
  The chunk size starts at 500 rows and adapts to about 25 ms a chunk (at most 5,000), because rows scattered through a
  big file cost more to delete than rows that sit together. A chunk deletes its rows with `DELETE ... WHERE id IN (?, ...)` in batches of 200 ids (#808), not a JSON array read back by `json_each`. Compaction is `incremental_vacuum` in steps of 500 pages with
  a yield between, then a WAL checkpoint. A run writes one `activity_purged` admin log row when it removed something.
  `Fleet.retain()` (hourly) starts the removal of rows of sessions the main database no longer holds without waiting
  for it, and `deleteSession` does the same for one session. The Admin's deletes and `preview` (an estimate by index
  counts, with bytes from the session averages) go through the same queue: a purge, a delete and a preview never
  interleave their chunks, and capture keeps running between chunks. A delete request answers when its removal has
  finished, which can take a while for a very large delete.
- **Reads.** The live route's reply may carry a `history` note (counts only). The entries come from
  `GET /api/fleet/respond/sessions/:id/activity-history`, which needs a respond sign-in for the session's owner
  or an Admin. The Admin API (`/api/admin/settings`, `activity-history/preview`, `stored-activity`,
  `stored-activity/delete`) writes the admin log itself.
- **UI.** The Data page and Stored activity use the Admin's own rows, warning bar, confirmation box and selection
  bar. In the window `useActivityFeed` loads the newest stored page when `history.canRead`, merges the live entries
  after it by (time, kind, text) so none shows twice, and `loadOlder` prepends pages by `seq`.
- **Measured (#432, `scripts/podium-seed-activity.ts`).** On one machine (macOS, Node 24, local SSD), with 14.4 million
  rows (100 sessions x 5 loops x 20 entries a minute x 1 day, 3.4 GB at about 223 MiB per million rows): `totals()` and
  an unfiltered or session-level `list` take 0 to 1 ms; a window-filtered `list` takes 0.5 to 9 s without blocking
  (longest event-loop lag 18 ms); `preview` 0.5 s; a purge of 1.44 million rows 18.6 s and a delete of 2.46 million rows
  33 s, each never holding the event loop for more than about 50 ms. The first `page()` on a cold file took about
  106 ms, then 5 ms. Before the rework the same calls blocked the server for 4 to 18 s. With the server live, `GET
  /api/fleet/state` p50/p99 was 4.6/23 ms idle and 6.2/37 ms during a purge of 3.7 million rows, and capture was not
  visible in the console's latency (about 3 MiB of file growth a minute at 50 simulated sessions). The issue's example
  volume (100 sessions x 20 entries a minute x 30 days, about 86 million rows and 20 GB) was not run: these are one day,
  and everything about 30 days is an extrapolation. Removal takes proportionally longer at that size, in the
  background.
- **Limits.** It is not a complete record: the mod keeps 20 entries per loop and one report carries 60,000
  characters, so a busy session can lose entries, and nothing is replayed after an outage. The size cap compares an
  estimate of the entries' bytes, not the file's size, because freed pages stay in the file until vacuum.

<!-- nav:start -->
---

Previous: [Activity feed](08-activity-feed.md) · Up: [Components](README.md) · Next: [Session recording](10-session-recording.md)
<!-- nav:end -->
