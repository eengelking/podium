#!/usr/bin/env node
// Check that the live-test skill has one reference per harness. Every plugin/<harness>/ folder (plugin/core/ is shared code, not a harness)
// needs .claude/skills/podium-live-test/references/<harness>.md, every such reference needs its harness, and SKILL.md names each one.
// Usage: node scripts/live-test-parity.mjs [--root <repo folder>]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Usage: node scripts/live-test-parity.mjs [--root <repo folder>]
Fails (exit 1) when a plugin/<harness>/ folder has no .claude/skills/podium-live-test/references/<harness>.md, when such a reference
has no harness folder, or when SKILL.md does not name a reference. references/new-harness.md is the guide, not a harness.`;

const SKILL = ".claude/skills/podium-live-test";
const NOT_A_HARNESS = new Set(["core"]);
const GUIDE = "new-harness";

/** The harness folders under plugin/, sorted (everything but the shared `core`, and dot folders). */
export function harnessFolders(root) {
  const dir = join(root, "plugin");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !NOT_A_HARNESS.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** The harness references of the skill (every references/*.md but the guide), sorted. */
export function harnessReferences(root) {
  const dir = join(root, SKILL, "references");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .filter((n) => n !== GUIDE)
    .sort((a, b) => a.localeCompare(b));
}

/** The problems in the repository at `root`, as `file: message` lines. */
export function parityProblems(root) {
  const problems = [];
  const skillFile = join(root, SKILL, "SKILL.md");
  if (!existsSync(skillFile)) return [`${SKILL}/SKILL.md: the live-test skill is missing`];
  if (!existsSync(join(root, SKILL, "references", `${GUIDE}.md`))) problems.push(`${SKILL}/references/${GUIDE}.md: the new-harness guide is missing`);
  const skill = readFileSync(skillFile, "utf8");
  const harnesses = harnessFolders(root);
  const refs = harnessReferences(root);
  for (const h of harnesses) {
    if (!refs.includes(h)) problems.push(`plugin/${h}/: no ${SKILL}/references/${h}.md (a new harness adds its reference, see references/${GUIDE}.md)`);
  }
  for (const r of refs) {
    if (!harnesses.includes(r)) problems.push(`${SKILL}/references/${r}.md: no plugin/${r}/ folder, so no harness has this name`);
    if (!skill.includes(`${r}.md`)) problems.push(`${SKILL}/SKILL.md: does not name references/${r}.md`);
  }
  return problems;
}

/**
 * @param {string[]} argv
 * @param {{ log: (m: string) => void, error: (m: string) => void }} [out]
 */
export function run(argv, out = console) {
  if (argv.includes("-h") || argv.includes("--help")) {
    out.log(HELP);
    return 0;
  }
  const i = argv.indexOf("--root");
  const root = i === -1 ? join(fileURLToPath(import.meta.url), "..", "..") : argv[i + 1];
  const problems = parityProblems(root);
  for (const p of problems) out.error(p);
  if (problems.length === 0) out.log(`live-test skill: ${harnessFolders(root).length} harness(es), each with a reference`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));
