// Every harness folder under plugin/ (all but core) ships a test and a typecheck script in package.json (#934).
// Used by scripts/harness-scripts.test.ts, so a new harness cannot land without them.
import fs from "node:fs";
import path from "node:path";

// plugin/opencode/ holds only a README until #855 adds its code. #855 removes this entry.
export const EXEMPT = new Set(["opencode"]);

export function harnesses(pluginDir) {
  return fs
    .readdirSync(pluginDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "core" && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

// The scripts each harness folder is missing, as "test:mod:<harness>" / "typecheck:mod:<harness>".
export function missingHarnessScripts(pluginDir, scripts, exempt = EXEMPT) {
  const missing = [];
  for (const h of harnesses(pluginDir)) {
    if (exempt.has(h)) continue;
    for (const name of [`test:mod:${h}`, `typecheck:mod:${h}`]) {
      if (!(name in scripts)) missing.push(name);
    }
  }
  return missing;
}

export function readScripts(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
}
