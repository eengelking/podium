import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  cleanup, createRebuilder, findExecutable, gitIgnores, HARNESS_TABLE, ignoredChange, isExecutableFile, parseArgs, run, spawnInherited, watchDirs,
} from "./plugin-dev.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "plugin-dev.mjs");
const scratch = mkdtempSync(join(tmpdir(), "plugin-dev-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

/** A fake harness table entry whose build and args are spies. */
function fakeTable(build: () => Promise<string> | string = () => "abc12345") {
  return {
    ...HARNESS_TABLE,
    claudecode: { ...HARNESS_TABLE.claudecode, build: vi.fn(build), args: () => ["--plugin-dir", "/x/dist/claudecode"] },
  };
}

function harnessRun(args: string[], over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const spawnHarness = vi.fn(async () => 0);
  const base = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {}, find: () => "/bin/claude", spawnHarness, table: fakeTable(), root: "/repo" };
  const deps = { ...base, ...over };
  return { out, err, spawnHarness, deps, go: () => run(args, deps) };
}

describe("parseArgs", () => {
  it("reads the harness, --watch and everything after --", () => {
    expect(parseArgs(["claudecode", "--watch", "--", "--model", "x", "--watch"])).toEqual({ harness: "claudecode", watch: true, rest: ["--model", "x", "--watch"] });
    expect(parseArgs(["claudecode"])).toEqual({ harness: "claudecode", watch: false, rest: [] });
  });
  it("wants help for --help or -h before --, not after it", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["claudecode", "-h"])).toEqual({ help: true });
    expect(parseArgs(["claudecode", "--", "--help"])).toMatchObject({ harness: "claudecode", rest: ["--help"] });
  });
  it("rejects an unknown option, no harness, and too many names", () => {
    expect(parseArgs(["claudecode", "--nope"]).error).toContain('Unknown option "--nope"');
    expect(parseArgs([]).error).toContain("Name a harness");
    expect(parseArgs(["claudecode", "opencode"]).error).toContain("Too many arguments");
    expect(parseArgs(["cleanup", "dist", "x"]).error).toContain("Too many arguments");
  });
  it("takes an optional harness after cleanup", () => {
    expect(parseArgs(["cleanup"])).toMatchObject({ harness: "cleanup", target: undefined });
    expect(parseArgs(["cleanup", "claudecode"])).toMatchObject({ harness: "cleanup", target: "claudecode" });
  });
});

describe("the harness table", () => {
  it("has claudecode with its binary, override, watch roots and --plugin-dir arguments", () => {
    const e = HARNESS_TABLE.claudecode;
    expect(e.bin).toBe("claude");
    expect(e.binEnv).toBe("PODIUM_CLAUDE_BIN");
    expect(e.roots).toEqual(["plugin/claudecode", "plugin/core"]);
    expect(e.args("/r")).toEqual(["--plugin-dir", join("/r", "dist-dev", "claudecode")]);
  });
  it("has opencode as a stub with nothing to run", () => {
    expect(HARNESS_TABLE.opencode.stub).toContain("#857");
    expect("build" in HARNESS_TABLE.opencode).toBe(false);
  });
});

