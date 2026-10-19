// The "no open steps" strip hides when the Board is narrow (#413).
// jsdom does not run container queries, so this reads fleet.css: the strip must be display:none inside the same
// @container block that turns the columns into tabs, so the two change at one width and the strip stays mounted
// (its expanded list and open note survive a resize).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/fleet/fleet.css"), "utf8");

describe("no-open-steps strip on a narrow Board (#413)", () => {
  const block = /@container \(max-width: 640px\) \{([^@]*?)\n\}/.exec(css.slice(css.indexOf(".kb-tabs { display: none")))?.[1] ?? "";

  it("shares the breakpoint that turns the columns into tabs", () => {
    expect(block).toMatch(/\.podium \.kb-tabs\s*\{\s*display:\s*flex/);
  });

  it("hides the strip at that width", () => {
    expect(block).toMatch(/\.podium \.kb-none\s*\{\s*display:\s*none/);
  });
});
