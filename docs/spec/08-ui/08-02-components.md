---
title: "8.2 Components"
description: "The components to create and how they group."
group: "Reference"
section: "8.2"
order: 2
---

# 8.2 Components

Create these. Split further only if a file passes about 250 lines.

- **Pages and layout:** `Root` (the page switch: it picks the page from `route.ts` and loads `HistoryView` and `AdminView` only when asked), `FleetApp`, `TopBar`, `Rail`, `Legend`, `PageBanner`, `PageNav`.
- **Wall:** `Wall` (with `KpiStrip`, `Toolbar`, `SessionCard`).
- **Board:** `Board` (with `RunningCounts` and `board.ts`, the pure bucketing the page and its tests share).
- **People:** `People` (`Monogram`, `PeopleCluster`, `Band`, `OwnerLine`).
- **Orchestrator page:** `FocusView` (with `FocusHeader`, `MiniCharts`, `FactsBar`, `BlowoutCallout`,
  `PlanPanel`, `AgentTree`, `AgentRow`).
- **Chat and the people pages:** `Chat` (with `ChatSidebar`, `ChatThread`, `ChatComposer`, `ChatMembers` (the avatar stack and the members panel), `ChatAvatar` (the agent, person and you avatars and the overlapped pair), `ChatMenu` (rows and avatars), `ChatForms`, `ChatRules`, `ChatAdmin`), `MyReporters`, `MyUsage`, `PeerRights`, `PeerLimits`, `TrafficMap` (the retired Traffic page's code, kept until 1.9).
- **History and Admin:** `HistoryView`; `AdminView` with one file per tab under `admin/` (`PeopleTab`, `GroupsTab`, `ReportersTab`, `SettingsTab`, `ReportingTab`, `CertificatesTab`, `LogTab`, `StoredActivityTab`, `SpendTab`, `ModelPricesTab` and the report pages `ToolsPage`, `SpendPage`, `TimePages`, `HarnessPage`, `DataPage`).
- **Notices and reads:** `NoticeStack` (the wall notices), `SessionReadNotes` (the red notice an owner sees while an Admin reads their live Activity or Respond window), `SignIn` (the lock screen).
- **Recording and replay:** `RecordPicker`, `RecordingLayer`, `ReplayPage`, with `replayItems.ts` and `replayReads.tsx`.
- **Side panel:** `SidePanel` (with `ActivityList`, `AgentDetail`, `FailureBox`, `BlowoutBox`, `ReportDocs`,
  `ActivityFeed`, `ActivityTabs`, `BackgroundList`, `FilesList`, `FileDiffModal`, `Respond`, `Modal`).
- **Shared pieces:** `Chips` (`ModelChip`, `EffortMeter`, `StatusChip`, `BlowBadge`, `CompBadge`, `GitLine`), `Sparkline`,
  `ResizeHandle`, `EdgeTab`.
- **Hooks:** `useFleet`, `useActivityFeed`, `useResizable`, `usePanes`, `useHotkeys`, `useShortcuts`, `useIdle`, `useTheme`,
  `usePeoplePrefs`, `useWallColumns`, `useChat`, `useRespond`, `useMyPeers`, `usePins`, `useHeartbeat`, `useHeldState`,
  `useLeaving`, `useNow`, `usePageVisible`.
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
