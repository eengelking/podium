// Routes for session recording (#353, SPEC 7.1 "Mod route for session recording" and "Browser routes for session recording").
//
// The mod's route takes X-Podium-Token and needs the credential to own the session, like a report. The browser's routes live on
// responding's /respond router, so they share its sign-in, its cross-site check and its no-store header. Every browser route needs
// the signed-in person to be the session's owner or an Admin. A recording's text goes to the one reader and nowhere else: it is
// never logged, and the Admin log carries only who did what to which session, with counts.
import express, { Router, type Request, type Response } from 'express';
import type { Fleet } from './fleet.js';
import type { BrowserHelpers, PeerDeps } from './peerRoutes.js';
import { credentialOwns, viewerOwns } from './respondRoutes.js';
import { sourceAddress, type PeopleStore } from './people.js';
import { sizeText } from './sizeText.js';
import { MAIN_LOOP, RECORDING_LIMITS, validateRecordingBatch, validateRecordingStart, type RecordingPage } from './protocol.js';
import type { SessionRow } from './db.js';
import type { RecordingTrail } from './recordings.js';
import type { Logger } from '../logging/logger.js';

/** The mod's batch is at most 480,000 bytes of JSON; the router's body limit is the report's. */
const BATCH_BODY_LIMIT = '512kb';

const sourceOf = (req: Request): string => sourceAddress(req.ip);

/** Authentication on and the Admin's flag (#353). The reporter's `sessionRecording` option is checked per session. */
export const recordingEnabled = (fleet: Fleet, token: string | null): boolean => token !== null && fleet.recordings.enabled();

const id8 = (id: string): string => id.slice(0, 8);

/** The Admin log row and the server log line for one recording event, never any text of the recording. */
export function logRecording(people: PeopleStore | null, logger: Logger, now: number, kind: string, detail: string, source: string, actor: string | null, fields: Record<string, string | number | boolean | null>): void {
  people?.log(kind, detail, source, now, actor);
  logger.info(`recording.${kind.replace(/^recording_/, '')}`, `podium: ${detail}`, { ...fields, source });
}

/** Writes what the server did to a recording on its own (a limit, the flag going off, a /clear) to the Admin log and the server log. */
export function wireRecordingLogs(fleet: Fleet, people: PeopleStore | null, logger: Logger): void {
  fleet.recordings.trail = (t: RecordingTrail) => {
    const name = fleet.db.getSession(t.sessionId)?.name ?? 'a session';
    const where = `${name} (${id8(t.sessionId)})`;
    const now = fleet.now();
    if (t.kind === 'limit') {
      const why = t.which === 'budget' ? 'the disk budget was reached' : `the session reached its limit (${sizeText(t.bytes)})`;
      logRecording(people, logger, now, 'recording_limit', `Recording of ${where} stopped: ${why}`, 'server', null, { session_id: t.sessionId, limit: t.which, bytes: t.bytes });
    } else if (t.kind === 'stopped') {
      logRecording(people, logger, now, 'recording_stopped', `Recording of ${where} stopped: the Admin turned session recording off`, 'server', null, { session_id: t.sessionId, by: t.by });
    } else {
      logRecording(people, logger, now, 'recording_started', `Recording of ${where} continues after /clear from ${id8(t.from)}`, 'server', t.by, { session_id: t.sessionId, from_session: t.from });
    }
    fleet.recordingChanged(t.sessionId);
  };
}

/** What a session's recording starts from: its name, project and owner in the main database. */
const metaOf = (fleet: Fleet, row: SessionRow) => fleet.historyMeta(row.id) ?? { name: row.name, project: null, owner: row.owner };

