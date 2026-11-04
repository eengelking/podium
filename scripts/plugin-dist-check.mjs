#!/usr/bin/env node
// Checks that the tracked dist/ is exactly what a clean build of the source produces (#983).
//
//   node scripts/plugin-dist-check.mjs
//
// dist/<harness>/ is the plugin that `eengelking-marketplace` installs, and it is tracked on `main`, which holds only finished releases.
// A hand-built or stale dist/ would ship code that differs from the source it claims to be, so this runs on every PR into `main` (ci.yml)
// and again before the release archive is built (release.yml). It builds each harness in memory with the same planTree the build uses,
// and compares the file list and the bytes with dist/. It writes nothing, so it cannot repair what it finds: rebuild with
// `npm run plugin:build:release`, which empties dist/ first, and commit the result.
//
// It also fails on a folder or file in dist/ that is no harness's build, on a dev stamp (.claude-plugin/dev-build.json), and on a built
// harness whose version is not the product's (the root package.json), which is what a release-prep PR that forgot to rebuild looks like.
// Only node builtins are used.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHarnesses, manifestVersion, planTree, walk } from "./plugin-build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = ".claude-plugin/dev-build.json";

const USAGE = `Usage: node scripts/plugin-dist-check.mjs

Fails unless dist/ holds exactly what a clean build of plugin/ produces: the same files with the same bytes, one folder per harness,
no dev stamp, and every harness at the product version (package.json). Writes nothing. To fix a failure run
\`npm run plugin:build:release\` (it empties dist/ first) and commit dist/.
  -h, --help  this text.`;

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The product version in `root`'s package.json, or null when there is none to compare with. */
function productVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** The problems with one harness's folder `dir` against the clean build `built` (a Map of path to bytes). */
function checkHarness(harness, dir, built, product) {
  const label = `dist/${harness}`;
  // A Finder's .DS_Store is never part of a build (included() drops it), so a local run does not fail on one.
  const have = new Map(walk(dir).filter((f) => !f.endsWith(".DS_Store")).map((f) => [f, readFileSync(join(dir, ...f.split("/")))]));
  const problems = [];
  if (have.has(STAMP)) problems.push(`${label}: ${STAMP} is a dev stamp and must never be committed; rebuild with npm run plugin:build:release`);
  for (const [name, data] of built) {
    if (!have.has(name)) problems.push(`${label}: missing from dist/: ${name}`);
    else if (!data.equals(have.get(name))) problems.push(`${label}: different bytes: ${name}`);
  }
  for (const name of [...have.keys()].sort(byName)) {
    if (!built.has(name) && name !== STAMP) problems.push(`${label}: only in dist/: ${name}`);
  }
  const version = manifestVersion(dir, harness);
  if (product && version !== product) problems.push(`${label}: version ${version ?? "(none)"} is not the product version ${product}`);
  return problems;
}

/** The problems with the tracked dist/ of the checkout at `root`: an empty list when it is exactly the clean build. */
export function checkDist(root = ROOT) {
  const dist = join(root, "dist");
  if (!existsSync(dist)) return ["dist/ does not exist. Run npm run plugin:build:release and commit dist/."];
  const harnesses = defaultHarnesses(root);
  const problems = readdirSync(dist)
    .sort(byName)
    .filter((name) => !harnesses.includes(name))
    .map((name) => `dist/${name}: not a built harness; remove it`);
  const product = productVersion(root);
  for (const harness of harnesses) {
    const dir = join(dist, harness);
    if (!existsSync(dir)) {
      problems.push(`dist/${harness}: missing. Run npm run plugin:build:release and commit dist/.`);
      continue;
    }
    try {
      problems.push(...checkHarness(harness, dir, planTree(harness, { root }), product));
    } catch (e) {
      problems.push(`dist/${harness}: ${e.message}`);
    }
  }
  return problems;
}

/** Runs the command line `args`; returns the exit code and what to print to stdout and stderr. */
export function run(args, root = ROOT) {
  if (args.includes("--help") || args.includes("-h")) return { code: 0, out: USAGE };
  if (args.length > 0) return { code: 1, err: `Unknown argument "${args[0]}".\n\n${USAGE}` };
  const problems = checkDist(root);
  if (problems.length) {
    return { code: 1, err: `dist/ is not what a clean build of the source produces:\n${problems.map((p) => `  - ${p}`).join("\n")}\nRun npm run plugin:build:release (it empties dist/ first) and commit dist/.` };
  }
  return { code: 0, out: `dist/ matches a clean build: ${defaultHarnesses(root).join(", ")}.` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, out, err } = run(process.argv.slice(2));
  if (out) console.log(out);
  if (err) console.error(err);
  process.exitCode = code;
}
