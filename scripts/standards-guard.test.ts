import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inventory, literalProblems, type Deferred } from "./standards-inventory";

// #354: the checks that keep the design system honest. They run in npm test and in CI.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const deferred = (JSON.parse(readFileSync(join(ROOT, "docs/standards/deferred.json"), "utf8")) as { entries: Deferred[] }).entries;

/** The .ts and .tsx source files under a folder, tests included, since the frontend build type-checks them too. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
}

describe("the container image build", () => {
  // The frontend build type-checks every file under frontend/src. The image copies only the folders the Containerfile names,
  // so a file that imports from scripts/ breaks the image build (and nothing in CI builds the image) unless scripts is copied.
  it("copies scripts when the frontend imports from it", () => {
    const importsScripts = sources(join(ROOT, "frontend", "src")).filter((f) => /from "(\.\.\/)+scripts\//.test(readFileSync(f, "utf8")));
    expect(importsScripts.length).toBeGreaterThan(0);
    expect(readFileSync(join(ROOT, "Containerfile"), "utf8")).toMatch(/^COPY scripts scripts$/m);
  });
});

describe("design system guard", () => {
  const inv = inventory();

  it("finds no hard-coded color outside tokens.css that is not on the deferred list", () => {
    expect(literalProblems(inv.literals, deferred)).toEqual([]);
  });

  it("reads every custom property it uses from a definition", () => {
    expect(inv.undefined).toEqual([]);
  });

  it("keeps every theme and mode within the contrast targets", () => {
    const out = execFileSync("npx", ["tsx", "scripts/theme-contrast.ts", "--quiet"], { cwd: ROOT, encoding: "utf8" });
    expect(out).toMatch(/0 failing/);
  }, 30_000);

  it("fails when a new color is hard-coded, an entry loses its reason, or a listed color goes away", () => {
    const added = [...inv.literals, { file: "fleet.css", line: 9, text: "#123456" }];
    expect(literalProblems(added, deferred)).toEqual([expect.stringContaining("hard-coded color #123456 in fleet.css:9")]);
    expect(literalProblems(inv.literals, [{ ...deferred[0], reason: " " }, ...deferred.slice(1)])).toEqual([expect.stringContaining("has no reason")]);
    expect(literalProblems(inv.literals.slice(1), deferred)).toEqual([expect.stringContaining("but found")]);
    const twice = [...inv.literals, { file: "fleet.css", line: 3, text: "#123456" }, { file: "fleet.css", line: 4, text: "#123456" }];
    expect(literalProblems(twice, deferred)[0]).toContain("and 1 more");
  });
});
