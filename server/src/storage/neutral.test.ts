// The neutral storage contract must not name the SQLite adapter (#313): another database implements `types.ts` without
// reading anything under `sqlite/`. Only `index.ts` may import the adapter, and only on demand, to register its loader.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = path.join(SRC, 'storage', 'sqlite');
const REGISTRY = path.join(SRC, 'storage', 'index.ts');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}

/** Every module specifier a file imports or re-exports, including dynamic `import('x')` and `import x = require('x')`. */
function specifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) out.push(n.argument.literal.text);
    else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Only the static ones: `import`/`export ... from`, not the type-only ones (erased) and not `import('x')`. */
function staticSpecifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  return sf.statements.flatMap((n) => {
    if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly && ts.isStringLiteral(n.moduleSpecifier)) return [n.moduleSpecifier.text];
    if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) return [n.moduleSpecifier.text];
    return [];
  });
}

const names = (s: string): boolean => s.includes('storage/sqlite/') || s.includes('./sqlite/') || s.includes('node:sqlite');

describe('the neutral storage contract', () => {
  const neutral = sourceFiles(SRC).filter((f) => !f.startsWith(ADAPTER + path.sep) && f !== REGISTRY);

  it('finds the files it guards', () => {
    expect(neutral.some((f) => f.endsWith(path.join('storage', 'types.ts')))).toBe(true);
    expect(neutral.some((f) => f.endsWith(path.join('fleet', 'protocol.ts')))).toBe(true);
  });

  it('is not imported by name from the SQLite adapter outside the adapter and the registry', () => {
    const offenders = neutral.flatMap((f) => specifiers(f).filter(names).map((s) => `${path.relative(SRC, f)} imports "${s}"`));
    expect(offenders).toEqual([]);
  });

  it('loads the adapter in the registry only on demand, so a server using one kind never loads another\'s driver', () => {
    expect(specifiers(REGISTRY).some(names)).toBe(true);
    expect(staticSpecifiers(REGISTRY).filter(names)).toEqual([]);
  });

  it('does not reach for the SQLite test handles outside the adapter (test files may)', () => {
    const offenders = neutral.filter((f) => /\b(sqliteHandle|activityHandle)\b/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('names no database outside the adapter and the registry, in code, strings or comments', () => {
    const word = /\b(sqlite|vacuum|pragma|rowid|wal)\b/i;
    const hits = neutral.flatMap((f) =>
      fs.readFileSync(f, 'utf8').split('\n').flatMap((line, i) => {
        const m = word.exec(line);
        return m ? [`${path.relative(SRC, f)}:${i + 1} "${m[1]!.toLowerCase()}"`] : [];
      }),
    );
    expect(hits).toEqual([]);
  });
});
