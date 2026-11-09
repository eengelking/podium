#!/usr/bin/env node
// Fold the changelog fragments in changelog.d/ into the [Unreleased] section of CHANGELOG.md (DECISIONS 67).
// A PR adds a file named <issue-or-slug>.<type>.md and never edits CHANGELOG.md, so two PRs cannot conflict on it.
// Usage: node scripts/changelog-assemble.mjs [--check] [--root <folder>]
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const TYPES = ["added", "changed", "deprecated", "removed", "fixed", "standards"];
/** The Keep a Changelog headings in their order. A `standards` fragment is written under Changed. */
const HEADINGS = ["Added", "Changed", "Deprecated", "Removed", "Fixed"];
const HELP = `Usage: node scripts/changelog-assemble.mjs [--check] [--root <folder>]
Reads changelog.d/<issue-or-slug>.<type>.md (type: ${TYPES.join(", ")}) and appends each one as a bullet to the matching
"### Type" subsection of [Unreleased] in CHANGELOG.md, then deletes the file. A "standards" fragment becomes a "Standards:" bullet
under Changed. With --check it writes and deletes nothing, and exits 1 if a fragment has a bad name or is empty.
--root is the folder that holds CHANGELOG.md and changelog.d/ (default: the repository root). changelog.d/README.md is ignored.`;

/** `1066.added.md` gives `{ id: "1066", type: "added" }`; anything else gives null. */
export function parseName(file) {
  const m = /^([a-z0-9][a-z0-9-]*)\.([a-z]+)\.md$/.exec(file);
  return m && TYPES.includes(m[2]) ? { id: m[1], type: m[2] } : null;
}

/** The fragments under `dir`, in file-name order, and a list of problems. */
export function readFragments(dir) {
  const fragments = [];
  const problems = [];
  if (!existsSync(dir)) return { fragments, problems };
  for (const file of readdirSync(dir).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
    if (file === "README.md" || file.startsWith(".")) continue;
    const name = parseName(file);
    if (!name) {
      problems.push(`${file}: name it <issue-or-slug>.<type>.md with a type of ${TYPES.join(", ")}`);
      continue;
    }
    const text = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n").trim();
    if (!text) problems.push(`${file}: the fragment is empty`);
    else if (/^[-*] /.test(text)) problems.push(`${file}: write the text of the entry, without the leading "- "`);
    else fragments.push({ file, ...name, text });
  }
  return { fragments, problems };
}

function bullet(f) {
  const text = f.type === "standards" ? `Standards: ${f.text}` : f.text;
  return `- ${text.replace(/\n(?=.)/g, "\n  ")}`;
}

/** `changelog` with each fragment appended to its subsection of [Unreleased]. */
export function assemble(changelog, fragments) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => /^## \[Unreleased\]/.test(l));
  if (start < 0) throw new Error("CHANGELOG.md has no [Unreleased] section");
  for (const heading of HEADINGS) {
    const mine = fragments.filter((f) => (f.type === "standards" ? "Changed" : f.type[0].toUpperCase() + f.type.slice(1)) === heading);
    if (!mine.length) continue;
    let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    if (end < 0) end = lines.length;
    const at = lines.findIndex((l, i) => i > start && i < end && l.trimEnd() === `### ${heading}`);
    const added = mine.map(bullet);
    if (at >= 0) {
      let stop = lines.findIndex((l, i) => i > at && i < end && /^### /.test(l));
      if (stop < 0) stop = end;
      while (stop > at + 1 && lines[stop - 1].trim() === "") stop--;
      lines.splice(stop, 0, ...added);
    } else {
      // A new subsection goes before the first heading that comes later in the order, or one that is not on the list.
      const later = HEADINGS.slice(HEADINGS.indexOf(heading) + 1);
      const place = lines.findIndex((l, i) => i > start && i < end && /^### /.test(l) && (later.includes(l.slice(4)) || !HEADINGS.includes(l.slice(4))));
      if (place >= 0) lines.splice(place, 0, `### ${heading}`, "", ...added, "");
      else {
        let tail = end;
        while (tail > start + 1 && lines[tail - 1].trim() === "") tail--;
        lines.splice(tail, 0, "", `### ${heading}`, "", ...added);
      }
    }
  }
  return lines.join("\n");
}

/** The command. Returns the exit status, and writes through `out` and `err` so a test can read what it said. */
export function run(argv, out = console.log, err = console.error) {
  if (argv.includes("--help") || argv.includes("-h")) return out(HELP), 0;
  const ri = argv.indexOf("--root");
  if (ri >= 0 && !argv[ri + 1]) return err("--root needs a folder"), 1;
  const root = ri >= 0 ? argv[ri + 1] : join(fileURLToPath(import.meta.url), "../..");
  const dir = join(root, "changelog.d");
  const { fragments, problems } = readFragments(dir);
  if (problems.length) {
    for (const p of problems) err(`changelog.d/${p}`);
    return 1;
  }
  if (argv.includes("--check")) return out(`${fragments.length} fragment(s) ok`), 0;
  if (!fragments.length) return out("No fragments to assemble."), 0;
  const path = join(root, "CHANGELOG.md");
  writeFileSync(path, assemble(readFileSync(path, "utf8"), fragments));
  for (const f of fragments) rmSync(join(dir, f.file));
  out(`Assembled ${fragments.length} fragment(s) into [Unreleased].`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = run(process.argv.slice(2));
