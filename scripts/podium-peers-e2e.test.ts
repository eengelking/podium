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
      for (const word of ["--harness LIST", "--opencode-model", "--opencode-config", "--activity-output", "--session-recording", "--file-diff", "tmux -L", "opencode --standalone"]) expect(r.stdout, word).toContain(word);
    }
  });

  it("gives a window's project folder one commit, so a session in it reports a git branch", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    const fn = /^init_project\(\) \{\n[\s\S]*?\n\}\n/m.exec(src)?.[0];
    expect(fn, "init_project is defined").toBeTruthy();
    expect(src.match(/^\s+init_project "\$dir"$/gm)).toHaveLength(2); // the Claude Code window and the OpenCode window
    const dir = tempDir();
    // A git identity and signing config that would break a plain commit: the helper must not depend on either.
    const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", env });
    for (const again of [false, true]) {
      const r = spawnSync("bash", ["-c", `${fn}\ninit_project "$1"`, "bash", dir], { encoding: "utf8", env });
      expect(r.status, r.stderr).toBe(0);
      expect(git("rev-list", "--count", "HEAD").stdout.trim(), again ? "a second call adds none" : "one commit").toBe("1");
    }
    expect(git("branch", "--show-current").stdout.trim()).not.toBe("");
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
    expect(r.stdout).toContain("tmux -L e2e-dry-test attach -t e2e-dry-test");
    expect(r.stdout).toContain("tmux -L e2e-dry-test");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("says what down would do with --dry-run, and stops nothing", () => {
    const dir = path.join(os.tmpdir(), `podium-peers-e2e-dry-${process.pid}`);
    const r = run("down", "--dry-run", "--dir", dir, "--tmux", "e2e-dry-test");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("would: kill the tmux server on socket e2e-dry-test");
    expect(r.stdout).toContain(`would: remove the links in ${dir}/home-claude, then ${dir}`);
    expect(run("down", "--dry-run", "--dir", dir, "--keep").stdout).toContain(`keeping ${dir}`);
  });

  describe("harnesses (#976)", () => {
    const dir = path.join(os.tmpdir(), `podium-peers-e2e-harness-${process.pid}`);
    const dry = (...args: string[]) => run("up", "--dry-run", "--dir", dir, "--tmux", "e2e-h-test", ...args);

    it("starts Claude Code in every window by default, and builds only that plugin", () => {
      const r = dry();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("build the claudecode plugin");
      expect(r.stdout).not.toContain("opencode");
      expect(r.stdout).not.toContain("OpenCode");
      expect(r.stdout).not.toContain("activityOutput");
      expect(r.stdout.match(/start Claude Code \(haiku\)/g)).toHaveLength(4);
      // A scratch home that holds no .podium, so a reporter config file there cannot send the session to the maintainer's server.
      expect(r.stdout).toContain(`HOME ${dir}/home-claude (links to your home, except .podium)`);
      expect(r.stdout).toContain("tmux -L e2e-h-test");
    });

    it("starts OpenCode windows with their own home, env file and --standalone", () => {
      const r = dry("--harness", "opencode", "--opencode-model", "opencode/some-free", "--sessions", "2");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("build the opencode plugin");
      expect(r.stdout).not.toContain("build the claudecode plugin");
      expect(r.stdout).toContain(`start OpenCode (opencode/some-free) as planner in ${dir}/proj-planner, home ${dir}/home-planner with the plugin copied in, env file ${dir}/oc-env-planner.sh, opencode --standalone`);
      expect(r.stdout).toContain("as tester in");
      expect(r.stdout).not.toContain("start Claude Code");
      expect(r.stdout).not.toContain("write " + dir + "/settings.json");
    });

    it("lets one run mix the harnesses, window by window, on one server", () => {
      const r = dry("--harness", "claudecode,opencode", "--opencode-model", "p/m", "--model", "sonnet");
      expect(r.status).toBe(0);
      const order = [...r.stdout.matchAll(/start (Claude Code|OpenCode) \([^)]*\) as (\w+)/g)].map((m) => `${m[2]}:${m[1]}`);
      expect(order).toEqual(["planner:Claude Code", "tester:OpenCode", "notes:Claude Code", "docs:OpenCode"]);
      expect(r.stdout).toContain("Claude Code (sonnet)");
      expect(r.stdout).toContain("OpenCode (p/m)");
      expect(r.stdout.match(/start the server/g)).toHaveLength(1);
    });

    it("needs a model for OpenCode and never defaults one", () => {
      const r = dry("--harness", "opencode");
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/--opencode-model PROVIDER\/MODEL is required/);
      expect(dry("--harness", "claudecode,opencode").status).toBe(2);
      expect(dry("--harness", "opencode", "--opencode-model", "a b").stderr).toMatch(/--opencode-model takes/);
    });

    it("refuses --tmux default, whose socket is the user's own tmux server", () => {
      expect(dry("--tmux", "default").stderr).toMatch(/--tmux default is the name of your own tmux server's socket/);
    });

    it("refuses a harness it does not know and an empty list", () => {
      expect(dry("--harness", "pi").stderr).toMatch(/--harness takes claudecode or opencode, or a comma list of them, not 'pi'/);
      expect(dry("--harness", "claudecode,,opencode").status).toBe(2);
      expect(dry("--harness", "").stderr).toMatch(/--harness needs a value/);
      expect(dry("--opencode-config", path.join(dir, "missing.json")).stderr).toMatch(/is not a file/);
    });

    it("turns on the Admin flags and the reporter options through flags, for both harnesses", () => {
      const r = dry("--harness", "claudecode,opencode", "--opencode-model", "p/m", "--activity-output", "--session-recording", "--file-diff");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("podium-peers-seed.mjs --talk --activity-output --session-recording --file-diff");
      expect(r.stdout).toContain('"activityOutput": true, "sessionRecording": true, "fileDiff": true');
    });

    it("writes an OpenCode window's files and takes the caller's provider block, with ask permissions that win", () => {
      // A real up starts a server and sessions; this runs only the window's own preparation, with stand-in tools on PATH.
      const work = tempDir();
      const bin = path.join(work, "bin");
      fs.mkdirSync(bin);
      const fake = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
      fake("tmux", "exit 0");
      fake("opencode", "exit 0");
      fake("curl", "exit 0");
      const cfg = path.join(work, "provider.json");
      fs.writeFileSync(cfg, JSON.stringify({ provider: { lmstudio: { name: "Local" } }, model: "wrong/model", permission: { bash: "allow", read: "allow" } }));
      const r = spawnSync("bash", ["-c", `
        set -e
        sed -n -e '/^init_project() {/,/^}/p' -e '/^start_opencode() {/,/^}/p' "${SCRIPT}" > "$WORK/fn.sh"
        DRY=0; DIR="$WORK/run"; URL=http://127.0.0.1:1; SEED_FILE="$DIR/seed.out"; TMUX_NAME=t
        OC_DIST="$WORK/dist-oc"; OC_MODEL=lmstudio/m; OC_CONFIG="$OC_CONFIG"
        mkdir -p "$DIR" "$OC_DIST/plugin"; echo x > "$OC_DIST/plugin/index.ts"
        step() { :; }; tm() { :; }
        . "$WORK/fn.sh"
        start_opencode win "$DIR/proj-win" " PODIUM_FILE_DIFF=true"
      `], { encoding: "utf8", env: { ...process.env, WORK: work, OC_CONFIG: cfg, PATH: `${bin}:${process.env.PATH}` } });
      expect(r.status, r.stderr).toBe(0);
      const conf = JSON.parse(fs.readFileSync(path.join(work, "run/proj-win/opencode.json"), "utf8"));
      expect(conf.model).toBe("lmstudio/m");
      expect(conf.provider.lmstudio.name).toBe("Local");
      expect(conf.permission).toEqual({ bash: "ask", edit: "ask", read: "allow" });
      expect(fs.existsSync(path.join(work, "run/home-win/.config/opencode/plugins/podium/plugin/index.ts"))).toBe(true);
      const env = fs.readFileSync(path.join(work, "run/oc-env-win.sh"), "utf8");
      expect(env).toContain(`export HOME=${path.join(work, "run/home-win")}`);
      expect(env).toContain("export PODIUM_SERVER=http://127.0.0.1:1");
      expect(env).toContain("PODIUM_FILE_DIFF=true");
      expect(env).toContain("sed -n 's/^token=//p'");
      expect(env).not.toMatch(/PODIUM_TOKEN=[^"]/);
    });
  });
});