/** The mod's route (SPEC 7.1). */
export function mountRecordingRoutes(router: Router, d: PeerDeps): void {
  const { fleet, logger } = d;
  const json = express.json({ limit: BATCH_BODY_LIMIT });

  router.post('/sessions/:id/recording', d.requireToken, json, (req, res) => {
    const v = validateRecordingBatch(req.body);
    if (!v.ok) {
      res.status(400).json({ ok: false, error: v.error, path: v.path });
      return;
    }
    const refuse = (status: number, error: string, path?: string) => {
      logger.debug('recording.refused', `podium: refused a recording batch for session ${req.params.id}: ${error}`, { status, session_id: req.params.id ?? null, source: sourceOf(req) });
      res.status(status).json({ ok: false, error, ...(path ? { path } : {}) });
    };
    const off = () => refuse(403, 'recording is off');
    if (!recordingEnabled(fleet, d.token)) return off();
    const row = fleet.db.getSession(req.params.id!);
    if (!row) return refuse(404, 'unknown session', '$.id');
    if (!credentialOwns(d.identityOf(res), row)) return refuse(409, 'that session belongs to someone else', '$.session.id');
    // A session that has ended is not accepted again: its recording is kept as it is.
    if (!fleet.isLive(row.id)) return fleet.recordings.has(row.id) ? refuse(409, 'the session has ended', '$.id') : refuse(404, 'unknown session', '$.id');
    // A recording a person stopped still takes the entries captured before the stop (the mod's last interval); ingest drops later ones.
    if (fleet.recordings.acceptsUntil(row.id) === null) return off();
    const before = fleet.recordings.grant(row.id).state;
    const stored = fleet.recordings.ingest(row.id, v.batch, metaOf(fleet, row));
    const recording = fleet.recordings.grant(row.id);
    if (recording.state !== before) fleet.recordingChanged(row.id);
    logger.debug('recording.batch', `podium: stored ${stored} of ${v.batch.entries.length} recorded entries of session ${row.id}`, { session_id: row.id, stored, received: v.batch.entries.length, state: recording.state });
    res.json({ ok: true, stored, recording });
  });
}

