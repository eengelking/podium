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
.all) is unordered or ordered differently:
  - one adapter states an ORDER BY and another does not;
  - the adapters order by different columns, after the dialect is normalized (podium_lower and lower, NULLS FIRST and LAST,
    placeholders, collation, table aliases, ASC);
  - an adapter has no ORDER BY and the query is not marked order-insensitive;
  - a method that runs a list query has no counterpart in another adapter.
Each failure names the method, the adapter, the file and the line.
A list whose order does not matter (a set of ids, a total) is marked with a comment next to the query that gives the reason:
  // order-insensitive: <why>
--list prints every list query it found with its normalized order. --root defaults to this repository.`;

// File names that differ between the adapters for the same store: the SQLite file name -> the PostgreSQL one.
const FILE_ALIASES = { db: "fleet" };
// Files that are not stores: tests, fixtures and the schema.
const SKIP_FILE = /(\.test\.|testing|Testing|Fixtures|contractReference|schema\.)/;
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

/** The list queries in one file: { method, line, text, marked }. text is null when the SQL cannot be read. */
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
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "all") {
      // SQLite: stmt(sql).all(...args). PostgreSQL: db.all(sql, args).
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
        helpers.add(method);
        return;
      }
      if (arg && (ts.isCallExpression(target) || /\bdb\b|\bthis\.db$/.test(target.getText()))) {
        const text = sqlText(arg, fn, sf);
        if (text === null || /^\s*(select|with)\b/i.test(text)) out.push({ method: method ?? "(module)", line: lineOf(node.getStart()) + 1, text, marked: marked(node) });
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
      if (text === null || /^\s*(select|with)\b/i.test(text)) out.push({ method: method ?? "(module)", line: lineOf(node.getStart()) + 1, text, marked: marked(node) });
    }
    ts.forEachChild(node, (c) => calls(c, method, fn));
  };
  if (helpers.size) calls(sf, null, null);
  return out;
}

/** The ORDER BY clauses of a query as one string with the dialect differences removed; "" when there is none. */
export function orderOf(sql) {
  const found = [];
  const word = /\border\s+by\b/gi;
  for (let m; (m = word.exec(sql)); ) {
    // Only the ORDER BY of the whole query orders its result: not one in OVER (...) or in a subquery.
    let open = 0;
    for (const c of sql.slice(0, m.index)) open += c === "(" ? 1 : c === ")" ? -1 : 0;
    if (open > 0) continue;
    // The clause runs to LIMIT, OFFSET, UNION or FOR UPDATE, or to the parenthesis that closes the subquery it is in.
    let depth = 0;
    let end = sql.length;
    for (let i = m.index + m[0].length; i < sql.length; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")" && depth-- === 0) {
        end = i;
        break;
      } else if (depth === 0 && /^(limit|offset|union|for\s+update)\b/i.test(sql.slice(i)) && /\W/.test(sql[i - 1])) {
        end = i;
        break;
      }
    }
    found.push(sql.slice(m.index + m[0].length, end));
  }
  return found
    .map((c) =>
      c
        .toLowerCase()
        .replace(/podium_lower\(/g, "lower(")
        .replace(/\bnulls\s+(first|last)\b/g, "")
        .replace(/\bcollate\s+("[^"]*"|\w+)/g, "")
        .replace(/:\w+|\$\d+|\?/g, "?")
        .replace(/\b\w+\./g, "")
        .replace(/\basc\b/g, "")
        .replace(/\s+/g, " ")
        .replace(/\s*,\s*/g, ", ")
        .trim(),
    )
    .join(" | ");
}

/** Every list query under the adapters: { adapter, file, key, method, line, order, marked, text }. */
export function collect(root) {
  const all = [];
  for (const { name, dir } of adapterFolders(root)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !SKIP_FILE.test(x)).sort()) {
      const stem = basename(f, ".ts");
      for (const q of listQueries(join(dir, f))) {
        const fileKey = name === "sqlite" ? (FILE_ALIASES[stem] ?? stem) : stem;
        all.push({ adapter: name, file: `server/src/storage/${name}/${f}`, key: `${fileKey}#${q.method}`, ...q, order: q.text === null ? null : orderOf(q.text) });
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
    else if (q.order === "") add(q, "returns a list with no ORDER BY; add one in every adapter, or mark it with `// order-insensitive: <why>`");
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
    const ordered = adapters.map((a) => ({ a, set: [...new Set(group.filter((q) => q.adapter === a && !q.marked && q.order && !q.order.includes("…")).map((q) => q.order))].sort() })).filter((x) => x.set.length);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[0].set.join(" ; ") !== ordered[i].set.join(" ; ")) {
        const q = group.find((x) => x.adapter === ordered[i].a && x.order);
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
