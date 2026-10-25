import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { knownRefs, refProblems, run } from "./check-doc-refs.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-doc-refs.mjs");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const fm = (fields: Record<string, string>, body = "# T\n") => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n${body}`;
const OLD = (name: string) => `${name}.md`; // spelled out here so this file is not itself a reference

/** A repository with spec section 6 (with a subsection 6.8 and a numbered list in section 12) and decision 37. */
function repo(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "docrefs-"));
  made.push(root);
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("docs/spec/README.md", fm({ title: "Spec", description: "d" }));
  put("docs/spec/06/README.md", fm({ title: "6", description: "d", section: "6" }));
  put("docs/spec/06/08.md", fm({ title: "6.8", description: "d", section: "6.8" }));
  put("docs/spec/12.md", fm({ title: "12", description: "d", section: "12" }, "# 12\n\n1. one\n2. two\n10. ten\n"));
  put("docs/decisions/37.md", fm({ title: "37", description: "d", number: "37" }));
  for (const [rel, text] of Object.entries(extra)) put(rel, text);
  return root;
}

describe("knownRefs", () => {
  it("answers for a section, a subsection, a numbered item of a section, and a decision", () => {
    const k = knownRefs(repo());
    expect([k.hasSection("6"), k.hasSection("6.8"), k.hasSection("12.10"), k.hasSection("12.3"), k.hasSection("7"), k.hasSection("7.1")]).toEqual([true, true, true, false, false, false]);
    expect([k.hasDecision("37"), k.hasDecision("38")]).toEqual([true, false]);
  });
  it("has nothing when the folders do not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "docrefs-"));
    made.push(root);
    expect(knownRefs(root).hasSection("1")).toBe(false);
  });
});

describe("refProblems", () => {
  it("accepts citations that resolve, including 'SPEC section n.n'", () => {
    const root = repo({ "server/a.ts": "// see SPEC 6.8 and SPEC section 6, and DECISIONS 37.\n" });
    expect(refProblems(root)).toEqual([]);
  });
  it("reports a citation nothing answers to, with its place", () => {
    const root = repo({ "server/a.ts": "// ok\n// SPEC 9.9 and DECISIONS 99\n" });
    expect(refProblems(root)).toEqual(["server/a.ts:2: SPEC 9.9 is not a section of docs/spec/", "server/a.ts:2: DECISIONS 99 is not an entry of docs/decisions/"]);
  });
  it("reports a reference to an old single-file page, but not in its stub or the changelog", () => {
    const root = repo({
      "README.md": `See docs/${OLD("USER_GUIDE")}.\n`,
      [`docs/${OLD("SPEC")}`]: `Moved to docs/spec/README.md. Was ${OLD("SPEC")}.\n`,
      "CHANGELOG.md": `Edited ${OLD("DECISIONS")}.\n`,
    });
    expect(refProblems(root)).toEqual([`README.md:1: ${OLD("USER_GUIDE")} was split into a folder; point at docs/user-guide/README.md or the page`]);
  });
  it("skips node_modules and ignores files that are not text", () => {
    const root = repo({ "node_modules/x/a.md": "SPEC 99\n", "logo.png": "SPEC 99\n" });
    expect(refProblems(root)).toEqual([]);
  });
});

describe("check-doc-refs.mjs, in-process", () => {
  it("reports each problem then a count, and exits 0 when nothing is wrong", () => {
    const lines: string[] = [];
    expect(run(["--root", repo({ "a.md": "SPEC 8.8\n" })], (l: string) => lines.push(l))).toBe(1);
    expect(lines).toEqual(["a.md:1: SPEC 8.8 is not a section of docs/spec/", "1 unresolved reference(s)"]);
    const ok: string[] = [];
    expect(run(["--root", repo()], (l: string) => ok.push(l))).toBe(0);
    expect(ok).toEqual(["all doc references resolve"]);
  });
  it("prints help and rejects a missing folder", () => {
    const lines: string[] = [];
    expect(run(["-h"], (l: string) => lines.push(l))).toBe(0);
    expect(lines[0]).toContain("Usage:");
    expect(() => run(["--root", "/nonexistent-repo-folder"])).toThrow("not found");
  });
});

describe("check-doc-refs.mjs", () => {
  const run = (...args: string[]) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  it("exits 0 when all resolve and 1 with the problems listed", () => {
    expect(run("--root", repo()).stdout).toContain("all doc references resolve");
    const bad = run("--root", repo({ "a.md": "SPEC 8.8\n" }));
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("a.md:1: SPEC 8.8");
  });
  it("prints help and fails on a missing folder", () => {
    expect(run("--help").stdout).toContain("Usage:");
    expect(run("--root", "/nonexistent-repo-folder").status).toBe(1);
  });
  it("passes on this repository", () => {
    const r = spawnSync("node", [SCRIPT, "--root", join(dirname(SCRIPT), "..")], { encoding: "utf8" });
    expect(r.stdout.split("\n").filter((l) => l.includes(": ")).slice(0, 20), "unresolved doc references").toEqual([]);
    expect(r.status).toBe(0);
  });
});
