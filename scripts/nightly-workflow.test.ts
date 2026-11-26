// The Nightly's publish step (#1381). It runs under `set -euo pipefail`, so a pipe whose reader stops early, such as
// `git log | head -n 50`, ends the step with exit 141 (SIGPIPE) once there are more commits than the reader takes. That stopped every
// nightly from 1.7.0 on, when development was 218 commits past the last nightly. This runs the step's own text from nightly.yml
// against a scratch repository with more commits than the notes list, with `gh` and `node` stood in for, and checks that it gets to
// `gh release create`.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The `run: |` text of the named step of a workflow, dedented. */
function stepScript(file: string, name: string): string {
  const lines = readFileSync(join(REPO, ".github", "workflows", file), "utf8").split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  expect(at, `${file} has no step named ${name}`).toBeGreaterThan(-1);
  const indent = (lines[run + 1].match(/^ */) ?? [""])[0].length;
  const out: string[] = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() !== "" && (l.match(/^ */) ?? [""])[0].length < indent) break;
    out.push(l.slice(indent));
  }
  return out.join("\n");
}

const git = (cwd: string, args: string[], input?: string) => {
  const r = spawnSync("git", args, { cwd, input, encoding: "utf8" });
  expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nightly-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("nightly.yml's publish step", () => {
  it("publishes when development is far more commits past the last nightly than the notes list", () => {
    const work = join(dir, "repo");
    const bin = join(dir, "bin");
    mkdirSync(work);
    mkdirSync(bin);
    git(work, ["init", "-q"]);
    // 400 commits in one fast-import, each with a long subject, so the log is far more than one pipe write.
    const subject = "x".repeat(200);
    let stream = "";
    for (let i = 1; i <= 400; i++) {
      stream += `commit refs/heads/development\nmark :${i}\ncommitter T <t@example.invalid> ${1_700_000_000 + i} +0000\n`;
      const msg = `commit ${i} ${subject}\n`;
      stream += `data ${Buffer.byteLength(msg)}\n${msg}${i > 1 ? `from :${i - 1}\n` : ""}\n`;
      if (i === 1) stream += "reset refs/tags/nightly-2000-01-01\nfrom :1\n\n";
    }
    git(work, ["fast-import", "--quiet"], stream);
    git(work, ["checkout", "-q", "development"]);
    const sha = git(work, ["rev-parse", "HEAD"]);

    // gh: one earlier nightly exists, today's does not, and create records its arguments. node: the build passes and the zip
    // script writes an empty archive and prints its path, the way podium-reporter-zip.mjs does.
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
case "$1 $2" in
  "release list") echo nightly-2000-01-01 ;;
  "release view") exit 1 ;;
  "release create") shift 2; printf '%s\\n' "$@" > "${dir}/created" ;;
  *) exit 2 ;;
esac
`);
    writeFileSync(join(bin, "node"), `#!/usr/bin/env bash
case "$1" in
  scripts/plugin-build.mjs) ;;
  scripts/podium-reporter-zip.mjs) f="$PWD/reporter-$RANDOM.zip"; : > "$f"; echo "$f" ;;
  *) exit 2 ;;
esac
`);
    chmodSync(join(bin, "gh"), 0o755);
    chmodSync(join(bin, "node"), 0o755);
    writeFileSync(join(dir, "step.sh"), stepScript("nightly.yml", "Publish the new nightly"));

    // GitHub runs a `run:` block as `bash -e {0}`; the step sets pipefail itself.
    const r = spawnSync("bash", ["-e", join(dir, "step.sh")], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHA: sha, GITHUB_ENV: join(dir, "env") },
    });
    expect(r.status, `the step ended with ${r.status} (141 is SIGPIPE): ${r.stderr}`).toBe(0);
    const notes = readFileSync(join(work, "notes.md"), "utf8");
    expect(notes).toContain("Commits since `nightly-2000-01-01`:");
    expect(notes.split("\n").filter((l) => l.startsWith("- ")).length).toBe(50);
    expect(readFileSync(join(dir, "created"), "utf8")).toContain(`--target\n${sha}\n`);
  });
});
