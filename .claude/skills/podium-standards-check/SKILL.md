---
name: podium-standards-check
description: Check Podium UI work against the design standards in docs/standards/, and audit the whole app for anything off-standard or not covered. Load this for ANY Podium UI work, before and after you build it - a new or changed screen, component, mockup, CSS rule, color, label, notice, modal, table or form, and before you open a PR that touches frontend/ or mockup/. Also use it when asked "does this follow the standards", "review this UI", "is this on-brand", "audit the UI", "check the platform for deviations", or "what is not covered by the standards". It reports each deviation with the standard it breaks and where, and edits nothing.
---

# Checking Podium UI against its standards

Podium's look is written down in `docs/standards/` (open `index.html`). The pages are generated from the app, so a standard there is what the app really does, not an aspiration. This skill is how you find out whether new or existing UI follows them. It reports. It never edits the code, the mockup or the standards; changing a standard is the `podium-standards-update` skill's job and needs the maintainer's approval.

**Relationship to the global design skills.** `frontend-design`, `dataviz` and the artifact skills say how to design well in general. The standards constrain them: where they disagree, Podium's tokens, components and patterns win. Use the global skills for the parts the standards do not cover, and say when you did.

## Where the standards are

Read the page you need, not all of them (`components.html` is large; search it by section id).

| Question | Page |
|---|---|
| Which color or font token? | `tokens.html`, `frontend/src/fleet/tokens.css` (the only place a color token is defined) |
| Does this work in every theme and mode? | `themes.html` |
| Which size, radius, layer, duration? | `scale.html` (what the stylesheets use today) |
| Is there already a component for this? | `components.html` (section ids such as `#notices`, `#session-card`) |
| A rule for a recurring decision | `patterns.html` (wall notices, paging, status, consent, copy, primary button, empty states, long text) |
| How should it read? | `voice.html` |
| Keyboard, labels, contrast, motion, narrow width | `accessibility.html` |
| When is a mockup needed, how do I add to the system | `process.html` |

`npx tsx scripts/standards-inventory.ts --json` lists every token, class, component and color literal in the app, if you need to look something up fast.

## Two modes

Pick from the request. If it names a diff, a file, a PR or a mockup, run the change check. If it asks about the platform as a whole, or no change is named, run the audit.

### Change check

1. **Scope.** Find what changed: `git diff $(git merge-base HEAD development)...HEAD -- frontend mockup docs/standards` for a branch, or the named file for a mockup. Read the files, not only the diff, for anything whose surroundings matter.
2. **What is already allowed.** A change that is on `development` but not yet in the standards is allowed if the maintainer approved it. Read the `Standards:` lines under `[Unreleased]` in `CHANGELOG.md`. A deviation that one of them names is "allowed, pending release". Anything else that differs from the standards is a deviation.
3. **Check each area, against the page, not from memory:**
   - **Tokens.** Every color is a token from `tokens.css` through `var(--name)`. No hex, rgb or hsl in CSS or TSX (`npm test -w server -- standards-guard` catches these, and also an undefined `var(--x)` and any theme below the contrast targets; run it). A mockup links `tokens.css` and does not carry a `:root` block. Model colors come from the model tokens. Sizes, radii, layers and durations come from the values in use on `scale.html`; a new value needs a reason.
   - **Components.** If a component or class already does the job (`components.html`), use it. A class that is not in `fleet.css` or `admin.css` is new, and a new component or pattern is added to the system in the same change, not invented in one feature.
   - **Patterns.** Walk `patterns.html` and test the change against every rule that applies. The wall-notice rules are the usual miss: bottom of the wall, an X, a confirmation that points to Admin > Settings, an on/off switch there, and errors are never notices. Also: one primary button per view, paging as "Showing N of M" with the Admin pager, status as shape plus word plus color, consent boxes differ from notes, text from a session is a text node and never HTML.
   - **Copy.** `voice.html`: a button says what happens, the same action has one name, errors say what went wrong and what to try, a path in Admin is `Admin > Settings`.
   - **Accessibility and narrow width.** `accessibility.html`: a real button or link with a visible focus ring, names on controls and charts, no color-only meaning, reduced motion, no sideways scroll at 400 px. A mockup must show both light and dark and a narrow width (`process.html`).
4. **Report.** Use the format below. Say what you could not check (no browser, no way to run it) rather than implying it was checked.

### Audit

Run it with no assumption that the code is right.

1. Run `npm test -w server -- standards-guard` and `npm run standards:parity`. Report failures as they are. A parity failure on `development` can just mean development is ahead of the standards; say so, and list what differs.
2. **Deviations** (the app breaks a standard): read the stylesheets and components for hard-coded colors and unlisted literals, `style={{}}` with literal sizes or colors, interactive elements with no label or focus style, state shown by color alone, a message on the wall that breaks the notice rules, text that breaks the voice rules, mockups that carry their own `:root` (`grep -l ":root" mockup/*.html`), docs that still point at the mockup `:root` rule.
3. **Uncovered** (the app does something no standard describes): a component with no section, a class that is on `not-rendered.json` and is not transient, a one-off pattern that two screens each invented, a state with no sample, a value on `scale.html` used once. These are not violations. They are proposals for the maintainer: say what the standard would be.
4. Look for what a checklist misses: the same thing done two ways in two screens, a state only reachable by an error, behavior at 400 px, a very long name, a fleet of hundreds of sessions, an empty list.

## Report format

```
Standards check: <what was checked>   (change check | audit)

Deviations
1. <short title> - breaks <page>#<anchor>: "<the rule, in a few words>"
   Where: <file>:<line>
   What: <what the code does>
   Fix: <the smallest change that follows the standard>

Allowed, pending release   (named by a Standards: line)
- <item> - <the Standards: line>

Not covered by the standards   (proposals, not violations)
- <what the app does> - <where> - <what a standard for it could say>

Could not check
- <what, and why>

Verdict: <N deviations | no deviations>
```

Keep each deviation to what a person needs to act. Never rewrite the code in the report beyond a one-line fix, never "fix it in passing", and never soften a deviation because fixing it is inconvenient.
