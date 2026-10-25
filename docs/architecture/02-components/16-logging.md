---
title: "Logging"
description: "How the server's logging works, where it lives and what it keeps."
group: "Project internals"
order: 16
---

# Logging

Files: `server/src/logging/`. Issues #140 and #155. The reasoning is in DECISIONS 26. Logging is server only; the
mod's logs stay on its machine.

**Records**

- `logger.ts` makes a `Logger` whose calls are events: a stable dotted name (`report.rejected`), a message for
  people and flat fields.
- Every record has `timestamp` (RFC 3339, UTC), `level`, `message`, `event`, `service` (`podium`), `host`
  (`os.hostname()`, the container id under Podman) and `version`.
- Debug and info go to stdout, warn and error to stderr. `PODIUM_LOG_LEVEL` (default `info`) filters both what is
  printed and what is shipped.

**Formats**

| `PODIUM_LOG_FORMAT` | Output |
|---|---|
| `text` (default) | The message alone, which is what the server always printed. The events added in #140 (`quietInText`: `session.*`, `reporter.*`, `admin.*`, `sweep.removed`, `report.conflict`, `report.accepted`, `http.request`, `http.aborted`) print only at debug, so the default text output is unchanged. `auth.failed`, and `tls.*` events at warn or error, are the exception (#602): they print at their own level so an Admin sees why a reporter is refused. The info-level `tls.*` lines (`tls.listening`, `tls.ca_created`) stay quiet in text, so the default output has no line for the reporter port. `foldedInText` folds them: the first line for one event, route, source and reason prints, repeats inside 60 seconds do not, and the next line after the window carries `(N more in the last minute not printed)`. The memory is 1000 kinds, oldest dropped first. Folding is for the text output only; `json` and the shipper get every line. |
| `json` | The whole record as one line, every event at its own level. The shipper always gets this JSON record. |

**Redaction** (`redact.ts`)

`redact.ts` is the backstop for what a record may hold.

- Callers pass named fields and never a body. A field whose name contains a word such as token, secret,
  authorization, cookie, prompt, answer, activity, text or body is dropped.
- In every string, person tokens (`pdm_...`), the admin secret, the ship header values and a ship URL's password
  are replaced with `[redacted]`, control characters are removed, and a 500-character cap applies.
- After the exact-match replacement, `scrubPatterns` replaces common secret shapes in every string, the message
  and event included:
  - `Bearer` and `Basic` credentials.
  - `password`, `passwd`, `pwd`, `secret`, `token`, `api_key` and `access_key` assignments (`=`, or `:` when the
    key is quoted as in JSON).
  - URL `user:pass@`.
  - The key formats `sk-`, `ghp_`/`gho_`/..., `github_pat_`, `AKIA...`, `xox[bap]-` and JWTs.
- It skips numeric, boolean and null values and names that only contain the word (`token_count`). It reads a
  `Bearer` or `Basic` word as a credential only when it has a digit, a symbol or inner capitals.
- It reads only the first 4000 characters of a string, because the value is cut to 500 anyway and the assignment
  pattern backtracks.
- It is pattern matching with no entropy detection, so an unknown secret format is not caught.

**Shipping** (`shipper.ts`)

The shipper runs only when `PODIUM_LOG_SHIP_URL` is set. Request paths never await it.

- `push` appends the JSON line to an in-memory array and returns.
- A 1 s timer (or a full batch of 100) gzips a batch as NDJSON and `fetch`es it to `<url>/insert/jsonline` with
  `_time_field=timestamp&_msg_field=message&_stream_fields=service,host`, `Content-Type: application/stream+json`
  and the `PODIUM_LOG_SHIP_HEADERS`, with a 5 s timeout.
- A failed batch goes back to the front. Past `PODIUM_LOG_SHIP_BUFFER` lines (2000) the oldest are dropped.
- Only a 400, 413 or 422 (a batch the endpoint calls malformed or too large) drops that batch. Any other answer,
  401, 403, 404 and 5xx included, keeps it and retries, backing off from 1 s to 30 s. No full batch starts a flush
  while a retry is not due.
- The shipper reports a failure (`log.ship_failed`), a full buffer (`log.ship_dropping`), a refused batch
  (`log.ship_refused`) and the recovery once each per outage. It does so through the logger with `ship: false`,
  so those lines never feed the buffer they describe.

**Setup and emitters**

`setup.ts` reads the settings and turns a bad value into its default plus one `log.config_invalid` warning.

| Source | Events |
|---|---|
| `index.ts` | `server.start` (with the settings, never the token), `server.stop` (then up to 1 s to send what is left) |
| `requestLog.ts` | `http.request` at debug (method, path without query, route pattern, status, duration, source); `http.aborted` the same for a request the client dropped first |
| `fleet/routes.ts` | `auth.failed` (printed in text, folded), `report.rejected`, `report.accepted` at debug, `report.conflict`, `hook.rejected`, `ingest.failed`, `request.failed` |
| `admin/adminRouter.ts` | `admin.<kind>` for each Admin Log entry, with the action, source address and ids, never the entry's text |
| `fleet/fleet.ts` | `session.started`, `session.ended`, `session.deleted`, `reporter.connected` (the first time an owner, machine and reporter kind is heard, or after a silence longer than `STALE_AFTER_MS`), `reporter.silent` (when a session goes stale), `sweep.removed` |
| `fleet/sweeper.ts` | `sweeper.failed` |

The routers and the sweeper still take the old `log(line)` option, wrapped by `loggerFromLine`. A `Fleet` built
without a logger is silent.

<!-- nav:start -->
---

Previous: [People view](15-people-view.md) · Up: [Components](README.md) · Next: [Shared contract](17-shared-contract.md)
<!-- nav:end -->
