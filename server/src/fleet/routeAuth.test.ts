// Every route that changes state is behind a gate, or is on a written list with its reason (#1052). A new write route that skips auth fails here.
// The scan is in the style of `adminReads.test.ts` and `storage/neutral.test.ts`: it reads the route files, not a running server.
//
// A write route (`post`, `put`, `patch`, `delete`) passes when it is behind one of these gates:
//   - token:    `requireToken` (or `d.requireToken`) is one of its arguments, so it runs before the body is parsed;
//   - reporter: `authenticate` is one of its arguments (the reporter's certificate renewal, `tlsReporterRenew.ts`);
//   - admin:    it is registered in `admin/adminRouter.ts` after the one `router.use` that requires an unlocked Admin session;
//   - viewer:   it is a route of the browser router and its handler asks for the signed-in viewer before it does anything
//               (`viewer`, `viewerOf`, `owner`, `target`, `access` or `browserSession`).
// Anything else must be in ALLOWED_WITHOUT_GATE with a reason. Changing which routes need a token is out of scope here.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A write route that has none of the gates above, keyed `METHOD /path` as written in the source, with why that is right. */
const ALLOWED_WITHOUT_GATE: Record<string, string> = {
  'POST /sessions/:id/drop': 'Removes a card the server was about to drop anyway (a heartbeat-lost one), like the other reads the console makes. SPEC 7.1, 7.5.',
  'POST /notices/:id/close': 'Closes a wall notice; it changes how the wall looks for everyone and the wall has no sign-in. Logged with the source. SPEC 7.1, 8.1.',
  'POST /update-notice/close': 'Hides the release the server is offering, for everyone, and only that release; a newer one shows again. Logged with the source. #499, SPEC 8.1.',
  'PUT /wall/background-sessions': 'The Show/Hide link on the background-sessions note; it changes how the wall looks. Logged with the source. SPEC 7.1, 8.1.',
  'POST /unlock': 'How an Admin session is opened: it takes the admin secret or a person token in the body and is throttled.',
  'POST /unlock/from-respond': 'Opens an Admin session from the console sign-in of an Administrator; it checks that sign-in itself.',
  'POST /sign-in': 'How a person signs in to the console: it takes their token in the body, and is throttled.',
  'POST /sign-out': 'Ends the caller’s own console sign-in by its cookie and changes nothing else.',
};

type Write = { file: string; line: number; method: string; route: string; gate: string | null };

