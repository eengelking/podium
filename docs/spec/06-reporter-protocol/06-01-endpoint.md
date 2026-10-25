---
title: "6.1 Endpoint"
description: "The report endpoint: request headers and body, and each response the server can send."
group: "Reference"
section: "6.1"
order: 1
---

# 6.1 Endpoint

`POST /api/fleet/report` with `Content-Type: application/json` and an optional `X-Podium-Token`. The body is
one `Report`. The server decides who sent a report from the token ([7.7](../07-server/07-07-hardening.md)).

## Responses

- `200` with this body:

  ```
  { "ok": true, "serverTime": <epoch ms>, "ackedEvents": <n>, "sessionId": "…", "liveSessions": <n>,
    "serverVersion": "…", "reporterSupport": { "min": "…", "max": "…" },
    "reporterCompat": "ok" | "outdated" | "newer" | "unknown",
    "watch": ["<agentId>" | "@orchestrator", …], "watchOutput": ["<agentId>" | "@orchestrator", …], "respond": boolean, "deliveries": Delivery[],
    "diffs": DiffRequest[], "peers": boolean, "peerDeliveries": PeerDelivery[], "peerRequests": PeerRequest[],
    "recording": RecordingGrant }
  ```

  | Field | Meaning |
  |---|---|
  | `serverVersion`, `serverBuild`, `reporterSupport`, `reporterCompat` | Explained in [6.8](06-08-version-compatibility.md). |
  | `watch` | The loops a viewer is watching right now, the orchestrator's main loop as `@orchestrator`, so the mod knows whose activity to send ([6.4](06-04-failure-and-excerpt-rules.md)). While the Admin keeps the Activity history (#432) and the session's reporter has the `activityFeed` option on, it also lists the orchestrator and every running agent, watched or not. Always empty while the Admin has the activity feed turned off. |
  | `watchOutput` | The loops of `watch` that a viewer has the feed open on right now (a live lease), when the Admin's `activity-output` flag is on (#431). A subset of `watch`: the loops the Activity history lists without a viewer are never here, so the mod captures a Bash call's output only while someone is looking. Empty while the flag is off or nobody watches; an older server sends no field, which the mod reads as empty. |
  | `respond` | Whether the server takes answers for this session now ([7.7](../07-server/07-07-hardening.md): authentication on, the Admin's `respond` and `activity-feed` flags on, and the session has an owner). The mod announces asks only while it is true. |
  | `diffs` | The file diffs the session's signed-in owner is waiting for now (`{ id, path }`, #319, [6.4](06-04-failure-and-excerpt-rules.md)), at most 4. Always empty while the Admin's `file-diff` flag is off or the session has no owner. |
  | `deliveries` | The messages and commands sent from Podium for this session that the mod has not yet given a result for ([6.2](06-02-the-report.md), [7.1](../07-server/07-01-endpoints.md)), in the order they were sent, at most 20, and always empty while `respond` is false. An answer to an ask never comes here, only through the held request. |
  | `peers` | Whether this session's orchestrator takes part in orchestrator messaging now (#347, [7.7](../07-server/07-07-hardening.md#orchestrator-messaging-347)): authentication on, the Admin's `peer-messaging` flag on, the report made with a person's token (not the admin secret), and the report's `session.peers` true. The mod offers its tools only while it is true. |
  | `peerDeliveries` | Another orchestrator's messages for this one (`kind: "message"`) and Podium's own notices about this orchestrator's messages and requests (`kind: "notice"`), oldest first, at most 20. A message comes only while the session reports itself idle (`status: "waiting"`, `waitReason` not `permission`); a notice comes in any reply. Each takes a result through the peer result route ([7.1](../07-server/07-01-endpoints.md)), never responding's. Always empty while `peers` is false. |
  | `peerRequests` | The owner's open requests about this session's reporter (an Admin's proposal, an orchestrator's request for access, a message waiting for approval), at most 20, for the toast and `/podium allow\|decline\|deliver` ([5.3](../05-mod-api/05-03-events-the-reporter-hooks.md#orchestrator-messaging-from-the-reporter-347)). Always empty while `peers` is false. |
  | `recording` | The session's recording state (#353, [6.4](06-04-failure-and-excerpt-rules.md#session-recording-opt-in-353)): `{ state: "off" \| "recording" \| "stopped" \| "limit", consent: { admin, chosen, owner }, loops, limit: "session" \| "budget" \| null, startedBy, startedAt, stoppedBy, stoppedAt, keptUntil, bytes }`. The mod captures only while `state` is `recording` and all three `consent` answers are true. `state` is `off` and `loops` empty whenever nothing is chosen or kept for this session, which is every reply while the Admin's `session-recording` flag is off or the server has no token. An older server sends no field, which a mod reads as `off`. |

- `400 { "ok": false, "error": "…", "path": "…" }` for a body that fails validation. The mod drops that report
  and logs once to debug. It never retries a 400.
- `401` for a missing, wrong, revoked or mismatched credential. The mod logs a 401 once and retries about once
  a minute.
- `409` when the session id already belongs to another owner. The mod shows "refused: session belongs to
  someone else" on its status line instead of "connecting", tells the user once (a toast and `/podium`) to
  start a new session, logs it once, and clears the message at the next accepted report.
- `413` above 512 KB.

The mod sends a **full snapshot** every time (idempotent upsert) plus the **events not yet acknowledged**. The
server never needs a previous report to understand a new one.

<!-- nav:start -->
---

Up: [6. The reporter protocol](README.md) · Next: [6.2 The Report](06-02-the-report.md)
<!-- nav:end -->
