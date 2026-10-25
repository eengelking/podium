---
title: "Orchestrator page"
description: "How the orchestrator page is laid out and which file builds it."
group: "Project internals"
order: 5
---

# Orchestrator page

File: `FocusView.tsx`. Issues #165, #197 and #287. Mockup: `mockup/podium-orchestrator.html`.

**Layout**

- `FocusView` renders `.op`, a size container, so the page's breakpoints are `@container` queries on its own
  width: facts to two columns at 520 px, plan and tree stacked at 700 px.
- `.op` holds `.osum`, the one bordered surface, and `.two`.
- `.osum` has the children `.fh` (`FocusHeader`), the blowout detail `.bdet` only while open, `.facts`
  (`FactsBar`) and `.band` (`StatusBand`), always in that order and with the band last.
- `.osum.risk` is the card's red top edge for a level 2 blowout.

**State kinds**

- The band reuses the card's `cardKind`, `bandLine` and `waitSummary`. `stateKind` in `Chips.tsx` adds `deleg`
  (SPEC 8.1). The card, the rail item and this page all call it, with `delegatesOf` giving the delegates, so they
  cannot disagree.
- `FocusView` computes `waitingOnByRow` and the kind once per render and passes them to `FocusHeader`,
  `StatusBand` and `AgentTree`, so the shape beside the name, the band and the tree rows never disagree.

**Parts**

- Remove now is a child of the band, absolutely positioned over its right end. The band reserves right padding for
  it (`.has-rm`), and below 520 px it moves under the text.
- `.fh` is a stretching flex row, so `.hcs` (the three charts) is as tall as the header. `.hc` is a flex column
  and its `svg` takes `flex: 1 1 46px` with a `min-height` of 46 px. The title row and the "60s ago / now" row
  keep their natural height at the top and bottom.
- The svg's `preserveAspectRatio="none"` viewBox and `vector-effect: non-scaling-stroke` let the graph stretch
  without changing line widths. `chartsFill.test.ts` reads these rules out of `fleet.css`.
- `.facts` is a six-column grid, twelve cells (two columns at 640 px and narrower) whose 1 px gap over a `--grid` background draws the hairlines.
- Blowouts, Session, Resume and Fork are whole-cell controls without button chrome. Resume and Fork are one component, `CopyCell`, and Machine and System are `PopCell`s (#427), both built on `usePopup`: a popup that opens on hover and focus above the cell, or below it when the scrolling page has no room above (`.osum` does not clip). `forkCommand` is built next to `resumeCommand` in `derive.ts`, so the page copies a string and builds nothing (#352). The open state of the blowout detail is
  `FocusView`'s own (kept per session id, closed by default) and reaches the cell as `blow`.
- The Reporter cell takes its tooltip from `HOOKS_NOTE` and `versionNote`, the same sources as the card chip.
- The old callout stack, the status chip beside the name and `.alert` are gone. `.callout` remains for the agent
  panel and the fleet notice. It and `.bdet` share their text and loop-list rules in one grouped selector in
  `fleet.css` and differ only in the box.

<!-- nav:start -->
---

Previous: [Fleet card](04-fleet-card.md) · Up: [Components](README.md) · Next: [Known reporters](06-known-reporters.md)
<!-- nav:end -->
