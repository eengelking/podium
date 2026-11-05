#!/usr/bin/env node
// Builds a harness's plugin and runs the harness with it loaded, so a developer never loads the source folder (#927).
//
//   node scripts/plugin-dev.mjs <harness> [--watch] [-- <args for the harness>]
//   node scripts/plugin-dev.mjs cleanup [<harness>]
//
// Why: plugin/claudecode cannot be loaded on its own. Its hooks import ../../core/, outside the plugin folder, and Claude Code refuses
// that. The folder it can load is the build, dist-dev/claudecode/ (scripts/plugin-build.mjs; dist/ is tracked and holds only the release
// build, #983). This script builds it with the dev stamp, the same as `npm run plugin:build`, and starts the harness against it. With --watch it rebuilds into the same folder when the source
// changes; the session then needs /reload-plugins. Adding a harness is one entry in HARNESS_TABLE. Only node builtins are used.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, rmSync, statSync, watch as fsWatch } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitBin } from "./git-bin.mjs";
import { buildHarness, DEV_OUT, readIfPresent } from "./plugin-build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEBOUNCE_MS = 300;

const USAGE = `Usage: node scripts/plugin-dev.mjs <harness> [--watch] [-- <args for the harness>]
       node scripts/plugin-dev.mjs cleanup [<harness>]

Builds the harness's plugin into dist-dev/<harness>/ with the dev stamp (the same as npm run plugin:build), then runs the harness with
that folder loaded. The source folder plugin/claudecode cannot be loaded on its own, so use this instead of --plugin-dir by hand.
  <harness>   claudecode (opencode is a stub: it exits 1 at once, and says how to build and start it; for a real OpenCode
              session against a throwaway server use scripts/podium-peers-e2e.sh --harness opencode).
  --watch     rebuild into the same folder when a file under plugin/claudecode or plugin/core changes (*.test.ts, .DS_Store and
              anything under dist/ or dist-dev/ are ignored). A failed rebuild keeps the last good build. Run /reload-plugins in the session
              after a rebuild.
  --           everything after it goes to the harness unchanged. Through npm the first -- is npm's own:
              npm run plugin:dev:claudecode -- --watch -- --model sonnet
  cleanup     remove build outputs only: dist-dev/, .build-test/ and dist-zips/, or just dist-dev/<harness>/ when one is named. It never
              touches dist/ (tracked, the release build), refuses a path git does not report as ignored, and a symlink. It stops no process.
  -h, --help  this text.
The harness's own binary is found on PATH (an absolute path, never a bare name); PODIUM_CLAUDE_BIN overrides it for claude.
The harness's exit code is this script's exit code.`;

/** The first file named `name` in a directory of `pathEnv` that `isExec` accepts; relative and empty entries are skipped. */
export function findExecutable(name, { pathEnv = process.env.PATH ?? "", override = "", isExec = isExecutableFile } = {}) {
  if (override) return isAbsolute(override) && isExec(override) ? override : null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExec(candidate)) return candidate;
  }
  return null;
}

/** Whether `path` is a regular file this process can execute. */
export function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The build of claudecode: dev-stamped into dist-dev/claudecode, and the stamp text to show. */
function buildClaudecode(root) {
  const { dir } = buildHarness("claudecode", { root, outDir: join(root, DEV_OUT), stamp: true });
  const raw = readIfPresent(join(dir, ".claude-plugin", "dev-build.json"));
  if (!raw) return "no git";
  const s = JSON.parse(raw.toString("utf8"));
  return `${s.commit}${s.dirty ? " (dirty)" : ""}`;
}

/** One entry per harness. `build(root)` returns the stamp text; `command` is how to run it; `stub` names why there is nothing to run. */
export const HARNESS_TABLE = {
  claudecode: {
    bin: "claude",
    binEnv: "PODIUM_CLAUDE_BIN",
    roots: ["plugin/claudecode", "plugin/core"],
    build: buildClaudecode,
    args: (root) => ["--plugin-dir", join(root, DEV_OUT, "claudecode")],
  },
  opencode: {
    stub: "OpenCode has no dev runner yet (it comes with its distribution, #857). Build it with `node scripts/plugin-build.mjs opencode --dev-stamp` and load dist-dev/opencode/plugin/opencode/index.ts as a plugin.",
  },
};

