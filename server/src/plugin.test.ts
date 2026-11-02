// The plugin/ layout (#927): core is shared code, claudecode and opencode each hold what is specific to one harness.
// core may be imported by a harness and never imports one, and one harness never imports the other. Each built
// plugin ships core inside its own folder, so a path that reaches across would break the install.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin");
const FOLDERS = ["core", "claudecode", "opencode"] as const;
type Folder = (typeof FOLDERS)[number];

// A static import or re-export starts a statement, so a string a test feeds to a redactor ("+import x from '../../a'") is not one.
const SPECS = [
  /^[ \t]*(?:import|export)\b[^"'\n=]*?["']([^"']+)["']/gm, // import x from "m", import "m", export * from "m"
  /^[ \t]*\}\s*from\s*["']([^"']+)["']/gm, // the last line of a multi-line import or re-export
  /\b(?:import|require)\s*\(\s*["']([^"']+)["']/g, // import("m"), require("m")
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : sources(p);
    return /\.(ts|tsx|mjs|js)$/.test(e.name) ? [p] : [];
  });
}

function relativeImports(file: string): string[] {
  const text = readFileSync(file, "utf8").replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  return SPECS.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]!)).filter((s) => s.startsWith("."));
}

/** The harness folder an import reaches: "core", "claudecode", "opencode", or null for a path that leaves plugin/ or stays in the importer's own folder. */
function folderOf(file: string, spec: string): Folder | "outside" {
  const rel = path.relative(PLUGIN, path.resolve(path.dirname(file), spec));
  const top = rel.split(path.sep)[0];
  return (FOLDERS as readonly string[]).includes(top!) ? (top as Folder) : "outside";
}

/** Every import in `from` that lands in one of the folders in `forbidden`, as "file imports spec". */
function offenders(from: Folder, forbidden: readonly (Folder | "outside")[]): string[] {
  const dir = path.join(PLUGIN, from);
  return sources(dir).flatMap((file) =>
    relativeImports(file)
      .filter((spec) => forbidden.includes(folderOf(file, spec)))
      .map((spec) => `${path.relative(PLUGIN, file)} imports ${spec}`),
  );
}

describe("plugin/ layout", () => {
  it("has the three folders and walks real files", () => {
    for (const f of FOLDERS) expect(readdirSync(path.join(PLUGIN, f)).length).toBeGreaterThan(0);
    expect(sources(path.join(PLUGIN, "core")).length).toBeGreaterThan(5);
  });

  it("core imports neither harness, and nothing outside plugin/", () => {
    expect(offenders("core", ["claudecode", "opencode", "outside"])).toEqual([]);
  });

  it("claudecode does not import opencode", () => {
    expect(offenders("claudecode", ["opencode"])).toEqual([]);
  });

  it("opencode does not import claudecode", () => {
    expect(offenders("opencode", ["claudecode"])).toEqual([]);
  });

  it("the check sees a forbidden import (guards against a regex that matches nothing)", () => {
    const file = path.join(PLUGIN, "core", "x.ts");
    expect(folderOf(file, "../claudecode/hooks/a.ts")).toBe("claudecode");
    expect(folderOf(file, "../opencode/a.ts")).toBe("opencode");
    expect(folderOf(file, "../../server/a.ts")).toBe("outside");
    expect(folderOf(file, "./protocol.ts")).toBe("core");
  });
});
