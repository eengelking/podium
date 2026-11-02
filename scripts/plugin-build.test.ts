import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildHarness, checkTree, defaultHarnesses, included, planTree, relativeSpecifiers, run, walk } from "./plugin-build.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "plugin-build.mjs");
const tmp = () => mkdtempSync(join(tmpdir(), "plugin-build-"));

/** The bytes of every file under a built folder, name to content. */
function snapshot(dir: string): Map<string, string> {
  return new Map(walk(dir).map((f: string) => [f, readFileSync(join(dir, f)).toString("base64")]));
}

/** A minimal plugin folder that passes the check, for the failure cases to break. */
function fixture(): string {
  const dir = tmp();
  mkdirSync(join(dir, ".claude-plugin"));
  mkdirSync(join(dir, "hooks"));
  mkdirSync(join(dir, "plugin", "core"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), '{"name":"x","version":"1.0.0"}');
  writeFileSync(join(dir, "hooks", "hooks.json"), '{"modules":["../plugin/a.ts"]}');
  writeFileSync(join(dir, "plugin", "a.ts"), 'import { b } from "./core/b.ts"\nexport const a = b\n');
  writeFileSync(join(dir, "plugin", "core", "b.ts"), "export const b = 1\n");
  return dir;
}

describe("plugin-build: the built folder", () => {
  const out = tmp();
  const built = buildHarness("claudecode", { outDir: out });

  it("has the manifest, the types, a generated hooks.json and the source tree under plugin/", () => {
    expect(built.dir).toBe(join(out, "claudecode"));
    for (const f of [".claude-plugin/plugin.json", "types/index.d.ts", "hooks/hooks.json", "hooks/helper.mjs", "plugin/claudecode/hooks/register.ts", "plugin/core/git.ts"]) {
      expect(built.files, f).toContain(f);
    }
    expect(JSON.parse(readFileSync(join(built.dir, "hooks", "hooks.json"), "utf8"))).toEqual({ modules: ["../plugin/claudecode/hooks/register.ts"] });
  });

  it("leaves out tests, .DS_Store, tsconfig.json, the typecheck's types and node_modules", () => {
    expect(built.files.filter((f: string) => f.endsWith(".test.ts") || f.endsWith(".DS_Store"))).toEqual([]);
    expect(built.files.some((f: string) => f.includes("tsconfig.json") || f.includes(".claude-plugin/types/") || f.includes("node_modules"))).toBe(false);
  });

  it("is self-contained", () => {
    expect(checkTree(built.dir)).toEqual([]);
  });

  it("is the same bytes when built twice, and in name order", () => {
    const again = buildHarness("claudecode", { outDir: tmp() });
    expect(snapshot(again.dir)).toEqual(snapshot(built.dir));
    expect(again.files).toEqual(built.files);
    expect(built.files).toEqual([...built.files].sort());
  });

  it("rebuilds over an existing folder, dropping what is no longer built", () => {
    writeFileSync(join(built.dir, "stale.txt"), "x");
    buildHarness("claudecode", { outDir: out });
    expect(walk(built.dir)).not.toContain("stale.txt");
  });

  it("keeps the tests with withTests, and is still self-contained", () => {
    const withTests = buildHarness("claudecode", { outDir: tmp(), withTests: true });
    expect(withTests.files).toContain("plugin/claudecode/hooks/register.test.ts");
    expect(withTests.files).toContain("plugin/core/git.test.ts");
    expect(checkTree(withTests.dir)).toEqual([]);
  });

  it("plans the same file list as it builds", () => {
    expect([...planTree("claudecode").keys()]).toEqual(built.files);
  });
});

