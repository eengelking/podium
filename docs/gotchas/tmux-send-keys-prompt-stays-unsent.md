---
title: "A prompt sent to Claude Code with tmux send-keys stays in the box unsent"
description: "Keys sent in one burst read as a paste and Enter does not submit it; send the text, pause, then send Enter on its own."
group: "Project internals"
area: "Developing"
date: "2026-10-19"
status: "open"
order: 46
---

# A prompt sent to Claude Code with `tmux send-keys` stays in the box unsent

**You see:** You sent a long prompt and `Enter` to a Claude Code window in one `tmux send-keys`. The text is in the
prompt box and no turn starts.

**Why:** The keys arrive in one burst, which Claude Code most likely reads as a paste, and an Enter inside a paste
does not submit it.

**Do:** Send the text, pause, then send Enter on its own:

```sh
tmux send-keys -t podium-e2e:planner -l 'Run podium_peers.'
sleep 1
tmux send-keys -t podium-e2e:planner C-m
```

To watch a nested run without touching your own server:

1. Copy the mod and point its `serverUrl` default at a server on another port with its own `PODIUM_DB`.
2. Pass `--settings '{"enabledPlugins":{"podium-reporter@eengelking-marketplace":false}}'` so the installed copy stays
   quiet.

The simulator's `--nested` flag shows the same shapes with no run at all.

<!-- nav:start -->
---

Previous: [A test run with claude -p cannot launch a fork](claude-p-test-run-cannot-launch-a-fork.md) · Up: [Gotchas](README.md) · Next: [A server test fails now and then with a 404, a 401 or a body of {}, and passes on the next run](server-test-fails-now-and-then-then-passes.md)
<!-- nav:end -->
