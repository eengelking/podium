// What a reporter's mod answers when the console asks for a changed file's diff (SPEC 6.4). The server holds the browser's request
// until a report's reply lists it and the mod PUTs the answer, so the suite plays the mod: `startDiffMod` reports the seeded session
// every 200 ms (the reply lists waiting requests) and answers each from this table. Nothing here is a real diff of a real file.
const text = (...lines) => lines.join('\n');
const ok = (path, body, over = {}) => {
  const n = body.split('\n').length;
  return { path, status: 'ok', text: body, truncated: false, shownLines: n, totalLines: n, redactions: 0, base: 'abc1234', ...over };
};
const none = (path, status) => ({ path, status, text: null, truncated: false, shownLines: 0, totalLines: 0, redactions: 0, base: 'abc1234' });
const LONG = 'packages/billing-service/src/deeply/nested/directory/structure/with/many/levels/invoice-line-item-serializer.ts';

const DIFFS = {
  'src/invoice/export.ts': ok('src/invoice/export.ts', text('@@ -1,4 +1,5 @@', ' import { total } from "./totals";', '-export const rows = (list) => list.map(row);', '+export const rows = (list) => list.map(rowV2);', '+export const header = "invoice-v2";', ' export default total;'), { redactions: 1 }),
  // A diff the reporter cut: three lines of 900 were sent.
  'src/invoice/export.test.ts': ok('src/invoice/export.test.ts', text('@@ -0,0 +1,3 @@', '+import { rows } from "./export";', '+test("rows", () => expect(rows([])).toEqual([]));', '+test("header", () => expect(1).toBe(1));'), { truncated: true, shownLines: 3, totalLines: 900 }),
  'src/invoice/legacy.ts': ok('src/invoice/legacy.ts', text('@@ -1,3 +0,0 @@', '-export const legacy = true;', '-export const old = 1;', '-export default legacy;')),
  'src/invoice/totals.ts': ok('src/invoice/totals.ts', text('@@ -1,2 +1,2 @@', '-export const sum = (a, b) => a + b;', '+export const total = (a, b) => a + b;', ' export default total;')),
  'assets/logo.png': none('assets/logo.png', 'binary'),
  [LONG]: ok(LONG, text('@@ -1 +1 @@', '-export const a = 1;', '+export const a = 2;')),
  'data/fixtures/huge.json': none('data/fixtures/huge.json', 'too-large'),
  'config/secrets.env': none('config/secrets.env', 'withheld'),
};

/** Starts answering diff requests for the invoice session. Returns a function that stops it. */
/** `over` is merged into the session of each report, so a spec can play a reporter whose options differ (fileDiffPreload: false). */
function startDiffMod(origin, token, seed, over = {}) {
  const c = seed.client(origin);
  const base = seed.fleetReports({}).find((r) => r.key === 'invoice');
  const id = seed.SESSIONS.invoice;
  let stopped = false;
  let busy = false;
  const timer = setInterval(async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const res = await c.mod(token, 'POST', '/report', { ...base.body, sentAt: Date.now(), session: { ...base.body.session, ...over } });
      for (const d of res.body?.diffs ?? []) {
        await c.mod(token, 'PUT', `/sessions/${id}/diffs/${d.id}`, DIFFS[d.path] ?? none(d.path, 'unavailable'));
      }
    } catch {
      // The server may be restarting; the next tick tries again.
    } finally {
      busy = false;
    }
  }, 200);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = { startDiffMod, DIFFS };
