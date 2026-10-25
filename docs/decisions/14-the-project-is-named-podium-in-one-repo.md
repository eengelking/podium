---
title: "14. The project is named Podium, in one repo"
description: "The repo moved from claude-dashboard to eengelking/podium and the old usage dashboard stayed in it for a while, so old links rely on a redirect."
group: "Project internals"
number: 14
date: "2026-10-11"
status: "accepted"
order: 14
---

# 14. The project is named Podium, in one repo

**Decision.** The repo was `claude-dashboard` and is now `eengelking/podium` (PR #5). The earlier usage
dashboard stayed in the same repo at `#/usage` until it was removed (entry 15).

**Why.** The repo is published, and the name should say what the product is. "Podium" was already the
working name in the spec (open question 10, kept in one constant).

**Cost.** Old links to `claude-dashboard` rely on GitHub's redirect.

<!-- nav:start -->
---

Previous: [13. The token option is sensitive](13-the-token-option-is-sensitive.md) · Up: [Decisions](README.md) · Next: [15. The usage dashboard is removed](15-the-usage-dashboard-is-removed.md)
<!-- nav:end -->
