---
name: podium-patterns-check
description: Find and apply Podium's development patterns from docs/PATTERNS.md. Load this when you are about to implement or change code, scripts, config or docs in Podium - before you write, to find the patterns that apply to the files you will touch, and again on the branch before the PR, to check the diff against them and list the ones the PR relies on. Also use it when asked "does this follow our patterns", "what pattern covers X", or when a change would alter a pattern. It reports each departure with the pattern and the check that holds it, and edits nothing. For UI looks it defers to podium-standards-check.
---

# Checking a change against Podium's patterns

`docs/PATTERNS.md` is the list of development patterns the code follows. This skill is how you use it: it holds the steps and none of the patterns, so the page stays the only place a pattern is described. It reports. It never edits the code or the page, and it never decides that a pattern should change; that is the maintainer's decision under "Changing a pattern" on the page.

**Relationship to the standards.** The look of the UI is `docs/standards/`, checked by `podium-standards-check`. For a change under `frontend/` or `mockup/`, load that skill too; it wins on color, components, copy and layout. This skill covers the code patterns in the same files (the live stream, text nodes, `EdgeTab`) and everything outside the UI.

## Three steps

### 1. Before you write: find what applies

1. List the paths the change will touch. Use the issue's Requirements and `git diff --stat` if work has started.
2. Open `docs/PATTERNS.md` and read the sections that cover those paths. Use this map, then read the page, not the map:

   | The change touches | Read |
   |---|---|
   | `server/src/storage/`, a query, a table, a setting stored in the database | Storage |
   | `server/src/` routes, middleware, auth, logging, config or environment | Server routes, auth and logging |
   | Anything a session or person can turn on, or that answers into a session | Consent and what Podium may do |
   | `plugin/` | Reporter and plugin |
   | `frontend/` | UI code (and load `podium-standards-check`) |
   | A test, a spec or a script | Tests |
   | A page under `docs/` | Docs |
   | A version, `dist/`, a PR target, a release | Release |

3. Read the linked decision or gotcha for any entry you will rely on. Read "Findings, not patterns" so you do not copy a departure as if it were a pattern.
4. Write down the patterns the change relies on. They go in the PR body.

If no entry covers what you are about to do, say so. A missing pattern is not permission to invent one: look at how the nearest code does it and follow that.

### 2. On the branch: check the diff

1. Find the change: `git diff $(git merge-base HEAD development)...HEAD`. Read the files, not only the diff, where the surroundings matter.
2. For each pattern you listed, and each other section that covers a path in the diff, test the diff against the entry's rule. Run the check the entry names under "Held by" when it is cheap (`npm test -w server -- <name>`, a script). A pattern with "none" has to be read by eye.
3. A departure is code that does something the entry says not to, or that does by hand what an entry says goes through the shared path. Report it. Do not fix it in passing and do not weaken a check to pass.
4. A change that **alters** a pattern (a new way where the page names one, or a rule that would no longer hold) stops here. Do not continue. Tell the maintainer which pattern, what the change needs it to say, and that the page's "Changing a pattern" rule applies: a DECISIONS entry, approval before code, every use updated, a full pass.
5. Code that already departs from a pattern, which the change did not cause, is filed as its own issue and left alone.

### 3. For the PR

Put one line in the PR body: `Patterns:` and the names of the entries the change relies on, or `Patterns: none apply` with the reason. Say which checks you ran and what you could not run.

## Report format

```
Patterns check: <what was checked>

Relies on
- <entry> (<section>)

Departures
1. <short title> - breaks <entry> (<section>): "<the rule, in a few words>"
   Where: <file>:<line>
   What: <what the code does>
   Held by: <the check, or none>

Would alter a pattern   (stop and ask)
- <entry> - <what the change needs it to say>

Not covered by the page
- <what the change does> - <nearest code followed>

Could not check
- <what, and why>

Verdict: <N departures | no departures>
```

Keep each item to what a person needs to act on. Never soften a departure because fixing it is inconvenient.
