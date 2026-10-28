// The edge tab is at least 24 CSS px on its short side in every placement (#636, WCAG 2.5.8, axe target-size).
// jsdom has no layout, so this reads fleet.css; a real-browser axe run on the wall, Board, My reporters and Traffic is the
// check that the tab passes. The accepted design is mockup/podium-edge-tab-target-size.html, option A: 32 x 24 on a
// horizontal edge, 24 x 32 on a vertical one, the visible pill being the whole hit box.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/fleet/fleet.css"), "utf8");
const rule = (selector: string) => css.split("\n").find((l) => l.startsWith(selector)) ?? "";
const rules = (selector: string) => css.split("\n").filter((l) => l.trim().startsWith(selector));

describe("Edge tab size (#636)", () => {
  it("a horizontal tab is 32 x 24", () => {
    const r = rule(".podium .edge-tab {");
    expect(r).toMatch(/width:\s*32px/);
    expect(r).toMatch(/height:\s*24px/);
  });

  it("a vertical tab is 24 x 32", () => {
    const r = rule(".podium .edge-tab-left, .podium .edge-tab-right, .podium .edge-tab-fold {");
    expect(r).toMatch(/width:\s*24px/);
    expect(r).toMatch(/height:\s*32px/);
  });

  it("the tab straddles its edge by half its thickness, 12 px", () => {
    expect(rule(".podium .top .edge-tab-top")).toMatch(/top:\s*calc\(100% - 12px\)/);
    expect(rule(".podium .kpi-block:not(.shut) .edge-tab-kpi")).toMatch(/top:\s*calc\(100% - 12px\)/);
    expect(rule(".podium .edge-tab-fold {")).toMatch(/right:\s*-12px/);
  });

  it("a folded or stacked bar across the width is 24 px", () => {
    expect(rule(".podium .kpi-block.shut .edge-tab-kpi")).toMatch(/height:\s*24px/);
    const bars = rules(".podium .fold-col.shut .edge-tab-fold { position: relative");
    expect(bars.length).toBe(2);
    for (const b of bars) expect(b).toMatch(/height:\s*24px/);
    const stacked = rules(".podium .edge-tab-fold { top: auto");
    expect(stacked.length).toBe(2);
    for (const s of stacked) expect(s).toMatch(/bottom:\s*-12px/);
  });

  it("the folded rail's tab is centred in the 28 px rail", () => {
    expect(rule(".podium .fold-col.shut .edge-tab-fold { right: auto")).toMatch(/left:\s*2px/);
  });

  it("a collapsed pane's tab fills the 24 px strip", () => {
    expect(rule(".podium .edge-tab-left.edge-tab-shut")).toMatch(/left:\s*0/);
    expect(rule(".podium .edge-tab-right.edge-tab-shut")).toMatch(/right:\s*0/);
  });
});
