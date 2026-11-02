import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildHarness } from "./plugin-build.mjs";
import { parseArgs, publish, run, sourceRefProblem, targetProblem } from "./plugin-publish.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "plugin-publish.mjs");
const TARGET = "plugin-dist-test";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const remoteSha = (bare: string) => spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${TARGET}`], { cwd: bare, encoding: "utf8" }).stdout.trim();
const treeFiles = (bare: string, ref: string) => git(bare, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean);

describe("plugin-publish", () => {
  const scratch = mkdtempSync(join(tmpdir(), "plugin-publish-test-"));
  const built = join(scratch, "built");
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
  let n = 0;
  let repo = "";
  let bare = "";
  let dist = "";
  let sha = "";

  beforeAll(() => {
    buildHarness("claudecode", { outDir: built });
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  // Each test gets its own checkout (a repo with one commit and a package.json), its own bare repo as `origin`, and its own copy of the build.
  beforeEach(() => {
    const dir = join(scratch, `case-${++n}`);
    repo = join(dir, "repo");
    bare = join(dir, "origin.git");
    dist = join(repo, "dist");
    mkdirSync(repo, { recursive: true });
    git(dir, "init", "-q", "--bare", bare);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(repo, ".gitignore"), "dist/\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "source");
    git(repo, "remote", "add", "origin", bare);
    sha = git(repo, "rev-parse", "HEAD");
    cpSync(built, dist, { recursive: true });
  });

  const opts = (extra: Record<string, unknown> = {}) => ({ root: repo, remote: bare, target: TARGET, sourceSha: sha, sourceRef: "main", ...extra });
  /** The state the main checkout must keep through any run. */
  const checkoutState = () => ({ status: git(repo, "status", "--porcelain", "--ignored"), index: git(repo, "ls-files", "-s"), head: git(repo, "rev-parse", "HEAD"), branches: git(repo, "branch", "--list"), worktrees: git(repo, "worktree", "list") });
  const bump = (v: string) => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ version: v }));
    const f = join(dist, "claudecode", ".claude-plugin", "plugin.json");
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), version: v }, null, 2));
  };

  it("creates an orphan branch whose tree is exactly dist/<harness>/...", () => {
    const r = publish(opts());
    expect(r.status).toBe("published");
    expect(remoteSha(bare)).toBe(r.sha);
    expect(git(bare, "rev-list", "--parents", "-n", "1", r.sha)).toBe(r.sha); // no parent
    const files = treeFiles(bare, TARGET);
    expect(files.length).toBeGreaterThan(5);
    expect(files.every((f) => f.startsWith("dist/claudecode/"))).toBe(true);
    expect(files).toContain("dist/claudecode/.claude-plugin/plugin.json");
    const local = readdirSync(join(built, "claudecode"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
    expect(files.length).toBe(local);
    expect(git(bare, "log", "-1", "--format=%B", TARGET)).toContain(`Source commit: ${sha}`);
    expect(git(bare, "log", "-1", "--format=%s", TARGET)).toContain(version);
  });

  it("publishes nothing when the tree is unchanged", () => {
    const first = publish(opts());
    const second = publish(opts({ sourceSha: sha }));
    expect(second.status).toBe("unchanged");
    expect(remoteSha(bare)).toBe(first.sha);
    expect(git(bare, "rev-list", "--count", TARGET)).toBe("1");
  });

  it("appends a commit on top for a changed tree and for a bumped version, never rewriting the old one", () => {
    const first = publish(opts());
    writeFileSync(join(dist, "claudecode", "plugin", "claudecode", "added.ts"), "export const a = 1;\n");
    const second = publish(opts());
    expect(second.status).toBe("published");
    expect(git(bare, "rev-parse", `${second.sha}^`)).toBe(first.sha);
    bump("9.9.9");
    const third = publish(opts());
    expect(third.status).toBe("published");
    expect(git(bare, "rev-parse", `${third.sha}^`)).toBe(second.sha);
    expect(git(bare, "log", "-1", "--format=%s", TARGET)).toContain("9.9.9");
    expect(git(bare, "rev-list", "--count", TARGET)).toBe("3");
  });

  it("publishes nothing when a built plugin.json version is not the product version", () => {
    const f = join(dist, "claudecode", ".claude-plugin", "plugin.json");
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), version: "0.0.1" }));
    expect(() => publish(opts())).toThrow(/not the product version/);
    expect(remoteSha(bare)).toBe("");
  });

  it("refuses development and any other source ref, and accepts main and release-candidate/*", () => {
    expect(() => publish(opts({ sourceRef: "development" }))).toThrow(/may not publish/);
    expect(() => publish(opts({ sourceRef: "feat/x" }))).toThrow(/may not publish/);
    expect(() => publish(opts({ sourceRef: undefined }))).toThrow(/may not publish/);
    expect(remoteSha(bare)).toBe("");
    expect(sourceRefProblem("main")).toBe("");
    expect(sourceRefProblem("refs/heads/main")).toBe("");
    expect(sourceRefProblem("release-candidate/1.5.0")).toBe("");
    expect(sourceRefProblem("release-candidate/")).not.toBe("");
    expect(publish(opts({ sourceRef: "release-candidate/1.5.0" })).status).toBe("published");
  });

  it("lets a test skip the source rule only with the flag", () => {
    expect(publish(opts({ sourceRef: "feat/x", allowAnySource: true })).status).toBe("published");
  });

  it("refuses main and development as a target and a malformed one", () => {
    for (const t of ["main", "development", "../x", "a b", "x.lock", "x/"]) expect(targetProblem(t), t).not.toBe("");
    expect(targetProblem("plugin-dist")).toBe("");
    expect(() => publish(opts({ target: "development" }))).toThrow(/refused/);
  });

  it("publishes nothing when the self-containment check fails", () => {
    writeFileSync(join(dist, "claudecode", "plugin", "claudecode", "hooks", "bad.ts"), 'import "../../../../../outside.ts";\n');
    expect(() => publish(opts())).toThrow(/not publishable/);
    expect(remoteSha(bare)).toBe("");
  });

  it("publishes nothing when there is no built folder", () => {
    rmSync(dist, { recursive: true });
    expect(() => publish(opts())).toThrow(/no built harness/);
  });

  it("refuses a rejected (non-fast-forward) push and never forces", () => {
    publish(opts());
    const before = remoteSha(bare);
    writeFileSync(join(dist, "claudecode", "plugin", "claudecode", "added.ts"), "export const a = 1;\n");
    // A competing commit lands between the fetch and the push, and the retry is switched off: the push is refused.
    const rival = () => {
      const clone = join(scratch, `rival-${n}`);
      git(scratch, "clone", "-q", "-b", TARGET, bare, clone);
      git(clone, "config", "user.email", "r@example.com");
      git(clone, "config", "user.name", "R");
      writeFileSync(join(clone, "rival.txt"), "x");
      git(clone, "add", ".");
      git(clone, "commit", "-q", "-m", "rival");
      git(clone, "push", "-q", "origin", `HEAD:${TARGET}`);
      return git(clone, "rev-parse", "HEAD");
    };
    let rivalSha = "";
    expect(() => publish(opts({ retries: 0, beforePush: () => { rivalSha = rival(); } }))).toThrow(/rejected and is not forced/);
    expect(remoteSha(bare)).toBe(rivalSha);
    expect(git(bare, "merge-base", "--is-ancestor", before, rivalSha) ?? "").toBe("");
  });

  it("fetches and retries once after a rejected push, appending on top of the rival commit", () => {
    publish(opts());
    writeFileSync(join(dist, "claudecode", "plugin", "claudecode", "added.ts"), "export const a = 1;\n");
    let rivalSha = "";
    const r = publish(opts({
      beforePush: (attempt: number) => {
        if (attempt > 0) return;
        const clone = join(scratch, `rival2-${n}`);
        git(scratch, "clone", "-q", "-b", TARGET, bare, clone);
        git(clone, "config", "user.email", "r@example.com");
        git(clone, "config", "user.name", "R");
        writeFileSync(join(clone, "rival.txt"), "x");
        git(clone, "add", ".");
        git(clone, "commit", "-q", "-m", "rival");
        git(clone, "push", "-q", "origin", `HEAD:${TARGET}`);
        rivalSha = git(clone, "rev-parse", "HEAD");
      },
    }));
    expect(r.status).toBe("published");
    expect(git(bare, "rev-parse", `${r.sha}^`)).toBe(rivalSha);
    // The rival's file is not in dist/, so the new commit's tree drops it: the branch holds exactly the built tree.
    expect(treeFiles(bare, TARGET).every((f) => f.startsWith("dist/claudecode/"))).toBe(true);
  });

  it("leaves the main checkout's index, working tree, branches and worktree list as they were, and removes its temp worktree", () => {
    writeFileSync(join(repo, "staged.txt"), "s");
    git(repo, "add", "staged.txt");
    writeFileSync(join(repo, "untracked.txt"), "u");
    const before = checkoutState();
    publish(opts());
    publish(opts());
    expect(checkoutState()).toEqual(before);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(existsSync(join(repo, ".git", "worktrees")) ? readdirSync(join(repo, ".git", "worktrees")) : []).toEqual([]);
  });

  it("cleans up its worktree when the run fails, and leaves the checkout alone", () => {
    publish(opts());
    const before = checkoutState();
    writeFileSync(join(dist, "claudecode", "plugin", "claudecode", "added.ts"), "export const a = 1;\n");
    expect(() => publish(opts({ remote: join(scratch, "does-not-exist.git") }))).toThrow();
    expect(checkoutState()).toEqual(before);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("--dry-run commits nothing to the remote", () => {
    const r = publish(opts({ dryRun: true }));
    expect(r.status).toBe("dry-run");
    expect(remoteSha(bare)).toBe("");
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("refuses a build that carries a dev stamp, so a developer's build never reaches plugin-dist", () => {
    writeFileSync(join(dist, "claudecode", ".claude-plugin", "dev-build.json"), '{"commit":"a1b2c3d4","tag":"","dirty":false}');
    expect(() => publish(opts())).toThrow(/dev-build\.json is a dev stamp/);
    expect(git(bare, "branch", "--list", TARGET)).toBe("");
  });

  it("ignores .DS_Store and refuses a symlink in the build", () => {
    writeFileSync(join(dist, "claudecode", ".DS_Store"), "x");
    publish(opts());
    expect(treeFiles(bare, TARGET).some((f) => f.endsWith(".DS_Store"))).toBe(false);
    execFileSync("ln", ["-s", "plugin.json", join(dist, "claudecode", ".claude-plugin", "link.json")]);
    expect(() => publish(opts())).toThrow();
  });

  it("works from the command line, and prints help", () => {
    const help = spawnSync("node", [SCRIPT, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: node scripts/plugin-publish.mjs");
    const r = spawnSync("node", [SCRIPT, "--root", repo, "--remote", bare, "--target", TARGET, "--source-sha", sha, "--source-ref", "development"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("may not publish");
    const ok = spawnSync("node", [SCRIPT, "--root", repo, "--remote", bare, "--target", TARGET, "--source-sha", sha, "--source-ref", "main"], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(remoteSha(bare)).not.toBe("");
    const again = spawnSync("node", [SCRIPT, "--root", repo, "--remote", bare, "--target", TARGET, "--source-sha", sha, "--source-ref", "main"], { encoding: "utf8" });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("Nothing to publish");
  });

  it("rejects unknown and valueless arguments", () => {
    expect(parseArgs(["--nope"]).error).toContain("Unknown argument");
    expect(parseArgs(["--target"]).error).toContain("needs a value");
    expect(run(["--bogus"]).code).toBe(1);
    expect(run(["-h"]).code).toBe(0);
    expect(parseArgs(["--dry-run", "--target", "x"]).opts).toMatchObject({ dryRun: true, target: "x" });
  });
});
