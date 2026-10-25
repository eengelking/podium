---
title: "Fleet card"
description: "How the session card on the fleet wall is built: its chips, session id and files."
group: "Project internals"
order: 4
---

# Fleet card

Files: `frontend/src/fleet/components/SessionCard.tsx`, `Chips.tsx`, `SessionId.tsx`. Issues #144 and #322.
Mockups: `mockup/podium-card.html`, `mockup/podium-session-name.html`.

**Structure**

- The card is one `button.card.sc` holding four children in a fixed order: `.z1` (who and where, plus the tags in
  `.notes`), `.z2` (plan and the agent strip with its sparkline), `.z3` (four readouts) and `.band`.
- `.z2` has `margin-top: auto`. When a row makes a card taller than its content, the spare height opens between
  `.z1` and `.z2`, and `.z2`, `.z3` and the band stay together on the card's bottom edge, so they line up across
  the row.
- The card is `overflow: hidden` so it can run edge to edge inside the rounded corners.

**State**

- `cardKind` in `Chips.tsx` maps a session to one of five kinds (running, waiting, bg, stale, done). Background
  work wins over waiting, as in `idleOnBackground`.
- `StateIcon` draws that kind's shape, so the name marker and the band use one source and state is never color
  alone.
- The kind class on the band (`.band.waiting`, `.band.bg`...) sets `--c` and `--c-text`. `.hot` is the heavier
  tint for waiting and stale. Every kind has the same thin top line.

**Details**

- Remove cannot sit inside the card's button, so on a heartbeat-lost card it is a sibling in `.card-slot`, laid
  over the right end of the band (`.remove-bar`, absolutely positioned from the bottom edge, which works because
  the band has a fixed `min-height`).
- The session id shares the path line in `.pathrow`. It is `SessionId` (`components/SessionId.tsx`), also used by
  the orchestrator page's header. On the card it is a `role="button"` span, because a button cannot nest in the
  card's button, and it stops its click and keys from reaching the card.
- The layout rules hang on `.card.sc`.

<!-- nav:start -->
---

Previous: [Tooltips](03-tooltips.md) · Up: [Components](README.md) · Next: [Orchestrator page](05-orchestrator-page.md)
<!-- nav:end -->
