// In wall mode the Board's columns fill the space down to the footer (#497).
// jsdom does no layout, so this reads fleet.css: in wall mode the board is a column that takes the height of .main,
// the columns stretch to it instead of stopping at the 640px cap, and what does not fit scrolls inside the column.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/fleet/fleet.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`, or "" when there is none. */
function rule(selector: string): string {
  const esc = selector.replaceAll(/[.[\]()>:*+~ ]/g, (c) => `\\${c}`);
  return new RegExp(String.raw`(?:^|\n)\s*${esc}\s*\{([^}]*)\}`).exec(css)?.[1] ?? "";
}

describe("Board columns in wall mode (#497)", () => {
  it("makes the main area a bounded column so the board can take its height", () => {
    const main = rule(".podium[data-wall] .main:has(> .kb)");
    expect(main).toMatch(/display:\s*flex/);
    expect(main).toMatch(/flex-direction:\s*column/);
    expect(main).toMatch(/overflow:\s*auto/);
    expect(main).toMatch(/padding-bottom:\s*0/);
  });

  it("lets the board fill that height with no gap under it", () => {
    const kb = rule(".podium[data-wall] .kb");
    expect(kb).toMatch(/flex:\s*1/);
    expect(kb).toMatch(/min-height:\s*0/);
    // With no strip there is nothing to leave room for; with one, the strip's own 16 px from the legend stays (SPEC 8.1).
    expect(rule(".podium[data-wall] .kb:not(:has(> .kb-none))")).toMatch(/padding-bottom:\s*0/);
  });

  it("stretches the columns to the board instead of capping them", () => {
    const board = rule(".podium[data-wall] .kb-board");
    expect(board).toMatch(/flex:\s*1/);
    expect(board).toMatch(/min-height:\s*160px/);
    expect(board).toMatch(/align-items:\s*stretch/);
    expect(board).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(rule(".podium[data-wall] .kb-col")).toMatch(/max-height:\s*none/);
  });
});
