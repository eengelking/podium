// scripts/db-lock.sh (#1284): the machine's database lock. Every case runs with its own TMPDIR, so it never touches the real lock
// of the person running the tests, and leaves no lock folder behind.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_SH = join(REPO, "scripts", "db-lock.sh");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "db-lock-test-")));
  made.push(d);
  return d;
}
/** Single-quotes a string for bash. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const uid = String(process.getuid?.() ?? 0);
const lockDir = (t: string) => join(t, `podium-db-lock-${uid}`);
/** A clean environment: the suite may itself run under CI or hold the real lock. */
const env = (t: string, extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: t,
  PODIUM_DB_LOCK_POLL_S: "0.1",
  ...extra,
});
/** A bash script that sources the lock, takes it, then runs `body`. */
const script = (body: string, name = "job") => `source ${JSON.stringify(LOCK_SH)}\ndb_lock_acquire ${name}\n${body}\n`;
const sh = (t: string, body: string, extra: Record<string, string> = {}, name = "job") =>
  spawnSync("bash", ["-c", script(body, name)], { encoding: "utf8", env: env(t, extra), timeout: 20000 });

describe("db-lock.sh", () => {
  it("prints its help, and refuses to run a command", () => {
    const r = spawnSync("bash", [LOCK_SH, "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const word of ["PODIUM_DB_LOCK_HELD", "PODIUM_DB_LOCK=off", "PODIUM_DB_LOCK_TIMEOUT_S", "db_lock_acquire", "CI"]) expect(r.stdout).toContain(word);
    expect(spawnSync("bash", [LOCK_SH, "-h"], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("bash", [LOCK_SH, "ls"], { encoding: "utf8" }).status).toBe(2);
  });

  it("acquires with its pid inside, exports the holder, and releases on exit", () => {
    const t = tmp();
    const r = sh(t, `echo "pid=$$ held=$PODIUM_DB_LOCK_HELD file=$(cat "$TMPDIR/podium-db-lock-$(id -u)/pid")"`);
    expect(r.status).toBe(0);
    const m = /pid=(\d+) held=(\d+) file=(\d+)/.exec(r.stdout);
    expect(m && m[1] === m[2] && m[2] === m[3]).toBe(true);
    expect(existsSync(lockDir(t))).toBe(false);
  });

  it("releases when the script is killed by TERM", () => {
    const t = tmp();
    const child = spawn("bash", ["-c", script("sleep 3 & wait")], { env: env(t) });
    const until = Date.now() + 10000;
    while (!existsSync(join(lockDir(t), "pid")) && Date.now() < until) spawnSync("sleep", ["0.1"]);
    expect(existsSync(lockDir(t))).toBe(true);
    child.kill("SIGTERM");
    const end = Date.now() + 10000;
    while (existsSync(lockDir(t)) && Date.now() < end) spawnSync("sleep", ["0.1"]);
    expect(existsSync(lockDir(t))).toBe(false);
  });

  it("makes a second caller wait, tells it who holds the lock, and lets it go once the first is done", async () => {
    const t = tmp();
    const first = spawn("bash", ["-c", script(`touch "$TMPDIR/first-in"; sleep 1.5; touch "$TMPDIR/first-out"`, "first")], { env: env(t) });
    const firstDone = new Promise((res) => first.on("close", res));
    const until = Date.now() + 10000;
    while (!existsSync(join(t, "first-in")) && Date.now() < until) spawnSync("sleep", ["0.1"]);
    const holder = readFileSync(join(lockDir(t), "pid"), "utf8").trim();
    const second = spawn("bash", ["-c", script(`test -e "$TMPDIR/first-out" && echo second-after-first`, "second")], { env: env(t) });
    let out = "", err = "";
    second.stdout.on("data", (d) => (out += d));
    second.stderr.on("data", (d) => (err += d));
    const code = await new Promise((res) => second.on("close", res));
    await firstDone;
    expect(code).toBe(0);
    expect(out).toContain("second-after-first");
    expect(err).toContain(`waiting for the database test lock (held by pid ${holder}, waited 0s)`);
    expect(existsSync(lockDir(t))).toBe(false);
  });

  it("takes the lock over from a dead holder", () => {
    const t = tmp();
    const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    spawnSync("mkdir", [lockDir(t)]);
    writeFileSync(join(lockDir(t), "pid"), dead + "\n");
    const r = sh(t, "echo got");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("got");
    expect(r.stderr).toContain(`the holder (pid ${dead}) is gone, taking the lock over`);
    expect(existsSync(lockDir(t))).toBe(false);
  });

  it("does not wait for itself: a child of the holder goes straight in, and the holder keeps the lock", () => {
    const t = tmp();
    const child = q(script(`echo "child in, held=$PODIUM_DB_LOCK_HELD"`, "child"));
    const r = sh(t, `bash -c ${child}\necho "parent still holds: $(test -d "$TMPDIR/podium-db-lock-$(id -u)" && echo yes)"`);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/child in, held=\d+/);
    expect(r.stdout).toContain("parent still holds: yes");
    expect(r.stderr).not.toContain("waiting");
    expect(existsSync(lockDir(t))).toBe(false);
  });

  it("does not trust a stale PODIUM_DB_LOCK_HELD: a script that inherited it from a dead holder still waits for the real lock", () => {
    const t = tmp();
    const holder = spawn("bash", ["-c", script(`touch "$TMPDIR/in"; sleep 1.5`, "holder")], { env: env(t) });
    const until = Date.now() + 10000;
    while (!existsSync(join(t, "in")) && Date.now() < until) spawnSync("sleep", ["0.1"]);
    const r = sh(t, `echo got`, { PODIUM_DB_LOCK_HELD: "99999999" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("waiting for the database test lock");
    holder.kill();
  });

  it("is a no-op under CI or PODIUM_DB_LOCK=off, and says why once", () => {
    const t = tmp();
    spawnSync("mkdir", [lockDir(t)]);
    writeFileSync(join(lockDir(t), "pid"), `${process.pid}\n`); // held by a live process: a real caller would wait
    for (const [extra, why] of [[{ CI: "true" }, "CI is set"], [{ PODIUM_DB_LOCK: "off" }, "PODIUM_DB_LOCK=off"]] as const) {
      const r = sh(t, `bash -c ${q(script("echo inner"))}\necho done`, extra);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("done");
      expect(r.stderr.split(why).length - 1).toBe(1);
    }
    expect(readFileSync(join(lockDir(t), "pid"), "utf8").trim()).toBe(String(process.pid)); // untouched
  });

  it("gives up with exit 3 after PODIUM_DB_LOCK_TIMEOUT_S", () => {
    const t = tmp();
    spawnSync("mkdir", [lockDir(t)]);
    writeFileSync(join(lockDir(t), "pid"), `${process.pid}\n`);
    const r = sh(t, "echo should-not-run", { PODIUM_DB_LOCK_TIMEOUT_S: "1" });
    expect(r.status).toBe(3);
    expect(r.stdout).not.toContain("should-not-run");
    expect(r.stderr).toContain("gave up after");
    expect(r.stderr).toContain(`pid ${process.pid}`);
  });
});
