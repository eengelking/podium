import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCATIONS, buildTables, findStale, main, readRefs, readRows, render } from "./atlas-functions.mjs";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

// The page's source references, cut down: only "name: what it does" is a key function.
const KNOWN = ["hooks", "sse"];
// Every part in the table order needs an entry in REFS, so the fixture gives the others an empty one.
const others = LOCATIONS.flatMap(([, ids]) => ids).filter((id) => !KNOWN.includes(id)).map((id) => ` ${id}:[],`).join("\n");
const PAGE = `const pM="m/",pS="s/",pSF="sf/",pF="f/";
const REFS={
${others}
 hooks:[[pM+"state.ts",1,"newSession: creates the model"],[pM+"state.ts",2,"BACKOFF_MS: 1 s, 2 s"],[pM+"register.ts",3,"on('tool.call')"]],
 sse:[[pSF+"sse.ts",4,"class SseHub: the browser streams"],[pSF+"sse.ts",5,"maxClients: 100"],[pSF+"routes.ts",6,"GET /state"]]
};
`;

describe("readRows", () => {
  it("keeps 'name: what' and 'class Name: what', and drops constants, bare values and plain text", () => {
    const rows = readRows(PAGE).map((r) => `${r.kind}${r.name}${r.call}`);
    expect(rows).toEqual(["newSession", "class SseHub"]);
  });

  it("fails when a part on the page is missing from the table order", () => {
    expect(() => readRows(PAGE.replace(" hooks:[", " newpart:[],\n hooks:["))).toThrow(/newpart/);
  });

  it("fails when a part in the table order has gone from the page", () => {
    expect(() => readRows(PAGE.replace(" tx:[],", ""))).toThrow(/"tx"/);
  });
});

describe("buildTables", () => {
  it("groups rows under a heading per location, with the file named and the first letter capital", () => {
    const md = buildTables(readRows(PAGE));
    expect(md).toContain("### Reporter");
    expect(md).toContain("| Reporter | `newSession` | Creates the model. In `m/state.ts`. |");
    expect(md).toContain("| Server | `class SseHub` | The browser streams. In `sf/sse.ts`. |");
  });
});

describe("docs/atlas/ATLAS.md", () => {
  it("has the key functions the page names, written by scripts/atlas-functions.mjs", () => {
    expect(read("docs/atlas/ATLAS.md")).toBe(render(ROOT));
  });

  it("names only files and functions that are still in the code", () => {
    const rows = readRows(read("docs/atlas/podium-atlas.html"));
    expect(rows.length).toBeGreaterThan(50);
    expect(findStale(rows, ROOT)).toEqual([]);
  });

  it("has a row for every hook the reporter registers", () => {
    const doc = read("docs/atlas/ATLAS.md");
    const hooks = [...read("mod/podium-reporter/hooks/register.ts").matchAll(/^ {2}on\('([\w.]+)'/gm)].map((m) => m[1]);
    expect(hooks.length).toBeGreaterThan(15);
    // A row: its Item cell holds the hook's name in backticks (a mention elsewhere in the text does not count).
    const row = (h: string) => new RegExp(`^\\| \\w+ \\| [^|]*\`${h.replaceAll(".", "\\.")}\``, "m");
    expect(hooks.filter((h) => !row(h).test(doc))).toEqual([]);
  });
});

describe("docs/atlas/podium-atlas.html", () => {
  it("says which version it was read at, and it is the version in package.json", () => {
    const page = read("docs/atlas/podium-atlas.html");
    const v = JSON.parse(read("package.json")).version as string;
    expect(page).toContain(`Reads from the repo at v${v}`);
    expect(page).toContain(`at version ${v}`);
  });
});

describe("readRefs", () => {
  it("reads each part's references as text: a prefix and a path, a bare path, and escaped quotes", () => {
    const refs = readRefs(`const pM="m/",pS="s/",pSF="sf/",pF="f/";\nconst REFS={\n a:[[pM+"x.ts",3,"f: says \\"hi\\""],["scripts/y.ts",4,"g: two"]],\n b:[],\n};`);
    expect(refs).toEqual({ a: [["m/x.ts", 3, 'f: says "hi"'], ["scripts/y.ts", 4, "g: two"]], b: [] });
  });

  it("does not run anything in the page", () => {
    const g = globalThis as { __ran?: boolean };
    readRefs(`const pM="m/",pS="s/",pSF="sf/",pF="f/";\nconst REFS={\n a:[[pM+"x.ts",1,(globalThis.__ran=true,"f: x")]],\n};`);
    expect(g.__ran).toBeUndefined();
  });

  it("fails when the page has no REFS list", () => {
    expect(() => readRefs("nothing here")).toThrow(/REFS/);
  });
});

describe("a description ending in a full stop", () => {
  it("gets one full stop, not two", () => {
    const md = buildTables([{ location: "Reporter", id: "hooks", file: "m/x.ts", kind: "", name: "f", call: "", what: "does x..." }]);
    expect(md).toContain("| Reporter | `f` | Does x. In `m/x.ts`. |");
  });
});

describe("the command line", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const quiet = () => ({ log: vi.spyOn(console, "log").mockImplementation(() => {}), err: vi.spyOn(console, "error").mockImplementation(() => {}) });
  // A copy of the page and the document, so a write cannot touch the repo's own.
  const copy = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-"));
    dirs.push(d);
    fs.mkdirSync(path.join(d, "docs/atlas"), { recursive: true });
    for (const f of ["docs/atlas/podium-atlas.html", "docs/atlas/ATLAS.md"]) fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
    return d;
  };

  it("--help says how to use it and changes nothing", () => {
    const { log } = quiet();
    expect(main(["--help"])).toBe(0);
    expect(log.mock.calls[0]![0]).toContain("Usage: node scripts/atlas-functions.mjs");
  });

  it("--check passes on the repo as it is", () => {
    const { log } = quiet();
    expect(main(["--check"])).toBe(0);
    expect(log.mock.calls[0]![0]).toMatch(/^ok: \d+ key functions$/);
  });

  it("--check fails, and writes nothing, when the document is out of date", () => {
    const { err } = quiet();
    const d = copy();
    const doc = path.join(d, "docs/atlas/ATLAS.md");
    const stale = fs.readFileSync(doc, "utf8").replace("`redact`", "`redactX`");
    fs.writeFileSync(doc, stale);
    expect(main(["--check"], d)).toBe(1);
    expect(err.mock.calls[0]![0]).toContain("out of date");
    expect(fs.readFileSync(doc, "utf8")).toBe(stale);
  });

  it("writes the document from the page", () => {
    const { log } = quiet();
    const d = copy();
    const doc = path.join(d, "docs/atlas/ATLAS.md");
    fs.writeFileSync(doc, fs.readFileSync(doc, "utf8").replace("`redact`", "`redactX`"));
    expect(main([], d)).toBe(0);
    expect(fs.readFileSync(doc, "utf8")).toBe(fs.readFileSync(path.join(ROOT, "docs/atlas/ATLAS.md"), "utf8"));
    expect(log.mock.calls[0]![0]).toMatch(/^wrote \d+ key functions/);
  });
});
