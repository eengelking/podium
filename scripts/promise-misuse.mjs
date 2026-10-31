#!/usr/bin/env node
// Finds Promise-typed expressions used where a value is expected, or left floating (#809). Since #313 every store call returns a
// promise, and a missed `await` compiles and answers wrongly: `x ?? promise`, `!promise`, `if (promise)` and a dropped result all
// type-check because a promise is always truthy. tsc does not catch them and the repo has no lint rule for them.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';

const USAGE = `Usage: node scripts/promise-misuse.mjs <tsconfig> [--tests]

Loads <tsconfig> with the TypeScript API and reports every place a Promise-typed expression is used where a value is expected
or is left floating. Each finding prints as file:line: kind: source text. Exits 1 when a finding is not allowed, 0 when there is
none, 2 for a bad argument. --tests also checks the test files (*.test.ts, *.test.tsx).

Kinds
  condition        a Promise in an if, while, do, for or ternary condition
  negated          a Promise under !
  logical-operand  a Promise as the left operand of &&, || or ??
  comparison       a Promise as an operand of ==, !=, ===, !==, <, <=, > or >=
  floating         an expression statement that is a Promise and is not awaited, voided or given a rejection handler
  missing-reason   a promise-ok comment with no reason after the colon
  unused-allow     a promise-ok comment that allows nothing

Handled, so not floating: a chain that ends in .catch(...), a chain that ends in .finally(...) after a .catch or a two-argument .then, and
.then(onFulfilled, onRejected) with both arguments. An assignment is not a statement of its own value, and a return is not a statement. Only a type that is exactly a Promise is
checked: a Promise | null is meant to be tested for null, so "if (this.inFlight)" on one is not a finding.

Allowing a deliberate case: a comment on the same line or the line before,
  // promise-ok: <why a reviewer can judge this is right>
The reason is required. A comment that allows nothing is reported, so stale marks do not pile up.

Examples
  node scripts/promise-misuse.mjs server/tsconfig.json --tests
  node scripts/promise-misuse.mjs scripts/tsconfig.json --tests
`;

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);
const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

const unwrap = (node) => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);

/** True when the chain already has a rejection handler: `.catch(...)`, `.then(a, b)`, or `.finally(...)` after one of those. */
function handled(expression) {
  const node = unwrap(expression);
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const name = node.expression.name.text;
  if (name === 'catch') return true;
  if (name === 'then') return node.arguments.length >= 2;
  return name === 'finally' && handled(node.expression.expression);
}

/** The expressions whose value a statement drops: the statement itself, or each branch of `c ? a : b` and the right side of `c && a`, `c || a`, `c ?? a`. */
function floatingParts(expression) {
  const node = unwrap(expression);
  if (ts.isConditionalExpression(node)) return [...floatingParts(node.whenTrue), ...floatingParts(node.whenFalse)];
  if (ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind)) return floatingParts(node.right);
  return [node];
}

const ALLOW = 'promise-ok';

/** The reason in a `promise-ok: <why>` comment ('' when there is none), or null when the comment is not one. A longer word such as promise-okay is not the marker. */
function allowReason(body) {
  if (!body.startsWith(ALLOW)) return null;
  const rest = body.slice(ALLOW.length);
  if (/^\w/.test(rest)) return null;
  return rest.startsWith(':') ? rest.slice(1).split('\n')[0].trim() : '';
}

