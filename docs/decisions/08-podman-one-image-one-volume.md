---
title: "8. Podman, one image, one volume"
description: "The server and UI ship as one Podman image with a /data volume, with Docker supported too, at the cost of passing the health check by hand."
group: "Project internals"
number: 8
date: "2026-10-11"
status: "accepted"
order: 8
---

# 8. Podman, one image, one volume

**Decision.** The container runs under Podman (not Docker). The server and the UI ship in one image with a
`/data` volume for the SQLite file. Nothing else runs beside it.

**Why.** Podman was the stated preference for this project. There is no second service to orchestrate, so a
single image is enough. It runs as a non-root user (2026-10-11, PR #3).

**Cost.** Podman's default OCI image format drops a `HEALTHCHECK` instruction, so `podiumctl` passes
`--health-cmd` when it runs the container.

**Amended (2026-10-20).** Docker is supported as well. Podman stays the default when both are installed;
otherwise `podiumctl` uses Docker, and `--engine` chooses. Many people have Docker and not Podman, and the two take
the same arguments for everything `podiumctl` runs, so supporting both costs a few lines (see ARCHITECTURE,
Container mode).

<!-- nav:start -->
---

Previous: [7. Cost is an estimate, except the session ledger](07-cost-is-an-estimate-except-the-session-ledger.md) · Up: [Decisions](README.md) · Next: [9. podiumctl has two modes and no dependencies](09-podiumctl-has-two-modes-and-no-dependencies.md)
<!-- nav:end -->
