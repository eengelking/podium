---
title: "67. A PR adds a changelog fragment, and release-prep assembles the fragments"
description: "Each PR adds its own file under changelog.d/ instead of editing CHANGELOG.md, so PRs never conflict on it. Release-prep folds the files in."
group: "Project internals"
number: 67
date: "2026-11-08"
status: "accepted"
order: 67
---

# 67. A PR adds a changelog fragment, and release-prep assembles the fragments

## Context

Every PR into `development` added its entry to the `[Unreleased]` section of `CHANGELOG.md`. All of those PRs edit the same few lines
at the top of one file, so when one merged, every other open PR conflicted and had to be updated and its checks run again. With
several agents working at once that meant the same PRs went through CI over and over, for a conflict that had nothing to do with
their code.

## Decision

- **A PR adds one file per entry under `changelog.d/`**, named `<issue-or-slug>.<type>.md`. The type is `added`, `changed`,
  `deprecated`, `removed`, `fixed` or `standards`. The issue is the number, such as `1066`, and a PR with no issue uses a short slug,
  such as `login-redirect`. The file holds the text of one entry, without the leading `- `. A PR with an Added and a Fixed entry adds
  two files.
- **A feature or fix PR never edits `CHANGELOG.md`.** Two PRs never touch the same file.
- **The `release-prep/<version>` PR assembles them.** `scripts/changelog-assemble.mjs` appends each fragment to the matching
  `### Type` subsection of `[Unreleased]` and deletes the file. The section is then renamed to the release as before.
- **`standards` and `deprecated` keep their meaning.** A `standards` fragment is the `Standards:` line that records the maintainer's
  approval of a change to a standard. It is written into the release section as a `Standards:` line under Changed. A `deprecated`
  fragment is the `Deprecated` line that `docs/DEPRECATIONS.md` needs.
- **A test checks the fragments that exist** (name, type, not empty). Nothing requires a PR to have one, because a change with
  nothing a person would notice adds none.

## Why

- A new file cannot conflict with another PR's new file, so a merge no longer sends the other open PRs back through CI.
- A parallel batch's sub-agents can each write their own entry. CLAUDE.md kept them out of `[Unreleased]` for exactly this
  conflict.
- Entries already under `[Unreleased]` stay where they are. The assembler adds to the section and does not rewrite it, so there is no
  migration and a PR that was open before this change still merges.

## Alternatives

- **A merge driver or a `union` merge attribute on `CHANGELOG.md`.** It works only where each clone has it configured, and it does
  not stop two PRs adding to the same line of a list.
- **Entries in the PR body, collected at release.** The text would be taken from GitHub at release time, with no review of it in the
  diff and no way to check it in a test.
- **A required fragment on every PR.** Rejected for now: some changes have nothing a person would notice.

## Cost

- One more directory and a step in release-prep.
- The order of entries inside a release section follows the file names, not the order the PRs merged.

<!-- nav:start -->
---

Previous: [66. A closed conversation is kept for the days its harness lets a person resume the session (#1113)](66-a-closed-conversation-is-kept-for-the-days-its-harness-lets-a-person-resume-the-session.md) · Up: [Decisions](README.md)
<!-- nav:end -->
