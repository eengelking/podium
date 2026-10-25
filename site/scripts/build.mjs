#!/usr/bin/env node
// Builds the docs site (#688): one Starlight build per version, put together into one folder. The newest version is built from the
// working tree and served at the root; each older release line from FIRST_VERSION_LINE on is built from its newest git tag and
// served at /<line>/. The newest is built first, because a build empties its output folder.
//
//   node site/scripts/build.mjs [--out <folder>] [--latest-only] [--help]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_VERSION_LINE, REPO } from "../docs-nav.mjs";
import { computeVersions, llmsTxt, prepareDocs } from "./lib.mjs";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(siteDir, "..");

export const HELP = `Usage: node site/scripts/build.mjs [--out <folder>] [--latest-only]

Builds the Podium docs site from docs/ into <folder> (default site/out): the newest version from the working tree at the root, and each
older release line from its newest git tag at /<line>/. The build fails on a broken internal link.

  --out <folder>   where the site is written
  --latest-only    build only the newest version (a quick preview; no tags are read)
  -h, --help       show this help

Preview a build with: python3 -m http.server -d site/out`;

function git(args, opts = {}) {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", ...opts });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

/** Writes the docs folder of a tag into a fresh temporary folder and returns its path. */
function extractDocs(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "podium-docs-"));
  // docs/ and the app's stylesheets, which the standards pages load. A very old release may lack the stylesheets' folder.
  let archive = spawnSync("git", ["archive", ref, "docs", "frontend/src/fleet"], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) archive = spawnSync("git", ["archive", ref, "docs"], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive ${ref} failed: ${archive.stderr}`);
  const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
  return dir;
}

function buildOne(version, versions, outRoot) {
  const older = version.ref !== null;
  const tmp = older ? extractDocs(version.ref) : null;
  try {
    const { pages } = prepareDocs({
      docsDir: path.join(tmp ?? repoRoot, "docs"),
      rootDir: tmp ?? repoRoot,
      contentDir: path.join(siteDir, "src/content/docs"),
      publicDir: path.join(siteDir, "public"),
      base: version.base,
      ref: version.ref ?? "main",
      editBase: older ? "" : `https://github.com/${REPO}/edit/development/`,
      older,
      lastUpdatedOf: (file) => git(["log", "-1", "--format=%cs", version.ref ?? "HEAD", "--", `docs/${file}`]).trim() || undefined,
    });
    const llms = path.join(siteDir, "public/llms.txt");
    if (older) fs.rmSync(llms, { force: true });
    else fs.writeFileSync(llms, llmsTxt(pages));
    for (const dir of [path.join(siteDir, ".astro"), path.join(siteDir, "node_modules/.astro")]) fs.rmSync(dir, { recursive: true, force: true });
    const out = older ? path.join(outRoot, version.line) : outRoot;
    console.log(`\n== Building ${version.label}${older ? ` from ${version.ref}` : " from the working tree"} into ${out}`);
    const res = spawnSync(process.execPath, [path.join(siteDir, "node_modules/astro/bin/astro.mjs"), "build"], {
      cwd: siteDir,
      stdio: "inherit",
      env: {
        ...process.env,
        DOCS_BASE: version.base,
        DOCS_OUT: out,
        DOCS_CURRENT: version.line,
        DOCS_REF: version.ref ?? "",
        DOCS_VERSIONS: JSON.stringify(versions),
        // What this version has: an older release may lack a page or a folder the newest one has.
        DOCS_PAGES: JSON.stringify(pages.map((p) => p.slug)),
      },
    });
    if (res.status !== 0) throw new Error(`The build of ${version.label} failed.`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  const outArg = argv.indexOf("--out");
  if (outArg !== -1 && !argv[outArg + 1]) throw new Error("--out needs a folder.");
  const outRoot = path.resolve(outArg === -1 ? path.join(siteDir, "out") : argv[outArg + 1]);
  const headVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
  const latestOnly = argv.includes("--latest-only");
  const tags = latestOnly ? [] : git(["tag", "--list", "v*"]).split("\n").filter(Boolean);
  const versions = computeVersions({ tags, headVersion, firstLine: process.env.DOCS_FIRST_LINE || FIRST_VERSION_LINE });
  fs.rmSync(outRoot, { recursive: true, force: true });
  for (const v of versions) buildOne(v, versions, outRoot);
  fs.writeFileSync(path.join(outRoot, "versions.json"), JSON.stringify(versions, null, 2) + "\n");
  console.log(`\nBuilt ${versions.map((v) => v.label).join(", ")} into ${outRoot}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
