---
title: "How Podium fits together"
description: "The shape of the system: how the reporter mod, the server and the UI connect, plus the design standards and the docs site."
group: "Project internals"
order: 1
---

# How Podium fits together

This page shows how the reporter mod, the server and the UI connect, for a contributor reading the code for the first time.

```
 Claude Code session ──(reporter mod: hooks -> state.ts reducers -> report.ts)──┐
 Claude Code session ──(  flush timer: POST /api/fleet/report every 1 s when   )──┼──> server (Express, 127.0.0.1:4317)
 simulator (podium-sim) ─(  something changed, 5 s heartbeat, backoff offline )──┘      routes.ts: validate (protocol.ts)
                                                                                        fleet.ts:  ingest.ts -> storage (SQLite)
 browser (React, frontend/src/fleet) <── GET /api/fleet/state (first paint) ──────────   derive.ts: SessionView, KPIs, series
                                     <── GET /api/fleet/stream (SSE) ─────────────────   sse.ts + sweeper.ts (stale, drop, linger,
                                                                                         samples, retention, 2 s tick)
```

## The mod

`mod/podium-reporter/` runs in each Claude Code process.

- Hooks only update an in-memory model through pure reducers (`state.ts`, `plan.ts`, `failures.ts`). They never
  wait on the network.
- A `$.clock.every` timer reads `$.session.id()`, `$.session.usage()` and `$.agent.list()`, and posts a full
  snapshot plus unacknowledged events (`transport.ts`).
- Git is polled every 10 s (`pollGit` in `register.ts`, reading through `git.ts`).
- `session.end` sends the final report inside a 1 s deadline.
- A changed session id (after `/clear` or a resume) closes the old id with a `done` report and starts over under
  the new one.

## The server

`server/src/fleet/` validates every report by hand (`protocol.ts`) and stores it in one transaction (`ingest.ts`):
it upserts the session and agents, inserts events and blowout rows idempotently, and writes one sample per second.
It broadcasts the changed `SessionView` (at most one per session per 500 ms) and each new event over SSE.

- `fleet.ts` owns the live set and time.
- `sweeper.ts` runs every second: a session is stale at 15 s and dropped 60 s later, ended sessions linger 8 s,
  and quiet seconds get carry-forward samples. It ticks KPIs every 2 s and prunes hourly.
- `derive.ts` turns rows into views and is pure.
- `server/src/storage/` is the only way the server reaches its database: async interfaces with SQLite as the one adapter
  (see [Storage](02-components/19-storage.md)).

## The UI

`frontend/src/fleet/` is the mockup in React.

- `useFleet` loads `/state`, applies stream messages with a pure reducer (`store.ts`), treats 6 s of silence as
  disconnected and reopens the stream, whose first message is a full snapshot.
- Sorting, filtering, the agent tree and chart points are pure functions in `logic.ts` and `chart.ts`.
- Styles are `fleet.css` and `admin/admin.css`, scoped under `.podium` and `.adminv`. Every color token is in `tokens.css`, which `fleet.css` imports.
- The UI computes nothing it could not recompute from one `SessionView`.

## Design standards (#354)

`docs/standards/` is static HTML that opens from a checkout and loads the app's own `fleet.css`, `admin.css` and
`tokens.css` by relative path, so nothing is copied. The pages are generated, not written:

- `frontend/src/fleet/standards/screens*.tsx` render the real components with fixture data (the wall, an orchestrator's
  page, the board, the Respond modal, each Admin tab and so on). `samples.ts` says which part of which screen is each
  component's sample and holds the words around it (purpose, when to use it, accessibility). `tokens.meta.ts` describes
  each token. `prose.ts` is the patterns, voice, accessibility and process pages. `build.tsx` assembles them.
- `npm run standards:sync` rewrites the pages. `npm run standards:parity` fails if a page differs from what the app
  renders, if a class in the stylesheets is in no sample and not in `docs/standards/not-rendered.json`, if a component file
  has no section, or if a token has no description. CI runs it on a PR into `main` and on `main`; a plain `npm test` does
  not, because `development` may be ahead of the standards. The run pins the time zone and locale so the pages are the
  same on every machine.
- `scripts/standards-inventory.ts` lists the tokens, classes, components and color literals. `npm test` uses it to fail on
  a hard-coded color not listed in `docs/standards/deferred.json`, and on a custom property nothing defines.
- A sample draws a `position: fixed` part (the toast, a tip, a modal's backdrop) in place, and an Admin `main` as a `div`.
  Those are the only differences between a sample and the app. The parity pass fails when a class that `fleet.css` or
  `admin.css` fixes has no in-place rule under `.s-sample` in `docs/standards/standards.css` (a hand-written file the pages
  link). The rule for the row Actions menu arrives with the release's standards update (#700).

Two project skills and an agent keep it honest: `podium-standards-check`, `podium-standards-update` and
`podium-ui-auditor` (`.claude/`).

## The docs site (#688)

`site/` publishes `docs/` at podium.engelking.dev. It is a separate Astro Starlight project with its own `package.json` and
lockfile, outside the npm workspaces, so the server and UI builds never install it. DECISIONS 43 has the reasons.

- `site/scripts/build.mjs` builds one Starlight site per version and puts them in `site/out/`. The newest release line (from the
  root `package.json`) is built from the working tree at `/`; each older line from `FIRST_VERSION_LINE` on is built from its newest
  `vX.Y.Z` tag at `/<line>/`. Before each build `prepareDocs` in `site/scripts/lib.mjs` writes the pages (title, description and
  last-updated from the doc and git, links rewritten to site addresses or to GitHub at that tag) into the ignored
  `site/src/content/docs/`, and copies `docs/standards/`, `docs/images/` and the atlas page unchanged. The standards and the atlas
  are shown in a frame inside a page of the site; the standards load the app's stylesheets by a `../../frontend/src/fleet/` path, so
  the build serves them at `/docs/standards/` and copies those stylesheets from the same version to `/frontend/src/fleet/`.
- `site/docs-nav.mjs` is the menu: which docs are published, in which group, at which address.
- `site/src/styles/theme.css` maps the console's tokens onto Starlight's variables. `site/src/components/` overrides the header,
  footer, banner (older versions) and page title, and holds the version menu. The header carries Starlight's theme switch, and a page that shows a static page in a frame gives that page the site's theme. `site/src/pages/index.astro` is the homepage.
- `.github/workflows/docs-site.yml` builds every version on a PR into `main`, and on a PR into `development` that changes `docs/`, `site/`, the tokens or the workflow, and deploys to GitHub Pages on a push to `main`.
- The address is `podium.engelking.dev`, a DNS-only `CNAME` to `eengelking.github.io` set in the repository's Pages settings. `site/public/CNAME` keeps the domain in every build. DECISIONS 44 has the reasons and `docs/COMMUNITY.md` lists the record and the renewal notes.
  `scripts/site-lib.test.ts` tests the preparation and the version choice. The `podium-docs-site` skill is the procedure.

<!-- nav:start -->
---

Up: [Architecture](README.md) · Next: [Components](02-components/README.md)
<!-- nav:end -->
