import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The marketing standard (.claude/skills/podium-marketing-design): the page template is the source of the tokens, and the atlas, the
// docs site's theme and every page in demo/ must carry the same ones. A page also keeps its fonts, loads nothing but those fonts, has no
// color of its own outside the token blocks and respects reduced motion. No tracking issue: this guards the design standard itself.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = ".claude/skills/podium-marketing-design/assets/page-start.html";
const ATLAS = "docs/atlas/podium-atlas.html";
const SITE_THEME = "site/src/styles/theme.css";

/** The tokens the atlas and the site's theme share with the template. The people colors and the gradient belong to the pages. */
const SHARED = ["bg", "surface", "sunk", "ink", "ink2", "mute", "line", "accent", "accent-ink", "hot", "ok", "bad", "warn", "mark", "shadow"];
const FONTS = ["Bricolage+Grotesque", "Hanken+Grotesk", "JetBrains+Mono"];
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const squash = (value: string) => value.replace(/\s+/g, " ").replace(/ ?, ?/g, ",").trim().toLowerCase();

type Tokens = Map<string, string>;
interface Palettes { light: Tokens; dark: Tokens }

/** The custom properties declared in a block of CSS, with their values folded to one line and lower case. */
function declarations(block: string): Tokens {
  const out: Tokens = new Map();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], squash(m[2]));
  return out;
}

/** The light palette (the bare :root block) and the dark one (:root[data-theme="dark"]) of a page. */
function palettes(html: string): Palettes {
  const light = html.match(/(?:^|\n)\s*:root\s*\{([^}]*)\}/);
  const dark = html.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
  return { light: declarations(light?.[1] ?? ""), dark: declarations(dark?.[1] ?? "") };
}

function styleOf(html: string): string {
  return html.split("<style>")[1]?.split("</style>")[0] ?? "";
}

/** The tokens a page must carry: every one the template declares, in both themes, with the same value. */
function tokenProblems(name: string, html: string, template: Palettes): string[] {
  const page = palettes(html);
  const problems: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    for (const [token, value] of template[theme]) {
      const got = page[theme].get(token);
      if (got === undefined) problems.push(`${name}: ${theme} palette lacks ${token}`);
      else if (got !== value) problems.push(`${name}: ${theme} ${token} is ${got}, the standard is ${value}`);
    }
  }
  return problems;
}

/** A color written as a literal anywhere but a token block: a hex, rgb(), rgba(), hsl() or hsla() inside a declaration. */
function literalProblems(name: string, html: string): string[] {
  const css = styleOf(html)
    .replace(/:root[^{]*\{[^}]*\}/g, "")
    .replace(/@media[^{]*\{\s*\}/g, "");
  const found = new Set<string>();
  for (const body of css.matchAll(/\{([^{}]*)\}/g)) {
    for (const m of body[1].matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g)) found.add(m[0]);
  }
  return [...found].map((c) => `${name}: color literal ${c} outside the token blocks`);
}

/** The fonts the page loads, and nothing else loaded from outside. */
function loadProblems(name: string, html: string): string[] {
  const problems: string[] = [];
  const link = html.match(/<link[^>]+fonts\.googleapis\.com\/css2[^>]*>/)?.[0] ?? "";
  for (const f of FONTS) if (!link.includes(f)) problems.push(`${name}: the font link lacks ${f}`);
  if (/<script[^>]+src=/.test(html)) problems.push(`${name}: loads a script from outside`);
  for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
    if (!/^https:\/\/fonts\.(googleapis|gstatic)\.com/.test(m[1])) problems.push(`${name}: loads ${m[1]}`);
  }
  if (!styleOf(html).includes("prefers-reduced-motion")) problems.push(`${name}: has no prefers-reduced-motion rule`);
  return problems;
}

/** The atlas shares the shared tokens, by value, in both themes. Its fonts and layout are its own. */
function sharedProblems(name: string, html: string, template: Palettes): string[] {
  const page = palettes(html);
  const problems: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    for (const token of SHARED) {
      const want = template[theme].get(`--${token}`);
      const got = page[theme].get(`--${token}`);
      if (want !== undefined && got !== want) problems.push(`${name}: ${theme} --${token} is ${got ?? "missing"}, the standard is ${want}`);
    }
  }
  return problems;
}

