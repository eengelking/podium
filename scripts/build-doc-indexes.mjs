#!/usr/bin/env node
// Rebuild the generated parts of the docs that are split into folders (#697): the list of entries in each folder's README.md,
// and the previous / up / next footer on each page. Both come from the pages' frontmatter, so adding a page is adding a file.
// Usage: node scripts/build-doc-indexes.mjs [--check] [--root <docs folder>] [--only <folder under the docs folder>]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./docFrontmatter.mjs";
import { ENTRIES_END, ENTRIES_START, NAV_END, NAV_START, entriesMarkdown, navMarkdown, replaceBetween, topicDirs, topicEntries } from "./docTopics.mjs";

const HELP = `Usage: node scripts/build-doc-indexes.mjs [--check] [--root <docs folder>] [--only <folder under the docs folder>]
Rebuilds the entry list between the "entries" markers of each docs folder's README.md, and the footer between the "nav" markers of
each page in it, from the pages' frontmatter. With --only it touches that folder and the ones inside it, and nothing else. With --check
it writes nothing and exits 1 if any file is out of date.`;

/** Every change the builder would make under `root`, as `[path, newText]` pairs. */
export function pendingChanges(root, only = "") {
  // A subfolder's README is both a page of its parent (nav footer) and a README of its own (entries), so an edit to it builds on the
  // pending text and not on what is on disk, or the second edit would undo the first.
  const pending = new Map();
  const read = (path) => pending.get(path) ?? readFileSync(path, "utf8");
  const set = (path, text) => {
    if (read(path) !== text) pending.set(path, text);
  };
  for (const dir of topicDirs(root).filter((d) => !only || d === only || d.startsWith(`${only}/`))) {
    const readme = join(root, dir, "README.md");
    const text = read(readme);
    const { fields } = parseFrontmatter(text);
    const entries = topicEntries(root, dir);
    if (text.includes(ENTRIES_START)) set(readme, replaceBetween(text, ENTRIES_START, ENTRIES_END, entriesMarkdown(fields.entries, entries)));
    entries.forEach((e, i) => {
      const page = read(e.path);
      if (!page.includes(NAV_START)) return;
      // A subfolder's README sits one level down, so its neighbours are reached through the parent folder.
      const at = (j) => (entries[j] ? { fields: entries[j].fields, href: e.isFolder ? `../${entries[j].link}` : entries[j].link } : null);
      const upHref = e.isFolder ? "../README.md" : "README.md";
      const nav = navMarkdown({ prev: at(i - 1), next: at(i + 1), upTitle: fields.title }).replace("](README.md)", `](${upHref})`);
      set(e.path, replaceBetween(page, NAV_START, NAV_END, nav));
    });
  }
  return [...pending];
}

function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  const rootAt = argv.indexOf("--root");
  const root = rootAt === -1 ? "docs" : argv[rootAt + 1];
  if (!root || !existsSync(root)) throw new Error("The docs folder was not found.");
  const onlyAt = argv.indexOf("--only");
  const changes = pendingChanges(root, onlyAt === -1 ? "" : argv[onlyAt + 1].replace(/\/$/, ""));
  if (argv.includes("--check")) {
    for (const [path] of changes) console.log(`${path}: out of date, run node scripts/build-doc-indexes.mjs`);
    console.log(changes.length ? `${changes.length} file(s) out of date` : "all generated indexes are up to date");
    return changes.length ? 1 : 0;
  }
  for (const [path, text] of changes) writeFileSync(path, text);
  console.log(`${changes.length} file(s) updated`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
