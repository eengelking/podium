# Decisions

This is the "why" log. It records the significant choices behind Podium and what each one costs, newest
last. It is for contributors and curious readers who want to know why something is the way it is before
proposing to change it.

- `docs/SPEC.md` says what Podium must do.
- `docs/ARCHITECTURE.md` says how it was built and where it departs from the spec.
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

## Contents

| # | Decision |
|---|---|
| [1](#1-podium-only-observes) | Podium only observes (superseded by 28) |
| [2](#2-a-claude-code-mod-reports-from-inside-the-session) | A Claude Code mod reports from inside the session |
| [3](#3-full-snapshots-plus-unacknowledged-events) | Full snapshots plus unacknowledged events |
| [4](#4-sqlite-through-nodesqlite-validation-by-hand) | SQLite through `node:sqlite`, validation by hand |
| [5](#5-settings-hooks-as-a-reduced-fallback) | Settings hooks as a reduced fallback |
| [6](#6-the-report-types-are-copied-and-a-test-keeps-them-equal) | The report types are copied, and a test keeps them equal |
| [7](#7-cost-is-an-estimate-except-the-session-ledger) | Cost is an estimate, except the session ledger (superseded in part by 23) |
| [8](#8-podman-one-image-one-volume) | Podman, one image, one volume |
| [9](#9-podiumctl-has-two-modes-and-no-dependencies) | `podiumctl` has two modes and no dependencies |
| [10](#10-the-token-is-generated-on-first-start-and-secrets-stay-out-of-argv) | The token is generated on first start, and secrets stay out of argv |
| [11](#11-start-on-boot-through-launchd-and-systemd-user-units) | Start on boot through launchd and systemd user units |
| [12](#12-the-mod-stays-in-this-repo-and-is-listed-from-the-skills-marketplace) | The mod stays in this repo and is listed from the skills marketplace |
| [13](#13-the-token-option-is-sensitive) | The `token` option is sensitive |
| [14](#14-the-project-is-named-podium-in-one-repo) | The project is named Podium, in one repo |
| [15](#15-the-usage-dashboard-is-removed) | The usage dashboard is removed |
| [16](#16-the-host-passes-its-home-directory-to-a-containerised-server) | The host passes its home directory to a containerised server |
| [17](#17-fleet-cards-keep-a-fixed-width) | Fleet cards keep a fixed width (superseded by 27) |
| [18](#18-a-supported-range-of-reporter-versions-not-a-protocol-number) | A supported range of reporter versions, not a protocol number |
| [19](#19-the-changed-files-list-is-a-git-diff-against-where-the-session-started) | The changed-files list is a git diff against where the session started |
| [20](#20-per-person-tokens-bound-to-a-name-and-an-admin-section-gated-by-the-old-shared-secret) | Per-person tokens bound to a name, and an Admin section gated by the old shared secret |
| [21](#21-people-are-shown-from-the-tokens-owner-grouped-in-the-browser-and-machines-carry-a-random-id) | People are shown from the token's owner, grouped in the browser, and machines carry a random id |
| [22](#22-wall-notices-are-server-settings-shown-at-the-bottom-with-one-switch-each-in-admin) | Wall notices are server settings, shown at the bottom, with one switch each in Admin |
| [23](#23-the-server-prices-tokens-with-prices-the-admin-can-change) | The server prices tokens, with prices the Admin can change |
| [24](#24-an-agents-activity-is-sent-only-while-someone-watches-it-and-never-kept) | An agent's activity is sent only while someone watches it, and never kept |
| [25](#25-the-admin-can-switch-the-activity-feed-off-for-the-whole-server) | The Admin can switch the activity feed off for the whole server |
| [26](#26-the-server-logs-events-and-can-push-them-to-a-central-platform) | The server logs events, and can push them to a central platform |
| [27](#27-the-walls-cards-stretch-in-at-most-four-columns) | The wall's cards stretch, in at most four columns |
| [28](#28-podium-can-answer-a-waiting-session-through-the-reporter-not-through-a-terminal) | Podium can answer a waiting session, through the reporter, not through a terminal |
| [29](#29-a-session-keeps-the-podium-identity-it-started-with) | A session keeps the Podium identity it started with |
| [30](#30-admin-opens-from-the-consoles-sign-in-with-a-name-and-a-token) | Admin opens from the console's sign-in, with a name and a token |
| [31](#31-security-sweep-249-what-was-found-what-was-fixed-what-is-accepted) | Security sweep (#249): what was found, what was fixed, what is accepted |
| [32](#32-throttling-wrong-admin-secret-guesses-on-the-report-routes-255) | Throttling wrong admin-secret guesses on the report routes (#255) |
| [33](#33-refusing-a-host-the-server-does-not-expect-256) | Refusing a Host the server does not expect (#256) |
| [34](#34-what-the-admin-log-says-about-a-delivery-the-server-lets-go-of-333-334-329) | What the Admin log says about a delivery the server lets go of (#333, #334, #329) |
| [35](#35-trusting-a-reverse-proxys-client-address-only-when-told-to-305) | Trusting a reverse proxy's client address, only when told to (#305) |
| [36](#36-a-files-diff-is-source-code-so-only-its-owner-can-open-it-319) | A file's diff is source code, so only its owner can open it (#319) |
| [37](#37-orchestrators-can-message-each-other-but-only-one-persons-own-347) | Orchestrators can message each other, but only one person's own (#347) |
| [38](#38-the-plan-list-ends-with-the-done-steps-in-the-order-the-server-saw-them-finish-454) | The Plan list ends with the done steps, in the order the server saw them finish (#454) |
| [39](#39-the-admin-can-keep-the-activity-feed-in-a-second-sqlite-file-432) | The Admin can keep the activity feed, in a second SQLite file (#432) |
| [40](#40-a-session-can-be-recorded-whole-with-three-yes-answers-353) | A session can be recorded whole, with three yes answers (#353) |
| [41](#41-a-bash-row-opens-to-the-whole-command-and-its-output-431) | A Bash row opens to the whole command and its output (#431) |
| [42](#42-podium-makes-its-own-ca-and-the-reporter-authenticates-with-a-certificate-577) | Podium makes its own CA, and the reporter authenticates with a certificate (#577) |
| [43](#43-the-docs-site-is-astro-starlight-and-each-version-is-built-from-its-git-tag-688) | The docs site is Astro Starlight, and each version is built from its git tag (#688) |

## 1. Podium only observes

**Superseded** by 28: Podium can now answer a session that waits on its person.

**Decision.** No control surface. Podium never sends a prompt, stops an agent, approves a permission or edits
a session. At most the UI copies a resume or fork command to the clipboard, for the person to run.

**Why.** It keeps the trust model simple: the mod can only report, and the server can only store and show. A
dashboard that could steer sessions would need much stronger authentication and would be a much more
attractive target. It is the first "Non-goal" in `docs/SPEC.md`.

**Cost.** Nothing in the UI can act on what it shows. You switch to the terminal for that.

## 2. A Claude Code mod reports from inside the session

**Decision.** The reporter is a Claude Code mod (`mod/podium-reporter/`), not a log parser or an external
process.

**Why.** It is the only mechanism that sees agent spawns, per-step usage, compaction, tool results and plans
from inside a session, and can send them out (`SPEC.md` section 2).

**Cost.** Sessions started without the mod are invisible, except through the reduced settings-hook ingest
(entry 5). The mod depends on Claude Code's mod API, which is new.

## 3. Full snapshots plus unacknowledged events

**Decision.** Each report carries the whole session state and the events the server has not acknowledged.
The server upserts it and never needs an earlier report to understand a later one (`SPEC.md` section 6).

**Why.** A lost or repeated report cannot corrupt anything, and a restarted server recovers from the next
report. The mod owns what is true inside a session. The server owns time (staleness, lingering, dropping,
series).

**Cost.** Reports are larger than a delta would be. At one per second that does not matter.

## 4. SQLite through `node:sqlite`, validation by hand

**Decision.** Storage is SQLite via Node's built-in `node:sqlite`. Every report is validated by hand in
`protocol.ts` instead of with a schema library.

**Why.** There is no native build step and no new runtime dependency, which is plenty for one machine. The
spec allows no other runtime dependency without a written reason. A hand-written check also lets it clamp
long strings and strip control characters instead of rejecting a whole report (`ARCHITECTURE.md`, spec
questions 4 to 6).

**Cost.** The validator is code to maintain. `node:sqlite` is loaded through `process.getBuiltinModule`
because vitest cannot resolve the `sqlite` specifier, and Podium needs Node 24.

## 5. Settings hooks as a reduced fallback

**Decision.** `POST /api/fleet/hook` accepts Claude Code's settings hooks for sessions that never loaded the
mod. They show up marked "settings hooks" with no tokens, cost or plan.

**Why.** You should not have to restart a session to see it at all. A session the mod reports is never
changed by hooks, so enabling both is harmless (`ARCHITECTURE.md`, spec question 37).

**Cost.** Hook-only sessions send no heartbeat, so they get a longer stale window (`HOOK_STALE_AFTER_MS`,
10 minutes).

## 6. The report types are copied, and a test keeps them equal

**Decision.** The Report types live in `server/src/fleet/protocol.ts` and, byte for byte between markers, in
`mod/podium-reporter/hooks/protocol.ts`. `server/src/fleet/protocol.test.ts` compares the two.

**Why.** The mod's tests run in the hooks sandbox, which has no file system, so a mod test cannot read the
server's file. The comparison has to live where both files can be read (`ARCHITECTURE.md`, spec questions 1
and 2).

**Cost.** The mod and the server have to stay in one repo, or this check needs a replacement. This is why
the mod was not moved to a separate repo (entry 12).

## 7. Cost is an estimate, except the session ledger

*Superseded in part by 23 (#117): the server now prices the tokens, with `server/src/fleet/pricing.ts`.*

**Decision.** An orchestrator's own cost is the session's ledger. Agent cost is token counts times a price
table (`mod/podium-reporter/hooks/models.ts`), and the UI always labels it an estimate.

**Why.** The engine only gives a ledger for the session, not per agent. Presenting an estimate as a bill
would be wrong.

A model with no price (anything that is not a Claude model, such as one served by Ollama) gets no estimate
at all:

- It is `null` in the report and "n/a" in the UI.
- Its sessions are left out of the fleet's cost total, with a note. The note counts a session only while its
  model is unpriced. Once the Admin prices the model the session has a cost and the note goes (#276). The
  cost-per-minute sparkline stays beside it.
- A loop that has not reported a model yet, with no spend, is also unknown and reads as a dash, not $0.00.

The earlier fallback priced such a model as Sonnet so the number was never zero, but an invented figure
presented as an estimate is worse than none (#66).

**Cost.** Agent figures undershoot the ledger a little (known issue 7 in `ARCHITECTURE.md`).

## 8. Podman, one image, one volume

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

## 9. `podiumctl` has two modes and no dependencies

**Decision.** `bin/podiumctl` is a plain ES module with no dependencies. It manages the server either in a
container (Podman or Docker) or as a standalone Node process, and saves the mode.

**Why.** Some people will have neither Podman nor Docker, and developers want a plain process. A script with no
dependencies installs with `npm link` and nothing else, and `npm link` is how an npm binary is normally
installed (PR #3).

**Cost.** Two code paths to keep working. Both are tested for real, not only in unit tests.

## 10. The token is generated on first start, and secrets stay out of argv

**Decision.** The first `podiumctl start` generates a random `PODIUM_TOKEN` and saves it to
`~/.podium/config.env` (mode 0600). `podiumctl token` shows it. An empty token is the deliberate "auth off"
setting. Secrets reach the server through the process environment (`podman run -e NAME` with no value),
never the command line.

**Why.** This follows how RKE2 handles its join token: generated once, saved in a known place, and easy to
find again. The maintainer likes that approach. A secret on a command line is visible in the process list.

**Cost.** The token is still part of the container's environment, so `podman inspect podium` shows it. See
`docs/GOTCHAS.md`.

## 11. Start on boot through launchd and systemd user units

**Decision.** `podiumctl enable` writes a launchd agent (macOS) or a systemd user unit (Linux).

- In container mode the unit runs `podiumctl start`.
- In standalone mode it runs `podiumctl run` in the foreground and restarts only after a non-zero exit.

**Why.** A container restart policy is not enough on macOS: Podman runs in a VM that is not up at login, and
`podiumctl start` also starts it. Restarting only on a failure keeps `podiumctl stop` from being undone by
the service.

**Cost.** What was tested and what was not:

- The Linux unit has run on Bazzite 44 (Fedora Atomic, systemd 259, Podman 5.8.7, SELinux enforcing) with
  Node from Homebrew, in both modes (2026-10-16, #268).
- Standalone: it started, `stop` was not undone, a killed server came back in about 4 seconds, and `disable`
  removed everything.
- Container: the same, except that `systemctl --user start` does nothing after `podiumctl stop`. The unit
  is `Type=oneshot` with `RemainAfterExit=yes` and so still counts as active. Use `podiumctl start`, or
  `systemctl --user stop` first.
- A container is not restarted when it dies. Only the unit's start at login or boot brings it up.
- Standalone, rebooted (2026-10-20, #268): with `loginctl enable-linger` the server was listening at boot
  before anyone logged in; without it, it started at login. Both runs were clean, with one start and no restarts.
- Not yet tested: container mode through a reboot.
- The unit names Homebrew's `opt/<formula>` link for `node` rather than the `Cellar/<formula>/<version>`
  directory that `brew upgrade` deletes.

## 12. The mod stays in this repo and is listed from the skills marketplace

**Decision.** `podium-reporter` lives in `mod/podium-reporter/` here. `eengelking-marketplace` (in
`eengelking/skills`) lists it with a `git-subdir` source, using a full `https://` URL (2026-10-11,
`eengelking/skills` PRs #32 and #33).

**Why.**

- A marketplace is only a listing, so one `eengelking-marketplace` can point at plugins that live in other
  repos.
- The mod has to sit beside the server because of entry 6.
- The `eengelking/skills` repo is for project-agnostic skills, and this mod is tied to one project.
- The `owner/repo` shorthand makes Claude Code clone over SSH, which fails for anyone without a GitHub SSH
  key.

**Cost.** A mod fix needs a `plugin.json` version bump or installed copies never update. CI checks it
(`mod-version-check`).

## 13. The `token` option is sensitive

**Decision.** The mod's `token` option is marked `sensitive`.

**Why.** It is a credential, so Claude Code keeps it out of the plain settings display.

**Cost.** A sensitive option has no row in the `/config` menu. Set it with
`/plugin configure podium-reporter@eengelking-marketplace`. (Found when testing, 2026-10-11.)

## 14. The project is named Podium, in one repo

**Decision.** The repo was `claude-dashboard` and is now `eengelking/podium` (PR #5). The earlier usage
dashboard stayed in the same repo at `#/usage` until it was removed (entry 15).

**Why.** The repo is published, and the name should say what the product is. "Podium" was already the
working name in the spec (open question 10, kept in one constant).

**Cost.** Old links to `claude-dashboard` rely on GitHub's redirect.

## 15. The usage dashboard is removed

**Decision.** The earlier usage dashboard is gone. Removed:

- the "Usage dashboard" link and the `#/usage` page
- the `/api/claude-code` and `/api/api-usage` routes, and the modules only they used
- `recharts`
- the `ANTHROPIC_ADMIN_API_KEY` setting

A `#/usage` link now lands on the fleet console. `podiumctl` ignores a leftover `ANTHROPIC_ADMIN_API_KEY` in
an existing config and lets `config unset` clear it.

**Why.** The maintainer moved away from it. Checking the empty-in-container case (#16) showed the page had
little value, and fixing it would have meant mounting transcripts into the container only to feed it. It
shared the repo and the server but none of the fleet console's code. This overrides the "stays reachable at
`#/usage`" statements in SPEC and entry 14.

**Cost.** A breaking change for anyone who used the page (pre-1.0). Cross-session cost history, if wanted,
would be a new feature in the fleet console built from what the mod reports.

## 16. The host passes its home directory to a containerised server

**Decision.** `podiumctl` sets `PODIUM_HOST_HOME` to the host's home directory when it starts the container,
and `configFromEnv` uses it in place of the server's own `os.homedir()` when it is an absolute path.
Standalone mode and `npm run dev` do not set it and behave as before. The name avoids `PODIUMCTL_HOME`,
which is where `podiumctl` keeps its own files.

**Why.** In a container the server runs as `node`, so its home is `/home/node` and a session's
`/Users/<name>/...` never shortened to `~/...` (#20). Nothing in the report carries the reporter's home. The
other options were worse:

- Having the mod report its home changes the report format and SPEC 6.2 for a display detail.
- Guessing `/Users/<name>` or `/home/<name>` can show a wrong `~`.

The value is not a secret and needs no change on the wire.

**Cost.** One more variable for `podiumctl` to set. A server started in a container by hand, without
`podiumctl`, must set it itself or paths stay long.

## 17. Fleet cards keep a fixed width

**Superseded by 27 (#145).**

**Decision.** The wall grid is `repeat(auto-fill, min(360px, 100%))`, left-aligned. A card is 360 px wide
(narrower only when the area is) and extra room adds columns.

**Why.** With `minmax(300px, 1fr)` a new column made every card narrower, so collapsing a pane, which widens
the main area, shrank the cards (#65). Collapsing the 340 px right pane did it most. A steady size is what
an always-on wall display (#33) wants. One rule covers both panes, the top bar and Wall mode, since they only
change the main area's width.

**Cost.** A last row that is not full leaves empty space on its right, and the cards no longer stretch to
fill a wide row.

## 18. A supported range of reporter versions, not a protocol number

**Context.** Issue #49 asked whether to follow `kubectl`, which allows a skew of one minor version, or to
add a protocol version that changes only with the report format.

**Decision.** The server keeps one range, `REPORTER_SUPPORT { min, max }`, of mod versions it reads
correctly (SPEC 6.8). It compares `major.minor` of each report's `reporter.version` and tells the reporter
in the reply.

- Below the range is `outdated`.
- Above it is `newer`.
- A version it cannot parse is `unknown` and never warns.

**Why.** A protocol number would warn less often, but `Report.v` already exists and has never needed to
change, and a warning that never fires is not much use. A range on the mod's own version:

- needs no new field on the wire,
- works for reporters that already send `reporter.version`,
- gives the opposite direction (a mod newer than the server) for free.

Ignoring the patch number keeps a mod-only fix from warning anyone.

**Cost.** Someone must move `min` or `max` when a change needs it. Forgetting `max` when a new mod minor
ships makes every up-to-date mod show `upgrade server`, and a test cannot catch that on its own. The release
steps are in `CONTRIBUTING.md` ("The mod version bump"), which says to move `max`.

## 19. The changed-files list is a git diff against where the session started

**Decision.** The mod records the commit HEAD pointed at when the session began and lists the files that
differ from it in the working tree (SPEC 5.7).

- Line counts come from `git diff --numstat`, and untracked files are counted separately.
- It does not count only the files the session's own Edit and Write calls touched.
- If that commit is no longer an ancestor of HEAD (a rebase, an amend, a branch switch), it diffs against
  the merge base with the upstream, and with no upstream against HEAD alone. The report says which (`since`).
- The Files tab pages the list 20 at a time, and the left column widens to 400 px while it is open (#26).

**Why.** It matches what GitHub shows, includes changes made by shell commands and formatters, and survives
a commit, which a count of tool calls does not. The starting commit is kept in the mod's store under the
session id, so a hot reload does not move it.

**Cost.**

- Two sessions in the same checkout both see the same changes, because the diff is of the working tree.
  Worktrees avoid it.
- A session that switches to an unrelated branch reads as `upstream` or `worktree` rather than as its own
  changes.
- The mod runs five git queries every 10 seconds instead of one, and counts at most the first 200 files.
- Untracked files are counted with one `git grep -c` per 100 files (#271). A folder of hundreds costs a few
  processes a poll. An empty or binary untracked file past the first 20 in a read shows no counts, and
  untracked files past the 200th add no lines to the totals.
- The report carries the list in every snapshot, since a report is a full snapshot (SPEC 6.7). The mod only
  marks a report due when the list changes.

## 20. Per-person tokens bound to a name, and an Admin section gated by the old shared secret

**Decision.** The shared `PODIUM_TOKEN` becomes the *admin secret*. It opens an Admin section where the
server owner makes a token for each person.

- A person's token is `pdm_<12 hex key id>_<48 hex secret>`, generated by the server and shown once. It is
  stored only as its SHA-256 (it also kept the last four characters until #277 dropped them).
- A report is accepted when its token is live and the `userName` it carries equals that token's person.
- The shared secret keeps working for reporting, under the owner `Admin`, with an off switch.
- Admin's session is an in-memory id in an `HttpOnly; SameSite=Strict` cookie, with a 10 minute idle
  timeout, 5 wrong tries locking a source for 15 minutes, a required `X-Podium-Admin` header on changes,
  and an admin log (#36).

**Why.**

- One shared secret cannot tell who sent a report, and anyone holding it could claim any name.
- A key id inside the token means the server finds the person from the token, and a name alone gives
  nothing to guess. Names are visible in the console, so the name match is only a consistency check and the
  token's randomness is the protection.
- A plain SHA-256 is enough because the tokens are random and long: there is no password to guess, and the
  hash only keeps a copied database from handing out working tokens.
- Keeping the old secret means an existing single-token setup works after upgrade with no change.

**Cost.**

- Anyone with the admin secret can open Admin and make tokens, so the secret still has to be guarded
  (`podman inspect` shows it).
- Sessions live in memory, so a restart locks Admin.
- There are no accounts, and a person cannot see or rotate their own token. (The built-in Administrators
  group, #172, later let its members open Admin with their own name and token. See 30.)
- Tokens still travel over plain HTTP: a network-reachable server needs a trusted network or a TLS proxy.
- Any valid credential can delete any session.
- The lockout is per source address, so behind a proxy that hides addresses it is shared.

## 21. People are shown from the token's owner, grouped in the browser, and machines carry a random id

**Decision.** The people view (#34) groups sessions by `sessions.owner`, which the server sets from the token
(decision 20), not by the `userName` a report carries.

- A named reporter also sends `machine`: the short host name and a random 12-hex id. The mod makes the id
  once and keeps it in `podium-machine-id` in the Claude config directory (#267).
- Bands, ordering and the spend chart are computed in the browser from live sessions. The server adds only
  the machine, each owner's group and today's spend per owner.
- "Me" is picked in the browser and kept in `localStorage`.
- The view stays off until a session belongs to a person, so a one-person setup that reports with the admin
  secret looks as before.

**Why.**

- A name is visible to everyone and can be typed by anyone, so trusting it would let one person appear as
  another. The token already decides identity.
- A host name alone cannot tell two machines with the same name apart, and a hardware or OS identifier says
  more about the machine than Podium needs, so the id is random and local to the mod.
- Deriving people from live sessions keeps the server free of a second, stale copy of who is around.
- The server cannot know who is looking at a page, so only the browser can say "me".

**Cost.**

- With the admin secret or with auth off, names are sent and stored but no person is shown (GOTCHAS).
- A person whose sessions have all ended has no band, though today's spend still lists them.
- The id is per config directory, so a copied `~/.claude` makes two machines share one id (the host name
  still differs in most cases).
- The mod now writes one file of its own outside its store. A machine that had two ids (an inline copy and
  the marketplace install) settles on one, so its other row ends with that row's last session.
- Group changes in Admin reach a live session's card with its next report rather than at once.

## 22. Wall notices are server settings, shown at the bottom, with one switch each in Admin

**Decision.** Informational notes about the wall (today, the background-sessions note) sit in one stack at
the bottom of the wall.

- Each has an X. Closing one turns it off for every browser and tells the user where to turn it back on,
  Admin > Settings, which has one switch per notice.
- The switches, and whether background sessions are shown, are rows in the `settings` table. They are sent in
  the state body and pushed to open tabs as a `wall` stream event.
- Closing a notice and the Show them / Hide them link are open routes like Remove, not Admin calls.

**Why.**

- A note above the cards pushes the work down, and a note that cannot be closed gets in the way every time.
- The wall has no Admin session, so what it shows has to come in the state it already receives.
- One setting per server matches how the rest of Admin works, and keeps "show background sessions" from
  resetting on every reload, as the old per-tab state did.

**Cost.**

- Anyone who can reach the dashboard can close a notice or show background sessions for everyone, the same
  trust Remove already has.
- A notice closed by mistake is easy to restore but affects every viewer until it is.
- The list of notices lives in two places, the server's `NOTICES` and the wall's stack, so a new notice
  touches both.

## 23. The server prices tokens, with prices the Admin can change

**Decision.** The reporter sends tokens per model and per prompt-size tier (`usageByModel`, for the session
and for each agent). The server turns them into dollars in one module, `pricing.ts`, using a built-in table
of Anthropic's list prices with the Admin's changes laid over it.

- The cost is worked out when it is read, not when it arrives, so a price change moves every figure at once.
- Each model has five prices (input, output, cache read, 5-minute and 1-hour cache write). Haiku 5.5 has a
  second set for prompts over 100,000 tokens.
- Podium does not read Claude Code's own `modelPricing` or cost figure.

**Why.**

- The reporter cannot see the Admin's settings, and the session total it used to send was Claude Code's
  ledger, which the server cannot reprice.
- Tokens per model are enough to reprice everything, including the orchestrator's share (session total
  minus its agents), so the card, the facts bar and the totals still add up (#109).
- Pricing on read means a price change needs no migration of stored rows.
- A request's tier depends on its own prompt size, so it has to be decided per request in the reporter, not
  from totals.

**Cost.**

- The session figure is now an estimate from the Admin's prices, not Claude Code's ledger, for any reporter
  that sends usage (0.12.0 and later). A person who sets a contracted rate in Claude Code's `modelPricing`
  must set it here too.
- Reports grow by a few rows per model, and each sample row stores the session's usage so the cost-per-minute
  sparkline can follow the Admin's prices too (#270).
- Cache writes count at the 5-minute rate unless Claude Code reports the 1-hour part. The `turn.step` usage
  fields in SPEC 5 carry no such split, so until it does the 1-hour price has no effect.
- A session first heard of after midnight, whose start the server believed from before it, counts what it
  spent since its first sample (#276).
- A session that started before midnight and now reports no ledger figure (the reporter sends `null` for a
  local model) cannot be split by the ledger. It is split by the usage its last sample before midnight kept,
  priced with the Admin's prices: what it costs now minus what that usage cost. So a session that spent on a
  Claude model before midnight and on a local model after adds only its spend after midnight (#286).
- A session none of whose samples kept usage (a reporter older than 0.12.0 on a local model) has nothing to
  split by and counts nothing today.

## 24. An agent's activity is sent only while someone watches it, and never kept

*Amended by 39 (#432): the Admin can now choose to keep it. The default, and everything below, is unchanged.*

**Decision.** The activity feed (#118) has its own reporter option, `activityFeed`, off by default and
separate from `fullPrompts`.

- With it on, nothing is captured, sent or stored for a loop until a viewer opens its panel. The panel's
  fetch takes a short lease on the server, the reply to each report lists the leased loops (`watch`), and
  the mod captures only those.
- The server keeps the last 20 entries in memory. It drops them when the lease lapses (the viewer's interval
  plus 15 seconds), when the session leaves or on restart, and never keeps an entry older than the lease, so
  a viewer who comes back starts empty. There is no table and no history.
- The panel fetches on the viewer's interval (5 seconds by default) only while it is open and the tab is
  visible.
- Tool calls and the text between them are sent. The model's thinking is not.

**Why.**

- What an agent is doing right now is more sensitive than its task prompt or answer, and everyone who can
  open the console can read it, so it gets its own switch and is off unless asked for.
- Capturing only what someone is looking at keeps the cost at zero for the many agents nobody watches, keeps
  the reports small, and means there is nothing to retain, export or leak afterwards.
- The question it answers, "where is this agent in its work", is about now, so a history adds little.
- Thinking may come summarized or not at all depending on the model, and is the most private part.

**Cost.**

- A viewer sees nothing from before they opened the panel, and the first entries arrive one report cycle
  after the lease starts (about a second, more on a long interval).
- Two viewers share one lease, so a slow viewer keeps a loop watched for longer than a fast one alone would.
- A restart of the server loses every feed.
- The reports of a watched loop carry up to 20 entries of 300 characters again on every report, because
  reports are full snapshots.

## 25. The Admin can switch the activity feed off for the whole server

**Decision.** On top of the reporter's `activityFeed` option (24), Admin > Settings > Feature flags has an
**Agent activity feed** switch (`activity-feed`). It is on by default, kept in the `settings` table with the
other Admin settings, and written to the admin log. The feed needs both.

- With the flag off, the server grants no lease, lists nothing in `watch`, keeps nothing a mod sends, and
  drops what it held when the flag goes off. The activity route answers `enabled: false`.
- Open panels keep asking on their interval and say the Admin turned it off, so turning it back on resumes
  the feed without a reload.
- The store is a generic list of flags, `FEATURES`, so the next feature that needs an off switch adds one
  entry.

**Why.**

- The reporter option belongs to whoever runs each machine, and the feed is read by everyone who can open
  the console. The person who runs the server needs a way to stop it for everyone without asking every
  machine to change a setting, and to have that recorded.
- Default on, because the reporter option is already off by default, so a flag that also started off would
  make the feature take two steps to try for no added safety.

**Cost.**

- A machine with the option on still captures nothing while the flag is off, which can puzzle its owner
  until the panel's note explains it.
- Open panels keep making one small request per interval while the flag is off.
- A flip sends every browser a full snapshot, which is fine for a switch that changes rarely.

## 26. The server logs events, and can push them to a central platform

**Decision.** The server writes each thing it does as an event with a stable dotted name, a level and flat
fields (`server/src/logging/`, #140).

- Plain text stays the default and prints what the server always printed. `json` prints one object per line.
- When `PODIUM_LOG_SHIP_URL` is set, the server also pushes the JSON lines to that endpoint, shaped for
  VictoriaLogs' JSON line ingest, from a bounded buffer that drops the oldest lines when the endpoint is
  down.
- Only the server logs this way. The mod does not.
- Access logging is one `http.request` line per request at `debug`, so it is off at the default `info`.
- Admin changes are `admin.*` events with the action and the source address. The Admin Log table is
  unchanged.
- Node's own `fetch` and `zlib` do the work, with no logging library.

**Why.**

- The maintainer wants an agent to find out what a deployment did through the VictoriaLogs MCP server: a
  rejected report by its reason, a session's start and end.
- A push from the server needs nothing else installed, and the same JSON on stdout still serves a collector
  such as Vector or Fluent Bit for anyone who prefers that.
- The mod's logs would leave the user's machine, a different privacy decision, so they stay out until
  someone asks.
- A line per request is noise for most people, and the paths already show in the events that matter.

**Cost.**

- With shipping on, the server makes network calls on its own, and lines are lost when the endpoint is down
  longer than the buffer lasts (it says so once).
- The default text output stays what it was. The events added with the logger (sessions, reporters, sweeps,
  Admin changes, conflicts) print in text only at `debug`, which the maintainer chose so
  that turning nothing on changes nothing. A refused credential (`auth.failed`) and the `tls.*` events were
  moved out of that list in #602, folded to one line a minute, because an Admin reading a plain log to find
  out why a reporter is offline saw nothing. They are still at their own level in `json` and in what is
  shipped, so someone reading plain text at the default level sees less than an agent reading VictoriaLogs.
- Field names are checked against a deny list and strings are scrubbed, but a new field still needs its
  author to think about what it carries.

## 27. The wall's cards stretch, in at most four columns

**Decision.** The fleet wall counts columns instead of letting the browser fill them (`wallLayout.ts`,
`useWallColumns`, #145). This replaces 17, and applies to the fleet wall only.

- A card is never narrower than 360 px.
- The wall uses as many 360 px columns, 12 px apart, as its own measured width holds, at most four and never
  more than there are cards. The cards stretch to fill the row.
- A lone card is half the wall when two columns fit.
- Later rows keep the same column width, so a short last row is left-aligned.
- Bands in the People and Group views share one set of columns, from the total number of cards shown.
- A `ResizeObserver` on the wall keeps the count current.

**Why.**

- The maintainer asked for a wall that fills the screen with a steady, predictable shape: one wide card,
  then two, three or four across, never more.
- The 360 px minimum keeps today's card size as the floor.
- Measuring the wall itself, not the window, accounts for the panes, which can be dragged to any width.
- Taking the columns from the total, not each band's cards, keeps cards in different bands the same width,
  so the page does not look ragged.

**Cost.** A card is no longer a steady size: opening or closing a pane, or dragging one, changes the columns
and can resize every card, which is what 17 avoided (#65). The count needs JavaScript and a measurement, so
before the first measure the wall falls back to the old fixed 360 px cards.

## 28. Podium can answer a waiting session, through the reporter, not through a terminal

**Context.** The maintainer's real goal behind #21 was answering a session that stopped to ask, without going
back to the terminal or the desktop app.

**Decision.** Podium is no longer observe-only (this supersedes 1). When a session waits on its person, the
owner or an Admin can answer from the browser (#206, `SPEC.md` 5.3 and 7.7):

- an AskUserQuestion form (an option, a typed answer, or a message in place of an answer)
- a plan (approve in one of three modes, or send it back with feedback)
- a tool's permission prompt (allow once, or deny with a reason)
- a turn that ended (a new message, `/clear` or `/compact`)

How it works:

- Everything goes through podium-reporter. Its hooks race Claude Code's own dialog against an answer from the
  server, and whichever comes first wins, so the terminal keeps working the whole time.
- The mod fetches answers from the server, in the same direction as reporting, and the server never connects
  to a session.
- It is off unless five switches are on: authentication, the Admin's **Respond from Podium** flag, the
  Admin's activity feed flag, and on the machine the reporter's `respond` option and `activityFeed` option.
- The `respond` option has four levels, so the person running a session decides how much it accepts, and the
  mod enforces that itself.
- "Always allow", any other change to permission rules, and every slash command but `/clear` and `/compact`
  stay in the terminal.
- The web terminal asked for in #21 was not built.

**Why.**

- A browser terminal into the session's tmux would do far more than the goal needs and cover too few
  sessions. It hands the browser raw keystrokes into the session, works only for sessions inside tmux, can't
  see the host's tmux from the container, and would need SSH or a tunnel for another machine.
- The Claude Code mod API gives a narrower path that reaches every session the reporter already sees.
- A spike against a real Claude Code 2.1.301 session (comments on #206) showed each case working, once a
  plan approval echoes the tool's input back as `updatedInput`.
- A held request lets an answer land within a second or two, and needs no listening port in the session.
- `/model` and `/effort` were left out. `/model` also saves the model as the default for new sessions, and
  `/effort` opens a confirmation only the terminal can answer.

**Cost.**

- The trust model is no longer "the mod can only report". Anyone holding a person's token, or the admin
  secret, can put text into that person's opted-in sessions. So the switches are off by default, every
  answer needs a credential even though reads are open, and each answer is written to the admin log without
  its text.
- The browser now signs in with a token, which travels over plain HTTP unless a TLS proxy is used.
- Plan approval rests on behavior Claude Code doesn't document (anthropics/claude-code#97656 is open), so the
  mod confirms that each approval took and otherwise leaves the plan to the terminal.
- Where an organization manages Claude Code, PermissionRequest hooks don't run in a user-installed plugin,
  so tool permissions and plan approval can't be answered there.
- A pending answer is kept in memory only, so a server restart loses it.
- The mod's hooks for an open ask now wait on the network on purpose, which the reporter never did before.

## 29. A session keeps the Podium identity it started with

**Context.** The reporter's `userName` and `token` options are one set per Claude config directory, and
Claude Code reloads every running session's module when an option changes. Signing in as a second Podium
identity on the same machine therefore switched the first terminal's running sessions to the new token, and
the server refused them (409, a session stored under Admin reported with a person's token). The refusal was
right. The switch was the defect (#226).

**Decision.** The mod takes its name and token once, at `session.start`, and holds them in `$.state`, which
survives a reload. At that first start it prefers the terminal's `PODIUM_USER` and `PODIUM_TOKEN` over the
shared options.

**Alternatives.**

- Reading the options live (the old behavior).
- Holding the pair in `$.store`, which would write a token to disk.
- A project-scoped setting, which Claude Code does not offer for plugin options.
- Letting the server accept a session from a second owner, which would undo #209.

**Cost.** A running session cannot pick up a corrected token or name. Fixing a wrong token means starting a
new session, where before a reload was enough. Two identities on one machine need the environment variables,
not the settings screen.

## 30. Admin opens from the console's sign-in, with a name and a token

**Context.** Admin and the console had two sign-ins that did not know about each other. An Administrator
signed in to respond still typed a token again to open Admin, the Admin button showed to everyone, and Admin
took a token alone (#215).

**Decision.** Admin's unlock takes a name and a token, checked by the same function as the sign-in to
respond.

- The respond cookie is scoped to `/api` instead of `/api/fleet/respond`.
- `POST /api/admin/unlock/from-respond` opens an Admin session for a browser whose respond sign-in is an
  Administrator's.
- The button shows only when `GET respond/me` says `admin`.
- The idle lock stays. An Administrator still signed in to the console is let back in without a prompt, and
  anyone else sees the sign-in.

**Alternatives.**

- One shared cookie for both sessions, which would tie the 10-minute Admin lock to the 12-hour console
  sign-in.
- Minting the Admin cookie at respond sign-in, which would not cover the idle lock and would not work if the
  Admin session had been locked on purpose.
- Dropping the idle lock.

**Cost.**

- The respond cookie now travels to every `/api` route, though only the respond and Admin routes read it.
- The Admin button is gone while responding is switched off (the `respond` flag is off by default), since
  nobody can sign in at the top bar then. `#/admin` still works.
- An explicit "Lock Admin" used to leave a reload free to reopen Admin while the console sign-in stood. #272
  fixed that (below).

**Update (#272).** "Lock Admin" marks that browser's respond sign-in as held, in memory. `from-respond`
refuses a held sign-in until that person unlocks with their name and token, which lifts the hold (another
Administrator unlocking in the same browser does not), or signs in to respond again. The sign-in itself
stands, so the person can still answer sessions, and the idle lock still lets a signed-in Administrator back
in. Alternative not taken: ending the respond sign-in on Lock Admin, which would also stop the person
answering sessions' prompts, something the button's name does not suggest.

## 31. Security sweep (#249): what was found, what was fixed, what is accepted

**Context.** A review of the server, UI, mod, `podiumctl`, the Containerfile and the dependencies, at the
time Podium gained responding (#206) and Admin sign-in by name and token (#215).

**Fixed.**

- *High (advisory, not reachable).* `npm audit --omit=dev` reported `proxy-addr` (critical, IP spoofing
  through a trusted proxy subnet) and `qs` (moderate, denial of service in query parsing, reached through
  Express). Podium never sets `trust proxy`, so `proxy-addr` could not be steered, but `qs` parses every
  query string. `npm audit fix` moved them to patched versions, and production dependencies now audit clean.
- *Low.* No response carried a content security policy, `X-Frame-Options` or `nosniff`, so any future markup
  bug would have run with the page's full reach, and the console could be framed. They are now set on every
  response (7.7).
- *Low.* The container ran with Podman's default capability set. It now drops all of them and cannot gain
  privileges.

**Checked and sound.**

- Every SQL statement is parameterized. The two that build an `IN (?, ?)` list or an `ORDER BY` take only
  counts and whitelisted words.
- Tokens are 192 bits, stored as SHA-256 and compared in constant time. The lockout covers Admin and the
  sign-in to respond together.
- Every Admin route sits behind the unlocked-session check. Every change in Admin and respond needs a custom
  header and a same-host `Origin`, with `SameSite=Strict` cookies.
- A session is answerable only by its owner or an Admin, and the answer's text is never logged.
- The UI has no `dangerouslySetInnerHTML`, and a Markdown link opens only `http(s)` and `mailto`.
- `podiumctl` passes the token by environment, writes the config at mode 0600 and keeps the token out of the
  boot file. Log lines redact tokens.

**Accepted.**

- *Guessing the admin secret with `X-Podium-Token`.* Accepted when found, fixed in #255. Wrong secrets on the
  report routes are now throttled with a counter of their own. The shared lockout could not simply count
  them, since a misconfigured reporter would lock out every reporter and the person's own browser on a
  shared address (all local reporters arrive from `127.0.0.1`). The throttle counts distinct wrong values,
  never person tokens, and while it holds it refuses even the right admin secret from that address. See 32.
- *DNS rebinding.* Accepted when found, fixed in #256 (see 33): the server now refuses a `Host` it does not
  expect. The reads are still open by design (7.1).
- *Open reads and three open writes.* `GET` routes, Remove on a lost card, closing a wall notice and the
  background-sessions switch take no token (7.1). They change only how the wall looks.
- *Development dependencies.* Accepted when found, cleared in #269. `npm audit` listed `vitest`, `vite`'s
  `esbuild` and `tinypool`, none of which ships in the image. The test tooling moved to vitest 5, vite 8 and
  `@vitejs/plugin-react` 6, and `npm audit` (with dev dependencies) now reports nothing. The root
  `package.json` names vitest itself, because the two workspaces no longer share one copy for the `scripts/`
  tests to find. `frontend/src/jest-dom.d.ts` carries jest-dom's matcher types for vitest 5's two-parameter
  `Assertion` (GOTCHAS).
- *A server's own page loads Google Fonts,* which tells Google that someone opened Podium. The policy names
  that one origin.

**Cost.** The policy must be edited by hand when the page gains an origin or an inline script.

## 32. Throttling wrong admin-secret guesses on the report routes (#255)

**Context.** Admin's unlock and the console sign-in lock a source after five wrong tries, but
`X-Podium-Token` on `POST /report`, `POST /hook`, `DELETE /sessions/:id` and the mod's respond routes had no
limit, and a secret found there opens Admin (31). Counting those in the shared lockout would let one
reporter with a stale token lock out every other reporter on `127.0.0.1`.

**Decision.** A separate throttle per source address (`GuessThrottle`).

- It counts *distinct* wrong values (kept as hashes), locking at five for 15 minutes.
- A person's token is never counted or throttled. It has 192 random bits, so it cannot be guessed, and stale
  or revoked ones are the common misconfiguration.
- While throttled, any non-person credential gets `429` with `Retry-After`, including the right admin
  secret.
- A short `PODIUM_TOKEN` (under 24 characters) is warned about at start.

**Alternatives.**

- Counting every wrong token in the shared lockout (the stale-reporter lockout above).
- A throttle that lets the right secret through while locked, which would let a guesser learn the right one
  from the one response that differs, so it limits nothing.
- Delaying wrong answers instead of refusing, which holds connections open.

**Cost.**

- An attacker who shares an address with an admin-secret reporter can lock that reporter out for 15 minutes
  (its reports are retried about once a minute and recover when the lock ends).
- Reporters with a person's token are untouched, which is another reason to give each person one rather than
  reporting with the admin secret.
- Behind a container's port mapping or a proxy, clients may all show one source address and then share one
  throttle. The Admin lockout already has the same limit, and Podium sets no `trust proxy`.
- The counter is in memory, so a restart clears it.

## 33. Refusing a Host the server does not expect (#256)

**Context.** The reads take no token (7.1), and the server did not look at `Host`. A page on another site can
rebind its own name to `127.0.0.1` and then read the fleet, including every agent's prompt and answer, as its
own origin. It cannot reach Admin or respond, which need a cookie that rebinding never carries (31).

**Decision.** A check ahead of every route answers `403` to a `Host` that is not a loopback name or address,
the bound address, or a name in `PODIUM_ALLOWED_HOSTS` (7.7). `localhost` always works, with nothing to list.

**Why.** A server bound to `0.0.0.0` (or `::`) allows any IP-literal `Host` by default:

- What a rebinding page controls is a DNS name, and the browser sends that name in `Host`. An address typed
  in the bar is not resolved, so no other site can make a browser send one for this server, and allowing it
  costs nothing.
- Refusing addresses on a wildcard bind would break the supported `--bind 0.0.0.0` use for no gain, and
  would make the owner list every address the machine has.
- A name is never allowed unless listed, on any bind.
- On a specific bind (`--bind 192.168.1.5`) only that address is allowed, besides loopback.
- In container mode the server cannot see the host's bind address (it listens on `0.0.0.0` inside), so it
  takes any address there. The container's published port is still limited to the bind address by Podman.

**Cost.** Reaching a server by a name (`box.lan`, a reverse proxy's name) needs `PODIUM_ALLOWED_HOSTS` and a
restart, and a reverse proxy that rewrites `Host` has to send a name that is listed. A request with no `Host`
(HTTP/1.0) is refused.

## 34. What the Admin log says about a delivery the server lets go of (#333, #334, #329)

**Context.** #304 made the Admin log follow an answer from `respond_sent` to what became of it. Three ways to
lose one still left the log ending at `respond_sent`:

- the session was deleted (`dropSession`)
- responding was turned off (`clear`)
- a message the session had queued when it ended

A retried final result also answered `404`, and #327 left open whether it should answer `200`.

**Decision.** Each of those writes one `respond_dropped` row per delivery that has no result yet, with the
sender as actor and the short delivery id, never the text.

- The reasons are "the session was deleted first" and "responding was turned off first" (both "before any
  result came back", since a handed-over answer may have reached the session). For a queued message at
  session end the reason is "the session ended while it was still queued, so Podium cannot tell whether it
  was read".
- A delivery with a result already has its row. `endSession` followed by `dropSession` writes one row, not
  two.
- Turning responding off writes a row for each delivery, not one row with a count. The row's value is that
  its id pairs with the `respond_sent` row, and a count cannot be paired. The noise is bounded by what was
  waiting (at most the per-session message limit plus one answer per open ask).
- For the retry, `404` is the contract. The mod drops a queued result on any response, so a `404` is not
  retried, and a finished-delivery record would add memory state and a clear path for no visible gain.

**Alternatives.**

- One summary row for `clear()`.
- Answering `200` to a retried final result from a bounded record of finished ids.
- A `respond_result` row for a queued message at session end, which would claim an outcome Podium never saw.

**Cost.** Turning responding off with many waiting items writes many rows. A mod that is not the bundled one
and retries on `404` would retry once per tick until its own limit.

## 35. Trusting a reverse proxy's client address, only when told to (#305)

**Context.** Podium set no `trust proxy` (31, 32). Behind the TLS proxy the docs recommend, `req.ip` was the
proxy for every request: the admin log's `source` showed the proxy, the Admin and sign-in lockout and the
admin-secret throttle were shared by everyone behind it, and `req.secure` was false, so the session cookies
were not `Secure`.

**Decision.** `PODIUM_TRUST_PROXY` names the hops to trust and goes to Express `trust proxy` (7.7). Off by
default. It takes a hop count, or addresses, CIDR ranges and `loopback`, `linklocal`, `uniquelocal`.

**Why.**

- Express already does the right thing for a named hop: it reads `X-Forwarded-For` from the right and stops at
  the first address it does not trust, so a value a client put to the left of the proxy's is ignored.
- `true` is refused. It trusts every hop, so any client could send its own `X-Forwarded-For` and pick its
  source, which defeats the lockouts and falsifies the audit. A setting that can be turned into that by one
  word should not accept the word.
- A malformed value stops the server at start, since trusting nothing silently would leave the lockouts shared
  and trusting too much would leave them spoofable.
- Off by default keeps a server with no proxy exactly as it was.

**Alternatives.**

- Accepting `true`, as Express does.
- Reading `X-Forwarded-For` ourselves, which repeats `proxy-addr` with fewer checks.
- Turning trust on when the bind is loopback, which guesses that a local listener is a proxy.

**Cost.** The owner has to know their proxy's address or hop count and must name only a proxy that overwrites
`X-Forwarded-For`. A hop that passes a client's header through lets that client choose its source. The
setting needs a restart.

## 36. A file's diff is source code, so only its owner can open it (#319)

**Context.** The Files tab lists what a session changed, as paths and counts (5.7). The maintainer wanted a click
to open the diff. That is source code, and the rest of the console is readable by anyone who can reach the server
(7.1), so the text could not simply join the report.

**Decision.** The text is read on demand and leaves the machine only for the session's owner.

- The owner's browser asks; the server lists the request in the next reply to the session's mod; the mod runs
  `git diff` for that one path and answers; the server hands the answer to the waiting request and forgets it.
- Three things must be on: the reporter's `fileDiff` option, the Admin's `file-diff` flag, and authentication.
  The flag and the option are off by default.
- Only the signed-in person whose name is the session's owner may ask. An Administrator who is not the owner may
  not, and neither may the admin secret, except for a session owned by `Admin`.
- The mod redacts the text before it leaves the machine, on removed lines too, and never reads the diff of a
  path such as `.env` or a key file. The server keeps nothing: not in the database, the state, the stream, a log
  line or the admin log, which records only that a path was opened and by whom.

**Why.**

- Sending every diff in every report would put all of a person's source on a server whose reads are open. On
  demand puts nothing on the server for a file nobody opens.
- Redaction on the machine means the server and the console never see a secret the rules caught, so a leak
  would need a rule to miss it.
- Owner-only, rather than owner or Admin, keeps the number of people who can read the code as small as the
  feature allows. A person who needs an Admin to see it can sign in as the owner.
- It reuses what exists: the held-request and lease shape of the activity feed, the respond sign-in and its
  cookie, the shared modal, and the feed's `[redacted]` mark.

**Alternatives.**

- Sending diffs with the report, capped. Rejected for the reason above.
- Owner or Admin, as for responding. Rejected: responding changes a session, and reading code needs a stricter
  gate than that.
- Promising no redaction and leaning on the gate alone. Rejected: a gate does not help a secret that was pasted
  into a file by accident.

**Cost.** Redaction is best effort, so a secret in a shape no rule knows can still reach the owner's browser,
and the docs say so. The high-entropy rule hides some values that are not secrets. A diff is a round trip to the
machine, so it takes a moment and fails when the machine is off. The side-by-side view is drawn twice (two panes
and one column) and CSS shows the one that fits.

## 37. Orchestrators can message each other, but only one person's own (#347)

**Context.** The maintainer had a development agent on a Mac and needed `systemd` tested on Linux, so a second
agent ran on a Linux machine and the maintainer pasted text between the two by hand. Podium already knows every
live session and owner, so it could carry that text. But this is a new kind of traffic: text one agent wrote
becomes input to another. #347 made the policy question the first step, since it could end the idea.

**Decision.** Podium carries messages between one person's own orchestrators, on any of their machines and any
OS (`SPEC.md` 1, 5.3, 5.9, 7.7 and 8.1). The server (#412), the mod (#414), My reporters (#415), the Admin's pages
(#416), Traffic (#417) and an owner's stricter limits (#436) are built. #347 records the design and the follow-up
issues, and `docs/MESSAGING.md` the setup.

- Only between reporters with the same owner. The server refuses a link between two owners.
- Podium carries the messages itself, through the reporter and the server, in the direction reporting already
  goes. It does not use Claude Code's own `SendMessage`.
- Rights belong to a pair of reporters and go one way, with a right to see and a right to send, and a reply
  needs its own right. A right to send is with or without approval.
- Three switches, all off by default: the Admin's flag, the `peers` option on each machine, and a right the
  owner gives on a new page, My reporters. An Admin can propose a right; only the owner can accept it. An
  Admin's pause applies at once.
- A message is a new turn in an orchestrator whose turn has ended, framed as a podium-reporter message, never
  as the person's own words. It never reaches an agent an orchestrator launched, and only an orchestrator sends.
- Secrets are replaced on the sending machine. The text is kept on the server for 30 days, and only the owner
  and an Admin can read it, on a new Traffic page and on My reporters.

**Why.**

- Anthropic's terms allow messaging within one person's sessions, but leave messaging between people unclear,
  so it is not built (the findings, with sources and dates, are on #347):
  - Claude Code ships cross-session messaging itself, and the mods API offers `$.session.send`,
    `$.prompt.submit` and `$.tool.register`.
  - The Consumer Terms forbid making an account available to anyone else, the Claude Code legal page says Pro
    and Max limits assume ordinary, individual use, and the Usage Policy in force from November 12, 2026 adds
    services that route requests through consumer subscriptions to its list of unauthorized access. Person B's
    agent starting turns in person A's session may fall under those, and nothing addresses consent or a
    self-hosted relay. It stays blocked until Anthropic answers the questions on #347.
- Claude Code's own messaging reaches another machine only through Remote Control, which needs a claude.ai
  sign-in and does not work with an API key, and it delivers between tool calls during a turn. Podium has people
  on API keys, and #347 wants a message never to interrupt a turn.
- A message sent with `$.prompt.submit` during a turn already waits for the turn to end (verified for #206), so
  delivering at a turn's end needs nothing new.
- A reporter is the stable unit. Sessions and agents come and go, so a right on them would not outlast the
  session.
- The owner's acceptance, and the `peers` option the server cannot change, keep the person in charge of what
  enters their sessions, even against an Admin or a compromised server.
- Keeping the text is what makes the exchange worth having: the maintainer wants to read what the agents said.
  Limiting who can read it follows the file diff (DECISIONS 36), since a message can hold source code.

**Alternatives.**

- Use Claude Code's `SendMessage` and `ListAgents`, with Remote Control on through `remoteControlAtStartup`, and
  have the reporter only watch and gate them. Rejected: no API keys, and delivery mid-turn.
- Messaging between people, with each owner accepting the link. Blocked on the terms, not rejected.
- Rights per session or per agent, dragged around by the Admin. Rejected: they do not outlast a session, and an
  Admin should not decide what enters a person's sessions.
- Showing a message that waits for approval as an ask in Respond, with the amber band. Rejected: the receiving
  session is working, not waiting on its person, and the band means it is waiting.
- Keeping nothing, as responding does, or redacting only in the console. Rejected: the first makes the exchange
  unreadable afterwards, and the second would leave the secret on the server.
- A list-of-links view on My reporters as well as the grid and the board. Dropped as too complex.

**Cost.**

- The trust model widens again. Anyone holding a person's token can put text into that person's linked
  orchestrators. That is why the switches are off by default and approval is the default for a new right.
- A message is another agent's text in a session. A receiving session in auto mode can act on it without asking.
  Its permission prompts still apply, but what auto mode allows is not a prompt. The #411 spike found the
  auto-mode classifier does not take a plugin's text as the person's intent, and the model refused the risky
  requests once Podium's opening line was there. Without that line it tried one (SPEC 5.3), so in accept-edits
  or bypass mode the line and the model's judgment are the only guard.
- Conversation text is stored on disk, which responding never does, and redaction is best effort.
- The design rests on the mods API, which is early access. The #411 spike checked it on Claude Code 2.1.303: a
  tool cannot be kept from subagents, so it refuses their calls; background agents do not hold a message back;
  and a toast plus `/podium`, registered to run mid-turn, answer a request (SPEC 5.3). A later version can change
  any of it.
- A managed organization that allows only managed mods turns the whole reporter off, messaging included.
- A spend cap and a hop count across chains (A to B to C) are not designed. The round-trip cap per link is the
  only loop guard. The #411 spike did not test chains.

## 38. The Plan list ends with the done steps, in the order the server saw them finish (#454)

**Context.** The Plan tab listed steps in the order the model wrote them and paged them 10 at a time. In a long plan the
step being worked on and the steps still to do landed on different pages with finished steps between them. A step
carries no finish time, so "in the order they finished" had to come from somewhere.

**Decision.** The list is ordered in progress, blocked, pending in plan order, then done in finish order (`SPEC.md` 8.1).
Blocked goes right after in progress, above pending: a blocked step is open work a person may need to act on, so it stays
on the first page. The server records the finish order. On each report it compares the plan with the stored one and gives a
step that has newly become done the next number (`doneSeq`, in `plan_json`); a step that stays done keeps its number and a
reopened step loses it. Steps done in the first plan the server saw have none and come first among the done, in plan order.

**Alternatives.**

- The browser notices a step change state. Rejected: a page opened late, or reloaded, has no order, which is the common
  case for a long plan.
- The reporter sends a finish time. Rejected: a protocol change in both copies for something the server can see anyway, and
  every older reporter would still send plans without it.
- Sliding the rows when a step moves. Left out: optional in the issue and it adds a motion case for reduced motion.

**Cost.**

- The server keeps a number per done step. It is derived on each report from the stored plan, so nothing new is stored
  apart from the field.
- Two steps that finish between two reports get numbers in plan order, not true order. The order is as fine as the
  reporting interval.
- A new plan that reuses step ids (TaskCreate numbers from 1) inherited the numbers of ids that were done and still
  were. #465 closed that, see below.

**Amended (#465): when two plans are the same plan.** The numbers carry over from the stored plan only when the new one
is the same plan: equal source, equal title, and the same text for every step id the two share (and at least one shared
id). Anything else is a replaced plan and starts over, as if first seen, so steps done in it get no number until a later
report sees them finish. Step texts are what separate two TaskCreate plans, since both number from 1 and the title is
often empty. Renaming a step therefore also starts the order over; the list falls back to plan order, which is the
accepted cost. A report with no plan no longer drops the numbers: while a report carries none, the server keeps the last
plan in `plan_kept_json` (migration 21) and compares the next plan with it. Rejected: comparing only titles (usually
null), and keeping a second copy of every plan (the column is filled only during a gap).

## 39. The Admin can keep the activity feed, in a second SQLite file (#432)

**Context.** DECISIONS 24 kept the feed in memory, only while someone watched, because the question it answers is about
now. A person who wants to look back at what a session did, after they closed the window or after it ended, could not.
The Admin also needs a way to clear it: to stop keeping it, to remove something private that leaked, or to save space.
#353 (recording and replay) needs the same store, purge job and manage screen, so the choices here are shared with it.

**Decision.** The Admin chooses one global policy in Admin > Server > Data: *Not stored* (the default, and today's
behavior), *purge after* a number of hours, days, weeks or months, *purge when the session ends*, or *keep everything*,
with an optional size cap that removes the oldest entries first (`SPEC.md` 6.4).

- Entries go to a second SQLite file, `activity.sqlite`, beside `podium.sqlite`, with its own schema version, WAL and
  incremental auto-vacuum. The policy is one JSON row in the main `settings` table.
- Capture needs no viewer: under a keep policy the server lists every running loop of a session whose reporter has
  `activityFeed` on in `watch`. The mod needs no change and the report format is unchanged.
- Every entry is stored, including the answers and messages sent from Podium, each with its marker. The redaction done
  before sending is kept as it is, with no second pass.
- A purge runs every 5 minutes and writes one admin log row per run that removed something. The hourly retention also
  removes the entries of sessions the main database no longer holds, so the shorter of the two retentions wins.
- The Admin reads and deletes through Data and Stored activity. Deleting is by ticked sessions, by a filter (including a
  range of dates) or everything, asks first, compacts the file and is written to the admin log with counts and sizes.
  There is no per-entry delete.
- Stored text can be read only by the session's owner and an Admin, through a signed-in browser. A keep policy needs a
  token on the server.

**Why.**

- A separate file keeps a large, fast-growing table out of the main database, so its backups, vacuum and the hourly
  retention are not slowed by it, and deleting everything can give the space back without touching sessions, History or
  settings.
- Deleting rows does not shrink a SQLite file. Auto-vacuum in steps plus a WAL checkpoint after each removal returns
  the space without one long blocking `VACUUM` on the main database.
- Listing every running loop reuses the mechanism DECISIONS 24 built, so no protocol or mod change is needed.
- Reads are narrower than the console's open reads because stored text can hold anything an agent read or ran, and the
  Admin, who runs the server and can delete it, can read it too.

**Alternatives.**

- A table in `podium.sqlite`. Rejected: one file holding months of entries grows large and slows backups, vacuum and the
  hourly retention. A second file has the same dependency.
- An external store. Rejected: a new dependency and another place to secure, with no benefit at this size.
- A per-project or per-owner policy. Left out: start global; a scope can be added to the same form.
- A second redaction pass on stored text. Left out: the text is already cut and redacted, and the read rule and the
  warning carry the rest.
- Per-entry delete. Left out: finding one entry needs searching inside stored text, which the issue excludes. A date range
  reaches the minutes of a leak without it.

**Cost.**

- It is not a complete record. The mod keeps 20 entries per loop and one report carries 60,000 characters, so a busy
  session can lose entries or a whole loop's feed, and nothing is replayed after an outage.
- Reporters send more and the server stores more while a keep policy is on. The Admin is told before saving.
- Compaction takes time on a large file; it runs in bounded steps and a delete says how much it freed.
- A backup made before a delete still holds what was deleted.
- The size cap counts an estimate of the entries' bytes, not the file's size, because freed pages stay in the file until
  vacuum.
- Choosing *purge when the session ends* with a restart: a session that has not ended stays live and keeps its history.
- A load test found that scanning the table for the Stored activity list, the preview, a purge or a delete blocked the
  server for 4 to 18 s on one day of the issue's example volume (14.4 million rows). The store therefore keeps per-session
  aggregates and removes in chunks that yield to the event loop. The cost is that a very large removal takes longer in
  total (a delete of 2.46 million rows took 33 s against 14 s all at once), that a window-filtered list and the preview
  are estimates or slow-but-not-blocking, and that a delete request waits until its removal is done. The 30-day volume was
  not run.

## 40. A session can be recorded whole, with three yes answers (#353)

**Context.** The Activity feed shows the last 20 short lines of a loop, and #432 (DECISIONS 39) can keep them. Neither
answers "what exactly did this agent read and run, and why". A recording keeps all of it, whole, which is the most Podium
ever holds of a conversation. The details are in [REPLAY.md](REPLAY.md).

**Decision.**

- **Three yes answers, the third on the machine.** The Admin's `session-recording` flag, a choice of the session by its
  owner or an Admin, and the reporter's `sessionRecording` option, off by default. The option is the owner's consent and
  the browser cannot overrule it. It is a separate option, not a level of `activityFeed` or `respond`.
- **The notice is not a wall notice and cannot be hidden.** No X and no switch, on the wall or in Admin, and the owner's
  terminal is told every time. This is an approved exception to DECISIONS 22.
- **Expiry is per part.** Each part goes the Admin's keep time after it was recorded, and the time shown to a person is
  when the oldest part still held goes.
- **The mod names the sender on decisions.** An answer or approval from Podium is recorded by the mod, where it takes the
  answer and knows Claude Code took it, with the sender, never by the server.
- **A separate consent route.** `GET .../recording/consent` tells the picker whether the owner allowed recording and how
  long recordings are kept, before anything is chosen.
- **Stored apart from the main database.** In `activity.sqlite`, in their own tables, sharing DECISIONS 39's store, purge
  and Stored activity page.
- **The limits come from a measurement.** A 5 second batch, a 256 KB early flush, 512 MB for one session and 4 GB for
  all recordings, from simulated traffic (SPEC 6.4, "Measured write load").

**Why.**

- Whole prompts and results can hold anything the session saw, so each party who could be harmed by it has a switch:
  the Admin for the server, the owner for the machine, and the person choosing for the session.
- Consent that anyone could dismiss is not consent. An Admin can start a recording without the owner, so the owner has
  to see it and hear it every time.
- Per-part expiry means a short keep time is honored within a purge run, and a long recording sheds its oldest part
  instead of living until its last.
- Only the mod knows what Claude Code took. A server-written decision could claim an approval that never happened.
- The wall's `SessionView` goes to everyone, so whether the owner allowed recording cannot ride on it.
- A separate file keeps a fast-growing table out of the main database's backups, vacuum and retention.
- A batch every 5 seconds instead of every second cut the server's writes for 20 busy sessions by 29% and its CPU by 35%,
  at the price of a replay that trails by up to 5 seconds. The first defaults (256 MB, 2 GB) would have stopped a busy
  session of 8 loops after about 3.4 hours, while the trouble was still going on.

**Alternatives.**

- A level of `activityFeed` or `respond`. Rejected: neither implies recording, and recording implies neither.
- A closable notice with a switch, like DECISIONS 22. Rejected for the reason above.
- The server recording decisions as it delivers them. Rejected: it cannot tell what Claude Code took.
- Recording thinking text. Not possible today: the chunks arrive with empty text.

**Cost.**

- A recording can hold a secret that redaction missed (REPLAY.md, "What redaction does not cover"). Redaction of a very
  long line is done in pieces of 1,000 characters, so a secret across a cut can slip through.
- It is not complete. The mod's queue is bounded, a session that dies loses up to 5 seconds, and a question or permission
  prompt answered in the terminal leaves no decision row.
- Thinking text is not available, and only one model at one effort was tested.
- The limits come from simulated traffic, not real sessions, so they may change.
- The Admin can read every recording and start one without the owner, which is why the notice cannot be hidden.

## 41. A Bash row opens to the whole command and its output (#431)

**Context.** The Activity feed showed a Bash call as one line cut to 300 characters, with no result. A person had to open
the terminal to see whether a command worked. #432 and #353 changed what the feed may keep since the issue was written,
so some of its first assumptions (output "in memory only", captured "only for a watched loop") no longer hold as written.

**Decision.** Every Bash row is closed by default (only Bash: the mod sends a whole command and output for no other tool). A click on the
row opens it to the whole command, then the output with its exit status (a bare check for exit 0, a cross and "Exit N,
failed" otherwise); a second click or the Collapse button closes it. Command and output wrap. The same row serves the
agent panel, the Expand modal, the Respond modal and the session-recording replay. The replay shows the result its
recording already holds (#353); it adds no second copy.

- **Two switches.** The whole command rides the existing `activityFeed` option and `activity-feed` flag. Output has its own
  reporter option and its own Admin feature flag, both off by default.
- **Output is never stored.** It is not in `podium.sqlite`, `activity.sqlite`, the state, the stream or the logs. The server
  holds it in memory only, on the feed's lease. A test checks that a secret in output is found in none of them.
- **Output is captured only while a viewer has the feed open.** A keep policy under #432 lists a loop as watched with no
  viewer; that listing never asks the mod for output; only a live viewer lease does. The reply carries a second list,
  `watchOutput`, a subset of `watch` made only of loops under a live lease while the `activity-output` flag is on. The
  mod captures output for a loop only when it is in `watchOutput` and its `activityOutput` option is on. Extending
  `watch` was rejected: it mixes lease loops with history loops, so the mod could not tell a viewer from a keep
  policy. A reply field is the smallest change: an older server sends none, which the mod reads as "no output".
- **The entry fields.** `id` (the tool call's id, so output that arrives after the entry first went out is matched to
  its entry, and the console can key an open row), `command`, `commandCut`, `output`, `outputCut`, `done`, `exitCode`
  and `failed`, all optional. Stdout and stderr go in one `output` (stdout first). Claude Code's Bash result type has
  `stdout`, `stderr` and `interrupted` but no exit code; the mod reads `isError`, and an `exitCode` only if the result
  text gives one, so `failed` may be true with no `exitCode`. The Admin flag is `activity-output`, "Bash output in the
  activity feed"; the reporter option is `activityOutput`, "Send a Bash command's output" (mockup
  `mockup/podium-feed-expand-admin.html`, approved).
- **The command is kept.** The Activity history (#432) stores the whole command, redacted and cut at 20,000 characters with
  a visible `[cut off at 20000 characters]` marker.
- **Limits.** Command 20,000 characters and output 20,000 characters per entry, each with the marker, the same size as the
  full prompt cap (`fullText`). The report-wide 60,000-character cap (`activityChars`) stays as it is for the 300-character
  summaries; commands and output count against a separate per-loop budget, because 20 entries of 40,000 characters each
  would be 800,000 characters and the old cap would drop nearly all of them. The budget is 200,000 characters of commands
  and output per report (`LIMITS.activityDetailChars`), shared over the orchestrator and the agents, the orchestrator
  first, each from its newest entry back. An entry that does not fit loses its output, then its command, and keeps its
  summary. Why 200,000: it holds ten whole entries (a 20,000-character command and output), enough for a window of
  recent work, and with the 60,000 of summaries and the 120,000 of full text it stays near 380,000 characters, under
  the 512 KB body limit (`BODY_LIMIT`) for ordinary text. JSON escaping and non-ASCII text can push it past that, so
  the mod must also check the serialized size of a report, as the recording does at 480,000 bytes, and drop output
  first when over.
- **Claude Code's own cut.** A Bash result of about 90 KB or more arrives as a short `<persisted-output>` stub. The row
  shows what the mod received, so for that case it shows the stub.
- **Redaction.** `redactBounded` in `mod/podium-reporter/hooks/recording.ts`, as the recording uses. No third approach.

**Why.**

- Output holds more than a command does (file contents, environment dumps, tokens the redactor does not know), so it
  gets its own consent and its own default, apart from the command.
- Capturing only for a live viewer keeps a keep policy from turning every running loop into a standing copy of its output.
- Not storing output means the Admin's retention and size cap never have to account for it.

**Alternatives.**

- Output on the `activityFeed` option. Rejected: it would grant output to everyone who allowed the command line.
- Storing output under the keep policy, as #353 does for recordings. Rejected: a recording has its own three yes answers;
  the feed does not.

**Cost.**

- Redaction in 1,000-character pieces can miss a secret across a cut (see `docs/REPLAY.md`), and it hides some harmless
  long lines as `[redacted]`.
- A person who opens a row after the command finished may find no output, because it was not captured before the feed
  was open.
- A result over about 90 KB shows a stub, not the output.

**Amended (#598): a finished call says so, with or without output.** Under #431 a Bash entry got `done` only together with
output, so a call still running and one that finished before the panel opened looked alike, and the row said "Output was
not collected." for both.

- **What the mod sends.** While `activityFeed` is on, the mod sends `done`, `failed` and `exitCode` on a Bash entry
  whenever the call finishes, with or without output. Output itself is unchanged: it still needs the `activityOutput`
  option, the `activity-output` flag and the loop in `watchOutput`.
- **What the server does.** It keeps the three fields with the entry in memory, as it keeps the rest of the entry. The
  Activity history stores none of them; it stores only the whole command, as before.
- **What the row says.** No `done` and the loop active: "Running." and the word running on the line. `done` with no
  output: "Output was not collected." and the status mark (a bare check for exit 0, a cross and "Exit N, failed" or
  "Failed"), on the line and beside Output. No `done` and the loop not active: "Output was not collected." with no mark,
  a stale call whose end was never reported.
- **An older mod.** It sends no `done` without output, so its rows keep today's wording: running while the loop is
  active, otherwise "Output was not collected." with no mark. An older server drops `done`, `failed` and `exitCode`
  from a session that does not report `activityOutput: true`, so it ignores the new use and its rows stay as they
  were; with the option on it keeps them, which only helps. Neither case is an error, since the fields are optional on
  the entry.
- **A call that throws.** It returns no result, so the mod marks nothing: `done` stays unknown, and the row reads as
  it does for a stale call. A denied call is `done` and `failed` as before, and its reason is output, so it is sent
  only with the output switches on.
- **Running or stale (console).** Only the newest entry of the feed can read as running: a Bash call with no `done`
  and no output, last in the list, in a loop that is working. An older mod never sends `done` without output, so any
  earlier call with none may have finished long ago; a later entry, text included, means the call returned. A call
  that runs beside another reads as not collected until it reports, which claims nothing false. The flag and option
  wording stay ahead of "Running.", since output will not come; the line still says running. The replay is unchanged:
  it knows from the recording whether a call has a result and never says running.
- **Why.** The mod knows when a call ends; the server cannot tell a finished call from a running one without being told.
  The mockup is `mockup/podium-feed-expand.html`, "Rows without output".

## 42. Podium makes its own CA, and the reporter authenticates with a certificate (#577)

**Context.** Podium's traffic is plain HTTP. A reporter sends its token, its reports and the answers it holds
over HTTP, and the browser signs in with a name and a token over HTTP, so anyone on the path can read and
change them. The only advice was a TLS proxy (20, 28, 31). #323 designed the fix over 17 comments and #577
builds it. This entry records why it has this shape. It is built (#577 and its sub-issues).

**Decision.** With TLS turned on (`PODIUM_TLS=on`, `podiumctl start --tls`), the server makes its own CA and
serving certificate in `/data/tls` and opens a second port for reporters, HTTPS with mutual TLS (see the update
below). Each person gets a client certificate in
one generated config file, `reporter-config-<name>-<epoch>.pem`, holding the server address, the CA, the name
and the certificate with its private key, the way `kubeadm` and `kubectl` do. `SPEC.md` 5.9, 6, 6.8, 7.1 and
7.7 have the rules.

- A reporter with the file is identified by its certificate, not a token. A token the person has set is still sent
  inside the TLS connection and the server ignores it. The server authenticates the reporter from the certificate in the TLS
  handshake, mapped to a person by SHA-256 fingerprint, and the report's `userName` must still equal that person,
  as 20 requires. The console keeps its name and token, on plain HTTP (30, and the update below).
- The reporter makes its TLS connection through a small Node helper, started per session, because the mod's
  `$.http.fetch` accepts no CA or certificate. The mod sends its requests to the helper over a Unix socket.
- Revoking the certificate, the token, or both are separate actions. The server checks revocation on every
  request. Plain HTTP stays on loopback so an Admin can always sign in (33 still applies to both ports).
- Serving certificates renew themselves, person certificates renew from the reporter, and the CA rotates only
  by hand, with a cross-signed overlap when planned.
- Reporters over HTTP are an Admin switch, on for an existing install and off for a fresh one that enables TLS.
- macOS and Linux are in scope. Windows is unsupported.

**Why.**

- Tokens in a header over plain HTTP were the accepted cost in 20, 28 and 31. Responding (28) made it worse,
  since the browser's sign-in and held answers now cross the network too.
- The maintainer's model is `kubectl`: the CA arrives inside the credential file and is used for that one
  connection. A person's machine installs nothing and trusts nothing new. A certificate also cannot be lifted
  out of a header and replayed the way a token can, because the private key signs the handshake and is never
  sent.
- A person is still bound to their name (20). The certificate is public and the key proves identity, so a
  stolen database yields no usable reporter credential.
- Revocation had to be easy and separate: "it just blocks the reporter from working, but the user can still log
  in".
- The helper is the one route that was measured to work (Claude Code 2.1.305, 20 of 20 requests at about 2 ms,
  the server saw the certificate on every handshake). `$.http.fetch` ignores `ca`, `cert` and `key`.
  `NODE_EXTRA_CA_CERTS` needs a restart, cannot be set later by a mod, and trusts the CA for the whole process.
  `curl` per request fails on macOS with a combined PEM file. The long-term fix is an engine option on
  `$.http.fetch` (#591), and then the helper goes and the file stays.
- `openssl` and Node's own TLS do the work, with no pure-JS certificate library. The CA lives on durable
  storage so a restart or rebuild never loses it. Reporter identity is read once per session (29), so the
  helper follows the same rule.

**Alternatives.**

- Signed requests over verified HTTPS with `crypto.subtle`. Superseded: the helper gives real mutual TLS.
- A `ca.pem`, a `.pdm` file and a `NODE_EXTRA_CA_CERTS` line with a restart. Superseded by the one file, and kept
  as the documented fallback if the helper is not accepted.
- The reporter setting its own trust at runtime. Does not work.
- A pinned CA hash like `kubeadm join`. Needs the engine option.
- A TLS proxy only (the earlier advice). It still works, and a server with a real name can use one (35).

**Cost.**

- The reporter needs `node`. It looks at `PODIUM_NODE`, then the `PATH` Claude Code started with, then Homebrew, `/usr/local`, nvm and Volta, and says so in the status line when it finds none.
- `$.process` is CLI only per the engine types, so the desktop app and VS Code are untested.
- A stolen `/data/tls` holds the CA key, which is everything the CA signed. It needs an emergency rotation and a
  reissue, and the folder must be backed up and permissioned like a secret.
- A stolen config file holds a person's private key until it is revoked.
- A laptop asleep past both the cross certificate and its own certificate's end needs a reissue.
- Podium now holds a CA, a renewal schedule and a rotation procedure, which is more to run and more to explain.

**Update (#665): reporters get their own mutual-TLS port, the console gets no HTTPS, and there is no grace.** The review
of #663 raised CodeQL `js/disabling-certificate-validation` on the one HTTPS listener, which asked for a client
certificate but did not require one (`rejectUnauthorized: false`) so that a browser could use it too. Every place that
trusts a certificate checked `socket.authorized`, so it was safe as built, but the safety lived in application code.
The maintainer decided to split the traffic by port.

- Port 4317 stays plain HTTP. It serves the console, Admin and any reporter that uses a token. Podium does not serve
  HTTPS to browsers; a person who wants it puts a proxy in front (35).
- Port 4318 (`PODIUM_TLS_PORT`) is HTTPS with `requestCert: true` and `rejectUnauthorized: true`, and serves only the
  routes a reporter calls and `POST /api/reporter/renew`. A connection without a valid certificate is dropped in the
  handshake, and any other path is a `404`. Nothing in Podium sets `rejectUnauthorized: false`.
- A certificate that has expired is not renewed. A reporter renews while the certificate is valid, 30 days before it
  ends. If it lapses, the reporter cannot reach 4318 and an Admin generates a new config for the person. The 30-day
  grace and `tls.reporter.graceDays` are gone.
- The reporter says in the status line and in `/podium` that the certificate expired on a named date and that an
  Admin must generate a new one. Admin > People warns before it lapses.
- Admin > Server > Certificates keeps the CA and the serving certificate. It no longer offers Download CA or any
  text about trusting the CA in a browser, since no browser uses this TLS.

*Why.* The grace was the one flow that needed an unverified client: a renewal with an expired certificate
(`CERT_HAS_EXPIRED`). Dropping it lets the listener verify every client, and it removes the gap where an expired
certificate skipped the hourly renewal limit and the in-flight guard and could renew repeatedly. A renewal answer, a
new CA during a rotation included, now only travels over a connection both sides verified.

*Cost.* A laptop that sleeps past its certificate's end, or a reporter that does not run at any time in its certificate's last 30 days
(it can lapse after a little over a month away, and always does after 90), needs an Admin to reissue its config. Revocation is checked on every request and not in
the handshake, since the handshake cannot know it. The planned-rotation overlap stays at 120 days, which now leaves a
margin over a default 90-day certificate and does not cover a certificate set to the 365-day maximum.

## 43. The docs site is Astro Starlight, and each version is built from its git tag (#688)

*Context.* The docs are Markdown files in `docs/`. The maintainer wants them on GitHub Pages at
`podium.engelking.dev` (#689) with a menu, search, SEO and a version dropdown that opens on the latest release. The
site is a separate project in `site/`, not part of the server or the UI, and `docs/` stays the only source.

*Decision.*

- The generator is Astro Starlight. Search is Pagefind, built into Starlight, client-side, with no outside service.
- A version is a release line (`1.3`), and the site shows the newest patch tag of each line. The latest line is served
  at `/`, and older ones at `/<line>/`.
- Each version is built from that tag's `docs/` (`git archive <tag> docs`) in its own Starlight build, and the builds are
  put together into one site. Nothing is copied into the repo for an old version.
- A small build step prepares the pages before Starlight reads them: it gives a page a `title` from its first heading
  until every page has frontmatter (#696), and rewrites links between pages to site routes.
- The dropdown is a Starlight component override. Each build is given the whole version list, so the menu needs no
  request, and "same page in another version" sends a person to the page when that version has it and to that version's
  front page when it does not.
- The newest version is built from the working tree, not a tag, because the site is built when `main` moves and the tag
  comes after. Older versions are noindex and out of the sitemap, so a search finds the current page and not five copies.
- The menu lists what each version has: an older release may lack a page the newest has.
- The community plugin `starlight-versions` is not used.

*Why.* A spike, run before the choice was made, built the real docs two ways with Starlight 0.42.7 and Astro 7.4.2.

- `starlight-versions` 0.10.1 snapshots the current pages into the repo and parses every page as MDX, including `.md`
  files. It stopped at the first unescaped `<feedback>` in `docs/ARCHITECTURE.md` and then at a `<time>` elsewhere. The
  docs are plain Markdown that quotes tags in prose, and every new page would have to be written to MDX's rules. It also
  keeps a second copy of each old version in the repo.
- Building from a tag needed no plugin. v1.2.2 and v1.3.0 each built in about two seconds (11 and 13 pages), with Pagefind
  indexes of their own, so an old version searches only its own pages. Put together, the latest sits at `/` and the older
  one at `/1.2/`, with its links and assets under that path. The latest has to be built first, since a build empties its
  output folder.
- The link validator (`starlight-links-validator` 0.27.0) ran on the 1.3.0 build and reported 5 invalid links in 2 files,
  which the build step or the docs have to fix. Links written as `FILE.md` do not become site routes by themselves.

*Alternatives.* Docusaurus versions natively, but it copies each version into the repo like the plugin does and brings a
heavier toolchain. MkDocs Material with `mike` and Hugo were not tried. Neither shares the maintainer's website stack,
and the spike showed Starlight can do what was needed.

*Also decided.* The site's accent is the console's blue, `--sonnet`, for what is selected and what can be clicked, with the
status colors `--good`, `--warn` and `--crit` for tip, caution and danger callouts. It borrows a model color for a non-model
job. The maintainer approved that when the mockup was accepted on #688, and since the site is not part of the app the
standards pages do not change. Search is Pagefind over the docs pages only;
`docs/standards/` and the atlas page are served as they are and are not indexed. The interactive atlas page is served at
`/atlas-map/`, because `/atlas/` is the page built from `ATLAS.md`. The site loads its two fonts from Google Fonts, as the
console's mockups do.

*Cost.* The version dropdown, the combined build and the link rewrite are ours to write and keep. A tag's `docs/` is built
with today's theme, so an old version looks like the current site and not like it did. A tag whose docs do not build
needs a fix in the build step, not a change to the tag. Versions start at the first release that ships with the site
(v1.3.1 is the first); earlier ones are not back-filled.
