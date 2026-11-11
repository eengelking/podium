// scripts/e2e-shards.mjs (#1130): the spec groups for scripts/e2e-all.sh --shards N, weighed by the recorded spec times in
// e2e/spec-times.json, the --record that writes that file from Cypress logs, and the counts it reads from a Cypress log.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkShards, countsIn, durationSeconds, listSpecs, main, median, readTimes, resolveSpec, shard, shardsFor, specTimesIn, TIMES_FILE, weight } from "./e2e-shards.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A small repository with the given spec files (path under e2e/cypress/e2e -> text), and a timings file when times is given. */
function repo(specs: Record<string, string>, times?: Record<string, number> | string) {
  const root = mkdtempSync(join(tmpdir(), "e2eshards-"));
  made.push(root);
  for (const [rel, text] of Object.entries(specs)) {
    const p = join(root, "e2e", "cypress", "e2e", rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  if (times !== undefined) {
    mkdirSync(join(root, "e2e"), { recursive: true });
    writeFileSync(join(root, TIMES_FILE), typeof times === "string" ? times : JSON.stringify({ about: "test", times }));
  }
  return root;
}

/** Runs main() and collects what it writes. */
function cli(argv: string[], root: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { root, out: (s: string) => out.push(s), err: (s: string) => err.push(s), today: () => "2026-01-02" });
  return { code, out, err };
}

/** A (Results) box as Cypress prints it after a spec. */
const box = (name: string, duration: string) => `
  (Results)

  ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
  │ Tests:        3                                                                                │
  │ Passing:      3                                                                                │
  │ Failing:      0                                                                                │
  │ Duration:     ${duration.padEnd(81)}│
  │ Spec Ran:     ${name.padEnd(81)}│
  └────────────────────────────────────────────────────────────────────────────────────────────────┘
`;

const PASS_LOG = `
  │ Specs:          3 found (a/one.cy.js, a/two.cy.js, b/three.cy.js)                               │
  (Run Finished)
  │ ✔  a/one.cy.js                              00:04        6        6        -        -        - │
    ✔  All specs passed!                        10:52      535      535        -        -        -
`;
const FAIL_LOG = `
  │ Specs:          20 found (a/one.cy.js, ...)                                                      │
    ✖  1 of 20 failed (5%)                      03:10      180      179        1        -        -
`;

describe("listSpecs", () => {
  it("finds every .cy.js file under e2e/cypress/e2e, relative to e2e/, sorted, and nothing else", () => {
    const root = repo({ "wall/b.cy.js": "", "wall/a.cy.js": "", "admin/deep/c.cy.js": "", "wall/notes.md": "", "wall/helper.js": "" });
    expect(listSpecs(root)).toEqual(["cypress/e2e/admin/deep/c.cy.js", "cypress/e2e/wall/a.cy.js", "cypress/e2e/wall/b.cy.js"]);
  });

  it("is empty when there is no spec folder", () => {
    expect(listSpecs(mkdtempSync(join(tmpdir(), "e2eshards-none-")))).toEqual([]);
  });

  it("finds the real suite's specs", () => {
    expect(listSpecs(REPO).length).toBeGreaterThan(10);
  });
});

describe("weight", () => {
  it("counts tests and twice each server restart", () => {
    const text = "before(() => cy.resetServer());\nit('a', () => {});\n  it(\"b\", () => {});\nit.skip('c', () => {});\nsplit('x'); cy.resetServer({ noSeed: true });";
    expect(weight(text)).toBe(2 + 2 * 2);
  });

  it("is at least 1", () => {
    expect(weight("")).toBe(1);
  });
});

describe("shard", () => {
  const specs = [
    { path: "a", weight: 10 },
    { path: "b", weight: 9 },
    { path: "c", weight: 5 },
    { path: "d", weight: 5 },
    { path: "e", weight: 1 },
  ];

  it("puts the heaviest first into the lightest group, and sorts each group", () => {
    // a 10 -> 1; b 9 -> 2; c 5 -> 2 (14); d 5 -> 1 (15); e 1 -> 2 (15).
    expect(shard(specs, 2)).toEqual([["a", "d"], ["b", "c", "e"]]);
  });

  it("gives every spec one group and is the same each time", () => {
    const groups = shard(specs, 3);
    expect(checkShards(specs.map((s) => s.path), groups)).toEqual([]);
    expect(shard([...specs].reverse(), 3)).toEqual(groups);
  });

  it("is one group of everything for one shard", () => {
    expect(shard(specs, 1)).toEqual([["a", "b", "c", "d", "e"]]);
  });

  it("refuses a count below 1, not a whole number, or above the spec count", () => {
    expect(() => shard(specs, 0)).toThrow(/1 or more/);
    expect(() => shard(specs, 1.5)).toThrow(/1 or more/);
    expect(() => shard(specs, 6)).toThrow(/more than the 5 spec files/);
  });
});

describe("checkShards", () => {
  it("names a spec in no group, one in two, and a name that is not a spec", () => {
    expect(checkShards(["a", "b", "c"], [["a", "b"], ["b", "x"]])).toEqual(["b is in shards 1 and 2", "c is in no shard", "shard list names x, which is not a spec file"]);
  });
});

describe("shardsFor", () => {
  it("covers the real suite exactly once at 1, 3 and 6 shards", () => {
    const all = listSpecs(REPO);
    for (const n of [1, 3, 6]) {
      const { groups, problems } = shardsFor(REPO, n);
      expect(problems).toEqual([]);
      expect(groups).toHaveLength(n);
      expect(groups.flat().sort()).toEqual(all);
    }
  });
});

describe("the recorded times", () => {
  const specs = { "a/one.cy.js": "it('x');", "a/two.cy.js": "it('x');", "b/three.cy.js": "it('x');", "b/four.cy.js": "it('x');" };
  const P = (s: string) => `cypress/e2e/${s}.cy.js`;

  it("weigh each spec by its seconds, so a slow spec with few tests gets a group of its own", () => {
    // By the heuristic every spec weighs 1 and two shards take two each; by time one spec is as slow as the other three together.
    const root = repo(specs, { [P("a/one")]: 90, [P("a/two")]: 30, [P("b/three")]: 30, [P("b/four")]: 30 });
    const r = shardsFor(root, 2);
    expect(r.source).toBe("times");
    expect(r.groups).toEqual([[P("a/one")], [P("a/two"), P("b/four"), P("b/three")]]);
    expect(r.weights).toEqual([90, 90]);
    expect(r.missing).toEqual([]);
  });

  it("weigh a spec with no recorded time at the median of the recorded ones", () => {
    const root = repo(specs, { [P("a/one")]: 10, [P("a/two")]: 20, [P("b/three")]: 60 });
    const r = shardsFor(root, 1);
    expect(r.missing).toEqual([P("b/four")]);
    expect(r.fill).toBe(20);
    expect(r.weights).toEqual([10 + 20 + 60 + 20]);
  });

  it("ignore a recorded time for a spec that is no longer on disk, in the groups and in the median", () => {
    const root = repo(specs, { [P("a/one")]: 10, [P("a/two")]: 10, [P("b/three")]: 10, [P("b/four")]: 10, [P("a/gone")]: 500 });
    const r = shardsFor(root, 2);
    expect(r.groups.flat()).not.toContain(P("a/gone"));
    expect(r.weights).toEqual([20, 20]);
  });

  it("fall back to the tests and restarts when there is no file, or it has no spec on disk", () => {
    for (const root of [repo(specs), repo(specs, { [P("a/gone")]: 5 })]) {
      const r = shardsFor(root, 2);
      expect(r.source).toBe("heuristic");
      expect(r.weights).toEqual([2, 2]);
    }
  });

  it("give the same groups each time, whatever order the file lists the specs in", () => {
    const times = { [P("a/one")]: 7, [P("a/two")]: 7, [P("b/three")]: 3, [P("b/four")]: 4 };
    const reversed = Object.fromEntries(Object.entries(times).reverse());
    const a = shardsFor(repo(specs, times), 2);
    expect(shardsFor(repo(specs, reversed), 2).groups).toEqual(a.groups);
    expect(shardsFor(repo(specs, times), 2).groups).toEqual(a.groups);
  });

  it("refuse a file that does not parse or holds a time that is not whole seconds", () => {
    expect(() => readTimes(repo(specs, "{ nope"))).toThrow(/does not parse/);
    expect(() => readTimes(repo(specs, "[]"))).toThrow(/no "times" object/);
    expect(() => readTimes(repo(specs, { [P("a/one")]: 1.5 }))).toThrow(/whole number of seconds/);
    expect(() => readTimes(repo(specs, { [P("a/one")]: 0 }))).toThrow(/whole number of seconds/);
    expect(readTimes(repo(specs))).toBeNull();
  });

  it("in the repo parse, are sorted, and cover the real suite exactly once at 3 and 4 shards", () => {
    const data = JSON.parse(readFileSync(join(REPO, TIMES_FILE), "utf8"));
    const keys = Object.keys(data.times);
    expect(keys).toEqual([...keys].sort());
    expect(Object.values(data.times).every((t) => Number.isInteger(t) && (t as number) >= 1)).toBe(true);
    expect(readTimes(REPO)).toEqual(data.times);
    for (const n of [3, 4]) {
      const r = shardsFor(REPO, n);
      expect(r.source).toBe("times");
      expect(r.groups.flat().sort()).toEqual(listSpecs(REPO));
    }
  });

  it("median is the middle value, or the rounded mean of the two middle ones", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 2, 9])).toBe(3);
    expect(median([1, 2])).toBe(2);
  });
});

