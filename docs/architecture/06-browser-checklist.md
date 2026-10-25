---
title: "Browser checklist (T4.2)"
description: "The checks run in Chrome against the dev server and what each found."
group: "Project internals"
order: 6
---

# Browser checklist (T4.2)

Run in Chrome (Claude in Chrome) against the dev server, Vite, and either `podium-sim --chaos` or real
`claude -p` sessions. Checked: yes unless noted.

| Item (SPEC 8.1) | 1440 dark | 1440 light | 400 dark | 400 light |
|---|---|---|---|---|
| Top bar: logo, connection pill, clock, theme toggle, link to usage | yes | yes | yes | yes |
| Connection pill shows "disconnected, retrying" with the server stopped, recovers by itself | yes (at once; back 2.3 s after restart) | | | |
| Three columns, drag handles (real drag 340 -> 510 px, saved), double-click reset, focus ring | yes | yes | hidden, stacked | hidden, stacked |
| Rail: status dot, name, blowout badge, model chip, plan bar, agents; red edge at level 2 | yes | yes | yes | yes |
| Rows enter and leave with animation | yes (burst of 11) | | | |
| KPI tiles with sparklines | yes | yes | yes (2 columns) | yes |
| Toolbar: segments, Sort (Model: Fable, Opus, Sonnet in rail and wall), text filter, counts | yes | yes | | |
| Cards: git line, model, effort, context, badge, blowout tooltip, plan, agent strip, cost, sparkline | yes | yes | yes | yes |
| Waiting and stale on the card band and the orchestrator page's status band | yes | yes | | |
| Empty states with an instruction | yes | | | |
| Orchestrator page: header, three charts with crosshair and readout, blowout marker and caption | yes | yes | yes | |
| Facts grid with Session, Resume and Fork last ("Copied", then back; popups on Resume and Fork) | yes | yes | yes | |
| Blowouts cell opens the blowout detail with agent links | yes | | | |
| Plan checklist, agent tree, sort columns and "Show as tree" (now "Launch order", and a sort keeps the tree, #101), row flash | yes | yes | yes (tree scrolls inside) | |
| Activity: 12 rows, Show 12 more, Show fewer, counts, 150-event note | yes | yes | yes | |
| Activity row selects session and agent, scrolls and flashes; failure row shows root cause | yes | yes | yes | |
| Rows of ended sessions greyed, "Session ended", inert | yes | | | |
| Agent detail: failure box, blowout timeline, inherited model and effort on a fork | yes | yes | | |
| No horizontal page scroll | yes | yes | yes (381 px in 396) | yes |
| Kill and restart the server: UI reconnects with no reload | yes | | | |
| 20 reports in 200 ms (10 new sessions + 10 for one): 11 rows, no duplicates | yes (23 ms) | | | |
| A session that never ends: stale at 15 s, gone at 75 s | yes | | | |
| A real `claude -p` session appears, with agents and plan, then leaves | yes (run 3) | | | |

Blank cells were not separately checked at that width or theme. The layout is the same CSS, and the 400 px and
light passes covered the views listed. 400 px ran in a 400 px same-origin iframe because Chrome would not resize
the window that narrow. Touch input and screen reader output were not checked.

<!-- nav:start -->
---

Previous: [Known issues](05-known-issues.md) · Up: [Architecture](README.md) · Next: [Mod API findings](07-mod-api-findings.md)
<!-- nav:end -->