/** The browser's routes (SPEC 7.1), mounted on responding's /respond router. */
export function mountRecordingBrowserRoutes(browser: Router, d: PeerDeps, h: BrowserHelpers): void {
  const { fleet, logger, people } = d;
  const now = fleet.now;

  const refuse = (req: Request, res: Response, status: number, reason: string, extra: Record<string, unknown> = {}) => {
    logger.warn('recording.refused', `podium: refused ${req.method} ${req.baseUrl}${req.path} from ${sourceOf(req)}: ${reason}`, { status, reason, source: sourceOf(req), session_id: req.params.id ?? null });
    res.status(status).json({ ok: false, error: reason, ...extra });
  };

  /** The signed-in viewer and the session they may use (its owner, or an Admin); otherwise answers and returns null. */
  const access = (req: Request, res: Response) => {
    if (!recordingEnabled(fleet, d.token)) {
      res.status(404).json({ ok: false, error: 'session recording is off' });
      return null;
    }
    const v = h.viewerOf(req);
    if (!v) {
      refuse(req, res, 401, 'sign in to open the recording');
      return null;
    }
    const row = fleet.db.getSession(req.params.id!);
    if (!row) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return null;
    }
    if (!viewerOwns(v, row)) {
      refuse(req, res, 403, 'not your session', { owner: row.owner });
      return null;
    }
    return { v, row };
  };

  const audit = (req: Request, v: { actor: string }, row: SessionRow, kind: string, detail: string, fields: Record<string, string | number | boolean | null> = {}) =>
    logRecording(people, logger, now(), kind, `${detail} in ${row.name} (${id8(row.id)})`, sourceOf(req), v.actor, { session_id: row.id, ...fields });

  browser.get('/sessions/:id/recording', (req, res) => {
    const got = access(req, res);
    if (!got) return;
    const bad = (error: string, path: string) => void res.status(400).json({ ok: false, error, path });
    const num = (raw: unknown, min: number): number | null | 'bad' => {
      if (raw === undefined || raw === '') return null;
      return typeof raw === 'string' && /^\d{1,15}$/.test(raw) && Number(raw) >= min ? Number(raw) : 'bad';
    };
    const before = num(req.query.before, 0);
    if (before === 'bad') return bad('before must be a whole number', '$.query.before');
    const limit = num(req.query.limit, 1);
    if (limit === 'bad') return bad('limit must be a whole number of 1 or more', '$.query.limit');
    const loop = req.query.loop === undefined || req.query.loop === '' ? null : req.query.loop;
    const loops = fleet.recordings.loopInfo(got.row.id);
    if (loop !== null && (typeof loop !== 'string' || !loops.some((l) => l.loop === loop))) return bad('the session has no such loop', '$.query.loop');
    if (!fleet.recordings.has(got.row.id)) {
      res.status(404).json({ ok: false, error: 'this session has no recording' });
      return;
    }
    const page = fleet.recordings.page(got.row.id, before, Math.min(limit ?? RECORDING_LIMITS.page, RECORDING_LIMITS.page), loop);
    // Opening a replay is a read of everything the session did: the Admin log hears of it, the owner's own included. Paging back is not another read.
    if (before === null) audit(req, got.v, got.row, 'recording_read', `${got.v.name} opened the replay${loop ? ` of ${loop === MAIN_LOOP ? 'the orchestrator' : 'one agent'}` : ''}`, { entries: page.entries.length });
    const body: RecordingPage = { ...page, grant: fleet.recordings.grant(got.row.id), loops, owner: got.row.owner };
    res.json(body);
  });

  // The consent as it stands before anything is chosen, so the picker can say whether the owner allows recording (SPEC 7.1). It
  // carries no text, and a recording need not exist.
  browser.get('/sessions/:id/recording/consent', (req, res) => {
    const got = access(req, res);
    if (!got) return;
    res.json({ ok: true, grant: fleet.recordings.grant(got.row.id) });
  });

  browser.put('/sessions/:id/recording', (req, res) => {
    const got = access(req, res);
    if (!got) return;
    const v = validateRecordingStart(req.body);
    if (!v.ok) {
      res.status(400).json({ ok: false, error: v.error, path: v.path });
      return;
    }
    // PROVISIONAL (#353): capture needs a running session, so a session that has ended cannot be started.
    if (!fleet.isLive(got.row.id)) {
      res.status(409).json({ ok: false, error: 'the session is not running' });
      return;
    }
    const known = new Set(fleet.recordings.loopInfo(got.row.id).map((l) => l.loop));
    if (v.request.loops.some((l) => !known.has(l))) {
      res.status(400).json({ ok: false, error: 'the session has no such loop', path: '$.loops' });
      return;
    }
    const out = fleet.recordings.start(got.row.id, v.request.loops, got.v.name, metaOf(fleet, got.row));
    if (out !== 'ok') {
      const why = { limit: 'the recording stopped for its limit; delete it to start again', budget: "the disk budget is reached", busy: 'the last recording of this session is still being deleted' }[out];
      res.status(409).json({ ok: false, error: why });
      return;
    }
    audit(req, got.v, got.row, 'recording_started', `${got.v.name} chose to record ${v.request.loops.length === 1 ? '1 loop' : `${v.request.loops.length} loops`}`, { loops: v.request.loops.length, by: got.v.name });
    fleet.recordingChanged(got.row.id);
    res.json({ ok: true, grant: fleet.recordings.grant(got.row.id) });
  });

  browser.post('/sessions/:id/recording/stop', (req, res) => {
    const got = access(req, res);
    if (!got) return;
    const out = fleet.recordings.stop(got.row.id, got.v.name);
    if (!out) {
      res.status(404).json({ ok: false, error: 'this session has no recording' });
      return;
    }
    if (out.changed) {
      audit(req, got.v, got.row, 'recording_stopped', `${got.v.name} stopped the recording`, { by: got.v.name });
      fleet.recordingChanged(got.row.id);
    }
    res.json({ ok: true, grant: out.grant });
  });

  browser.delete('/sessions/:id/recording', (req, res) => {
    const got = access(req, res);
    if (!got) return;
    if (!fleet.recordings.has(got.row.id)) {
      res.status(404).json({ ok: false, error: 'this session has no recording' });
      return;
    }
    fleet.recordings.removeMany([got.row.id]).then(
      (out) => {
        audit(req, got.v, got.row, 'recording_deleted', `${got.v.name} deleted the recording (${out.entries} entries, ${sizeText(out.bytes)})`, { entries: out.entries, bytes: out.bytes });
        fleet.recordingChanged(got.row.id);
        res.json({ ok: true, entries: out.entries, bytes: out.bytes });
      },
      () => void res.status(500).json({ ok: false, error: 'could not delete the recording' }),
    );
  });
}
