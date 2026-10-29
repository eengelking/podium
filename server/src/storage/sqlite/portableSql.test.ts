import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// #808: SQLite's JSON functions are spelled differently (or are missing) in other SQL databases, so no query in the adapter uses them.
// A word counts only inside a string or template literal, so a TypeScript arrow `=>` or a comment never trips this.
const dir = path.dirname(new URL(import.meta.url).pathname);
const JSON_SQL = /\b(?:json_extract|json_each|json_object|json_group_array)\b|->>|->\s*['"]?\$/i;

/** Every `file:line word` where a SQL string in `source` uses a SQLite-only JSON function or operator. */
function findJsonSql(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const check = (node: ts.Node, text: string) => {
    const m = JSON_SQL.exec(text);
    if (m) hits.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${m[0]}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) check(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('portable SQL in the SQLite adapter (#808)', () => {
  it('finds a JSON function or operator in a string or template, and nothing else', () => {
    expect(findJsonSql('x.ts', "db.prepare('SELECT json_extract(a, \"$.b\") FROM t')")).toEqual(['x.ts:1 json_extract']);
    expect(findJsonSql('x.ts', 'const q = `SELECT ${c} FROM json_each(?)`;')).toEqual(['x.ts:1 json_each']);
    expect(findJsonSql('x.ts', 'const q = `SELECT ${c} , data ->> \'$.k\'`;')).toEqual(['x.ts:1 ->>']);
    expect(findJsonSql('x.ts', "const q = 'SELECT JSON_GROUP_ARRAY(x)';")).toEqual(['x.ts:1 JSON_GROUP_ARRAY']);
    expect(findJsonSql('x.ts', "// json_extract in a comment\nconst f = (a: Map<string, number>) => a.size; const s = 'plain';")).toEqual([]);
  });

  it('has no json_extract, json_each, json_object, json_group_array or JSON arrow in a query under server/src/storage/sqlite', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap((f) => findJsonSql(`server/src/storage/sqlite/${f}`, readFileSync(path.join(dir, f), 'utf8')));
    expect(hits).toEqual([]);
  });
});
