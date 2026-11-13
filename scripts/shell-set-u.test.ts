// The shell scripts that run under `set -u` (#823). bash 3.2, the one macOS ships, lets `${NAME//a/b}` and the other pattern forms
// read a variable that was never set; bash 4 and later, the one CI and every Linux machine runs, stops the script with "NAME: unbound
// variable". So a script that reads an environment variable that way passes on a Mac and fails in CI (scripts/test-db.sh did, with
// PODIUM_TEST_ONLY). This reads each script and fails for a variable the script never assigns, read with a pattern operator, a
// substring or a length and no default. A plain `$NAME` or `${NAME}` is left out: it stops the script on every bash, so a run on a
// Mac already finds it. A variable the script sets itself is safe; one it only gets from the environment needs `${NAME:-}` first.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Each read of a variable the script never assigns, with a pattern operator, a substring or a length, as `line: text`. */
function unsetPatternReads(text: string): string[] {
  if (!/^\s*set -[a-z]*u/m.test(text)) return [];
  const assigned = new Set<string>();
  // An assignment starts a statement: at the start of a line, or after ;, &&, ||, then, do, else or (, with an optional keyword.
  const assign = /(?:^\s*|(?:;|&&|\|\||\bthen|\bdo|\belse|\()\s*)(?:local |export |declare(?: -[a-zA-Z]+)? |readonly )?([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=/gm;
  for (const m of text.matchAll(assign)) assigned.add(m[1]);
  for (const m of text.matchAll(/\b(?:for|read(?: -[a-z]+)*)\s+([A-Za-z_][\w ]*)/g)) for (const n of m[1].split(/\s+/)) assigned.add(n);
  for (const m of text.matchAll(/getopts\s+\S+\s+([A-Za-z_]\w*)/g)) assigned.add(m[1]);
  const found: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const m of line.matchAll(/\$\{(#?)([A-Za-z_]\w*)(\/\/?|##?|%%?|\^\^?|,,?|:[0-9]|\})/g)) {
      const [whole, length, name, op] = m;
      if (op === "}" && !length) continue;
      if (!assigned.has(name)) found.push(`${i + 1}: ${whole}`);
    }
  });
  return found;
}

/** The shell scripts of the repo's own folders, by path from the repo. */
const scripts = ["scripts", "runner"].flatMap((d) =>
  readdirSync(join(REPO, d))
    .filter((f) => f.endsWith(".sh"))
    .map((f) => `${d}/${f}`),
);

describe("shell scripts under set -u", () => {
  it("finds a pattern read of an unset variable, and passes one that has a default or is assigned", () => {
    const bad = 'set -uo pipefail\nlimited=0 ; [[ -n "${PODIUM_TEST_ONLY//[ ,]/}" ]] && limited=1\necho "${#OTHER}"\n';
    expect(unsetPatternReads(bad)).toEqual(["2: ${PODIUM_TEST_ONLY//", "3: ${#OTHER}"]);
    const good = 'set -u\nx="${PODIUM_TEST_ONLY:-}"\nlimited=0 ; [[ -n "${x//[ ,]/}" ]] && limited=1\n# ${COMMENTED//a/b}\necho "${PLAIN}"\n';
    expect(unsetPatternReads(good)).toEqual([]);
    expect(unsetPatternReads('echo "${NOT_STRICT//a/b}"\n')).toEqual([]);
  });

  it("read no variable they never set with a pattern operator, a substring or a length, so bash 4 and later run them as bash 3.2 does", () => {
    expect(scripts.length).toBeGreaterThan(5);
    const found = scripts.flatMap((f) => unsetPatternReads(readFileSync(join(REPO, f), "utf8")).map((x) => `${f}:${x}`));
    expect(found, "give each one a default first, for example x=\"${NAME:-}\", or ${NAME:-} in place of ${NAME}").toEqual([]);
  });
});
