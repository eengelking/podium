// scripts/podium-peers-e2e.sh: only the parts that start nothing (help, argument checks, --dry-run). A real `up`
// starts Claude Code sessions, which cost money, so it is run by hand (docs/MESSAGING.md, "Testing it end to end").
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "podium-peers-e2e.sh");
const run = (...args: string[]) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
const runWith = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const MARKER = ".podium-peers-e2e";

/** A new folder under the system's temp folder, as the file system names it, removed after the test. */
const temps: string[] = [];
function tempDir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "podium-peers-e2e-t-")));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("podium-peers-e2e.sh", () => {
  it("prints its help with -h and --help", () => {
    for (const flag of ["-h", "--help"]) {
      const r = run(flag);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Usage: scripts/podium-peers-e2e.sh up [options]");
      expect(r.stdout).toContain("trust");
      expect(r.stdout).toContain("C-m");
      expect(r.stdout).toContain("--model NAME");
      expect(r.stdout).toContain("--no-build");
    }
  });

  it("refuses a number with a leading zero, rather than reading it as octal", () => {
    for (const [flag, value, words] of [
      ["--sessions", "09", /--sessions must be a number from 1 to 20/],
      ["--sessions", "08", /--sessions must be a number from 1 to 20/],
      ["--sessions", "010", /--sessions must be a number from 1 to 20/],
      ["--port", "0099", /--port must be a number from 1 to 65535/],
      ["--port", "08080", /--port must be a number from 1 to 65535/],
    ] as const) {
      const r = run("up", flag, value, "--dry-run");
      expect(r.status, `${flag} ${value}`).toBe(2);
      expect(r.stderr).toMatch(words);
      expect(r.stderr).not.toMatch(/value too great|invalid/);
      expect(r.stdout).toBe("");
    }
    expect(run("up", "--sessions", "9", "--port", "8080", "--dry-run", "--dir", path.join(os.tmpdir(), `podium-peers-e2e-none-${process.pid}`)).status).toBe(0);
  });

  it("builds on every up, unless --no-build says to serve the build already there", () => {
    const dir = path.join(os.tmpdir(), `podium-peers-e2e-none-${process.pid}`);
    const built = run("up", "--dry-run", "--dir", dir);
    expect(built.status).toBe(0);
    expect(built.stdout).toContain("would: build the server and the UI from this checkout (npm run build)");
    const kept = run("up", "--dry-run", "--no-build", "--dir", dir);
    expect(kept.status).toBe(0);
    expect(kept.stdout).not.toContain("npm run build");
    expect(kept.stdout).toContain("would: skip the build (--no-build) and serve server/dist and frontend/dist as they are");
  });

  it("refuses a work folder that is not empty and that no earlier up made, and writes nothing to it", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
    const r = run("up", "--dry-run", "--dir", dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`the work folder ${dir} is not empty and an earlier up did not make it; pick a new or empty folder`);
    expect(fs.readdirSync(dir)).toEqual(["notes.txt"]);
    // A file in place of the folder is refused too.
    expect(run("up", "--dry-run", "--dir", path.join(dir, "notes.txt")).stderr).toMatch(/is not a folder/);
  });

  it("takes an empty work folder, or one an earlier up made", () => {
    const empty = tempDir();
    expect(run("up", "--dry-run", "--dir", empty).status).toBe(0);
    const again = tempDir();
    fs.writeFileSync(path.join(again, MARKER), "");
    fs.writeFileSync(path.join(again, "server.log"), "");
    expect(run("up", "--dry-run", "--dir", again).status).toBe(0);
  });

  it("never lets down remove a folder up did not make, the home folder, the checkout or a folder that holds it, or a link", () => {
    // A real down here starts nothing: there is no tmux session by this name and no saved server pid.
    const mine = tempDir();
    fs.writeFileSync(path.join(mine, "notes.txt"), "mine");
    const r = run("down", "--dir", mine, "--tmux", `e2e-test-${process.pid}`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`not removing ${mine}: up did not make it`);
    expect(fs.existsSync(path.join(mine, "notes.txt"))).toBe(true);

    // A home folder that an older up wrote the marker into.
    const home = tempDir();
    fs.writeFileSync(path.join(home, MARKER), "");
    const h = runWith({ HOME: home }, "down", "--dir", home, "--tmux", `e2e-test-${process.pid}`);
    expect(h.status).toBe(2);
    expect(h.stderr).toMatch(/cannot be \/ or the home folder/);
    expect(fs.existsSync(path.join(home, MARKER))).toBe(true);

    expect(run("down", "--dry-run", "--dir", "/").stderr).toMatch(/cannot be \/ or the home folder/);
    const checkout = path.resolve(__dirname, "..");
    for (const d of [checkout, path.dirname(checkout)]) expect(run("down", "--dry-run", "--dir", d).stderr).toMatch(/cannot be this checkout or a folder that holds it/);

    // A link to a folder up made: down removes neither the link nor what it points at.
    const made = tempDir();
    fs.writeFileSync(path.join(made, MARKER), "");
    const link = path.join(tempDir(), "work");
    fs.symlinkSync(made, link);
    const l = run("down", "--dir", link, "--tmux", `e2e-test-${process.pid}`);
    expect(l.status).toBe(2);
    expect(l.stderr).toMatch(/cannot be a symbolic link/);
    expect(fs.existsSync(path.join(made, MARKER))).toBe(true);
    expect(run("down", "--dry-run", "--dir", `${link}/`).stderr).toMatch(/cannot be a symbolic link/);
  });

  it("removes on down the folder up made", () => {
    const made = path.join(tempDir(), "work");
    fs.mkdirSync(made);
    fs.writeFileSync(path.join(made, MARKER), "");
    fs.writeFileSync(path.join(made, "server.log"), "");
    const r = run("down", "--dir", made, "--tmux", `e2e-test-${process.pid}`);
    expect(r.status).toBe(0);
    expect(fs.existsSync(made)).toBe(false);
  });

  it("refuses a missing subcommand, an unknown argument and values out of range", () => {
    expect(run().status).toBe(2);
    expect(run("start").stderr).toMatch(/unknown argument: start/);
    expect(run("up", "--sessions", "0", "--dry-run").stderr).toMatch(/--sessions must be a number from 1 to 20/);
    expect(run("up", "--port", "70000", "--dry-run").stderr).toMatch(/--port must be a number/);
    expect(run("up", "--port").stderr).toMatch(/--port needs a value/);
    expect(run("up", "down").stderr).toMatch(/one of up or down/);
    expect(run("up", "--tmux", "a b", "--dry-run").status).toBe(2);
  });

  it("says what up would do with --dry-run, and makes nothing", () => {
    const dir = path.join(os.tmpdir(), `podium-peers-e2e-dry-${process.pid}`);
    const r = run("up", "--dry-run", "--dir", dir, "--port", "4999", "--sessions", "5", "--tmux", "e2e-dry-test", "--model", "sonnet");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`would: make the work folder ${dir}`);
    expect(r.stdout).toContain("http://127.0.0.1:4999");
    expect(r.stdout).toContain("podium-peers-seed.mjs --talk");
    for (const name of ["planner", "tester", "notes", "docs", "s5"]) expect(r.stdout).toContain(`as ${name} in ${dir}/proj-${name}`);
    expect(r.stdout).toContain("Claude Code (sonnet)");
    expect(r.stdout).toContain("tmux attach -t e2e-dry-test");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("says what down would do with --dry-run, and stops nothing", () => {
    const dir = path.join(os.tmpdir(), `podium-peers-e2e-dry-${process.pid}`);
    const r = run("down", "--dry-run", "--dir", dir, "--tmux", "e2e-dry-test");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("would: kill the tmux session e2e-dry-test");
    expect(r.stdout).toContain(`would: remove ${dir}`);
    expect(run("down", "--dry-run", "--dir", dir, "--keep").stdout).toContain(`keeping ${dir}`);
  });
});
