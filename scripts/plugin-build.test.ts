import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildHarness, checkTree, defaultHarnesses, devStamp, included, planTree, relativeSpecifiers, run, walk } from "./plugin-build.mjs";

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
    for (const f of [".claude-plugin/plugin.json", "types/index.d.ts", "hooks/hooks.json", "plugin/core/tls/helper.mjs", "plugin/claudecode/hooks/register.ts", "plugin/core/git.ts"]) {
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

describe("plugin-build: the dev stamp (#927)", () => {
  const STAMP = ".claude-plugin/dev-build.json";
  const fakeGit = (map: Record<string, { code?: number; out?: string }>) => (args: string[]) => {
    const r = map[args[0]];
    return { code: r?.code ?? (r ? 0 : 128), out: r?.out ?? "" };
  };

  it("is the commit, the tag and whether the tree has edits, ignoring the output folders", () => {
    const seen: string[][] = [];
    const git = (args: string[]) => {
      seen.push(args);
      return fakeGit({ "rev-parse": { out: "a1b2c3d4\n" }, describe: { code: 128 }, status: { out: " M x.ts\n" } })(args);
    };
    expect(devStamp(ROOT, git)).toEqual({ commit: "a1b2c3d4", tag: "", dirty: true });
    expect(seen.find((a) => a[0] === "status")).toEqual(["status", "--porcelain", "--", ".", ":(exclude)dist", ":(exclude).build-test", ":(exclude)dist-zips"]);
    expect(devStamp(ROOT, fakeGit({ "rev-parse": { out: "a1b2c3d4\n" }, describe: { out: "v1.1.0\n" }, status: { out: "" } }))).toEqual({ commit: "a1b2c3d4", tag: "v1.1.0", dirty: false });
  });

  it("is null when git cannot name a commit or read the status, or throws", () => {
    expect(devStamp(ROOT, fakeGit({}))).toBeNull();
    expect(devStamp(ROOT, fakeGit({ "rev-parse": { out: "\n" } }))).toBeNull();
    expect(devStamp(ROOT, fakeGit({ "rev-parse": { out: "a1b2c3d4" }, status: { code: 128 } }))).toBeNull();
    expect(devStamp(ROOT, () => { throw new Error("no git"); })).toBeNull();
  });

  it("is read from the real checkout when none is injected", () => {
    const real = devStamp(ROOT);
    if (real) expect(real.commit).toMatch(/^[0-9a-f]{8}$/);
    expect(devStamp(tmp())).toBeNull(); // a folder outside any repository
  });

  it("is written with --dev-stamp, as JSON with no imports, and the folder is still self-contained", () => {
    const out = tmp();
    const r = run(["claudecode", "--dev-stamp", "--out", out]);
    expect(r.code).toBe(0);
    const dir = join(out, "claudecode");
    const real = devStamp(ROOT);
    if (real) {
      expect(JSON.parse(readFileSync(join(dir, STAMP), "utf8"))).toEqual(real);
      expect(checkTree(dir)).toEqual([]);
    } else expect(existsSync(join(dir, STAMP))).toBe(false);
  });

  it("is written by buildHarness when asked, to the byte the stamp says", () => {
    const planned = planTree("claudecode", { stamp: { commit: "a1b2c3d4", tag: "", dirty: false } });
    expect(planned.get(STAMP)?.toString()).toBe('{"commit":"a1b2c3d4","tag":"","dirty":false}\n');
    expect([...planned.keys()]).toEqual([...planned.keys()].sort());
  });

  it("is left out without the flag, and two such builds are identical", () => {
    const a = buildHarness("claudecode", { outDir: tmp() });
    const b = buildHarness("claudecode", { outDir: tmp() });
    expect(a.files).not.toContain(STAMP);
    expect(snapshot(a.dir)).toEqual(snapshot(b.dir));
    const viaCli = tmp();
    expect(run(["claudecode", "--out", viaCli]).code).toBe(0);
    expect(existsSync(join(viaCli, "claudecode", STAMP))).toBe(false);
  });

  it("builds without a stamp when the source is not a git checkout", () => {
    const root = tmp();
    cpSync(join(ROOT, "plugin"), join(root, "plugin"), { recursive: true, filter: (src) => !src.includes("node_modules") });
    const built = buildHarness("claudecode", { root, outDir: tmp(), stamp: true });
    expect(built.files).not.toContain(STAMP);
    expect(checkTree(built.dir)).toEqual([]);
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

  it("builds claudecode into --out, and builds opencode only when it is named (it is not distributed until #857)", () => {
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

  it("builds opencode as a package: package.json pointing at the entry, its source and the shared source", () => {
    const out = tmp();
    const r = run(["opencode", "--out", out, "--with-tests"]);
    expect(r.code).toBe(0);
    const dir = join(out, "opencode");
    const files = walk(dir);
    for (const f of ["package.json", "plugin/opencode/index.ts", "plugin/opencode/reporter.ts", "plugin/opencode/reporter.test.ts", "plugin/core/transport.ts"]) expect(files, f).toContain(f);
    for (const f of ["plugin/opencode/tsconfig.json", "plugin/opencode/vitest.config.ts", "plugin/opencode/package.json", ".claude-plugin/plugin.json", "hooks/hooks.json"]) expect(files, f).not.toContain(f);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "podium-reporter-opencode", main: "plugin/opencode/index.ts", exports: { ".": "./plugin/opencode/index.ts", "./tui": "./plugin/opencode/tui.ts" }, version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version });
    expect(files.some((f: string) => f.endsWith(".test.ts") && f.startsWith("plugin/opencode/"))).toBe(true);
    expect(run(["opencode", "--check", "--out", out])).toMatchObject({ code: 0 });
    // Without --with-tests the tests stay out, and the same source gives the same bytes.
    const a = tmp();
    const b = tmp();
    run(["opencode", "--out", a]);
    run(["opencode", "--out", b]);
    expect(walk(join(a, "opencode")).some((f: string) => f.endsWith(".test.ts"))).toBe(false);
    expect(snapshot(join(a, "opencode"))).toEqual(snapshot(join(b, "opencode")));
  });

  it("checks an opencode folder's package.json", () => {
    const dir = tmp();
    mkdirSync(join(dir, "plugin", "opencode"), { recursive: true });
    writeFileSync(join(dir, "plugin", "opencode", "index.ts"), "export default 1\n");
    writeFileSync(join(dir, "package.json"), "{ nope");
    expect(checkTree(dir)).toEqual(["package.json is not valid JSON."]);
    writeFileSync(join(dir, "package.json"), '{"name":"x"}');
    const noExports = 'package.json needs a name and an exports entry for "." that names a file in the folder (OpenCode loads a local plugin through them).';
    expect(checkTree(dir)).toEqual(["package.json has no version.", "package.json main does not name a file in the folder.", noExports]);
    writeFileSync(join(dir, "package.json"), '{"version":"1.0.0","main":"plugin/opencode/index.ts"}');
    expect(checkTree(dir)).toEqual([noExports]);
    writeFileSync(join(dir, "package.json"), '{"name":"x","version":"1.0.0","main":"plugin/opencode/index.ts","exports":{".":"./plugin/opencode/index.ts"}}');
    expect(checkTree(dir)).toEqual([]);
  });

  it("fails clearly for a harness with no manifest, a bad flag and a missing value", () => {
    const empty = tmp();
    mkdirSync(join(empty, "plugin", "opencode"), { recursive: true });
    expect(() => planTree("opencode", { root: empty })).toThrow("plugin/opencode has no package.json");
    expect(() => planTree("claudecode", { root: empty })).toThrow("plugin/claudecode has no .claude-plugin/plugin.json");
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

describe("plugin-build: npm run plugin:build:release (#932)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  it("is the plain script, with no --dev-stamp, while plugin:build keeps the stamp", () => {
    expect(pkg.scripts["plugin:build:release"]).toBe("node scripts/plugin-build.mjs");
    expect(pkg.scripts["plugin:build"]).toContain("--dev-stamp");
  });

  it("builds a folder with no dev-build.json that equals a direct plugin-build.mjs run", () => {
    const viaNpm = tmp();
    const direct = tmp();
    const a = spawnSync("npm", ["run", "--silent", "plugin:build:release", "--", "--out", viaNpm], { cwd: ROOT, encoding: "utf8" });
    expect(a.status, a.stderr).toBe(0);
    const b = spawnSync("node", [SCRIPT, "--out", direct], { cwd: ROOT, encoding: "utf8" });
    expect(b.status, b.stderr).toBe(0);
    for (const h of defaultHarnesses()) {
      expect(existsSync(join(viaNpm, h, ".claude-plugin", "dev-build.json")), h).toBe(false);
      expect(snapshot(join(viaNpm, h))).toEqual(snapshot(join(direct, h)));
    }
  });
});