/** The docs site declares the same values for the shared tokens, in its own two-block layout. */
function themeProblems(css: string, template: Palettes): string[] {
  const problems: string[] = [];
  const flat = squash(css);
  for (const theme of ["light", "dark"] as const) {
    for (const token of SHARED.filter((t) => t !== "shadow")) {
      const want = template[theme].get(`--${token}`);
      if (want !== undefined && !flat.includes(`--${token}: ${want}`)) problems.push(`${SITE_THEME}: ${theme} --${token} ${want} is not declared`);
    }
  }
  return problems;
}

describe("marketing pages", () => {
  const template = palettes(read(TEMPLATE));
  const pages = existsSync(join(ROOT, "demo"))
    ? readdirSync(join(ROOT, "demo")).filter((f) => f.endsWith(".html")).map((f) => `demo/${f}`)
    : [];

  it("has a template whose two themes declare every shared token", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const token of SHARED) expect(template[theme].has(`--${token}`), `${theme} --${token}`).toBe(true);
    }
  });

  it("keeps the template itself clean", () => {
    const html = read(TEMPLATE);
    expect([...literalProblems(TEMPLATE, html), ...loadProblems(TEMPLATE, html)]).toEqual([]);
  });

  for (const page of pages) {
    it(`${page} carries the standard's tokens, fonts and no colors of its own`, () => {
      const html = read(page);
      expect([...tokenProblems(page, html, template), ...literalProblems(page, html), ...loadProblems(page, html)]).toEqual([]);
    });
  }

  it("keeps the atlas on the shared palette and fonts", () => {
    const html = read(ATLAS);
    expect(sharedProblems(ATLAS, html, template)).toEqual([]);
    const link = html.match(/<link[^>]+fonts\.googleapis\.com\/css2[^>]*>/)?.[0] ?? "";
    for (const f of FONTS) expect(link, f).toContain(f);
  });

  it("keeps the docs site's theme on the shared palette", () => {
    expect(themeProblems(read(SITE_THEME), template)).toEqual([]);
  });

  describe("the checks themselves", () => {
    const good = read(TEMPLATE);
    it("flags a token whose value moved, and one that is missing", () => {
      const moved = good.replace(/--accent: #2F4BFF;/i, "--accent: #123456;");
      expect(tokenProblems("a.html", moved, template).join("\n")).toContain("light --accent is #123456");
      const gone = good.replace(/--sunk: #E9EDF4;/i, "");
      expect(tokenProblems("b.html", gone, template).join("\n")).toContain("lacks --sunk");
    });
    it("flags a color literal in a rule and leaves the token blocks alone", () => {
      expect(literalProblems("c.html", good)).toEqual([]);
      const bad = good.replace("</style>", ".x { color: #ff0000; background: rgba(0, 0, 0, .5); }\n</style>");
      expect(literalProblems("c.html", bad)).toEqual(["c.html: color literal #ff0000 outside the token blocks", "c.html: color literal rgba( outside the token blocks"]);
    });
    it("flags an outside script, an outside stylesheet, a missing font and no reduced-motion rule", () => {
      expect(loadProblems("d.html", good.replace("</head>", '<script src="https://cdn.example/x.js"></script></head>'))).toContain("d.html: loads a script from outside");
      expect(loadProblems("e.html", good.replace("</head>", '<link rel="stylesheet" href="https://cdn.example/x.css"></head>'))).toContain("e.html: loads https://cdn.example/x.css");
      expect(loadProblems("f.html", good.replace("Hanken+Grotesk", "Other"))).toContain("f.html: the font link lacks Hanken+Grotesk");
      expect(loadProblems("g.html", good.replace("prefers-reduced-motion", "prefers-x"))).toContain("g.html: has no prefers-reduced-motion rule");
    });
    it("flags a shared token that moved in the atlas or the site's theme", () => {
      expect(sharedProblems("atlas", "<style>:root{--bg:#000000;}</style>", template).length).toBeGreaterThan(0);
      expect(themeProblems("--bg: #000000;", template).length).toBeGreaterThan(0);
    });
  });
});
