---
title: "7.1 Endpoints"
description: "Every server route, grouped as fleet, responding and Admin routes, with its purpose."
group: "Reference"
section: "7.1"
order: 1
---

# 7.1 Endpoints

All JSON unless noted. The routes are grouped below: fleet routes (read by the console and written by the
mod), the mod's responding routes, the browser's responding routes, and the Admin API.

## Fleet routes

| Method and path | Purpose |
|---|---|
| `POST /api/fleet/report` | Ingest ([6.1](../06-reporter-protocol/06-01-endpoint.md)). |
| `GET /api/fleet/state` | Everything live plus the latest 150 events. First paint and resync. Details below. |
| `GET /api/fleet/stream` | SSE (7.3). |
| `GET /api/fleet/sessions/:id` | One `SessionView`, live or historical. 404 if unknown. |
| `GET /api/fleet/sessions/:id/agents/:agentId/text` | The agent's whole task prompt and final answer ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)). Details below. |
| `GET /api/fleet/sessions/:id/agents/:agentId/activity?every=` | A loop's activity feed ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)). Details below. |
| `GET /api/fleet/events?sessionId=&before=&limit=` | Page through stored events newest first (`limit` ≤ 200, default 50, `before` = event time). |
| `GET /api/fleet/history?day=YYYY-MM-DD&page=N&pageSize=N` | Ended or dropped sessions that day. Phase 4. Details below. |
| `POST /api/fleet/notices/:id/close` | Turn a wall notice off for everyone ([8.1](../08-ui/08-01-what-the-ui-must-do.md)). No token, like Remove. 400 for an id that is not a known notice. |
| `POST /api/fleet/update-notice/close` | Body `{ version }`: the X on the update notice hides the release it names for everyone ([6.8](../06-reporter-protocol/06-08-version-compatibility.md#the-release-check-499-mockuppodium-update-noticehtml-mockuppodium-update-check-adminhtml)). No token. 400 unless `version` is `MAJOR.MINOR.PATCH` and is not newer than the release on offer (or none is on offer), so a made-up version cannot hide every later release. |
| `PUT /api/fleet/wall/background-sessions` | Body `{ show: boolean }`: the Show them / Hide them link on the background-sessions note changes this setting. No token. 400 unless `show` is a boolean. |
| `POST /api/fleet/sessions/:id/drop` | Remove a heartbeat-lost session from the live view now: the same exit as the automatic drop ([7.5](07-05-lifecycle-timers.md)). No token. 404 if the session is not live, 409 if it is not `stale`. |
| `DELETE /api/fleet/sessions/:id` | Remove a session and its rows (for stuck test data). Requires the token if one is configured. |
| `GET /api/fleet/health` | `{ ok, dbPath, liveSessions, uptimeSec, reporterVersionsSeen, serverVersion, serverBuild, reporterSupport, sseClients, maxClockSkewMs }`. |
| `POST /api/fleet/hook` | Phase 5: classic settings-hook payloads. |
| `GET /api/fleet/peers/traffic?range=` | Which orchestrators message which, for Traffic (#347): `{ enabled, conversations, retainDays, serverTime }`. Counts and states, never the text. No token, like the other reads. Details under the messaging routes below. |

**`GET /api/fleet/state`**
- Body: `{ serverTime, config, sessions: SessionView[], kpis, clearedToday, events: ActivityView[], server: { version, reporterSupport }, wall, features }`.
- `wall` is the wall's notice and background-sessions settings ([8.1](../08-ui/08-01-what-the-ui-must-do.md)).
- `features` maps each Admin feature flag's id to whether it is on ([8.1](../08-ui/08-01-what-the-ui-must-do.md)). It also carries one
  derived entry, `activity-history` (#432), true when the Admin keeps the Activity history, a token is set and the
  `activity-feed` flag is on. It is not an Admin flag and is not in the flag list. The console reads it to offer the
  sign-in that stored history needs, and a policy change reaches open consoles as a fresh snapshot.

**`GET /api/fleet/sessions/:id/agents/:agentId/text`**
- Body: `{ prompt: string | null, answer: string | null }`.
- 404 if the server holds neither. No token, like the other reads.

**`GET /api/fleet/sessions/:id/agents/:agentId/activity?every=`**
- Body: `{ entries: (ActivityEntry & { seq })[], since, live, enabled, serverTime }`. `@orchestrator` is the main
  loop. `seq` numbers entries in the order the server took them. An entry may carry the Bash fields of
  [6.2](../06-reporter-protocol/06-02-the-report.md) (`id`, `command`, `output`, `done`, `exitCode`, `failed` and the cut flags, #431); `output`
  only while the Admin's `activity-output` flag is on. `done`, `exitCode` and `failed` are not output and are served
  with the feed whatever that flag says (#598).
- Each call takes or renews a lease on that loop for `every` seconds (5, 10, 20, 30 or 60; anything else is 5)
  plus 15 seconds. While a lease is live, the reply to each report lists the loop in `watch`.
- For a session that is not live it answers `live: false`, `since: null` and no entries, and takes no lease.
- `enabled` is false while the Admin has the activity feed turned off ([8.1](../08-ui/08-01-what-the-ui-must-do.md)). The
  reply then has no entries and `since: null`, `live` as usual, and no lease is taken.
- 404 for an unknown session or agent.
- The entries are in memory only, never in the state or the stream. No token, like the other reads.
- Under a keep policy (#432) the reply may also carry `history`: counts about this loop's stored history,
  with no text (`policy`, `total`, `since`, `keptUntil`, `canRead`, `owner`). `canRead` is true when the
  request carries a respond sign-in for the session's owner or an Admin. The reply has no `history` key
  under the default policy or when the loop has nothing stored, so it is exactly as it was.

**`GET /api/fleet/respond/sessions/:id/activity-history?loop=&before=&limit=`** (#432)
- One page of a loop's stored Activity history, oldest first: `{ entries, olderBefore, total, since,
  keptUntil }`. `loop` is `@orchestrator` or an agent id of the session, `before` is the `seq` of the oldest
  entry already shown (omit it for the newest page), and `limit` is 1 to 100 (the console asks for 20).
  `olderBefore` is the `seq` to pass for the next older page, or null.
- It needs a signed-in respond session that is the session's owner or an Admin: 401 without a sign-in, 404 for a
  session the database does not hold, 404 while the policy is *Not stored*, 403 (with `owner`) for anyone else, then
  404 for an unknown loop and 400 for a bad `before` or `limit`. It works for a session that has ended and does not
  need the `respond` flag: sign-in is open to the owner and an Admin whenever a keep policy is on and a token is
  set. `Cache-Control: no-store`. The text is never logged.

**`GET /api/fleet/respond/sessions/:id/files/diff?path=`** (#319)
- The console's request for one file's diff. It needs a respond session ([7.7](07-07-hardening.md), *File diff*),
  not just a read: this is the one read that returns source code.
- It is held until the mod answers or 15 seconds pass. `200 { path, status, text, truncated, shownLines,
  totalLines, redactions, base }`, where `status` is `"ok"`, `"binary"`, `"withheld"`, `"too-large"` or `"unavailable"`
  and `text` is a string only for `"ok"`. `504 { error: "no answer" }` when the mod did not answer.
- `401` signed out, `403 { error: "not your session", owner }` for anyone who is not the owner (an Admin included),
  `403 { error: "file diff is off" }` while a switch the server knows of is off, `404` for an unknown or
  not-live session, `400` for a missing path.
- `Cache-Control: no-store`. The text is never logged and never kept ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)).

**`GET /api/fleet/history?day=YYYY-MM-DD&page=N&pageSize=N`**
- Ended or dropped sessions that day, newest first, summary rows only (name, project, model, duration, cost,
  blowouts, end reason), one page at a time (#195). The server builds the rows of the requested page only
  (#273).
- `page` is 1 or more (default 1; a page past the end answers the last page). `pageSize` is 25, 50 or 100
  (default 50). Anything else is a 400.
- Body: `{ day, sessions, total, page, pageSize }`, where `total` counts the whole day.
- Each row also carries `clearedFrom` (the session it continues after a `/clear`) and `clearedInto` (the
  session that continued it), each null when there is none (#206, [5.8](../05-mod-api/05-08-session-identity-clear-restarts.md)).
- A row also carries `recording: { keptUntil }` (#353) when a recording of the session is held and the request comes
  from a signed-in viewer who is the session's owner or an Admin (the sign-in of [the browser routes for session
  recording](#browser-routes-for-session-recording-353)); `keptUntil` is when the oldest part still held goes, as
  `keptUntil` is everywhere else. For anyone else, for a session with no recording, and while the Admin's
  `session-recording` flag is off (the replay routes answer `404` then), the field is absent, so History tells nobody
  else that a recording exists and never points at one that cannot be opened.

## Mod routes for responding

Issue #206 ([5.3](../05-mod-api/05-03-events-the-reporter-hooks.md#responding-from-podium)). All need `X-Podium-Token` from the session's owner ([7.7](07-07-hardening.md)).

**`PUT /api/fleet/sessions/:id/diffs/:requestId`**: the mod's answer to a request in `diffs` (#319).
- Body: `{ path, status, text?, truncated, shownLines, totalLines, redactions, base }` as in the browser route's reply.
- `200 { ok: true }`, also for a request already answered or dropped (the text is discarded). `403` while the
  flag is off, `404` for a session that is not live, `400` for a body that fails validation, `413` above
  300,000 bytes.
- The text goes to the waiting browser request and nowhere else.

**`PUT /api/fleet/sessions/:id/asks/:askId`**: the mod announces an open ask.
- Body: one `Ask` ([6.2](../06-reporter-protocol/06-02-the-report.md)) whose `id` is `:askId`.
- `200 { ok: true }`, also for an ask already known. The call is idempotent, and a changed body replaces the
  stored ask while no answer to it is pending.
- `403 { ok: false, error: "responding is off" }` while the server takes no answers for this session (the
  report reply's `respond` is false).
- `404` for a session that is not live.
- `409 { ok: false, error: "closed" }` for an ask already closed.
- `400` for a body that fails validation.
- `429` past 8 open asks for one session.

**`GET /api/fleet/sessions/:id/asks/:askId/answer?wait=`**: the mod's held request for an answer.
- `wait` is 1 to 20 seconds (default 20; `$.http.fetch` gives up after 30).
- `200 { delivery: Delivery }` at once when an answer to the ask is pending (one already handed over but with
  no result yet is handed over again). Otherwise the request is held until one arrives (`200`) or `wait` runs
  out (`204`).
- `404` for an ask the server doesn't hold, such as after a restart (the mod then announces it again).
- `410 { outcome }` for a closed ask.
- `403` while responding is off.
- At most 4 held requests per ask and 200 in all. Past that, the oldest is answered `204`.

**`POST /api/fleet/sessions/:id/asks/:askId/close`**: the mod says an ask closed without an answer from Podium.
- Body: `{ outcome: "terminal" | "closed" | "ended", at, answer?, planApproved? }`:
  - `terminal`: answered in the terminal. `answer` is a short summary of what was chosen there, redacted, ≤
    2,000 chars: a question's answers joined with "; ", `No, keep planning` for a plan sent back from there,
    `allowed` or `denied` for a tool. `planApproved: true` is for a plan approved there, with no mode.
  - `closed`: closed without an answer (Esc or an aborted turn).
  - `ended`: the session ended.
- `200 { ok: true }`, also for an ask already closed or unknown.
- An answer still pending for the ask is dropped, and the modal shows why. An answer from Podium closes its ask
  through its delivery's result instead.

**`POST /api/fleet/sessions/:id/deliveries/:deliveryId/result`**: the mod says what became of a delivery.
- Body: `{ result: "took" | "queued" | "not-taken" | "refused" | "closed", at }`:
  - `took`: the session took it (for an answer this closes the ask as `podium`).
  - `queued`: a message waits for the session to be idle (a later `took` follows).
  - `not-taken`: Claude Code didn't take a plan approval. The ask stays open, and no further answer from Podium
    is accepted for it.
  - `refused`: the mod refused it ([5.3](../05-mod-api/05-03-events-the-reporter-hooks.md#responding-from-podium)).
  - `closed`: its ask had closed first.
- `200 { ok: true }`.
- `404` for a delivery the server no longer holds, which the mod ignores. The server drops a message once it
  has a final result (`took`, `not-taken`, `refused`, `closed`) and an answer once it is `refused`, so a retry
  of one of those gets `404` too. The mod, which drops a queued result on any response, does not send it again
  (DECISIONS 34).
- A repeat of the result a held delivery already has (`queued` again) gets `200`.

## Browser routes for responding

Every route except `GET /respond/me` needs the browser's respond session ([7.7](07-07-hardening.md)).

**`GET /api/fleet/respond/me`**
- Body: `{ enabled, signedIn, name, admin }`.
- `enabled`: whether responding is on for this server (authentication on and the `respond` flag on,
  [7.7](07-07-hardening.md)).
- `name` is a person's name or `Admin`. `admin` is true for the admin secret or a person in Administrators.
- No credential needed.

**`POST /api/fleet/respond/sign-in`**
- Body: `{ name, token }`: a person's name and their token, or the name `Admin` and the admin secret
  ([7.7](07-07-hardening.md)). Starts this browser's respond session.
- `200 { ok: true, name, admin }`, `name` as Admin > People spells it.
- `401 { ok: false, error: "wrong name or token" }`, which never says which of the two was wrong.
- `400` when either is empty.
- `429 { ok: false, error: "too many wrong tries", retryAfterSec }`.
- `403` while responding is off.

**`POST /api/fleet/respond/sign-out`**
- Ends this browser's respond session. `200 { ok: true }`.

**`GET /api/fleet/respond/sessions/:id/asks/:askId`**: the whole ask, for the modal.
- Body: `{ ask: Ask, state: "open" | "pending" | "not-taken" | "closed", delivery: (Delivery & { result: string | null, mine: boolean }) | null, closed: { outcome: "podium" | "terminal" | "closed" | "ended", at, by: string | null, answer: string | null, planApproved: boolean } | null, lastSeenAt }`.
- `delivery` is the answer taken for it, from whoever sent it. `mine` is whether this browser's person sent it.
- Owner or Admin only (`403 { ok: false, error: "not your session", owner }` otherwise). `404` for an ask the
  server doesn't hold.
- A closed ask stays readable until the session reports itself idle with no open ask (#208), for at most 10
  minutes, or until the same session's next ask opens.

**`POST /api/fleet/respond/sessions/:id/asks/:askId/answer`**: answers an open ask.
- Body: a `Delivery` ([6.2](../06-reporter-protocol/06-02-the-report.md)) without `id`, `askId`, `by` or `at`, of kind `question`, `reply`,
  `plan-approve`, `plan-feedback`, `allow-once` or `deny`. Owner or Admin only.
- `202 { ok: true, deliveryId }`: the answer waits for the mod, and the modal shows "Sent, not confirmed yet"
  until its result.
- Only the first answer to an ask is taken. A later one is `409 { ok: false, error: "answered", by, at }`.
- `410 { ok: false, error: "closed", outcome, at }` for a closed ask.
- `422 { ok: false, error: "not accepted", kind }` for a kind outside the session's `accepts`, one that doesn't
  fit the ask's kind, or `allow-once` for a tool whose input was cut off.
- `400` for a body that fails validation (an option index out of range, two options on a single-choice
  question, text over its limit).
- `403` when the browser isn't signed in, isn't the owner or an Admin, or responding is off.
- `404` for an unknown ask.

**`DELETE /api/fleet/respond/deliveries/:deliveryId`**: "Discard my answer".
- Drops an answer or message the mod has not been handed yet. Its sender or an Admin.
- `200 { ok: true }`. `409 { ok: false, error: "handed over" }` once the mod has it. `404` when it's gone.

**`POST /api/fleet/respond/sessions/:id/messages`**: sends a new message or a command.
- Body: `{ text }` or `{ command: "clear" | "compact" }`. Owner or Admin, with `message` (or `command`) in the
  session's `accepts`.
- `202 { ok: true, deliveryId, queued }`. `queued` is true when the session is running, so the message starts
  its turn once the session is idle.
- A text that starts with `/` is read as a command. `/clear` and `/compact` are taken as those commands.
  - Either with anything after it is
    `400 { ok: false, error: "/<name> takes nothing after it from here. Send /<name> on its own, or use the terminal." }`.
  - Any other is
    `400 { ok: false, error: "/<name> runs only in the terminal. From here you can send /clear and /compact." }`.
- `422` for a kind outside `accepts`. `429` past 20 undelivered messages for one session. `403` and `404` as
  above.
- While an ask is open, the modal sends a message in its place as a `reply` to the ask instead.
- The modal sends `/clear` and `/compact` only on their own. With anything after one it sends nothing and shows
  "/compact takes nothing after it from here. Send /compact on its own, or use the terminal." (with the
  command's own name).

## Mod routes for orchestrator messaging

Issue #347 ([5.3](../05-mod-api/05-03-events-the-reporter-hooks.md#orchestrator-messaging-from-the-reporter-347), [7.7](07-07-hardening.md#orchestrator-messaging-347)). Each needs
`X-Podium-Token` with a person's token that owns the session, the session live, its last report's `peers` true, and
messaging on (authentication and the Admin's flag). Otherwise: `401` for a wrong credential, `404` for a session that
is not live, `403` with the reason for the rest (`orchestrator messaging is off`, `a reporter on the admin secret cannot
take part`, `not your session`, `messaging is off on this machine: turn on the reporter's peers option there`). Every
refusal is `{ ok: false, error }`, the error in words the mod can show the model as is.

**`GET /api/fleet/sessions/:id/peers`**: what `podium_peers` answers.
- `200 { ok: true, peers, leftOut }`. `peers` lists the orchestrators this one can see: `{ address: "name@machine", id, duplicate, name,
  machine, os, project, status, level: "see" | "ask" | "send", paused }`. `id` is the first eight characters of the
  session id; `duplicate` is true when more than one orchestrator the asker can reach has that name and machine. `leftOut` lists the owner's reporters with no
  orchestrator listed, and why: `messaging off on the machine`, `reporter too old to message`, `no right to see it`, `no
  orchestrator running`.

**`POST /api/fleet/sessions/:id/peers/messages`**: `podium_send`.
- Body `{ to: "name@machine" | "name@machine#id", text }`, at most 128 KB. `id` is a prefix of the target's session id,
  as `podium_peers` lists it; it picks one of several orchestrators that share the name. A plain `name@machine` that
  matches more than one is a `409` that lists the `name@machine#id` forms to use (#500).
- `202 { ok: true, id, state, paused, approvalWhy, requestId, to: { name, machine }, roundTrips: { used, cap } }`.
  `state` is `sent` (the receiver is idle and gets it in its next reply), `turn` (it gets it when its turn ends) or
  `approval` (it waits for the owner; `approvalWhy` is `link` or `round-trips`, and `requestId` names the request).
  `paused` says the link is paused, so it waits for a resume too.
- `400` for a body that is not `to` and `text` strings, or an empty text. `404` for a `to` that is not one of the owner's
  live orchestrators this one can see (whoever else it may be). `409` when two orchestrators answer to that address.
  `422` to itself, or over the longest message. `403` with a right to see only. `429` over the messages per minute on
  the link. Nothing is stored for a refused message.

**`POST /api/fleet/sessions/:id/peers/access`**: `podium_request_access`.
- Body `{ to, right: "see" | "send", reason }`. `to` is one of the owner's machines, or `name@machine`.
- By the owner's default: `202 { ok: true, state: "asked", requestId, to }`, `200 { ok: true, state: "allowed", level, to
  }` or `200 { ok: true, state: "declined", to }`. An asked request's answer reaches this orchestrator as a notice.
- `400` for a bad right or a reason over 1,000 characters, `404` for a machine the owner has no reporter on, `409` for
  two.

**`POST /api/fleet/sessions/:id/peers/requests/:requestId`**: `/podium allow|decline|deliver <id>`.
- Body `{ answer: "allow" | "decline" | "deliver" }`. `200 { ok: true, outcome, level?, paused? }`. `level` is there
  only when an allow applied a right: the level the right now has, which can be higher than the request's (neither an
  allowed access request nor an accepted proposal lowers a right, even one that rose after it was made). `paused: true` is there only when a delivered
  message's link is paused, so the message waits for Resume link and `/podium deliver` says so. The request closes in
  Podium too.
- `404` unknown, `403` another owner's, `410` already answered (the error says how), `422` an answer that does not fit
  (`deliver` is for a message; `allow` for a proposal or an access request).

**`POST /api/fleet/sessions/:id/peers/deliveries/:deliveryId/result`**: what became of a peer delivery.
- Body `{ result: "took" | "queued" | "refused", at }`. `200 { ok: true }`, also for a repeat of the result it already
  has. `404` for a delivery the server does not hold for this session.
- `took` marks a message delivered. `queued` says it waits for the session to be idle (a `took` follows). `refused`
  drops it, and its sender is told. A notice is let go on any result.

**`GET /api/fleet/peers/traffic?range=live|24h|30d`**: Traffic's map and table, open to every reader.
- `{ enabled, conversations, retainDays, serverTime }`, each conversation `{ link, a, b, owner, messages, lastAt,
  state: "active" | "waiting" | "paused", paused, aToB, bToA, roundTrips }` (`a` and `b` are `{ sessionId, name,
  machine, reporterKey }`; `state` is `waiting` while a message waits for approval even on a paused link, and `paused`
  says the link is paused either way). `retainDays` is the Admin's setting for how long a conversation is kept, so
  Traffic can name it, and `serverTime` the clock Traffic counts "ago" by (#417). `live` (the
  default) keeps conversations with a live orchestrator; `24h` and `30d` those with a message in that time. While
  messaging is off, `{ enabled: false, conversations: [] }`. `400` for another range.

## Browser routes for orchestrator messaging

On responding's `/respond` router, so they need its sign-in, `X-Podium-Respond: 1` on a change, and send
`Cache-Control: no-store`. A browser can sign in while messaging is on even with responding off. Each acts on the
signed-in person's own reporters: the admin secret has none (`403`). `403` too while messaging is off.

- `GET /api/fleet/respond/peers`: My reporters in one read. `{ enabled, owner, serverTime, serverStartedAt, reporters,
  rights, defaults, limits: { server, effective }, requests }`. `reporters` are the person's mod reporters (`key`,
  `machine`, `os`, `peers`, `version`, `state`, `lastSeenAt` and `compat` as Admin > Reporters works them out, and
  `live`, its live orchestrators). `serverTime` and `serverStartedAt` time the states, as on `GET /api/admin/reporters`.
  `requests` are the open ones, each a `PeerRequest` with `fromKey` and `toKey` (the two reporter keys, so the page
  can tell apart two machines that share a name) and `messageId`. The mod's `peerRequests` carry the `PeerRequest`
  alone.
- `PUT /api/fleet/respond/peers/rights`: `{ from, to, level }`, one direction. `200 { ok: true, right }`. `403` when
  either reporter is another person's, on the admin secret, or the two belong to different people.
- `PUT /api/fleet/respond/peers/links`: `{ a, b, paused }`, Pause link or Resume link, both directions.
- `DELETE /api/fleet/respond/peers/links`: `{ a, b }`, Remove link. A message still waiting on it is dropped.
- `PUT /api/fleet/respond/peers/defaults`: any of `{ trust, onRequest: "ask" | "allow" | "decline", newSend: "ask" |
  "send", limits: { roundTrips?, perMinute?, maxChars? } }`. A limit above the Admin's is a `400`; `null` removes one.
- `POST /api/fleet/respond/peers/requests/:requestId`: `{ answer }`, as the mod's route.
- `GET /api/fleet/respond/peers/conversations?range=`: the person's conversations, as Traffic's read.
- `GET /api/fleet/respond/peers/conversations/:a/:b`: one conversation's messages with their text, oldest first, for its
  owner or an Admin (the admin secret or an Administrator). Each is `{ id, from, to, owner, text, sentAt, state,
  stateAt, why, approved }`. `403` for anyone else, `404` when there is none.

## Certificate routes (#577)

Names and shapes are confirmed in the design (DECISIONS 42). They exist only while TLS is on, and the Admin routes
need the unlocked Admin session like the rest of the Admin API.

| Method and path | Purpose |
|---|---|
| `GET /api/tls/status` | The header pill's data: `{ enabled: false }` when TLS is off, otherwise the first of the CA and the serving certificate to end (`subject`, `expiresAt`, `daysLeft`, `stage`), `renewalFailed` and `showCountdown`. No fingerprint, name or path, so it is open like the console's other reads. Reused for 30 seconds, never past the moment a certificate ends. |
| `POST /api/reporter/renew` | The reporter renews its certificate ([6](../06-reporter-protocol/06-08-version-compatibility.md#authenticating-by-certificate-577)). Authenticated by the client certificate. Body: the new public key. Reply: the new certificate, and for a planned CA rotation the added CA and its cross certificate. `429` with `Retry-After` when the person's certificate was renewed less than an hour ago. |
| `GET /api/admin/certificates` | The CA, the serving certificate, their dates and fingerprint, the names, the settings, the last renewal failure and the previous certificates. |
| `PUT /api/admin/certificates` | Change the `tls.*` settings ([7.7](07-07-hardening.md)). A value outside its range is a `400` that names the range. |
| `POST /api/admin/certificates/renew` | Renew the serving certificate now. |
| `POST /api/admin/certificates/rotate-ca` | Rotate the CA. Body `{ endOverlap }`: false is a planned rotation with an overlap, true is the hard cutover. |
| `POST /api/admin/certificates/retire-ca` | Retire the old CA after a planned rotation. Answers `409` when there is none. The reply names how many reporters were still on it (`refused`) and how many connections it closed. |
| `GET /api/admin/certificates/ca.pem` | The CA certificate, for a person who wants to check it. No key. The page no longer links it (#665). |
| `GET /api/admin/people` | Also answers `tls` (whether TLS is on) and, on each row, `certificate`: `{ notAfter, revoked }` for the person's live certificate, or the newest revoked one, and null when TLS is off or they never had one. Never a key. |
| `POST /api/admin/people` | Also returns the reporter config file, once, with the token. It cannot be fetched again. |
| `POST /api/admin/people/:id/certificate/reissue` | A new config file, once. The earlier certificate is revoked. A revoked person is restored (their token is unchanged), since a certificate for a revoked person is refused. |
| `POST /api/admin/people/:id/certificate/revoke` | Revoke the person's certificate. Their token and console sign-in are unchanged. |
| `GET /api/admin/people/:id/certificate.pem` | The person's public certificate and the CA. Never a key. |
| `POST /api/admin/people/:id/revoke-all` | Revoke the certificate and the token. Refused for the last active Administrator. |

`POST people/:id/revoke`, in the list below, is still the token's revoke, and with TLS on it also revokes the person's certificate ([7.7](07-07-hardening.md), *Revocation*).

## Mod route for session recording (#353)

Needs `X-Podium-Token` from the session's owner ([7.7](07-07-hardening.md)), like the responding routes.

**`POST /api/fleet/sessions/:id/recording`**: the mod's batch of recorded entries ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md#session-recording-opt-in-353)).
- Body: one `RecordingBatch`, `{ v: 1, sentAt, entries }`, at most 200 entries. Each entry is `{ loop, seq, at, kind,
  text, name?, callSeq?, failed?, cut?, lost? }` with `kind` one of `prompt`, `text`, `tool`, `result`, `thinking`,
  `clear`, `compact`, `gap` (`stopped` and `limit` are written by the server and refused). `text` keeps its line
  breaks and is clipped to 100,000 characters plus the cut-off marker.
- `200 { ok: true, stored, recording }`: `stored` is how many entries were new (an entry held already, by
  `(loop, seq)`, is dropped and not an error) and `recording` is the `RecordingGrant` after the batch, so a limit
  reached by this batch stops the mod at once. The entries that fit are stored, and the one that would pass the limit
  and everything after it are not; the batch is then answered with `recording.state: "limit"`.
- A recording a person stopped (state `stopped`) still takes entries whose `at` is at or before the stop time
  (`stoppedAt`), so the last batch interval is not lost; entries after it are dropped (not stored, not an error), and
  the answer is `200` with `recording.state: "stopped"`. The entries are stored after the `stopped` mark in the
  replay's order of storing.
- `403 { ok: false, error: "recording is off" }` while the three yes answers are not all true for this session,
  except for that late batch of a stopped recording; also for a recording stopped by a limit or the budget, and one
  that was deleted (nothing is stored, and the mod stops capturing). `404` for a session that is not live and has no recording, `400`
  for a body that fails validation, `401` for a missing or wrong credential, `409` as for a report, `413` above
  512 KB.
- A session that has ended is not accepted again: its recording is kept as it is.

## Browser routes for session recording (#353)

On responding's `/respond` router: they need its sign-in, `X-Podium-Respond: 1` on a change, and send
`Cache-Control: no-store`. Every one needs the signed-in person to be the session's owner or an Admin (the same test
as the Activity history, [7.7](07-07-hardening.md#activity-history-432)): `401` without a sign-in, `403` for anyone else, `404` while the
`session-recording` flag is off or the session is unknown. A recording's text is never logged.

- **`GET /api/fleet/respond/sessions/:id/recording?before=&limit=&loop=`**: one page of a replay, oldest first, as a
  `RecordingPage`: `{ entries, olderBefore, total, grant, loops, owner }`. Without `before` it answers the newest
  `limit` rows (default and most 200, `RECORDING_LIMITS.page`); `before` is the `n` of the oldest row already shown
  and `olderBefore` is the `n` for the next older page, or null. `loop` limits the page to one loop (`@orchestrator`
  or an agent id). `loops` lists every loop of the session with its name and whether it is recorded. `404` when the
  session has no recording (never chosen, deleted or expired), `400` for a bad `before`, `limit` or `loop`. It works for
  a session that has ended and when capture has stopped.
  Each row is a `RecordingRow`: `n` is the server's order, `seq` the entry's own number within its loop (the mod's, from
  1; 0 and below for a mark the server wrote), and a `result`'s `callSeq` is the `seq` of the `tool` row it answers.
- **`GET /api/fleet/respond/sessions/:id/recording/consent`**: the consent before anything is chosen, `200 { ok: true,
  grant }`, where `grant` is the `RecordingGrant` the next report would get (state `off` and `consent.chosen` false when
  no recording exists), and `keepHours`, the Admin's *Keep a recording for* value. The picker reads `grant.consent.owner`
  on open to say, before Start, that the owner has not allowed recording, and `keepHours` to say how long a recording
  is kept (it states no number until the answer arrives or if it fails). It carries no text and needs no recording to exist. The wall's `SessionView` is sent to everyone, so
  the owner's option is not put there; this route is how the owner and an Admin learn it. Same access as the rest.
- **`PUT /api/fleet/respond/sessions/:id/recording`**: start, or change which loops are recorded. Body:
  `RecordingStartRequest`, `{ loops }`, 1 or more loop ids of the session. `200 { ok: true, grant }`. Loops added
  later are recorded from that moment on; nothing before it is kept. `409` when the disk budget has no headroom (7.7) or the
  recording has stopped for its limit (`DELETE` it first to start again), `400` for a loop the session does not have.
  It does not need the reporter's option: it records the choice, and the reply's `grant.consent.owner` says whether
  the owner has allowed it, so the picker can tell the person.
- **`POST /api/fleet/respond/sessions/:id/recording/stop`**: stop capture, keep what was recorded. `200 { ok: true,
  grant }`, also for a recording already stopped. The server writes a `stopped` mark.
- **`DELETE /api/fleet/respond/sessions/:id/recording`**: delete the whole recording and stop capture. `200 { ok: true,
  entries, bytes }`; compacting the file runs in chunks as for a stored-activity delete. `404` when there is none.
- Each of the three changes is written to the Admin log with who did it ([7.7](07-07-hardening.md#session-recording-353)). The
  `grant` of a person who may not read it is never sent: the state shown on a card is the session view's
  `recording` ([7.4](07-04-view-types.md)), which carries no text.

## Admin API

The `/api/admin/*` routes ([7.7](07-07-hardening.md)):

- Session and sign-in: `GET session` (`{ enabled, unlocked, version }`), `POST unlock` (body `{ name, token }`),
  `POST unlock/from-respond` (a browser signed in to respond as an Administrator), `POST lock`.
- With an unlocked session:
  - People: `GET/POST people`, `POST people/:id/rotate`, `POST people/:id/revoke`, `PUT people/:id/group`, and
    `POST people/delete`.
    - `POST people/delete` takes `{ ids }`, 1 to 500 person ids (one id for a single person), and replies
      `{ ok, removed }`. It deletes the people and their machine list; their token stops working at once, and an
      Administrator's open Admin session locks. It refuses with `400`, deleting nobody, if the list holds the person
      signed in to Admin, or would leave the Administrators group with no active (unrevoked) member, since only an
      active member can open Admin. An id that is not a person is skipped, and `removed` counts the people it removed;
      it answers `404` if none of the ids is a person. Sessions, spend rows and Admin log entries that name a person keep the name as text, and the name can be
      created again. It writes one `person_deleted` Admin log entry per person, naming who deleted whom.
    - The People page offers it with a checkbox per row, a selection bar (**Delete N…**, **Clear**) and a **Delete**
      button on each row. Both open a confirmation dialog first. Selection is of the rows on the current page only.
  - Reports (#484, [8.1](../08-ui/08-01-what-the-ui-must-do.md#admin-layout-143-mockuppodium-adminhtml)): `GET reports/:report` for `usage`, `spend`, `people`, `sessions`,
    `failures` and `activity`, and `GET reports/retention` for the Data page's tables.
    - Query: `from` and `to` (`YYYY-MM-DD`, inclusive, at most 400 days apart, `to` not after today), `by`
      (`day`, `week` or `month`; weeks start Monday), and `person`, `group` and `model` where the report has them.
      A bad value is a `400`.
    - Reply: `{ report, from, to, by, tz, basedOn, oldestDay, columns: [{ key, label, unit }], rows, total }`.
      `oldestDay` is the first day the rollups hold (today when there are none yet). `partial` is `true` whenever `from` is
      before it: a period wholly before it has `rows: []`, and one that straddles it returns the rows from `oldestDay`
      on, so the page says so instead of drawing zeros. `basedOn` is `rollups`, `rollups and live` or `admin log`. A figure that is unknown is `null`, not 0.
    - `format=csv` returns the same `columns` and `rows` as text (RFC 4180, a header row, a cell that starts with
      `=`, `+`, `-` or `@` prefixed with `'`), `Content-Disposition: attachment`. The page's JSON export is the
      reply itself, so an export always matches the screen.
    - Today is read from the live tables, and every earlier day from the rollups.
    - **Columns.** Every report's `rows` are objects, and `columns` names their keys in order. `period` is the bucket's
      first day (`YYYY-MM-DD`, or `YYYY-MM` for `by=month`). A money field is `null` when no priced model was
      involved. `breakdown` is a query value that adds a `key` column.
      - `usage`: `period, people, reporters, sessions, peakLive`. `reporters` is the most reporters heard from on any one day
        in the bucket (a rollup holds a count per day, so a distinct count over a week is not possible). `total` has the same keys over the whole period
        (`people` and `reporters` counted once, `peakLive` the highest).
      - `spend`: `breakdown` is `none` (default), `person`, `group`, `model` or `project`. Rows: `period, key, sessions,
        tokIn, tokOut, costUsd, unpricedSessions`. `key` is absent for `none`.
      - `people`: one row per person, no `period`: `person, group, sessions, lastReportAt, state` (`active` reported in the
        period, `quiet` known but not in the period, `never` never reported). The reply also carries
        `summary: { people, groups, reporters, reporterVersions: {version: count}, engineVersions: {version: count} }`.
      - `sessions`: `breakdown` is `outcome` (default), `model`, `effort` or `plan`. Rows: `period, key, sessions,
        avgDurationS, maxDurationS, agentsPerSession, blowouts, maxContextPct`.
      - `failures`: `breakdown` is `class` (default), `tool` or `person`. Rows: `period, key, count, people` and, while the
        stored sessions still exist (30 days), `sessionIds` (at most 10) for the History link.
      - `activity`: read from `admin_log`, not the rollups; `kind` filters. Rows: `t, kind, detail, source`, newest first,
        at most 1,000. It has no `by`. `truncated` is `true` when the log held more than 1,000 entries in the period, and
        the page then says "Showing the newest 1,000 entries. Narrow the period or filter by kind to see the rest."
      - `retention`: `{ tables: [{ name, rows, oldestDay, keptDays }], detail: [{ name, keptDays }] }`.
      - An empty person, group, model or project is `-` in every `key` and in the filters.
      - `spend/projection` (`horizon=month|30d`, `window=7|14|30`, default 14, `by=person|group`): rows `key, runRatePerDay, spentThisMonth, projected` (`null` for both `runRatePerDay` and `projected`
        when there is too little history, with `reason: 'history'`), a `total` row of the same keys, and the reply carries
        `window: { from, to, days }`, `horizon`, `unpricedSessions` and `historyDays`.
      - `spend/today/:owner`: `total` and, each adding up to it, `bySession: [{ id, name, model, costUsd, share }]`,
        `byModel: [{ model, costUsd, share }]`, `bySource: { orchestrator, agents }`; `unpriced` is the count of sessions
        left out. For a group, `byPerson: [{ owner, costUsd, share }]` comes first and the route takes `?group=1`.
    - `GET reports/spend/today/:owner` (#482) returns `{ owner, total, bySession, byModel, bySource, unpriced }` for
      the breakdown, and `GET reports/spend/projection` (#483) the projection; both are described under *Spend*.
    - A report with names in it (person, group, model, project) returns them as text.
  - Groups: `GET/POST groups`, `DELETE groups/:id`.
  - Reporters (the Reporters page, [7.7](07-07-hardening.md), [8.1](../08-ui/08-01-what-the-ui-must-do.md)): `GET reporters`,
    `GET reporters/:key`, `DELETE reporters/:key`, and `POST reporters/remove`.
    - `POST reporters/remove` removes many at once: `{ keys }` of 1 to 500, `{ state }`, or
      `{ match: { q?, state?, admin? } }` for every reporter a filter holds. It replies `{ ok, removed }`.
    - `GET/POST reporters/ignores` (the ignore rules, `{ kind, pattern }`) and
      `DELETE reporters/ignores/:id`.
  - `GET/PUT settings`:
    - the admin-secret switch;
    - the feature flags: `features` lists `{ id, name, description, on }` and a change sends
      `{ features: { <id>: boolean } }` (an unknown id is a 400);
    - the wall notice switches and the background-sessions setting;
    - `forgetReporters` (`{ enabled?, days? }`; days a whole number from 1 to 3650);
    - the model prices: `modelPrice` `{ key, std, long? }` saves one model, `resetModelPrice` `key` removes the
      change;
    - orchestrator messaging (#347): `peerMessaging` `{ roundTrips, perMinute, maxChars, retainDays }`, whole numbers
      from 1 to 100, 1 to 60, 1 to 20,000 and 1 to 365 (defaults 10, 6, 20,000 and 30), any of them in one change,
      written to the Admin log as `peer_limits_changed`;
    - the Activity history (#432): the reply's `activityHistory` is `{ settings: { policy, n, unit, capGb },
      totals: { entries, bytes, sessions, fileBytes }, lastPurge: { at, entries, bytes } | null, authOn }` (`bytes` is
      the entries' estimated size, `fileBytes` the file's pages in use, for "on disk"), and a change sends
      `{ activityHistory: { policy, n, unit, capGb } }`. `policy` is `default`, `after`, `end` or `all`; `unit` is
      `hours`, `days`, `weeks` or `months`; `n` is 1 to 3650 and `capGb` is null or 1 to 1000. A keep policy is a 400
      while the server runs without a token. A change is written to the Admin log as `activity_history_changed`.
  - The Activity history (#432, [6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)):
    - `POST activity-history/preview` (`{ settings }`): what saving those settings would do now without doing it.
      For a keep policy, `{ entries, bytes, sessions, stopsCapturing: false }` is an estimate of what the purge would
      remove (counts by index, bytes from each session's average entry size), and `sessions` is the number of sessions
      that would lose at least one entry. For `default`, it is what is stored now, with `stopsCapturing` true when
      anything is stored. `bytes` is always the estimate of the entries' size, never the file's.
    - `GET stored-activity?page=&pageSize=&q=&loop=&project=&owner=&olderThanDays=&from=&to=`: the stored sessions
      (`{ total, page, pageSize, rows, totals, match, projects, owners }`; a row is `{ sessionId, name, project, owner,
      live, entries, bytes, oldestAt }`). `loop` is `all`, `main` or `agents`; `from` and `to` are epoch
      milliseconds on the server's clock. `match` is what the filter matches, for "Delete all N that match". When a
      filter changes which entries count (`loop`, `olderThanDays`, `from`, `to`), `bytes` is an estimate from each
      session's average entry size. A bad value is a `400`.
    - `POST stored-activity/delete` (`{ ids }` of at most 200 sessions, or `{ match: <filter> }`, or `{ all: true }`;
      an empty filter is a `400`): removes the entries, compacts the file, and answers `{ entries, sessions,
      bytes, freed }`, where `sessions` is the number of sessions that lost at least one entry, `bytes` the estimate of
      the entries' size and `freed` what the file gave back on disk. It writes one `activity_deleted` entry to the Admin log with the count, the size and how
      the entries were chosen, and never the entries' text.
  - Session recording (#353, [6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md#session-recording-opt-in-353)):
    - the settings reply carries `recording`: `{ settings: { keepHours, budgetMb, sessionMb }, totals: { recordings,
      bytes, running }, authOn }`, and a change sends `{ recording: { keepHours?, budgetMb?, sessionMb? } }`:
      `keepHours` 1 to 168 (default 6), `budgetMb` 64 to 102,400 (default 4,096), `sessionMb` 8 to 4,096 (default 512,
      and not above `budgetMb`). A value outside its range is a `400`. A change is written to the Admin log as
      `recording_settings_changed`. The defaults are set from measurement ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md#session-recording-opt-in-353)).
    - the flag itself is `session-recording` in `features`, like any other, and turning it on is a `400` while the server
      runs without a token.
    - `GET recordings?page=&pageSize=&state=&q=`: the recordings, running or kept, as `{ total, page, pageSize, rows,
      totals }`; a row is a `RecordingAdminRow`: `{ sessionId, name, owner, startedBy, state, limit, loops, label,
      bytes, keptUntil }`. `state` is `recording`, `stopped` or `limit`. The Stored activity page lists the same
      recordings through its Source filter, and its delete works on them as on any stored activity.
    - `POST recordings/:sessionId/stop` and `DELETE recordings/:sessionId`: as the browser routes, for any session.
      Each is written to the Admin log (`recording_stopped`, `recording_deleted`) with the Admin as the one who did it.
      The Admin's table asks first, in the warning-bordered confirmation box.
  - Orchestrator messaging on a reporter (#347): `GET reporters/:key/peers` (`{ reporter, peers, trust, rights,
    effective, requests }`: its reporter, the owner's reporters, the owner's Trust my own reporters, and the stored and
    effective rights and open requests of every pair of the owner's reporters, each request as the owner's read lists
    it, with `fromKey`, `toKey` and `messageId`, so Admin > Reporters draws the whole Grid in one read, #416),
    `POST reporters/:key/peers/propose`
    (`{ from?, to, level }`, a proposal the owner must accept, `202 { ok, requestId }`; `409` for a level at or below
    the stored right, since a proposal only raises one), `PUT reporters/:key/peers/pause`
    (`{ paused }`, Pause all links, at once) and `DELETE reporters/:key/peers/:other` (removes that link, at once).
  - `GET peers/conversations?range=` and `GET peers/conversations/:a/:b`, as the browser's reads, for every owner.
  - `GET log`.
- Lists take `page`, `pageSize` (default 50, at most 100) and, for people and reporters, `q`, and return
  `{ total, page, pageSize, rows }`. The reporters list also takes `state`, `sort` and `dir` and adds `counts`
  and `serverTime`.

<!-- nav:start -->
---

Up: [7. The server](README.md) · Next: [7.2 Database (SQLite)](07-02-database.md)
<!-- nav:end -->
