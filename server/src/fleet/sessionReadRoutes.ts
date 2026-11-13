// Browser routes for the notice a person gets when an Admin reads the content of their session (#1073 an ask, #1074 stored Activity; PROJECT.md "An Admin
// Never Reads in Silence"). They live on responding's /respond router, so they share its sign-in, its cross-site check and its no-store header.
// What an Admin reads is recorded by the route that serves it, through `AdminReads.noteSession` before anything is sent; these three routes only tell the
// person. Nothing here carries any text: a name, a time and a kind.
import { Router, type Request, type Response } from 'express';
import { jsonBody } from '../jsonBody.js';
import type { Fleet } from './fleet.js';
import type { BrowserHelpers, PeerDeps } from './peerRoutes.js';
import { ADMIN_OWNER, nameKey, sourceAddress } from '../storage/rows.js';
import { LOOP_ID, isSessionReadKind, readNeedsLoop } from './sessionReads.js';
import { MAIN_LOOP } from './protocol.js';
import { asyncHandler } from './asyncHandler.js';

const sourceOf = (req: Request): string => sourceAddress(req.ip);

export function mountSessionReadRoutes(browser: Router, d: PeerDeps, h: BrowserHelpers): void {
  const { fleet, logger } = d;
  const reads = (): Fleet['chat']['adminReads'] => fleet.chat.adminReads;
  const json = jsonBody({ limit: '1kb' });

  const refuse = (req: Request, res: Response, status: number, reason: string) => {
    logger.warn('session_reads.refused', `podium: refused ${req.method} ${req.baseUrl}${req.path} from ${sourceOf(req)}: ${reason}`, { status, reason, source: sourceOf(req), session_id: typeof req.params.id === 'string' ? req.params.id : null });
    res.status(status).json({ ok: false, error: reason });
  };

  // The Admins reading the signed-in person's own sessions now, by kind and session. The console reads it when the stream's `reads` counter moves. An Admin gets
  // only their own sessions' readers, like anyone: this names no one else's.
  browser.get('/session-reads', asyncHandler(async (req, res) => {
    if (d.token === null) return void res.status(404).json({ ok: false, error: 'authentication is off' });
    const v = await h.viewerOf(req);
    if (!v) return void refuse(req, res, 401, 'sign in to see who is reading your sessions');
    res.json({ ok: true, serverTime: fleet.now(), readers: await reads().sessionReadersOf(v.name) });
  }));

  // The person's own look at the record of reads of one of their sessions: who read, when, and who reads now. Loading it is the person seeing it.
  browser.get('/sessions/:id/admin-reads/:kind', asyncHandler(async (req, res) => {
    if (d.token === null) return void res.status(404).json({ ok: false, error: 'authentication is off' });
    const v = await h.viewerOf(req);
    if (!v) return void refuse(req, res, 401, 'sign in to see who read your session');
    const kind = req.params.kind;
    if (!isSessionReadKind(kind)) return void refuse(req, res, 400, 'unknown kind of read');
    const row = await fleet.db.getSession(req.params.id as string);
    if (!row) return void res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
    const own = row.owner !== null && row.owner !== ADMIN_OWNER && nameKey(row.owner) === nameKey(v.name);
    if (!own) return void refuse(req, res, 403, 'only the session\'s owner sees who read it');
    const got = await reads().sessionRecordsOf(kind, row.id, v.name);
    res.json({ ok: true, serverTime: fleet.now(), adminReads: got.records, adminReading: got.reading });
  }));

  // An Admin's open read pings this every 15 seconds so the session's owner keeps seeing that it is being read. Records first, like the read itself, and only a loop the session has (`404` otherwise, nothing recorded). Only a read that begins wakes the consoles: a ping adds nothing a console cannot work out from the end it holds. A person's
  // own read, and a session nobody owns, tell no one. The body may carry `loop` for a kind that is read per loop.
  browser.post('/sessions/:id/admin-reads/:kind/reading', json, asyncHandler(async (req, res) => {
    if (d.token === null) return void res.status(404).json({ ok: false, error: 'authentication is off' });
    const v = await h.viewerOf(req);
    if (!v) return void refuse(req, res, 401, 'sign in first');
    if (!v.admin) return void refuse(req, res, 403, 'only an Admin reads a session that is not their own');
    const kind = req.params.kind;
    if (!isSessionReadKind(kind)) return void refuse(req, res, 400, 'unknown kind of read');
    const loop = (req.body as { loop?: unknown } | undefined)?.loop;
    if (readNeedsLoop(kind) ? typeof loop !== 'string' || !LOOP_ID.test(loop) : loop !== undefined) return void refuse(req, res, 400, readNeedsLoop(kind) ? 'loop must be one loop id' : 'this kind of read has no loop');
    const row = await fleet.db.getSession(req.params.id as string);
    if (!row) return void res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
    if (readNeedsLoop(kind) && !(loop === MAIN_LOOP && kind !== 'text') && !(await fleet.db.getAgents(row.id)).some((a) => a.id === loop)) return void res.status(404).json({ ok: false, error: 'unknown loop', path: '$.loop' });
    const got = await reads().noteSession(v, kind, row, loop as string | undefined);
    if (got.changed) fleet.sessionReadsChanged();
    res.json({ ok: true });
  }));
}
