#!/usr/bin/env -S npx tsx
// Lists everything the Podium UI is made of: tokens, classes, components, color literals (#354).
// The guard, the parity test and the standards audit all read this, so they agree on what "the app has".
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `standards-inventory: list the tokens, classes, components and color literals of the Podium UI.

Usage: npx tsx scripts/standards-inventory.ts [options]

Reads frontend/src/fleet: tokens.css, fleet.css, admin/admin.css and every non-test .tsx file.
Prints the counts of what it found. With --json, prints the full inventory:
  tokens       each block in tokens.css (selector, media or not, token name and value)
  classes      every class selector in fleet.css and admin.css
  components   every non-test .tsx file under components/ and admin/, and the top-level views
  literals     every hex, rgb or hsl color written outside tokens.css, with file and line
  undefined    custom properties used with var() that nothing defines

Options:
  --json    Print the full inventory as JSON
  -h, --help
Always exits 0; the tests (scripts/standards-guard.test.ts) decide what fails.`;

const HERE = dirname(fileURLToPath(import.meta.url));
export const FLEET_DIR = join(HERE, "..", "frontend", "src", "fleet");

export interface Hit {
  line: number;
  text: string;
}

/** Text with block comments and line comments blanked out. Newlines stay, so a line number still points at the right line. */
export function stripComments(text: string): string {
  const blank = (m: string) => m.replaceAll(/[^\n]/g, "");
  // A // only starts a comment at the start of a line or after a space, never inside http://.
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, blank).replaceAll(/(^|[\s;{}])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/**
 * Color values written as a literal: hex, rgb(a) and hsl(a). In CSS any #hex counts. In TSX only a quoted "#hex" does,
 * because a link such as "#/admin" or "#top" is not a color.
 */
export function colorLiterals(text: string, kind: "css" | "tsx" = "css"): Hit[] {
  const t = stripComments(text);
  const hex = kind === "css" ? /(?<![\w&#])#[0-9a-fA-F]{3,8}\b/g : /(?<=["'`])#[0-9a-fA-F]{3,8}(?=["'`])/g;
  const fn = /\b(?:rgba?|hsla?)\([^)]*\)/g;
  const hits: Hit[] = [];
  for (const re of [hex, fn]) for (const m of t.matchAll(re)) hits.push({ line: lineOf(t, m.index), text: m[0] });
  return hits.sort((a, b) => a.line - b.line || t.split("\n")[a.line - 1].indexOf(a.text) - t.split("\n")[b.line - 1].indexOf(b.text));
}

/** Names of custom properties a stylesheet or a TSX file sets, such as `x` for `--x: 1px` or `["--c" as string]`. */
export function customPropDefs(text: string): Set<string> {
  const t = stripComments(text);
  const out = new Set<string>();
  for (const m of t.matchAll(/(?<![\w-])--([a-zA-Z0-9-]+)\s*:/g)) out.add(m[1]);
  for (const m of t.matchAll(/["']--([a-zA-Z0-9-]+)["']/g)) out.add(m[1]);
  return out;
}

/** Names of custom properties read with var(). */
export function customPropUses(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripComments(text).matchAll(/var\(\s*--([a-zA-Z0-9-]+)/g)) out.add(m[1]);
  return out;
}

/** Every class a stylesheet's selectors name. Declarations are dropped first, so `url(a.png)` is not read as a class, and a class must start with a letter, so `1.5px` is not either. */
export function classNames(css: string): Set<string> {
  let t = stripComments(css);
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replaceAll(/\{[^{}]*\}/g, "{}");
  }
  const out = new Set<string>();
  for (const m of t.matchAll(/(?<!\d)\.([a-zA-Z_][\w-]*)/g)) out.add(m[1]);
  return out;
}

export interface TokenBlock {
  selector: string;
  inMedia: boolean;
  tokens: Record<string, string>;
}

/** The blocks of tokens.css that set at least one token, each with its selector (whitespace collapsed) and its token values. */
export function tokenBlocks(css: string): TokenBlock[] {
  const t = stripComments(css);
  const out: TokenBlock[] = [];
  for (const m of t.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const tokens: Record<string, string> = {};
    for (const d of m[2].matchAll(/--([a-zA-Z0-9-]+)\s*:([^;]+);/g)) tokens[d[1]] = d[2].trim();
    if (!Object.keys(tokens).length) continue;
    const before = t.slice(0, m.index);
    out.push({ selector: m[1].trim().replaceAll(/\s+/g, " "), inMedia: before.split("{").length - before.split("}").length > 0, tokens });
  }
  return out;
}

function walk(dir: string, keep: (f: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), keep) : keep(e.name) ? [join(dir, e.name)] : []))
    .sort();
}

export interface Inventory {
  tokens: TokenBlock[];
  classes: string[];
  components: string[];
  literals: Array<{ file: string; line: number; text: string }>;
  undefined: string[];
}

/** Reads the app and returns what it has. `dir` is frontend/src/fleet, or a copy of it in a test. */
export function inventory(dir: string = FLEET_DIR): Inventory {
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  const css = { "tokens.css": read("tokens.css"), "fleet.css": read("fleet.css"), "admin/admin.css": read("admin/admin.css") };
  const tsx = walk(dir, (f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx")).map((f) => relative(dir, f));
  const tsxText = Object.fromEntries(tsx.map((f) => [f, read(f)]));

  const literals: Inventory["literals"] = [];
  for (const [f, text] of Object.entries(css)) if (f !== "tokens.css") for (const h of colorLiterals(text)) literals.push({ file: f, ...h });
  for (const [f, text] of Object.entries(tsxText)) for (const h of colorLiterals(text, "tsx")) literals.push({ file: f, ...h });

  const defs = new Set<string>();
  const uses = new Set<string>();
  for (const text of [...Object.values(css), ...Object.values(tsxText)]) {
    for (const n of customPropDefs(text)) defs.add(n);
    for (const n of customPropUses(text)) uses.add(n);
  }
  const classes = new Set<string>();
  for (const f of ["fleet.css", "admin/admin.css"] as const) for (const c of classNames(css[f])) classes.add(c);

  return {
    tokens: tokenBlocks(css["tokens.css"]),
    classes: [...classes].sort(),
    components: tsx.filter((f) => f.startsWith("components/") || f.startsWith("admin/") || !f.includes("/")),
    literals,
    undefined: [...uses].filter((n) => !defs.has(n)).sort(),
  };
}

export interface Deferred {
  file: string;
  text: string;
  count: number;
  reason: string;
}

/**
 * Compares the color literals found against the deferred list. Returns one message per problem: a literal that is not
 * listed (a new hard-coded color), a listed one found more or fewer times, or an entry with no reason.
 */
export function literalProblems(found: Inventory["literals"], deferred: Deferred[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const l of found) seen.set(`${l.file} ${l.text}`, (seen.get(`${l.file} ${l.text}`) ?? 0) + 1);
  for (const d of deferred) {
    const key = `${d.file} ${d.text}`;
    if (!d.reason.trim()) problems.push(`deferred entry ${key} has no reason`);
    const n = seen.get(key) ?? 0;
    if (n !== d.count) problems.push(`${key} is listed ${d.count} time(s) in docs/standards/deferred.json but found ${n} time(s)`);
    seen.delete(key);
  }
  for (const [key, n] of seen) {
    const at = found.find((l) => `${l.file} ${l.text}` === key)!;
    problems.push(`hard-coded color ${at.text} in ${at.file}:${at.line}${n > 1 ? ` (and ${n - 1} more)` : ""}: use a token from tokens.css, or list it in docs/standards/deferred.json with a reason`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
  } else {
    const inv = inventory();
    if (args.includes("--json")) console.log(JSON.stringify(inv, null, 2));
    else
      console.log(
        `token blocks: ${inv.tokens.length}\nclasses: ${inv.classes.length}\ncomponents: ${inv.components.length}\ncolor literals outside tokens.css: ${inv.literals.length}\nundefined custom properties: ${inv.undefined.length}`,
      );
  }
}
