// scripts/test-db.sh (#823): which containers it starts, the variables it sets, PODIUM_TEST_ONLY and --image, and that it
// removes every container however the run ends. A copy of the script runs in a temp repository with a fake container engine and a fake
// npx, so nothing starts a container here; the real runs (every adapter's server suite on PostgreSQL and MariaDB) are in the PR for #823.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DB_ADAPTERS } from "./db-adapters.mjs";

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

// npx: writes what vitest would have been given (its arguments, the folder and the variables) and exits $FAKE_CODE.
const FAKE_NPX = `#!/usr/bin/env bash
{ echo "args=$*"; echo "pwd=$(pwd)"; echo "PG=\${PODIUM_TEST_PG:-}"; echo "MARIADB=\${PODIUM_TEST_MARIADB:-}"; echo "ONLY=\${PODIUM_TEST_ONLY:-}"; } > "$FAKE_DIR/vitest"
exit "\${FAKE_CODE:-0}"
`;

function run(args: string[], env: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "testdb-")));
  made.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "server"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "state"));
  for (const f of ["test-db.sh", "db-adapters.mjs"]) copyFileSync(join(REPO, "scripts", f), join(root, "scripts", f));
  writeFileSync(join(root, "bin", "engine"), FAKE_ENGINE);
  writeFileSync(join(root, "bin", "npx"), FAKE_NPX);
  chmodSync(join(root, "bin", "engine"), 0o755);
  chmodSync(join(root, "bin", "npx"), 0o755);
  const state = join(root, "state");
  // A clean environment: the suite running this test may itself have the test server variables set.
  const r = spawnSync("bash", [join(root, "scripts", "test-db.sh"), ...args], {
    encoding: "utf8",
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: process.env.HOME ?? "", CONTAINER_ENGINE: join(root, "bin", "engine"), FAKE_DIR: state, ...env },
  });
  const read = (f: string) => (existsSync(join(state, f)) ? readFileSync(join(state, f), "utf8") : "");
  const vitest = Object.fromEntries(read("vitest").trim().split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const calls = read("calls").trim().split("\n").filter(Boolean);
  const left = readdirSync(state).filter((f) => f.startsWith("c-"));
  return { ...r, root, vitest, calls, left, runs: calls.filter((c) => c.startsWith("run ")) };
}

const image = (kind: string) => DB_ADAPTERS.find((a) => a.kind === kind)!.test!.image;

describe("test-db.sh", () => {
  it("prints its help", () => {
    const r = spawnSync("bash", [join(REPO, "scripts", "test-db.sh"), "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("--floor");
    for (const word of ["PostgreSQL 17", "MariaDB 11.4", "--image KIND=REF", "PODIUM_TEST_ONLY", "NOT RUN", "db-adapters.mjs"]) expect(r.stdout).toContain(word);
  });

  it("starts every database server at once, sets each variable, runs vitest in server/ with the arguments, and removes the containers", () => {
    const r = run(["src/storage/adapters.test.ts", "-t", "contract"], { FAKE_CODE: "3" });
    expect(r.status).toBe(3);
    expect(r.runs).toHaveLength(2);
    expect(r.runs[0]).toContain(image("postgres"));
    expect(r.runs[1]).toContain(image("mariadb"));
    // Both are started before the first is waited for.
    expect(r.calls.findIndex((c) => c.startsWith("exec "))).toBeGreaterThan(r.calls.lastIndexOf(r.runs[1]));
    expect(r.vitest).toMatchObject({
      args: "vitest run src/storage/adapters.test.ts -t contract",
      pwd: join(r.root, "server"),
      PG: "postgres://postgres:change-me@127.0.0.1:41001/postgres",
      MARIADB: "mariadb://root:change-me@127.0.0.1:41002/podium_test",
      ONLY: "",
    });
    expect(r.left).toEqual([]);
    expect(r.stdout.trim().split("\n").pop()).toBe("test-db: every adapter had its server: sqlite postgres mariadb");
  });

  it("publishes each container's port on 127.0.0.1 only", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    for (const c of r.runs) expect(c).toMatch(/ -p 127\.0\.0\.1::\d+ /);
  });

  it("uses the one image --image names for a kind, and the tested one for the others", () => {
    const own = run(["--image", "mariadb=example.org/mariadb:99", "--", "-t", "x"]);
    expect(own.runs.join("\n")).toContain("example.org/mariadb:99");
    expect(own.runs.join("\n")).toContain(image("postgres"));
    expect(own.vitest.args).toBe("vitest run -t x");
    expect(run(["--image", "mariadb"]).status).toBe(2);
  });

  it("starts only the kinds PODIUM_TEST_ONLY names, passes it on, and says the run is limited and what was NOT RUN", () => {
    const r = run([], { PODIUM_TEST_ONLY: "sqlite,postgres" });
    expect(r.status).toBe(0);
    expect(r.runs).toHaveLength(1);
    expect(r.vitest).toMatchObject({ PG: expect.stringContaining("41001"), MARIADB: "", ONLY: "sqlite,postgres" });
    expect(r.stdout).toMatch(/LIMITED by PODIUM_TEST_ONLY=sqlite,postgres\. Servers started: postgres\. NOT RUN: mariadb\. A limited run is not a pass/);
  });

  it("refuses a kind PODIUM_TEST_ONLY names that does not exist, before it starts anything", () => {
    const r = run([], { PODIUM_TEST_ONLY: "sqlite,mysql" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/"mysql", which is not a storage kind/);
    expect(r.runs).toEqual([]);
  });

  it("exits 2 and removes every container when a database does not answer, and runs no test", () => {
    const r = run([], { FAKE_NOT_READY: "mariadb" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/MariaDB did not answer/);
    expect(r.vitest).toEqual({});
    expect(r.left).toEqual([]);
  });

  it("exits 2 when the engine is not usable", () => {
    const r = run([], { FAKE_INFO: "1" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/is not usable/);
    expect(r.runs).toEqual([]);
  });
});
