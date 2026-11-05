#!/usr/bin/env node
// Check docs/DEPRECATIONS.md against the version in package.json. A feature is removed within three minor releases of the one that
// announced it, and a release does not go out with a removal still listed as pending. The check reads the "Deprecated now" table.
// Usage: node scripts/check-deprecations.mjs [--root <repo folder>]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Usage: node scripts/check-deprecations.mjs [--root <repo folder>]
Reads the "Deprecated now" table in docs/DEPRECATIONS.md (Feature, Announced, Removed, Use instead) and the version in package.json.
Fails (exit 1) when a row's Announced or Removed is not MAJOR.MINOR, when Removed is not after Announced or is more than three minor
releases later (or in another major), and when Removed is at or before the current version, because that removal is due and the
feature must be gone and its row moved to "Removed".`;

export const MAX_MINORS = 3;
const VERSION = /^(\d+)\.(\d+)$/;

/** `"1.5"` as `[1, 5]`, or null when it is not MAJOR.MINOR. */
const parse = (s) => {
  const m = VERSION.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
};

/** The rows of the "Deprecated now" table, with the line each is on. */
export function deprecatedRows(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s+Deprecated now\s*$/.test(l));
  if (start === -1) return null;
  const rows = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    if (!lines[i].startsWith("|")) continue;
    const cells = lines[i].split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 4 || cells[0] === "Feature" || /^-+$/.test(cells[0].replace(/\s/g, ""))) continue;
    rows.push({ line: i + 1, feature: cells[0], announced: cells[1], removed: cells[2] });
  }
  return rows;
}

/** The problems in the repository at `root`, as `file:line: message` lines. */
export function deprecationProblems(root) {
  const file = "docs/DEPRECATIONS.md";
  const path = join(root, file);
  if (!existsSync(path)) return [`${file}: the file is missing`];
  const rows = deprecatedRows(readFileSync(path, "utf8"));
  if (rows === null) return [`${file}: there is no "Deprecated now" section`];
  const current = parse(String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).split(".").slice(0, 2).join("."));
  const problems = [];
  for (const r of rows) {
    const at = `${file}:${r.line}`;
    const a = parse(r.announced);
    const d = parse(r.removed);
    if (!a || !d) {
      problems.push(`${at}: ${r.feature}: Announced and Removed must each be MAJOR.MINOR, such as 1.5`);
      continue;
    }
    if (d[0] !== a[0]) problems.push(`${at}: ${r.feature}: removal in ${r.removed} is in another major than ${r.announced}; the policy covers minor releases only`);
    else if (d[1] <= a[1]) problems.push(`${at}: ${r.feature}: Removed ${r.removed} must be after Announced ${r.announced}`);
    else if (d[1] - a[1] > MAX_MINORS) problems.push(`${at}: ${r.feature}: Removed ${r.removed} is more than ${MAX_MINORS} minor releases after Announced ${r.announced}`);
    if (current && (current[0] > d[0] || (current[0] === d[0] && current[1] >= d[1]))) {
      problems.push(`${at}: ${r.feature}: removal is due in ${r.removed} and the version is ${current.join(".")}; remove the feature and move its row to "Removed"`);
    }
  }
  return problems;
}

export function run(argv, cwd) {
  if (argv.includes("--help") || argv.includes("-h")) return { code: 0, out: HELP };
  const i = argv.indexOf("--root");
  const root = i === -1 ? cwd : argv[i + 1];
  const problems = deprecationProblems(root);
  return problems.length ? { code: 1, out: problems.join("\n") } : { code: 0, out: "docs/DEPRECATIONS.md agrees with the version" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, out } = run(process.argv.slice(2), process.cwd());
  console.log(out);
  process.exit(code);
}
