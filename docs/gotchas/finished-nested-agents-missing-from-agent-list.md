---
title: "Finished nested agents are missing from $.agent.list()"
description: "The engine's list drops finished agents once their parent finishes; do not rely on $.agent.list() for history."
group: "Project internals"
area: "Developing"
date: "2026-10-12"
status: "open"
order: 49
---

# Finished nested agents are missing from `$.agent.list()`

**You see:** `$.agent.list()` no longer returns agents that finished.

**Why:** Once a parent agent finishes, the engine's list drops the finished agents it launched (SPEC 5.3). The mod keeps
every agent it has seen, and the server never deletes an agent a later report leaves out, so the console keeps them. A
hot reload after that point rebuilds only what the list still has.

**Do:** Do not rely on `$.agent.list()` for history. Read from what the mod has recorded.

<!-- nav:start -->
---

Previous: [The frontend build says Property 'toBeInTheDocument' does not exist on type 'Assertion'](frontend-build-tobeinthedocument-type-error.md) · Up: [Gotchas](README.md) · Next: [A turn.step hook that reads the stream loses the step's result](turn-step-hook-loses-the-step-result.md)
<!-- nav:end -->
