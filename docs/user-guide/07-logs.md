---
title: "Logs"
description: "Read the server's logs, choose what they hold, send them to VictoriaLogs and query them."
group: "Getting started"
order: 7
---

# Logs

`podiumctl logs` shows what the server did. Each line is an event with a fixed name, so you or an agent can search for it.

In the default text format you see what Podium always printed: its start, reports it rejected, errors and its shutdown.
A refused token or certificate prints too, once a minute for the same route, source and reason, with a count of the
repeats it held back. The other events below (sessions, reporters, sweeps, Admin changes) print in text only with
`PODIUM_LOG_LEVEL=debug`. The JSON format and the copy sent to VictoriaLogs carry every event at the level in the table.

| Event | Level | When |
|---|---|---|
| `server.start`, `server.stop` | info | The server started or stopped. In the JSON format and in VictoriaLogs, `server.start` also carries the port, database, whether auth is on, and the log and lifecycle settings |
| `report.rejected`, `hook.rejected` | warn | A report or hook payload failed validation; `reason` and `path` say why |
| `auth.failed` | warn | A request had no token, a wrong or revoked one, or a token that does not belong to the report's name |
| `auth.throttled` | warn | One address made more failed `/api` requests in a minute than `PODIUM_FAILURE_LIMIT` allows; logged once per address and minute |
| `server.test_timings` | warn | The server started with shortened idle or lock times (`PODIUM_TEST_TIMINGS=1`, for the end-to-end suite); the fields carry the times in effect. It never appears on a real server |
| `server.weak_token` | warn | `PODIUM_TOKEN` is shorter than 24 characters; the `length` field says how long. Use a longer one (`podiumctl` makes one for you) |
| `server.csp` | warn | The server could not read the page it serves to work out which inline script the content security policy allows, so none is allowed; `reason` says why |
| `tls.*` | info, warn, error | Built-in TLS. Warnings and errors (`tls.failed`, `tls.renew_failed`, `tls.handshake_failed`, `tls.http_refused`, `tls.client_refused`) print folded like `auth.failed`. Info lines (`tls.listening`, `tls.ca_created`, renewals, rotations) print in text only at `debug` |
| `report.conflict` | warn | A report for a session that belongs to someone else |
| `reporter.connected` | info | A reporter (owner, machine, mod or settings hooks) was heard for the first time, or again after a silence |
| `reporter.silent` | warn | A session stopped reporting and turned stale |
| `session.started`, `session.ended`, `session.deleted` | info | A session's first report (or its return after leaving the wall), its end (`reason` is `done` or `heartbeat lost`), or a delete |
| `reporters.forgotten` | info | The Forget old reporters setting removed reporters that had been silent for its number of days |
| `sweep.removed` | info | The sweep took ended or heartbeat-lost sessions off the wall; it names the first 10 session ids and counts the rest in `session_ids_omitted` |
| `admin.*` | info | An Admin change, named as in the Admin Log (`admin.person_created`, `admin.feature_changed`); a failed unlock is `admin.unlock_failed` at warn |
| `ingest.failed`, `request.failed`, `sweeper.failed` | error | Something broke on the server |
| `report.accepted`, `http.request` | debug | Every stored report, and every HTTP request (method, path, route, status, time; never the query string) |
| `http.aborted` | debug | A request the client dropped before the server answered (the fields of `http.request` without a status, since none was sent) |

## Log settings

Two settings change what you get. Set each with `podiumctl config set KEY=VALUE`, then run `podiumctl restart`.

| Setting | Values |
|---|---|
| `PODIUM_LOG_LEVEL` | `debug`, `info` (the default), `warn` or `error`. In text, `debug` adds the session, reporter, sweep, Admin and request lines |
| `PODIUM_LOG_FORMAT` | `text` (the default) prints each line's message, as Podium always has. `json` prints one object per line with `timestamp`, `level`, `message`, `event`, `service`, `host`, `version` and the event's fields, such as `session_id`, `route`, `status` and `reason`. A collector such as Vector or Fluent Bit can read it from the container's output |

