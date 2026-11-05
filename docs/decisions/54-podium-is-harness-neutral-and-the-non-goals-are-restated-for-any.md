---
title: "54. Podium is harness-neutral, and the non-goals are restated for any harness (#854)"
description: "Claude Code and OpenCode are the supported harnesses; Podium watches, answers only where the harness's own dialogs offer it, and never types or switches."
group: "Project internals"
number: 54
date: "2026-11-01"
status: "accepted"
order: 54
---

# 54. Podium is harness-neutral, and the non-goals are restated for any harness (#854)

**Context.** The spec's goals and non-goals were written for Claude Code alone. The non-goals say Podium answers a session "only in
the ways Claude Code's own dialogs offer" (SPEC 1). Once OpenCode is a second harness (#847), those words cannot stand as they are,
and the limits must not loosen by accident because a harness offers more controls than Claude Code does (an agent switcher, an
interrupt key).

**Decision.** Podium is a console for agent harnesses. Claude Code and OpenCode are the supported harnesses. The limits of
[DECISIONS 1](01-podium-only-observes.md) and [DECISIONS 28](28-podium-can-answer-a-waiting-session-through.md) hold for every harness:

- Podium watches.
- It answers a session that waits on its person only in the ways that harness's own dialogs offer, and only where the Admin and the
  session's owner have both turned that on.
- It never types into a terminal or opens one.
- It never switches an agent, interrupts a turn, or starts, stops, resumes or kills a session or an agent, even where a harness
  has a control for it.

The Claude Code list in SPEC 1 stays as it is, because it names what Claude Code's dialogs offer. A harness's own list is added
to the spec when its reporter is built.

**Why.** The promise people rely on is that Podium cannot drive their sessions. A limit written as "what the harness offers" would
grow with each harness, so the limit is written as what is answered and what is never done.

**Alternatives.** Keep the wording Claude Code-specific and add an OpenCode paragraph next to it: two lists to keep in step, and no
rule for a third harness. Allow each harness's extra controls: reverses the promise above.

**Cost.** A control that is useful in one harness (switch agent, interrupt) is not offered, even though it would be easy to build.