/** Every real comment of the source (not text in a string) that starts with `promise-ok`: [{ line, reason }], reason '' when missing. */
function allowComments(source) {
  if (!source.text.includes('promise-ok')) return [];
  const seen = new Map();
  const collect = (ranges) => {
    for (const range of ranges ?? []) seen.set(range.pos, range);
  };
  const walk = (node) => {
    collect(ts.getLeadingCommentRanges(source.text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(source.text, node.end));
    ts.forEachChild(node, walk);
  };
  walk(source);
  const comments = [];
  for (const range of seen.values()) {
    const body = source.text.slice(range.pos, range.end).replace(/^\/\/|^\/\*|\*\/$/g, '').trim();
    const reason = allowReason(body);
    if (reason !== null) comments.push({ pos: range.pos, line: source.getLineAndCharacterOfPosition(range.pos).line + 1, reason, text: body });
  }
  return comments;
}

/** Finds every finding in `tsconfig`; `tests` includes *.test.ts(x). Returns [{ file (absolute), line, kind, text }]. */
export function scan(tsconfig, { tests = false } = {}) {
  const config = ts.getParsedCommandLineOfConfigFile(path.resolve(tsconfig), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  });
  if (config.fileNames.length === 0) throw new Error(`${tsconfig} matches no source files, so nothing was checked`);
  const program = ts.createProgram(config.fileNames, config.options);
  const checker = program.getTypeChecker();
  const wanted = new Set(config.fileNames.map((f) => path.resolve(f)));
  const isPromise = (node) => checker.getTypeAtLocation(node).symbol?.name === 'Promise';
  const findings = [];

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !wanted.has(path.resolve(source.fileName))) continue;
    if (!tests && /\.test\.tsx?$/.test(source.fileName)) continue;
    const found = [];
    const report = (node, kind) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      found.push({ file: path.resolve(source.fileName), line, kind, text: node.getText(source).replaceAll(/\s+/g, ' ').trim().slice(0, 100) });
    };
    const check = (node, kind) => {
      if (node && isPromise(node)) report(node, kind);
    };
    const visit = (node) => {
      if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) check(node.expression, 'condition');
      else if (ts.isForStatement(node)) check(node.condition, 'condition');
      else if (ts.isConditionalExpression(node)) check(node.condition, 'condition');
      else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) check(node.operand, 'negated');
      else if (ts.isBinaryExpression(node)) {
        const kind = node.operatorToken.kind;
        if (LOGICAL.has(kind)) check(node.left, 'logical-operand');
        else if (COMPARISONS.has(kind)) {
          check(node.left, 'comparison');
          check(node.right, 'comparison');
        }
      } else if (ts.isExpressionStatement(node)) {
        const expression = unwrap(node.expression);
        const isAssignment = ts.isBinaryExpression(expression) && expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        const isVoidOrAwait = ts.isVoidExpression(expression) || ts.isAwaitExpression(expression);
        if (!isAssignment && !isVoidOrAwait) for (const part of floatingParts(expression)) if (!handled(part) && isPromise(part)) report(part, 'floating');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    // A promise-ok comment with a reason allows a finding on its own line or the next one; one without a reason allows nothing.
    const comments = allowComments(source);
    const used = new Set();
    for (const finding of found) {
      const allow = comments.find((c) => c.reason !== '' && (c.line === finding.line || c.line === finding.line - 1));
      if (allow) used.add(allow);
      else findings.push(finding);
    }
    for (const c of comments) {
      const kind = c.reason === '' ? 'missing-reason' : used.has(c) ? null : 'unused-allow';
      if (kind) findings.push({ file: path.resolve(source.fileName), line: c.line, kind, text: c.text.slice(0, 100) });
    }
  }
  const comment = (f) => (f.kind === 'missing-reason' || f.kind === 'unused-allow' ? 0 : 1); // on one line, the comment comes first
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || comment(a) - comment(b));
}

/** `file:line: kind: text`, with the file relative to the working directory. */
export function format(finding) {
  return `${path.relative(process.cwd(), finding.file)}:${finding.line}: ${finding.kind}: ${finding.text}`;
}

const STDIO = { out: (s) => void process.stdout.write(`${s}\n`), err: (s) => void process.stderr.write(`${s}\n`) };

/** The command line. `write` takes { out, err } so a test can capture the output; returns the exit code. */
export function run(argv, write = STDIO) {
  if (argv.includes('--help') || argv.includes('-h')) {
    write.out(USAGE.trimEnd());
    return 0;
  }
  const unknown = argv.filter((a) => a.startsWith('-') && a !== '--tests');
  const positional = argv.filter((a) => !a.startsWith('-'));
  if (unknown.length > 0 || positional.length !== 1) {
    if (unknown.length > 0) write.err(`Unknown option: ${unknown[0]}`);
    write.err(USAGE.trimEnd());
    return 2;
  }
  if (!existsSync(positional[0])) {
    write.err(`No such file: ${positional[0]}`);
    return 2;
  }
  let findings;
  try {
    findings = scan(positional[0], { tests: argv.includes('--tests') });
  } catch (error) {
    write.err(`promise-misuse: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  for (const finding of findings) write.out(format(finding));
  write.out(findings.length === 0 ? 'promise-misuse: no findings' : `promise-misuse: ${findings.length} finding(s)`);
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv.slice(2));
