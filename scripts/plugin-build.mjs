#!/usr/bin/env node
// Builds the folder a harness's plugin is installed and zipped from (#927): dist/<harness>/.
//
//   node scripts/plugin-build.mjs [claudecode] [opencode] [--out <dir>] [--with-tests] [--check]
//
// Why a build at all: a plugin installed from a marketplace (git-subdir) is only its own folder, and an import that leaves that
// folder is refused. The source keeps each harness in plugin/<harness>/ and the code every harness shares in plugin/core/, with
// imports such as `../../core/git.ts`. The build lays the source tree out under the plugin's folder with no import rewritten:
//
//   dist/claudecode/
//     .claude-plugin/plugin.json      the manifest
//     types/                          the plugin API declarations the manifest names
//     hooks/hooks.json                generated: its `modules` entry points at the real register module in the tree below
//     hooks/helper.mjs                the TLS helper, where the mod looks for it (`$.plugin.root/hooks/helper.mjs`)
//     plugin/claudecode/**            the harness's own source
//     plugin/core/**                  the shared source
//
// The build then checks that the folder is self-contained (checkTree) and refuses to finish when it is not. The same bytes come
// from the same source tree: files are written in name order with a fixed mode and no timestamp. Only node builtins are used.
// podium-reporter-zip.mjs zips what this builds, and `npm run test:mod` builds with --with-tests to .build-test/ for
// `claude plugin test`.
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage: node scripts/plugin-build.mjs [claudecode] [opencode] [--out <dir>] [--with-tests] [--check]

Builds dist/<harness>/ for each harness named: the folder a plugin is installed and zipped from.
  <harness>      claudecode or opencode. With none named, every harness that has a .claude-plugin/plugin.json
                 (opencode has none yet, so it is skipped unless named; naming it then fails).
  --out <dir>    where to build (default: dist/ in the repo). The harness's folder is <dir>/<harness>/ and is replaced.
  --with-tests   keep the *.test.ts files, so \`claude plugin test <dir>/<harness>\` can run them (npm run test:mod).
  --check        build nothing; only run the self-containment check on the existing <out>/<harness>/ folders.
  -h, --help     this text.
Left out: *.test.ts (unless --with-tests), .DS_Store, node_modules, tsconfig.json and the types the typecheck script lays in
.claude-plugin/types/. The build fails on a symlink, an import that leaves the folder or names a missing file, a missing
plugin.json, and a hooks/hooks.json whose modules do not exist inside the folder.`;

/** The harnesses and where their source lives. Shared code is plugin/core, copied into every harness's tree. */
export const HARNESSES = ["claudecode", "opencode"];

const CODE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(["node_modules"]);

/** Whether a source file ships. */
export function included(rel, withTests = false) {
  const name = rel.split("/").at(-1);
  if (name === ".DS_Store") return false;
  if (!withTests && name.endsWith(".test.ts")) return false;
  return true;
}

/** Every file under `dir` as a path relative to it with forward slashes, in name order. Throws on a symlink. */
export function walk(dir, rel = "") {
  const out = [];
  const entries = readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new Error(`${join(dir, r)} is a symlink; a plugin folder must hold real files only.`);
    if (e.isDirectory()) {
      if (!SKIPPED_DIRS.has(e.name)) out.push(...walk(dir, r));
    } else out.push(r);
  }
  return out;
}