describe("plugin-build: the self-containment check", () => {
  it("passes the fixture", () => {
    expect(checkTree(fixture())).toEqual([]);
  });

  it("fails on an import that leaves the folder", () => {
    const dir = fixture();
    writeFileSync(join(dir, "plugin", "a.ts"), 'import { x } from "../../outside/x.ts"\n');
    expect(checkTree(dir).join("\n")).toContain("plugin/a.ts imports ../../outside/x.ts, which leaves the plugin's folder");
  });

  it("fails on an import of a file that is not there, an export-from, and a literal dynamic import", () => {
    const dir = fixture();
    writeFileSync(join(dir, "plugin", "a.ts"), 'export { q } from "./missing.ts"\nconst m = await import("./gone.ts")\nimport "./side.ts"\n');
    const problems = checkTree(dir).join("\n");
    expect(problems).toContain("imports ./missing.ts");
    expect(problems).toContain("imports ./gone.ts");
    expect(problems).toContain("imports ./side.ts");
  });

  it("fails on a missing plugin.json", () => {
    const dir = fixture();
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{ nope");
    expect(checkTree(dir).join("\n")).toContain("plugin.json is not valid JSON");
    const empty = tmp();
    expect(checkTree(empty).join("\n")).toContain(".claude-plugin/plugin.json is missing");
  });

  it("fails on a bad hooks.json: missing, not JSON, no modules, a missing module, a module outside the folder", () => {
    const dir = fixture();
    const set = (text: string) => writeFileSync(join(dir, "hooks", "hooks.json"), text);
    set("{ nope");
    expect(checkTree(dir).join("\n")).toContain("hooks/hooks.json is not valid JSON");
    set('{"modules":[]}');
    expect(checkTree(dir).join("\n")).toContain("non-empty modules array");
    set('{"modules":["./register.ts"]}');
    expect(checkTree(dir).join("\n")).toContain("module ./register.ts does not exist");
    set('{"modules":["../../elsewhere.ts"]}');
    expect(checkTree(dir).join("\n")).toContain("leaves the plugin's folder");
    const bare = fixture();
    writeFileSync(join(bare, "hooks", "hooks.json"), "{}");
    expect(checkTree(bare).join("\n")).toContain("non-empty modules array");
  });

  it("fails on a symlink and on a folder that does not exist", () => {
    const dir = fixture();
    symlinkSync(join(dir, "plugin", "core", "b.ts"), join(dir, "plugin", "link.ts"));
    expect(checkTree(dir).join("\n")).toContain("is a symlink");
    expect(checkTree(join(dir, "nowhere")).join("\n")).toContain("does not exist");
  });

  it("finds the relative specifiers a file names and ignores the rest", () => {
    const text = [
      'import a from "./a.ts"',
      "import type { B } from '../b.ts'",
      'import {\n  c,\n} from "./c.ts"',
      'export * from "./d.ts"',
      'import "./e.ts"',
      'const f = await import("./f.ts")',
      'import g from "node:fs"',
      'const s = "+import x from \\"./in-a-string.ts\\""',
    ].join("\n");
    expect(relativeSpecifiers(text).sort()).toEqual(["./a.ts", "../b.ts", "./c.ts", "./d.ts", "./e.ts", "./f.ts"].sort());
  });
});

describe("plugin-build: the command line", () => {
  it("prints usage for --help and -h", () => {
    for (const flag of ["--help", "-h"]) expect(execFileSync("node", [SCRIPT, flag], { encoding: "utf8" })).toContain("Usage:");
  });

  it("builds claudecode into --out, and skips opencode, which has no plugin.json yet", () => {
    const out = tmp();
    expect(defaultHarnesses()).toEqual(["claudecode"]);
    const r = run(["--out", out]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("claudecode:");
    expect(r.out).not.toContain("opencode");
    expect(run(["--check", "--out", out])).toMatchObject({ code: 0 });
    expect(run(["claudecode", "--out", out, "--with-tests"]).code).toBe(0);
    expect(walk(join(out, "claudecode"))).toContain("plugin/core/git.test.ts");
  });

  it("fails clearly for a harness named that has nothing to build, a bad flag and a missing value", () => {
    expect(run(["opencode", "--out", tmp()])).toMatchObject({ code: 1, err: expect.stringContaining("plugin/opencode has no .claude-plugin/plugin.json") });
    expect(run(["--nope"]).err).toContain('Unknown argument "--nope"');
    expect(run(["--out"]).err).toContain("--out needs a value");
    expect(run(["--check", "--out", tmp()]).err).toContain("not self-contained");
  });

  it("refuses to finish a build whose tree escapes the folder", () => {
    const root = tmp();
    mkdirSync(join(root, "plugin", "claudecode", ".claude-plugin"), { recursive: true });
    mkdirSync(join(root, "plugin", "claudecode", "hooks"));
    writeFileSync(join(root, "plugin", "claudecode", ".claude-plugin", "plugin.json"), '{"version":"1.0.0"}');
    writeFileSync(join(root, "plugin", "claudecode", "hooks", "hooks.json"), '{"modules":["./r.ts"]}');
    writeFileSync(join(root, "plugin", "claudecode", "hooks", "r.ts"), 'import "../../../../outside.ts"\n');
    const r = run(["claudecode", "--out", join(root, "o")], root);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not self-contained");
    expect(r.err).toContain("leaves the plugin's folder");
  });

  it("refuses an unknown harness and a source symlink", () => {
    expect(() => planTree("nope")).toThrow("Unknown harness");
    const root = tmp();
    mkdirSync(join(root, "plugin", "claudecode", ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, "plugin", "claudecode", ".claude-plugin", "plugin.json"), '{"version":"1.0.0"}');
    symlinkSync(join(root, "plugin", "claudecode", ".claude-plugin", "plugin.json"), join(root, "plugin", "claudecode", "x.ts"));
    expect(() => planTree("claudecode", { root })).toThrow("is a symlink");
    expect(run([], tmp())).toMatchObject({ code: 1 });
  });

  it("filters tests and .DS_Store", () => {
    expect(included("a.test.ts")).toBe(false);
    expect(included("a.test.ts", true)).toBe(true);
    expect(included("x/.DS_Store", true)).toBe(false);
    expect(included("a.ts")).toBe(true);
  });

  it("is runnable as a script and exits 1 on a bad argument", () => {
    const r = spawnSync("node", [SCRIPT, "--nope"], { encoding: "utf8" });
    expect(r.status).toBe(1);
  });
});
