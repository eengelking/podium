import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkReporter } from "../server/src/fleet/compat";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("mod version", () => {
  // The mod reports VERSION to the server; plugin.json is what installed copies update on. A bump that
  // misses one makes reports claim the wrong version (CONTRIBUTING.md, "The mod version bump").
  it("register.ts VERSION matches plugin.json", () => {
    const manifest = JSON.parse(read("mod/podium-reporter/.claude-plugin/plugin.json")).version as string;
    const m = /export const VERSION = '([^']+)'/.exec(read("mod/podium-reporter/hooks/register.ts"));
    expect(m?.[1]).toBe(manifest);
  });
});

describe("supported reporter range", () => {
  // Without this, a mod minor bump that forgets REPORTER_SUPPORT.max makes every up-to-date mod show
  // "upgrade server" (SPEC 6.8, DECISIONS 18).
  it("includes the mod version in this repo", () => {
    const manifest = JSON.parse(read("mod/podium-reporter/.claude-plugin/plugin.json")).version as string;
    expect(checkReporter(manifest)).toBe("ok");
  });
});

describe("package versions", () => {
  it("root, server and frontend package.json agree", () => {
    const v = ["package.json", "server/package.json", "frontend/package.json"].map((p) => JSON.parse(read(p)).version);
    expect(new Set(v).size).toBe(1);
  });

  // Podium and the mod are versioned as one product (.claude/PROJECT.md, "Releases"; the files are listed in the podium-release skill): a release, or any PR that
  // changes the mod, sets every one of them to the same number.
  it("the mod and the packages share one version", () => {
    const mod = JSON.parse(read("mod/podium-reporter/.claude-plugin/plugin.json")).version as string;
    expect(JSON.parse(read("package.json")).version).toBe(mod);
  });

  it("package-lock.json follows the manifests", () => {
    const lock = JSON.parse(read("package-lock.json"));
    const root = JSON.parse(read("package.json")).version as string;
    expect(lock.version).toBe(root);
    expect(lock.packages[""].version).toBe(root);
    expect(lock.packages.server.version).toBe(root);
    expect(lock.packages.frontend.version).toBe(root);
  });
});

describe("TypeScript compiler", () => {
  // @typescript/typescript6 brings a second `tsc`, and npm links that one into node_modules/.bin, so a bare `tsc` runs
  // TypeScript 6 and passes. The scripts name the TypeScript 7 binary by its path instead (gotcha "npx tsc prints Version 6").
  it("no package script or shell script runs a bare tsc", () => {
    const bare = /(^|[;&|]\s*)(npx\s+)?tsc(\s|$)|\.bin\/tsc/;
    const scripts = ["package.json", "frontend/package.json", "server/package.json"].flatMap((p) =>
      Object.values(JSON.parse(read(p)).scripts as Record<string, string>),
    );
    const shell = read("scripts/podium-mod-typecheck.sh").split("\n").filter((l) => !l.trim().startsWith("#"));
    expect([...scripts, ...shell].filter((l) => bare.test(l))).toEqual([]);
  });

  // The scripts point at the hoisted root copy (`../node_modules/typescript/bin/tsc`), which holds while both workspaces ask for the same range.
  it("frontend and server ask for the same typescript, and the installed one has that major", () => {
    const range = (p: string) => JSON.parse(read(p)).devDependencies.typescript as string;
    expect(range("frontend/package.json")).toBe(range("server/package.json"));
    const major = /\d+/.exec(range("server/package.json"))?.[0];
    expect(JSON.parse(read("node_modules/typescript/package.json")).version.split(".")[0]).toBe(major);
  });

  // TypeScript 7 has no JavaScript compiler API. The guard tests and promise-misuse.mjs get it from the 6.x line.
  it("the compiler API comes from @typescript/typescript6 on 6.x", () => {
    expect(JSON.parse(read("package.json")).devDependencies["@typescript/typescript6"]).toMatch(/^\^6\./);
  });
});
