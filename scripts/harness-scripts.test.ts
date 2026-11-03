import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXEMPT, harnesses, missingHarnessScripts, readScripts } from "./harness-scripts.mjs";

const ROOT = path.join(__dirname, "..");

describe("a script pair per harness (#934)", () => {
  it("package.json has test:mod:<harness> and typecheck:mod:<harness> for every harness under plugin/", () => {
    const missing: string[] = missingHarnessScripts(path.join(ROOT, "plugin"), readScripts(ROOT));
    expect(missing, `plugin/<harness>/ needs these scripts in package.json (CONTRIBUTING.md, "Testing a reporter"): ${missing.join(", ")}`).toEqual([]);
  });

  it("names the missing scripts when a harness folder has none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-scripts-"));
    try {
      for (const d of ["core", "claudecode", "pi"]) fs.mkdirSync(path.join(dir, d));
      const scripts = { "test:mod:claudecode": "x", "typecheck:mod:claudecode": "x" };
      expect(harnesses(dir)).toEqual(["claudecode", "pi"]);
      expect(missingHarnessScripts(dir, scripts, new Set())).toEqual(["test:mod:pi", "typecheck:mod:pi"]);
      expect(missingHarnessScripts(dir, { ...scripts, "test:mod:pi": "x" }, new Set())).toEqual(["typecheck:mod:pi"]);
      expect(missingHarnessScripts(dir, scripts, new Set(["pi"]))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exempts no harness", () => {
    expect([...EXEMPT]).toEqual([]);
  });
});
