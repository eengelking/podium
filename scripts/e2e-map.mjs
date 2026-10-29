#!/usr/bin/env node
// Checks that the names in the end-to-end coverage map (docs/e2e/COVERAGE.md, #782, DECISIONS 48) exist in the repository, so the map cannot rot silently.
// It checks names, not behavior: it cannot tell whether a spec named in a row asserts what the row says. That is read by a person, in the spec:
//   - every file the map names in a code span (a spec, a source file, a doc, a script) exists;
//   - every server route it names (`GET /api/fleet/history`) matches a route literal in server/src;
//   - every spec under e2e/cypress/e2e/ is named in the map (a spec nobody mapped says nothing about what it covers);
//   - every data-testid a spec uses is defined in the frontend sources.
// Usage: node scripts/e2e-map.mjs      Exit code 0 when clean, 1 with one line per problem.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MAP = "docs/e2e/COVERAGE.md";
const SPEC_DIR = "e2e/cypress/e2e";
const ROOTS = ["frontend/", "server/", "mod/", "scripts/", "docs/", "site/", ".github/", ".claude/", "e2e/", "bin/"];
const METHOD = /^(GET|POST|PUT|PATCH|DELETE) (\/\S+)$/;

/** The code spans of a Markdown text, leaving out fenced blocks. */
export function tokensIn(md) {
  let fence = null;
  const out = [];
  for (const line of md.split("\n")) {
    const f = /^(```|~~~)/.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1].trim());
  }
  return out;
}

const walk = (dir, keep) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : walk(p, keep);
    return keep(p) ? [p] : [];
  });
};

const sources = (root, dir) => walk(join(root, dir), (p) => /\.(ts|tsx)$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p));
const norm = (route) => route.replace(/:\w+/g, ":p");

/** The route literals the server's sources hold ("/history", "/sessions/:id/peers/messages"), with each parameter written ":p". */
export function routesIn(root) {
  const out = new Set();
  for (const f of sources(root, "server/src")) {
    for (const m of readFileSync(f, "utf8").matchAll(/(['"`])(\/[A-Za-z0-9_\-/:.${}]*)\1/g)) out.add(norm(m[2].replace(/\$\{[^}]*\}/g, ":p")));
  }
  return out;
}

/** True when a route as the map writes it matches a server route: the mount prefixes are tried off the front in turn. */
function routeExists(route, known) {
  const path = norm(route.split("?")[0]);
  const rests = [path.replace(/^\/api/, ""), path.replace(/^\/api\/(fleet|admin)/, ""), path.replace(/^\/api\/fleet\/respond/, ""), path.replace(/^\/api\/fleet\/(peers|recording)/, "")];
  return rests.some((r) => r && known.has(r));
}

/** A glob with `*` in one path segment, expanded against the files that exist. */
function expand(root, token) {
  if (!token.includes("*")) return existsSync(join(root, token)) ? [token] : [];
  const esc = (t) => t.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${token.split("**").map((part) => part.split("*").map(esc).join("[^/]*")).join(".*")}$`);
  const first = token.indexOf("*");
  const base = token.slice(0, token.lastIndexOf("/", first) + 1);
  return walk(join(root, base), () => true).map((p) => p.slice(root.length + 1)).filter((p) => re.test(p));
}

/** The test ids the specs use, by spec file: `cy.tid('x')` and `[data-testid="x"]`. */
function testIdsUsed(root, spec) {
  const text = readFileSync(join(root, spec), "utf8");
  const ids = new Set();
  for (const m of text.matchAll(/\btid\(\s*['"]([^'"]+)['"]/g)) ids.add(m[1]);
  for (const m of text.matchAll(/data-testid=\\?["']?([A-Za-z0-9_-]+)/g)) ids.add(m[1]);
  return ids;
}

/** Every problem the map has, as one short sentence each. Empty when the map is true. */
export function mapProblems(root) {
  if (!existsSync(join(root, MAP))) return [`${MAP} does not exist`];
  const problems = [];
  const known = routesIn(root);
  const specs = walk(join(root, SPEC_DIR), (p) => p.endsWith(".cy.js")).map((p) => p.slice(root.length + 1)).sort();
  const mapped = new Set();
  const seen = new Set();
  for (const token of tokensIn(readFileSync(join(root, MAP), "utf8"))) {
    if (seen.has(token)) continue;
    seen.add(token);
    const route = METHOD.exec(token);
    if (route) {
      if (!routeExists(route[2], known)) problems.push(`${MAP} names the route ${token}, which no server route matches`);
      continue;
    }
    if (/\s/.test(token) || !ROOTS.some((r) => token.startsWith(r))) continue;
    const dirToken = token.endsWith("/");
    if (!dirToken && !/\.[A-Za-z0-9]+$/.test(token) && !token.includes("*")) continue;
    const found = expand(root, dirToken ? token.slice(0, -1) : token);
    if (found.length === 0) {
      problems.push(`${MAP} names ${token}, which does not exist`);
      continue;
    }
    for (const f of found) if (f.startsWith(`${SPEC_DIR}/`) && f.endsWith(".cy.js")) mapped.add(f);
    if (dirToken && existsSync(join(root, token)) && statSync(join(root, token)).isDirectory()) for (const s of specs) if (s.startsWith(token)) mapped.add(s);
  }
  for (const s of specs) if (!mapped.has(s)) problems.push(`${s} is not in ${MAP}: add the feature it covers`);
  const defined = new Set();
  for (const f of sources(root, "frontend/src")) for (const m of readFileSync(f, "utf8").matchAll(/data-testid=["{]\s*["'`]?([A-Za-z0-9_-]+)/g)) defined.add(m[1]);
  for (const s of specs) for (const id of testIdsUsed(root, s)) if (!defined.has(id)) problems.push(`${s} uses data-testid "${id}", which no frontend source defines`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log("Usage: node scripts/e2e-map.mjs\nChecks docs/e2e/COVERAGE.md against the repository: every file, route and test id it names exists, and every spec is named.");
    process.exit(0);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = mapProblems(root);
  for (const p of problems) console.log(p);
  console.log(problems.length ? `${problems.length} problem(s) in the e2e coverage map` : "the e2e coverage map is true");
  process.exit(problems.length ? 1 : 0);
}
