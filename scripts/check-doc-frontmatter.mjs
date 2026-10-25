#!/usr/bin/env node
// Check that every page in docs/ has `title`, `description` and `group` in its frontmatter (#696).
// Usage: node scripts/check-doc-frontmatter.mjs [file.md ...]
// With no files, checks every .md under docs/, so a page in a folder (#697) is checked the day it lands. docs/standards/ is
// generated and docs/templates/ holds examples with placeholders, so neither is checked.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { frontmatterProblems } from "./docFrontmatter.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/check-doc-frontmatter.mjs [file.md ...]\nChecks title, description and group in each page's frontmatter; exits 1 if any is missing or invalid.");
  process.exit(0);
}
const SKIP = new Set(["standards", "templates", "fixtures", "images"]);
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (SKIP.has(e.name) ? [] : walk(join(dir, e.name))) : e.name.endsWith(".md") ? [join(dir, e.name)] : [],
  );
const files = args.length ? args : existsSync("docs") ? walk("docs").sort() : [];

let bad = 0;
for (const file of files) {
  for (const problem of frontmatterProblems(readFileSync(file, "utf8"))) {
    console.log(`${file}: ${problem}`);
    bad++;
  }
}
console.log(bad ? `${bad} problem(s) in ${files.length} page(s)` : `all ${files.length} pages have title, description and group`);
process.exit(bad ? 1 : 0);
