---
title: "Running as a service"
description: "How podiumctl runs the server as a container or a standalone process, and how secrets, boot and the mod fit."
group: "Project internals"
order: 10
---

# Running as a service

`bin/podiumctl` (plain ESM, no dependencies, `bin` entry in the root `package.json`) manages the server in one of
two modes, chosen with `--mode` and saved in `~/.podium/config.env`. The reasoning is in DECISIONS 8 to 11.

## Container mode

- `Containerfile` is a two-stage Node 26 build. The build stage runs `npm ci --ignore-scripts` and both builds. The runtime stage
  has production deps for `server`, the two `dist` trees, user `node`, and the `/data` volume.
- The engine is Podman or Docker (`--engine`, saved as `PODIUMCTL_ENGINE`; default Podman if it is installed, else
  Docker). Every command takes the same arguments on both, so `podiumctl` only swaps the binary. Three differences
  are handled: it checks for the image with `image inspect` (Docker has no `image exists`), it starts a stopped
  Podman machine on macOS and Windows but only reports a stopped Docker daemon, and under Docker it adds
  `--add-host host.docker.internal:host-gateway` so the container can reach the host on Linux as it can on Docker
  Desktop. Docker does not read `.containerignore`, so `.dockerignore` holds the same rules and a test keeps them equal.
- `podiumctl` runs it as `podium` with `--restart unless-stopped`, the port published on the chosen bind address,
  the named volume `podium-data`, and a `--health-cmd` (the `HEALTHCHECK` instruction is dropped by Podman's
  default OCI image format).
- It also passes the host's time zone as `TZ`, so the day for "Est. cost today" is the host's.
- Inside, the server binds `0.0.0.0:4317`. The host-side bind is where access is limited. With built-in TLS on it
  also binds `0.0.0.0:4318` for reporters (mutual TLS only), published the same way, and the image carries the `openssl` package (#580). `podiumctl`
  publishes `4318` and mounts the host folder `~/.podium/tls` at `/data/tls` (`:U` under Podman, so the `node` user owns
  it) only when TLS is on, so the CA outlives the container and the volume. After `run` it reads the container's mounts
  and warns when `/data/tls` is missing; the server checks `/proc/self/mountinfo` and logs `tls.storage_not_persistent`
  when `/data/tls` is not on a named volume or bind mount (the anonymous volume the image's `VOLUME /data` makes does not
  count, since removing the container removes it). `rm` keeps the folder unless `--purge-tls --yes`.
- Container mode relies on `podman run` or `docker run` failing when the port is taken.
- A standalone `start` refuses while a `podium` container runs under either engine, not only the saved one.

## Standalone mode

- It starts a detached `node server/dist/index.js` with a pid file and `~/.podium/podium.log`.
- The pid file is only trusted if that pid's command line is `podiumctl` or the server entry, so a reused pid is
  never signalled.
- Under the boot service, `podiumctl run` writes its own pid (not the server child's), so `stop` reaches its
  SIGTERM handler and the service does not restart the server.
- `start` refuses to spawn when something already accepts connections on the bind address and port. It only
  reports success for the process it spawned: if that process exits while `start` waits, it removes the pid file
  and shows the tail of the log.

## Secrets, boot and the mod

- Secrets reach the server through the process environment (`podman run -e NAME` or `docker run -e NAME` with no value), never the
  command line. The token is generated on first start. An empty `PODIUM_TOKEN` is the deliberate "auth off"
  setting.
- `enable` writes a launchd plist (macOS) or systemd user unit (Linux). The unit calls `podiumctl start`
  (container; idempotent) or `podiumctl run` (standalone; foreground, restarted only on a non-zero exit, so
  `stop` is not undone).
- The reporter mod is not containerized. It runs inside each Claude Code process and posts to the server's URL.
  It is installed from `eengelking-marketplace` (39). Its `token` option is secret, so it is set with
  `/plugin configure`, not the `/config` menu.

## Verified

On macOS with Podman 6.1.2: build, start, token enforcement (401 without, accepted with), non-root user, restart,
stop, standalone start/stop, `run` plus SIGTERM, launchd enable/disable in both modes, purge, and
`claude plugin install podium-reporter@eengelking-marketplace` against the live marketplace with a clean config
directory. The systemd path is covered by a unit test of the generated text only (known issue 12).

On Linux with Docker 29.8.1 and no Podman (2026-10-20): the engine is picked and saved, `build` (and `start` with no
image), start, status, health, token enforcement, non-root user, dropped capabilities, `host.docker.internal`,
`logs`, restart, stop, the standalone guard against a running container, `docker run` failing on a taken port, and
purge. Boot units were not tried with Docker. A systemd user unit cannot wait for the system `docker.service`, so at boot
`podiumctl start` can run before the daemon is up and fail; the container itself still comes back through
`--restart unless-stopped` once the daemon starts.

<!-- nav:start -->
---

Previous: [Phase log](09-phase-log.md) · Up: [Architecture](README.md)
<!-- nav:end -->
