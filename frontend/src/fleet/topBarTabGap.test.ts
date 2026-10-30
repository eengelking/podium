// The top bar leaves room for its edge tab where the bar wraps (#787).
// jsdom does no layout, so this reads fleet.css: the tab sits 12 px inside the bar's bottom edge, so below the width where
// the page stacks the bar's bottom padding is 12 px, not 8, or the tab overlaps the last button of the second row.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/fleet/fleet.css"), "utf8");

/** The body of the `@media (max-width: 1040px)` block that holds the stacked layout (the one with `.podium .cols`). */
function stackedBlock(): string {
  const start = css.indexOf("@media (max-width: 1040px) {\n  .podium, .podium .app { height: auto; }");
  if (start < 0) return "";
  const end = css.indexOf("\n}\n", start);
  return css.slice(start, end);
}

describe("top bar and its edge tab (#787)", () => {
  it("keeps today's 8 px bottom padding at wide widths", () => {
    expect(css).toMatch(/\.podium \.top \{[^}]*padding: 8px 16px;/);
  });

  it("adds 4 px of bottom padding below the stacking width, matching the tab's 12 px overlap", () => {
    expect(css).toMatch(/\.podium \.top \.edge-tab-top \{ top: calc\(100% - 12px\); \}/);
    expect(stackedBlock()).toMatch(/\.podium \.top \{ padding-bottom: 12px; \}/);
  });
});
