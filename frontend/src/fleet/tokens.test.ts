import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { THEMES } from "./themes";

// #354: tokens.css is the one place a color token is defined. The app, the standards pages and new mockups all read it.
const read = (f: string) => readFileSync(resolve(__dirname, f), "utf8");
const TOKEN_DEF = /^\s*--(bg|surface|raised|ink|ink2|muted|grid|axis|border|hover|sel|opus|sonnet|haiku|fable|other|good|good-text|warn|serious|crit|crit-text|deleg|deleg-text|admin-text|on-good|eff-[a-z0-9-]+):/m;

describe("token source (#354)", () => {
  it("has tokens.css, and themes.css is folded into it", () => {
    expect(existsSync(resolve(__dirname, "tokens.css"))).toBe(true);
    expect(existsSync(resolve(__dirname, "themes.css"))).toBe(false);
  });

  it("defines Podium's dark base and both light blocks, and every other theme in both of its modes", () => {
    const css = read("tokens.css");
    expect(css).toMatch(/^:root, \.podium \{/m);
    expect(css).toContain(':root[data-theme="light"], :root[data-theme="light"] .podium {');
    expect(css).toContain("@media (prefers-color-scheme: light)");
    for (const t of THEMES.filter((x) => x.id !== "podium"))
      for (const m of t.modes) expect(css).toContain(`:root[data-theme-name="${t.id}"][data-theme="${m}"] .podium {`);
  });

  it("is imported by fleet.css, which defines no color token of its own", () => {
    const fleet = read("fleet.css");
    expect(fleet).toMatch(/^@import "\.\/tokens\.css";/);
    expect(fleet).not.toMatch(TOKEN_DEF);
  });

  it("takes the page background from --bg, not a hex value (outside .podium the tokens live on the root)", () => {
    const fleet = read("fleet.css");
    expect(fleet).not.toMatch(/html:has\(\.podium\)[^{]*\{\s*background:\s*#/);
    expect(fleet).not.toMatch(/:root\[data-theme="light"\]:has\(\.podium\)[^{]*\{\s*background:\s*#/);
  });
});
