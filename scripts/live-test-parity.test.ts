import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { harnessFolders, harnessReferences, parityProblems, run } from "./live-test-parity.mjs";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const SKILL = ".claude/skills/podium-live-test";

/** A repo with the given harness folders and skill references; `skill` is SKILL.md's text, `guide` whether the guide exists. */
function repo(harnesses: string[], refs: string[], skill = refs.map((r) => `references/${r}.md`).join("\n"), guide = true) {
  const root = mkdtempSync(join(tmpdir(), "livetest-"));
  made.push(root);
  mkdirSync(join(root, "plugin", "core"), { recursive: true });
  mkdirSync(join(root, "plugin", ".cache"), { recursive: true });
  writeFileSync(join(root, "plugin", "README.md"), "x");
  for (const h of harnesses) mkdirSync(join(root, "plugin", h), { recursive: true });
  mkdirSync(join(root, SKILL, "references"), { recursive: true });
  writeFileSync(join(root, SKILL, "SKILL.md"), skill);
  if (guide) writeFileSync(join(root, SKILL, "references", "new-harness.md"), "guide");
  for (const r of refs) writeFileSync(join(root, SKILL, "references", `${r}.md`), "ref");
  return root;
}

describe("harnessFolders and harnessReferences", () => {
  it("list harnesses without core, dot folders and files, and references without the guide", () => {
    const root = repo(["opencode", "claudecode"], ["opencode", "claudecode"]);
    expect(harnessFolders(root)).toEqual(["claudecode", "opencode"]);
    expect(harnessReferences(root)).toEqual(["claudecode", "opencode"]);
  });

  it("return nothing when the folders are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "livetest-"));
    made.push(root);
    expect(harnessFolders(root)).toEqual([]);
    expect(harnessReferences(root)).toEqual([]);
  });
});

describe("parityProblems", () => {
  it("passes when every harness has a reference that SKILL.md names", () => {
    expect(parityProblems(repo(["claudecode", "opencode"], ["claudecode", "opencode"]))).toEqual([]);
  });

  it("fails for a harness folder with no reference", () => {
    const problems = parityProblems(repo(["claudecode", "pi"], ["claudecode"]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/plugin\/pi\/: no .*references\/pi\.md/);
  });

  it("fails for a reference with no harness folder", () => {
    const problems = parityProblems(repo(["claudecode"], ["claudecode", "codex"]));
    expect(problems).toEqual([expect.stringMatching(/references\/codex\.md: no plugin\/codex\//)]);
  });

  it("fails when SKILL.md does not name a reference", () => {
    const problems = parityProblems(repo(["claudecode", "opencode"], ["claudecode", "opencode"], "references/claudecode.md"));
    expect(problems).toEqual([expect.stringMatching(/SKILL\.md: does not name references\/opencode\.md/)]);
  });

  it("fails when the new-harness guide is missing", () => {
    const problems = parityProblems(repo(["claudecode"], ["claudecode"], undefined, false));
    expect(problems).toEqual([expect.stringMatching(/new-harness\.md: the new-harness guide is missing/)]);
  });

  it("fails when the skill is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "livetest-"));
    made.push(root);
    expect(parityProblems(root)).toEqual([expect.stringMatching(/the live-test skill is missing/)]);
  });
});

describe("run", () => {
  const out = () => ({ log: vi.fn(), error: vi.fn() });

  it("prints help", () => {
    const o = out();
    expect(run(["--help"], o)).toBe(0);
    expect(o.log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

  it("exits 0 and says so for a repo that passes", () => {
    const o = out();
    expect(run(["--root", repo(["claudecode"], ["claudecode"])], o)).toBe(0);
    expect(o.log).toHaveBeenCalledWith(expect.stringContaining("1 harness(es)"));
  });

  it("exits 1 and prints each problem", () => {
    const o = out();
    expect(run(["--root", repo(["pi"], [])], o)).toBe(1);
    expect(o.error).toHaveBeenCalledTimes(1);
  });

  it("defaults the root to this checkout, which passes", () => {
    const o = out();
    expect(run([], o)).toBe(0);
    expect(dirname(fileURLToPath(import.meta.url))).toContain("scripts");
  });
});
