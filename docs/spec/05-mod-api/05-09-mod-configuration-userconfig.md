---
title: "5.9 Mod configuration (userConfig)"
description: "The mod's options, how identity is set, and the reporter config file used with TLS."
group: "Reference"
section: "5.9"
order: 9
---

# 5.9 Mod configuration (userConfig)

Declare the options in `plugin.json`. **Assumption:** confirm the exact `userConfig` field syntax with
`claude plugin validate`. The reference says a field may list `options` and `default`, and secret fields are
supported.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `serverUrl` | string | `http://127.0.0.1:4317` | Where to POST. |
| `token` | string (secret if supported) | empty | Sent as `X-Podium-Token` when non-empty: a person's token from Admin ([7.7](../07-server/07-07-hardening.md)), or the admin secret. |
| `userName` | string | empty | The person's name as the server owner entered it (see below). |
| `flushIntervalMs` | number | `1000` | Minimum time between reports while something changes. |
| `heartbeatMs` | number | `5000` | Report at least this often even when nothing changed. |
| `sessionName` | string | empty | Override display name for this machine's sessions (rare). |
| `showStatus` | boolean | `true` | Show the status line (`podium v<version> ● N live` and its offline and refused states). |
| `explainFailures` | boolean | `false` | Phase 5 only. When true, ask a small model to explain a failure (costs tokens). |
| `fullPrompts` | boolean | `false` | When true, send each agent's whole task prompt and final answer as `promptText` and `answerText` ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)). Off by default: only the 400-character excerpts are sent. |
| `activityFeed` | boolean | `false` | When true, send the activity feed (see below). Title "Send an agent's recent activity". |
| `activityOutput` | boolean | `false` | When true, the mod sends a Bash command's output with its activity entry, only for a loop a viewer has the feed open on (see below). Title "Send a Bash command's output". Needs `activityFeed` on. |
| `fileDiff` | boolean | `false` | When true, the mod reads one file's diff when the console asks for it (see below). Title "Send a file's diff on request". |
| `respond` | string, one of `off`, `questions`, `questions-and-plans`, `everything` | `off` | What this session accepts from Podium (see below). Title "Respond from Podium". |
| `peers` | boolean | `false` | When true, this machine's orchestrators can message the owner's other orchestrators through Podium, within the rights the owner set ([5.3](05-03-events-the-reporter-hooks.md#orchestrator-messaging-from-the-reporter-347)). Title "Message my other orchestrators". Set once per machine; the server cannot change it. The server takes it in the report (`session.peers`, #412). Read from `register`'s options (#414); the report sends `session.peers` true only with the option on and an interactive session. |
| `sessionRecording` | boolean | `false` | When true, this machine's sessions may be recorded whole when someone with the right chooses to ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md#session-recording-opt-in-353)). Title "Allow session recording". Set once per machine; the server cannot change it. The report sends `session.sessionRecording`. |

Read the options via the `options` argument of `register`. A config change reloads the module.

## Notes on six options

**`userName`**
- Sent as `Report.userName`, with `Report.machine`. The server accepts a report made with a person's token
  only when the name matches. Empty sends neither.
- Claude Code keeps it in `~/.claude/settings.json` under
  `pluginConfigs["podium-reporter@eengelking-marketplace"].options` (the key is `podium-reporter` for a
  `--plugin-dir` load).

**`activityFeed`**
- When true, the mod sends the activity feed (`activity`, [6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)) of each loop
  the server's reply lists as watched: its tool calls and the text it writes, the last 20, each redacted and
  cut to 300 characters. It also sends `session.activityFeed`.
- Off by default: nothing is captured and `watch` is ignored.
- Turning it on is also consent to the Activity history: if the Admin has chosen to keep it (#432), the server
  lists every running loop of the session as watched, so these entries are captured and stored on the server
  whether or not anyone watches, until the Admin's period ends. The option description in the mod's
  `plugin.json` says so.

**`activityOutput`** (#431)
- When true, the mod adds what a Bash call printed (stdout then stderr), and how it exited, to that call's activity
  entry ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)), and sends `session.activityOutput`. It needs `activityFeed` on as well.
- Off by default and separate from `activityFeed`: the whole command rides `activityFeed`, the output needs this
  too, because output holds more than a command does (file contents, environment dumps, tokens the redactor does not
  know). Neither implies the other.
- The mod sends output only for a loop in the reply's `watchOutput` ([6.1](../06-reporter-protocol/06-01-endpoint.md)), which lists only loops a
  viewer has the feed open on. A loop that is in `watch` only because the Activity history keeps it is never asked
  for output.
- Its description in `plugin.json` says output can hold secrets the redactor does not recognize.

**`fileDiff`** (#319)
- When true, the mod answers a request in the reply's `diffs` ([6.1](../06-reporter-protocol/06-01-endpoint.md)) by sending the diff of that
  one file ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)). It also sends `session.fileDiff`.
- Off by default: no diff is ever read, `diffs` is ignored, and nothing leaves the machine. It is separate from
  `activityFeed`, so a person can allow one without the other.
- A diff is source code and can hold a secret. The mod redacts what looks like one before it leaves the machine
  ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)), but that is best effort and not a guarantee. This option, the Admin's
  flag and the owner-or-Admin gate are the control, and the User Guide says so.

