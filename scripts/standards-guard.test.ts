import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inventory, literalProblems, type Deferred } from "./standards-inventory";

// #354: the checks that keep the design system honest. They run in npm test and in CI.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const deferred = (JSON.parse(readFileSync(join(ROOT, "docs/standards/deferred.json"), "utf8")) as { entries: Deferred[] }).entries;

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