describe("findExecutable", () => {
  const bin = join(scratch, "bin");
  const other = join(scratch, "other");
  mkdirSync(bin, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(bin, "tool"), "#!/bin/sh\n");
  chmodSync(join(bin, "tool"), 0o755);
  writeFileSync(join(other, "tool"), "x");
  chmodSync(join(other, "tool"), 0o644);

  it("finds the first executable on PATH as an absolute path", () => {
    expect(findExecutable("tool", { pathEnv: [other, bin].join(delimiter) })).toBe(join(bin, "tool"));
  });
  it("returns null when none is found", () => {
    expect(findExecutable("tool", { pathEnv: other })).toBeNull();
    expect(findExecutable("missing", { pathEnv: bin })).toBeNull();
  });
  it("skips empty and relative entries", () => {
    const seen: string[] = [];
    const isExec = (p: string) => (seen.push(p), false);
    expect(findExecutable("tool", { pathEnv: ["", ".", "rel/bin", bin].join(delimiter), isExec })).toBeNull();
    expect(seen).toEqual([join(bin, "tool")]);
  });
  it("honors an absolute override that is executable, and does not fall back when it is not", () => {
    expect(findExecutable("tool", { pathEnv: bin, override: join(bin, "tool") })).toBe(join(bin, "tool"));
    expect(findExecutable("tool", { pathEnv: bin, override: join(other, "tool") })).toBeNull();
    expect(findExecutable("tool", { pathEnv: bin, override: "tool" })).toBeNull();
  });
  it("uses PATH from the environment by default", () => {
    expect(findExecutable("definitely-not-a-real-binary-xyz")).toBeNull();
  });
  it("isExecutableFile is false for a folder and a missing path", () => {
    expect(isExecutableFile(bin)).toBe(false);
    expect(isExecutableFile(join(bin, "nope"))).toBe(false);
    expect(isExecutableFile(join(bin, "tool"))).toBe(true);
  });
});

