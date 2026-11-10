// scripts/e2e-all.sh --shards N (#1130): the run names, the result line, the exit codes and the spec count check. A copy of the script
// runs in a temp repository whose scripts/e2e-up.sh is a fake that prints a Cypress summary and exits as told, so nothing starts a
// container. The real runs are in the PR for #1130.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

// The fake: `build` exits $FAKE_BUILD; `run` takes its name from --out, counts the specs in --spec (or every spec when there is none),
// prints that as Cypress would, records its arguments and exits with the code $FAKE_CODES gives its name (for example "sqlite.2=1").
const FAKE_UP = `#!/usr/bin/env bash
cmd="$1"; shift; all="$*"
if [ "$cmd" = build ]; then echo "fake build $all"; exit "\${FAKE_BUILD:-0}"; fi
out=""; spec=""
while [ $# -gt 0 ]; do
  case "$1" in --out) out="$2"; shift 2 ;; --spec) spec="$2"; shift 2 ;; *) shift ;; esac
done
name="$(basename "$out")"
mkdir -p "$out"
echo "$E2E_DB $cmd $all" > "$out/args"
if [ -n "$spec" ]; then n=$(echo "$spec" | tr ',' '\\n' | wc -l | tr -d ' '); else n=$(find "$(dirname "$0")/../e2e/cypress/e2e" -name '*.cy.js' | wc -l | tr -d ' '); fi
n=$((n - \${FAKE_DROP:-0}))
code=0
for pair in \${FAKE_CODES:-}; do [ "\${pair%%=*}" = "$name" ] && code="\${pair#*=}"; done
[ "$code" = 2 ] && { echo "e2e: FAIL  the server did not answer"; exit 2; }
echo "  │ Specs:          $n found (x.cy.js)   │"
if [ "$code" = 0 ]; then
  echo "    ✔  All specs passed!                        01:00      $((n * 2))      $((n * 2))        -        -        -"
else
  echo "    ✖  1 of $n failed (10%)                      01:00      $((n * 2))      $((n * 2 - 1))        1        -        -"
fi
exit "$code"
`;

