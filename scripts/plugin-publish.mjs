#!/usr/bin/env node
// Publishes the built plugin folders (dist/<harness>/) to the `plugin-dist` branch (#927). plugin-dist.yml runs this after the
// build; a person can run it with --dry-run to see what it would do. All the logic is here and not in the workflow, because GitHub
// runs a workflow_dispatch workflow only from the default branch, so the script is the part that can be tested before a merge.
//
//   node scripts/plugin-publish.mjs --source-sha <sha> --source-ref <ref> [--remote origin] [--target plugin-dist] [--dry-run]
//
// What it does, in order, and nothing is touched until the checks pass:
//   1. refuses a source ref other than `main` or `release-candidate/*`;
//   2. checks that each built harness's plugin.json version equals the product version (root package.json);
//   3. runs the self-containment check (checkTree from plugin-build.mjs) on each built tree;
//   4. fetches the target branch (an orphan branch with no history is started when the remote has none), checks it out as a second
//      worktree in a temp folder, replaces the worktree's dist/ with the built dist/, and compares trees;
//   5. an equal tree publishes nothing; otherwise it commits on top and pushes without force.
// The checkout's index, working tree, `main` and `development` are never touched. The temp worktree is removed on success and failure.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitBin } from "./git-bin.mjs";
import { checkTree, HARNESSES, readIfPresent } from "./plugin-build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_TARGET = "plugin-dist";
const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

const USAGE = `Usage: node scripts/plugin-publish.mjs --source-sha <sha> --source-ref <ref> [options]

Publishes dist/<harness>/ (built by scripts/plugin-build.mjs) to the plugin-dist branch as one new commit on top of it.
  --source-sha <sha>   the commit the build came from (default: HEAD of the checkout). Named in the commit message.
  --source-ref <ref>   the branch the build came from. Only "main" and "release-candidate/*" may publish.
  --remote <name|url>  where to fetch from and push to (default: origin)
  --target <branch>    the branch to publish to (default: ${DEFAULT_TARGET}). Another name is for tests; main and development are refused.
  --dist <dir>         the built folder (default: <root>/dist)
  --root <dir>         the checkout (default: this repo). Its package.json gives the product version.
  --author-name <n>, --author-email <e>   the commit's author and committer (default: the Actions bot)
  --dry-run            do everything except push
  --allow-any-source-for-test   skip the source-ref rule (tests only)
  -h, --help           this text
Exit 0 with "nothing to publish" when the built tree equals the branch's tree. Never force-pushes.`;

