---
title: "7.3 Ingest rules and derivation"
description: "What the server does with each valid report, and the values it derives from it."
group: "Reference"
section: "7.3"
order: 3
---

# 7.3 Ingest rules and derivation

Modules: `ingest.ts` and `derive.ts`.

On a valid report, in one transaction:

1. Upsert the session (`last_seen_at = serverTime`, never the reporter's clock; store clock skew `sentAt − serverTime` for debugging). A report with `status: 'done'` sets `ended_at`. `started_at` is set once, when the session is first stored: from a report, the reporter's `startedAt` if it is within 2 minutes of `serverTime`, otherwise `serverTime`; from a settings hook, `serverTime`. Later reports never change it, and rows stored before this rule keep their value. Under Claude Code's background daemon the engine's `usage().startedAt` can be one shared host-level value, so sessions that began minutes apart reported the same start (#43).
2. Upsert every agent. An agent absent from a later report is **not** deleted (a reload may lose it); it stays as last reported, and if it was `running` and the session is `done`, mark it `aborted`.
3. Insert events with `INSERT OR IGNORE` on `id`. Insert a `blowouts` row for each `blow` event carrying `data.kind`.
4. Sample: compute `tokens_total` (main loop tokens + Σ agent tokens), `tokens_delta` against the previous sample (≥ 0), `peak_context = max(session context %, max over running agents' context %) / 100`, `running_agents`. At most one sample per session per second.
5. Broadcast the changed `SessionView` and new events over SSE, throttled to one `session` message per session per 500 ms.

**Blowout level** (the signal, computed in `derive.ts` and tested): `total = session.blowouts + Σ agent.blowouts`.

- `level = 0` if total is 0.
- `level = 2` if the orchestrator has ≥ 2 blowouts, or any single agent has ≥ 2, or total ≥ 3.
- Otherwise `level = 1`.

Level 2 is the red "likely losing context" state. Level 1 is the amber "context exceeded" state.

**Compactions** (#805): `compactions` on the view is the number of the session's stored `compact` events, of any loop, whose
`data.trigger` is `"auto"` (5.3: an automatic compaction below 80% fill is logged as a `compact` event, not a blowout). It is counted from
`events` when the view is built, not from a column, so it needs no migration and no change to the report. A blowout is never counted
here, and a manual or plugin compaction has no `trigger` of `"auto"`. The count lives as long as the session's events (the events
retention, 30 days by default, the same as sessions). A reporter older than the one that logs early compactions as `compact` events
sends them as blowouts, so it shows no pill.

**KPIs:**

- Live orchestrators.
- Counts running, waiting and stale. A waiting session idle on background work (#119) is not in `waiting`.
- Subagents running and agents total.
- Plan steps done/total across live sessions.
- Est. cost today: the sum of what each session, live or ended, spent since local midnight on the server
  (#139).
  - A session that started today counts whole.
  - One that started earlier counts the share of its cost that came after the ledger's last sample before
    midnight. One with no such sample counts what it spent since its first sample (#276).
  - One that now reports no ledger cost (a local model) counts its cost now minus the cost of the usage on its
    last sample before midnight, priced with the Admin's prices (#286), and nothing today when no sample kept
    usage.
- The same sum split by owner with each owner's group (`costTodayByOwner`, largest first, an owner of `null`
  for sessions with none).
- Tokens in the last 60 s (Σ `tokens_delta`).
- Total blowouts, with the count of sessions at level 2.
- Sparkline series for cost-per-minute and tokens-per-second, 60 points. The cost-per-minute series is priced
  like every other cost figure (#270): each sample's `usage_json` is repriced with the Admin's prices, so a
  price change moves the sparkline with the cards. Samples from a reporter that sends no usage keep the
  ledger's `cost_usd`, and where the two kinds meet in one window that step counts as zero.

<!-- nav:start -->
---

Previous: [7.2 Database (SQLite)](07-02-database.md) · Up: [7. The server](README.md) · Next: [7.4 View types](07-04-view-types.md)
<!-- nav:end -->
