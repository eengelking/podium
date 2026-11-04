# plugin/opencode

The OpenCode reporter (#855). It watches OpenCode 2.x sessions and reports them to Podium, and (#858) answers a permission, a question, a message and `/compact` from
Podium where the person turned that on. It is written in TypeScript against `@opencode/plugin`, which OpenCode supplies at runtime, and it imports the code
every reporter shares from `../core/` (report types, transport, failures, redaction, plan, git). It never imports `../claudecode/`;
`server/src/plugin.test.ts` fails if it does.

| File | What it does |
|---|---|
| `index.ts` | The plugin entry: `Plugin.define`-shaped glue. Subscribes to `ctx.event`, runs the flush timer, returns the cleanup. Keeps one `Reporter` per location on `globalThis`, because module state is not shared between plugin loads. |
| `state.ts` | Folds one bus event into a `Store`. A root session and the child sessions it launched are one `Root`: one record, one report; a child is an agent. |
| `report.ts` | A `Root` as a v2 report: the `harness` block, the capabilities and `costSource: 'harness'`. |
| `reporter.ts` | The runtime: one `Transport` per root, the flush `tick`, the idle sweep, the branch read and the bounded final flush. `handle` never waits for the network. |
| `answering.ts` | Answering from Podium, driven by the flush tick: starts a wait for each open ask, acts on the messages and commands a reply hands over, and says what the session accepts. The announcing, waiting and reporting back are `../core/respond.ts`. |
| `answer.ts` | Pure: the asks Podium is shown (redacted and cut), the reply OpenCode takes for a permission, the form answer for a question, and the label a message carries. |
| `host.ts` | The calls into OpenCode: `permission.reply`, the session prompt and compact API, and the two ways to answer a question form. |
| `bridge.ts`, `tui.ts` | The TUI part. The server part cannot answer a form, so it hands the answer to the TUI part as a plugin RPC event, and the TUI part replies with `session.form.reply`. `tui.ts` is the package's `./tui` export. |
| `options.ts` | Settings from `PODIUM_*` and `~/.podium/config.env` (`../core/settings.ts`), `idleSeconds` from the plugin options, then the defaults. |
| `tls.ts` | The secure connection (#948): finds the reporter config file the way the Claude reporter does (`../core/tls/findConfig.ts`), makes the mTLS client in this process (`../core/tls/client.mjs`), and gives the `Reporter` a `fetch` through it. A file that cannot be used becomes a link that sends nothing and says why, once, as a `podium-reporter:` console line and in `Reporter.statusText()`. |
| `notice.ts` | Pure: the console lines said once (`dedupe`), the text of `/podium`, and the toast the TUI part shows when the connection changes. |
| `window.ts` | Pure: a model's context window from a `ctx.model.list()` answer. |
| `machine.ts` | The machine id (`~/.podium/machine-id`, shared with the Claude reporter) and the settings file read. |

## What it reports

- Model and provider (from `session.step.started`), tokens and cost from `session.usage.updated`. The root's usage already includes its
  children's, so the session cost is the root's figure and a child's cost is its own; nothing is added twice.
- Context is the last step's prompt: input plus cache read plus cache write. The window comes from the model list (`ctx.model.list`, the
  model's `limit.context`), asked for in the background the first time a model is seen, so the percent appears on a later report. A model
  the list does not hold has a context size and no percent.
- Effort is the model's variant on `session.step.started` (`model.variant`), reported as the free string OpenCode gives with
  `effortSource: 'observed'`. A step with no variant reports effort as unknown; the model's default is not on the bus.
- Skills come from `session.skill.activated`. Tokens per model and prompt-size tier (`usageByModel`) are totalled from each finished step.
- A failure carries the engine's error text, and "Blocked by permission" when a person rejected a permission and that call then failed.
  A call that failed twice or more is listed as evidence.
- Tools with input and result, permission asks and questions (the session is `waiting`), compaction, the plan from the todo tool, failures,
  and the git branch.
- A session is `done` after it has been quiet for `idleSeconds` (default 60), at once on `session.deleted` or `session.archived`, and when the
  plugin is cleaned up (one final, time-bounded flush). It reopens under the same id when it sees activity again.

## Answering

Off unless `PODIUM_RESPOND` and `PODIUM_ACTIVITY_FEED` are `true` in the environment or `~/.podium/config.env`, and the Admin's flags are on. Then:

- **Permission:** allow once or reject, with `permission.reply`. Never "always".
- **Question:** answered by field key. Through the TUI part when a TUI is attached (it says so every 30 seconds); otherwise through OpenCode's local
  route with the address and password in `service.json`, read only when an answer is sent and only for an address on this machine; otherwise Podium
  is not offered the question, because it could not be answered.
- **Message and `/compact`:** `session.prompt` and `session.compact` with `delivery: queue`, Podium's delivery id as the idempotency `id`. A message's
  text starts with a line saying it came through Podium, because OpenCode hands the model the text as the user's own.
- **Not offered:** plan approval and `/clear` (OpenCode has no equivalent), and always-allow.

## Settings

Settings are read only from the environment and `~/.podium/config.env`, never from `opencode.json` (a repo can ship that): `PODIUM_SERVER` (default
`http://127.0.0.1:4317`), `PODIUM_TOKEN`, `PODIUM_USER`, `PODIUM_IDLE_SECONDS` (at least 5; also accepted as the `idleSeconds` plugin option) and the consent
options. Three plugin options, named and bounded as in the Claude Code reporter, are the only others read from `opencode.json`: `flushIntervalMs` (default 1000, at least 200),
`heartbeatMs` (default 5000, at least 1000) and `sessionName` (empty; it names a session OpenCode has not named, and OpenCode's own title wins). A Podium server with built-in TLS needs a client certificate: save the reporter config file the Admin gives you (`reporter-config-<name>-<epoch>.pem`) in `~/.podium/`
and run `chmod 600` on it, and the reporter connects to the address in it over HTTPS with your certificate (no token needed). `PODIUM_REPORTER_CONFIG` and `PODIUM_REPORTER_CONTEXT`, from the
same two places, choose another file; with no file nothing changes. The client starts with the reporter, renews the certificate when it is due, and stops when the plugin is cleaned up. What this trusts and why is in [the threat note](../../docs/REPORTER.md#the-opencode-reporter-what-it-trusts).

## What it tells you

- The transport's notices (token refused, session belongs to someone else or to another harness, server too old for report version 2) are written once each to the
  console as `podium-reporter:` lines.
- The TUI part shows `Reporter.statusText()` as a toast when the connection changes (not for a change in the live-session count).
- `/podium` shows the console address, the home folder, the secure connection, the connection state, the versions, reports sent, failed and rejected, events queued, the
  last error and the number of sessions. OpenCode's `command.add` has no reply to print, so the answer is a toast in the TUI, and a console line when no TUI part is attached.
  `/podium name`, `/podium context` and the messaging subcommands are not offered.

## Build and test

- `node scripts/plugin-build.mjs opencode` builds `dist/opencode/`: a `package.json` whose `main` is `plugin/opencode/index.ts` (and whose `./tui` export is the TUI part), plus the
  source of this folder and `plugin/core/`.
- `npm run test:mod:opencode` builds with the tests and runs them with vitest on the built folder. `npm run typecheck:mod:opencode`
  checks this folder against `@opencode/plugin` (the version pinned in `scripts/podium-opencode-typecheck.sh`).
- `scripts/opencode-reporter.test.ts` replays the recorded streams in `docs/fixtures/opencode/` through the reporter and every
  report through the server's validator and ingest.
