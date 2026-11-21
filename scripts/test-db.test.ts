// `npm run test:db` (#1294, #823): scripts/test-db.mjs and the container helper it runs, scripts/db-servers.sh. Which containers start, the variables set,
// --db, --scope, --shards, --out, --image and the vitest arguments, the DB TEST RESULT line, the LIMITED notice, and that every container is removed however
// the run ends. Copies of the scripts run in a temp repository with a fake container engine and a fake npx, so nothing starts a container here; the real
// runs (every adapter's server suite on PostgreSQL and MariaDB) are in the PR for #1294.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DB_ADAPTERS } from "./db-adapters.mjs";
import { adapterFilters, kindOfTest, main, parseArgs, resultLines, runLogged, summarize } from "./test-db.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

// The engine: `run` records its arguments and marks the container as there; `port` answers a port per kind; `exec` (the readiness check)
// passes unless $FAKE_NOT_READY names the kind, which also stops that container; `rm` removes the mark. Every call is logged.
const FAKE_ENGINE = `#!/usr/bin/env bash
dir="$FAKE_DIR"; echo "$*" >> "$dir/calls"
kind() { echo "$1" | sed 's/^podium-test-\\(.*\\)-[0-9]*$/\\1/'; }
case "$1" in
  info) exit "\${FAKE_INFO:-0}" ;;
  run) shift; name=""; while [ $# -gt 0 ]; do case "$1" in --name) name="$2"; shift 2 ;; *) shift ;; esac; done
       touch "$dir/c-$name"; echo "id-$name" ;;
  port) case "$(kind "$2")" in postgres) echo "127.0.0.1:41001" ;; mariadb) echo "127.0.0.1:41002" ;; *) echo "127.0.0.1:41009" ;; esac ;;
  exec) [ "$(kind "$2")" = "\${FAKE_NOT_READY:-}" ] && exit 1; exit 0 ;;
  inspect) [ -f "$dir/c-\${!#}" ] || exit 1; [ "$(kind "\${!#}")" = "\${FAKE_NOT_READY:-}" ] && { echo false; exit 0; }; echo true ;;
  logs) echo "fake log line" ;;
  rm) rm -f "$dir/c-$3" ;;
esac
exit 0
`;

// npx: appends what vitest would have been given (its arguments, the folder and the variables) to a file, writes the JSON report it is asked for
// (--outputFile.json=PATH) from $FAKE_REPORT, and exits $FAKE_CODE.
const FAKE_NPX = `#!/usr/bin/env bash
{ echo "args=$*"; echo "pwd=$(pwd)"; echo "PG=\${PODIUM_TEST_PG:-}"; echo "MARIADB=\${PODIUM_TEST_MARIADB:-}"; echo "ONLY=\${PODIUM_TEST_ONLY:-}"; } >> "$FAKE_DIR/vitest"
for a in "$@"; do case "$a" in --outputFile.json=*) [ -n "\${FAKE_REPORT:-}" ] && echo "$FAKE_REPORT" > "\${a#--outputFile.json=}" ;; esac; done
exit "\${FAKE_CODE:-0}"
`;

const file = (name: string, status = "passed", titles: string[] = []) => ({ name, status, assertionResults: [{ status, ancestorTitles: titles, title: "t" }, { status: "passed", ancestorTitles: titles, title: "u" }] });
const REPORT = JSON.stringify({
  testResults: [
    file("/r/server/src/a.test.ts"),
    file("/r/server/src/storage/postgres/p.test.ts"),
    file("/r/server/src/storage/mariadb/m.test.ts"),
    file("/r/server/src/storage/adapters.test.ts", "passed", ["the registered adapters", "storage contract", "postgres"]),
  ],
});

