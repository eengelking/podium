---
title: "Decisions"
description: "The why log: the significant choices behind Podium, what each one costs, and which ones were later reversed."
group: "Project internals"
entries: "table"
---

# Decisions

This is the "why" log. It records the significant choices behind Podium and what each one costs, newest
last. It is for contributors and curious readers who want to know why something is the way it is before
proposing to change it.

- `docs/spec/` says what Podium must do.
- `docs/architecture/` says how it was built and where it departs from the spec.
- This file says why.

Add an entry when a choice would otherwise get re-argued, and do not rewrite old ones. If a decision is
reversed, add a new entry that says so and mark the old one superseded.

Each entry has some of these parts, in this order:

- **Context.** What prompted the decision (only where it is not obvious).
- **Decision.** What was chosen.
- **Why.** The reasons.
- **Alternatives.** What was considered and not taken (only where recorded).
- **Cost.** What the choice gives up.

Other docs cite entries by number, so numbers never change.

## All decisions

<!-- entries:start -->
| Entry | Status | Date | Summary |
|---|---|---|---|
| [1. Podium only observes](01-podium-only-observes.md) | superseded | 2026-10-11 | Podium only watched: no prompts, stops or approvals, which kept trust simple but meant acting on anything meant going to the terminal. Replaced by 28. |
| [2. A Claude Code mod reports from inside the session](02-a-claude-code-mod-reports-from-inside-the-session.md) | accepted | 2026-10-11 | The reporter is a Claude Code mod, the only way to see agents, usage and plans from inside a session, at the cost of depending on a new mod API. |
| [3. Full snapshots plus unacknowledged events](03-full-snapshots-plus-unacknowledged-events.md) | accepted | 2026-10-11 | Each report carries the whole session state plus unacknowledged events, so a lost report is harmless, at the cost of larger reports. |
| [4. SQLite through node:sqlite, validation by hand](04-sqlite-through-node-sqlite-validation-by-hand.md) | accepted | 2026-10-11 | Storage is SQLite through the built-in node:sqlite and reports are validated by hand, with no new dependency but a validator to maintain. |
| [5. Settings hooks as a reduced fallback](05-settings-hooks-as-a-reduced-fallback.md) | accepted | 2026-10-11 | POST /api/fleet/hook accepts settings hooks for sessions without the mod, showing a reduced view with no tokens, cost or plan. |
| [6. The report types are copied, and a test keeps them equal](06-the-report-types-are-copied-and-a-test-keeps-them.md) | accepted | 2026-10-11 | The Report types are copied byte for byte into the mod and a test keeps the two equal, which is why the mod stays in this repo. |
| [7. Cost is an estimate, except the session ledger](07-cost-is-an-estimate-except-the-session-ledger.md) | accepted | 2026-10-11 | An orchestrator's cost is the session ledger and agent cost is an estimate from a price table, labeled as one. Partly replaced by 23. |
| [8. Podman, one image, one volume](08-podman-one-image-one-volume.md) | accepted | 2026-10-11 | The server and UI ship as one Podman image with a /data volume, with Docker supported too, at the cost of passing the health check by hand. |
| [9. podiumctl has two modes and no dependencies](09-podiumctl-has-two-modes-and-no-dependencies.md) | accepted | 2026-10-11 | bin/podiumctl is a dependency-free ES module that runs the server in a container or as a plain Node process, at the cost of two code paths. |
| [10. The token is generated on first start, and secrets stay out of argv](10-the-token-is-generated-on-first-start-and-secrets.md) | accepted | 2026-10-11 | podiumctl generates a random token on first start, saves it at mode 0600 and keeps secrets out of argv, though docker inspect still shows it. |
| [11. Start on boot through launchd and systemd user units](11-start-on-boot-through-launchd-and-systemd-user-units.md) | accepted | 2026-10-11 | podiumctl enable writes a launchd agent or systemd user unit so the server starts on boot; container mode through a reboot is not yet tested. |
| [12. The mod stays in this repo and is listed from the skills marketplace](12-the-mod-stays-in-this-repo-and-is-listed.md) | accepted | 2026-10-11 | podium-reporter lives in this repo and the skills marketplace lists it by a git-subdir source, so a mod fix needs a version bump to reach users. |
| [13. The token option is sensitive](13-the-token-option-is-sensitive.md) | accepted | 2026-10-11 | The mod's token option is marked sensitive so Claude Code hides it, at the cost of no row in the /config menu. |
| [14. The project is named Podium, in one repo](14-the-project-is-named-podium-in-one-repo.md) | accepted | 2026-10-11 | The repo moved from claude-dashboard to eengelking/podium and the old usage dashboard stayed in it for a while, so old links rely on a redirect. |
| [15. The usage dashboard is removed](15-the-usage-dashboard-is-removed.md) | accepted | 2026-10-11 | The usage dashboard, its routes, recharts and the admin API key setting were removed, a breaking change for anyone who used the page. |
| [16. The host passes its home directory to a containerized server](16-the-host-passes-its-home-directory.md) | accepted | 2026-10-11 | podiumctl passes PODIUM_HOST_HOME so a containerized server shortens the host's home to ~, at the cost of one more variable to set by hand. |
| [17. Fleet cards keep a fixed width](17-fleet-cards-keep-a-fixed-width.md) | superseded | 2026-10-12 | The wall grid used fixed 360 px cards so collapsing a pane never shrank them, leaving empty space in a short last row. Replaced by 27. |
| [18. A supported range of reporter versions, not a protocol number](18-a-supported-range-of-reporter-versions-not.md) | accepted | 2026-10-12 | The server keeps a supported range of reporter versions and compares major.minor, instead of a protocol number, but someone must move the range. |
| [19. The changed-files list is a git diff against where the session started](19-the-changed-files-list-is-a-git-diff-against-where.md) | accepted | 2026-10-12 | The changed-files list is a git diff against the commit the session started at, matching GitHub, but two sessions in one checkout see the same changes. |
| [20. Per-person tokens bound to a name, and an Admin section gated by the old shared secret](20-per-person-tokens-bound-to-a-name-and-an-admin.md) | accepted | 2026-10-12 | The shared token becomes an admin secret and each person gets a server-made token bound to a name, with no accounts and no password reset. |
| [21. People are shown from the token's owner, grouped in the browser, and machines carry a random id](21-people-are-shown-from-the-tokens-owner-grouped.md) | accepted | 2026-10-12 | People are grouped by the token's owner, not the name a report claims, and machines carry a random id, so a one-person setup looks unchanged. |
| [22. Wall notices are server settings, shown at the bottom, with one switch each in Admin](22-wall-notices-are-server-settings-shown-at-the-bottom.md) | accepted | 2026-10-13 | Wall notices sit at the bottom with an X and one Admin switch each, kept as server settings, so anyone who reaches the dashboard can close one for everyone. |
| [23. The server prices tokens, with prices the Admin can change](23-the-server-prices-tokens-with-prices-the-admin.md) | accepted | 2026-10-13 | The server prices per-model token counts with a table Admins can change, worked out on read, so the session figure is an estimate, not Claude Code's ledger. |
| [24. An agent's activity is sent only while someone watches it, and never kept](24-an-agents-activity-is-sent-only-while-someone.md) | accepted | 2026-10-13 | An agent's activity is captured only while someone watches the panel, held in memory and never stored, which protects privacy but loses history. |
| [25. The Admin can switch the activity feed off for the whole server](25-the-admin-can-switch-the-activity-feed-off.md) | accepted | 2026-10-13 | An Admin feature flag switches the activity feed off for the whole server, on top of each machine's own option, at the cost of puzzling machine owners. |
| [26. The server logs events, and can push them to a central platform](26-the-server-logs-events-and-can-push-them.md) | accepted | 2026-10-14 | The server logs events with stable names, as text or JSON, and can push them to VictoriaLogs, at the cost of network calls and lines lost when it is down. |
| [27. The wall's cards stretch, in at most four columns](27-the-walls-cards-stretch-in-at-most-four-columns.md) | accepted | 2026-10-14 | The wall counts its own columns, at most four, and stretches 360 px minimum cards to fill the row, so card size is no longer steady. Replaces 17. |
| [28. Podium can answer a waiting session, through the reporter, not through a terminal](28-podium-can-answer-a-waiting-session-through.md) | accepted | 2026-10-15 | The owner or an Admin can answer a waiting session from the browser through the reporter, widening the trust model, so five switches default to off. |
| [29. A session keeps the Podium identity it started with](29-a-session-keeps-the-podium-identity-it-started.md) | accepted | 2026-10-15 | A session takes its Podium name and token once at session.start and keeps them, so a second identity on one machine cannot hijack running sessions. |
| [30. Admin opens from the console's sign-in, with a name and a token](30-admin-opens-from-the-consoles-sign-in-with-a-name.md) | accepted | 2026-10-15 | Admin unlocks with a name and a token through the console's sign-in, so an Administrator signs in once, at the cost of a wider respond cookie. |
| [31. Security sweep (#249): what was found, what was fixed, what is accepted](31-security-sweep-what-was-found-what-was-fixed-what.md) | accepted | 2026-10-16 | A review of the server, UI, mod, podiumctl and image: what was fixed (advisories, headers, capabilities), what was found sound, and what is accepted. |
| [32. Throttling wrong admin-secret guesses on the report routes (#255)](32-throttling-wrong-admin-secret-guesses-on-the-report.md) | accepted | 2026-10-16 | A per-address throttle counts distinct wrong admin-secret guesses on the report routes, never person tokens, but can lock out a reporter on a shared address. |
| [33. Refusing a Host the server does not expect (#256)](33-refusing-a-host-the-server-does-not-expect.md) | accepted | 2026-10-16 | The server answers 403 to a Host it does not expect, to stop DNS rebinding, so reaching it by a name needs PODIUM_ALLOWED_HOSTS and a restart. |
| [34. What the Admin log says about a delivery the server lets go of (#333, #334, #329)](34-what-the-admin-log-says-about-a-delivery-the-server.md) | accepted | 2026-10-16 | The Admin log writes one respond_dropped row for each delivery the server lets go of, with no text, at the cost of many rows when responding is turned off. |
| [35. Trusting a reverse proxy's client address, only when told to (#305)](35-trusting-a-reverse-proxys-client-address-only-when.md) | accepted | 2026-10-18 | PODIUM_TRUST_PROXY names the proxy hops to trust, off by default and never true, so the owner must know the proxy's address or hop count. |
| [36. A file's diff is source code, so only its owner can open it (#319)](36-a-files-diff-is-source-code-so-only-its-owner.md) | accepted | 2026-10-18 | A file's diff is read on demand and reaches only the session's owner, redacted on the machine and never stored, at the cost of best-effort redaction. |
| [37. Orchestrators can message each other, but only one person's own (#347)](37-orchestrators-can-message-each-other-but-only-one.md) | accepted | 2026-10-18 | Podium carries messages only between one person's own orchestrators, with owner-granted rights and switches off by default, widening the trust model. |
| [38. The Plan list ends with the done steps, in the order the server saw them finish (#454)](38-the-plan-list-ends-with-the-done-steps-in-the-order.md) | accepted | 2026-10-19 | The Plan list shows in progress, blocked, pending, then done steps in the order the server saw them finish, as fine as the reporting interval. |
| [39. The Admin can keep the activity feed, in a second SQLite file (#432)](39-the-admin-can-keep-the-activity-feed-in-a-second.md) | accepted | 2026-10-20 | The Admin can choose to keep the activity feed in a second SQLite file under one global purge policy, at the cost of an incomplete record and more data stored. |
| [40. A session can be recorded whole, with three yes answers (#353)](40-a-session-can-be-recorded-whole-with-three-yes.md) | accepted | 2026-10-20 | A session can be recorded whole only with three yes answers and a notice nobody can hide, at the cost of a secret that redaction may miss. |
| [41. A Bash row opens to the whole command and its output (#431)](41-a-bash-row-opens-to-the-whole-command-and-its-output.md) | accepted | 2026-10-21 | A Bash row opens to its whole command and output, with output behind its own switches, held in memory only and captured only for a live viewer. |
| [42. Podium makes its own CA, and the reporter authenticates with a certificate (#577)](42-podium-makes-its-own-ca-and-the-reporter.md) | accepted | 2026-10-22 | With TLS on, Podium makes its own CA and gives each reporter a client certificate on a mutual-TLS port, at the cost of a CA, renewals and reissues to run. |
| [43. The docs site is Astro Starlight, and each version is built from its git tag (#688)](43-the-docs-site-is-astro-starlight-and-each-version.md) | accepted | 2026-10-25 | The docs site is Astro Starlight with each version built from its git tag, at the cost of a version dropdown and link rewrite we maintain. |
| [44. The docs live at podium.engelking.dev, a CNAME to GitHub Pages (#689)](44-the-docs-live-at-podium-engelking-dev-a-cname.md) | accepted | 2026-10-25 | The docs site lives at podium.engelking.dev, a DNS-only CNAME to GitHub Pages, so renewal stays with GitHub and the maintainer's other domains stay untouched. |
| [45. Large docs split along their sections into folders, with a README as the index (#697)](45-large-docs-split-along-their-sections.md) | accepted | 2026-10-25 | The spec, decisions, gotchas, architecture and user guide are folders of small pages, one per section or entry, each folder indexed by a generated README. |
| [46. A context names one reporter config file, in ~/.podium/contexts.json (#606)](46-a-context-names-one-reporter-config-file-in-podium-contexts-json.md) | accepted | 2026-10-27 | A context is a name for a reporter config file in ~/.podium/contexts.json; a context that fails falls back to the newest file. |
| [47. Load every changed file's diff while the page is open, in the browser only (#631)](47-load-every-diff-while-the-page-is-open-in-the.md) | accepted | 2026-10-27 | The console reads each changed file's diff while the owner has the page open, kept in page memory only; it reads files nobody opened. |
| [48. Storage sits behind async interfaces, SQLite is the only adapter and stays the default (#313)](48-storage-sits-behind-async-interfaces-with-sqlite-as-the-only-adapter.md) | accepted | 2026-10-28 | The server reaches its data through async interfaces with one SQLite adapter, so a database can be replaced later; the cost is that every call is awaited. |
| [49. End-to-end tests run Cypress from an e2e folder against the built server (#782)](49-end-to-end-tests-run-cypress-from-an-e2e-folder-against-the-built.md) | accepted | 2026-10-28 | Cypress lives in its own e2e/ folder and drives the built server with a fixed-data seed; every feature change must update its specs. |
| [50. Test-only timing variables let the end-to-end suite reach the idle and lock times (#791)](50-test-only-timing-variables-let-the-end-to-end-suite-reach-the-idle-and-lock-times.md) | accepted | 2026-10-29 | Three environment variables shorten the Admin idle lock, the sign-in idle end and the lockout for a test server, behind one flag; there is no clock. |
| [51. The reporter config folder on Windows is %USERPROFILE%\.podium (#834)](51-the-reporter-config-folder-on-windows-is-userprofile-podium.md) | accepted | 2026-10-30 | The mod takes the home folder from HOME, else USERPROFILE, else HOMEDRIVE plus HOMEPATH, so Windows uses the same .podium folder name as macOS and Linux. |
| [52. A machine takes part in messaging while any live session does (#838)](52-a-machine-takes-part-in-messaging-while-any-live-session-does.md) | accepted | 2026-10-30 | The server derives a reporter's peers value from its live sessions, so a claude -p run that reports false cannot switch the machine Off. |
<!-- entries:end -->
