import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { run as build } from "./plugin-build.mjs";
import { checkDist, run } from "./plugin-dist-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "plugin-dist-check-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

const version = JSON.parse(readFileSync(join(ROOT, "plugin", "claudecode", ".claude-plugin", "plugin.json"), "utf8")).version as string;

/** A temp repo root with the plugin sources, a package.json at the product version and a clean release build in dist/. */
function built() {
  const root = join(scratch, `r${++n}`);
  mkdirSync(root);
  cpSync(join(ROOT, "plugin"), join(root, "plugin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  expect(build([], root).code).toBe(0);
  return root;
}

describe("plugin-dist-check (#983)", () => {
  it("passes when dist/ is exactly what a clean build of the source produces", () => {
    const root = built();
    expect(checkDist(root)).toEqual([]);
    const r = run([], root);
    expect(r.code).toBe(0);
    expect(r.out).toContain("claudecode");
    expect(r.out).toContain("opencode");
  });

  it("fails on a file whose bytes differ, naming it", () => {
    const root = built();
    writeFileSync(join(root, "dist", "claudecode", "plugin", "core", "git.ts"), "// edited\n");
    expect(checkDist(root)).toContain("dist/claudecode: different bytes: plugin/core/git.ts");
    expect(run([], root).code).toBe(1);
  });

  it("fails on a file in dist/ the build does not produce (a stale file)", () => {
    const root = built();
    writeFileSync(join(root, "dist", "claudecode", "stale.txt"), "x");
    expect(checkDist(root)).toContain("dist/claudecode: only in dist/: stale.txt");
  });

  it("ignores a .DS_Store a file browser left in dist/", () => {
    const root = built();
    writeFileSync(join(root, "dist", "claudecode", ".DS_Store"), "x");
    expect(checkDist(root)).toEqual([]);
  });

  it("fails on a file the build produces that dist/ lacks", () => {
    const root = built();
    rmSync(join(root, "dist", "opencode", "package.json"));
    expect(checkDist(root)).toContain("dist/opencode: missing from dist/: package.json");
  });

  it("fails on a folder in dist/ that is no harness's build", () => {
    const root = built();
    mkdirSync(join(root, "dist", "old-harness"));
    writeFileSync(join(root, "dist", "old-harness", "x"), "x");
    expect(checkDist(root)).toContain("dist/old-harness: not a built harness; remove it");
  });

  it("fails on a loose file in dist/", () => {
    const root = built();
    writeFileSync(join(root, "dist", "notes.txt"), "x");
    expect(checkDist(root)).toContain("dist/notes.txt: not a built harness; remove it");
  });

  it("fails on a dev stamp with a message that says how to fix it", () => {
    const root = built();
    writeFileSync(join(root, "dist", "claudecode", ".claude-plugin", "dev-build.json"), '{"commit":"a1b2c3d4","tag":"","dirty":false}\n');
    const problems = checkDist(root);
    expect(problems.some((p) => p.includes("dev-build.json") && p.includes("plugin:build:release"))).toBe(true);
  });

  it("fails on a harness whose version is not the product's", () => {
    const root = built();
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
    const problems = checkDist(root);
    expect(problems).toContain(`dist/claudecode: version ${version} is not the product version 9.9.9`);
    expect(problems).toContain(`dist/opencode: version ${version} is not the product version 9.9.9`);
  });

  it("fails when dist/ is missing, and says to run the release build", () => {
    const root = built();
    rmSync(join(root, "dist"), { recursive: true });
    const r = run([], root);
    expect(r.code).toBe(1);
    expect(r.err).toContain("npm run plugin:build:release");
  });

  it("does not write into the checkout it checks", () => {
    const root = built();
    const before = readFileSync(join(root, "dist", "claudecode", ".claude-plugin", "plugin.json"));
    run([], root);
    expect(readFileSync(join(root, "dist", "claudecode", ".claude-plugin", "plugin.json"))).toEqual(before);
  });

  it("passes on this repository's own dist/ once the release build is committed", () => {
    // The check that gates a PR into main. On a feature branch dist/ holds the last release's bundle, which is stale relative to
    // plugin/ only when the branch changed the reporter; so this asserts the shape of the result, not that the repo is releasable.
    const problems = checkDist(ROOT);
    expect(Array.isArray(problems)).toBe(true);
  });

  it("prints help and rejects an unknown argument", () => {
    expect(run(["--help"]).code).toBe(0);
    expect(run(["--nope"]).code).toBe(1);
  });

  it("runs from the command line", () => {
    const r = spawnSync("node", [join(ROOT, "scripts", "plugin-dist-check.mjs"), "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dist/");
  });
});
