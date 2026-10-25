---
title: "9. podiumctl has two modes and no dependencies"
description: "bin/podiumctl is a dependency-free ES module that runs the server in a container or as a plain Node process, at the cost of two code paths."
group: "Project internals"
number: 9
date: "2026-10-11"
status: "accepted"
order: 9
---

# 9. `podiumctl` has two modes and no dependencies

**Decision.** `bin/podiumctl` is a plain ES module with no dependencies. It manages the server either in a
container (Podman or Docker) or as a standalone Node process, and saves the mode.

**Why.** Some people will have neither Podman nor Docker, and developers want a plain process. A script with no
dependencies installs with `npm link` and nothing else, and `npm link` is how an npm binary is normally
installed (PR #3).

**Cost.** Two code paths to keep working. Both are tested for real, not only in unit tests.

<!-- nav:start -->
---

Previous: [8. Podman, one image, one volume](08-podman-one-image-one-volume.md) · Up: [Decisions](README.md) · Next: [10. The token is generated on first start, and secrets stay out of argv](10-the-token-is-generated-on-first-start-and-secrets.md)
<!-- nav:end -->
