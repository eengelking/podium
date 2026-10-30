---
name: podium-atlas-update
description: Keep the Podium atlas (docs/atlas/podium-atlas.html and docs/atlas/ATLAS.md) in line with the code. Load this whenever a change is structural or architectural - a new, removed or renamed part, reporter hook or timer, route, middleware in the request chain, table or store, listener or port, deployment mode, flow, consent option or Admin flag, a changed default timing or limit, or a moved or renamed file the atlas names - and in the release-prep PR, when the version and line counts change. Also use it when asked to update, fix, check or extend the atlas, or when `node scripts/atlas-functions.mjs --check` or its test fails. It explains where each fact lives in the page, which tables in ATLAS.md are generated and which are written by hand, and how to verify both.
---

# Updating the Podium atlas

The atlas answers "how does Podium fit together" in two forms that must say the same thing:

- `docs/atlas/podium-atlas.html`, one interactive page. Its facts are JavaScript data inside the page (nodes, flows, modes, stores, consent tiers, request checks, source references). **The page is the source of truth.**
- `docs/atlas/ATLAS.md`, a text companion with tables in three columns: Location, Item, Description. Everything in it is derived from the page and the code.

An out-of-date atlas is worse than none, because it reads as authoritative. The cost of an update is small if you do it in the same PR as the change, and large later, when nobody remembers why a number moved. That is why the rule in `.claude/CLAUDE.md` ties it to structural changes.

## Does this change need an atlas update?

Update it when the change alters something the atlas states:

- a part, hook, timer, route, table, listener, port or middleware is added, removed or renamed, or the order of the request checks changes;
- a flow gains, loses or reorders a step; a deployment mode, consent option or Admin flag is added or its default changes;
- a default timing, limit, size or count the page quotes changes (stale and drop times, backoff, budgets, caps, retention, the number of migrations or Admin pages);
- a file or function the atlas names is moved or renamed (`node scripts/atlas-functions.mjs --check` finds these);
- a release is prepared: the version and the line counts.

Do not update it for a bug fix inside one function, a copy change, a test, or a refactor that keeps every name and number the atlas states. If unsure, search the page for the symbol, the number or the file name: no hit means nothing to update.

## Procedure

Work on a branch in a worktree, as for any change (see `.claude/CLAUDE.md`, "Always Branch First").

1. **Find what changed.** `git diff origin/development...HEAD --stat` and the diff itself. For each change, list the atlas facts it touches. Search the page for the old name or number: `grep -n '<symbol or number>' docs/atlas/podium-atlas.html docs/atlas/ATLAS.md`.
2. **Update the page first.** Edit the data it reads, not the rendering code. `references/page-data.md` says which constant holds which kind of fact and the shape of each entry. Keep the existing voice: short, concrete, one claim per sentence.
3. **Source references.** Each part has `REFS` entries `[file, line, text]`. The line must be the symbol's declaration, and the text must be `name: what it does` or `class Name: what it does` for it to appear in the Key functions tables. A reference with no colon stays on the page only (a route, a setting, a bare constant).
4. **Regenerate.** `node scripts/atlas-functions.mjs` rewrites the Key functions tables in ATLAS.md. Never edit between the `atlas-functions` markers by hand; the next run would erase it.
5. **Update the hand-written ATLAS.md tables** that the change touches: the parts, the reporter's hooks and timers, the flows, the four ways to run it, where data lives. Keep the three columns, group by Location, and keep most-important-first order inside each group. A new reporter hook needs a row, and a test fails without one.
6. **Check every number against the code, not against another doc.** Open the constant or function and read the value. Docs and the page can both be stale; the code cannot.
7. **Version and line counts** change only in the `release-prep/<version>` PR (feature PRs never bump versions). In a feature PR, add or extend the atlas entry under `[Unreleased]` in `CHANGELOG.md` if a person would notice. At release-prep, see "Version and line counts" below.
8. **Verify.**
   - `node scripts/atlas-functions.mjs --check`
   - `cd server && npx vitest run ../scripts/atlas-functions.test.ts`
   - `node scripts/check-doc-links.mjs docs/atlas/ATLAS.md` (the default run does not cover this folder)
   - Load the page and use what you changed: serve `docs/atlas` on localhost (`python3 -m http.server <port> --bind 127.0.0.1`), click the nodes, flows and tabs you touched, and look for console errors. For layout, `node scripts/page-shot.mjs --help`, then a shot at 400 and at 1440 px. Stop the server afterwards.
9. **Report** what changed on the page and in ATLAS.md, which numbers you re-read in the code, and anything you could not verify. Say plainly what you did not run.

## Version and line counts (release-prep only)

The rail says "Reads from the repo at vX.Y.Z" and the footer says "at version X.Y.Z"; both must equal `package.json`, and the test fails otherwise. The line counts are in the `D` array (console, server, reporter mod, scripts: source and test lines), the chart's `aria-label`, the "View as a table" table, the "≈56k + ≈51k" total in the At a glance list, and the "Counted from the repository on <date>" note. The method is: `.ts`, `.tsx` and `.mjs` files, excluding dependencies and snapshot files, the reporter mod counted from its hooks folder, source and test lines counted apart. Re-count the previous release's numbers first with your method; if you do not reproduce them, your method differs and the new numbers would not compare.

## Traps

- **Line numbers are on the page only.** They move on every edit, so ATLAS.md never carries them. When a file changes, re-find each `REFS` line for it: the line must hold the symbol's declaration.
- **Wrong units and wrong order are the common errors.** A fact-check of this page found four wrong claims: a budget described in the wrong unit (a character budget called bytes), the order of the messaging checks, a retry delay that held only for one of two paths, and a demo default that started opposite to the code. For anything with a unit, an order or a default, read the code that enforces it.
- **A description must be true for the code as it is now**, not as the spec intends or the CHANGELOG once said.
- **Do not paste file contents, tokens, hosts or paths from a developer's machine** into the page or the doc. Use the repo-relative path and a one-line description.
- **The page has its own `:root` colors on purpose.** It is a project document, not part of the product, and is exempt from the tokens rule. Do not "fix" them.
- **Keep the two files in step.** If you add a part to the page, ATLAS.md's parts table needs the row, and the reverse. The count ("thirty-two parts" today) appears in the page's heading and in ATLAS.md's intro; update both when the count changes.
