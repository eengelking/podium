---
title: "Orchestrator messaging"
description: "How orchestrators send messages to each other through Podium, with rights, settings and routes."
group: "Project internals"
order: 13
---

# Orchestrator messaging

Files: `server/src/fleet/peerTypes.ts`, `peerSettings.ts`, `peerRights.ts`, `peerMessages.ts`, `peers.ts`,
`peerRoutes.ts`; `scripts/podium-peers-demo.mjs`; the mod's `hooks/peers.ts` and the messaging block in
`hooks/register.ts`; the console's `MyReporters.tsx`, `useMyPeers.ts`, `peers.ts`, `components/PeerRights.tsx` and
`components/PeerLimits.tsx`; Admin's `admin/ReporterMessaging.tsx`; Traffic's `Traffic.tsx`, `trafficData.ts`,
`useTraffic.ts` and `components/TrafficMap.tsx`. Issue #412 builds the server half of #347, #414 the mod, #415 My
reporters, #416 the Admin's pages, #417 Traffic and #436 an owner's stricter limits; the rules are in SPEC 5.3, 7.7 and
8.1, and the reasoning in DECISIONS 37. How a person sets it up and uses it is in [MESSAGING.md](../../MESSAGING.md).

**Parts.** `peerTypes.ts` is the contract: the words (reporter, link, conversation), the rows and the two store
interfaces. `PeerRights` keeps the rights between reporters, each owner's defaults and stricter limits, and the
requests the owner answers. `PeerMessages` keeps the live directory of orchestrators (memory), the messages
(`peer_messages`) and Podium's notices to an orchestrator (memory). `PeerMessages` sees the rights only through the
narrow `PeerRightsView`, so each store is tested alone. `PeerSettings` holds the Admin's limits and retention in one
`settings` row. `PeerService` (`peers.ts`) joins them, and the fleet owns one, as it owns `RespondStore`. It builds its
reporter lookup from its own `ReporterStore` on the same database.

**Flow.** The report route records the reporter (`ReporterStore.record` now returns its key), then calls
`fleet.peers.note` with the session, the key and the token's person. The reply spreads `peerReplyFor`, which checks the
switches the server knows of and asks `PeerService.reply` for the deliveries (messages only while the session reports
idle) and the open requests about that reporter. A send resolves `to` (`name@machine`, or `name@machine#id` to pick among same-named ones) among the live directory, checks the right, the
length, the rate and the round trips, and stores the message as `ready` or `approval`. The next idle report hands it
over (`handed`), and the mod's result moves it to `delivered`, `queued` or `dropped`.

**Same owner, in the store.** Every write that joins two reporters goes through `PeerRights.pair`, which refuses two
owners, a reporter on the admin secret or owned by `Admin`, and a browser's person who is not the owner. The message
store resolves `to` only among the sender owner's orchestrators, so a message to another person's orchestrator is a
`404` before any right is read. Neither depends on the routes for this.

**Logs.** The stores take a `trail` callback and log nothing. `wirePeerLogs` in `peerRoutes.ts` turns each trail into an
Admin log row and a `peers.*` server log event, and sets `PeerService.withSource`, so a row names the address of the
request that caused it (`server` for a sweep). The Admin router writes through the same trail, with the Admin as actor,
so a proposal or a pause is logged once.

**Routes.** The mod's routes are on the fleet router. The owner's routes go on responding's browser router through
`RespondDeps.extendBrowser`, so they share its sign-in cookie, cross-site check and no-store header, and
`RespondDeps.alsoSignIn` lets a browser sign in while only messaging needs it. The Admin's routes are in
`adminRouter.ts`, which gets the service as `peers`.

**Where it departs from the design.** The issue left the meaning of a link to the build, and the design says "round
trips on a link". A link is a reporter pair here (pause, remove, rate and retention go by it, as the Traffic mockup's
Remove link names two machines), and round trips are counted per conversation between two orchestrators, as the
Traffic mockup shows them per line. Notices to a sender ride the same reply list as messages (`kind: "notice"`), so the
mod has one list, one result route and one dedupe. SPEC 7.7 records both.

