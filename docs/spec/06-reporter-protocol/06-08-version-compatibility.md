---
title: "6.8 Version compatibility"
description: "How the mod and server versions may drift, the supported range, and how each side tells the person."
group: "Reference"
section: "6.8"
order: 8
---

# 6.8 Version compatibility

The mod and the server are released separately, so their versions can drift in either direction. The server
keeps one range, `REPORTER_SUPPORT` in `server/src/fleet/compat.ts`: the oldest and newest reporter (mod)
versions it reads correctly. It changes when the report format or the mod's behavior needs it, not on every
release.

Only `major.minor` is compared, so a mod-only patch fix never warns. `checkReporter` returns:

| Result | Meaning | What to do |
|---|---|---|
| `ok` | Inside the range. | Nothing. |
| `outdated` | Below `min`. | Update the mod: `claude plugin update podium-reporter@eengelking-marketplace`, then `/reload-plugins`. |
| `newer` | Above `max`. | Upgrade the server. |
| `unknown` | The version is not `X.Y.Z` (the simulator's `0.1.0-sim`, for one). | Nothing. No warning is shown. |

A mismatch is a warning, never an error. The server still accepts and shows every report it can read.

## What the mod and the dashboard show

- The reply to a report carries `serverVersion`, `reporterSupport` and `reporterCompat` for that report's
  version.
  - A mod that reads them shows `· update mod` or `· upgrade server` on its status line, a line in `/podium`,
    and a toast once.
  - A reporter inside the range but a major.minor below `reporterSupport.max` shows `· update available`
    instead (a patch difference is not flagged). This needs no new server field.
  - A mod that predates this ignores the fields. A mod talking to a server that predates this sees no
    `reporterCompat` and shows nothing.
- `SessionView` carries `reporterVersion` (null for a hooks-only session, which has no mod), `reporterBuild`
  (see Builds below) and `compat` (always `unknown` for hooks). `StateBody.server` carries
  `{ version, build, reporterSupport }`, and the UI shows the server version, and its build for a dev build, in
  the left rail footer.
- **Builds (#400).** A release is a clean checkout of exactly a `vMAJOR.MINOR.PATCH` tag. Every other build is a
  dev build, whatever branch it came from, and is named by the 8-character commit hash, with `-dirty` after it
  when the tree had local edits. A release has no build: the field is `null` and only the version shows. The
  server's build comes from `PODIUM_BUILD`, which `podiumctl build` passes into the image, or from
  `server/build.json`, which a standalone `podiumctl build` writes; with neither (a build made without git) it is
  `null`. The mod finds its own only when it runs from a checkout of this repository, where `mod/podium-reporter`
  is tracked by git: an installed copy has no repository, so it is a release. It sends `reporter.build` only for
  a dev build; the server keeps only a value that is a commit hash and stores it on the session as
  `reporter_build`. The server's reply to a report carries `serverBuild` (null for a release). An older mod sends
  no build and is a release, and an older server sends no `serverBuild`, so the mod shows the version alone.
  The mod's status line shows `podium v1.1.0 | dev: a1b2c3d4 ● 2 live` in every connection state, and `/podium`
  and the facts bar show `1.1.0 · Dev: a1b2c3d4`. A release shows what it showed before.
- The dashboard marks each affected card, counts them in the top bar, and says what to do on the session's
  page.

## Responding moves the range to `{ min: "0.2.0", max: "0.14.0" }` (#206)

Reporter 0.14.0 adds `session.respond`, `session.asks`, `session.clearedFrom`, the ask and delivery routes
([7.1](../07-server/07-01-endpoints.md)) and the `respond` option ([5.9](../05-mod-api/05-09-mod-configuration-userconfig.md)). So `plugin.json`'s
`version` and `VERSION` in `register.ts` move to 0.14.0.

- `min` stays. An older reporter still reports as before, and its sessions show "Reporter can't answer",
  because their reports carry no `respond`.
  - The modal's note names the version from `reporterVersion`, or reads "an older podium-reporter" without
    one, and asks for an update.
  - For a session reported by the settings hooks, a `claude -p` run, or a computer where the permission hooks
    don't run, the note says that instead and asks for no update, as the mockup's frames show. A session that
    reports `not-interactive` may be a `claude -p` run or a Claude desktop session no window has opened yet, and
    the console cannot tell them apart, so its note names both (#837).
- A 0.13 reporter now shows `· update available` on its status line.
- A server older than this ignores the new fields and sends no `respond`, so a 0.14 reporter never announces
  an ask to it.
- Plan approval was verified on Claude Code 2.1.301. The report already carries Claude Code's version as
  `reporter.engineVersion`, and because the mod checks that each approval took
  ([5.3](../05-mod-api/05-03-events-the-reporter-hooks.md#responding-from-podium)), a different version degrades to "approve it in the terminal" rather than
  failing quietly.

## Session recording and the range (#353)

Session recording adds `session.sessionRecording`, the reply's `recording`, the recording routes ([7.1](../07-server/07-01-endpoints.md))
and the `sessionRecording` option ([5.9](../05-mod-api/05-09-mod-configuration-userconfig.md)), all of them ignorable by the other side.

- An older mod sends no `session.sessionRecording`, so the server reads its owner as not allowing it and never
  lists a loop to record. The console says "an older podium-reporter" in the picker's note.
- An older server sends no `recording`, which a newer mod reads as `off`, so it captures nothing.
- Which release carries it is decided in its `release-prep/<version>` PR, which then moves `plugin.json`, `VERSION`
  and, on a new minor, `max` in `REPORTER_SUPPORT`. A feature PR for #353 changes none of them.

## The release check (#499, `mockup/podium-update-notice.html`, `mockup/podium-update-check-admin.html`)

Podium has no registry, so people update by pulling the new release and running `podiumctl build`. The server tells
them when one exists. The mod and the server share one version, so an out-of-date server also means an out-of-date
reporter, and the reporter's own check above still covers the mod.

- **Where it runs.** On the server, once per server, never in a browser, so it is one request a day however many tabs
  are open and the page's `connect-src 'self'` ([7.7](../07-server/07-07-hardening.md#response-headers-and-the-container-249)) is unchanged.
- **When.** About 30 seconds after the server starts, then every 24 hours. It does not run on a request.
- **What it asks.** `GET https://api.github.com/repos/eengelking/podium/releases/latest`, with a 10 second
  timeout. GitHub's `latest` is never a draft or a pre-release, and a tag that is not `vMAJOR.MINOR.PATCH` is
  ignored as well. Nothing about the install, the sessions or the people is sent.
- **The comparison.** The tag's `MAJOR.MINOR.PATCH` against the server's own version (`StateBody.server.version`), all
  three numbers. A version that is not `MAJOR.MINOR.PATCH` (a dev build's `unknown`, the simulator's `0.1.0-sim`)
  never shows a notice. The release link is built from the tag (`https://github.com/eengelking/podium/releases/tag/vX.Y.Z`); the
  `html_url` in the reply is not used.
- **Who sees it.** Every viewer of the wall, in the notice stack ([8.1](../08-ui/08-01-what-the-ui-must-do.md#wall-notices-114-mockuppodium-wall-noticeshtml)).
- **Dismissing it** hides the release it names, for everyone, until a newer release than that one is published. The
  version is kept in the `settings` table (`wall_update_dismissed`), so it survives reloads and a restart. It only ever
  moves forward: a tab closing an older release does not bring back a newer one already closed.
- **A failed check is silent.** Offline, rate limited, a bad status, a reply it cannot read, no answer: the wall shows
  no notice and no error, the last good answer is kept, and the next daily check tries again. The server writes one
  short `update.check_failed` warning per failed check.
- **The switch.** Admin > Settings > Feature flags > **Release check** (`update-check`). It is **on by default**. Off, the
  server makes no request to GitHub at all and holds no notice, for installs that must not make outbound calls.
  Turning it on checks at once instead of waiting for the next daily run.
- **What reaches the wall.** `StateBody.wall.update` is `{ latest, url }` while there is a newer release that
  nobody has closed the notice for, and `null` otherwise (an older server sends no field, which reads as `null`). A
  change reaches open tabs through the `wall` stream event.

---

## Authenticating by certificate (#577)

Designed in DECISIONS 42. With TLS on ([7.7](../07-server/07-07-hardening.md), *Built-in TLS*), `POST /api/fleet/report` and every
other route the mod calls can be made over mutual TLS, through the helper ([5.9](../05-mod-api/05-09-mod-configuration-userconfig.md)), on
the reporter port (4318 by default). That port serves only those routes and the renewal route, and only to a client
with a valid certificate. The console is on the HTTP port.

- **Who is calling.** The server authenticates the person from the certificate in the handshake and not from
  `X-Podium-Token`. The reporter port is `https.createServer` with `requestCert: true` and `rejectUnauthorized: true`
  and the Podium CA(s) as `ca`, so a connection with no certificate, an expired one or one from another CA is dropped
  in the handshake and no route runs. The server then looks the certificate up by its SHA-256 fingerprint and checks it
  is not revoked, which the handshake cannot know. The report's `userName` must still equal that person (DECISIONS 20).
- **The token.** A reporter that has a config file is identified by its certificate. A token set in the options or
  in `PODIUM_TOKEN` is still sent with its requests, inside the TLS connection, and the server ignores it when a
  certificate is present. A reporter without a file sends its token over HTTP, while the Admin allows reporters
  over HTTP. The console signs in with a name and a token as before.
- **Renewal.** `POST /api/reporter/renew` is authenticated by the person's current certificate. The body carries
  the reporter's new public key (no Node API builds a CSR), and the response carries a new certificate for it.
  The helper writes the new certificate and the CA(s) in one atomic write, so the file never holds one without
  the other. The reporter renews when 30 days of the certificate are left, or half its lifetime when that is shorter (a certificate
  that lasts under 60 days). A renewal needs a certificate that is
  valid in the handshake, so its answer, a new CA included, only travels over a connection the reporter's side and
  the server both verified.
- **Renewal limit.** A person's certificate is renewed at most once an hour. While the person's newest live
  certificate was issued less than an hour ago, the server answers `429` with a `Retry-After` header (seconds, at
  most 3600) and the code `TOO_SOON`, before it signs anything or stores a row, and a second request that arrives
  while one is being signed counts the same way. The window is fixed and is not a setting. The reporter treats a
  `429` as a wait and not a refusal: it goes on with the old certificate and asks again after `Retry-After`, and
  never sooner than a minute.
- **No grace (#665).** A certificate that has expired is not renewed. It cannot reach the reporter port, so there is
  no renewal to answer and nothing for a forged expired certificate to pass for. An Admin generates a new config
  for the person (Reissue config). The helper compares the certificate's `notAfter` with its clock before it
  connects, sends nothing, and answers every request with `CERT_EXPIRED`, which the mod words as "Your Podium
  certificate expired on 2026-08-30. Ask an Admin to generate a new reporter config." in the status line and in
  `/podium`.
- **A new CA in the response.** The renewal response adds `rotation: { ca, cross }` (the new CA and its cross
  certificate) while a planned overlap is open, and leaves the field out at every other time. Only for a planned CA rotation, as an addition, with a cross certificate that
  verifies under the CA the reporter already holds. After an emergency rotation the server does not offer it
  ([7.7](../07-server/07-07-hardening.md)).

## Compatibility and the certificate reporter (#577)

The reporter that reads a config file and starts the helper is a new minor version of the mod, so it ships with
a release like any other mod change, and `REPORTER_SUPPORT.max` moves to that release's `MAJOR.MINOR.0` in the
same release-prep PR. A mod without it keeps working against a server with TLS on while the Admin allows
reporters over HTTP, and a mod with it keeps working against a server with TLS off by using no config file.
The renewal response carries no new `reporterSupport` field.

<!-- nav:start -->
---

Previous: [6.7 Reporting cadence](06-07-reporting-cadence.md) · Up: [6. The reporter protocol](README.md)
<!-- nav:end -->
