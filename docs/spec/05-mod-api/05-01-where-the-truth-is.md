---
title: "5.1 Where the truth is"
description: "Where to find the engine's types, guide and examples, and how far to trust each statement in section 5."
group: "Reference"
section: "5.1"
order: 1
---

# 5.1 Where the truth is

- The `plugin-authoring` skill bundles the engine's types file, `types/claude-code.d.ts` (about 21,000 lines),
  a long-form guide (`reference.md`) and examples (`examples/`). To find the folder, invoke the skill (it
  rewrites the types and names the current folder) or search the skill's directory. Grep the types file; do
  not read it whole.
- Once a mod is loaded from a folder the engine watches, the same types appear in
  `<mod folder>/.claude-plugin/types/`, and `tsc -p <mod folder>` type-checks the mod.
- The API is early access and moves between releases. The declaration file is the authority. This section is a
  map.

<!-- nav:start -->
---

Up: [5. The Claude Code mod API: everything the reporter needs](README.md) · Next: [5.2 Shape of a mod (Verified)](05-02-shape-of-a-mod.md)
<!-- nav:end -->
