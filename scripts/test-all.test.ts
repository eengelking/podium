// scripts/test-all.mjs (#1295): which suites exist and in what order, how the options and the pass-through rule are read, NOT RUN and LIMITED,
// the exit codes, that one lock covers the whole run, and that a harness added to package.json without a suite fails. No suite really runs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { kinds } from "./db-adapters.mjs";
import { cannotRun, countsOf, exitCode, harnessSuites, lockedRun, main, parseArgs, resultLines, stepsFor, suites, unrunHarnessScripts } from "./test-all.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts as Record<string, string>;
const list = suites(pkg);
const names = list.map((s) => s.name);
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "test-all-test-")); made.push(d); return d; };

describe("suites", () => {
  it("runs the server suite first and e2e last, with every harness between", () => {
    expect(names[0]).toBe("server");
    expect(names.at(-1)).toBe("e2e");
    expect(names).toEqual(expect.arrayContaining(["frontend", "core", "mod:opencode", "mod:claudecode"]));
  });
  it("runs a harness's test script and then its typecheck", () => {
    const s = list.find((x) => x.name === "mod:opencode")!;
    expect(s.steps).toEqual([["run", "test:mod:opencode"], ["run", "typecheck:mod:opencode"]]);
  });
  it("picks up a harness from package.json, not from a list", () => {
    const more = { ...pkg, "test:mod:newone": "x", "typecheck:mod:newone": "y" };
    expect(harnessSuites(more, ["opencode", "claudecode"])).toContain("newone");
    expect(suites(more, []).map((s) => s.name)).toContain("mod:newone");
  });
  it("covers every test:mod and typecheck:mod script in package.json (a harness added without a suite fails here)", () => {
    expect(unrunHarnessScripts(pkg, list)).toEqual([]);
  });
  it("notices a script pair no suite runs", () => {
    expect(unrunHarnessScripts({ ...pkg, "test:mod:ghost": "x" }, list)).toEqual(["test:mod:ghost"]);
  });
  it("names every plugin/ harness folder", () => {
    const folders = harnessSuites({}, undefined);
    for (const f of folders) expect(names).toContain(`mod:${f}`);
  });
});

describe("parseArgs", () => {
  it("defaults to every suite and every database, not limited", () => {
    const a = parseArgs([], list);
    expect(a).toMatchObject({ names, limited: false, failFast: false, pass: [] });
    expect(a.db).toBeUndefined();
  });
  it("keeps run order whatever order --suite names them", () => {
    expect(parseArgs(["--suite", "core,server"], list).names).toEqual(["server", "core"]);
  });
  it("refuses an unknown or repeated suite", () => {
    expect(parseArgs(["--suite", "nope"], list).error).toContain("not a suite");
    expect(parseArgs(["--suite", "core core"], list).error).toContain("twice");
    expect(parseArgs(["--suite", " "], list).error).toContain("at least one");
  });
  it("marks a narrowed run LIMITED", () => {
    expect(parseArgs(["--suite", "core"], list).limited).toBe(true);
    expect(parseArgs(["--db", "sqlite"], list, ["sqlite", "postgres"]).limited).toBe(true);
    expect(parseArgs(["--db", "sqlite postgres"], list, ["sqlite", "postgres"]).limited).toBe(false);
  });
  it("refuses an unknown or repeated database", () => {
    expect(parseArgs(["--db", "oracle"], list).error).toContain("not a storage kind");
    expect(parseArgs(["--db", "sqlite sqlite"], list).error).toContain("twice");
    expect(parseArgs(["--db", ""], list).error).toContain("at least one");
  });
  it("reads --shards, --out and --fail-fast", () => {
    expect(parseArgs(["--shards", "2", "--out", "/x", "--fail-fast"], list)).toMatchObject({ shards: 2, out: "/x", failFast: true });
    expect(parseArgs(["--shards", "0"], list).error).toContain("whole number");
  });
  it("refuses an unknown option or a missing value", () => {
    expect(parseArgs(["--nope"], list).error).toContain("unknown option");
    expect(parseArgs(["--suite"], list).error).toContain("needs a value");
  });
  it("shows help", () => {
    expect(parseArgs(["-h"], list).help).toBe(true);
  });
  it("passes arguments through to exactly one suite", () => {
    expect(parseArgs(["--suite", "server", "--", "src/storage/adapters.test.ts"], list).pass).toEqual(["src/storage/adapters.test.ts"]);
    expect(parseArgs(["--suite", "server", "src/x.test.ts"], list).pass).toEqual(["src/x.test.ts"]); // npm ate the first --
  });
  it("refuses pass-through arguments with two suites, or with all of them", () => {
    expect(parseArgs(["--suite", "core server", "--", "x"], list).error).toContain("go to one suite");
    expect(parseArgs(["--", "x"], list).error).toContain("go to one suite");
  });
});

