---
name: podium-ui-verify
description: See a built Podium UI change at a narrow and a wide width with scripts/page-shot.mjs, instead of trusting a type-check. Load this after the mockup is accepted and the code is written, for any change to frontend/ that has a narrow layout and for any width-specific bug, and whenever you need a full-page screenshot of a page at a set width (the docs site included). Use it before reaching for the Chrome extension's window resize, an iframe or `chrome --headless --screenshot`, none of which work here.
---

# Checking the built UI at 400 px and 1440 px

`PROJECT.md` says a UI change with a narrow layout is checked with a real run. This is how. `scripts/page-shot.mjs` loads a page in headless Chrome at a set width and saves a full-page PNG; `--eval` runs a JavaScript snippet in the page and prints its JSON result, for opening panels or reporting where elements sit. Run `node scripts/page-shot.mjs --help` for the flags.

Why this tool and nothing else: the Chrome extension's window resize does nothing, an iframe is refused, and `chrome --headless --screenshot` never finishes because the page holds `/api/fleet/stream` open.

## Steps

1. Start a throwaway server (`development-commands`, seeded with `scripts/podium-peers-seed.mjs`). Never point at the maintainer's own server: `--url` is required and has no default for that reason.
2. Run it once at 400 and once at 1440 (add `--eval` to open a panel or read element positions first), then read each PNG.
3. Stop the server afterwards. The script stops its own Chrome and deletes its profile.

For the docs site, set `document.documentElement.dataset.theme` in `--eval` to pick light or dark (`podium-docs-site`).
