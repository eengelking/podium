// scripts/podium-peers-e2e.sh: only the parts that start nothing (help, argument checks, --dry-run). A real `up`
// starts Claude Code sessions, which cost money, so it is run by hand (docs/MESSAGING.md, "Testing it end to end").
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "podium-peers-e2e.sh");
const run = (...args: string[]) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });

describe("podium-peers-e2e.sh", () => {
  it("prints its help with -h and --help", () => {
    for (const flag of ["-h", "--help"]) {
      const r = run(flag);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Usage: scripts/podium-peers-e2e.sh up [options]");
      expect(r.stdout).toContain("trust");
      expect(r.stdout).toContain("C-m");
      expect(r.stdout).toContain("--model NAME");
    }
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