const WRITE = new Set(['post', 'put', 'patch', 'delete']);
const TOKEN_GATES = new Set(['requireToken', 'authenticate']);
const VIEWER_GATE = /\b(?:viewer|viewerOf|owner|target|access|browserSession)\(/;

/** The name an argument ends in: `requireToken` and `d.requireToken` are both `requireToken`. */
function nameOf(n: ts.Expression): string | null {
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  return null;
}

/** Every write route a source registers, and the gate each has (null for none). Exported shape is local: the test below also feeds it small snippets. */
function writes(file: string, text: string): Write[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const isAdmin = file.endsWith('admin/adminRouter.ts');
  let adminGateEnd = Number.POSITIVE_INFINITY; // where the unlock `router.use` ends; a route after it is behind it
  if (isAdmin) {
    adminGateEnd = -1;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'use' && /sessionValid\(req\)/.test(n.getText()) && /'locked'/.test(n.getText())) adminGateEnd = n.getEnd();
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const out: Write[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && WRITE.has(n.expression.name.text) && n.arguments.length >= 2) {
      const first = n.arguments[0]!;
      const route = ts.isStringLiteralLike(first) ? first.text : ts.isIdentifier(first) ? `\${${first.text}}` : null;
      if (route !== null) {
        const method = n.expression.name.text.toUpperCase();
        const receiver = n.expression.expression.getText();
        const middle = n.arguments.slice(1, -1);
        const handler = n.arguments[n.arguments.length - 1]!;
        let gate: string | null = null;
        if (middle.some((a) => TOKEN_GATES.has(nameOf(a) ?? ''))) gate = 'token';
        else if (isAdmin && n.getStart() > adminGateEnd) gate = 'admin';
        else if (receiver === 'browser' && VIEWER_GATE.test(handler.getText())) gate = 'viewer';
        out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, method, route, gate });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}
const rel = (file: string): string => path.relative(SRC, file).split(path.sep).join('/');

/** A file that mounts routes, as in `adminReads.test.ts`: it imports from express and registers a path on anything. */
const ROUTE_FILES = sourceFiles(SRC).filter((f) => {
  const text = fs.readFileSync(f, 'utf8');
  return /from 'express'/.test(text) && /\.(get|post|put|patch|delete)\(\s*['`/\w]/.test(text);
});
const ALL = ROUTE_FILES.flatMap((f) => writes(f, fs.readFileSync(f, 'utf8')));
const key = (w: Write): string => `${w.method} ${w.route}`;

describe('write routes and their gates (#1052)', () => {
  it('finds the fleet, reporter and admin route files it guards', () => {
    const names = ROUTE_FILES.map(rel);
    for (const f of ['fleet/routes.ts', 'fleet/respondRoutes.ts', 'fleet/peerRoutes.ts', 'fleet/recordingRoutes.ts', 'fleet/chatDmRoutes.ts', 'admin/adminRouter.ts', 'tlsReporterRenew.ts']) expect(names).toContain(f);
    expect(ALL.length).toBeGreaterThan(50);
  });

  it('puts every write route behind a gate or on the written list', () => {
    const open = ALL.filter((w) => w.gate === null && !(key(w) in ALLOWED_WITHOUT_GATE)).map((w) => `${rel(w.file)}:${w.line} ${key(w)}`);
    expect(open, 'a write route with no gate and no entry in ALLOWED_WITHOUT_GATE (with its reason)').toEqual([]);
  });

  it('lists the four fleet routes that take no token, each with a reason', () => {
    for (const k of ['POST /sessions/:id/drop', 'POST /notices/:id/close', 'POST /update-notice/close', 'PUT /wall/background-sessions']) {
      expect(ALLOWED_WITHOUT_GATE[k]).toBeTruthy();
      expect(ALL.some((w) => key(w) === k && w.gate === null && rel(w.file) === 'fleet/routes.ts')).toBe(true);
    }
  });

  it('keeps the list honest: every entry names a route that still has no gate, and has a reason', () => {
    const stale: string[] = [];
    for (const [k, reason] of Object.entries(ALLOWED_WITHOUT_GATE)) {
      if (reason.trim().length < 20) stale.push(`${k}: no reason`);
      if (!ALL.some((w) => key(w) === k && w.gate === null)) stale.push(`${k}: no such ungated route, remove the entry`);
    }
    expect(stale).toEqual([]);
  });

  it('does not list a route that has a gate, and a token route is never on the list', () => {
    expect(ALL.filter((w) => w.gate === 'token').length).toBeGreaterThanOrEqual(10);
    expect(ALL.some((w) => key(w) === 'DELETE /sessions/:id' && w.gate === 'token')).toBe(true);
    expect(ALL.some((w) => key(w) === 'POST /report' && w.gate === 'token')).toBe(true);
  });

  describe('the scan itself', () => {
    const fleetFile = 'fleet/routes.ts';
    it('fails a new write route with no token', () => {
      const w = writes(fleetFile, `router.post('/sessions/:id/kill', json, asyncHandler(async (req, res) => { res.json({ ok: true }); }));`);
      expect(w).toHaveLength(1);
      expect(w[0]!.gate).toBeNull();
      expect(key(w[0]!) in ALLOWED_WITHOUT_GATE).toBe(false);
    });
    it('passes a write route behind requireToken, whichever way it is named', () => {
      expect(writes(fleetFile, `router.put('/a', requireToken, json, h);`)[0]!.gate).toBe('token');
      expect(writes(fleetFile, `router.delete('/a', d.requireToken, h);`)[0]!.gate).toBe('token');
    });
    it('does not count a read, and a requireToken that is only in the handler body is no gate', () => {
      expect(writes(fleetFile, `router.get('/a', h);`)).toEqual([]);
      expect(writes(fleetFile, `router.post('/a', asyncHandler(async () => { requireToken; }));`)[0]!.gate).toBeNull();
    });
    it('treats an admin route before the unlock gate as open and one after it as gated', () => {
      const text = `
        router.post('/unlock', h);
        router.use(asyncHandler(async (req, res, next) => { if (await sessionValid(req)) return next(); res.status(401).json({ ok: false, error: 'locked' }); }));
        router.post('/people', h);`;
      const w = writes('admin/adminRouter.ts', text);
      expect(w.map((x) => x.gate)).toEqual([null, 'admin']);
    });
    it('passes a browser route that asks for the viewer, and fails one that does not', () => {
      expect(writes('fleet/chatDmRoutes.ts', `browser.post('/a', asyncHandler(async (req, res) => { const v = await d.viewer(req, res); }));`)[0]!.gate).toBe('viewer');
      expect(writes('fleet/chatDmRoutes.ts', `browser.post('/a', asyncHandler(async (req, res) => { res.json({}); }));`)[0]!.gate).toBeNull();
    });
  });
});
