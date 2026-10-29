import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { mapProblems, routesIn, tokensIn } from "./e2e-map.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A small repository: one server route file, one frontend file with a test id, two specs, and the map. */
function repo(map: string, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "e2emap-"));
  made.push(root);
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("server/src/fleet/routes.ts", "router.get('/history', h);\nrouter.get('/sessions/:id/agents/:agentId/activity', h);\nrouter.put(`/admin/people/:id/group`, h);\n");
  put("frontend/src/fleet/Top.tsx", 'export const A = () => <span data-testid="page-pill" />;\n');
  put("e2e/cypress/e2e/wall/cards.cy.js", "cy.tid('page-pill');\n");
  put("e2e/cypress/e2e/wall/rail.cy.js", "cy.get('[data-testid=\"page-pill\"]');\n");
  put("docs/e2e/COVERAGE.md", map);
  for (const [rel, text] of Object.entries(extra)) put(rel, text);
  return root;
}

const GOOD = [
  "| Feature | Spec | Covered by |",
  "|---|---|---|",
  "| Cards | SPEC 8.1 | `e2e/cypress/e2e/wall/cards.cy.js` |",
  "| Rail | SPEC 8.1 | `e2e/cypress/e2e/wall/rail.cy.js`, `frontend/src/fleet/Top.tsx` |",
  "| History | none | `GET /api/fleet/history` |",
  "| Activity | SPEC 8.1 | `GET /api/fleet/sessions/:sessionId/agents/:aid/activity` |",
].join("\n");

describe("tokensIn", () => {
  it("takes the code spans of a map and ignores everything else", () => {
    expect(tokensIn("Text `a/b.js` more `GET /x` and ``double``.\n```\n`fenced`\n```\n")).toEqual(["a/b.js", "GET /x", "double"]);
  });
});

describe("routesIn", () => {
  it("lists the route literals of the server sources, with every :param written the same", () => {
    const root = repo(GOOD);
    expect(routesIn(root)).toEqual(new Set(["/history", "/sessions/:p/agents/:p/activity", "/admin/people/:p/group"]));
  });
});

describe("mapProblems", () => {
  it("is clean when every spec, source file, route and test id the map names exists, and every spec is in the map", () => {
    expect(mapProblems(repo(GOOD))).toEqual([]);
  });

  it("names a spec file the map lists that no longer exists", () => {
    const bad = GOOD.replace("wall/rail.cy.js", "wall/gone.cy.js");
    const problems = mapProblems(repo(bad));
    expect(problems).toContain("docs/e2e/COVERAGE.md names e2e/cypress/e2e/wall/gone.cy.js, which does not exist");
    expect(problems.some((p) => p.includes("wall/rail.cy.js") && p.includes("is not in docs/e2e/COVERAGE.md"))).toBe(true);
  });

  it("names a source file that was moved or deleted", () => {
    const problems = mapProblems(repo(GOOD.replace("frontend/src/fleet/Top.tsx", "frontend/src/fleet/Moved.tsx")));
    expect(problems).toContain("docs/e2e/COVERAGE.md names frontend/src/fleet/Moved.tsx, which does not exist");
  });

  it("names a route that no longer exists, and accepts a route whose parameter has another name", () => {
    const problems = mapProblems(repo(GOOD.replace("/api/fleet/history", "/api/fleet/historyy")));
    expect(problems).toEqual(["docs/e2e/COVERAGE.md names the route GET /api/fleet/historyy, which no server route matches"]);
  });

  it("names a spec that is not in the map", () => {
    const root = repo(GOOD, { "e2e/cypress/e2e/wall/new.cy.js": "it('x');\n" });
    expect(mapProblems(root)).toEqual(["e2e/cypress/e2e/wall/new.cy.js is not in docs/e2e/COVERAGE.md: add the feature it covers"]);
  });

  it("names a data-testid a spec uses that no frontend source defines", () => {
    const root = repo(GOOD, { "e2e/cypress/e2e/wall/cards.cy.js": "cy.tid('page-pill'); cy.tid('no-such-id');\n" });
    expect(mapProblems(root)).toEqual(["e2e/cypress/e2e/wall/cards.cy.js uses data-testid \"no-such-id\", which no frontend source defines"]);
  });

  it("says when the map is missing", () => {
    const root = repo(GOOD);
    rmSync(join(root, "docs/e2e/COVERAGE.md"));
    expect(mapProblems(root)).toEqual(["docs/e2e/COVERAGE.md does not exist"]);
  });
});

describe("the repository's own map", () => {
  it("names only files, routes and test ids that exist, and lists every spec", () => {
    expect(mapProblems(REPO)).toEqual([]);
  });
});