function run(args: string[], env: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "testdb-")));
  made.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "server"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "state"));
  for (const f of ["test-db.mjs", "db-servers.sh", "db-lock.sh", "db-adapters.mjs"]) copyFileSync(join(REPO, "scripts", f), join(root, "scripts", f));
  writeFileSync(join(root, "bin", "engine"), FAKE_ENGINE);
  writeFileSync(join(root, "bin", "npx"), FAKE_NPX);
  chmodSync(join(root, "bin", "engine"), 0o755);
  chmodSync(join(root, "bin", "npx"), 0o755);
  const state = join(root, "state");
  const out = join(root, "out");
  // A clean environment: the suite running this test may itself have the test server variables set.
  const r = spawnSync("node", [join(root, "scripts", "test-db.mjs"), "--out", out, ...args], {
    encoding: "utf8",
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: process.env.HOME ?? "", CONTAINER_ENGINE: join(root, "bin", "engine"), FAKE_DIR: state, PODIUM_DB_LOCK: "off", FAKE_REPORT: REPORT, ...env },
  });
  const read = (f: string) => (existsSync(join(state, f)) ? readFileSync(join(state, f), "utf8") : "");
  const vitestRuns = read("vitest").trim().split("\n").filter(Boolean).reduce<Record<string, string>[]>((acc, l) => {
    const k = l.slice(0, l.indexOf("="));
    if (k === "args") acc.push({});
    acc[acc.length - 1][k] = l.slice(l.indexOf("=") + 1);
    return acc;
  }, []);
  const calls = read("calls").trim().split("\n").filter(Boolean);
  const left = readdirSync(state).filter((f) => f.startsWith("c-"));
  const lastLine = r.stdout.trim().split("\n").filter((l) => l.startsWith("DB TEST RESULT:"))[0];
  return { ...r, root, out, vitestRuns, vitest: vitestRuns[0] ?? {}, calls, left, runs: calls.filter((c) => c.startsWith("run ")), result: lastLine };
}

const image = (kind: string) => DB_ADAPTERS.find((a) => a.kind === kind)!.test!.image;

describe("test-db.mjs arguments", () => {
  const known = ["sqlite", "postgres", "mariadb"];
  it("defaults to every kind, the whole config and one shard", () => {
    expect(parseArgs([], {}, known)).toMatchObject({ dbs: known, limited: false, scope: "all", shards: 1, pass: [], images: [] });
  });

  it("reads --db space or comma separated, and PODIUM_TEST_ONLY when --db is not given", () => {
    expect(parseArgs(["--db", "sqlite postgres"], {}, known)).toMatchObject({ dbs: ["sqlite", "postgres"], limited: true });
    expect(parseArgs(["--db", "sqlite,mariadb"], {}, known)).toMatchObject({ dbs: ["sqlite", "mariadb"] });
    expect(parseArgs([], { PODIUM_TEST_ONLY: "sqlite,postgres" }, known)).toMatchObject({ dbs: ["sqlite", "postgres"], limited: true });
    expect(parseArgs(["--db", "mariadb"], { PODIUM_TEST_ONLY: "sqlite" }, known)).toMatchObject({ dbs: ["mariadb"] });
  });

  it("refuses an unknown or repeated kind, an empty list, bad values and unknown long options", () => {
    expect(parseArgs(["--db", "mysql"], {}, known)).toEqual({ error: expect.stringMatching(/"mysql", which is not a storage kind/) });
    expect(parseArgs(["--db", "sqlite sqlite"], {}, known)).toEqual({ error: expect.stringMatching(/twice/) });
    expect(parseArgs(["--db", " "], {}, known)).toEqual({ error: expect.stringMatching(/at least one/) });
    expect(parseArgs([], { PODIUM_TEST_ONLY: "oracle" }, known)).toEqual({ error: expect.stringMatching(/PODIUM_TEST_ONLY names "oracle"/) });
    expect(parseArgs(["--shards", "0"], {}, known)).toEqual({ error: expect.stringMatching(/whole number/) });
    expect(parseArgs(["--scope", "some"], {}, known)).toEqual({ error: expect.stringMatching(/adapters or all/) });
    expect(parseArgs(["--image", "mariadb"], {}, known)).toEqual({ error: "--image needs KIND=REF" });
    expect(parseArgs(["--image", "mysql=x:1"], {}, known)).toEqual({ error: expect.stringMatching(/"mysql"/) });
    expect(parseArgs(["--dbb", "x"], {}, known)).toEqual({ error: expect.stringMatching(/unknown option --dbb/) });
    expect(parseArgs(["--db"], {}, known)).toEqual({ error: expect.stringMatching(/needs a value/) });
  });

  it("passes everything after -- to vitest, and, as npm drops the first --, everything from the first argument that is not a long option", () => {
    expect(parseArgs(["--db", "sqlite", "--", "--db", "x"], {}, known)).toMatchObject({ pass: ["--db", "x"] });
    expect(parseArgs(["--shards", "2", "src/a.test.ts", "-t", "contract"], {}, known)).toMatchObject({ shards: 2, pass: ["src/a.test.ts", "-t", "contract"] });
  });

  it("answers --help", () => {
    expect(parseArgs(["-h"], {}, known)).toEqual({ help: true });
  });
});

