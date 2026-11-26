---
name: podium-marketing-design
description: How Podium's marketing and explainer pages look, and what they may say. Load this whenever you make, change, restyle or review a page that shows Podium to people outside the console - the animated pages in demo/, the architecture atlas, the docs site's look and its front page, a landing page, a one-pager, a diagram or an animation about what Podium does. Use it even when the request never says "marketing", for example "make a page that explains Chat", "add a scene to the demo", "restyle the site", "does the atlas match" or "capture this for a talk". It holds the palette and type, the page recipe, the words to use, the rule that every claim is true, and the checks to run. Not for the console itself, which has its own standards (podium-standards-check).
---

# Podium marketing pages

A page that explains Podium is often the first thing a person sees, so it has to look like one product and say only true things. Both have gone wrong here. The pages drifted into different palettes and fonts, and a first draft of the Chat explainer showed one person's agent messaging another person's agent directly, which Podium refuses. This skill keeps the look in one place and sends every claim back to a doc.

## What it covers

| Surface | Where | Notes |
|---|---|---|
| Explainer and demo pages | `demo/*.html` | One self-contained file each. `demo/podium-chat-explained.html` is the worked example. |
| The architecture atlas | `docs/atlas/podium-atlas.html` | Also has `/podium-atlas-update`, which owns its facts. This skill owns its look. |
| The docs site | `site/src/styles/theme.css`, `site/src/pages/index.astro`, `site/src/components/` | `/podium-docs-site` owns how it is built. |
| The link preview image | `site/og/og.html`, drawn into `site/public/og.png` | The front page's hero in dark mode, held still, with `theme.css`'s dark values. A change to that hero is a reason to look at the image. No test compares them. |

The console and the design system in `docs/standards/` are not covered. They have their own palette, and `/podium-standards-check` wins there. Marketing pages do not read `frontend/src/fleet/tokens.css`.

## The look

**Start from `assets/page-start.html`.** It carries the token block, the reset, the brand, the hero, the bottom controls, the footer and the theme button. Keep its token block exactly as it is. `scripts/marketing-pages.test.ts` compares it with the atlas, the site and every page in `demo/`, so a page that wanders fails `npm test` instead of being found by eye.

**Colors are tokens.** The palette is the atlas's, light and dark, following the system theme with a Theme button (`system`, `light`, `dark`, remembered under `podium-marketing-theme`; the site uses Starlight's own switch). The roles:

- `--bg`, `--surface`, `--sunk`: page, raised panels, sunken areas such as a stage. `--ink`, `--ink2`, `--mute`, `--line`: text, secondary text, quiet text, hairlines.
- `--accent` and `--accent-ink`: what is selected and what can be clicked, and the text on it. `--hot`, `--ok`, `--bad`, `--warn`: highlight and status, each with a word or a shape beside it.
- `--p-ed`, `--p-maya`, `--p-raj`: the colors of the three sample people. `--mark`: the amber of the logo in the corner.
- `--band-top`, `--band-bottom`: the hub fade, a tint of the accent at the top and nearly the surface at the bottom. Put it on the one central object of a page, as the Podium bar and the atlas's system map have it.

There is no color literal outside the token blocks. A new color is a new token, added to the template, the atlas, `theme.css` and every page in the same PR.

**Type.** Bricolage Grotesque for the brand and headings (weight 700, `font-stretch: 85%`, tight tracking), Hanken Grotesk for text, JetBrains Mono for commands, times and status. Sentence case. No all-caps labels, no em dashes.

**People and agents never depend on color alone.** A person is a circle with an initial, an agent is a rounded square with a glyph, and the name is always written.

**The logo is the real one.** Copy the mark from the template or from `Logo` in `frontend/src/fleet/components/Icons.tsx`; do not redraw it. In the corner it takes `--mark`. Inside an animation it is neutral (`currentColor` on `--ink`), so it does not compete with what moves.

**The explainer recipe**, from the Chat page: the brand top left, then a hero with the headline on the left and the lede on the right, right-aligned; scene tabs (a title, a short line and a progress bar); one note line about what is on screen; the central object (a stage beside a conversation); the controls at the bottom (Pause, Replay, the loop switch, Theme); a footer that says the content is illustrative. Captions stay on one line at desktop width.

**Motion is calm.** One thing moves at a time. Packets and typing take about as long as the Chat page's, which runs at 1.25 times its first draft because the first draft felt slow. The person can pause and replay. `prefers-reduced-motion` shows the whole page at rest. The first frame is complete.

## What a page may say

- **Use the app's words.** The app is the console. Chat has channels (General, the public ones, My group) and Direct Messages. "Wall" is the console's page of cards, so it never names Chat. Say agent or session, not orchestrator, unless the page is about messaging rights.
- **Name no harness unless a fact differs.** Podium reports from more than one harness (Claude Code and OpenCode today, more later). Do not write "Claude Code" where "your agent sessions" is true.
- **Every claim is true.** Read `references/claims.md`, then re-read the doc it cites. The list is a place to start and it goes stale. Put each claim and its source in the PR. If you cannot find the source, leave the claim out.
- **Sample data is invented and says so.** Use made-up people, projects, ids and times. Never a real person, host, path, address or token, and never a link to a Claude Code session.
- **Do not state what has to be on** unless you verified it in the code or the docs. Which switches a feature needs is exactly the kind of detail that is wrong from memory.
- Follow `/eengelking:documentation-voice-guide`: plain, specific, no filler.

## Build and check

1. One file, no build step, nothing loaded except Google Fonts (the docs site self-hosts its fonts). Inline the script.
2. Look at it. Serve its folder on a free port (`python3 -m http.server -d <folder> <port> --bind 127.0.0.1`) and open it in Chrome, or take screenshots with `node scripts/page-shot.mjs --url <address> --width 1440` and again at `--width 400`, with `--eval "document.documentElement.dataset.theme='light'"` for the other theme. Look at light and dark, read the console for errors, and stop the server and close the tab. A file:// address will not open in the Chrome tool.
3. Run the guard: `npm run test:db -- -- ../scripts/marketing-pages.test.ts`. It starts throwaway database containers and takes the machine's lock, so say how long it will take. Do not narrow it with `--db` to get a green.
4. By surface. The atlas: `node scripts/atlas-functions.mjs --check` and the atlas test. The site: `node site/scripts/build.mjs --latest-only` and its link check.
5. A page in `demo/` is excluded from SonarCloud on purpose (`sonar-project.properties`), so write no test for its script. A change a visitor of the site would notice gets a `changelog.d/` fragment; a new demo page does not need one.

## When the standard itself changes

The maintainer decides. Change `assets/page-start.html` first, then the atlas, `site/src/styles/theme.css` and every page in `demo/` in the same PR, so `marketing-pages.test.ts` passes. Update this file in that PR if a role or a rule changed.

## Alongside other skills

`/frontend-design:frontend-design` and `/dataviz` apply to any web page, so load them. Where they suggest a different palette or typeface, this standard wins. Use `/podium-standards-check` only for console UI.
