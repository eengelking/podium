---
title: "48. End-to-end tests run Cypress from an e2e folder against the built server (#782)"
description: "Cypress lives in its own e2e/ folder and drives the built server with a fixed-data seed; every feature change must update its specs."
group: "Project internals"
number: 48
date: "2026-10-28"
status: "accepted"
order: 48
---

# 48. End-to-end tests run Cypress from an e2e folder against the built server (#782)

**Context.** CI ran unit tests (vitest with jsdom) and the build, and nothing exercised the real console in a browser, so a change could pass every check and still break a page (#787 was found that way). jsdom does no layout, so several tests only read `fleet.css`. The maintainer asked for a suite that covers every feature and for a process that keeps it true. #403 and #782 asked for the same platform; #403 was closed in favor of #782.

**Decision.** End-to-end tests are written with Cypress and run in GitHub Actions.

- **Cypress runs in a container, never on the host.** Specs run from the official `cypress/included` image, pinned by version and digest, with `e2e/` mounted in. Nothing installs Cypress with npm and nothing downloads its binary onto a developer's machine or into the CI runner's npm cache. The specs are plain JavaScript so `e2e/` needs no dependency. This was changed from "Cypress from npm in `e2e/`" on 2026-10-28, after the maintainer objected to a Cypress install on their machine.
- **Where it lives.** `e2e/` holds the config, support files and specs. It is not a root workspace and has no Cypress dependency, so `npm ci --ignore-scripts`, `npm test`, `npm run build` and the SonarCloud job never see Cypress. `e2e/**` is excluded from Sonar's coverage and duplication measures.
- **What it tests.** The built UI served by Podium's own image (`podiumctl build`, from the `Containerfile`, as users run it), in a container on a private container network beside the Cypress container, with a database file in a temp folder. No port is opened on the host except what the seed script needs. The engine is Podman or Docker (`podiumctl` supports both), so the same scripts run on a Mac with Podman and on `ubuntu-latest` with Docker. Not Vite and not `tsx`.
- **Readiness.** The job polls `GET /api/fleet/health` and the first spec asserts the server version equals `package.json`'s, so a stale build fails loudly. No fixed sleeps.
- **Data.** A fixed-data seed script puts fixed session ids, names, models, costs, plans, agents, changed files, people and tokens in through the server's own HTTP routes. The simulator is time-driven and is used only for "something is live" smoke checks. State is reset by restarting the server on a wiped database file before each spec file, and specs never share a server in parallel.
- **Secrets.** The admin secret is generated per run, masked in the log and passed to Cypress as an environment variable; sign-in uses `cy.request` and does not type it into a field. Video is off. Failure screenshots are kept 7 days and the server log is uploaded only after a scrub step, because the repo is public and artifacts are world-readable.
- **Flakiness.** `retries: 0`, no `cy.wait(ms)`, no assertion on a clock-derived value, animations off in the support file, long `LINGER_MS` and stale values in the seed environment, and a retrying assertion for any live count. A pass means five consecutive green runs on one commit.
- **Test ids.** The frontend has almost no `data-testid`. Specs need them, so adding a `data-testid` (and a seed id the spec can select without a random suffix) is part of the work and changes nothing a person sees. A spec uses an ARIA role and name where one exists and a `data-testid` where not.
- **When it runs.** Locally, with `npm run e2e`. The `E2E` workflow exists but is manual only (`workflow_dispatch`): a first run on a GitHub runner timed out on the first page load of several spec files, and the maintainer took it out of the pipeline until the suite runs well locally. The intent, when it is stable, is a PR into `development` that touches `frontend/`, `server/`, `mod/`, `e2e/` or the workflow, and always the release PR (`development` to `main`), with `E2E summary` required for the release PR; both are the maintainer's step.
- **Keeping it true.** The `podium-e2e-update` skill and the `podium-e2e-keeper` agent run on any feature change, update the specs and the coverage map and run the suite to green. `docs/e2e/COVERAGE.md` maps every feature to its specs, and a check in `npm test` fails when the map names a file or route that no longer exists.
- **Left out.** The Admin idle lock, the Respond sign-in idle end and the sign-in lockout need their timings to be reachable and are tracked in #791. A test-only timing knob is not added here. The History page has no spec page and is tracked in #792. Real TLS and the reporter mod inside Claude Code stay out (`npm run test:mod`).
- **Fullscreen.** Wall mode's real Fullscreen API is refused in the image's Chrome. The spec tries it first: `requestFullscreen` is called from the click, `document.fullscreenElement` stays null (Cypress's clicks are not a user gesture, and the console runs in Cypress's iframe), and the console stays in wall mode as the spec says a refusal must. The other wall-mode specs stub `requestFullscreen` and the fullscreen state and assert the app's own handling (collapse, Esc, Exit, the browser leaving fullscreen, the idle hide). The coverage map records that the real call is only checked by hand. Confirmed by the first run on 2026-10-28.
- **How the runner reaches the server.** The two containers share a private network of their own, and the server keeps a fixed address on it, because the browser and Cypress's proxy cache a name's address and the server container is recreated for each spec file. The specs ask `scripts/e2e-up.sh` to restart, pause or resume the server by writing a request file into a mounted folder, so the Cypress container holds no engine socket and nothing listens on the host. The seed runs in Podium's own image on the same network. The server's `Host` check is satisfied with `PODIUM_ALLOWED_HOSTS` set to the container's name, and Chrome is told to treat that http origin as secure so the clipboard works. The Google Fonts stylesheet is answered with an empty one, so a run needs no internet.

**Why.**

- Only a real browser can check layout, focus, contrast, target size, theme switching, `EventSource` reconnect and a card changing with no reload.
- A separate folder keeps the unit-test install and the Sonar scan as light as they are.
- The built server is what users run. Vite and the container add differences without finding more UI bugs.
- A fixed seed and a restart per spec file make a spec depend on data, never on timing.

**Alternatives.**

- Playwright was not weighed in this entry, because the maintainer asked for Cypress (#403). `scripts/page-shot.mjs` stays for 400 px screenshots.
- Cypress in the root `devDependencies` puts it in every `npm ci`, the lockfile, Dependabot and Sonar's dependency scan.
- Cypress from npm in `e2e/` was the first choice and was dropped: it puts a binary of several hundred MB in a per-user cache outside the repo.
- Plain Node for the server, with Cypress in a container reaching it on the host, needs the server bound to every interface and `host.containers.internal` allowed. It opens a port on the machine and differs from what users run.
- The simulator as the seed makes every assertion depend on the clock.

**Cost.**

- The Cypress image, `docker.io/cypress/included:16.2.0` pinned at `sha256:c196ed896aec24c7ea8fc1d4185b210493e311339b6c09d0153f9b8dfc6a6058` (Cypress 16.2.0, Chrome 156, Node 24; a multi-architecture index with amd64 and arm64 variants), is 2.5 GB on disk. It runs natively on Apple silicon under Podman with no emulation, and the same pin runs on `ubuntu-latest` with Docker. Changing the version means changing the digest in `scripts/e2e-up.sh` and this line on purpose. An image build of Podium on each run is cached by the engine's layer cache.
- A CI job of several minutes on every app-touching PR.
- Every feature change now carries e2e work, which is the point and is also a cost.
- Cypress 16 removed `Cypress.env()`; the specs read the admin secret with `cy.env()`. Node's version no longer matters to Cypress, because the image carries its own.
- `scripts/podium-seed-history.ts` needs `tsx`, which no container here carries, so Admin > Reporting is checked on live data and its 45-day history by hand and by unit tests.

<!-- nav:start -->
---

Previous: [47. Load every changed file's diff while the page is open, in the browser only (#631)](47-load-every-diff-while-the-page-is-open-in-the.md) · Up: [Decisions](README.md)
<!-- nav:end -->