/** Whether a changed path (relative to a watch root, or any path) is one that must not trigger a rebuild. */
export function ignoredChange(rel) {
  if (!rel) return false;
  const parts = String(rel).split(/[\\/]/);
  const name = parts.at(-1);
  return name === ".DS_Store" || name.endsWith(".test.ts") || parts.includes("dist") || parts.includes(DEV_OUT);
}

/**
 * Debounced, serialized rebuilds. `notify(rel)` schedules a rebuild after `delay` ms of quiet; one build runs at a time, and a change
 * that arrives during a build runs one more after it. A failing build is reported and the next change builds again.
 */
export function createRebuilder({ build, log, logError, delay = DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let running = null;
  let again = false;
  let stopped = false;

  // One build, then one more when a change arrived during it (`fire` sets `again`) unless `stop` was called meanwhile. It repeats by
  // calling itself rather than looping, because both flags change from other functions while the build is awaited.
  async function runBuild() {
    again = false;
    try {
      log(`rebuilt ${DEV_OUT} at ${await build()}; run /reload-plugins in the session`);
    } catch (e) {
      logError(`rebuild failed, keeping the last good build: ${e.message}`);
    }
    if (again && !stopped) await runBuild();
  }

  function fire() {
    timer = null;
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = runBuild().finally(() => {
      running = null;
    });
  }

  return {
    notify(rel) {
      if (stopped || ignoredChange(rel)) return;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(fire, delay);
    },
    /** Resolves when no build is running. */
    idle: async () => {
      await running;
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/** Watches each directory in `dirs` recursively; calls `onChange(relativePath)`. Returns an object with close(). */
export function watchDirs(dirs, onChange, watch = fsWatch) {
  const watchers = dirs.map((d) => watch(d, { recursive: true }, (_event, name) => onChange(name ? String(name) : "")));
  return { close: () => watchers.forEach((w) => w.close()) };
}

/** Runs `bin args` with the terminal inherited; resolves to its exit code (1 when it was ended by a signal or could not start). */
export function spawnInherited(bin, args, spawnFn = spawn) {
  return new Promise((resolveCode) => {
    const child = spawnFn(bin, args, { stdio: "inherit" });
    child.on("error", () => resolveCode(1));
    child.on("exit", (code) => resolveCode(code ?? 1));
  });
}

/** Splits the command line: { harness, watch, rest } or { help } or { error }. Everything after `--` is `rest`. */
export function parseArgs(args) {
  const split = args.indexOf("--");
  const own = split === -1 ? args : args.slice(0, split);
  const rest = split === -1 ? [] : args.slice(split + 1);
  if (own.includes("--help") || own.includes("-h")) return { help: true };
  let watch = false;
  const positional = [];
  for (const a of own) {
    if (a === "--watch") watch = true;
    else if (a.startsWith("-")) return { error: `Unknown option "${a}". Arguments for the harness go after --.\n\n${USAGE}` };
    else positional.push(a);
  }
  if (positional.length === 0) return { error: `Name a harness (${Object.keys(HARNESS_TABLE).join(", ")}) or cleanup.\n\n${USAGE}` };
  if (positional[0] === "cleanup" && positional.length <= 2) return { harness: "cleanup", watch, rest, target: positional[1] };
  if (positional.length > 1) return { error: `Too many arguments: ${positional.join(" ")}.\n\n${USAGE}` };
  return { harness: positional[0], watch, rest };
}

/** Whether git ignores `rel` in `root`: true, false, or null when git cannot say. */
export function gitIgnores(root, rel, git = gitBin) {
  try {
    const r = spawnSync(git(), ["-C", root, "check-ignore", "-q", "--", rel], { encoding: "utf8" });
    if (r.status === 0) return true;
    return r.status === 1 ? false : null;
  } catch {
    return null;
  }
}

/** The build outputs in the repo root that cleanup may remove with no harness named. */
export const OUTPUT_DIRS = [DEV_OUT, ".build-test", "dist-zips"];

/**
 * Removes build outputs. Targets are fixed: the three OUTPUT_DIRS, or dist-dev/<harness> for a known harness. dist/ is tracked and never a target. Each target must exist,
 * must not be a symlink (nor sit under one) and must be reported as ignored by git, or it is refused and nothing is removed for it.
 * Returns { removed, refused } with paths relative to the root.
 */
export function cleanup(harness, { root = ROOT, isIgnored = gitIgnores, lstat = lstatSync, remove = (p) => rmSync(p, { recursive: true, force: true }) } = {}) {
  const targets = harness ? [`${DEV_OUT}/${harness}`] : OUTPUT_DIRS;
  const removed = [];
  const refused = [];
  for (const rel of targets) {
    const parts = rel.split("/");
    let exists = true;
    let why = "";
    for (let i = 1; i <= parts.length && exists && !why; i++) {
      let st;
      try {
        st = lstat(join(root, ...parts.slice(0, i)));
      } catch {
        exists = false;
        break;
      }
      if (st.isSymbolicLink()) why = "it is a symlink";
      else if (!st.isDirectory()) why = "it is not a folder";
    }
    if (!exists) continue;
    if (!why) {
      const ignored = isIgnored(root, rel);
      if (ignored === null) why = "git could not say whether it is ignored";
      else if (!ignored) why = "git does not ignore it, so it may hold tracked files";
    }
    if (why) refused.push({ path: rel, why });
    else {
      remove(join(root, ...parts));
      removed.push(rel);
    }
  }
  return { removed, refused };
}

/**
 * Runs the command line. Side effects are injectable (`deps`) so tests need no real process, file event or timer.
 * Returns the exit code.
 */
export async function run(args, deps = {}) {
  const {
    root = ROOT,
    out = (s) => console.log(s),
    err = (s) => console.error(s),
    env = process.env,
    table = HARNESS_TABLE,
    find = findExecutable,
    spawnHarness = spawnInherited,
    watchFn = watchDirs,
    rebuilderOptions = {},
    cleanupFn = cleanup,
  } = deps;
  const p = parseArgs(args);
  if (p.help) {
    out(USAGE);
    return 0;
  }
  if (p.error) {
    err(p.error);
    return 1;
  }
  const known = Object.keys(table);
  if (p.harness === "cleanup") {
    const target = p.target;
    if (target !== undefined && !known.includes(target)) {
      err(`Unknown harness "${target}". Known: ${known.join(", ")}.`);
      return 1;
    }
    const { removed, refused } = cleanupFn(target, { root });
    for (const r of refused) err(`Refused to remove ${r.path}: ${r.why}.`);
    out(removed.length ? `removed ${removed.join(", ")}` : "nothing to clean");
    return refused.length ? 1 : 0;
  }
  const entry = table[p.harness];
  if (!entry) {
    err(`Unknown harness "${p.harness}". Known: ${known.join(", ")}, cleanup.`);
    return 1;
  }
  if (entry.stub) {
    err(entry.stub);
    return 1;
  }
  const bin = find(entry.bin, { override: env[entry.binEnv] ?? "" });
  if (!bin) {
    err(`${entry.bin} not found on PATH. Install it, or set ${entry.binEnv} to its full path.`);
    return 1;
  }
  const rebuild = () => entry.build(root);
  let stamp;
  try {
    stamp = await rebuild();
  } catch (e) {
    err(`The build failed, so ${p.harness} was not started: ${e.message}`);
    return 1;
  }
  out(`built ${DEV_OUT}/${p.harness} at ${stamp}; after a rebuild run /reload-plugins in the session`);
  let watcher = null;
  let rebuilder = null;
  if (p.watch) {
    rebuilder = createRebuilder({ build: rebuild, log: out, logError: err, ...rebuilderOptions });
    watcher = watchFn(entry.roots.map((r) => join(root, r)), (rel) => rebuilder.notify(rel));
  }
  const code = await spawnHarness(bin, [...entry.args(root), ...p.rest]);
  if (watcher) {
    rebuilder.stop();
    watcher.close();
    await rebuilder.idle();
  }
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
