---
title: "39. The Admin can keep the activity feed, in a second SQLite file (#432)"
description: "The Admin can choose to keep the activity feed in a second SQLite file under one global purge policy, at the cost of an incomplete record and more data stored."
group: "Project internals"
number: 39
date: "2026-10-20"
status: "accepted"
order: 39
---

# 39. The Admin can keep the activity feed, in a second SQLite file (#432)

**Context.** DECISIONS 24 kept the feed in memory, only while someone watched, because the question it answers is about
now. A person who wants to look back at what a session did, after they closed the window or after it ended, could not.
The Admin also needs a way to clear it: to stop keeping it, to remove something private that leaked, or to save space.
#353 (recording and replay) needs the same store, purge job and manage screen, so the choices here are shared with it.

**Decision.** The Admin chooses one global policy in Admin > Server > Data: *Not stored* (the default, and today's
behavior), *purge after* a number of hours, days, weeks or months, *purge when the session ends*, or *keep everything*,
with an optional size cap that removes the oldest entries first (`docs/spec/` 6.4).

- Entries go to a second SQLite file, `activity.sqlite`, beside `podium.sqlite`, with its own schema version, WAL and
  incremental auto-vacuum. The policy is one JSON row in the main `settings` table.
- Capture needs no viewer: under a keep policy the server lists every running loop of a session whose reporter has
  `activityFeed` on in `watch`. The mod needs no change and the report format is unchanged.
- Every entry is stored, including the answers and messages sent from Podium, each with its marker. The redaction done
  before sending is kept as it is, with no second pass.
- A purge runs every 5 minutes and writes one admin log row per run that removed something. The hourly retention also
  removes the entries of sessions the main database no longer holds, so the shorter of the two retentions wins.
- The Admin reads and deletes through Data and Stored activity. Deleting is by ticked sessions, by a filter (including a
  range of dates) or everything, asks first, compacts the file and is written to the admin log with counts and sizes.
  There is no per-entry delete.
- Stored text can be read only by the session's owner and an Admin, through a signed-in browser. A keep policy needs a
  token on the server.

**Why.**

- A separate file keeps a large, fast-growing table out of the main database, so its backups, vacuum and the hourly
  retention are not slowed by it, and deleting everything can give the space back without touching sessions, History or
  settings.
- Deleting rows does not shrink a SQLite file. Auto-vacuum in steps plus a WAL checkpoint after each removal returns
  the space without one long blocking `VACUUM` on the main database.
- Listing every running loop reuses the mechanism DECISIONS 24 built, so no protocol or mod change is needed.
- Reads are narrower than the console's open reads because stored text can hold anything an agent read or ran, and the
  Admin, who runs the server and can delete it, can read it too.

**Alternatives.**

- A table in `podium.sqlite`. Rejected: one file holding months of entries grows large and slows backups, vacuum and the
  hourly retention. A second file has the same dependency.
- An external store. Rejected: a new dependency and another place to secure, with no benefit at this size.
- A per-project or per-owner policy. Left out: start global; a scope can be added to the same form.
- A second redaction pass on stored text. Left out: the text is already cut and redacted, and the read rule and the
  warning carry the rest.
- Per-entry delete. Left out: finding one entry needs searching inside stored text, which the issue excludes. A date range
  reaches the minutes of a leak without it.

**Cost.**

- It is not a complete record. The mod keeps 20 entries per loop and one report carries 60,000 characters, so a busy
  session can lose entries or a whole loop's feed, and nothing is replayed after an outage.
- Reporters send more and the server stores more while a keep policy is on. The Admin is told before saving.
- Compaction takes time on a large file; it runs in bounded steps and a delete says how much it freed.
- A backup made before a delete still holds what was deleted.
- The size cap counts an estimate of the entries' bytes, not the file's size, because freed pages stay in the file until
  vacuum.
- Choosing *purge when the session ends* with a restart: a session that has not ended stays live and keeps its history.
- A load test found that scanning the table for the Stored activity list, the preview, a purge or a delete blocked the
  server for 4 to 18 s on one day of the issue's example volume (14.4 million rows). The store therefore keeps per-session
  aggregates and removes in chunks that yield to the event loop. The cost is that a very large removal takes longer in
  total (a delete of 2.46 million rows took 33 s against 14 s all at once), that a window-filtered list and the preview
  are estimates or slow-but-not-blocking, and that a delete request waits until its removal is done. The 30-day volume was
  not run.

<!-- nav:start -->
---

Previous: [38. The Plan list ends with the done steps, in the order the server saw them finish (#454)](38-the-plan-list-ends-with-the-done-steps-in-the-order.md) · Up: [Decisions](README.md) · Next: [40. A session can be recorded whole, with three yes answers (#353)](40-a-session-can-be-recorded-whole-with-three-yes.md)
<!-- nav:end -->
