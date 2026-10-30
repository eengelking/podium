---
title: "Responding"
description: "How Podium answers a session that waits on its person, and the server, mod and UI files that do it."
group: "Project internals"
order: 11
---

# Responding

Files: `server/src/fleet/respond.ts`, `respondRoutes.ts`, `lockout.ts`, `frontend/src/fleet/useRespond.tsx`,
`components/Respond.tsx`, `mod/podium-reporter/hooks/respond.ts`. Issue #206; SPEC 5.3, 7.1, 7.2 and 7.7. The
reasoning is in DECISIONS 28 to 30.

**Server**

- `RespondStore` (`respond.ts`) lives on the `Fleet`, in memory only. It holds each session's last `respond` info,
  its asks with content, a closed ask's outcome (kept until a report shows the session running again, or 10
  minutes), the one answer taken per ask, up to 20 waiting messages, and the held requests.
- `respondRoutes.ts` is mounted on the fleet router. The mod's routes sit behind `requireToken` and an owner
  check. The browser's routes are under `/respond`, with their own `HttpOnly` sign-in cookie, header and `Origin`
  checks.
- `Fleet.ingest` hands each report to the store, which learns asks a restarted server lost and takes as closed an
  open one a report stops listing (5 s grace).
- Answers and messages become `podium` entries in the watched loop's activity feed (`ActivityStore.addPodium`),
  updated or removed as the mod reports results.
- `lockout.ts` is shared with the Admin router.
- The Respond flag is `respond` in `FEATURES`, which now carries a per-flag default.
- The only database change is migration 15's `sessions.cleared_from`.

**Mod**

- `respond.ts` holds the pure parts: what the level accepts, the asks, `planApproval` with `updatedInput`,
  `toolDecision` and the terminal lines.
- `register.ts` holds the races: `questionRace` and `planRace` inside the generic `tool.call` hook,
  `permissionAsk` from `classic.PermissionRequest`, `settleToolAsk` when a tool's call ends,
  `startPermissionCheck` from `tool.check`, and `handleDeliveries` for the reply's messages and commands.
- Closes and results queue in `outbox` and go out from the flush timer, since Esc aborts a hook's own fetches.
  Delivery ids already acted on are kept in `$.store`.

**UI**

- `useRespond.tsx` provides who is signed in (asked only while the Admin's flags are on) and which session's modal
  is open.
- `components/Respond.tsx` is the button and the modal, with `RespondForms.tsx`, `Compose.tsx` and `SignIn.tsx`.
  `respond.ts` holds the rules for the button and the frames.
- The modal lets its fields keep their own keys (`Modal.tsx`), and `useActivityFeed` follows a Podium entry's note
  as it changes.

<!-- nav:start -->
---

Previous: [Session recording](10-session-recording.md) · Up: [Components](README.md) · Next: [File diff](12-file-diff.md)
<!-- nav:end -->
