---
title: "A new color theme shows up in the dropdown but the page stays on Podium's colors"
description: "A theme lives in themes.ts, tokens.css and the inline script in index.html; update all three."
group: "Project internals"
area: "Developing"
date: "2026-10-12"
status: "open"
order: 52
---

# A new color theme shows up in the dropdown but the page stays on Podium's colors

**You see:** The theme is listed, and picking it changes nothing.

**Why:** A theme lives in three places:

- its entry in `frontend/src/fleet/themes.ts`,
- its light and dark token blocks in `tokens.css`,
- the id list in the inline script in `frontend/index.html` that applies the choice before first paint.

`themes.test.ts` fails if they disagree, or if a block lacks a color token such as `--deleg`, `--deleg-text` and
`--admin-text`.

**Do:** Update all three. A new palette also needs an entry in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and a
clean run of `npx tsx scripts/theme-contrast.ts`.

<!-- nav:start -->
---

Previous: [A mod fix did not reach anyone](mod-fix-did-not-reach-anyone.md) · Up: [Gotchas](README.md)
<!-- nav:end -->
