# plugin/opencode

The OpenCode reporter (#855). It watches OpenCode 2.x sessions and reports them to Podium; it never answers a session (that is a
separate issue). It is written in TypeScript against `@opencode/plugin`, which OpenCode supplies at runtime, and it imports the code
every reporter shares from `../core/` (report types, transport, failures, redaction, plan, git). It never imports `../claudecode/`;
`server/src/plugin.test.ts` fails if it does.

| File | What it does |
|---|---|
| `index.ts` | The plugin entry: `Plugin.define`-shaped glue. Subscribes to `ctx.event`, runs the flush timer, returns the cleanup. Keeps one `Reporter` per location on `globalThis`, because module state is not shared between plugin loads. |
| `state.ts` | Folds one bus event into a `Store`. A root session and the child sessions it launched are one `Root`: one record, one report; a child is an agent. |
| `report.ts` | A `Root` as a v2 report: the `harness` block, the capabilities and `costSource: 'harness'`. |
| `reporter.ts` | The runtime: one `Transport` per root, the flush `tick`, the idle sweep, the branch read and the bounded final flush. `handle` never waits for the network. |
| `options.ts` | Settings from the plugin options, then the environment, then the defaults. |

## What it reports

- Model and provider (from `session.step.started`), tokens and cost from `session.usage.updated`. The root's usage already includes its
  children's, so the session cost is the root's figure and a child's cost is its own; nothing is added twice.
- Context is the last step's prompt: input plus cache read plus cache write. The window is not on the bus, so there is no percent and the
  reporter declares `context: false`. Effort is not on the bus either (`effort: false`).
- Tools with input and result, permission asks and questions (the session is `waiting`), compaction, the plan from the todo tool, failures,
  and the git branch.
- A session is `done` after it has been quiet for `idleSeconds` (default 60), at once on `session.deleted` or `session.archived`, and when the
  plugin is cleaned up (one final, time-bounded flush). It reopens under the same id when it sees activity again.

## Settings

Plugin options (or the environment): `serverUrl` (`PODIUM_SERVER`, default `http://127.0.0.1:4317`), `token` (`PODIUM_TOKEN`), `userName`
(`PODIUM_USER`), `idleSeconds` (`PODIUM_IDLE_SECONDS`, at least 5). Consent, token storage and the machine id are #856.

## Build and test

- `node scripts/plugin-build.mjs opencode` builds `dist/opencode/`: a `package.json` whose `main` is `plugin/opencode/index.ts`, plus the
  source of this folder and `plugin/core/`.
- `npm run test:mod:opencode` builds with the tests and runs them with vitest on the built folder. `npm run typecheck:mod:opencode`
  checks this folder against `@opencode/plugin` (the version pinned in `scripts/podium-opencode-typecheck.sh`).
- `scripts/opencode-reporter.test.ts` replays the recorded streams in `docs/fixtures/opencode/` through the reporter and every
  report through the server's validator and ingest.