describe("run", () => {
  it("prints help and exits 0", async () => {
    const t = harnessRun(["--help"]);
    expect(await t.go()).toBe(0);
    expect(t.out[0]).toContain("Usage: node scripts/plugin-dev.mjs");
  });
  it("fails on bad arguments", async () => {
    const t = harnessRun([]);
    expect(await t.go()).toBe(1);
    expect(t.err[0]).toContain("Name a harness");
  });
  it("lists the known harnesses for an unknown one", async () => {
    const t = harnessRun(["vim"]);
    expect(await t.go()).toBe(1);
    expect(t.err[0]).toBe('Unknown harness "vim". Known: claudecode, opencode, cleanup.');
    expect(t.spawnHarness).not.toHaveBeenCalled();
  });
  it("fails opencode at once with the reason, building and running nothing", async () => {
    const t = harnessRun(["opencode"]);
    expect(await t.go()).toBe(1);
    expect(t.err[0]).toContain("OpenCode has no dev runner yet");
    expect(t.err[0]).toContain("#857");
    expect(t.spawnHarness).not.toHaveBeenCalled();
  });
  it("builds, prints the line, runs the harness with --plugin-dir and the args after --, and passes its exit code through", async () => {
    const t = harnessRun(["claudecode", "--", "--model", "sonnet"], { spawnHarness: vi.fn(async () => 7) });
    expect(await t.go()).toBe(7);
    expect(t.deps.table.claudecode.build).toHaveBeenCalledWith("/repo");
    expect(t.out).toEqual(["built dist-dev/claudecode at abc12345; after a rebuild run /reload-plugins in the session"]);
    expect((t.deps.spawnHarness as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(["/bin/claude", ["--plugin-dir", "/x/dist/claudecode", "--model", "sonnet"]]);
  });
  it("passes the override variable to the finder", async () => {
    const find = vi.fn(() => "/opt/claude");
    const t = harnessRun(["claudecode"], { find, env: { PODIUM_CLAUDE_BIN: "/opt/claude" } });
    await t.go();
    expect(find).toHaveBeenCalledWith("claude", { override: "/opt/claude" });
  });
  it("fails clearly when the binary is not found, before building", async () => {
    const t = harnessRun(["claudecode"], { find: () => null });
    expect(await t.go()).toBe(1);
    expect(t.err[0]).toContain("claude not found on PATH");
    expect(t.err[0]).toContain("PODIUM_CLAUDE_BIN");
    expect(t.deps.table.claudecode.build).not.toHaveBeenCalled();
  });
  it("stops before launching when the build fails", async () => {
    const t = harnessRun(["claudecode"], { table: fakeTable(() => { throw new Error("not self-contained"); }) });
    expect(await t.go()).toBe(1);
    expect(t.err[0]).toContain("not started: not self-contained");
    expect(t.spawnHarness).not.toHaveBeenCalled();
  });
  it("cleanup passes the harness (or none) to cleanup and reports what it removed", async () => {
    const cleanupFn = vi.fn(() => ({ removed: ["dist", "dist-zips"], refused: [] }));
    const t = harnessRun(["cleanup"], { cleanupFn });
    expect(await t.go()).toBe(0);
    expect(cleanupFn).toHaveBeenCalledWith(undefined, { root: "/repo" });
    expect(t.out).toEqual(["removed dist, dist-zips"]);
    const u = harnessRun(["cleanup", "claudecode"], { cleanupFn });
    await u.go();
    expect(cleanupFn).toHaveBeenLastCalledWith("claudecode", { root: "/repo" });
  });
  it("cleanup says there is nothing to clean, and exits 0", async () => {
    const t = harnessRun(["cleanup"], { cleanupFn: () => ({ removed: [], refused: [] }) });
    expect(await t.go()).toBe(0);
    expect(t.out).toEqual(["nothing to clean"]);
  });
  it("cleanup reports a refusal and exits 1", async () => {
    const t = harnessRun(["cleanup"], { cleanupFn: () => ({ removed: [], refused: [{ path: "dist", why: "it is a symlink" }] }) });
    expect(await t.go()).toBe(1);
    expect(t.err[0]).toBe("Refused to remove dist: it is a symlink.");
  });
  it("cleanup rejects an unknown harness", async () => {
    const cleanupFn = vi.fn();
    const t = harnessRun(["cleanup", "vim"], { cleanupFn });
    expect(await t.go()).toBe(1);
    expect(t.err[0]).toContain('Unknown harness "vim"');
    expect(cleanupFn).not.toHaveBeenCalled();
  });
});

describe("--watch", () => {
  it("watches the harness's roots, rebuilds on a change, and stops the watcher when the harness exits", async () => {
    let onChange: (rel: string) => void = () => {};
    const close = vi.fn();
    const watchFn = vi.fn((_dirs: string[], cb: (rel: string) => void) => ((onChange = cb), { close }));
    const timers: Array<() => void> = [];
    const setTimer = vi.fn((f: () => void) => (timers.push(f), timers.length));
    let exit: (c: number) => void = () => {};
    const spawnHarness = vi.fn(() => new Promise<number>((r) => (exit = r)));
    const t = harnessRun(["claudecode", "--watch"], { watchFn, spawnHarness, rebuilderOptions: { setTimer, clearTimer: () => {} } });
    const done = t.go();
    await vi.waitFor(() => expect(spawnHarness).toHaveBeenCalled());
    expect(watchFn.mock.calls[0][0]).toEqual([join("/repo", "plugin/claudecode"), join("/repo", "plugin/core")]);
    onChange("hooks/x.ts");
    timers[0]();
    await vi.waitFor(() => expect(t.out.some((l) => l.startsWith("rebuilt dist-dev at"))).toBe(true));
    expect(t.deps.table.claudecode.build).toHaveBeenCalledTimes(2);
    exit(3);
    expect(await done).toBe(3);
    expect(close).toHaveBeenCalled();
  });
  it("does not watch without --watch", async () => {
    const watchFn = vi.fn();
    const t = harnessRun(["claudecode"], { watchFn });
    await t.go();
    expect(watchFn).not.toHaveBeenCalled();
  });
});

describe("the claudecode build", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const copy = (name: string) => {
    const root = join(scratch, name);
    cpSync(join(ROOT, "plugin"), join(root, "plugin"), { recursive: true });
    return root;
  };
  it("builds dist-dev/claudecode with the commit stamped and reports it", async () => {
    const root = copy("build-git");
    writeFileSync(join(root, ".gitignore"), "dist-dev/\n");
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "T");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "x");
    const sha = git(root, "rev-parse", "--short=8", "HEAD");
    expect(await HARNESS_TABLE.claudecode.build(root)).toBe(sha);
    expect(existsSync(join(root, "dist-dev", "claudecode", ".claude-plugin", "plugin.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "dist-dev", "claudecode", ".claude-plugin", "dev-build.json"), "utf8")).commit).toBe(sha);
    writeFileSync(join(root, "edit.txt"), "x");
    expect(await HARNESS_TABLE.claudecode.build(root)).toBe(`${sha} (dirty)`);
  });
  it("says no git outside a checkout", async () => {
    const root = copy("build-nogit");
    expect(await HARNESS_TABLE.claudecode.build(root)).toBe("no git");
    expect(existsSync(join(root, "dist-dev", "claudecode", ".claude-plugin", "dev-build.json"))).toBe(false);
  });
});

describe("ignoredChange", () => {
  it("ignores tests, .DS_Store and anything under dist or dist-dev, not source files", () => {
    expect(ignoredChange("hooks/a.test.ts")).toBe(true);
    expect(ignoredChange("hooks/.DS_Store")).toBe(true);
    expect(ignoredChange("dist/claudecode/x.ts")).toBe(true);
    expect(ignoredChange("a\\dist\\x.ts")).toBe(true);
    expect(ignoredChange("dist-dev/claudecode/x.ts")).toBe(true);
    expect(ignoredChange("hooks/a.ts")).toBe(false);
    expect(ignoredChange("")).toBe(false);
  });
});

describe("createRebuilder", () => {
  function setup(build: () => Promise<string> | string) {
    const timers = new Map<number, () => void>();
    let id = 0;
    const log: string[] = [];
    const errs: string[] = [];
    const clearTimer = vi.fn((n: number) => timers.delete(n));
    const r = createRebuilder({
      build: vi.fn(build), log: (s: string) => log.push(s), logError: (s: string) => errs.push(s),
      setTimer: ((f: () => void, ms: number) => (expect(ms).toBe(300), timers.set(++id, f), id)) as never, clearTimer: clearTimer as never,
    });
    const fire = () => { const [k, f] = [...timers][0]; timers.delete(k); f(); };
    return { r, timers, log, errs, fire, clearTimer };
  }

  it("collapses a burst of changes into one rebuild", async () => {
    const s = setup(() => "h1");
    s.r.notify("a.ts");
    s.r.notify("b.ts");
    s.r.notify("c.ts");
    expect(s.timers.size).toBe(1);
    expect(s.clearTimer).toHaveBeenCalledTimes(2);
    s.fire();
    await s.r.idle();
    expect(s.log).toEqual(["rebuilt dist-dev at h1; run /reload-plugins in the session"]);
  });
  it("does not schedule for an ignored change", () => {
    const s = setup(() => "h");
    s.r.notify("a.test.ts");
    expect(s.timers.size).toBe(0);
  });
  it("never overlaps builds and runs one more after a change during a build", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const s = setup(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((res) => releases.push(res));
      active--;
      return "h";
    });
    s.r.notify("a.ts");
    s.fire();
    s.r.notify("b.ts");
    s.fire(); // fires while the first build is running
    expect(releases).toHaveLength(1);
    releases[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]();
    await s.r.idle();
    expect(peak).toBe(1);
    expect(s.log).toHaveLength(2);
  });
  it("reports a failed rebuild, keeps watching, and builds the next change", async () => {
    let n = 0;
    const s = setup(() => {
      if (++n === 1) throw new Error("bad import");
      return "ok";
    });
    s.r.notify("a.ts");
    s.fire();
    await s.r.idle();
    expect(s.errs).toEqual(["rebuild failed, keeping the last good build: bad import"]);
    s.r.notify("a.ts");
    s.fire();
    await s.r.idle();
    expect(s.log).toEqual(["rebuilt dist-dev at ok; run /reload-plugins in the session"]);
  });
  it("builds nothing after stop, and drops a pending timer", async () => {
    const s = setup(() => "h");
    s.r.notify("a.ts");
    s.r.stop();
    expect(s.timers.size).toBe(0);
    s.r.notify("b.ts");
    expect(s.timers.size).toBe(0);
    await s.r.idle();
    expect(s.log).toEqual([]);
  });
  it("a fired timer after stop does nothing", async () => {
    const s = setup(() => "h");
    s.r.notify("a.ts");
    const f = [...s.timers.values()][0];
    s.r.stop();
    f();
    await s.r.idle();
    expect(s.log).toEqual([]);
  });
  it("stop clears nothing when no timer is set", () => {
    const s = setup(() => "h");
    s.r.stop();
    expect(s.clearTimer).not.toHaveBeenCalled();
  });
  it("uses the real timer by default", async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const r = createRebuilder({ build: () => "h", log: (s: string) => log.push(s), logError: () => {} });
      r.notify("a.ts");
      r.notify("b.ts");
      await vi.advanceTimersByTimeAsync(300);
      await r.idle();
      expect(log).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watchDirs", () => {
  it("watches each directory recursively, reports the relative name, and closes all", () => {
    const closes = [vi.fn(), vi.fn()];
    const cbs: Array<(e: string, n: string | null) => void> = [];
    let i = 0;
    const watch = vi.fn((_d: string, opts: unknown, cb: (e: string, n: string | null) => void) => {
      expect(opts).toEqual({ recursive: true });
      cbs.push(cb);
      return { close: closes[i++] };
    });
    const seen: string[] = [];
    const w = watchDirs(["/a", "/b"], (n: string) => seen.push(n), watch as never);
    cbs[0]("change", "x.ts");
    cbs[1]("rename", null);
    expect(seen).toEqual(["x.ts", ""]);
    w.close();
    expect(closes[0]).toHaveBeenCalled();
    expect(closes[1]).toHaveBeenCalled();
  });
});

describe("spawnInherited", () => {
  const fake = (event: string, arg?: unknown) => ((() => ({ on: (e: string, f: (a?: unknown) => void) => { if (e === event) f(arg); } })) as never);
  it("resolves the exit code, 1 for a signal, and 1 when it cannot start", async () => {
    expect(await spawnInherited("/b", [], fake("exit", 5))).toBe(5);
    expect(await spawnInherited("/b", [], fake("exit", null))).toBe(1);
    expect(await spawnInherited("/b", [], fake("error", new Error("x")))).toBe(1);
  });
  it("runs a real process with its terminal inherited and returns its code", async () => {
    expect(await spawnInherited(process.execPath, ["-e", "process.exit(4)"])).toBe(4);
  });
});

describe("cleanup", () => {
  /** A git repo ignoring dist-dev/, .build-test/ and dist-zips/, with some of them built. */
  function repo(name: string, make: string[]) {
    const root = join(scratch, name);
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitignore"), "dist-dev/\n.build-test/\ndist-zips/\n");
    writeFileSync(join(root, "keep.txt"), "tracked");
    git(root, "add", ".");
    for (const d of make) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, "f"), "x");
    }
    return root;
  }

  it("removes exactly dist-dev, .build-test and dist-zips and leaves everything else", () => {
    const root = repo("all", ["dist-dev/claudecode", ".build-test/claudecode", "dist-zips", "plugin"]);
    expect(cleanup(undefined, { root })).toEqual({ removed: ["dist-dev", ".build-test", "dist-zips"], refused: [] });
    expect(["dist-dev", ".build-test", "dist-zips"].some((d) => existsSync(join(root, d)))).toBe(false);
    expect(existsSync(join(root, "plugin", "f"))).toBe(true);
    expect(existsSync(join(root, "keep.txt"))).toBe(true);
  });
  it("with a harness removes only dist-dev/<harness>", () => {
    const root = repo("one", ["dist-dev/claudecode", "dist-dev/opencode", ".build-test/claudecode"]);
    expect(cleanup("claudecode", { root })).toEqual({ removed: ["dist-dev/claudecode"], refused: [] });
    expect(existsSync(join(root, "dist-dev", "claudecode"))).toBe(false);
    expect(existsSync(join(root, "dist-dev", "opencode"))).toBe(true);
    expect(existsSync(join(root, ".build-test"))).toBe(true);
  });
  it("never touches dist/, which is tracked and holds the release build (#983)", () => {
    const root = repo("tracked-dist", ["dist/claudecode", "dist-dev/claudecode"]);
    expect(cleanup(undefined, { root }).removed).toEqual(["dist-dev"]);
    expect(existsSync(join(root, "dist", "claudecode", "f"))).toBe(true);
    expect(cleanup("claudecode", { root }).removed).toEqual([]);
    expect(existsSync(join(root, "dist", "claudecode", "f"))).toBe(true);
  });
  it("has nothing to clean when nothing is built", () => {
    expect(cleanup(undefined, { root: repo("none", []) })).toEqual({ removed: [], refused: [] });
    expect(cleanup("claudecode", { root: repo("none2", []) })).toEqual({ removed: [], refused: [] });
  });
  it("refuses a folder git does not ignore, and removes the others", () => {
    const root = repo("tracked", ["dist-dev", "dist-zips"]);
    writeFileSync(join(root, ".gitignore"), "dist-dev/\n"); // dist-zips is no longer ignored
    const r = cleanup(undefined, { root });
    expect(r.removed).toEqual(["dist-dev"]);
    expect(r.refused).toEqual([{ path: "dist-zips", why: "git does not ignore it, so it may hold tracked files" }]);
    expect(existsSync(join(root, "dist-zips", "f"))).toBe(true);
  });
  it("refuses a symlink, and the folder under a symlink, and removes nothing through it", () => {
    const root = repo("link", []);
    const elsewhere = join(scratch, "elsewhere");
    mkdirSync(join(elsewhere, "claudecode"), { recursive: true });
    writeFileSync(join(elsewhere, "claudecode", "f"), "x");
    symlinkSync(elsewhere, join(root, "dist-dev"));
    expect(cleanup(undefined, { root }).refused).toEqual([{ path: "dist-dev", why: "it is a symlink" }]);
    expect(cleanup("claudecode", { root }).refused).toEqual([{ path: "dist-dev/claudecode", why: "it is a symlink" }]);
    expect(existsSync(join(elsewhere, "claudecode", "f"))).toBe(true);
  });
  it("refuses something that is not a folder", () => {
    const root = repo("file", []);
    writeFileSync(join(root, "dist-dev"), "a file");
    expect(cleanup(undefined, { root }).refused).toEqual([{ path: "dist-dev", why: "it is not a folder" }]);
    expect(existsSync(join(root, "dist-dev"))).toBe(true);
  });
  it("refuses when git cannot say", () => {
    const remove = vi.fn();
    const lstat = () => ({ isSymbolicLink: () => false, isDirectory: () => true }) as never;
    const r = cleanup(undefined, { root: "/r", isIgnored: () => null, lstat, remove });
    expect(r.removed).toEqual([]);
    expect(r.refused.map((x) => x.why)).toEqual(Array(3).fill("git could not say whether it is ignored"));
    expect(remove).not.toHaveBeenCalled();
  });
  it("gitIgnores: true for ignored, false for tracked, null outside a repo", () => {
    const root = repo("ign", ["dist-dev"]);
    expect(gitIgnores(root, "dist-dev")).toBe(true);
    expect(gitIgnores(root, "keep.txt")).toBe(false);
    const bare = join(scratch, "not-a-repo");
    mkdirSync(bare, { recursive: true });
    expect(gitIgnores(bare, "dist-dev")).toBeNull();
    expect(gitIgnores(root, "dist-dev", () => { throw new Error("no git"); })).toBeNull();
  });
});

describe("the default output", () => {
  it("prints to the console", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await run(["--help"])).toBe(0);
      expect(await run(["opencode"])).toBe(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe("the command line", () => {
  const cli = (...args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: "pipe" }), err: "" };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout, err: x.stderr };
    }
  };
  it("--help exits 0", () => {
    const r = cli("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("cleanup");
  });
  it("opencode fails with exit code 1 and the reason", () => {
    const r = cli("opencode");
    expect(r.code).toBe(1);
    expect(r.err).toContain("#857");
  });
});