describe("test-db.mjs reading a run", () => {
  const known = ["sqlite", "postgres", "mariadb"];
  it("counts a test for the database whose folder it is in, whose kind or label a describe title names, and else for sqlite", () => {
    expect(kindOfTest("/r/server/src/storage/postgres/p.test.ts", [], known)).toBe("postgres");
    expect(kindOfTest("/r/server/src/storage/adapters.test.ts", ["storage contract", "mariadb"], known)).toBe("mariadb");
    expect(kindOfTest("/r/server/src/fleet/chatGoneReadsPg.test.ts", ["Chat over PostgreSQL"], known)).toBe("postgres");
    expect(kindOfTest("/r/server/src/a.test.ts", ["something"], known)).toBe("sqlite");
  });

  it("sums files, tests and failures per database, skips skipped tests and counts a suite that failed to load as one failure", () => {
    const rep = {
      testResults: [
        file("/r/server/src/a.test.ts"),
        file("/r/server/src/storage/postgres/p.test.ts", "failed"),
        { name: "/r/server/src/storage/mariadb/m.test.ts", status: "failed", assertionResults: [] },
        { name: "/r/server/src/b.test.ts", status: "passed", assertionResults: [{ status: "skipped", ancestorTitles: [] }, { status: "passed", ancestorTitles: [] }] },
      ],
    };
    expect(summarize([rep], known, known)).toEqual({
      sqlite: { files: 2, tests: 3, failed: 0 },
      postgres: { files: 1, tests: 2, failed: 1 },
      mariadb: { files: 1, tests: 0, failed: 1 },
    });
    expect(Object.keys(summarize([rep], ["sqlite"], known))).toEqual(["sqlite"]);
  });

  it("names each database in the result line, and says LIMITED with what was NOT RUN", () => {
    const sums = { sqlite: { files: 2, tests: 10, failed: 0 }, postgres: { files: 1, tests: 5, failed: 1 } };
    const full = resultLines({ ...sums, mariadb: { files: 1, tests: 4, failed: 0 } }, known, known, false, 1);
    expect(full[0]).toBe("DB TEST RESULT: sqlite=PASS postgres=FAIL(1) mariadb=PASS".replace("sqlite=PASS", "sqlite=FAIL(0)").replace("mariadb=PASS", "mariadb=FAIL(0)"));
    expect(resultLines({ ...sums, mariadb: { files: 1, tests: 4, failed: 0 } }, known, known, false, 0)[0]).toMatch(/^DB TEST RESULT: sqlite=PASS postgres=FAIL\(1\) mariadb=PASS$/);
    const limited = resultLines(sums, known, ["sqlite", "postgres"], true, 0);
    expect(limited[0]).toBe("DB TEST RESULT: sqlite=PASS postgres=FAIL(1) mariadb=NOT RUN");
    expect(limited).toContain("  postgres: 1 files, 5 tests, 1 failed");
    expect(limited.at(-1)).toBe("LIMITED to sqlite postgres. NOT RUN: mariadb. A limited run is not a pass for a pull request.");
  });

  it("filters --scope adapters to the chosen server kinds' folders, the shared adapter test and the chatGoneReads files", () => {
    expect(adapterFilters(["sqlite", "postgres"], known, ["postgres", "mariadb"])).toEqual(["storage/postgres/", "storage/adapters.test", "chatGoneReads"]);
    expect(adapterFilters(known, known, ["postgres", "mariadb"])).toEqual(["storage/postgres/", "storage/mariadb/", "storage/adapters.test", "chatGoneReads"]);
  });
});

