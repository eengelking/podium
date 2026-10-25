---
title: "23. The server prices tokens, with prices the Admin can change"
description: "The server prices per-model token counts with a table Admins can change, worked out on read, so the session figure is an estimate, not Claude Code's ledger."
group: "Project internals"
number: 23
date: "2026-10-13"
status: "accepted"
order: 23
---

# 23. The server prices tokens, with prices the Admin can change

**Decision.** The reporter sends tokens per model and per prompt-size tier (`usageByModel`, for the session
and for each agent). The server turns them into dollars in one module, `pricing.ts`, using a built-in table
of Anthropic's list prices with the Admin's changes laid over it.

- The cost is worked out when it is read, not when it arrives, so a price change moves every figure at once.
- Each model has five prices (input, output, cache read, 5-minute and 1-hour cache write). Haiku 5.5 has a
  second set for prompts over 100,000 tokens.
- Podium does not read Claude Code's own `modelPricing` or cost figure.

**Why.**

- The reporter cannot see the Admin's settings, and the session total it used to send was Claude Code's
  ledger, which the server cannot reprice.
- Tokens per model are enough to reprice everything, including the orchestrator's share (session total
  minus its agents), so the card, the facts bar and the totals still add up (#109).
- Pricing on read means a price change needs no migration of stored rows.
- A request's tier depends on its own prompt size, so it has to be decided per request in the reporter, not
  from totals.

**Cost.**

- The session figure is now an estimate from the Admin's prices, not Claude Code's ledger, for any reporter
  that sends usage (0.12.0 and later). A person who sets a contracted rate in Claude Code's `modelPricing`
  must set it here too.
- Reports grow by a few rows per model, and each sample row stores the session's usage so the cost-per-minute
  sparkline can follow the Admin's prices too (#270).
- Cache writes count at the 5-minute rate unless Claude Code reports the 1-hour part. The `turn.step` usage
  fields in SPEC 5 carry no such split, so until it does the 1-hour price has no effect.
- A session first heard of after midnight, whose start the server believed from before it, counts what it
  spent since its first sample (#276).
- A session that started before midnight and now reports no ledger figure (the reporter sends `null` for a
  local model) cannot be split by the ledger. It is split by the usage its last sample before midnight kept,
  priced with the Admin's prices: what it costs now minus what that usage cost. So a session that spent on a
  Claude model before midnight and on a local model after adds only its spend after midnight (#286).
- A session none of whose samples kept usage (a reporter older than 0.12.0 on a local model) has nothing to
  split by and counts nothing today.

<!-- nav:start -->
---

Previous: [22. Wall notices are server settings, shown at the bottom, with one switch each in Admin](22-wall-notices-are-server-settings-shown-at-the-bottom.md) · Up: [Decisions](README.md) · Next: [24. An agent's activity is sent only while someone watches it, and never kept](24-an-agents-activity-is-sent-only-while-someone.md)
<!-- nav:end -->