describe("stepsFor", () => {
  const server = list.find((s) => s.name === "server")!;
  const core = list.find((s) => s.name === "core")!;
  const mod = list.find((s) => s.name === "mod:opencode")!;
  it("hands --db and --shards to the suites that take them only", () => {
    const a = parseArgs(["--db", "sqlite", "--shards", "2"], list, ["sqlite", "postgres"]);
    expect(stepsFor(server, a)).toEqual([{ cmd: "npm", args: ["run", "test:db", "--", "--db", "sqlite", "--shards", "2"] }]);
    expect(stepsFor(core, a)).toEqual([{ cmd: "npm", args: ["run", "test:core"] }]);
  });
  it("defaults to every registered kind for server and e2e", () => {
    const e2e = list.find((s) => s.name === "e2e")!;
    const a = parseArgs([], list);
    expect(stepsFor(server, a)[0].args).toEqual(["run", "test:db", "--", "--db", kinds().join(" ")]);
    expect(stepsFor(e2e, a)[0].args).toEqual(["run", "e2e:fast", "--", "--db", kinds("e2e").join(" ")]);
  });
  it("puts pass-through arguments on the first step, the tests, and none on the typecheck", () => {
    const a = { ...parseArgs([], list), pass: ["-t", "x"] };
    const steps = stepsFor(mod, a);
    expect(steps[0].args).toEqual(["run", "test:mod:opencode", "--", "-t", "x"]);
    expect(steps[1].args).toEqual(["run", "typecheck:mod:opencode"]);
  });
  it("separates Cypress arguments from e2e:fast's options with a second --", () => {
    const e2e = list.find((s) => s.name === "e2e")!;
    const a = parseArgs(["--suite", "e2e", "--", "--spec", "f"], list);
    expect(stepsFor(e2e, a)[0].args).toEqual(["run", "e2e:fast", "--", "--db", kinds("e2e").join(" "), "--", "--spec", "f"]);
  });
});

describe("cannotRun", () => {
  const no = (() => ({ status: 1 })) as unknown as typeof spawnSync;
  const yes = (() => ({ status: 0 })) as unknown as typeof spawnSync;
  it("says mod:claudecode needs the Claude Code CLI", () => {
    expect(cannotRun("mod:claudecode", no)).toContain("Claude Code CLI");
    expect(cannotRun("mod:claudecode", yes)).toBeUndefined();
  });
  it("says e2e needs a running container engine", () => {
    expect(cannotRun("e2e", no, {})).toContain("no container engine");
    expect(cannotRun("e2e", yes, {})).toBeUndefined();
  });
  it("lets server run on SQLite alone without an engine", () => {
    expect(cannotRun("server", no, {}, ["sqlite"], kinds("server"))).toBeUndefined();
    expect(cannotRun("server", no, {}, kinds(), kinds("server"))).toContain("no container engine");
  });
  it("never blocks frontend or core", () => {
    expect(cannotRun("core", no)).toBeUndefined();
  });
});

describe("countsOf", () => {
  it("reads vitest's Tests line", () => {
    expect(countsOf("core", "x\n Tests  729 passed (729)\n Duration 3s")).toBe("Tests  729 passed (729)");
  });
  it("reads the per-database lines of the server suite", () => {
    const t = "DB TEST RESULT: sqlite=PASS\n  sqlite: 3 files, 9 tests\n  postgres: 1 files, 2 tests\nother";
    expect(countsOf("server", t)).toBe("sqlite: 3 files, 9 tests; postgres: 1 files, 2 tests");
  });
  it("reads claude plugin test's Ran line", () => {
    expect(countsOf("mod:claudecode", "0 fail\nRan 1313 tests across 55 files. [13.60s]\n> x")).toBe("Ran 1313 tests across 55 files. [13.60s]");
  });
  it("reads the e2e line and returns undefined when there is nothing", () => {
    expect(countsOf("e2e", "E2E RESULT: sqlite=PASS")).toBe("E2E RESULT: sqlite=PASS");
    expect(countsOf("core", "nothing")).toBeUndefined();
    expect(countsOf("server", "nothing")).toBeUndefined();
  });
});