**The mod (#414).** `hooks/peers.ts` is pure: the tools' words, the frame a peer message is submitted under, the
request lines and toasts, and short ids. The messaging block in `register.ts` is kept apart from responding: peer
deliveries and requests have their own `Transport` fields (`peers`, `peerDeliveries`, `peerRequests`), and a message
only ever becomes a framed `$.prompt.submit`. Results share responding's outbox and `acted` dedupe but post to the
peers result route. A tool call waits on a `PeerCall` queue that `flush` drains (`sendPeerCalls`), so the call is
made by the timer with the report's credential and backoff. `redactText` in `diffRedact.ts` runs the diff redactor
over free text. The OS is parsed in `machine.ts` (`osFromSwVers`, `osFromOsRelease`, `osFromVer`, `cleanOs`).

**My reporters (#415).** The page is a flag on `FleetApp`, like the Board, and takes the middle column's place between
the rail and the Activity panel (#446), with no legend. `usePanes` takes the page's name and keeps one set of
collapsed flags per page (`podium.collapsed`, `.board`, `.reporters`). `useMyPeers` lives in `FleetViewBody`, so the top bar's count and the page share
one read. A change is optimistic, with a generation counter so an older read cannot undo a newer change. `peersApi`
sits beside `respondApi`, on the same router and header, and `RespondProvider` also asks `/me` while
`peer-messaging` is on. The rights pieces (the access level, system, proposed and paused tags, the Grid | Board
switch, the Grid, the Board, the can-B-answer prompt, quoted text) are in `components/PeerRights.tsx` for the Admin's
Messaging section (#416) to reuse; it passes `shown` and `waitingFor`. Their `pm-*` and `lv-*` CSS is in `admin.css`
under `.adminv`, so the Admin shell gets it too.

**Admin (#416).** `useReporterMessaging` in `admin/ReporterMessaging.tsx` gives the reporter's detail page three pieces
(the Pause all links button for the header, the System and Messaging rows, the Messaging section) and nothing while
the `peer-messaging` flag is off. Its Grid and Board are `PeerRights.tsx` with `showLive: false` (the Admin's read has
no live counts) and `disabledLevels: ["none"]` (the server refuses a proposal of No access); a change goes to
`POST reporters/:from/peers/propose`. The Admin's `GET reporters/:key/peers` covers every pair of the owner's reporters
and returns the owner's `trust`, so the Grid needs one read. `components/PeerLimits.tsx` is the limit rows for Admin >
Settings and My reporters > Defaults: the ranges and error words mirror `peerSettings.ts` (its test imports the server
file and compares), and the caller supplies each key's maximum, the state line, the "Use the Admin's limit" action and
what a typed value means, so the one component draws both.

**Traffic (#417).** The page is a flag on `FleetApp`, like My reporters, with no wall, rail or side panel, and no keys
for them.
`trafficData.ts` (not `traffic.ts`, which a case-insensitive disk would take for `Traffic.tsx`) holds the API, the
words and `layoutMap`: machines in two columns, busiest first then by name so a new message does not reorder them,
cubic curves, and each label at the first point along its curve that clears earlier labels and the nodes.
`components/TrafficMap.tsx` draws it as inline SVG, each line an `<a>`. `useTraffic` reads the open
`GET /api/fleet/peers/traffic` every 10 seconds while the page is visible, and `useConversation` asks for a
conversation's text only when the viewer is its owner or an Admin, so a signed-out browser never requests it.

**Testing.** `peerRights.test.ts` and `peerMessages.test.ts` test the stores alone; `peerRoutes.test.ts` plays two of
one owner's reporters and another person's through the real router and the Admin router. `scripts/podium-peers-demo.mjs`
does the same against a running server (`--help`). The mod's `peers.test.ts` and `peersMod.test.ts` hold the frame,
subagent-refusal, separation-from-responding and approval-text tests. The frame and separation checks are functions in
`hooks/peerChecks.ts` (test-only, like `scripted.ts`); the tests run them against the real code and against fakes
broken on purpose, which must fail, so no one has to remove the frame to prove the tests catch it (#437). The pages'
tests are `myReporters.test.tsx`, `peers.test.ts`, `admin/messaging.test.tsx`, `components/PeerLimits.test.tsx`,
`traffic.test.tsx` and `trafficData.test.ts` in the frontend. `scripts/podium-peers-seed.mjs` seeds a throwaway
server for looking at the pages, and with `--talk` adds conversations for Traffic. `scripts/podium-peers-e2e.sh` runs it
with real Claude Code sessions: `up` starts a throwaway server from the checkout, seeds it with `--talk`, and starts
sessions in tmux that load the mod with `--plugin-dir`; `down` stops them. Its test covers only the help, the argument
checks and `--dry-run`, since a real run costs model usage ([MESSAGING.md](../../MESSAGING.md#testing-it-end-to-end)).

<!-- nav:start -->
---

Previous: [File diff](12-file-diff.md) · Up: [Components](README.md) · Next: [Built-in TLS (#577)](14-built-in-tls.md)
<!-- nav:end -->
