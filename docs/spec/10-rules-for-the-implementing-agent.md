---
title: "10. Rules for the implementing agent"
description: "The repository rules, quality bar, order of work and report an implementing agent follows."
group: "Reference"
section: "10"
order: 10
---

# 10. Rules for the implementing agent

*These rules were written for the original build. Where they differ from `.claude/CLAUDE.md` (for example the branch name and the push and PR rules below), that file governs now.*

## 10.1 Repository rules (from this repo's `.claude/CLAUDE.md`)

- You are on branch `feat/podium-fleet-console`. Stay on it. Never work on `main`.
- Commit on this branch after each task (section 9). **Do not push, open a PR, merge, tag, or rewrite history.** The coordinating session does that after review.
- Do not commit secrets. Do not commit `data/`, `.env`, `node_modules/`, or SQLite files.
- Do not spawn forks. If you need help, use a fresh non-fork sub-agent and state its authority in its prompt (report only, no commits). Prefer doing the work yourself, in order.
- When fixing a bug in code, first write a test that reproduces it and watch it fail for the expected reason.
- Verify with real runs, not only type-checks. Say plainly in your final report what you could not run.
- Leave no mess: stop every server, simulator and browser tab you start; check with `pgrep -fl "tsx|vite|node dist|podium"` at the end.
- Before writing a one-off helper script, check `scripts/` for one that does it. New scripts go in `scripts/` with `--help` and stay.
- Do not document architecture in `.claude/CLAUDE.md`. Use `docs/architecture/`.
- If code and this spec disagree, or the spec is silent where it matters, record the question and your chosen reading in `docs/architecture/` under "Spec questions". Do not silently pick; do not stop for small ones.

## 10.2 Quality bar

- TypeScript strict. No `any` without a comment saying why.
- Every new module has tests. Pure logic is tested without I/O.
- No dependency added without a line in `docs/architecture/` explaining why nothing existing would do.
- No reported string is ever interpreted as HTML, SQL, a path, or a shell command.
- The UI never blocks on the server: first paint renders the shell and a loading state; errors show a message with what to do.

## 10.3 Order of work and checkpoints

Do the phases in order. After each phase run `npm test` and `npm run build` at the root and fix failures before continuing. At the end of each phase append a short entry to `docs/architecture/` ("Phase N: what was built, what was verified, what was not").

## 10.4 Using the real Claude CLI (T3.4)

Allowed: at most **three** `claude -p` smoke runs total, each with `--model haiku`, a prompt under 40 words, and `--plugin-dir mod/podium-reporter`. They use the user's quota; do not loop. Set `PORT` to a free port for the test server rather than 4317 if 4317 is busy, and pass it to the mod as `serverUrl` through settings or `pluginConfigs`. Never run an interactive `claude` session. If `claude -p` is unavailable or fails to authenticate, stop that task, record it under "Known issues", and finish the rest.

## 10.5 What to report when done

1. Per task: done or not, with the commit hash.
2. Test and build results (counts), and the exact commands used.
3. What you ran for real, and what you could not.
4. Every Assumption in section 5 that proved wrong.
5. Deviations from this spec and why.
6. Known issues and anything left undone.
7. The final `git log --oneline` of your commits.

---

<!-- nav:start -->
---

Previous: [9. Phased build plan](09-phased-build-plan.md) · Up: [Specification](README.md) · Next: [11. Explicitly out of scope / deferred](11-out-of-scope-and-deferred.md)
<!-- nav:end -->
