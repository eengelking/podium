#!/usr/bin/env node
// Check that every list query reads in the same order in every storage adapter (#910). The contract cases compare behavior on the
// data a scenario builds, and TypeScript makes every adapter implement every method, but nothing compared the queries themselves,
// so a query could ship with an ORDER BY in one adapter and none in the other with every test green.
// Usage: node scripts/storage-order-parity.mjs [--root <repo folder>] [--list]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";

const HELP = `Usage: node scripts/storage-order-parity.mjs [--root <repo folder>] [--list]
Reads every query in each adapter folder under server/src/storage/ (the sub-folders: sqlite, postgres, and any later one), pairs each
store method with its counterpart in the other adapters, and fails (exit 1) when a method that returns a list (a SELECT run with
.all), one row picked from several (a SELECT with an ORDER BY or a LIMIT run with .get) or a write with a subquery that takes the
first row of an ordered set (ORDER BY ... LIMIT in a subquery) is unordered or ordered differently:
  - one adapter states an ORDER BY and another does not;
  - the adapters order by different columns, after the dialect is normalized (podium_lower and lower, placeholders, collation,
    table aliases, ASC);
  - the adapters put NULLs in different places for a column the schema lets be NULL. SQLite sorts NULL first in ASC and last in DESC,
    PostgreSQL the reverse, so a term that says nothing is read by its dialect's default and one that says NULLS FIRST or LAST by what
    it says; a column declared NOT NULL, a COALESCE, and the sequence numbers in NEVER_NULL have no NULLs to place;
  - an adapter has no ORDER BY and the query is not marked order-insensitive (a .get that takes the first row with no ORDER BY; a
    SELECT 1 probe for existence is not one);
  - a method that runs a list query has no counterpart in another adapter.
Each failure names the method, the adapter, the file and the line.
A list whose order does not matter (a set of ids, a total) is marked with a comment next to the query that gives the reason:
  // order-insensitive: <why>
--list prints every list query it found with its normalized order. --root defaults to this repository.`;

// File names that differ between the adapters for the same store: the SQLite file name -> the PostgreSQL one.
const FILE_ALIASES = { db: "fleet" };
// Files that are not stores: tests, fixtures and the schema.
const SKIP_FILE = /(\.test\.|testing|Testing|Fixtures|contractReference|contractAdapter|schema\.)/;
const MARKER = /order-insensitive:[ \t]*\S/;

/** The adapter folders under `<root>/server/src/storage`, as { name, dir }. */
function adapterFolders(root) {
  const base = join(root, "server", "src", "storage");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ name: e.name, dir: join(base, e.name) }));
}

/** The name a node is known by when it is a method, a function, or a property or variable holding a function; else null. */
function nameOf(node) {
  const fnLike = (n) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
  if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name) return node.name.getText();
  if ((ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && fnLike(node.initializer)) return node.name.getText();
  return null;
}

/** The text of an SQL argument, with each ${...} replaced by "…". Returns null when it cannot be read. */
function sqlText(arg, fn, sf) {
  /** What a `const` of this name holds in the function, else in the file; null when it is not text. */
  const named = (id, depth) => {
    let got = null;
    const find = (n) => {
      if (got === null && ts.isVariableDeclaration(n) && n.name.getText() === id && n.initializer) got = own(n.initializer, depth + 1);
      ts.forEachChild(n, find);
    };
    if (fn) find(fn);
    if (got === null) find(sf);
    return got;
  };
  const span = (e, depth) => (ts.isIdentifier(e) && depth < 4 ? named(e.text, depth) : null) ?? "…";
  const own = (n, depth = 0) => {
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((t) => span(t.expression, depth) + t.literal.text).join("");
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = own(n.left, depth);
      const b = own(n.right, depth);
      return a === null || b === null ? null : a + b;
    }
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) return own(n.expression, depth);
    return null;
  };
  const direct = own(arg);
  if (direct !== null) return direct;
  if (!ts.isIdentifier(arg) || !fn) return null;
  // A variable: join what it is given in the enclosing function (`const sql = ...`, `sql += ...`).
  const parts = [];
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && n.name.getText() === arg.text && n.initializer) parts.push(own(n.initializer));
    else if (ts.isBinaryExpression(n) && n.left.getText() === arg.text && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken].includes(n.operatorToken.kind)) parts.push(own(n.right));
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return parts.length && parts.every((p) => p !== null) ? parts.join(" ") : null;
}

