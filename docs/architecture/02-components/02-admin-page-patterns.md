---
title: "Admin page patterns"
description: "The shared layout and controls the Admin pages are built from, and where they live."
group: "Project internals"
order: 2
---

# Admin page patterns

Files: `frontend/src/fleet/admin/Page.tsx`, `admin.css`, `pageInfo.ts`, `components/PageBanner.tsx`. Issues #143, #244 and #1209. Mockups:
`mockup/podium-admin.html`, `mockup/podium-admin-menu.html`.

- `AdminView` holds a side menu and renders one page component at a time. `NAV` groups the pages and gives each
  group an outline icon from `GROUP_ICON`. `PAGES` names each page and gives its one-line lead.
- The menu and the page scroll on their own inside `.adminv`, so the menu always runs the full height with Lock
  Admin and the footer at the bottom.
- A page component returns sections only. `AdminView` draws the header (`PageHeader`), and each section is
  `Section` (an H2 with an optional help line) around a `Panel`.
- A list is a panel holding an optional toolbar (`.tool`), the table (`.ptab`) and `Pager`. An on/off setting is a
  `SwitchRow`.
- The page's name and description are not said three times (#1209). The chip in the top bar is the name, and
  `PageBanner` draws the description alone on one line, cut only between sentences (`fitSentences`), with an (i)
  that opens the rest in the anchored `Modal`. Both read `pageInfo.ts`, one entry per page, so they cannot drift.
  The Admin pages keep their own `PageHeader`, because each differs from the chip and the banner.
- A new page adds an entry to `PAGES` and `NAV` and follows the same shape, so a later tab copies the pattern
  instead of inventing one.
- Spacing steps are 4, 8, 12, 16, 24 and 32 px. Buttons are 30 px, or 26 px (`.sm`) in a table row.
- Admin's CSS is scoped under `.adminv` and its layout classes are prefixed (`asec`, `apage`), because
  `fleet.css` already uses `.sec`, `.main`, `.code` and `.back` under `.podium`, with higher specificity.

<!-- nav:start -->
---

Previous: [Reporters, identity and Admin](01-reporters-identity-and-admin.md) · Up: [Components](README.md) · Next: [Tooltips](03-tooltips.md)
<!-- nav:end -->