## What is kept out of the logs

No line carries a token, the admin secret, a ship header, a prompt, an answer or activity text.

As a second guard, every piece of text in a line is scrubbed for common secret shapes, and what it finds becomes
`[redacted]`:

- `Bearer` and `Basic` credentials,
- `password=`, `secret=`, `token=` and `api_key=` values (in text, query strings and JSON),
- the password in `https://user:pass@host`,
- keys that start `sk-`, `ghp_`, `github_pat_`, `AKIA` or `xoxb-`, and JWTs.

It recognizes shapes only. A secret in a format it does not know, or one written as plain prose such as "the password is
hunter2", is not caught. It does not look at the Admin Log or stored data.

## Send the logs to VictoriaLogs

Podium can push every log line to a central platform. It is off until you give it an address, and then only the log lines
leave the machine. It was built for [VictoriaLogs](https://docs.victoriametrics.com/victorialogs/), and works with
anything that takes VictoriaLogs' JSON line ingest.

```sh
podiumctl config set PODIUM_LOG_SHIP_URL=http://host.containers.internal:9428
podiumctl restart
```

If the server cannot reach the address, its log says `log shipping to ... failed` once, with the reason.

- **The address.** In container mode the server runs inside a container, so `127.0.0.1` is the container itself. Use
  `host.containers.internal` (Podman) or `host.docker.internal` (Docker) for a VictoriaLogs on the same machine, or its
  address on your network. In standalone mode `http://127.0.0.1:9428` works.
- **The path.** Podium adds `/insert/jsonline` and the arguments that map its fields (`_time_field=timestamp`,
  `_msg_field=message`, `_stream_fields=service,host`). Give a full URL to change them.
- **Authentication or a tenant.** Set headers:

  ```sh
  podiumctl config set "PODIUM_LOG_SHIP_HEADERS=Authorization=Bearer <token>;AccountID=0"
  ```

  `podiumctl config` shows the header names and hides their values (a pair with no `=` is hidden whole).
  `--show-token` shows them. It also hides a user name or password in the URL and the values of its query arguments.
- **VictoriaLogs is down, or answers with an error** such as 401 (wrong credentials), 403, 404 (wrong URL) or a 5xx.
  Podium keeps the last `PODIUM_LOG_SHIP_BUFFER` lines (2000), drops the oldest past that, retries, and says once in its
  own log that it is dropping and again when it recovers. Reports are never held up.
- **VictoriaLogs refuses a batch as malformed or too large** (400, 413 or 422). Retrying would not help, so Podium drops
  that batch and says once that the endpoint refused it and how many lines were dropped.

## Point an agent at it

Add the [VictoriaLogs MCP server](https://github.com/VictoriaMetrics-Community/mcp-victorialogs) to Claude Code, pointed
at the same VictoriaLogs, and ask in plain words ("why were reports rejected in the last hour?"). It runs LogsQL queries
such as these:

```text
# Rejected reports in the last hour, counted by reason
_time:1h {service="podium"} event:="report.rejected" | stats by (reason) count() rejected

# One session's start and end
{service="podium"} session_id:="<session id>" event:in("session.started", "session.ended") | sort by (_time)

# Refused tokens and where they came from
_time:24h {service="podium"} event:="auth.failed" | stats by (reason, source) count() refused

# Admin changes today
_time:1d {service="podium"} event:="admin."* | fields _time, event, source, setting, on

# Sessions that went quiet, and errors
_time:1h {service="podium"} event:in("reporter.silent", "ingest.failed", "request.failed", "sweeper.failed")
```

`host` is the server's host name, which in container mode is the container's id, so it changes when the container is
recreated. Filter on `service` to see every run.

<!-- nav:start -->
---

Previous: [Everyday commands](06-everyday-commands.md) · Up: [User guide](README.md) · Next: [Sessions you started without the mod](08-sessions-you-started-without-the-mod.md)
<!-- nav:end -->
