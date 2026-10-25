---
title: "8.2 Components"
description: "The components to create and how they group."
group: "Reference"
section: "8.2"
order: 2
---

# 8.2 Components

Create these. Split further only if a file passes about 250 lines.

- **Pages and layout:** `FleetApp`, `TopBar`, `Rail`, `Legend`.
- **Wall:** `Wall` (with `KpiStrip`, `Toolbar`, `SessionCard`).
- **Board:** `Board` (with `RunningCounts` and `board.ts`, the pure bucketing the page and its tests share).
- **People:** `People` (`Monogram`, `PeopleBar`, `Band`, `OwnerLine`).
- **Orchestrator page:** `FocusView` (with `FocusHeader`, `MiniCharts`, `FactsBar`, `BlowoutCallout`,
  `PlanPanel`, `AgentTree`, `AgentRow`).
- **Side panel:** `SidePanel` (with `ActivityList`, `AgentDetail`, `FailureBox`, `BlowoutBox`, `ReportDocs`,
  `ActivityFeed`, `Modal`).
- **Shared pieces:** `Chips` (`ModelChip`, `EffortMeter`, `StatusChip`, `BlowBadge`, `GitLine`), `Sparkline`,
  `ResizeHandle`, `EdgeTab`.
- **Hooks:** `useFleet`, `useActivityFeed`, `useResizable`, `usePanes`, `useHotkeys`, `useIdle`, `useTheme`,
  `usePeoplePrefs`, `useWallColumns`.
- **Logic modules:**
  - `wallLayout.ts` (the wall's column count);
  - `people.ts` (bands, ordering, the people filter, machine labels, spend rows);
  - `format.ts` (`fmtTok`, `fmtUsd`, `fmtDur`, `fmtClock`, `shortenHome`).

Pure logic (sorting, filtering, tree building, series to polyline points, reducer) lives in plain functions
with their own tests.

<!-- nav:start -->
---

Previous: [8.1 What the UI must do](08-01-what-the-ui-must-do.md) · Up: [8. The UI](README.md) · Next: [8.3 Visual tokens](08-03-visual-tokens.md)
<!-- nav:end -->