**`respond`** (#206, [5.3](05-03-events-the-reporter-hooks.md#responding-from-podium))
- `off`: nothing.
- `questions`: answers to questions, and new messages while idle.
- `questions-and-plans`: the above, plus approving or rejecting a plan.
- `everything`: the above, plus allowing or denying a tool (allow once only), and `/clear`, `/compact`.
- Any other value reads as `off`.
- It needs `activityFeed` on as well. With that off, the mod accepts nothing.
- Set it with `/plugin configure podium-reporter@eengelking-marketplace`.
- The mod enforces its own level and never relies on the server for it.

**`sessionRecording`** (#353, [6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md#session-recording-opt-in-353))
- It is the session owner's consent, the third of three yes answers. With it off the mod captures nothing for a
  recording, whoever chose the session and whatever the Admin has switched on, and it says so in the terminal when a
  recording was chosen anyway (see *Session recording from the reporter* in [5.3](05-03-events-the-reporter-hooks.md)).
- Off by default and separate from `activityFeed`, `fullPrompts` and `respond`: none of them implies it, and it
  implies none of them.
- A recording holds whole prompts, file contents, command output and tool results. The mod redacts what looks like
  a secret before it leaves the machine, but that is best effort and not a guarantee. The option's description in
  `plugin.json` says so.
- Set it with `/plugin configure podium-reporter@eengelking-marketplace`. The mod reads it at `register` and enforces
  it itself; it never relies on the server for it.

## Identity (#226)

- The options are one set per Claude config directory, so two terminals on one machine share them, and a
  config change reloads every running session's module.
- A session's name and token are therefore taken once, at `session.start`, and held in `$.state`
  (`podium-reporter.identity`, declared in the mod's `types/index.d.ts`) for the rest of the session. A reload
  with different options does not change them.
- At that first start the mod uses, in order:
  1. the terminal's `PODIUM_USER` and `PODIUM_TOKEN` environment variables, taken together (when either is
     set, the shared `userName` and `token` are not used);
  2. the `userName` and `token` options.
- A session with no token holds nothing, so adding one later still applies.
- To change who a running session reports as, start a new session.
- A session that belongs to someone else is still refused ([7.7](../07-server/07-07-hardening.md)).

**Known limit (#230).** `/plugin configure` therefore holds one login per Claude config on a machine. The engine gives a
mod one shared set of `userConfig` values and no storage for a single session's login:

- `$.state` is per session but only the mod can write it, and the mod cannot tell which session's person just
  signed in;
- `$.store` is shared;
- a `sensitive` field such as `token` is not a `/config` row, so no `config.set` hook sees it change.

Two logins on one machine are possible only through the environment variables above. If the engine gains a
per-session login or a way to tell which session a sign-in came from, the mod should use it.

## The reporter config file (#577)

With TLS on ([7.7](../07-server/07-07-hardening.md), *Built-in TLS*), a reporter authenticates with a certificate instead of a token.
Everything it needs is in one file the Admin gives the person once. Designed in DECISIONS 42.

- **Name.** `reporter-config-<name>-<epoch>.pem`, where `<epoch>` is the second the file was issued.
- **Format.** A PEM-style text file, in this order:
  1. The first line, `# podium-reporter-config v1`.
  2. Header lines, `# key: value`: `user`, `server`, `issued-at` (an ISO time and an epoch), `expires` and
     `fingerprint` (the SHA-256 of the person's certificate).
  3. PEM blocks: the CA certificate (one, or two during a CA overlap, [7.7](../07-server/07-07-hardening.md)), the person's
     certificate and the person's private key.
- **Parsing.** By block type and role, never by position. A `CERTIFICATE` block is a CA certificate or the
  person's certificate according to whether it is a CA. `PRIVATE KEY` is the key. A reader ignores a header line
  it does not know.
- **Where it is found.** In this order (#606):
  1. `PODIUM_REPORTER_CONFIG`, if set, names the file. It is a plain environment variable read with `$.env.get`, not a
     `userConfig` option.
  2. The context `PODIUM_REPORTER_CONTEXT` names, if that is set, else the current context in
     `~/.podium/contexts.json` (see *Contexts* below).
  3. The newest `reporter-config-*.pem` in `~/.podium/`, by the epoch its name carries (`<epoch>` in
     `reporter-config-<name>-<epoch>.pem`); every other file there is ignored (a reissue leaves older files beside the
     new one, and the old certificate is revoked). The mod reads one file at a time, newest name first, and takes the
     first whose header lines are valid, so the private key of a file that is not chosen is never read (#607). A name
     with no epoch is tried last. A file renamed so its epoch no longer matches its `issued-at` line is ranked by its
     name.

  `~/.podium/` is also `podiumctl`'s home, and the names do not collide.
- **No file.** The reporter keeps working as today: the `serverUrl` and `token` options over HTTP, if the server
  allows reporters over HTTP.
- **With a file.** `serverUrl` is the address in the file. The reporter never sends a credential over `http://`
  when the URL was `https://`, and never falls back to HTTP unasked.
- **Permissions.** The file holds a private key. The reporter refuses, or tightens, a file that is group- or
  world-readable, as `ssh` does, and the box that shows the file says `chmod 600`.
- **Identity.** The file is read at `session.start`. Before each request the helper checks the file's modification
  time, and when it changed it re-reads the file only if the name in it equals the session's name (DECISIONS 29),
  then builds a new connection from it. It keeps the last good copy if a read fails. So a renewal made by another
  session, or a reissued config saved over the same file, is used within seconds. A new file saved under another
  name is used from the next session, and the server address stays the one read at start.

## Contexts (#606)

A context is a name for one reporter config file, and so for one server and one person, the way a kubeconfig names a
cluster. They are for someone who uses more than one Podium server. Designed in DECISIONS 46.

- **File.** `~/.podium/contexts.json`: `{ "current": "<name>" | null, "contexts": { "<name>": "<file>" } }`. A name is
  up to 64 letters, digits, dots, dashes and underscores, starting with a letter or digit. A file is a bare name in
  `~/.podium/` or an absolute path; a relative path with a folder in it is refused, so nothing climbs out of
  `~/.podium/`. A file that is not valid JSON of this shape reads as no contexts at all and is never overwritten by a
  command. A `current` that names no context reads as none. The format of the reporter config file does not change.
- **Selection.** `PODIUM_REPORTER_CONFIG`, then `PODIUM_REPORTER_CONTEXT` (one terminal, the way `kubectl --context` does
  for one command), then `current`, then the newest file. With no contexts file, or none current, the reporter chooses
  as it did before contexts, so a person with one server sees no change.
- **A context that cannot be used** (it names a context the file does not have, its file is missing or is not a reporter
  config, or `contexts.json` is unreadable) is shown, not hidden: `/podium` prints `Context problem:` with the reason and
  the line goes to the mod's debug log, and the reporter falls back to the newest file so it keeps reporting. It does not
  stop the session, as a bad `PODIUM_REPORTER_CONFIG` does, because that variable names one file on purpose and a
  context is a convenience over the folder.
- **Running sessions.** A session keeps the config it started with, as it keeps its identity ([Identity](#identity-226),
  DECISIONS 29). Changing the current context changes the next session and the reply says so. Two sessions on one machine
  can use two contexts at once, through `PODIUM_REPORTER_CONTEXT` in each terminal.
- **Commands.** `/podium context` and `podiumctl context`, with the same verbs on the same file: `list` (the default),
  `show [name]`, `add <name> <file>`, `rename <name> <new>`, `remove <name>` and `use <name>`. `add` checks that the file
  exists and is a version 1 reporter config before it writes. `remove` never deletes a config file. The first context
  added becomes the current one.
- **Where it shows.** The status line puts the context's name in brackets after the version (`podium v1.4.0 [work] ● 3
  live`), and `/podium` prints `Context: <name> (<server>)`. Neither appears when no context chose the file.

**The helper.** The mod cannot give `$.http.fetch` a CA or a client certificate, so podium-reporter starts a small
Node script, `hooks/helper.mjs`, once per session. It makes the TLS connection with the CA and certificate from
the file, and the mod sends its requests to it over a Unix socket with `$.http.fetch(..., { socketPath })`.

- It is started as `node helper.mjs <config path> <socket path> <server url>` and prints `ready` on its stdout
  when it is listening. The mod waits for that line, not for the socket file.
- It forces `rejectUnauthorized: true` and starts with `NODE_TLS_REJECT_UNAUTHORIZED` and `NODE_OPTIONS` cleared.
- It uses one socket per session, in a directory with mode 0700, and the socket is `chmod 0600`. A socket path is
  104 bytes at most on macOS and 108 on Linux.
- It exits when its parent dies and removes only its own socket. A `session.end` with reason `clear` does not stop
  it.
- A failure comes back as an `X-Podium-Helper-Error` header (`CERT_HAS_EXPIRED`, `ALTNAME`, `ECONNREFUSED`,
  `CLIENT_CERT_REJECTED` and so on). It aborts the response on a mid-body upstream error, so a truncated reply is
  never read as a `200`.
- It writes the config file atomically (a temporary file, then a rename) under a lock, because several sessions
  can renew at once, and keeps the mode 0600.
- It forwards only the calls a reporter makes, the same list as the reporter port ([7.7](../07-server/07-07-hardening.md), Ports), kept
  as a copy that a test compares with the server's. It builds the upstream request from the matched route, and
  anything else is answered `403` with `X-Podium-Helper-Error: ROUTE_NOT_ALLOWED`, without going upstream.
- When the certificate's end date has passed on this machine's clock it answers every request `502` with
  `CERT_EXPIRED` and sends nothing upstream. The reporter treats that as any failed send: it keeps its reports and
  retries with a back-off of at most 10 seconds, and `/podium` shows `offline, retrying` beside the reason.

**Platforms.** macOS and Linux are in scope. Windows is out of scope and unsupported. The mod runs on the command
line only: `$.process` is provided only there per the engine types, so the desktop app and VS Code are not covered.

**How the reporter finds `node`.** The helper needs `node`, and a Claude Code started from a desktop launcher
often has no `nvm` or Homebrew `PATH` (measured: the spawn fails with `ENOENT`). The reporter uses the file named
by `PODIUM_NODE` if that is set. Otherwise it runs `node` on the `PATH` Claude Code started with, then looks in
Homebrew's and `/usr/local`'s `bin`, `~/.volta/bin`, `~/.local/bin` and the newest version under `~/.nvm`. A missing
`node` is reported plainly (below).

<!-- nav:start -->
---

Previous: [5.8 Session identity, /clear, restarts](05-08-session-identity-clear-restarts.md) · Up: [5. The Claude Code mod API: everything the reporter needs](README.md) · Next: [5.10 Alternatives and extras the implementer may use](05-10-alternatives-and-extras.md)
<!-- nav:end -->