describe("reading spec durations from a Cypress log", () => {
  it("reads seconds, minutes and hours", () => {
    expect(durationSeconds("14 seconds")).toBe(14);
    expect(durationSeconds("1 second")).toBe(1);
    expect(durationSeconds("2 minutes, 2 seconds")).toBe(122);
    expect(durationSeconds("1 minute, 9 seconds")).toBe(69);
    expect(durationSeconds("1 hour, 1 minute")).toBe(3660);
    expect(durationSeconds("850ms")).toBe(0.85);
    expect(durationSeconds("soon")).toBeNull();
  });

  it("takes each spec's name and duration from its (Results) box, a wrapped name included, and not from the summary table", () => {
    const long = "admin/a-spec-with-a-name-so-long-that-cypress-wraps-it-inside-the-results-box";
    const wrapped = box(long.slice(0, 81), "33 seconds").replace(
      /(│ Spec Ran:.*│\n)/,
      `$1  │               ${`${long.slice(81)}.cy.js`.padEnd(81)}│\n`,
    );
    const log = `${box("a11y/axe.cy.js", "9 seconds")}${box("chat/admin-read-notices.cy.js", "2 minutes, 5 seconds")}${wrapped}
  (Run Finished)
    ✔  chat/admin-read-notices.cy.js            02:05        3        3        -        -        -
    ✔  admin/a-spec-with-a-name-so-long-tha     00:33        3        3        -        -        -
       t-cypress-wraps...
`;
    expect(specTimesIn(log)).toEqual([
      { name: "a11y/axe.cy.js", seconds: 9 },
      { name: "chat/admin-read-notices.cy.js", seconds: 125 },
      { name: `${long}.cy.js`, seconds: 33 },
    ]);
  });

  it("skips a box with no name or no duration", () => {
    expect(specTimesIn(box("", "9 seconds"))).toEqual([]);
    expect(specTimesIn(box("a.cy.js", "soon"))).toEqual([]);
  });

  it("maps a name to the spec on disk, whatever folder Cypress shows it from", () => {
    const paths = ["cypress/e2e/admin/about.cy.js", "cypress/e2e/wall/about.cy.js", "cypress/e2e/wall/rail.cy.js"];
    expect(resolveSpec("wall/rail.cy.js", paths)).toBe("cypress/e2e/wall/rail.cy.js");
    expect(resolveSpec("rail.cy.js", paths)).toBe("cypress/e2e/wall/rail.cy.js"); // a shard whose specs all sit in wall/
    expect(resolveSpec("cypress/e2e/wall/rail.cy.js", paths)).toBe("cypress/e2e/wall/rail.cy.js");
    expect(resolveSpec("about.cy.js", paths)).toBeNull(); // two specs have that name
    expect(resolveSpec("wall/gone.cy.js", paths)).toBeNull();
    expect(resolveSpec("wall/about.cy.js", [...paths, "cypress/e2e/old/wall/about.cy.js"])).toBe("cypress/e2e/wall/about.cy.js");
  });
});

