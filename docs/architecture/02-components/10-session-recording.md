---
title: "Session recording"
description: "How a session is recorded by the mod, stored on the server with its limits and replayed in the UI."
group: "Project internals"
order: 10
---

# Session recording

Files: `server/src/storage/sqlite/recordings.ts` (the store), `recordingRoutes.ts` (the mod's and the browser's routes),
`recordingSettings.ts` (also in `server/src/storage/sqlite/`; the Admin's three limits), `sweeper.ts` (`purgeRecordings`), `mod/podium-reporter/hooks/recording.ts`
(the capture), `frontend/src/fleet/components/ReplayPage.tsx`, `RecordPicker.tsx` and `RecordingLayer.tsx`, and
`frontend/src/fleet/admin/RecordingAdmin.tsx`. Issue #353; the reasoning is DECISIONS 40, and the feature end to end is
[REPLAY.md](../../REPLAY.md). This section keeps only the structure.

- **Tables.** `rec_sessions` (one row per recording: state, limit, who started and stopped it, loops, counters) and
  `rec_entries` (one row per entry, numbered `n` in the server's order, with the mod's `loop` and `seq` and a stored time
  `t`) in `activity.sqlite`, added as schema steps of `activityDb.ts`. Indexes are `(session_id, n)` and `t`. Nothing in
  the main database references them; code removes a session's rows. The Admin's three limits are one JSON row,
  `recording_settings`, in the main `settings` table.
- **Capture path.** The mod's `Recorder` redacts, numbers (`seq` per loop), cuts and queues entries, and `register.ts`
  sends them every 5 seconds (early at 256 KB) to `POST /api/fleet/sessions/:id/recording`. The server validates the
  batch, drops an entry it holds by `(loop, seq)`, enforces the per-session cap and the disk budget as it stores, and
  answers with the grant, which the mod reads as its on and off switch. A decision, `clear` or `compact` entry is written
  by the mod, never the server, which only adds the sender of a delivered message to the mod's prompt entry.
- **The grant.** Every reply to a report carries `recording.consent` (the Admin's flag, a choice, the reporter's option).
  The report carries `session.sessionRecording`. An older mod sends none and is read as not allowing; an older server
  sends none and a newer mod reads that as off (SPEC 6.8).
- **Purge.** `purgeStored` runs the Activity history's purge and `purgeRecordings` together every 5 minutes. Expiry is per
  part (each row goes `keepHours` after it was stored), removal runs in short chunks that yield to the event loop and share
  the Activity history's turn-taking, and the file is compacted afterwards.
- **`/clear` carry-over.** A `/clear` gives the session a new id. When the first report of the new session names the old
  one in `clearedFrom`, the server moves the running recording's choice, starter and start time to the new session, for the
  orchestrator's loop, and stops the old one without a `stopped` row.
- **Reads.** The wall's `SessionView.recording` carries state and times, never text. The text is read through
  `GET /api/fleet/respond/sessions/:id/recording` (paged, newest 200 first) by the owner or an Admin. A separate
  `GET .../recording/consent` exists because `SessionView` goes to everyone and so cannot carry whether the owner allowed
  recording; the picker reads it on open.
- **UI.** The History marker and the Recording cell read the session's `recording`; the replay is a route of its own
  (`#/?open=<id>&replay`, `frontend/src/route.ts`) that pairs each result with its call by `callSeq` (`replayItems.ts`).

<!-- nav:start -->
---

Previous: [Activity history](09-activity-history.md) · Up: [Components](README.md) · Next: [Responding](11-responding.md)
<!-- nav:end -->
