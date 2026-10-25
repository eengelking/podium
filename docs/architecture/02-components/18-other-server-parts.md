---
title: "Other server parts"
description: "The smaller server parts that have no page of their own, such as model prices."
group: "Project internals"
order: 18
---

# Other server parts

- **Model prices.** `pricing.ts` holds the built-in price per model family (per million tokens, dated by
  `PRICES_AS_OF`). `modelPrices.ts` keeps the Admin's overrides and custom models (at most 100) under the
  `model_prices` settings key. `Fleet` prices every session and agent through `Pricing`, so a change on
  Admin > Model prices reaches every cost figure (DECISIONS 23).
- **Wall notices.** `wallSettings.ts` defines the notices (today, `background-sessions`) and the setting behind
  them. `POST /api/fleet/notices/:id/close` and `PUT /api/fleet/wall/background-sessions` change only how the
  wall looks, so they take no token. `components/NoticeStack.tsx` draws them (DECISIONS 22).
- **Release check.** `updateCheck.ts` asks GitHub for the latest release once a day (`startUpdateCheck`, started in
  `index.ts`) and keeps the answer in memory. `Fleet.wallView()` adds it to `StateBody.wall.update` unless it is not
  newer than the server, the `update-check` flag is off, or the notice was closed for that release
  (`wall_update_dismissed`, set by `POST /api/fleet/update-notice/close`). The notice is built in `Wall.tsx` and is
  not an entry in `NOTICES`, because closing it hides one release, not the notice (SPEC 6.8).
- **Compatibility.** `compat.ts` holds `REPORTER_SUPPORT`, the reporter versions this server reads. Only
  `major.minor` is compared. A mod outside the range gets a version note on its card and a toast in the mod
  (DECISIONS 18). `build.ts` names the server's own build (`PODIUM_BUILD`, else `server/build.json`) for the footers
  and the report reply; the mod finds its own with `hooks/build.ts` and sends it as `reporter.build` (SPEC 6.8, Builds).
- **The stream.** `sse.ts` sends `snapshot` (on every connect), `session`, `activity`, `removed`, `tick` (every
  2 s) and `wall`, and accepts at most 100 clients.
- **Admin pages.** `AdminView` lists sixteen pages in four groups: People, Groups and Reporters (People and
  access); Settings, Model prices, Security, Certificates, Data and Stored activity (Server); Usage, Spend, People and groups,
  Sessions, Failures and Admin activity (Reporting); Admin log (Activity). Most have a `*Tab.tsx` file under
  `frontend/src/fleet/admin/`, the Reporting pages share `ReportPages.tsx`, and Data and Stored activity are
  `DataPage.tsx` and `StoredActivityTab.tsx` (#432). Certificates (`CertificatesTab.tsx`, #586) reads
  `GET /api/admin/certificates`; the header's certificate pill (`CertPill.tsx`) reads the open `GET /api/tls/status` every
  five minutes (not while the tab is hidden) and links to `#/admin/certificates`. The route answers from memory
  (`ServingRenewer.statusView()`) and reuses its answer for 30 seconds, never past the moment a certificate ends;
  its stage is `expired` only once the certificate has ended, and the last day reads critical.
- **Mounts.** Ahead of the routers, `failureLimiter` covers all of `/api` (#667). The server mounts `/api/fleet`, `/api/reporter` (renewal), `/api/admin` and `/api/tls` (the pill's status), then `/api/health` and a 404 for any other `/api`
  path, then serves the built frontend with `*` falling back to `index.html`.

<!-- nav:start -->
---

Previous: [Shared contract](17-shared-contract.md) · Up: [Components](README.md)
<!-- nav:end -->