const READ_CALLS = new Set(["all", "get", "run"]);

/**
 * Whether a get or run takes rows in an order that matters: a get that reads one row out of several (it has an ORDER BY or a LIMIT),
 * or a write with a subquery that takes the first rows of an ordered set. A get of a row by its key is not one.
 */
function picksRows(kind, text) {
  const subquery = clauses(text).some((c) => c.nested && c.limited);
  if (kind === "get") return /^\s*(select|with)\b/i.test(text) && (subquery || clauses(text).some((c) => !c.nested) || takesFirst(text));
  return subquery;
}

/** Whether a SELECT of rows (not a bare `SELECT 1` probe for existence) has a LIMIT of its own, outside any parenthesis. */
export function takesFirst(text) {
  if (/^\s*select\s+1\b/i.test(text)) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (depth === 0 && /^limit\b/i.test(text.slice(i)) && /\W/.test(text[i - 1] ?? " ")) return true;
  }
  return false;
}

/** The queries in one file whose row order matters: { kind, method, line, text, marked }. text is null when the SQL cannot be read. */
function listQueries(file) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const lines = src.split("\n");
  const out = [];
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  /** The comment lines directly above a 0-based line, joined. */
  const commentsAbove = (line) => {
    const got = [];
    for (let i = line - 1; i >= 0 && /^\s*(\/\/|\/\*|\*)/.test(lines[i]); i--) got.push(lines[i]);
    return got.join("\n");
  };
  const marked = (call) => {
    let stmt = call;
    while (stmt.parent && !ts.isBlock(stmt.parent) && !ts.isSourceFile(stmt.parent)) stmt = stmt.parent;
    const span = lines.slice(lineOf(call.getStart()), lineOf(call.getEnd()) + 1).join("\n");
    return MARKER.test([span, commentsAbove(lineOf(call.getStart())), commentsAbove(lineOf(stmt.getStart()))].join("\n"));
  };
  // A method that runs the SQL it is given (`rows(sql, ...args)`): its callers' literals are the queries.
  const helpers = new Set();
  const visit = (node, method, fn) => {
    const name = nameOf(node);
    if (name) {
      method = name;
      fn = node;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && READ_CALLS.has(node.expression.name.text)) {
      // SQLite: stmt(sql).all(...args). PostgreSQL: db.all(sql, args). The same for get (one row) and run (a write).
      const kind = node.expression.name.text;
      let target = node.expression.expression;
      // A prepared statement kept in a variable: `const back = this.st(sql); back.all(...)`.
      if (ts.isIdentifier(target) && fn) {
        let init = null;
        const find = (n) => {
          if (ts.isVariableDeclaration(n) && n.name.getText() === target.text && n.initializer && ts.isCallExpression(n.initializer)) init = n.initializer;
          ts.forEachChild(n, find);
        };
        find(fn);
        if (init) target = init;
      }
      const arg = ts.isCallExpression(target) ? target.arguments[0] : node.arguments[0];
      if (arg && ts.isIdentifier(arg) && fn?.parameters?.some((p) => p.name.getText() === arg.text)) {
        if (kind === "all") helpers.add(method);
        return;
      }
      if (arg && (ts.isCallExpression(target) || /\bdb\b/.test(target.getText()))) {
        const text = sqlText(arg, fn, sf);
        const query = { kind, limited: text !== null && takesFirst(text), method: method ?? "(module)", line: lineOf(node.getStart()) + 1, text, marked: marked(node) };
        if (kind === "all" ? text === null || /^\s*(select|with)\b/i.test(text) : text !== null && picksRows(kind, text)) out.push(query);
      }
    }
    ts.forEachChild(node, (c) => visit(c, method, fn));
  };
  visit(sf, null, null);
  const calls = (node, method, fn) => {
    const name = nameOf(node);
    if (name) {
      method = name;
      fn = node;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && helpers.has(node.expression.name.text) && node.arguments[0]) {
      const text = sqlText(node.arguments[0], fn, sf);
      if (text === null || /^\s*(select|with)\b/i.test(text)) out.push({ kind: "all", method: method ?? "(module)", line: lineOf(node.getStart()) + 1, text, marked: marked(node) });
    }
    ts.forEachChild(node, (c) => calls(c, method, fn));
  };
  if (helpers.size) calls(sf, null, null);
  return out;
}

