import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(__dirname, "ci-retry.sh");
const hasTimeout = spawnSync("timeout", ["1", "true"]).status === 0; // GNU coreutils; CI runs Linux

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-retry-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A fake command: counts its runs in a file and exits with the code for that run (the last code repeats).
function fake(codes: number[]): string {
  const counter = join(dir, "count");
  writeFileSync(counter, "0");
  const path = join(dir, "fake.sh");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
n=$(( $(cat "${counter}") + 1 )); echo $n > "${counter}"
codes=(${codes.join(" ")})
i=$(( n - 1 )); [ $i -ge \${#codes[@]} ] && i=$(( \${#codes[@]} - 1 ))
echo "fake run $n"; echo "FAIL some test name"
exit \${codes[$i]}
`,
    { mode: 0o755 },
  );
  return path;
}

function run(codes: number[], extra: string[] = []) {
  const cmd = fake(codes);
  const summary = join(dir, "summary");
  const r = spawnSync("bash", [script, "--name", "Test step", ...extra, "--", cmd], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  const count = Number(readFileSync(join(dir, "count"), "utf8"));
  let sum = "";
  try {
    sum = readFileSync(summary, "utf8");
  } catch {
    // none written
  }
  return { ...r, count, sum };
}

describe.skipIf(!hasTimeout)("scripts/ci-retry.sh", () => {
  it("runs once when the command passes", () => {
    const r = run([0]);
    expect(r.status).toBe(0);
    expect(r.count).toBe(1);
    expect(r.stdout).not.toContain("::warning");
    expect(r.sum).toBe("");
  });

  it("retries once after a failure, warns, and notes it in the summary", () => {
    const r = run([1, 0]);
    expect(r.status).toBe(0);
    expect(r.count).toBe(2);
    expect(r.stdout).toContain("::warning title=Retried Test step::Attempt 1 of 3 failed (exit 1)");
    expect(r.stdout).toContain("FAIL some test name");
    expect(r.sum).toContain("Test step: passed on attempt 2 of 3");
  });

  it("stops after 3 attempts and returns the last exit code", () => {
    const r = run([1, 2, 7]);
    expect(r.status).toBe(7);
    expect(r.count).toBe(3);
    expect(r.stdout.match(/::warning/g)?.length).toBe(2);
    expect(r.stdout).toContain("::error::Test step failed on attempt 3 of 3 (exit 7)");
    expect(r.sum).toBe("");
  });

  it("honors --attempts, and a timeout counts as a failure", () => {
    const r = run([1], ["--attempts", "2"]);
    expect(r.status).toBe(1);
    expect(r.count).toBe(2);
    const t = spawnSync("bash", [script, "--timeout", "1", "--attempts", "1", "--", "sleep", "5"], { encoding: "utf8" });
    expect(t.status).toBe(124);
  });

  it("prints help and rejects a missing command", () => {
    expect(spawnSync("bash", [script, "--help"], { encoding: "utf8" }).stdout).toContain("Usage:");
    expect(spawnSync("bash", [script], { encoding: "utf8" }).status).toBe(2);
  });
});
