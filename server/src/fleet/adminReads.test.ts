// An Admin never reads a person's content in silence (#1080, PROJECT.md "Read This Too", DECISIONS 62). `adminReads.registry.ts` lists every call a route makes that
// returns a person's content and what an Admin who makes it gets. This test scans the route files against it, in the style of `storage/neutral.test.ts`:
// a call that is not listed, a store method that returns text and is not listed, and a listed entry that is no longer true all fail the run.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';
import { ADMIN_READS, NOT_A_READ, type AdminReadEntry } from './adminReads.registry.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECISIONS = path.join(SRC, '..', '..', 'docs', 'decisions');
/** The fields that carry what a person wrote or received. A row type that declares one as a string is a row of content. */
const CONTENT_FIELDS = new Set(['text', 'prompt', 'answer', 'input', 'question', 'plan']);
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}

const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const rel = (file: string): string => path.relative(SRC, file).split(path.sep).join('/');
const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');

/** A file that mounts routes: it imports from express and registers a path with `get`, `post`, `put`, `patch` or `delete` on anything, whatever the router is called. */
const ROUTE_FILES = sourceFiles(SRC).filter((f) => {
  const text = fs.readFileSync(f, 'utf8');
  return /from 'express'/.test(text) && /\.(get|post|put|patch|delete)\(\s*['`/]/.test(text);
});

/** The callee of every call in a file, as written, with call parentheses and non-null marks dropped: `fleet.peers.messages.conversation`, `channels.page`. */
function callees(sf: ts.SourceFile): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && (ts.isPropertyAccessExpression(n.expression) || ts.isIdentifier(n.expression))) {
      const text = n.expression.getText().replace(/\(\)/g, '').replace(/!/g, '').replace(/\?\./g, '.');
      out.push({ text, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Whether a callee ends with a registered call at a segment boundary: `messages.conversation` matches `fleet.peers.messages.conversation`, not `xmessages.conversation`. */
const endsWith = (callee: string, call: string): boolean => callee === call || callee.endsWith(`.${call}`);

describe('the Admin read registry (#1080)', () => {
  it('finds the route files it guards', () => {
    const names = ROUTE_FILES.map(rel);
    for (const f of ['fleet/routes.ts', 'fleet/respondRoutes.ts', 'fleet/peerRoutes.ts', 'fleet/recordingRoutes.ts', 'fleet/chatDmRoutes.ts', 'admin/adminRouter.ts']) expect(names).toContain(f);
  });

  it('lists each call once, with the fields its notice needs', () => {
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const e of ADMIN_READS) {
      const key = `${e.call} ${e.files.join(',')}`;
      if (seen.has(key)) problems.push(`${e.call} is listed twice`);
      seen.add(key);
      if (e.notice === 'told' && !(e.via && e.case)) problems.push(`${e.call} is told: it needs via and case`);
      if (e.notice === 'owner-only' && !e.case) problems.push(`${e.call} is owner-only: it needs a case that shows the refusal`);
      if (e.notice === 'open' && e.decision === undefined && e.issue === undefined) problems.push(`${e.call} is open: it needs the decision or the open issue`);
      if (e.notice !== 'open' && (e.decision !== undefined || e.issue !== undefined)) problems.push(`${e.call} is ${e.notice}: only an open entry carries a decision or an issue`);
    }
    expect(problems).toEqual([]);
  });

  it('has no entry that is no longer true: each call is made in each file it names, the recording call is where it says, and each case and decision exists', () => {
    const problems: string[] = [];
    for (const e of ADMIN_READS) {
      for (const file of e.files) {
        if (!fs.existsSync(path.join(SRC, file))) problems.push(`${e.call}: ${file} does not exist`);
        else if (!callees(parse(path.join(SRC, file))).some((c) => endsWith(c.text, e.call))) problems.push(`${e.call}: ${file} no longer calls it`);
      }
      if (e.via) {
        const where = e.viaFile ?? e.files[0]!;
        if (!fs.existsSync(path.join(SRC, where)) || !callees(parse(path.join(SRC, where))).some((c) => endsWith(c.text, e.via!))) problems.push(`${e.call}: ${where} does not call ${e.via}`);
      }
      if (e.case) {
        if (!fs.existsSync(path.join(SRC, e.case.file))) problems.push(`${e.call}: the case file ${e.case.file} does not exist`);
        else if (!read(e.case.file).replace(/\\'/g, "'").split('\n').some((l) => l.includes(e.case!.title) && /^\s*(it|test)(\.\w+(\([^)]*\))?)?\(/.test(l))) problems.push(`${e.call}: ${e.case.file} has no case titled "${e.case.title}"`);
      }
      if (e.decision !== undefined && !fs.readdirSync(DECISIONS).some((f) => f.startsWith(`${e.decision}-`))) problems.push(`${e.call}: DECISIONS ${e.decision} does not exist`);
    }
    expect(problems).toEqual([]);
  });

  it('fails a route that calls a listed read from a file that is not listed for it', () => {
    const offenders: string[] = [];
    for (const file of ROUTE_FILES) {
      for (const c of callees(parse(file))) {
        for (const e of ADMIN_READS) {
          if (endsWith(c.text, e.call) && !e.files.includes(rel(file))) offenders.push(`${rel(file)}:${c.line} calls ${e.call}, which has no entry for this file`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('fails a store method that returns a row of content when no entry covers it', () => {
    const files = sourceFiles(SRC).map(parse);
    const stringy = (m: ts.PropertySignature): boolean => !!m.type && /^string(\s*\|\s*null)?$/.test(m.type.getText());
    const holdsContent = (n: ts.Node): boolean => {
      let hit = false;
      const walk = (m: ts.Node): void => {
        if (ts.isPropertySignature(m) && CONTENT_FIELDS.has(m.name.getText()) && stringy(m)) hit = true;
        ts.forEachChild(m, walk);
      };
      walk(n);
      return hit;
    };
    const rows = new Set<string>();
    for (const sf of files) {
      const visit = (n: ts.Node): void => {
        if ((ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && holdsContent(n)) rows.add(n.name.text);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(rows.size).toBeGreaterThan(5); // the scan found the row types: a change to how they are declared must not make it pass on nothing
    const covered = new Set<string>([...ADMIN_READS.flatMap((e) => [e.call.split('.').pop()!, ...(e.covers ?? [])]), ...Object.keys(NOT_A_READ)]);
    const offenders: string[] = [];
    for (const sf of files.filter((f) => !/(^|\/)storage\/(sqlite|postgres)\//.test(rel(f.fileName)))) {
      const visit = (n: ts.Node): void => {
        // A private method cannot be called from a route, so it cannot be a read of its own.
        const isPrivate = ts.isMethodDeclaration(n) && !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
        if ((ts.isMethodSignature(n) || ts.isMethodDeclaration(n)) && n.type && !isPrivate) {
          const t = n.type.getText();
          const returnsContent = [...rows].some((r) => new RegExp(`\\b${r}\\b`).test(t)) || holdsContent(n.type);
          const name = n.name.getText();
          if (returnsContent && !covered.has(name)) offenders.push(`${rel(sf.fileName)}: ${name} returns a row of content and has no entry in adminReads.registry.ts`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('keeps NOT_A_READ to methods that exist and that no entry already covers', () => {
    const all = sourceFiles(SRC).filter((f) => !/(^|\/)storage\/(sqlite|postgres)\//.test(rel(f))).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const covered = new Set<string>(ADMIN_READS.map((e: AdminReadEntry) => e.call.split('.').pop()!));
    const problems = Object.keys(NOT_A_READ).flatMap((m) => [
      ...(new RegExp(`\\b${m}\\(`).test(all) ? [] : [`${m} is in NOT_A_READ and is no method of any store or service`]),
      ...(covered.has(m) ? [`${m} is in NOT_A_READ and an entry covers it`] : []),
    ]);
    expect(problems).toEqual([]);
  });
});