/** Runs git in `cwd`; returns trimmed stdout and throws with git's message on failure. */
function git(cwd, args, { input } = {}) {
  const r = spawnSync(gitBin(), args, { cwd, encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r.stdout.trim();
}

/** Why `ref` may not publish, or "" when it may. */
export function sourceRefProblem(ref) {
  const name = String(ref ?? "").replace(/^refs\/heads\//, "");
  if (name === "main" || /^release-candidate\/[^/\s]+/.test(name)) return "";
  return `Source ref "${ref}" may not publish. Only main and release-candidate/* do.`;
}

/** Why `target` is not a usable branch name, or "". */
export function targetProblem(target) {
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(target) || target.includes("..") || target.endsWith("/") || target.endsWith(".lock")) {
    return `Target "${target}" is not a plain branch name.`;
  }
  if (["main", "development", "master"].includes(target)) return `Target "${target}" is refused: publishing never touches it.`;
  return "";
}

/** The built harness folders in `dist`, as names. */
function builtHarnesses(dist) {
  return HARNESSES.filter((h) => existsSync(join(dist, h)));
}

/** Everything wrong with the built folders before anything is touched: version mismatches and self-containment problems. */
export function checkBuilt(dist, version) {
  const problems = [];
  const built = builtHarnesses(dist);
  if (built.length === 0) problems.push(`${dist} holds no built harness folder; run node scripts/plugin-build.mjs first.`);
  for (const h of built) {
    const dir = join(dist, h);
    const manifest = join(dir, ".claude-plugin", "plugin.json");
    const manifestText = readIfPresent(manifest);
    if (!manifestText) {
      problems.push(`${h}: no .claude-plugin/plugin.json`);
    } else {
      const v = JSON.parse(manifestText.toString("utf8")).version;
      if (v !== version) problems.push(`${h}: plugin.json version ${v} is not the product version ${version}`);
    }
    if (existsSync(join(dir, ".claude-plugin", "dev-build.json"))) {
      problems.push(`${h}: .claude-plugin/dev-build.json is a dev stamp; rebuild without --dev-stamp: npm run plugin:build:release (npm run plugin:build adds the stamp)`);
    }
    for (const p of checkTree(dir)) problems.push(`${h}: ${p}`);
  }
  return problems;
}

/** Copies the built harness folders into `dest/dist/`: forward-slash names, no symlinks, no .DS_Store. */
function copyDist(dist, dest) {
  const walk = (src, to) => {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(src, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === ".DS_Store") continue;
      const p = join(src, e.name);
      if (e.isSymbolicLink()) throw new Error(`${p} is a symlink; the build creates none.`);
      if (e.name.includes("\\")) throw new Error(`${p} has a backslash in its name.`);
      if (e.isDirectory()) walk(p, join(to, e.name));
      else writeFileSync(join(to, e.name), readFileSync(p));
    }
  };
  for (const h of builtHarnesses(dist)) walk(join(dist, h), join(dest, "dist", h));
}

/** Removes everything in `dir` except its .git entry. */
function emptyWorktree(dir) {
  for (const e of readdirSync(dir)) if (e !== ".git") rmSync(join(dir, e), { recursive: true, force: true });
}

/**
 * Publishes. Returns { status: "published" | "unchanged" | "dry-run", sha, version, files }. Throws on any refusal or failure.
 * `retries` is how many times a rejected push is redone after a fresh fetch (default 1); `beforePush` is a test hook.
 */
export function publish(opts) {
  const root = resolve(opts.root ?? ROOT);
  const dist = resolve(opts.dist ?? join(root, "dist"));
  const remote = opts.remote ?? "origin";
  const target = opts.target ?? DEFAULT_TARGET;
  const log = opts.log ?? (() => {});
  const retries = opts.retries ?? 1;

  if (!opts.allowAnySource) {
    const p = sourceRefProblem(opts.sourceRef);
    if (p) throw new Error(p);
  }
  const tp = targetProblem(target);
  if (tp) throw new Error(tp);
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const problems = checkBuilt(dist, version);
  if (problems.length) throw new Error(`The build is not publishable:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  const sourceSha = opts.sourceSha ?? git(root, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error(`Source sha "${sourceSha}" is not a full commit sha.`);

  const tmp = mkdtempSync(join(tmpdir(), "plugin-publish-"));
  const wt = join(tmp, "worktree");
  const hooks = join(tmp, "no-hooks");
  mkdirSync(hooks);
  const branch = `plugin-publish-tmp-${process.pid}-${Date.now()}`;
  let added = false;
  try {
    // A detached worktree with nothing checked out: the checkout's own branches and index are not involved.
    git(root, ["worktree", "add", "--no-checkout", "--detach", wt, sourceSha]);
    added = true;
    // The commit is made by this script in a throwaway worktree, so the repo's own hooks (which guard main and development) are not run.
    const g = (args) => git(wt, ["-c", `core.hooksPath=${hooks}`, "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "commit.gpgsign=false", ...args]);
    const name = opts.authorName ?? BOT_NAME;
    const email = opts.authorEmail ?? BOT_EMAIL;
    const ident = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };

    for (let attempt = 0; ; attempt++) {
      const heads = git(root, ["ls-remote", "--heads", remote, `refs/heads/${target}`]);
      const tip = heads ? heads.split(/\s+/)[0] : "";
      let parentTree = "";
      emptyWorktree(wt);
      if (tip) {
        g(["fetch", "--no-tags", remote, `refs/heads/${target}`]);
        g(["checkout", "--detach", "--force", tip]);
        parentTree = g(["rev-parse", `${tip}^{tree}`]);
        emptyWorktree(wt);
        log(`${target} exists at ${tip}`);
      } else {
        g(["checkout", "--orphan", branch]);
        g(["read-tree", "--empty"]); // an orphan branch starts with the source commit's files and index; it must start empty
        emptyWorktree(wt);
        log(`${target} does not exist on ${remote}; it will be created with no history`);
      }
      copyDist(dist, wt);
      g(["add", "--all", "--force", "."]);
      const tree = g(["write-tree"]);
      if (tip && tree === parentTree) {
        log("The built tree equals the branch's tree: nothing to publish.");
        return { status: "unchanged", sha: tip, version };
      }
      const files = g(["ls-files"]).split("\n").filter(Boolean);
      const message = `Publish the plugin build for ${version} from ${sourceSha.slice(0, 12)}\n\nSource commit: ${sourceSha}\nSource ref: ${opts.sourceRef ?? "(none)"}\nVersion: ${version}\n`;
      execFileSync(gitBin(), ["-C", wt, "-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false", "commit", "--quiet", "--file", "-"], {
        input: message, env: { ...process.env, ...ident },
      });
      const sha = g(["rev-parse", "HEAD"]);
      log(`Committed ${sha} (${files.length} files)`);
      if (opts.dryRun) {
        log(`Dry run: not pushing ${sha} to ${remote} ${target}.`);
        return { status: "dry-run", sha, version, files };
      }
      opts.beforePush?.(attempt);
      const push = spawnSync(gitBin(), ["-C", wt, "-c", `core.hooksPath=${hooks}`, "push", remote, `${sha}:refs/heads/${target}`], { encoding: "utf8" });
      if (push.status === 0) {
        log(`Pushed ${sha} to ${remote} ${target}`);
        return { status: "published", sha, version, files };
      }
      const why = (push.stderr || push.stdout || "").trim();
      if (attempt >= retries) throw new Error(`The push was rejected and is not forced: ${why}`);
      log(`The push was rejected (${why.split("\n")[0]}); fetching and trying once more.`);
    }
  } finally {
    if (added) {
      spawnSync(gitBin(), ["worktree", "remove", "--force", wt], { cwd: root });
    }
    rmSync(tmp, { recursive: true, force: true });
    spawnSync(gitBin(), ["worktree", "prune"], { cwd: root });
    spawnSync(gitBin(), ["branch", "-D", branch], { cwd: root, stdio: "ignore" });
  }
}

/** Parses the command line into publish() options, or returns { error }. */
export function parseArgs(args) {
  const o = { log: (s) => console.log(s) };
  const value = { "--source-sha": "sourceSha", "--source-ref": "sourceRef", "--remote": "remote", "--target": "target", "--dist": "dist", "--root": "root", "--author-name": "authorName", "--author-email": "authorEmail" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--allow-any-source-for-test") o.allowAnySource = true;
    else if (value[a]) {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value.\n\n${USAGE}` };
      o[value[a]] = v;
    } else return { error: `Unknown argument "${a}".\n\n${USAGE}` };
  }
  return { opts: o };
}

export function run(args) {
  if (args.includes("--help") || args.includes("-h")) return { code: 0, out: USAGE };
  const { opts, error } = parseArgs(args);
  if (error) return { code: 1, err: error };
  try {
    const r = publish(opts);
    return { code: 0, out: r.status === "unchanged" ? "Nothing to publish." : `${r.status}: ${r.sha}` };
  } catch (e) {
    return { code: 1, err: e.message };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, out, err } = run(process.argv.slice(2));
  if (out) console.log(out);
  if (err) console.error(err);
  process.exitCode = code;
}
