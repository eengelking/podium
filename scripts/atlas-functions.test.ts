import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOCATIONS, buildTables, findStale, readRows, render } from "./atlas-functions.mjs";

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
