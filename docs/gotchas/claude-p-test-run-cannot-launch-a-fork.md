---
title: "A test run with claude -p cannot launch a fork"
description: "Forks are off in a non-interactive run; set CLAUDE_CODE_FORK_SUBAGENT=1 for the run."
group: "Project internals"
area: "Developing"
date: "2026-10-12"
status: "open"
order: 45
---

# A test run with `claude -p` cannot launch a fork

**You see:** The Agent tool answers "Agent type 'fork' not found".

**Why:** Forks are off in a non-interactive run. Subagents launching subagents work without any setting.

**Do:** Set `CLAUDE_CODE_FORK_SUBAGENT=1` for the run.

<!-- nav:start -->
---

Previous: [npm run test:mod and npm run typecheck:mod fail on a clean machine](test-mod-and-typecheck-mod-fail-on-a-clean-machine.md) · Up: [Gotchas](README.md) · Next: [A prompt sent to Claude Code with tmux send-keys stays in the box unsent](tmux-send-keys-prompt-stays-unsent.md)
<!-- nav:end -->