/** A temp repository: the real e2e-all.sh and e2e-shards.mjs, the fake e2e-up.sh, the e2e.yml DATABASES line and five specs. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "e2eall-")));
  made.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(REPO, "scripts", "e2e-all.sh"), join(root, "scripts", "e2e-all.sh"));
  copyFileSync(join(REPO, "scripts", "e2e-shards.mjs"), join(root, "scripts", "e2e-shards.mjs"));
  writeFileSync(join(root, "scripts", "e2e-up.sh"), FAKE_UP);
  chmodSync(join(root, "scripts", "e2e-up.sh"), 0o755);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "e2e.yml"), "          DATABASES: ${{ inputs.databases || 'sqlite postgres' }}\n");
  for (const s of ["a/one", "a/two", "b/three", "b/four", "c/five"]) {
    mkdirSync(join(root, "e2e", "cypress", "e2e", dirname(s)), { recursive: true });
    writeFileSync(join(root, "e2e", "cypress", "e2e", `${s}.cy.js`), "it('x');\n");
  }
  const out = realpathSync(mkdtempSync(join(tmpdir(), "e2eall-out-")));
  made.push(out);
  return { root, out };
}

function run(args: string[], env: Record<string, string> = {}, prepare?: (root: string) => void) {
  const { root, out } = repo();
  prepare?.(root);
  const r = spawnSync("bash", [join(root, "scripts", "e2e-all.sh"), "--out", out, ...args], {
    encoding: "utf8",
    env: { ...process.env, E2E_ENGINE: "none", ...env },
  });
  const last = r.stdout.trim().split("\n").pop();
  return { ...r, last, out };
}

describe("e2e-all.sh", () => {
  it("prints its help, with the shard option and how to choose a count", () => {
    const r = spawnSync("bash", [join(REPO, "scripts", "e2e-all.sh"), "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const word of ["--shards N", "Choosing --shards", "E2E RESULT: PASS|FAIL sqlite.1=PASS", "e2e/spec-times.json", "--record"]) expect(r.stdout).toContain(word);
  });

  it("keeps today's names, folders and result line with one shard, and builds once", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.last).toBe("E2E RESULT: PASS sqlite=PASS postgres=PASS");
    expect(existsSync(join(r.out, "sqlite.log")) && existsSync(join(r.out, "postgres", "args"))).toBe(true);
    expect(readFileSync(join(r.out, "build.log"), "utf8")).toBe("fake build \n");
    expect(readFileSync(join(r.out, "sqlite", "args"), "utf8")).toBe(`sqlite run --no-build --out ${r.out}/sqlite\n`);
    expect(r.stdout).toContain("e2e-all: sqlite: 5 specs, 10 tests (10 passing, 0 failing) over 1 shard(s)");
  });

  it("runs every database in N shards whose specs add up to the files on disk", () => {
    const r = run(["--shards", "3"]);
    expect(r.status).toBe(0);
    expect(r.last).toBe("E2E RESULT: PASS sqlite.1=PASS sqlite.2=PASS sqlite.3=PASS postgres.1=PASS postgres.2=PASS postgres.3=PASS");
    expect(r.stdout).toContain("e2e-all: postgres: 5 specs, 10 tests (10 passing, 0 failing) over 3 shard(s)");
    const specs = [1, 2, 3].flatMap((k) => readFileSync(join(r.out, `sqlite.${k}`, "args"), "utf8").trim().split(" ").pop()!.split(","));
    expect(specs.sort()).toEqual(["cypress/e2e/a/one.cy.js", "cypress/e2e/a/two.cy.js", "cypress/e2e/b/four.cy.js", "cypress/e2e/b/three.cy.js", "cypress/e2e/c/five.cy.js"]);
  });

  it("prints each shard's spec count and weight before the runs, and says when there are no recorded times", () => {
    const r = run(["--shards", "2", "--databases", "sqlite"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("e2e-shards: shard 1: 3 specs, 3 (tests and restarts, not seconds)");
    expect(r.stderr).toContain("e2e-shards: shard 2: 2 specs, 2 (tests and restarts, not seconds)");
    expect(r.stderr).toContain("there is no e2e/spec-times.json");
  });

  it("fails with exit 1 and names the shard whose spec failed, and prints its log tail", () => {
    const r = run(["--shards", "2"], { FAKE_CODES: "postgres.2=1" });
    expect(r.status).toBe(1);
    expect(r.last).toBe("E2E RESULT: FAIL sqlite.1=PASS sqlite.2=PASS postgres.1=PASS postgres.2=FAIL(1)");
    expect(r.stdout).toContain(`--- postgres.2 (exit 1), last lines of ${r.out}/postgres.2.log:`);
    expect(r.stdout).toContain("1 of ");
  });

  it("exits 2, never a pass, when a shard could not start", () => {
    const r = run(["--shards", "2"], { FAKE_CODES: "sqlite.1=2 postgres.1=1" });
    expect(r.status).toBe(2);
    expect(r.last).toBe("E2E RESULT: FAIL sqlite.1=FAIL(2) sqlite.2=PASS postgres.1=FAIL(1) postgres.2=PASS");
    expect(r.stdout).toContain("counts not read from every log");
  });

  it("fails a database whose runs passed but ran fewer specs than are on disk", () => {
    const r = run(["--databases", "sqlite"], { FAKE_DROP: "1" });
    expect(r.status).toBe(1);
    expect(r.last).toBe("E2E RESULT: FAIL sqlite=PASS sqlite.specs=FAIL(4/5)");
  });

  it("exits 2 when the spec files cannot be listed, not a spec count of 0", () => {
    const r = run(["--databases", "sqlite"], {}, (root) => writeFileSync(join(root, "scripts", "e2e-shards.mjs"), "process.exit(1);\n"));
    expect(r.status).toBe(2);
    expect(r.last).toBe("E2E RESULT: FAIL setup=FAIL(2)");
    expect(r.stderr).toContain("could not list the spec files");
  });

  it("does not check the spec count of a one-shard run limited by --spec", () => {
    const r = run(["--databases", "sqlite", "--", "--spec", "cypress/e2e/a/one.cy.js"]);
    expect(r.status).toBe(0);
    expect(r.last).toBe("E2E RESULT: PASS sqlite=PASS");
  });

  it("exits 2 when the build fails, and starts no run", () => {
    const r = run([], { FAKE_BUILD: "2" });
    expect(r.status).toBe(2);
    expect(r.last).toBe("E2E RESULT: FAIL build=FAIL(2)");
    expect(existsSync(join(r.out, "sqlite.log"))).toBe(false);
  });

  it("skips the build with --no-build, but still checks the images once", () => {
    const r = run(["--no-build", "--databases", "sqlite"]);
    expect(r.status).toBe(0);
    expect(readFileSync(join(r.out, "build.log"), "utf8")).toContain("fake build --no-build");
    expect(readFileSync(join(r.out, "sqlite", "args"), "utf8")).toBe(`sqlite run --no-build --out ${r.out}/sqlite\n`);
  });

  it("exits 2 rather than looping when an option has no value", () => {
    for (const flag of ["--shards", "--databases", "--out"]) {
      const r = spawnSync("bash", [join(REPO, "scripts", "e2e-all.sh"), flag], { encoding: "utf8", timeout: 10_000 });
      expect(r.status, flag).toBe(2);
      expect(r.stderr).toContain(`${flag} needs a value`);
    }
  });

  it("refuses a bad shard count, --spec with shards, and more shards than specs, with exit 2", () => {
    for (const args of [["--shards", "0"], ["--shards", "two"], ["--shards", "2", "--", "--spec", "x"], ["--shards", "9"]]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(2);
    }
  });

  it("ends a setup error found after the arguments with the result line, and starts no run", () => {
    const r = run(["--shards", "9"]);
    expect(r.status).toBe(2);
    expect(r.last).toBe("E2E RESULT: FAIL setup=FAIL(2)");
    expect(r.stderr).toContain("9 shards is more than the 5 spec files");
    expect(existsSync(join(r.out, "build.log"))).toBe(false);
  });
});
