---
title: "One machine showed as two rows with different machine ids (fixed in #267)"
description: "Before #267 each load of the mod kept its own machine id; update the mod and the machine settles on one shared id."
group: "Project internals"
area: "Reporters and machines"
date: "2026-10-16"
status: "fixed"
fixed_in: "#267"
order: 8
---

# One machine showed as two rows with different machine ids (fixed in #267)

**You see:** One computer appears twice, each row with its own machine id.

**Why:** Before #267 each load of the mod kept its own machine id in its own store, so an inline copy and the
marketplace install reported as two machines. Every load now shares `podium-machine-id` in the Claude config directory
(`CLAUDE_CONFIG_DIR`, else `~/.claude`). The id is made in `mod/podium-reporter/hooks/machine.ts`.

**Do:** Update the mod. A machine that already had two ids settles on one: the first load to run after the upgrade
writes the file and the others adopt it.

Some edge cases:

- Two sessions that start in the same instant can each keep the id they wrote until they end, and agree from the next
  session on. The other id's row stays live only while its session does.
- If the config directory is copied to another machine, the id goes with it and the two machines share one id.
- Where the file cannot be read or written, the mod falls back to its own store, as before.

<!-- nav:start -->
---

Previous: [The page shows more reporters than I have machines](more-reporters-than-machines.md) · Up: [Gotchas](README.md) · Next: [One machine shows an extra row ending in # and a name](extra-machine-row-ending-in-hash-and-name.md)
<!-- nav:end -->
