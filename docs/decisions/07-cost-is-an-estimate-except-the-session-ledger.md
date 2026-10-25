---
title: "7. Cost is an estimate, except the session ledger"
description: "An orchestrator's cost is the session ledger and agent cost is an estimate from a price table, labeled as one. Partly replaced by 23."
group: "Project internals"
number: 7
date: "2026-10-11"
status: "accepted"
order: 7
---

# 7. Cost is an estimate, except the session ledger

*Superseded in part by 23 (#117): the server now prices the tokens, with `server/src/fleet/pricing.ts`.*

**Decision.** An orchestrator's own cost is the session's ledger. Agent cost is token counts times a price
table (`mod/podium-reporter/hooks/models.ts`), and the UI always labels it an estimate.

**Why.** The engine only gives a ledger for the session, not per agent. Presenting an estimate as a bill
would be wrong.

A model with no price (anything that is not a Claude model, such as one served by Ollama) gets no estimate
at all:

- It is `null` in the report and "n/a" in the UI.
- Its sessions are left out of the fleet's cost total, with a note. The note counts a session only while its
  model is unpriced. Once the Admin prices the model the session has a cost and the note goes (#276). The
  cost-per-minute sparkline stays beside it.
- A loop that has not reported a model yet, with no spend, is also unknown and reads as a dash, not $0.00.

The earlier fallback priced such a model as Sonnet so the number was never zero, but an invented figure
presented as an estimate is worse than none (#66).

**Cost.** Agent figures undershoot the ledger a little (known issue 7 in `docs/architecture/`).

<!-- nav:start -->
---

Previous: [6. The report types are copied, and a test keeps them equal](06-the-report-types-are-copied-and-a-test-keeps-them.md) · Up: [Decisions](README.md) · Next: [8. Podman, one image, one volume](08-podman-one-image-one-volume.md)
<!-- nav:end -->
