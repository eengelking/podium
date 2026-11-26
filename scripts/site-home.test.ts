// The docs site's front page (site/src/pages/index.astro). #1415: Safari showed the floating chips without their words, which were
// page text sized from the container's width on an animated layer. Each chip's words are now drawn inside its graphic.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const page = fs.readFileSync(path.resolve(import.meta.dirname, "../site/src/pages/index.astro"), "utf8");

/** The markup of each floating chip: from its opening div to the div's own end. A chip holds no div. */
const chips = page.split('<div class="chip').slice(1).map((rest) => rest.slice(rest.indexOf(">") + 1, rest.indexOf("</div>")).trim());

// #1415: Safari drew nothing below the header after a narrow window went full screen. The docs pages skip the drawing of blocks that are
// off screen (content-visibility), and on the front page the one block is the whole page, so it is left out.
describe("skipping off-screen blocks", () => {
  const theme = fs.readFileSync(path.resolve(import.meta.dirname, "../site/src/styles/theme.css"), "utf8");
  it("leaves the front page out", () => {
    expect(page).toContain('<div class="home ');
    const rules = theme.split("\n").filter((line) => /content-visibility\s*:\s*auto/.test(line));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule.slice(0, rule.indexOf("{"))).toMatch(/:not\([^)]*\.home\b/);
  });
  // The skipping also clipped what runs past the page's edge, so without it a phone scrolled sideways.
  it("still clips what runs past the front page's edge", () => {
    expect(page).toMatch(/^\s*\.home \{[^}]*overflow-x: clip;/m);
  });
});

describe("the front page's floating chips", () => {
  it("draws everything in a chip inside one graphic", () => {
    expect(chips).toHaveLength(4);
    for (const chip of chips) {
      expect(chip.startsWith("<svg")).toBe(true);
      expect(chip.endsWith("</svg>")).toBe(true);
      expect(chip.match(/<svg\b/g)).toHaveLength(1);
      expect(chip).not.toContain("<span");
      expect(chip).toMatch(/<text class="[^"]+"/);
    }
  });
  // One unit of a chip's graphic is one unit of the illustration only while its viewBox is the chip's own size.
  it("gives each graphic a viewBox of its chip's size", () => {
    const sizes = [...page.matchAll(/<div class="chip[^>]*--w:(\d+);--h:(\d+);[^>]*>\s*<svg viewBox="0 0 (\d+) (\d+)"/g)];
    expect(sizes).toHaveLength(4);
    for (const [, w, h, boxW, boxH] of sizes) expect([boxW, boxH]).toEqual([w, h]);
  });
  it("sizes no chip text from the container's width", () => {
    const rules = page.split("\n").filter((line) => line.trimStart().startsWith(".chip"));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).not.toMatch(/\bfont(-size)?\s*:[^;}]*var\(--u\)/);
  });
});
