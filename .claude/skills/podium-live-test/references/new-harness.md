# Adding a harness

A new harness (Pi, Codex and the rest) joins the live test by adding **one reference file** to this skill, `references/<harness>.md`, named exactly like its folder `plugin/<harness>/`. It does not copy the core scenarios; it says how to start, how to check the wiring, how each scenario differs, and what is excluded. `scripts/live-test-parity.test.ts` fails when a `plugin/<harness>/` has no reference here, or a reference has no harness.

## Code the harness needs first

- A reporter name in `plugin/core/protocol.ts` and `server/src/fleet/reporterNames.ts`, with its version range.
- Reports with a `harness` block and a `capabilities` block (including `commands`).
- An entry in `frontend/src/fleet/harness.ts` (shape, shell tool name, recommended mark).
- Resume and fork commands in `server/src/fleet/derive.ts`.
- A `--harness` value and a `start_<harness>` function in `scripts/podium-peers-e2e.sh`, and the harness named in `docs/e2e/COVERAGE.md` where the e2e suite covers it.

## What the reference file holds

Copy the shape of `claudecode.md` or `opencode.md`:

1. **Variables and cost**: `LIVE`, `B`, `SOCK`, `T`, a port nothing else uses, the model, and what a run costs.
2. **Start**: the exact `up` command, where the plugin loads from (`dist-dev/<harness>`), and which flags turn on the Admin flag and reporter option for C12 to C14.
3. **Isolation**: the scratch home, the harness's config folder, any background service and how to avoid it, sign-in, and where consent and the respond level are set (plugin options, environment, a file), including how to turn answering off for one run.
4. **First-run prompts**: trust prompts, mode toggles, and how to make a tool call raise a permission ask.
5. **Wiring (C1)**: where `/podium` output shows, the keys to send, the expected `reporterName`.
6. **Scenario notes**: a row per scenario that reads differently here (prompt wording, key to press, screen text, how a message is shown at the terminal).
7. **Exclusions**: one row per core scenario the harness cannot do, in the form *capability, why (harness limit or reporter gap), what the run asserts instead* (a refusal and its status, an absent `accepts` kind, a `limits` entry). A capability the harness has that the others lack goes in as an extra check.
8. **Shut down** and **troubleshooting**.

Establish each exclusion from the code and, where possible, a live run, and say which. "Harness cannot" and "reporter does not yet" are different rows: the second becomes an issue, and its row is deleted when the issue is fixed.

## Keep the skill whole

When a harness is added, in the same PR: the reference file, an entry in `SKILL.md`'s list of references, the harness in the "Both at once" run if it can share a server, and a check that the other harnesses' references still read correctly (a new capability in `plugin/core/` may turn an exclusion into core). When a harness gains or loses a capability, its exclusions change in the same PR.
