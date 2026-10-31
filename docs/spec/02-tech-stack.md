---
title: "2. Tech stack"
description: "The technology choices for the mod, server, database, UI and tooling, with the reason for each."
group: "Reference"
section: "2"
order: 2
---

# 2. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Reporter mod | TypeScript hooks module for Claude Code's mod API (`plugin.json` + `hooks/register.ts`) | The only mechanism that sees agent spawns, per-step usage, compaction, tool results and plans from inside a session, and can send them out (`$.http.fetch`). |
| Server | Node 26, Express 4 (already in the repo), TypeScript | Matches the existing `server/` workspace. |
| Database | SQLite through Node's built-in `node:sqlite` (`DatabaseSync`), behind async storage interfaces with SQLite as the only adapter (#313) | No native build step, no new dependency, plenty for one machine. If `node:sqlite` proves unusable under vitest, fall back to `better-sqlite3` and say why in `docs/architecture/`. Bump `@types/node` in `server/` to a version that declares `node:sqlite`. |
| Live updates | Server-Sent Events (`text/event-stream`) | One-way push, built into browsers, no dependency, reconnects by itself. |
| Frontend | React 19 + Vite + TypeScript (already in the repo) | Matches the existing `frontend/` workspace. |
| Charts | Hand-written inline SVG | The mockup's charts are small polylines with markers; a library would fight the design. |
| Styling | Plain CSS with custom properties, ported from the mockup | The mockup defines the tokens for both themes. |
| Tests | vitest (server, frontend), `claude plugin test` (mod) | vitest is already configured. The mod's tests must run on the engine itself. |
| Fonts | Schibsted Grotesk and JetBrains Mono from Google Fonts, with system fallbacks | Same as the mockup. The app must still work offline with the fallbacks. |

No other runtime dependencies without a written reason in `docs/architecture/`.

---

<!-- nav:start -->
---

Previous: [1. Goals and non-goals](01-goals-and-non-goals.md) · Up: [Specification](README.md) · Next: [3. Glossary](03-glossary.md)
<!-- nav:end -->