/** The ORDER BY clauses of a query: { text, nested, limited }. nested: inside a subquery or an OVER (...); limited: the clause ends at a LIMIT. */
function clauses(sql) {
  const found = [];
  const word = /\border\s+by\b/gi;
  for (let m; (m = word.exec(sql)); ) {
    let open = 0;
    for (const c of sql.slice(0, m.index)) open += c === "(" ? 1 : c === ")" ? -1 : 0;
    // The clause runs to LIMIT, OFFSET, UNION or FOR UPDATE, or to the parenthesis that closes the subquery it is in.
    let depth = 0;
    let end = sql.length;
    let limited = false;
    for (let i = m.index + m[0].length; i < sql.length; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")" && depth-- === 0) {
        end = i;
        break;
      } else if (depth === 0 && /^(limit|offset|union|for\s+update)\b/i.test(sql.slice(i)) && /\W/.test(sql[i - 1])) {
        end = i;
        limited = /^limit/i.test(sql.slice(i));
        break;
      }
    }
    found.push({ text: sql.slice(m.index + m[0].length, end), nested: open > 0, limited });
  }
  return found;
}

/** The terms of an ORDER BY clause, split at the commas outside parentheses. */
function terms(clause) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < clause.length; i++) {
    if (clause[i] === "(") depth++;
    else if (clause[i] === ")") depth--;
    else if (clause[i] === "," && depth === 0) {
      out.push(clause.slice(from, i));
      from = i + 1;
    }
  }
  out.push(clause.slice(from));
  return out;
}

/** Where a NULL sorts when the term does not say: SQLite treats NULL as the smallest value, PostgreSQL as the largest. */
const defaultNulls = (adapter, desc) => ((adapter === "sqlite") !== desc ? "first" : "last");