/** The files of `harness`'s built tree: a Map from path inside the tree to bytes, sorted by path. */
export function planTree(harness, { root = ROOT, withTests = false } = {}) {
  if (!HARNESSES.includes(harness)) throw new Error(`Unknown harness "${harness}". Known: ${HARNESSES.join(", ")}.`);
  const src = join(root, "plugin", harness);
  if (!existsSync(join(src, ".claude-plugin", "plugin.json"))) {
    throw new Error(`plugin/${harness} has no .claude-plugin/plugin.json, so there is nothing to build for ${harness}.`);
  }
  const files = new Map();
  const put = (name, data) => files.set(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
  const nested = (prefix, dir, skip = () => false) => {
    for (const rel of walk(dir)) {
      if (included(rel, withTests) && !skip(rel)) put(`${prefix}/${rel}`, readFileSync(join(dir, rel)));
    }
  };

  // The harness's own files: manifest and types at the root, the rest where the source has them under plugin/<harness>/.
  const top = (rel) => rel === ".claude-plugin/plugin.json" || rel.startsWith("types/");
  for (const rel of walk(src)) {
    if (!included(rel, withTests)) continue;
    if (rel.startsWith(".claude-plugin/types/") || rel === "tsconfig.json") continue; // laid by the typecheck script / dev only
    if (rel === "hooks/hooks.json" || rel === "hooks/helper.mjs") continue; // handled below
    const bytes = readFileSync(join(src, rel));
    put(top(rel) ? rel : `plugin/${harness}/${rel}`, bytes);
  }

  // hooks/helper.mjs is run by path from the plugin's root, so it sits at the root's hooks/. It imports nothing of the tree.
  const helper = join(src, "hooks", "helper.mjs");
  if (existsSync(helper)) put("hooks/helper.mjs", readFileSync(helper));

  // hooks/hooks.json: the source's modules, repointed from the source's hooks/ to the same files under plugin/<harness>/hooks/.
  const hooksJson = join(src, "hooks", "hooks.json");
  if (existsSync(hooksJson)) {
    const source = JSON.parse(readFileSync(hooksJson, "utf8"));
    const modules = (source.modules ?? []).map((m) => {
      const inTree = posix.join("plugin", harness, "hooks", m);
      return posix.relative("hooks", inTree);
    });
    put("hooks/hooks.json", `${JSON.stringify({ ...source, modules }, null, 2)}\n`);
  }

  if (existsSync(join(root, "plugin", "core"))) nested("plugin/core", join(root, "plugin", "core"));

  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Every relative module specifier a source file names (static import and export-from, side-effect import, import("literal")). */
export function relativeSpecifiers(text) {
  const found = new Set();
  const patterns = [
    /^[ \t]*(?:import|export)\s[^'";]*?\bfrom\s*['"](\.{1,2}(?:\/[^'"]*)?)['"]/gm,
    /^[ \t]*import\s*['"](\.{1,2}(?:\/[^'"]*)?)['"]/gm,
    /\bimport\s*\(\s*['"](\.{1,2}(?:\/[^'"]*)?)['"]\s*\)/g,
  ];
  for (const p of patterns) for (const m of text.matchAll(p)) found.add(m[1]);
  return [...found];
}

/** The file inside `dir` that `spec` names from `fromRel` (a file in the tree), or null when none exists. */
function resolveSpecifier(dir, fromRel, spec) {
  const base = posix.join(posix.dirname(fromRel), spec);
  if (base.startsWith("../") || base === "..") return { outside: true, target: base };
  for (const candidate of [base, ...[".ts", ".mts", ".js", ".mjs", ".cjs", ".json"].map((e) => base + e), ...["index.ts", "index.js", "index.mjs"].map((i) => `${base}/${i}`)]) {
    const p = join(dir, ...candidate.split("/"));
    if (existsSync(p) && lstatSync(p).isFile()) return { outside: false, target: candidate };
  }
  return { outside: false, target: null, wanted: base };
}

/** Problems with the built folder `dir`: empty when it is self-contained and complete. */
export function checkTree(dir) {
  const problems = [];
  if (!existsSync(dir)) return [`${dir} does not exist; run node scripts/plugin-build.mjs first.`];
  let files;
  try {
    files = walk(dir);
  } catch (e) {
    return [e.message];
  }
  // A symlink can also be a dangling one that readdir lists as a link; walk() throws on every link, so only real files remain.
  if (!files.includes(".claude-plugin/plugin.json")) problems.push(".claude-plugin/plugin.json is missing.");
  else {
    try {
      const m = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
      if (typeof m.version !== "string") problems.push(".claude-plugin/plugin.json has no version.");
    } catch {
      problems.push(".claude-plugin/plugin.json is not valid JSON.");
    }
  }
  if (files.includes("hooks/hooks.json")) {
    let modules;
    let valid = true;
    try {
      modules = JSON.parse(readFileSync(join(dir, "hooks", "hooks.json"), "utf8")).modules;
    } catch {
      valid = false;
      problems.push("hooks/hooks.json is not valid JSON.");
    }
    if (valid) {
      if (!Array.isArray(modules) || modules.length === 0 || modules.some((m) => typeof m !== "string")) {
        problems.push("hooks/hooks.json needs a non-empty modules array of strings.");
      } else {
        for (const m of modules) {
          const target = posix.join("hooks", m);
          if (target.startsWith("../")) problems.push(`hooks/hooks.json module ${m} leaves the plugin's folder.`);
          else if (!existsSync(join(dir, ...target.split("/"))) || !lstatSync(join(dir, ...target.split("/"))).isFile()) {
            problems.push(`hooks/hooks.json module ${m} does not exist in the folder.`);
          }
        }
      }
    }
  } else problems.push("hooks/hooks.json is missing.");
  for (const rel of files.filter((f) => CODE.test(f))) {
    for (const spec of relativeSpecifiers(readFileSync(join(dir, ...rel.split("/")), "utf8"))) {
      const r = resolveSpecifier(dir, rel, spec);
      if (r.outside) problems.push(`${rel} imports ${spec}, which leaves the plugin's folder.`);
      else if (!r.target) problems.push(`${rel} imports ${spec}, but ${r.wanted} is not in the folder.`);
    }
  }
  return problems;
}

/** Builds `harness` into `<outDir>/<harness>/` (replacing it), checks it, and returns the folder and its files. Throws on a problem. */
export function buildHarness(harness, { root = ROOT, outDir = join(root, "dist"), withTests = false } = {}) {
  const files = planTree(harness, { root, withTests });
  const dir = resolve(outDir, harness);
  rmSync(dir, { recursive: true, force: true });
  for (const [name, data] of files) {
    const p = join(dir, ...name.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data, { mode: 0o644 });
  }
  const problems = checkTree(dir);
  if (problems.length) {
    throw new Error(`The ${harness} build is not self-contained:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return { dir, files: [...files.keys()] };
}

/** Harnesses to build when none is named: those with a plugin.json. */
export function defaultHarnesses(root = ROOT) {
  return HARNESSES.filter((h) => existsSync(join(root, "plugin", h, ".claude-plugin", "plugin.json")));
}

/** Runs the command line `args`; returns the exit code and what to print to stdout and stderr. */
export function run(args, root = ROOT) {
  if (args.includes("--help") || args.includes("-h")) return { code: 0, out: USAGE };
  const named = [];
  let outDir = join(root, "dist");
  let withTests = false;
  let checkOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) return { code: 1, err: `--out needs a value.\n\n${USAGE}` };
      outDir = resolve(v);
    } else if (a === "--with-tests") withTests = true;
    else if (a === "--check") checkOnly = true;
    else if (HARNESSES.includes(a)) named.push(a);
    else return { code: 1, err: `Unknown argument "${a}".\n\n${USAGE}` };
  }
  const harnesses = named.length ? named : defaultHarnesses(root);
  if (harnesses.length === 0) return { code: 1, err: "No harness has a .claude-plugin/plugin.json; nothing to build." };
  const out = [];
  try {
    for (const h of harnesses) {
      if (checkOnly) {
        const problems = checkTree(resolve(outDir, h));
        if (problems.length) return { code: 1, err: `The ${h} folder is not self-contained:\n${problems.map((p) => `  - ${p}`).join("\n")}` };
        out.push(`${h}: self-contained (${relative(process.cwd(), resolve(outDir, h)) || "."})`);
      } else {
        const r = buildHarness(h, { root, outDir, withTests });
        out.push(`${h}: ${r.files.length} files in ${r.dir.split(sep).join("/")}`);
      }
    }
  } catch (e) {
    return { code: 1, err: e.message };
  }
  return { code: 0, out: out.join("\n") };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, out, err } = run(process.argv.slice(2));
  if (out) console.log(out);
  if (err) console.error(err);
  process.exitCode = code;
}
