---
title: "People view"
description: "How the People view and the Admin spend tab are built from the fleet's data."
group: "Project internals"
order: 15
---

# People view

Files: `frontend/src/fleet/people.ts`, `components/People.tsx`, `usePeoplePrefs.ts`, `admin/SpendTab.tsx`. Issues
#34, #239 and #245. Mockup: `mockup/podium-admin-spend.html`. The reasoning is in DECISIONS 21.

**What the server adds**

The server stores nothing new about people. It adds three things:

- `sessions.machine_json` (migration 7), from `Report.machine`, which a named reporter (mod 0.9.0) sends next to
  `userName`.
- `SessionView.ownerGroup`, joined from the people and groups tables by the owner's exact name when the view is
  built.
- `Kpis.costTodayByOwner`, the `costToday` sum split by owner with each owner's group.

**What the browser does**

- Bands, their counts, ordering, the people filter, machine labels and the spend rows are pure functions in
  `people.ts`, fed from the live sessions and the KPIs the UI already has. People exist only while one of their
  sessions is live.
- The view switches on when any live session's owner is a person (not `Admin`, not null).
- Who is looking comes from the browser's respond sign-in (`useRespond`, `GET /respond/me`). `FleetView` is
  wrapped in `RespondProvider` so the wall can read it. A signed-in name that is not `Admin` is "me": the Me
  wall, the "you" tag, and the viewer's band first.
- The other choices are in `localStorage` under `podium.people`. The old `podium.me` is no longer read.
- The people controls are `PeopleCluster` in `components/People.tsx`, drawn by `Toolbar` in `components/Wall.tsx`
  in the same row as the filters. `fleet.css` narrows that row with container queries on the toolbar's own width
  (the `.toolbar` wrapper).
- Machine labels add the start of the machine id only when one owner has two machines with the same host name.

**Spend**

Spend by person or group is not on the wall. It is Admin > Reporting > Spend (#484), `admin/SpendPage.tsx`, whose
first section is `admin/SpendTab.tsx`. That section opens its own `useFleet` while it is showing, builds its rows with
`spendRows` from `people.ts` and pages them in the browser with Admin's `Pager`. Its choices are in `podium.adminSpend`.
A person's row opens `SpendBreakdown.tsx` (#482), which reads `reports/spend/today/:owner`; the sections below it are
`SpendProjection.tsx` (#483) and the shared period report.

**Reporting (#484)**

Files: `server/src/fleet/rollups.ts`, `reports.ts`, `reportRoutes.ts`, `reportDeps.ts`, `frontend/src/fleet/admin/reportsApi.ts`, `useReport.ts`, `ReportParts.tsx`, `ReportPages.tsx`, `scripts/podium-seed-history.ts`.

- The reports read daily rollups (`usage_daily`, `sessions_daily`, `failures_daily`, `fleet_daily`, migration 22), not the
  detail tables, so they reach back past the 30 days sessions and events are kept. `Fleet.retain()` calls
  `writeRollups` before `db.retain()` deletes anything. A rebuild of a day is one transaction and gives the same rows
  twice, a day's `peak_live_sessions` only grows, and a day that began before the session retention is not rebuilt,
  since the sessions left would lower its figures. Rollup rows past `RETAIN_ROLLUP_MS` (395 days) go.
- Today has no rollup yet. `buildRollups` makes the same rows from the live tables on every request, so a report is
  rollups for earlier days plus the live day.
- `reports.ts` holds the queries and the envelope (`from`, `to`, `by`, `tz`, `basedOn`, `oldestDay`, `partial`, `columns`,
  `rows`, `total`), the projection and the spend breakdown. The breakdown uses `sessionSpendSince` in `db.ts`, the same
  per-session since-midnight figure that makes `kpis.costTodayByOwner`, so its parts add up to the table row.
  `reportRoutes.ts` mounts the routes behind the Admin unlock check and turns a reply into CSV.
- On the page, `useReport` fetches one report for the chosen period and filters, and the export buttons reuse that
  reply: JSON is the reply, and CSV is the same query with `format=csv`. Choices are in `podium.adminReporting`.
- `scripts/podium-seed-history.ts` writes about 45 days of seeded rollups into a throwaway database, so the
  simulator can show a projection and the long-period reports. It refuses the real database path.

**Mod**

`machine.ts` cuts `hostname` output to the short name and makes the random id kept under `machineId` in
`$.store`. `register.ts` reads both once per load and only when `userName` is set.

<!-- nav:start -->
---

Previous: [Built-in TLS (#577)](14-built-in-tls.md) · Up: [Components](README.md) · Next: [Logging](16-logging.md)
<!-- nav:end -->