/** A test for "can this column be NULL in a table the query reads", from the schema's { table -> nullable columns }; null with no schema. */
function nullTest(sql, schema) {
  if (!schema) return null;
  const tables = [...sql.matchAll(/\b(?:from|join)\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
  return (id) => tables.some((t) => schema.get(t)?.has(id) && !NEVER_NULL.has(`${t}.${id}`));
}

/**
 * One ORDER BY term with the dialect differences removed. When `nullable` (a test from nullTest)
 * is given and the term reads a column that can be NULL, the term ends with the placement of NULLs it really has: the one it states, or else its
 * dialect's default. A term over a column that cannot be NULL, or one wrapped in COALESCE, has no NULLs to place.
 */
function termOf(t, adapter, nullable) {
  const low = t.toLowerCase();
  const stated = /\bnulls\s+(first|last)\b/.exec(low)?.[1];
  const desc = /\bdesc\b/.test(low);
  const expr = low
    .replace(/\bnulls\s+(first|last)\b/g, "")
    .replace(/podium_lower\(/g, "lower(")
    .replace(/\bcollate\s+("[^"]*"|\w+)/g, "")
    .replace(/:\w+|\$\d+|\?/g, "?")
    .replace(/\b\w+\./g, "")
    .replace(/\basc\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // every identifier that is not a function name (not followed by an opening parenthesis)
  const reads = [...expr.matchAll(/[a-z_]\w*/g)].some((m) => !/^\s*\(/.test(expr.slice(m.index + m[0].length)) && nullable?.(m[0]));
  const nulls = nullable && reads && !expr.includes("coalesce(") ? ` nulls ${stated ?? defaultNulls(adapter, desc)}` : "";
  return expr + nulls;
}

const clauseOf = (c, adapter, nullable) =>
  terms(c)
    .map((t) => termOf(t, adapter, nullable))
    .join(", ")
    .replace(/ ?, ?/g, ", ");

/**
 * The ORDER BY clauses of the whole query as one string with the dialect differences removed; "" when there is none. Without
 * `schema` (from nullableColumns), the placement of NULLs is dropped; with it, it is kept for the columns that can be NULL (see termOf).
 * @param {string} sql
 * @param {string} [adapter]
 * @param {Map<string, Set<string>> | null} [schema]
 */
export function orderOf(sql, adapter = "sqlite", schema = null) {
  return clauses(sql)
    .filter((c) => !c.nested)
    .map((c) => clauseOf(c.text, adapter, nullTest(sql, schema)))
    .join(" | ");
}

/** The ORDER BY clauses of the subqueries that take their first rows (`... ORDER BY t DESC LIMIT 1`), which pick one row and so need an order.
 * @param {string} sql
 * @param {string} [adapter]
 * @param {Map<string, Set<string>> | null} [schema]
 */
export function subOrderOf(sql, adapter = "sqlite", schema = null) {
  return clauses(sql)
    .filter((c) => c.nested && c.limited)
    .map((c) => clauseOf(c.text, adapter, nullTest(sql, schema)))
    .join(" | ");
}

/**
 * Columns that are declared nullable in a schema but hold a value in every row the store writes (a backfilled sequence number that is
 * only a tie-breaker), so the placement of NULLs among them does not matter. Each needs its reason here.
 */
const NEVER_NULL = new Set([
  "peer_messages.seq", // ADD COLUMN cannot be NOT NULL on SQLite; the migration backfills it and the store always assigns one
  "peer_requests.seq", // the same
  "person_certificates.seq", // the same
]);

/** The columns the schemas in the adapters declare without NOT NULL or a key, as a Map of table name -> Set of lower-case column names. */
export function nullableColumns(root) {
  const schema = new Map();
  const add = (table, col) => schema.set(table, (schema.get(table) ?? new Set()).add(col));
  const skip = /^(primary|unique|foreign|check|constraint)\b/i;
  for (const { dir } of adapterFolders(root)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !/\.test\./.test(x))) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\s+([^;`'\n]*)/gi)) if (!/not\s+null/i.test(m[3])) add(m[1].toLowerCase(), m[2].toLowerCase());
      for (const m of src.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?(\w+)\s*\(/gi)) {
        let depth = 1;
        let end = m.index + m[0].length;
        while (end < src.length && depth > 0) depth += src[end++] === "(" ? 1 : src[end - 1] === ")" ? -1 : 0;
        for (const part of terms(src.slice(m.index + m[0].length, end - 1))) {
          const def = part.trim();
          const col = /^"?(\w+)"?\s+\w+/.exec(def);
          if (col && !skip.test(def) && !/not\s+null|primary\s+key|generated/i.test(def)) add(m[1].toLowerCase(), col[1].toLowerCase());
        }
      }
    }
  }
  return schema;
}

/** What a query's order is made of: order (its own ORDER BY), sub (those of its subqueries that take the first rows) and cmp (both, to compare). */
function orderFields(text, adapter, schema) {
  if (text === null) return { order: null, sub: "", cmp: null };
  const order = orderOf(text, adapter, schema);
  const sub = subOrderOf(text, adapter, schema);
  return { order, sub, cmp: [order, sub && `(first rows: ${sub})`].filter(Boolean).join(" ") };
}

/** Every query under the adapters whose row order matters: { adapter, file, key, kind, method, line, order, sub, cmp, marked, text }. */
export function collect(root) {
  const all = [];
  const schema = nullableColumns(root);
  for (const { name, dir } of adapterFolders(root)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !SKIP_FILE.test(x)).sort((a, b) => a.localeCompare(b))) {
      const stem = basename(f, ".ts");
      for (const q of listQueries(join(dir, f))) {
        const fileKey = name === "sqlite" ? (FILE_ALIASES[stem] ?? stem) : stem;
        all.push({ adapter: name, file: `server/src/storage/${name}/${f}`, key: `${fileKey}#${q.method}`, ...q, ...orderFields(q.text, name, schema) });
      }
    }
  }
  return all;
}

/** The problems with a set of list queries, each as { adapter, file, line, method, message }. */
export function problems(queries, adapters) {
  const out = [];
  const add = (q, message) => out.push({ adapter: q.adapter, file: q.file, line: q.line, method: q.method, message });
  const byKey = new Map();
  for (const q of queries) byKey.set(q.key, [...(byKey.get(q.key) ?? []), q]);
  const byMethod = new Map();
  for (const q of queries) byMethod.set(q.method, [...(byMethod.get(q.method) ?? []), q]);
  for (const q of queries) {
    if (q.marked) continue;
    if (q.order === null) add(q, "the query text cannot be read from the source; write it as a literal, or mark it with `// order-insensitive: <why>`");
    else if (q.order === "" && q.kind === "all") add(q, "returns a list with no ORDER BY; add one in every adapter, or mark it with `// order-insensitive: <why>`");
    else if (q.order === "" && q.kind === "get" && q.limited) add(q, "reads one row out of several with no ORDER BY; add one in every adapter, or mark it with `// order-insensitive: <why>`");
  }
  for (const [key, group] of byKey) {
    const present = new Set(group.map((q) => q.adapter));
    for (const q of group.filter((x) => !x.marked)) {
      for (const other of adapters.filter((a) => a !== q.adapter && !present.has(a))) {
        // Another file may hold the counterpart under a different name; accept a method of that name that no other key claims.
        const same = (byMethod.get(q.method) ?? []).filter((m) => m.adapter === other);
        if (!same.length) add(q, `no counterpart for ${key} in ${other}`);
      }
    }
    // An ORDER BY with a ${...} in it is built at run time: it counts as stated, and its columns cannot be compared here.
    const ordered = adapters.map((a) => ({ a, set: [...new Set(group.filter((q) => q.adapter === a && !q.marked && q.cmp && !q.cmp.includes("…")).map((q) => q.cmp))].sort((a, b) => a.localeCompare(b)) })).filter((x) => x.set.length);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[0].set.join(" ; ") !== ordered[i].set.join(" ; ")) {
        const q = group.find((x) => x.adapter === ordered[i].a && x.cmp);
        add(q, `orders by ${ordered[i].set.join(" ; ")} but ${ordered[0].a} orders by ${ordered[0].set.join(" ; ")}`);
      }
    }
  }
  return out;
}

/** Run the check on the repository at `root`; the result has the problems and the queries read. */
export function check(root) {
  const queries = collect(root);
  return { queries, problems: problems(queries, adapterFolders(root).map((a) => a.name)) };
}

export function run(argv, log = console.log) {
  if (argv.includes("--help") || argv.includes("-h")) {
    log(HELP);
    return 0;
  }
  const i = argv.indexOf("--root");
  const root = i >= 0 ? argv[i + 1] : join(fileURLToPath(import.meta.url), "..", "..");
  const { queries, problems: found } = check(root);
  if (argv.includes("--list")) for (const q of queries) log(`${q.file}:${q.line}  ${q.key}  ${q.marked ? "(order-insensitive)" : (q.order ?? "(unreadable)")}`);
  if (!queries.length) {
    log(`storage-order-parity: no list queries found under ${root}/server/src/storage`);
    return 1;
  }
  for (const p of found) log(`${p.file}:${p.line}: ${p.adapter} ${p.method}: ${p.message}`);
  log(found.length ? `storage-order-parity: ${found.length} problem(s) in ${queries.length} list queries` : `storage-order-parity: ${queries.length} list queries agree`);
  return found.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = run(process.argv.slice(2));
