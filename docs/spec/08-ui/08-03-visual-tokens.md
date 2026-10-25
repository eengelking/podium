---
title: "8.3 Visual tokens"
description: "Where color tokens live, the themes, and the rules that keep the UI on them."
group: "Reference"
section: "8.3"
order: 3
---

# 8.3 Visual tokens

Every color token lives in `frontend/src/fleet/tokens.css`, the one source. The app, the standards pages and new
mockups read that file, and nothing copies its values. Dark is the base, and light comes via
`prefers-color-scheme` and `[data-theme]`. The other themes are token blocks keyed by `[data-theme-name]` and
`[data-theme]` in the same file. The tokens by role, the themes, the components, the patterns and the rules below are
written in `docs/standards/` (open `index.html`). Those pages are generated from the app on `main` and a test fails
if they differ from it, so they say what production does.

- **Surfaces and ink.** A page color, a card color and a raised color; primary, secondary and muted ink; grid and axis
  lines. Named by role in `tokens.css`, not by value.
- **Model colors.** One per family (opus, sonnet, haiku, fable) and one for a model that is not a Claude model.
  Each theme may choose its own but the four stay distinct from each other.
- **Status colors** in Podium's own theme are fixed: good, warning, serious, critical, and the delegating blue with
  its text color.
- **Administrator names.** An administrator's name in Admin > People (#182) uses the text color `--admin-text`,
  defined in every theme and mode, with a tooltip and a screen-reader label so color is not the only signal.
- **Other themes** may use their palette's green, amber, orange and red, which stay recognizable as those four,
  and their own blue or teal for delegating.
- **Contrast.** Every theme meets 4.5:1 for text on its backgrounds and 3:1 for status and model marks (or
  Podium's own ratio in that mode where that is lower), checked by `scripts/theme-contrast.ts`.
- **Status** is always shown as icon plus word, never color alone.
- **Type and motion.** Fonts: Schibsted Grotesk (UI), JetBrains Mono (ids, numbers, paths). Body 13 px.
  Numbers use tabular figures. `prefers-reduced-motion` disables animation.
- **New UI follows the standards.** A mockup links `tokens.css` and does not carry a `:root` block. A change to the
  UI that the maintainer approves is brought into the standards at the release that ships it
  (`docs/standards/process.html`).

<!-- nav:start -->
---

Previous: [8.2 Components](08-02-components.md) · Up: [8. The UI](README.md) · Next: [8.4 Accessibility and responsiveness](08-04-accessibility-and-responsiveness.md)
<!-- nav:end -->
