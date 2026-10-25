#!/usr/bin/env node
// Check the references to the docs that were split into folders (#697): every "SPEC n.n" and "DECISIONS n" citation must name
// one page that exists, and nothing may still point at the old single-file paths (their stubs are for readers outside this repo).
// Usage: node scripts/check-doc-refs.mjs [--root <repo folder>]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./docFrontmatter.mjs";

const HELP = `Usage: node scripts/check-doc-refs.mjs [--root <repo folder>]
Fails (exit 1) on a "SPEC n.n" or "DECISIONS n" citation that no page answers to, and on a reference to one of the five old
single-file pages (the SPEC, DECISIONS, GOTCHAS, ARCHITECTURE and USER_GUIDE markdown files) outside the stubs left at those
paths, CHANGELOG.md and the site's fallback for older releases.`;

const OLD_PAGES = ["SPEC", "DECISIONS", "GOTCHAS", "ARCHITECTURE", "USER_GUIDE"];
const TEXT = /\.(md|ts|tsx|mjs|js|json|ya?ml|html|css|sh|txt|toml|properties)$/;
// Files that name the old paths or bad citations on purpose: the changelog's history, the site's fallback for a release that predates the split, and the tests.
const LEGACY = new Set(["CHANGELOG.md", "site/docs-nav.mjs", "scripts/site-lib.test.ts"]);
// This check's own tests cite sections that do not exist, to prove it notices.
const FIXTURES = "scripts/check-doc-refs.test.ts";
const IGNORED = new Set(["node_modules", ".git", "out", ".astro", "dist", "coverage", "worktrees"]);
// What a local site build writes (gitignored copies of the docs made from the old names in older releases), not part of the repository.
const GENERATED = new Set(["site/public", "site/src/content"]);

/** Every text file under `root`, as paths relative to it. */
function listFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED.has(e.name) && !GENERATED.has(r)) walk(r);
      } else if (TEXT.test(e.name)) out.push(r);
    }
  };
  walk("");
  return out;
}

/** Every `.md` under docs/<dir> with its frontmatter, for the folders that hold a split topic. */
function pagesIn(root, dir) {
  const abs = join(root, "docs", dir);
  if (!existsSync(abs)) return [];
  return listFiles(abs).filter((f) => f.endsWith(".md")).map((f) => {
    const text = readFileSync(join(abs, f), "utf8");
    return { file: `docs/${dir}/${f}`, fields: parseFrontmatter(text).fields, text };
  });
}

/** The citations that can be made: section numbers of the spec, and decision numbers. */
export function knownRefs(root) {
  const sections = new Set();
  const listItems = new Map();
  for (const p of pagesIn(root, "spec")) {
    if (p.fields.section) {
      sections.add(p.fields.section);
      listItems.set(p.fields.section, new Set([...p.text.matchAll(/^(\d+)\. /gm)].map((m) => m[1])));
    }
  }
  const decisions = new Set(pagesIn(root, "decisions").map((p) => p.fields.number).filter((n) => n !== undefined && n !== ""));
  const has = (ref) => {
    if (sections.has(ref)) return true;
    const dot = ref.lastIndexOf(".");
    return dot !== -1 && (listItems.get(ref.slice(0, dot))?.has(ref.slice(dot + 1)) ?? false);
  };
  return { hasSection: has, hasDecision: (n) => decisions.has(n) };
}

/** The problems in the repository at `root`, as `file:line: message` lines. */
export function refProblems(root) {
  const known = knownRefs(root);
  const stubs = new Set(OLD_PAGES.map((n) => `docs/${n}.md`));
  const problems = [];
  for (const file of listFiles(root)) {
    if (file === FIXTURES) continue;
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      const at = `${file}:${i + 1}`;
      for (const m of line.matchAll(/\bSPEC (?:section )?(\d+(?:\.\d+)*)/g)) if (!known.hasSection(m[1])) problems.push(`${at}: SPEC ${m[1]} is not a section of docs/spec/`);
      for (const m of line.matchAll(/\bDECISIONS (\d+)\b/g)) if (!known.hasDecision(m[1])) problems.push(`${at}: DECISIONS ${m[1]} is not an entry of docs/decisions/`);
      if (stubs.has(file) || LEGACY.has(file)) return;
      for (const m of line.matchAll(/\b(SPEC|DECISIONS|GOTCHAS|ARCHITECTURE|USER_GUIDE)\.md\b/g)) problems.push(`${at}: ${m[0]} was split into a folder; point at docs/${m[1].toLowerCase().replace("_", "-")}/README.md or the page`);
    });
  }
  return problems;
}

function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  const at = argv.indexOf("--root");
  const root = at === -1 ? "." : argv[at + 1];
  if (!root || !existsSync(root)) throw new Error("The repository folder was not found.");
  const problems = refProblems(root);
  for (const p of problems) console.log(p);
  console.log(problems.length ? `${problems.length} unresolved reference(s)` : "all doc references resolve");
  return problems.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
