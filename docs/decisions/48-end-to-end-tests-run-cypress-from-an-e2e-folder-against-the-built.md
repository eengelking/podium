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

- **Where it lives.** `e2e/` has its own `package.json` and lockfile and is not a root workspace, so `npm ci --ignore-scripts`, `npm test`, `npm run build` and the SonarCloud job never install the Cypress binary. `e2e/**` is excluded from Sonar's coverage and duplication measures.
- **What it tests.** The built UI served by the built server (`node server/dist/index.js`) as a plain Node process on `ubuntu-latest`, on a fixed port, with a database file in the runner's temp folder. Not Vite, not `tsx`, and not the Podman image on every run (a check of the image stays with `podium:smoke`, and may join the release PR).
- **Readiness.** The job polls `GET /api/fleet/health` and the first spec asserts the server version equals `package.json`'s, so a stale build fails loudly. No fixed sleeps.
- **Data.** A fixed-data seed script puts fixed session ids, names, models, costs, plans, agents, changed files, people and tokens in through the server's own HTTP routes. The simulator is time-driven and is used only for "something is live" smoke checks. State is reset by restarting the server on a wiped database file before each spec file, and specs never share a server in parallel.
- **Secrets.** The admin secret is generated per run, masked in the log and passed to Cypress as an environment variable; sign-in uses `cy.request` and does not type it into a field. Video is off. Failure screenshots are kept 7 days and the server log is uploaded only after a scrub step, because the repo is public and artifacts are world-readable.
- **Flakiness.** `retries: 0`, no `cy.wait(ms)`, no assertion on a clock-derived value, animations off in the support file, long `LINGER_MS` and stale values in the seed environment, and a retrying assertion for any live count. A pass means five consecutive green runs on one commit.
- **Test ids.** The frontend has almost no `data-testid`. Specs need them, so adding a `data-testid` (and a seed id the spec can select without a random suffix) is part of the work and changes nothing a person sees. A spec uses an ARIA role and name where one exists and a `data-testid` where not.
- **When it runs.** On a PR into `development` that touches `frontend/`, `server/`, `mod/`, `e2e/` or the workflow, and always on the release PR (`development` to `main`). It is a gate for the release candidate (PROJECT.md, Releases). Making it a required status check is the maintainer's decision after it has proven stable.
- **Keeping it true.** The `podium-e2e-update` skill and the `podium-e2e-keeper` agent run on any feature change, update the specs and the coverage map and run the suite to green. `docs/e2e/COVERAGE.md` maps every feature to its specs, and a check in `npm test` fails when the map names a file or route that no longer exists.
- **Left out.** The Admin idle lock, the Respond sign-in idle end and the sign-in lockout need their timings to be reachable and are tracked in #791. A test-only timing knob is not added here. The History page has no spec page and is tracked in #792. Real TLS and the reporter mod inside Claude Code stay out (`npm run test:mod`).
- **Fullscreen.** Wall mode's real Fullscreen API may be refused by headless Chrome. The spec tries it first. If the browser refuses, it asserts the app's own wall-mode state with `requestFullscreen` stubbed, and the coverage map records that the real call is only checked by hand.

**Why.**

- Only a real browser can check layout, focus, contrast, target size, theme switching, `EventSource` reconnect and a card changing with no reload.
- A separate folder keeps the unit-test install and the Sonar scan as light as they are.
- The built server is what users run. Vite and the container add differences without finding more UI bugs.
- A fixed seed and a restart per spec file make a spec depend on data, never on timing.

**Alternatives.**

- Playwright was not weighed in this entry, because the maintainer asked for Cypress (#403). `scripts/page-shot.mjs` stays for 400 px screenshots.
- Cypress in the root `devDependencies` puts it in every `npm ci`, the lockfile, Dependabot and Sonar's dependency scan.
- A Podman image on every run is slower, needs an image build in the job, and tests the container more than the console.
- The simulator as the seed makes every assertion depend on the clock.

**Cost.**

- A second install, a second lockfile and a CI job of several minutes on every app-touching PR.
- Every feature change now carries e2e work, which is the point and is also a cost.
- Cypress's support for Node 24 and for fullscreen in headless Chrome are to be confirmed against its documentation by the first build; this entry is updated if either differs.

<!-- nav:start -->
---

Previous: [47. Load every changed file's diff while the page is open, in the browser only (#631)](47-load-every-diff-while-the-page-is-open-in-the.md) · Up: [Decisions](README.md)
<!-- nav:end -->
