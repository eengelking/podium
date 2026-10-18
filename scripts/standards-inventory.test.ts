import { describe, expect, it } from "vitest";
import { classNames, colorLiterals, customPropDefs, customPropUses, stripComments, tokenBlocks } from "./standards-inventory";

describe("stripComments", () => {
  it("removes CSS and JS block comments and line comments, keeping line numbers", () => {
    expect(stripComments("a /* #352 */ b\n// #1af\nc")).toBe("a  b\n\nc");
    expect(stripComments("x\n/* one\ntwo #fff */\ny").split("\n")).toHaveLength(4);
  });

  it("keeps a // that is inside a url or string", () => {
    expect(stripComments('a { b: url(http://x.test/y) }')).toContain("http://x.test/y");
  });
});

describe("colorLiterals", () => {
  it("finds hex, rgb, rgba, hsl and hsla values with their line numbers", () => {
    const css = ".a { color: #fff; }\n.b { background: rgba(0,0,0,.5); border: 1px solid hsl(10 20% 30%); }\n.c { color: #1A2B3C; }";
    expect(colorLiterals(css).map((h) => [h.line, h.text])).toEqual([
      [1, "#fff"],
      [2, "rgba(0,0,0,.5)"],
      [2, "hsl(10 20% 30%)"],
      [3, "#1A2B3C"],
    ]);
  });

  it("finds a hex inside a longer TSX string, and not a link or an id", () => {
    expect(colorLiterals('const a = "1px solid #fff"; const b = `linear-gradient(#000, #fff)`; <a href="#/admin">x</a>; const c = "#top-x";', "tsx").map((h) => h.text)).toEqual(["#fff", "#000", "#fff"]);
  });

  it("ignores issue numbers in comments, color-mix with tokens, and var() use", () => {
    const css = "/* see #352 and #abc */\n.a { color: color-mix(in srgb, var(--crit) 50%, transparent); background: var(--bg); }";
    expect(colorLiterals(css)).toEqual([]);
  });

  it("only treats a quoted #hex string in TSX as a color, not a link or an id", () => {
    const tsx = 'const a = "#ff0000"; const b = "#/admin/settings"; const c = "#add"; <a href="#top">x</a>';
    expect(colorLiterals(tsx, "tsx").map((h) => h.text)).toEqual(["#ff0000", "#add"]);
  });
});

describe("custom properties", () => {
  it("lists definitions and uses, including a fallback and an inline style", () => {
    const css = ".a { --x: 1px; color: var(--ink, #fff); margin: var(--x); }";
    expect([...customPropDefs(css)]).toEqual(["x"]);
    expect([...customPropUses(css)].sort()).toEqual(["ink", "x"]);
    expect([...customPropDefs('<i style={{ ["--c" as string]: c }} />')]).toEqual(["c"]);
  });
});

describe("classNames", () => {
  it("lists each class selector once, ignoring declarations and numbers", () => {
    const css = ".podium .card:hover, .podium .card.risk { padding: 1.5px; }\n.adminv .field.sm { width: 0.5em; }";
    expect([...classNames(css)].sort()).toEqual(["adminv", "card", "field", "podium", "risk", "sm"]);
  });

  it("does not read the value of an attribute selector as a class", () => {
    expect([...classNames('a[href$=".pdf"], .link[data-x="a.b"] { color: red; }')].sort()).toEqual(["link"]);
  });
});

describe("tokenBlocks", () => {
  it("splits tokens.css into blocks keyed by their selector and reads each token", () => {
    const css = ":root, .podium {\n  --bg: #000;\n  --ink: #fff;\n}\n:root[data-theme-name=\"nord\"][data-theme=\"dark\"],\n:root[data-theme-name=\"nord\"][data-theme=\"dark\"] .podium {\n  --bg: #2e3440;\n}\n";
    const blocks = tokenBlocks(css);
    expect(blocks.map((b) => b.selector)).toEqual([":root, .podium", ':root[data-theme-name="nord"][data-theme="dark"], :root[data-theme-name="nord"][data-theme="dark"] .podium']);
    expect(blocks[0].tokens).toEqual({ bg: "#000", ink: "#fff" });
    expect(blocks[1].tokens).toEqual({ bg: "#2e3440" });
  });
});
