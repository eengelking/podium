// A long model name stays inside the Model column of the Agents table (#975).
// jsdom does no layout, so the CSS half reads fleet.css: every row layout gives the Model track 148px, and the chip in
// that cell is as wide as the cell with its label clipped by an ellipsis instead of painting over Effort and Context.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ModelChip } from "./components/Chips";

afterEach(cleanup);

const css = readFileSync(resolve(process.cwd(), "src/fleet/fleet.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`, or "" when there is none. */
function rule(selector: string): string {
  const esc = selector.replaceAll(/[.[\]()>:*+~ ]/g, (c) => `\\${c}`);
  return new RegExp(String.raw`(?:^|\n)\s*${esc}\s*\{([^}]*)\}`).exec(css)?.[1] ?? "";
}

describe("the model chip with a long name (#975)", () => {
  const long = "google/gemma-4-26b-a4b-it";

  it("keeps the label in its own element, so it can be clipped, and the full id as the title", () => {
    render(<ModelChip family="other" model={long} label={long} />);
    const label = screen.getByText(long);
    expect(label.tagName).toBe("SPAN");
    const chip = label.closest(".chip")!;
    expect(chip).toHaveClass("model");
    expect(chip).toHaveAttribute("title", long);
  });

  it("clips the label with an ellipsis and lets the chip shrink to its cell", () => {
    const label = rule(".podium .chip.model > span");
    expect(label).toMatch(/min-width:\s*0/);
    expect(label).toMatch(/overflow:\s*hidden/);
    expect(label).toMatch(/text-overflow:\s*ellipsis/);
    const inRow = rule(".podium .trow .cell .chip.model");
    expect(inRow).toMatch(/width:\s*100%/);
    expect(inRow).toMatch(/min-width:\s*0/);
    expect(inRow).toMatch(/box-sizing:\s*border-box/);
  });

  it("gives the Model track 148px in every row layout, wide and narrow", () => {
    const tracks = [...css.matchAll(/\.podium \.trow(?:\.no-eff)?(?:\.no-ctx)? \{ (?:display: grid; )?grid-template-columns: ([^;]*);/g)].map((m) => m[1]);
    expect(tracks).toHaveLength(8);
    for (const t of tracks) {
      expect(t.split("1fr) ")[1]).toMatch(/^148px /);
    }
  });

  it("raises the table's minimum width by the same 56px", () => {
    expect(rule(".podium .trow")).toMatch(/min-width:\s*calc\(948px /);
    expect(rule(".podium .trow.no-eff")).toMatch(/min-width:\s*calc\(886px /);
    expect(rule(".podium .trow.no-ctx")).toMatch(/min-width:\s*calc\(796px /);
    expect(rule(".podium .trow.no-eff.no-ctx")).toMatch(/min-width:\s*calc\(734px /);
  });
});
