#!/usr/bin/env node
// Check relative links and #anchors in the repo's markdown docs.
// Usage: node scripts/check-doc-links.mjs [file.md ...]
// With no files, checks README.md, CONTRIBUTING.md, CHANGELOG.md and every .md under docs/ (not the generated standards, the templates, the fixtures or the images).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { slug, stripLinks, trimClosing } from "./docLinks.mjs";
import { markdownUnder } from "./docTopics.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/check-doc-links.mjs [file.md ...]\nChecks relative links and #anchors; exits 1 if any is broken.");
  process.exit(0);
}
const files = args.length ? args : ["README.md", "CONTRIBUTING.md", "CHANGELOG.md", ...(existsSync("docs") ? markdownUnder("docs") : [])].filter((f) => existsSync(f));

const anchors = (path) => {
  const seen = new Map();
  const out = new Set();
  let fence = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence && line.match(/^#{1,6}\s+(.*)/);
    if (!m) continue;
    // Closing hashes and the space before them are not part of the heading text.
    const s = slug(stripLinks(trimClosing(m[1])));
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    out.add(n ? `${s}-${n}` : s);
  }
  return out;
};

const cache = new Map();
let bad = 0;
for (const file of files) {
  let fence = false;
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (/^```/.test(line)) fence = !fence;
    if (fence) return;
    const text = line.replace(/`[^`]*`/g, "");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const [target, frag] = m[1].split("#");
      if (/^[a-z]+:/i.test(target)) continue;
      const path = target ? resolve(dirname(file), target) : resolve(file);
      if (!existsSync(path)) {
        console.log(`${file}:${i + 1}: missing file ${m[1]}`);
        bad++;
        continue;
      }
      if (frag && path.endsWith(".md")) {
        if (!cache.has(path)) cache.set(path, anchors(path));
        if (!cache.get(path).has(frag)) {
          console.log(`${file}:${i + 1}: no anchor ${m[1]}`);
          bad++;
        }
      }
    }
  });
}
console.log(bad ? `${bad} broken link(s)` : "all links ok");
process.exit(bad ? 1 : 0);
