---
title: "55. Reporters are keyed by machine and reporter name, the report gains a v2, and mod/ becomes reporters/ (#854)"
description: "Several harnesses on one machine each get a reporter row, the server reads reports v1 and v2, and mod/ is renamed when the second reporter lands."
group: "Project internals"
number: 55
date: "2026-11-01"
status: "accepted"
order: 55
---

# 55. Reporters are keyed by machine and reporter name, the report gains a v2, and mod/ becomes reporters/ (#854)

*The rename plan below is superseded by 56 (#927): `mod/` became `plugin/` (with `plugin/claudecode/`), not `reporters/`. The reporter key and the report v2 stand.*

**Context.** The reporter table is keyed by machine id alone, so two reporters on one machine (Claude Code and OpenCode) would
overwrite one row. The report validator accepts only `reporter.name: 'podium-reporter'`, and its fields (effort, plan source,
models, prices, context windows, resume commands) are Claude Code's. The reporter lives in `mod/`, a name for Claude Code's
mechanism. This records choices the maintainer made for #847.

**Decision.**

- **Reporter key.** A reporter is keyed by machine plus reporter name (#849). Several processes or locations of one harness on a
  machine share one row, as several Claude Code terminals do today.
- **Report contract.** The report moves to `v: 2` (#850), with a harness block and the harness's capabilities, so the console shows
  only what a harness reports. The server reads `v: 1` and `v: 2`, and v1 is not loosened in place. Cost a harness reports for a
  model Podium cannot price is shown, labeled as the harness's figure (#851).
- **Supported range.** One product version for the whole product, with a supported reporter range kept per reporter (#852).
- **Rename plan.** `mod/` becomes `reporters/` in the change that adds the second reporter (#855), with `mod/podium-reporter`
  moving to `reporters/claude-code/`. Until then the folder, the archive name and the marketplace source stay as they are, and
  this decision does not move any file.

**Update (#967).** The reporter's name says its harness. The Claude Code reporter sends `podium-reporter-claudecode` and the
OpenCode reporter `podium-reporter-opencode`; `podium-reporter` stays the product, plugin and MCP tool name. The server reads
the legacy `podium-reporter` as the Claude Code reporter, so an installed reporter that has not updated keeps its row,
key, peers rights and history, with no migration and no change to a stored key. A v1 report may carry either Claude name and a v2
report any of the three. The machine id of an existing Claude Code install is never replaced: its own file, then its store,
then the shared `~/.podium/machine-id`, and the winner is written to the shared file. An OpenCode id may change once, when
it had taken an id the Claude Code reporter did not use. Machine name and OS are read by one implementation in `plugin/core`.

**Why.** A key that includes the reporter name is the smallest change that keeps two harnesses apart. A `v: 2` with a reading
server leaves every installed reporter working. Renaming with the second reporter avoids a rename with nothing to explain it.

**Alternatives.** Loosen v1 in place: every old server would misread a report it cannot validate. Rename `mod/` now: a large move
for one reporter, and the marketplace source would change before it needs to.

**Cost.** The server carries two report versions until v1 is dropped. The rename later touches every path the docs quote, and the
citations that name `mod/` need checking when it happens.
