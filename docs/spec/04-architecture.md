---
title: "4. Architecture"
description: "How the three parts fit: repo layout, ports, who owns which data, and packaging, running and distribution."
group: "Reference"
section: "4"
order: 4
---

# 4. Architecture

```
 Claude Code session A  ──┐   POST /api/fleet/report (JSON, ~1/s while changing, heartbeat every 5 s)
 Claude Code session B  ──┼──────────────────────────────►  Podium server (Express, 127.0.0.1:4317)
 Claude Code session C  ──┘   (reporter mod, via $.http.fetch)     │  validate → upsert → derive → persist (SQLite)
                                                                   │
 Browser tab  ◄──────────  GET /api/fleet/stream (SSE)  ◄──────────┘  sweeper: stale / done / dropped
              ───────────► GET /api/fleet/state (first paint + resync)
```

## 4.1 Repo layout

Create exactly this layout. Do not move existing files.

```
docs/spec/                         this file
docs/architecture/                 written during the build (Phase 4 and section 10)
docs/fixtures/report.sample.json     one full valid Report (section 6); shared by mod and server tests
mockup/podium.html                   visual reference, do not edit
mod/podium-reporter/                 the Claude Code mod
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.ts                  wiring only: registers hooks, no logic
  hooks/state.ts                     in-memory session model and pure reducers
  hooks/report.ts                    builds a Report from state
  hooks/transport.ts                 queue, flush, backoff, offline buffer
  hooks/git.ts                       branch, worktree, ahead/behind, dirty
  hooks/plan.ts                      Task*/TodoWrite → plan steps
  hooks/failures.ts                  classify and excerpt failures
  hooks/models.ts                    model family, context windows, price table
  hooks/protocol.ts                  Report types (kept identical to server/src/fleet/protocol.ts)
  hooks/respond.ts                   responding from Podium (#206): asks, answers, terminal lines (pure)
  hooks/*.test.ts                    run by `claude plugin test`
server/src/fleet/
  protocol.ts                        Report + view types, validators
  ingest.ts                          Report → rows, events, blowouts, samples
  derive.ts                          SessionView, KPIs, blowout level, series
  sweeper.ts                         stale / linger / drop timers
  sse.ts                             client registry and broadcast
  routes.ts                          Express router mounted at /api/fleet
  respond.ts, respondRoutes.ts       responding from Podium (#206): the in-memory store, the mod's and the browser's routes
  peerTypes.ts, peerRoutes.ts        orchestrator messaging (#347, #412): the contract and the routes
  lockout.ts                         wrong-credential lockout shared by Admin and the sign-in to respond
  *.test.ts
server/src/storage/                  the async interfaces the server calls, and openStorage, which picks the implementation (#313)
  sqlite/                            the only adapter: schema, migrations and queries (db.ts), the stores, the lock, activity.sqlite
frontend/src/fleet/
  FleetApp.tsx, useFleet.ts (SSE + reducer), store.ts, format.ts
  components/…                       see section 8.2
  fleet.css                          tokens and layout ported from the mockup
  *.test.tsx
scripts/podium-sim.ts                simulator (has --help)
scripts/podium-smoke.sh              end-to-end smoke check (has --help)
scripts/podium-golden.mjs            captures a server's answers on every read route and every table's rows, and diffs two captures, to prove a refactor changed no behavior (#313; has --help)
scripts/promise-misuse.mjs            finds a Promise used as a value or left floating (a store call without await) in a tsconfig's files; `// promise-ok: <why>` allows a deliberate case; run over the repo by npm test (#809; has --help)
scripts/podium-respond-demo.mjs      seeds a throwaway server with waiting sessions to answer (#206; has --help)
scripts/podium-peers-demo.mjs        plays two people's reporters against a throwaway server to check messaging (#412; has --help)
scripts/podium-peers-seed.mjs        seeds one person's reporters and requests (and with --talk, conversations), and prints their token, to view My reporters and Traffic (#415, #417; has --help)
scripts/podium-peers-e2e.sh          starts a throwaway server from the checkout, seeds it, and runs real Claude Code sessions in tmux that load the mod with --plugin-dir, to try messaging end to end (#347; up and down, has --help and --dry-run)
scripts/podium-peers-e2e.test.ts     tests its help, argument checks and --dry-run
scripts/podiumctl.test.ts            tests for podiumctl (4.4)
bin/podiumctl                        command-line manager for the server (4.4; has --help)
Containerfile, .containerignore      the server and UI as a container image (4.4)
.dockerignore                        the same rules as .containerignore, for a Docker build (4.4)
```

`server/src/index.ts` mounts the fleet router and starts the sweeper. `frontend/src/main.tsx` renders:

- `FleetApp` for `#/` (the default);
- `FleetApp` for `#/board` (the same console with the kanban board in the middle, [8.1](08-ui/08-01-what-the-ui-must-do.md));
- `FleetApp` for `#/me/reporters` (the same console with My reporters under the top bar, [8.1](08-ui/08-01-what-the-ui-must-do.md));
- `FleetApp` for `#/traffic` (the same console with Traffic under the top bar, [8.1](08-ui/08-01-what-the-ui-must-do.md));
- `HistoryView` for `#/history`;
- `AdminView` for `#/admin`.

## 4.2 Ports and addresses

- Server: `PORT` env, default `4317` (already the repo's default). Binds `127.0.0.1` unless `HOST` is set.
  The container image sets `HOST=0.0.0.0` and `PORT=4317` inside the container (4.4).
- Vite dev server proxies `/api` to the server (check `frontend/vite.config.ts`; add the proxy if missing).
- Mod option `serverUrl`, default `http://127.0.0.1:4317`.

## 4.3 Data ownership

The mod owns what is true inside a session. The server owns time: staleness, lingering, dropping, series
(tokens per second, peak context, running count) and blowout severity. The UI owns presentation only. The
UI never computes anything it could not recompute from one `SessionView` (section 7.4).

## 4.4 Packaging, running and distribution

Added after the first build. `docs/architecture/` ("Running as a service") records how it was built.

### Image

`Containerfile` builds the server and the UI into one image:

- a build stage that runs `npm ci --ignore-scripts` and both builds;
- a runtime stage with the server's production dependencies, the two `dist` trees, a non-root user and a
  `/data` volume for the SQLite files (`podium.sqlite`, and `activity.sqlite` beside it when the Admin keeps the
  Activity history), the `openssl` package the server calls to make certificates (built-in TLS, [7.7](07-server/07-07-hardening.md)),
  and `EXPOSE 4317 4318`.

Nothing else is needed. There is no second service.

### `podiumctl`

`bin/podiumctl` has no dependencies and a `bin` entry in the root `package.json`. It manages the server in one
of two modes: `container` (the default when Podman or Docker is installed) or `standalone` (a Node process on the host).
Container mode uses Podman when it is installed and Docker otherwise; `--engine podman|docker` chooses.

- Commands: `build`, `start`, `stop`, `restart`, `status`, `logs`, `health`, `url`, `token`, `config`,
  `enable`, `disable`, `shell`, `rm` and `run`, and a `--help`.
- `status` exits 3 when the server is stopped.
- `--mode`, `--engine`, `--port` and `--bind` are saved in `~/.podium/config.env` (mode 0600, home overridable with
  `PODIUMCTL_HOME`).
- `--tls` (saved as `PODIUM_TLS=on`; `config set PODIUM_TLS=off` turns it off again) enables built-in TLS
  ([7.7](07-server/07-07-hardening.md)). With it, container mode also publishes the reporter port (`PODIUM_TLS_PORT`, default 4318, mutual TLS) on
  the `--bind` address and bind-mounts the host folder `~/.podium/tls` (mode 0700) at `/data/tls`, so the CA survives
  a restart, a rebuild and a removed volume, and a person can find it and back it up. After the container starts,
  `podiumctl` checks that the mount is there and warns when it is not; the server logs `tls.storage_not_persistent`
  when `/data/tls` is not on a named volume or a bind mount. Standalone mode keeps the CA in `data/tls` beside the
  database (mode 0700).
- `rm` never deletes the TLS folder by itself: it says the folder is kept and what deleting it means.
  `rm --purge-tls --yes` deletes it, and every reporter config must then be reissued.

### Network

In container mode the port is published on `127.0.0.1` unless `--bind` says otherwise. Inside the container the
server listens on `0.0.0.0`. That is the only place the `127.0.0.1` default ([7.7](07-server/07-07-hardening.md)) is not what
the server binds.

### Token

- The first `start` generates a random `PODIUM_TOKEN` and saves it in `config.env`. It is the admin secret
  ([7.7](07-server/07-07-hardening.md)): it opens the Admin section and may be used to report.
- `podiumctl token` prints it. `--rotate` replaces it, and after a restart every open Admin session is over.
  People's own tokens, which are in the database, are unaffected.
- An empty value is the deliberate "auth off" setting and is passed through to the server as empty.
- Secrets reach the server through its environment, never a command line.

### Start on boot

`enable` and `disable` write and remove a launchd agent (macOS) or a systemd user unit (Linux).

- In container mode the unit runs `podiumctl start`. In standalone mode it runs `podiumctl run` (foreground,
  restarted only after a non-zero exit, so `stop` is not undone).
- The unit names the `node` that ran `enable`. When that is a Homebrew Cellar path
  (`<prefix>/Cellar/<formula>/<version>/bin/node`), it names `<prefix>/opt/<formula>/bin/node` instead, which a
  `brew upgrade` leaves in place.
- `status` reports a unit that does not name the current script path as stale. Running `enable` again rewrites
  it.

### The mod is not containerized

The mod runs inside each Claude Code process and posts to `serverUrl`. It is installed from
`eengelking-marketplace`:

- `eengelking/skills` lists `podium-reporter` in its `.claude-plugin/marketplace.json` with a `git-subdir`
  source pointing at `mod/podium-reporter` in this repo. Use a full `https://` URL; the `owner/repo` shorthand
  clones over SSH.
- Users run `/plugin install podium-reporter@eengelking-marketplace`.
- This repo carries no marketplace file.
- The mod's version is set in `plugin.json` and in `VERSION` in `hooks/register.ts`, kept equal by
  `scripts/versions.test.ts`.
- The `token` option is `sensitive`, so it is set with `/plugin configure`, not the `/config` menu.
- `claude --plugin-dir` stays the way to work on the mod.

---

<!-- nav:start -->
---

Previous: [3. Glossary](03-glossary.md) · Up: [Specification](README.md) · Next: [5. The Claude Code mod API: everything the reporter needs](05-mod-api/README.md)
<!-- nav:end -->
