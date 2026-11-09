# Changelog fragments

A PR adds one file here for each entry a person would notice, and never edits `CHANGELOG.md`. Two PRs then cannot conflict on it
(DECISIONS 67). The `release-prep/<version>` PR folds the files into `[Unreleased]` with `node scripts/changelog-assemble.mjs`
and deletes them.

- **Name:** `<issue-or-slug>.<type>.md`. The issue is the number, such as `1066.added.md`. A PR with no issue uses a short
  slug, such as `login-redirect.fixed.md`.
- **Type:** `added`, `changed`, `deprecated`, `removed`, `fixed` or `standards`. A PR with two kinds of entry adds two files.
- **Content:** the text of one entry, without the leading `- `. A `standards` fragment is the maintainer-approved change to a
  standard, and it is written out as a `Standards:` line under Changed. A `deprecated` fragment goes with its row in
  `docs/DEPRECATIONS.md`.
- **Check:** `node scripts/changelog-assemble.mjs --check` (it also runs in `npm test`).