describe("result and exit code", () => {
  const pass = (name: string) => ({ name, status: "PASS", code: 0, seconds: 1, log: "/l", counts: "ok" });
  it("lists every suite on one line and exits 0 when all passed", () => {
    const rs = names.map(pass);
    const lines = resultLines(rs, names, false);
    expect(lines[0]).toBe(`TEST ALL RESULT: ${names.map((n) => `${n}=PASS`).join(" ")}`);
    expect(lines.join("\n")).not.toContain("LIMITED");
    expect(exitCode(rs)).toBe(0);
  });
  it("reports FAIL with the exit code and exits 1", () => {
    const rs = [pass("server"), { ...pass("core"), status: "FAIL", code: 1 }];
    expect(resultLines(rs, names, true)[0]).toBe("TEST ALL RESULT: server=PASS core=FAIL(1)");
    expect(exitCode(rs)).toBe(1);
  });
  it("reports NOT RUN with its reason, says LIMITED, and is not a pass", () => {
    const rs = [pass("core"), { name: "mod:claudecode", status: "NOT RUN", reason: "no CLI", log: "/l" }];
    const lines = resultLines(rs, ["core", "mod:claudecode"], false);
    expect(lines.join("\n")).toContain("mod:claudecode: NOT RUN, no CLI");
    expect(lines.at(-1)).toContain("LIMITED: NOT RUN mod:claudecode");
    expect(exitCode(rs)).toBe(1);
  });
  it("names what a narrowed run left out", () => {
    const last = resultLines([pass("core")], ["server", "core"], true).at(-1)!;
    expect(last).toContain("NOT RUN server");
    expect(last).toContain("not a pass for a pull request or a release");
  });
});

describe("main", () => {
  const yes = (() => ({ status: 0 })) as unknown as typeof spawnSync;
  const no = (() => ({ status: 1 })) as unknown as typeof spawnSync;
  const calls: string[] = [];
  const run = (argv: string[], code = 0, runner = yes) => {
    calls.length = 0;
    const ex = async (c: string, a: string[]) => { calls.push(`${c} ${a.join(" ")}`); return code; };
    return main([...argv, "--out", tmp()], { TEST_ALL_LOCKED: "1" }, ex as never, runner, pkg);
  };
  const everyCommand = list.flatMap((s) => stepsFor(s, parseArgs([], list)).map((st: { cmd: string; args: string[] }) => `${st.cmd} ${st.args.join(" ")}`));
  it("exits 2 for a bad argument and shows help with 0", async () => {
    expect(await main(["--suite", "zzz"], {}, undefined, yes, pkg)).toBe(2);
    expect(await main(["--help"], {}, undefined, yes, pkg)).toBe(0);
  });
  it("runs every suite's commands one after another in order, and exits 0", async () => {
    expect(await run([])).toBe(0);
    expect(calls).toEqual(everyCommand);
  });
  it("keeps going after a failing suite, and --fail-fast stops at the first", async () => {
    expect(await run([], 1)).toBe(1);
    expect(calls.length).toBe(list.length); // each suite stops at its first failing step
    expect(await run(["--fail-fast"], 1)).toBe(1);
    expect(calls).toEqual([everyCommand[0]]);
  });
  it("leaves a suite out as NOT RUN and exits 1", async () => {
    expect(await run(["--suite", "core e2e"], 0, no)).toBe(1);
    expect(calls).toEqual(["npm run test:core"]);
  });
  it("starts one locked run when the lock is not held yet", () => {
    let seen: { cmd: string; args: string[]; env: Record<string, string> } | undefined;
    const fake = ((cmd: string, args: string[], o: { env: Record<string, string> }) => { seen = { cmd, args, env: o.env }; return { status: 7 }; }) as unknown as typeof spawnSync;
    expect(lockedRun(["--suite", "core"], {}, fake)).toBe(7);
    expect(seen!.cmd).toBe("bash");
    expect(seen!.env.TEST_ALL_LOCKED).toBe("1");
    expect(seen!.args.join(" ")).toContain("db_lock_acquire");
    expect(seen!.args.at(-1)).toBe("core");
  });
});

describe("the lock", () => {
  it("is taken once for the run, the suites see it held, and it is gone afterward", () => {
    const t = tmp();
    const probe = join(t, "probe.txt");
    // A stand-in for a suite: prints whether it sees the lock as held by its parent, then the lock directory is checked after the run.
    const script = `source ${JSON.stringify(join(REPO, "scripts", "db-lock.sh"))} && db_lock_acquire t && echo "held=$PODIUM_DB_LOCK_HELD" > ${JSON.stringify(probe)} && ls ${JSON.stringify(t)} | grep -c podium-db-lock >> ${JSON.stringify(probe)}; db_lock_release`;
    const r = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "", TMPDIR: t, HOME: t }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readFileSync(probe, "utf8")).toMatch(/held=\d+\n1\n/);
    expect(existsSync(join(t, `podium-db-lock-${process.getuid?.() ?? 0}`))).toBe(false);
  });
});
