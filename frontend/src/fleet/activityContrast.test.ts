// The Activity panel's time and "go to" hint meet 4.5:1 on a gone row and on the selected row (#636).
// jsdom has no paint, so this reads fleet.css. A real-browser axe run found opacity on a gone row and the muted gray on
// the selected row's wash as the causes; the fix uses existing tokens only.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/fleet/fleet.css"), "utf8");
const rule = (selector: string) => css.split("\n").find((l) => l.startsWith(selector)) ?? "";

describe("Activity row contrast (#636)", () => {
  it("a gone row is not dimmed with opacity", () => {
    expect(rule(".podium .ev li.gone .evb")).not.toMatch(/opacity/);
  });

  it("a gone row's text is ink2, and a failed row keeps its own color", () => {
    expect(rule(".podium .ev li.gone:not(.bad) .tt")).toMatch(/color:\s*var\(--ink2\)/);
  });

  it("the selected row's time and hint are ink2", () => {
    expect(rule(".podium .ev li.cur time, .podium .ev li.cur .go")).toMatch(/color:\s*var\(--ink2\)/);
  });
});