describe("--record", () => {
  const specs = { "a/one.cy.js": "", "a/two.cy.js": "", "b/three.cy.js": "", "b/four.cy.js": "" };

  function logs(texts: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "e2eshards-rec-"));
    made.push(dir);
    return texts.map((t, i) => {
      const f = join(dir, `run${i}.log`);
      writeFileSync(f, t);
      return f;
    });
  }

  it("writes each spec's average over the logs, keeps the old time of a spec no log has, and drops one no longer on disk", () => {
    const root = repo(specs, { "cypress/e2e/b/four.cy.js": 44, "cypress/e2e/a/gone.cy.js": 9, "cypress/e2e/a/one.cy.js": 1 });
    const files = logs([
      box("a/one.cy.js", "1 minute, 10 seconds") + box("a/two.cy.js", "400ms") + box("x/unknown.cy.js", "3 seconds"),
      box("a/one.cy.js", "1 minute, 13 seconds") + box("b/three.cy.js", "8 seconds"),
    ]);
    const r = cli(["--record", ...files], root);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`e2e-shards: wrote ${TIMES_FILE}: 4 specs, 3 from 2 log(s), 1 kept from the old file`]);
    expect(r.err).toEqual(["e2e-shards: not a spec on disk (skipped): x/unknown.cy.js"]);
    const data = JSON.parse(readFileSync(join(root, TIMES_FILE), "utf8"));
    expect(data.recorded).toBe("2026-01-02");
    expect(data.logs).toBe(2);
    expect(data.about).toContain("--record");
    expect(Object.entries(data.times)).toEqual([
      ["cypress/e2e/a/one.cy.js", 72], // (70 + 73) / 2 = 71.5, rounded
      ["cypress/e2e/a/two.cy.js", 1], // under a second is still 1
      ["cypress/e2e/b/four.cy.js", 44],
      ["cypress/e2e/b/three.cy.js", 8],
    ]);
  });

  it("dates the file with today's local date when no date is given", () => {
    const root = repo(specs);
    const [f] = logs([box("a/one.cy.js", "2 seconds")]);
    expect(main(["--record", f], { root, out: () => {}, err: () => {} })).toBe(0);
    const { recorded } = JSON.parse(readFileSync(join(root, TIMES_FILE), "utf8"));
    const d = new Date();
    expect(recorded).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  });

  it("names a spec that has no time in any log or the old file", () => {
    const root = repo(specs);
    const r = cli(["--record", ...logs([box("a/one.cy.js", "2 seconds")])], root);
    expect(r.code).toBe(0);
    expect(r.err.join("\n")).toContain("no time in any log or the old file, so weighed at the median: cypress/e2e/a/two.cy.js");
  });

  it("writes nothing and exits 2 for a missing log, a log with no durations, or an old file that does not parse", () => {
    const root = repo(specs);
    const [good, empty] = logs([box("a/one.cy.js", "2 seconds"), "no boxes here"]);
    for (const argv of [["--record", good, `${good}.gone`], ["--record", good, empty], ["--record"]]) {
      const r = cli(argv, root);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(existsSync(join(root, TIMES_FILE))).toBe(false);
    }
    const bad = repo(specs, "{ nope");
    const r = cli(["--record", good], bad);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("does not parse");
    expect(readFileSync(join(bad, TIMES_FILE), "utf8")).toBe("{ nope");
  });

  it("reads the round-1 logs' format end to end: what it writes, --shards reads", () => {
    const root = repo(specs);
    const files = logs([box("a/one.cy.js", "2 minutes, 2 seconds") + box("a/two.cy.js", "40 seconds") + box("b/three.cy.js", "41 seconds") + box("b/four.cy.js", "41 seconds")]);
    expect(cli(["--record", ...files], root).code).toBe(0);
    const r = cli(["--shards", "2", "--explain"], root);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["cypress/e2e/a/one.cy.js", "cypress/e2e/a/two.cy.js,cypress/e2e/b/four.cy.js,cypress/e2e/b/three.cy.js"]);
    expect(r.err).toEqual(["e2e-shards: shard 1: 1 specs, 122 s", "e2e-shards: shard 2: 3 specs, 122 s"]);
  });
});

