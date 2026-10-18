import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FLEET_DIR, tokenBlocks } from "../../../../scripts/standards-inventory";
import { effective, scalePage, themesPage, tokensPage } from "./pages";
import { breakpoints, durations, valuesOf } from "./scale";
import { TOKEN_DOCS, TOKEN_GROUPS } from "./tokens.meta";

const css = `
.a { font-size: 12px; padding: 4px 8px; transition: background .15s, color 0.15s; }
.b { font-size: 12px; padding: 4px 8px; animation: spin 1.2s linear infinite; border-radius: 6px !important; }
.c { font-size: 13px; gap: 4px; z-index: 5; }
/* font-size: 99px; */
@media (max-width: 520px) { .a { margin: 0; } }
@container (min-width: 800px) { .b { margin: 0; } }
`;

describe("scale readers", () => {
  it("counts each value of a property, most used first, ignoring comments and !important", () => {
    expect(valuesOf(css, "font-size")).toEqual([["12px", 2], ["13px", 1]]);
    expect(valuesOf(css, "border-radius")).toEqual([["6px", 1]]);
    expect(valuesOf(css, "padding")).toEqual([["4px 8px", 2]]);
  });

  it("finds the durations in transitions and animations", () => {
    expect(durations(css)).toEqual([["0.15s", 1], [".15s", 1], ["1.2s", 1]].sort((a, b) => (b[1] as number) - (a[1] as number) || String(a[0]).localeCompare(String(b[0]), "en", { numeric: true })));
  });

  it("finds the widths the layout changes at", () => {
    expect(breakpoints(css)).toEqual([["max-width: 520px", 1], ["min-width: 800px", 1]]);
  });
});

const tokensCss = `:root, .podium { --bg: #000; --ink: #fff; --font-ui: sans-serif; }
:root[data-theme="light"], :root[data-theme="light"] .podium { --bg: #eee; }
:root[data-theme-name="nord"][data-theme="dark"], :root[data-theme-name="nord"][data-theme="dark"] .podium { --bg: #2e3440; }`;

describe("effective tokens", () => {
  const blocks = tokenBlocks(tokensCss);
  it("resolves Podium's dark base, Podium's light override and another theme over the base", () => {
    expect(effective(blocks, "podium", "dark")).toEqual({ bg: "#000", ink: "#fff", "font-ui": "sans-serif" });
    expect(effective(blocks, "podium", "light")).toEqual({ bg: "#eee", ink: "#fff", "font-ui": "sans-serif" });
    expect(effective(blocks, "nord", "dark")).toEqual({ bg: "#2e3440", ink: "#fff", "font-ui": "sans-serif" });
    expect(effective(blocks, "nord", "light")).toEqual({ bg: "#000", ink: "#fff", "font-ui": "sans-serif" });
  });

  it("writes the tokens page with a swatch per color and no swatch for a font", () => {
    const html = tokensPage(blocks);
    expect(html).toContain("<code>--bg</code>");
    expect(html).toContain('style="background: var(--bg)"');
    expect(html).not.toContain("var(--font-ui)");
    expect(html).toContain("<code>#eee</code>");
  });

  it("writes the themes page with a column for every theme and mode and the contrast targets", () => {
    const html = themesPage(blocks);
    expect(html).toContain("<th scope=\"col\">Nord dark</th>");
    expect(html).toContain("<th scope=\"col\">Catppuccin (Latte, Mocha) light</th>");
    expect(html).toContain("4.5:1");
    expect(html).toContain('style="background: #2e3440"');
  });

  it("writes the scale page with counts and the ten most used spacing values", () => {
    const html = scalePage(css);
    expect(html).toContain("<code>12px</code></td><td>2</td>");
    expect(html).toContain("Only the ten most used are shown");
    expect(html).toContain("<code>520px</code>".replace("520px", "max-width: 520px"));
  });
});

describe("the contrast text on the themes page", () => {
  it("quotes the numbers scripts/theme-contrast.ts checks", () => {
    const script = readFileSync(join(FLEET_DIR, "..", "..", "..", "scripts", "theme-contrast.ts"), "utf8");
    for (const n of ["4.5:1", "3:1", "0.08"]) expect(script).toContain(n);
  });
});

// Off in a plain `npm test` like the rest of the parity checks: it follows tokens.css on `main`.
describe.runIf(process.env.STANDARDS_PARITY === "1" || process.env.STANDARDS_WRITE === "1")("token docs match tokens.css", () => {
  it("describes every token, and only tokens that exist, in a known group", () => {
    const real = tokenBlocks(readFileSync(join(FLEET_DIR, "tokens.css"), "utf8")).flatMap((b) => Object.keys(b.tokens));
    expect([...new Set(real)].sort()).toEqual(Object.keys(TOKEN_DOCS).sort());
    for (const d of Object.values(TOKEN_DOCS)) expect(TOKEN_GROUPS).toContain(d.group);
  });
});