describe("npm run test:db", () => {
  it("prints its help", () => {
    const r = spawnSync("node", [join(REPO, "scripts", "test-db.mjs"), "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const word of ["PostgreSQL 17", "MariaDB 11.4", "--image KIND=REF", "--scope adapters|all", "--shards N", "--out DIR", "PODIUM_TEST_ONLY", "NOT RUN", "DB TEST RESULT"]) expect(r.stdout).toContain(word);
    expect(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts["test:db"]).toBe("node scripts/test-db.mjs");
  });

  it("no longer has scripts/test-db.sh", () => {
    expect(existsSync(join(REPO, "scripts", "test-db.sh"))).toBe(false);
  });

  it("starts every database server at once, sets each variable, runs vitest in server/ with the arguments and a JSON report, removes the containers, and ends with the result line", () => {
    const r = run(["src/storage/adapters.test.ts", "-t", "contract"], { FAKE_CODE: "1" });
    expect(r.status).toBe(1);
    expect(r.runs).toHaveLength(2);
    expect(r.runs[0]).toContain(image("postgres"));
    expect(r.runs[1]).toContain(image("mariadb"));
    // Both are started before the first is waited for.
    expect(r.calls.findIndex((c) => c.startsWith("exec "))).toBeGreaterThan(r.calls.lastIndexOf(r.runs[1]));
    expect(r.vitest).toMatchObject({
      pwd: join(r.root, "server"),
      PG: "postgres://postgres:change-me@127.0.0.1:41001/postgres",
      MARIADB: "mariadb://root:change-me@127.0.0.1:41002/podium_test",
      ONLY: "",
    });
    expect(r.vitest.args).toBe(`vitest run src/storage/adapters.test.ts -t contract --reporter=default --reporter=json --outputFile.json=${join(r.out, "report-1.json")}`);
    expect(r.left).toEqual([]);
    expect(r.result).toBe("DB TEST RESULT: sqlite=FAIL(0) postgres=FAIL(0) mariadb=FAIL(0)");
  });

  it("ends with a PASS per database and each one's files and tests when vitest passes", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.result).toBe("DB TEST RESULT: sqlite=PASS postgres=PASS mariadb=PASS");
    expect(r.stdout).toContain("  sqlite: 1 files, 2 tests");
    expect(r.stdout).toContain("  postgres: 2 files, 4 tests");
    expect(r.stdout).toContain("  mariadb: 1 files, 2 tests");
    expect(r.stdout).not.toContain("LIMITED");
    expect(readFileSync(join(r.out, "vitest.log"), "utf8")).toContain("test-db: servers started: postgres mariadb");
    expect(existsSync(join(r.out, "report-1.json"))).toBe(true);
  });

  it("publishes each container's port on 127.0.0.1 only", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    for (const c of r.runs) expect(c).toMatch(/ -p 127\.0\.0\.1::\d+ /);
    for (const c of r.runs) expect(c).toContain("--label dev.podium.test-db=");
  });

  it("uses the one image --image names for a kind, and the tested one for the others", () => {
    const own = run(["--image", "mariadb=example.org/mariadb:99", "--", "-t", "x"]);
    expect(own.runs.join("\n")).toContain("example.org/mariadb:99");
    expect(own.runs.join("\n")).toContain(image("postgres"));
    expect(own.vitest.args).toMatch(/^vitest run -t x /);
    expect(run(["--image", "mariadb"]).status).toBe(2);
  });

  it("starts only the servers --db names, passes the list on, and says the run is limited and what was NOT RUN", () => {
    const r = run(["--db", "sqlite postgres"]);
    expect(r.status).toBe(0);
    expect(r.runs).toHaveLength(1);
    expect(r.vitest).toMatchObject({ PG: expect.stringContaining("41001"), MARIADB: "", ONLY: "sqlite,postgres" });
    expect(r.result).toBe("DB TEST RESULT: sqlite=PASS postgres=PASS mariadb=NOT RUN");
    expect(r.stdout).toMatch(/LIMITED to sqlite postgres\. NOT RUN: mariadb\. A limited run is not a pass for a pull request\./);
  });

  it("limits the run by PODIUM_TEST_ONLY the same way when --db is not given", () => {
    const r = run([], { PODIUM_TEST_ONLY: "sqlite,mariadb" });
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toContain(image("mariadb"));
    expect(r.stdout).toMatch(/NOT RUN: postgres\./);
  });

  it("with --scope adapters runs only the files that depend on a database server for the kinds chosen", () => {
    const r = run(["--db", "sqlite postgres", "--scope", "adapters"]);
    expect(r.status).toBe(0);
    expect(r.vitest.args).toMatch(/^vitest run storage\/postgres\/ storage\/adapters\.test chatGoneReads --reporter=default/);
    expect(r.vitest.args).not.toContain("storage/mariadb/");
    expect(r.stdout).toMatch(/NOT RUN: mariadb\./);
  });

  it("with --scope all gives vitest no file filter", () => {
    expect(run([]).vitest.args).toMatch(/^vitest run --reporter=default/);
  });

  it("runs each shard one after another on the same containers", () => {
    const r = run(["--shards", "2"]);
    expect(r.status).toBe(0);
    expect(r.runs).toHaveLength(2);
    expect(r.vitestRuns.map((v) => v.args.match(/--shard=\S+/)![0])).toEqual(["--shard=1/2", "--shard=2/2"]);
    expect(r.vitestRuns.map((v) => v.args.match(/report-\d\.json/)![0])).toEqual(["report-1.json", "report-2.json"]);
    expect(r.stdout).toMatch(/2 shards \(--shards was given\)/);
  });

  it("prints the shard count it used and why when it is the default", () => {
    expect(run([]).stdout).toMatch(/1 shard \(a full run takes minutes, so sharding is opt-in\)/);
  });

  it("exits with the worst shard's code", () => {
    expect(run(["--shards", "2"], { FAKE_CODE: "1" }).status).toBe(1);
  });

  it("refuses a bad --db before it starts anything", () => {
    for (const bad of ["mysql", "sqlite sqlite"]) {
      const r = run(["--db", bad]);
      expect(r.status).toBe(2);
      expect(r.runs).toEqual([]);
      expect(r.calls).toEqual([]);
    }
  });

  it("exits 2 and removes every container when a database does not answer, and runs no test", () => {
    const r = run([], { FAKE_NOT_READY: "mariadb" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/MariaDB did not answer/);
    expect(r.vitestRuns).toEqual([]);
    expect(r.left).toEqual([]);
  });

  it("exits 2 when the engine is not usable", () => {
    const r = run([], { FAKE_INFO: "1" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/is not usable/);
    expect(r.runs).toEqual([]);
  });

  it("never reports a run with no vitest report as a pass", () => {
    const r = run([], { FAKE_REPORT: "", FAKE_CODE: "1" });
    expect(r.status).toBe(2);
  });
});

describe("db-servers.sh", () => {
  it("prints its help", () => {
    const r = spawnSync("bash", [join(REPO, "scripts", "db-servers.sh"), "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dev.podium.test-db");
  });

  it("needs a command", () => {
    const r = spawnSync("bash", [join(REPO, "scripts", "db-servers.sh"), "--kinds", "sqlite"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no command/);
  });
});

describe("test-db.mjs in process", () => {
  // A runner that stands in for db-servers.sh: it writes the report each shard is asked for (the paths are in the bash -c script) and answers `code`.
  const fake = (report: object | undefined, code: number, seen: { args?: string[]; env?: NodeJS.ProcessEnv } = {}) => async (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    seen.args = args;
    seen.env = opts.env;
    if (report) for (const m of args.at(-1)!.matchAll(/--outputFile\.json=(\S+?)'/g)) writeFileSync(m[1], JSON.stringify(report));
    return code;
  };
  const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "testdb-main-"))); made.push(d); return d; };
  const capture = async (f: () => Promise<number>) => {
    let out = "";
    let err = "";
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
    try { return { code: await f(), out, err }; } finally { process.stdout.write = o; process.stderr.write = e; }
  };

  it("prints help and refuses bad arguments without running anything", async () => {
    let ran = false;
    const exec = async () => { ran = true; return 0; };
    expect((await capture(() => main(["--help"], {}, exec))).out).toContain("DB TEST RESULT");
    const bad = await capture(() => main(["--db", "mysql"], {}, exec));
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/not a storage kind/);
    expect(ran).toBe(false);
  });

  it("runs db-servers.sh with the kinds that have a server, the images and the vitest command, and drops PODIUM_TEST_ONLY unless the run is limited", async () => {
    const seen: { args?: string[]; env?: NodeJS.ProcessEnv } = {};
    const r = await capture(() => main(["--db", "sqlite postgres", "--image", "postgres=x/pg:1", "--out", tmp()], { PATH: "p" }, fake(JSON.parse(REPORT), 0, seen)));
    expect(r.code).toBe(0);
    expect(seen.args!.slice(1, 7)).toEqual(["--kinds", "postgres", "--image", "postgres=x/pg:1", "--", "bash"]);
    expect(seen.env!.PODIUM_TEST_ONLY).toBe("sqlite,postgres");
    expect(r.out).toContain("DB TEST RESULT: sqlite=PASS postgres=PASS mariadb=NOT RUN");
    const full = { env: undefined as NodeJS.ProcessEnv | undefined };
    await capture(() => main(["--out", tmp()], { PODIUM_TEST_ONLY: "" }, async (_c, _a, o: { env: NodeJS.ProcessEnv }) => { full.env = o.env; return 0; }));
    expect("PODIUM_TEST_ONLY" in full.env!).toBe(false);
  });

  it("reads one report per shard and exits with the worst code", async () => {
    const out = tmp();
    const r = await capture(() => main(["--shards", "2", "--out", out], {}, fake(JSON.parse(REPORT), 1)));
    expect(r.code).toBe(1);
    expect(existsSync(join(out, "report-2.json"))).toBe(true);
    expect(r.out).toMatch(/sqlite: 2 files, 4 tests/);
  });

  it("turns a run that left no report into a setup error, but keeps an interrupt as 130", async () => {
    expect((await capture(() => main(["--out", tmp()], {}, fake(undefined, 1)))).code).toBe(2);
    expect((await capture(() => main(["--out", tmp()], {}, fake(undefined, 130)))).code).toBe(130);
    expect((await capture(() => main(["--out", tmp()], {}, fake(undefined, 3)))).code).toBe(3);
  });

  it("ignores a report that is not JSON", async () => {
    const out = tmp();
    const exec = async () => { writeFileSync(join(out, "report-1.json"), "{not json"); return 1; };
    expect((await capture(() => main(["--out", out], {}, exec))).code).toBe(2);
  });

  it("runLogged forwards a command's output, writes it to the log and returns its exit code", async () => {
    const d = tmp();
    const log = join(d, "log");
    writeFileSync(log, "");
    const r = await capture(() => runLogged("node", ["-e", "console.log('hi'); console.error('oops'); process.exit(4)"], { env: process.env }, log));
    expect(r.code).toBe(4);
    expect(r.out).toContain("hi");
    expect(r.err).toContain("oops");
    expect(readFileSync(log, "utf8")).toContain("hi");
    expect((await capture(() => runLogged("/no/such/command-xyz", [], { env: process.env }, log))).code).toBe(2);
  });
});