describe("countsIn", () => {
  it("reads the specs found and the totals row of a passing run", () => {
    expect(countsIn(PASS_LOG)).toEqual({ specs: 3, tests: 535, passing: 535, failing: 0 });
  });

  it("reads a failing run's totals", () => {
    expect(countsIn(FAIL_LOG)).toEqual({ specs: 20, tests: 180, passing: 179, failing: 1 });
  });

  it("is null for a log with no summary (a run that never started Cypress)", () => {
    expect(countsIn("e2e: FAIL  the server did not answer /api/fleet/health")).toBeNull();
    expect(countsIn("  │ Specs:          3 found (a.cy.js)")).toBeNull();
  });
});

describe("the command line", () => {
  const root = repo({ "a/one.cy.js": "it('x');it('y');", "a/two.cy.js": "it('x');", "b/three.cy.js": "it('x');" });

  it("prints its help", () => {
    for (const flag of ["-h", "--help"]) {
      const r = cli([flag], root);
      expect(r.code).toBe(0);
      expect(r.out.join("\n")).toContain("Usage: node scripts/e2e-shards.mjs --shards N");
    }
  });

  it("prints one comma-separated --spec list per shard", () => {
    const r = cli(["--shards", "2"], root);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["cypress/e2e/a/one.cy.js", "cypress/e2e/a/two.cy.js,cypress/e2e/b/three.cy.js"]);
  });

  it("notes on stderr, never stdout, how the specs were weighed when a time is missing", () => {
    const none = cli(["--shards", "2"], root);
    expect(none.err).toEqual([
      `e2e-shards: there is no ${TIMES_FILE}, so each spec is weighed by its tests and restarts, which predicts time badly; record the times with node scripts/e2e-shards.mjs --record <Cypress logs>`,
    ]);
    const some = cli(["--shards", "2"], repo({ "a/one.cy.js": "", "a/two.cy.js": "", "b/three.cy.js": "" }, { "cypress/e2e/a/one.cy.js": 4, "cypress/e2e/a/two.cy.js": 6 }));
    expect(some.code).toBe(0);
    expect(some.out).toHaveLength(2);
    expect(some.err[0]).toBe("e2e-shards: 1 spec(s) with no recorded time, weighed at the median (5 s): cypress/e2e/b/three.cy.js");
    expect(some.err[1]).toContain("--record");
    const all = cli(["--shards", "2"], repo({ "a/one.cy.js": "", "a/two.cy.js": "" }, { "cypress/e2e/a/one.cy.js": 4, "cypress/e2e/a/two.cy.js": 6 }));
    expect(all.err).toEqual([]);
    const stale = cli(["--shards", "2"], repo({ "a/one.cy.js": "", "a/two.cy.js": "" }, { "cypress/e2e/a/gone.cy.js": 4 }));
    expect(stale.err[0]).toContain(`${TIMES_FILE} has no time for any spec on disk, so each spec is weighed by its tests and restarts`);
  });

  it("prints each group's weight on stderr with --explain, and the same groups on stdout", () => {
    const r = cli(["--shards", "2", "--explain"], root);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(cli(["--shards", "2"], root).out);
    expect(r.err.slice(1)).toEqual(["e2e-shards: shard 1: 1 specs, 2 (tests and restarts, not seconds)", "e2e-shards: shard 2: 2 specs, 2 (tests and restarts, not seconds)"]);
  });

  it("exits 2 when the timings file does not parse", () => {
    const r = cli(["--shards", "2"], repo({ "a/one.cy.js": "", "a/two.cy.js": "" }, "{ nope"));
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("does not parse");
  });

  it("lists the specs", () => {
    expect(cli(["--list"], root).out).toEqual(["cypress/e2e/a/one.cy.js", "cypress/e2e/a/two.cy.js", "cypress/e2e/b/three.cy.js"]);
  });

  it("exits 2 on a bad shard count or bad arguments", () => {
    for (const argv of [["--shards", "0"], ["--shards", "x"], ["--shards", "4"], ["--shards"], ["--shards", "2", "--nope"], [], ["--nope"]]) {
      const r = cli(argv, root);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err.join("\n")).toMatch(/e2e-shards: /);
    }
  });

  it("prints the counts of each log, and exits 2 for a log with none or a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2eshards-logs-"));
    made.push(dir);
    writeFileSync(join(dir, "pass.log"), PASS_LOG);
    writeFileSync(join(dir, "broken.log"), "nothing here");
    expect(cli(["--counts", join(dir, "pass.log")], root)).toEqual({ code: 0, out: ["specs=3 tests=535 passing=535 failing=0"], err: [] });
    const r = cli(["--counts", join(dir, "pass.log"), join(dir, "broken.log"), join(dir, "gone.log")], root);
    expect(r.code).toBe(2);
    expect(r.out).toEqual(["specs=3 tests=535 passing=535 failing=0", "specs=? tests=? passing=? failing=?", "specs=? tests=? passing=? failing=?"]);
  });

  it("runs as a script", () => {
    const r = spawnSync("node", [join(REPO, "scripts", "e2e-shards.mjs"), "--shards", "2"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(2);
  });
});
