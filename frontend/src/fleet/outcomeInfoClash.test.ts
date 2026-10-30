// The "info" Outcome frame (`.out.info`, the answer panel's "Answered in the terminal") shares its class name with the
// top bar's `.info` button. A rule that styles every `.info` shrinks the frame to that button's 24px circle at the
// right edge (#829). jsdom does not run the cascade, so this reads fleet.css: every rule for `.info` names the button.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/fleet/fleet.css"), "utf8");

describe("the info class (#829)", () => {
  it("only the top bar's button is styled by a bare .info selector", () => {
    const offenders: string[] = [];
    for (const m of css.matchAll(/(?:^|\n)\s*([^{}\n@][^{}]*)\{/g)) {
      for (const sel of m[1]!.split(",").map((s) => s.trim())) {
        if (/\.info\b(?!-)/.test(sel) && !/\.out\.info/.test(sel) && !/button\.info/.test(sel)) offenders.push(sel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
