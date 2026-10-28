---
title: "47. Load every changed file's diff while the page is open, in the browser only (#631)"
description: "The console reads each changed file's diff while the owner has the page open, kept in page memory only; it reads files nobody opened."
group: "Project internals"
number: 47
date: "2026-10-27"
status: "accepted"
order: 47
---

# 47. Load every changed file's diff while the page is open, in the browser only (#631)

**Context.** Opening a file's diff waited on a round trip to the session's machine each time, and nothing was kept, so
opening the same file again or stepping to the next one waited again ([36](36-a-files-diff-is-source-code-so-only-its-owner.md) chose on request so that a file nobody opens is never read).

**Decision.** While the signed-in owner has the session's page open, the console loads the diffs of its changed files in the background.

- The loader is in the browser page: first-listed file first, two at a time, a file the person opens moved to the front, nothing
  while the tab is hidden. The diffs are kept in page memory and thrown away when the page is left. The server still keeps none.
- A reporter option, `fileDiffPreload`, on by default when `fileDiff` is on, turns it off for a person who wants the old on-request behavior.
- Each changed file carries `rev`, the git hash of its content, so an edit that leaves the counts alone is seen and the diff reloads in place.
- The admin log records a load as `file_diff_loaded` and an open as `file_diff_opened`, never the text.
- An archived session on the History page loads nothing, because the machine is gone. It shows no diffs until they are stored (#632).

**Why.**

- The wait is the whole cost of the feature and only a diff that is already there removes it.
- The browser is the only place that needs the text, so keeping it there adds no copy elsewhere.
- A content hash is cheap to read and is exact; counts and status alone miss an edit that swaps a line for a line.

**Alternatives.**

- Keeping the diffs on the server. Rejected here; it is the follow-up, #632.
- Detecting a change by counts and status only. Rejected: a same-count edit would leave a stale diff on screen.
- No option to turn it off. Rejected: [36](36-a-files-diff-is-source-code-so-only-its-owner.md) promised nothing is read for a file nobody opens, so the person who wants that keeps it.

**Cost.** The reporter reads files nobody opened, so more source code leaves the machine, redacted on a best-effort basis, and sits
in the owner's browser page. Redaction is still not a guarantee. A long file list means many `git diff` runs on the machine.

<!-- nav:start -->
---

Previous: [46. A context names one reporter config file, in ~/.podium/contexts.json (#606)](46-a-context-names-one-reporter-config-file-in-podium-contexts-json.md) · Up: [Decisions](README.md)
<!-- nav:end -->
