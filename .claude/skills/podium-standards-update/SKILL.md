---
name: podium-standards-update
description: Change the Podium design standards in docs/standards/ so they match the app on main exactly, after the maintainer has approved the change. Load this only when a standard must change - in the release-prep/<version> PR when CHANGELOG.md has Standards: lines under [Unreleased], in a hotfix PR that changes the UI, or when the maintainer says to update, add or fix a standard, token, component or pattern. Use it when parity (npm run standards:parity) fails on a release PR. It refuses a change that has no recorded approval, a change that is not on main yet, and an edit that would make the pages differ from the app.
---

# Updating the Podium design standards

The standards describe what production does. Production is whatever is on `main`. So the pages must match the app on `main` exactly: every token value, component, variant, state and pattern the app has appears in them, and nothing appears that the app does not have. No approximations, no "close enough", no aspirational entries. The `development` branch may be ahead and may be broken; the standards do not follow it until a release.

Most of the pages are generated from the app, so most of this skill is running a command and reading what it says, not writing prose. The parts that are written by hand are the words in `frontend/src/fleet/standards/` (`samples.ts`, `tokens.meta.ts`, `prose.ts`) and the fixtures in `screens*.tsx` that decide what a sample shows.

## Before you touch anything

1. **Approval.** Ask for it and record it. It is an issue, a PR the maintainer approved, or the maintainer's own words in this session. Put the reference in the PR description. A feature PR carries it as a `Standards:` line under `[Unreleased]` in `CHANGELOG.md`; read those lines first, they are the list of what was approved. If there is none, stop and say: "No approval is recorded for this change to the standards. Name the issue or PR the maintainer approved, or ask them." Do not edit on your own initiative, and never to make a deviation look allowed.
2. **Production.** Check that the change is in the code that is on `main`, or is about to be: you are on a `release-prep/<version>` branch, or a hotfix branch off `main`. A change that is approved but not on `main` yet is not written into the standards. Stop and say so.
3. **Branch.** Check `git branch --show-current` is not `main` or `development`.

## The update

1. List what differs: `npm run standards:parity` (it fails and names the first difference; for the whole picture run `npm run standards:sync`, then `git diff --stat docs/standards frontend/src/fleet/standards`).
2. Make the change in the right place:
   - A token's value, or a new or removed token: the value comes from `tokens.css` automatically. A token with no description makes a test fail, so add its role to `tokens.meta.ts`.
   - A new or changed component: add or change its section in `samples.ts` (what it is for, when to use it and not, accessibility, and the cases: a screen from `screens*.tsx` and a selector). If a screen cannot reach its state yet, add the fixture to the screen files.
   - A class no sample can render (it lasts a moment, depends on the pointer, or nothing uses it): add it to `docs/standards/not-rendered.json` with a true reason. A listed class that a sample now renders must come off the list.
   - A rule: change `prose.ts` (patterns, voice, accessibility, process), and only to say what the app does.
   - A color written outside `tokens.css` that cannot be a token yet: `docs/standards/deferred.json`, with a reason.
3. Regenerate: `npm run standards:sync`.
4. Verify, and do not finish until it passes with no differences: `npm run standards:parity`, then `npm test` and `npm run build`. If the app and the standards cannot be matched, stop and ask. Do not edit a page by hand to force it: the generated files are overwritten, and a hand edit would be a difference.

## The PR

The update goes through the normal branch and PR flow. The PR description shows what changed in the standards (`git diff --stat docs/standards`, and in a sentence what each change means) and links the approval. The release PR is valid only if parity passes.

## Refusals

Say why in one or two sentences and what would let you go on.

- No recorded approval: name what is needed (an issue, an approved PR, the maintainer's word).
- The change is not on `main` or in the release-prep PR yet: it is written into the standards at the release that ships it.
- A hand edit of a generated page, or an entry that the app does not have: the pages must equal the app, so the change belongs in the app first.
- A deviation the check found that someone wants allowed: that is a decision for the maintainer, never an edit to the standards.
