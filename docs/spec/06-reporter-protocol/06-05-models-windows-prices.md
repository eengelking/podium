---
title: "6.5 Models, windows, prices"
description: "How a model is named, its context window sized and its price applied."
group: "Reference"
section: "6.5"
order: 5
---

# 6.5 Models, windows, prices

Module: `models.ts` (pure).

## Model family and label

- `family(modelIdOrAlias)` is a lowercase substring match: `opus` gives `opus`, `sonnet` gives `sonnet`,
  `haiku` gives `haiku`, `fable` gives `fable`, anything else `other`.
  - Only a Claude model matches: a bare alias (`opus`, `sonnet[1m]`) or an id containing `claude`. A local
    model such as `my-sonnet-finetune:latest` is `other` even though its name holds a family word.
  - The UI colors by family ([section 8.3](../08-ui/08-03-visual-tokens.md)). `other` is shown with the raw model name and
    labeled as not a Claude model.
- The UI labels a Claude model with its family and version (#116). `modelVersion` in
  `frontend/src/fleet/logic.ts` reads the version from the id:
  - `claude-sonnet-5-5` gives `Sonnet 5.5`, `claude-opus-4-8` gives `Opus 4.8`, `claude-sonnet-5` gives
    `Sonnet 5`, and the older `claude-3-5-sonnet-…` order is read too.
  - Version parts are one or two digits, so a date stamp is ignored.
  - An alias with no version (`sonnet`, `opus[1m]`, `opusplan`) shows the family alone. The version is never
    guessed.
  - The full id stays in the tooltip, and the color stays tied to the family.
  - The reporter's own event text (`shortName`) is unchanged.

## Context windows

`windowOf(model)` returns `null` for a model in the `other` family (the percentage is then shown as unknown,
never computed against 1M).

**Assumption:** 200,000 for Haiku 4.5 and older (`haiku-4`, `haiku-3`, `claude-3`), 1,000,000 for the others,
Haiku 5.5 included. For the main loop prefer `$.session.usage().context.window`. Verify with the `claude-api`
skill and record the sources in `docs/architecture/`.

## Prices

- `priceOf(family)` returns USD per million tokens, split input / output / cache read / cache write.
  **Placeholder values must be replaced with current published prices** (use the `claude-api` skill).
- Keep all of it in this one file with a visible comment and a `PRICES_AS_OF` date constant.
- Cost estimate = Σ tokens × price / 1e6.
- A model in the `other` family has no built-in price:
  - `priceOf` and `costOf` return `null`;
  - the report carries `null` for the agent's `costUsdEst` and for the session's `costUsd` (the engine's
    ledger figure is not trusted for a model Podium has no price for, because what it is priced from is not
    known; see Known issues in `docs/architecture/`);
  - the UI shows "n/a" with the reason;
  - the fleet's "est. cost today" leaves those sessions out and says how many (`kpis.unpricedSessions`).

## Admin prices and where they are applied (#117)

The reporter's table is only a fallback for a server that predates this. Since reporter 0.12.0 each report
carries `usageByModel`.

- **What is reported.** The tokens of a loop per model and per prompt-size tier, for the whole session and for
  each agent.
  - The tier is `std`, or `long` for a request whose prompt (input plus cache reads plus cache writes) is over
    100,000 tokens.
  - Cache writes are split into the 5-minute and the 1-hour kind when Claude Code gives the split
    (`cache_creation.ephemeral_1h_input_tokens`). Otherwise all cache writes count at the 5-minute rate.
- **Where it is priced.** The server prices these in one place, `server/src/fleet/pricing.ts`:
  - the built-in table (Anthropic's pricing sheet of 2026-10-13), one row per model id, with five prices each:
    input, output, cache read, 5-minute cache write, 1-hour cache write, in USD per million tokens. Haiku 5.5
    has a second set for prompts over 100,000 tokens;
  - with the Admin's changes laid over it (Admin > Model prices, stored in `settings.model_prices`).
- **How a model resolves.** A model id resolves to the Admin's exact row for that id, else a built-in row (an
  alias such as `opus` is the family's current model), else nothing.
- **When it is priced.** The stored cost is repriced when it is read. A price change moves the cards, the
  orchestrator and agent costs, the facts bar, "Est. cost today", the spend panel and History at once, and a
  restart keeps it.
- **How the figures add up.** The orchestrator's own cost stays the session total minus its agents.
- **Edge cases.**
  - A row from a reporter that sends no `usageByModel` (or an empty list) keeps the cost it was stored with.
  - A model nobody priced adds nothing to the total, so the rest of a mixed session still follows the Admin's
    prices. A session whose models are all unpriced keeps its stored cost.
- **What it means.** The session figure is an estimate from the Admin's prices rather than the engine
  ledger's own number. The ledger's `costUsd` is still stored and is what a reporter older than 0.12.0 shows.
  The sparkline of cost per minute is still drawn from the ledger's samples and does not follow Admin prices.
- **The day.** The day starts at local midnight in the server's timezone. podiumctl gives the container the
  host's `TZ` (or the `TZ` set with `podiumctl config set`), because the container would otherwise run in UTC
  and roll the day over at the wrong hour (#139).

**Admin validation.**
- Each price is a finite number from 0 to 1000 (USD per million tokens).
- An Admin-added model id is lowercased and at most 120 characters, and at most 100 can be added.
- A long-prompt price can be set only on a model that has one.
- A price equal to the built-in value is not stored, and resetting a row deletes the Admin's change.

<!-- nav:start -->
---

Previous: [6.4 Failure and excerpt rules](06-04-failure-and-excerpt-rules.md) · Up: [6. The reporter protocol](README.md) · Next: [6.6 Session display name](06-06-session-display-name.md)
<!-- nav:end -->
