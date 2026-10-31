// Routes for responding to a waiting session from Podium (#206, SPEC 7.1, 7.7), mounted on the fleet router.
//
// Two sides. The mod's routes (announce an ask, wait for an answer, say an ask closed, say what became of a delivery)
// take X-Podium-Token, checked as for a report, and the credential must own the session. The browser's routes live
// under /respond and need a sign-in: a name and a token, the same pair as the reporter's userName and token options,
// or Admin with the admin secret. A sign-in is a random id in an HttpOnly, SameSite=Strict cookie scoped to
// /api (so Admin, #215, sees it too), held in memory only. Every change needs X-Podium-Respond: 1 and, when an Origin is sent, this
// server's own host; no CORS is offered. Nothing here logs or stores the text of an answer, a question or a plan.
import { randomBytes } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { jsonBody } from '../jsonBody.js';
import type { Fleet } from './fleet.js';
import type { Identity } from './routes.js';
import { ADMIN_OWNER, ADMIN_SECRET_ACTOR, nameKey, sourceAddress, FILE_DIFF, type SessionRow } from '../storage/rows.js';
import type { PeopleStoreApi } from '../storage/types.js';
import { checkNameToken } from './nameToken.js';
import type { RespondBridge } from './respondBridge.js';
import type { Lockout } from './lockout.js';
import { logWords, shortDeliveryId, type AnswerError, type DeliveryTrail, type DropWhy } from './respond.js';
import { DELIVERY_RESULTS, FILE_DIFF_LIMITS, LIMITS, MAIN_LOOP, RESPOND_LIMITS, validateAsk, validateFileDiffReply, type AskCloseOutcome, type Delivery, type DeliveryResult, type DiffRequest, type RespondMe } from './protocol.js';
import type { Logger } from '../logging/logger.js';
import type { BrowserHelpers } from './peerRoutes.js';
import { ACTIVITY_HISTORY_PAGE, ACTIVITY_HISTORY_PAGE_MAX, type ActivityHistoryPage } from './activityHistoryTypes.js';
import { parseRead } from './activityHistoryInput.js';
import { asyncHandler } from './asyncHandler.js';

export interface RespondDeps {
  fleet: Fleet;
  /** The admin secret; null when authentication is off, and responding with it. */
  token: string | null;
  people: PeopleStoreApi | null;
  logger: Logger;
  lockout: Lockout;
  requireToken: RequestHandler;
  identityOf: (res: Response) => Identity;
  /** Idle time before a sign-in ends. */
  signInIdleMs?: number;
  /** Filled in so Admin can open for a browser already signed in here as an Administrator (#215). */
  bridge?: RespondBridge;
  /** Runs ahead of the sign-in, to note a plain-HTTP connection (#306). It never blocks. */
  onSignIn?: RequestHandler;
  /** Another feature that needs the sign-in is on (orchestrator messaging, #347), so a browser can sign in for it. */
  alsoSignIn?: () => boolean;
  /** Mounts more routes on the browser router, behind its no-store, cross-site and body-size checks (#347). */
  extendBrowser?: (browser: Router, h: BrowserHelpers) => void;
}

const COOKIE = 'podium_respond';
const COOKIE_PATH = '/api';
const LEGACY_COOKIE_PATH = '/api/fleet/respond';
export const SIGN_IN_IDLE_MS = 12 * 3600_000;
const MAX_SIGN_INS = 200;
const BODY_LIMIT = '64kb';
const CLOSE_OUTCOMES: readonly AskCloseOutcome[] = ['terminal', 'closed', 'ended'];

/** A browser's sign-in: the person (null for the admin secret) and their token's hash when it began, so a rotation ends it. */
interface SignIn {
  personId: number | null;
  tokenHash: string | null;
  last: number;
  /** Set by an explicit Lock Admin: this sign-in no longer opens Admin by itself (#272). A new sign-in starts without it. */
  adminHeld?: boolean;
}

/** Who a signed-in browser is, worked out afresh on each request. */
interface Viewer {
  /** As deliveries and the feed name the sender: a person's name, or `Admin`. */
  name: string;
  /** As the admin log names the actor: a person's name, or `Admin secret`. */
  actor: string;
  admin: boolean;
  /** The person signed in, or null for the admin secret. */
  personId: number | null;
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const sourceOf = (req: Request): string => sourceAddress(req.ip);

/** Whether a mod's credential owns the session: a person's token their own sessions, the admin secret those owned by Admin. */
export function credentialOwns(id: Identity, row: SessionRow): boolean {
  if (row.owner === null) return false;
  if (id.kind === 'person') return nameKey(id.person.name) === nameKey(row.owner);
  return id.kind === 'admin' && row.owner === ADMIN_OWNER;
}

/** Whether a signed-in viewer may respond to a session: its owner, or an Admin. A session owned by Admin needs an Admin. */
export function viewerOwns(v: { name: string; admin: boolean }, row: SessionRow): boolean {
  if (v.admin) return true;
  return row.owner !== null && row.owner !== ADMIN_OWNER && nameKey(row.owner) === nameKey(v.name);
}

function answerError(res: Response, err: AnswerError): void {
  const { status, ...body } = err;
  res.status(status).json({ ok: false, ...body });
}

/** What the fleet router asks of the sign-in once the respond routes are mounted. */
export interface RespondAccess {
  /**
   * Reads the request's sign-in once and returns whether it is the sign-in of a given session's owner or an Admin. It never
   * refuses or throws, so a route that has no sign-in of its own can ask without changing who it answers.
   */
  reader: (req: Request) => Promise<(row: SessionRow) => boolean>;
}

export function mountRespondRoutes(router: Router, d: RespondDeps): RespondAccess {
  const { fleet, people, logger, lockout } = d;
  const now = fleet.now;
  const idleMs = d.signInIdleMs ?? SIGN_IN_IDLE_MS;
  const signIns = new Map<string, SignIn>();
  const json = jsonBody({ limit: BODY_LIMIT });

  /** Authentication on, and both of the Admin's flags. The reporter's own switches are the mod's to check. */
  const enabled = (): boolean => d.token !== null && fleet.respondFlagsOn();

  /** Authentication on and the Admin's file-diff flag (#319). The reporter's fileDiff option is the mod's to check. */
  const diffEnabled = (): boolean => d.token !== null && fleet.features.featureOn(FILE_DIFF);
  /** A browser can sign in when any feature that needs the sign-in is on. The respond routes still need `enabled()`. */
  /** Authentication on and a keep policy for the Activity history (#432): stored entries are read by a signed-in owner or Admin. */
  const historyEnabled = (): boolean => d.token !== null && fleet.activityHistorySettings.get().policy !== 'default';
  const signInEnabled = (): boolean => enabled() || diffEnabled() || historyEnabled() || (d.alsoSignIn?.() ?? false);

  const refuse = (req: Request, res: Response, status: number, reason: string, extra: Record<string, unknown> = {}) => {
    logger.warn('respond.refused', `podium: refused ${req.method} ${req.baseUrl}${req.path} from ${sourceOf(req)}: ${reason}`, { status, reason, source: sourceOf(req), session_id: req.params.id ?? null });
    res.status(status).json({ ok: false, error: reason, ...extra });
  };

  // ---- what became of a delivery (#304) ----------------------------------------------------------

  /** The address of the request that is changing a delivery's fate, for the admin log; 'server' when none is (a report's implicit close). */
  let trailSource = 'server';
  const withSource = <T>(src: string, fn: () => T): T => {
    trailSource = src;
    try {
      return fn();
    } finally {
      trailSource = 'server';
    }
  };
  const actorOf = (name: string): string => (name === ADMIN_OWNER ? ADMIN_SECRET_ACTOR : name);
  const RESULT_WORDS: Record<DeliveryResult, string> = {
    took: 'the session took it',
    queued: 'the session queued it',
    'not-taken': 'the session did not take it',
    refused: 'the session refused it',
    closed: 'it had closed before the session got it',
  };
  const DROP_WORDS: Record<DropWhy, string> = {
    discarded: 'discarded by its sender, so it never reached the session',
    'ask-closed': 'the ask closed first, so it never reached the session',
    'session-ended': 'the session ended first, before any result came back',
    'queued-session-ended': 'the session ended while it was still queued, so Podium cannot tell whether it was read',
    'session-deleted': 'the session was deleted first, before any result came back',
    'responding-off': 'responding was turned off first, before any result came back',
  };
  fleet.respond.trail = (t: DeliveryTrail) => {
    // The store calls this mid-change and cannot wait for a read; a failing log write must not leave a delivery half-updated.
    // The line is written when the session's name arrives.
    writeTrail(t).catch((err: unknown) => {
      logger.warn('respond.trail_failed', `podium: could not log what became of a delivery in session ${t.sessionId}`, { session_id: t.sessionId, error: String(err) });
    });
  };
  const writeTrail = async (t: DeliveryTrail) => {
    const at = now();
    const row = await fleet.db.getSession(t.sessionId);
    const where = `${logWords(t.delivery)} in ${row?.name ?? 'a session'} (${t.sessionId.slice(0, 8)}) [${shortDeliveryId(t.delivery)}]`;
    if (t.kind === 'result') {
      await people?.log('respond_result', `${where}: ${RESULT_WORDS[t.result]}`, trailSource, at, actorOf(t.delivery.by));
      logger.info('respond.result', `podium: ${logWords(t.delivery).toLowerCase()} in session ${t.sessionId} came back ${t.result}`, { session_id: t.sessionId, kind: t.delivery.kind, result: t.result });
    } else {
      await people?.log('respond_dropped', `${where}: ${DROP_WORDS[t.why]}`, trailSource, at, actorOf(t.by));
      logger.info('respond.dropped', `podium: ${logWords(t.delivery).toLowerCase()} in session ${t.sessionId} was dropped (${t.why})`, { session_id: t.sessionId, kind: t.delivery.kind, why: t.why });
    }
  };

  // ---- the mod's side ---------------------------------------------------------------------------

  /**
   * The session a mod route is about, when responding is on and the credential owns it; otherwise answers and returns null. `row` is
   * the session as the handler just read it. This is synchronous so the checks and what the handler does next run in one turn,
   * with nothing able to end or delete the session in between.
   */
  const modSession = (req: Request, res: Response, row: SessionRow | undefined, on: () => boolean = enabled, off = 'responding is off'): SessionRow | null => {
    if (!on()) {
      refuse(req, res, 403, off);
      return null;
    }
    if (!row || !fleet.isLive(row.id)) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return null;
    }
    if (!credentialOwns(d.identityOf(res), row)) {
      refuse(req, res, 403, 'not your session');
      return null;
    }
    return row;
  };

  /** The mod's answer to a request for a file's diff (#319). The text goes to the one waiting browser request and nowhere else. */
  router.put('/sessions/:id/diffs/:requestId', d.requireToken, jsonBody({ limit: '1mb' }), asyncHandler(async (req, res) => {
    const row = modSession(req, res, await fleet.db.getSession(req.params.id!), diffEnabled, 'file diff is off');
    if (!row) return;
    const sent = (req.body as { text?: unknown } | undefined)?.text;
    if (typeof sent === 'string' && Buffer.byteLength(sent) > FILE_DIFF_LIMITS.answerBytes) {
      res.status(413).json({ ok: false, error: `at most ${FILE_DIFF_LIMITS.answerBytes} bytes of diff are taken`, path: '$.text' });
      return;
    }
    const v = validateFileDiffReply(req.body);
    if (!v.ok) {
      res.status(400).json({ ok: false, error: v.error, path: v.path });
      return;
    }
    fleet.diffs.answer(row.id, req.params.requestId!, v.reply);
    res.json({ ok: true });
  }));

  router.put('/sessions/:id/asks/:askId', d.requireToken, jsonBody({ limit: '512kb' }), asyncHandler(async (req, res) => {
    const row = modSession(req, res, await fleet.db.getSession(req.params.id!));
    if (!row) return;
    const v = validateAsk(req.body);
    if (!v.ok) {
      res.status(400).json({ ok: false, error: v.error, path: v.path });
      return;
    }
    if (v.ask.id !== req.params.askId) {
      res.status(400).json({ ok: false, error: 'the ask id must match the path', path: '$.id' });
      return;
    }
    const out = fleet.respond.announce(row.id, v.ask);
    if (out === 'closed') res.status(409).json({ ok: false, error: 'closed' });
    else if (out === 'full') res.status(429).json({ ok: false, error: `at most ${RESPOND_LIMITS.asks} open asks per session` });
    else res.json({ ok: true });
  }));

  router.get('/sessions/:id/asks/:askId/answer', d.requireToken, asyncHandler(async (req, res) => {
    const row = modSession(req, res, await fleet.db.getSession(req.params.id!));
    if (!row) return;
    const raw = typeof req.query.wait === 'string' && /^\d{1,3}$/.test(req.query.wait) ? Number(req.query.wait) : RESPOND_LIMITS.holdSeconds;
    const wait = Math.max(1, Math.min(RESPOND_LIMITS.holdSeconds, raw));
    res.set('Cache-Control', 'no-store');
    // A mod that gives up (Esc aborts a hook's fetches) must not be handed an answer it never reads.
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    const out = await fleet.respond.hold(row.id, req.params.askId!, wait * 1000, gone.signal);
    if (res.writableEnded || res.destroyed) return;
    if (out.kind === 'delivery') res.json({ delivery: out.delivery });
    else if (out.kind === 'none') res.status(204).end();
    else if (out.kind === 'unknown') res.status(404).json({ ok: false, error: 'unknown ask' });
    else res.status(410).json({ ok: false, error: 'closed', outcome: out.outcome });
  }));

  router.post('/sessions/:id/asks/:askId/close', d.requireToken, json, asyncHandler(async (req, res) => {
    const row = modSession(req, res, await fleet.db.getSession(req.params.id!));
    if (!row) return;
    const b = req.body as Record<string, unknown> | undefined;
    const outcome = b?.outcome;
    if (typeof outcome !== 'string' || !(CLOSE_OUTCOMES as readonly string[]).includes(outcome)) {
      res.status(400).json({ ok: false, error: 'expected outcome terminal, closed or ended', path: '$.outcome' });
      return;
    }
    const answer = typeof b?.answer === 'string' ? b.answer.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, RESPOND_LIMITS.answer) : null;
    const at = typeof b?.at === 'number' && Number.isFinite(b.at) ? b.at : now();
    withSource(sourceOf(req), () => fleet.respond.close(row.id, req.params.askId!, { outcome: outcome as AskCloseOutcome, at, answer, planApproved: b?.planApproved === true }));
    logger.debug('respond.closed', `podium: an ask in session ${row.id} closed (${outcome})`, { session_id: row.id, outcome });
    res.json({ ok: true });
  }));

  router.post('/sessions/:id/deliveries/:deliveryId/result', d.requireToken, json, asyncHandler(async (req, res) => {
    const row = modSession(req, res, await fleet.db.getSession(req.params.id!));
    if (!row) return;
    const result = (req.body as Record<string, unknown> | undefined)?.result;
    if (typeof result !== 'string' || !(DELIVERY_RESULTS as readonly string[]).includes(result)) {
      res.status(400).json({ ok: false, error: `expected result ${DELIVERY_RESULTS.join(', ')}`, path: '$.result' });
      return;
    }
    const got = withSource(sourceOf(req), () => fleet.respond.result(row.id, req.params.deliveryId!, result as DeliveryResult));
    if (got === 'unknown') {
      res.status(404).json({ ok: false, error: 'unknown delivery' });
      return;
    }
    // A retry of a result the delivery already has is answered 200 but logged once (#330).
    if (got === 'new') logger.info('respond.delivered', `podium: a delivery to session ${row.id} came back ${result}`, { session_id: row.id, result });
    res.json({ ok: true });
  }));

  // ---- the browser's side -----------------------------------------------------------------------

  const browser = Router();

  browser.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Cross-site protection, as in the Admin API: a change must carry a header a page on another site cannot add without
  // a preflight, and an Origin that is not this server is refused. The cookie is SameSite=Strict on top of that.
  browser.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.get('origin');
    let sameOrigin = true;
    if (origin) {
      try {
        sameOrigin = new URL(origin).host === req.get('host');
      } catch {
        sameOrigin = false;
      }
    }
    if (!sameOrigin || req.get('x-podium-respond') !== '1') {
      refuse(req, res, 403, 'cross-site request refused');
      return;
    }
    next();
  });

  browser.use(json);

  /** Who a request's cookie says is signed in, or null. A revoked or rotated token, or an idle sign-in, ends it. */
  const viewerOf = async (req: Request): Promise<Viewer | null> => {
    const sid = readCookie(req, COOKIE);
    const s = sid ? signIns.get(sid) : undefined;
    if (!sid || !s) return null;
    let viewer: Viewer | null = null;
    if (now() - s.last <= idleMs) {
      if (s.personId === null) viewer = d.token !== null ? { name: ADMIN_OWNER, actor: ADMIN_SECRET_ACTOR, admin: true, personId: null } : null;
      else {
        const p = await people?.getPerson(s.personId);
        if (p && p.revokedAt === null && p.tokenHash === s.tokenHash) viewer = { name: p.name, actor: p.name, admin: await people!.isAdministrator(p.id), personId: p.id };
      }
    }
    // A sign-out that came in while the person was being read ends this sign-in: do not put it back.
    const current = signIns.get(sid);
    if (!current) return null;
    signIns.delete(sid);
    if (!viewer) return null;
    signIns.set(sid, { ...current, last: now() }); // re-inserted, so the oldest entry is the least recently used
    return viewer;
  };

  if (d.bridge) {
    const signInOf = (req: Request) => {
      const sid = readCookie(req, COOKIE);
      return sid ? signIns.get(sid) : undefined;
    };
    d.bridge.administratorOf = async (req) => {
      const v = signInEnabled() ? await viewerOf(req) : null;
      return v?.admin && !signInOf(req)?.adminHeld ? { personId: v.personId } : null;
    };
    d.bridge.hold = (req) => {
      const s = signInOf(req);
      if (s) s.adminHeld = true;
    };
    d.bridge.release = (req, personId) => {
      const s = signInOf(req);
      if (s && s.personId === personId) s.adminHeld = false; // only the person who is signed in here lifts their own hold
    };
  }

  browser.get('/me', asyncHandler(async (req, res) => {
    const v = signInEnabled() ? await viewerOf(req) : null;
    const me: RespondMe = { enabled: signInEnabled(), signedIn: !!v, name: v?.name ?? null, admin: v?.admin ?? false };
    res.json(me);
  }));

  browser.post('/sign-in', d.onSignIn ?? ((_req, _res, next) => next()), asyncHandler(async (req, res) => {
    if (!signInEnabled()) {
      refuse(req, res, 403, 'responding is off');
      return;
    }
    const src = sourceOf(req);
    const lockedFor = lockout.lockedFor(src);
    if (lockedFor > 0) {
      res.status(429).json({ ok: false, error: 'too many wrong tries', retryAfterSec: Math.ceil(lockedFor / 1000) });
      return;
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!name || !token) {
      res.status(400).json({ ok: false, error: 'enter your name and your token' });
      return;
    }
    // A person's token only with that person's name; the admin secret only with the name Admin (7.7).
    let signIn: SignIn | null = null;
    let viewer: Viewer | null = null;
    const found = await checkNameToken(people, d.token, name, token);
    // The sign-in was counted against this address while the person was being read: a lockout reached meanwhile refuses this one too, right or wrong.
    const lockedNow = lockout.lockedFor(src);
    if (lockedNow > 0) {
      res.status(429).json({ ok: false, error: 'too many wrong tries', retryAfterSec: Math.ceil(lockedNow / 1000) });
      return;
    }
    if (found?.person) {
      const p = found.person;
      signIn = { personId: p.id, tokenHash: p.tokenHash, last: now() };
      viewer = { name: p.name, actor: p.name, admin: await people!.isAdministrator(p.id), personId: p.id };
    } else if (found) {
      signIn = { personId: null, tokenHash: null, last: now() };
      viewer = { name: ADMIN_OWNER, actor: ADMIN_SECRET_ACTOR, admin: true, personId: null };
    }
    if (!signIn || !viewer) {
      const { n, locked } = lockout.fail(src);
      await people?.log('respond_sign_in_failed', locked ? `Wrong name or token (${n}); locked for ${Math.round(lockout.lockMs / 60_000)} minutes` : `Wrong name or token (${n})`, src, now(), null);
      logger.warn('respond.sign_in_failed', `podium: a sign-in to respond from ${src} was refused`, { source: src, failures: n, locked });
      res.status(401).json({ ok: false, error: 'wrong name or token' });
      return;
    }
    lockout.succeed(src);
    if (signIns.size >= MAX_SIGN_INS) signIns.delete(signIns.keys().next().value as string);
    const sid = randomBytes(32).toString('hex');
    signIns.set(sid, signIn);
    // A browser signed in before #215 holds a cookie at the old, narrower path; it is sent first and would shadow this one.
    res.clearCookie(COOKIE, { path: LEGACY_COOKIE_PATH });
    res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'strict', path: COOKIE_PATH, secure: req.secure });
    await people?.log('respond_sign_in', 'Signed in to respond', src, now(), viewer.actor);
    logger.info('respond.sign_in', `podium: ${viewer.name} signed in to respond from ${src}`, { source: src, admin: viewer.admin });
    res.json({ ok: true, name: viewer.name, admin: viewer.admin });
  }));

  browser.post('/sign-out', (req, res) => {
    const sid = readCookie(req, COOKIE);
    if (sid) signIns.delete(sid);
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
    res.clearCookie(COOKIE, { path: LEGACY_COOKIE_PATH });
    res.json({ ok: true });
  });

  /**
   * The signed-in viewer and the live session they may respond to; otherwise answers and returns null. The viewer is read first and
   * the session last, so the checks after the session is read and the handler's next steps run in one turn.
   */
  const browserSession = async (req: Request, res: Response): Promise<{ v: Viewer; row: SessionRow } | null> => {
    if (!enabled()) {
      refuse(req, res, 403, 'responding is off');
      return null;
    }
    const v = await viewerOf(req);
    if (!v) {
      refuse(req, res, 403, 'sign in to respond');
      return null;
    }
    const row = await fleet.db.getSession(req.params.id!);
    if (!row || !fleet.isLive(row.id)) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return null;
    }
    if (!viewerOwns(v, row)) {
      refuse(req, res, 403, 'not your session', { owner: row.owner });
      return null;
    }
    return { v, row };
  };

  /** Each answer, message and command the server takes: the admin log and the server log, never its text (7.7). */
  const audit = async (req: Request, v: Viewer, row: SessionRow, delivery: Delivery): Promise<void> => {
    const src = sourceOf(req);
    await people?.log('respond_sent', `${logWords(delivery)} in ${row.name} (${row.id.slice(0, 8)}) [${shortDeliveryId(delivery)}]`, src, now(), v.actor);
    logger.info('respond.sent', `podium: ${logWords(delivery).toLowerCase()} in session ${row.id}`, { session_id: row.id, kind: delivery.kind, admin: v.admin, source: src });
  };

  /**
   * One file's diff (#319). Only the session's owner: the signed-in person whose name is the session's owner, so not an
   * Administrator, and not another person. The request is held until the mod answers or FILE_DIFF_LIMITS.holdSeconds pass.
   * The text is never logged or kept; the admin log records only that the path was opened, and by whom.
   */
  browser.get('/sessions/:id/files/diff', asyncHandler(async (req, res) => {
    if (!diffEnabled()) {
      refuse(req, res, 403, 'file diff is off');
      return;
    }
    const v = await viewerOf(req);
    if (!v) {
      refuse(req, res, 401, 'sign in to open diffs');
      return;
    }
    const row = await fleet.db.getSession(req.params.id!);
    if (!row || !fleet.isLive(row.id)) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return;
    }
    if (row.owner === null || nameKey(row.owner) !== nameKey(v.name)) {
      refuse(req, res, 403, 'not your session', { owner: row.owner });
      return;
    }
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    if (!path || path.length > LIMITS.filePath) {
      res.status(400).json({ ok: false, error: 'path is needed', path: '$.path' });
      return;
    }
    if (fleet.diffs.optionOn(row.id) !== true) {
      refuse(req, res, 403, 'file diff is off');
      return;
    }
    // A load ahead (#631) is the console reading the file before anyone opened it; the reporter must have allowed that.
    const ahead = req.query.ahead === '1';
    if (ahead && fleet.diffs.preloadOn(row.id) !== true) {
      refuse(req, res, 403, 'loading diffs ahead is off');
      return;
    }
    const got = await fleet.diffs.ask(row.id, path);
    if (got === 'busy') {
      res.status(429).json({ ok: false, error: 'too many diffs are waiting for this session' });
      return;
    }
    if (got === null) {
      res.status(504).json({ ok: false, error: 'no answer' });
      return;
    }
    const kind = ahead ? 'loaded' : 'opened';
    await people?.log(`file_diff_${kind}`, `${path} in ${row.name} (${row.id.slice(0, 8)})`, sourceOf(req), now(), v.actor);
    logger.info(`file_diff.${kind}`, `podium: a file diff was ${kind} in session ${row.id}`, { session_id: row.id, status: got.status, source: sourceOf(req) });
    res.json(got);
  }));

  // The person opened a diff the console had already loaded ahead (#631): no request carried that open, so the browser says so.
  browser.post('/sessions/:id/files/diff/opened', asyncHandler(async (req, res) => {
    if (!diffEnabled()) {
      refuse(req, res, 403, 'file diff is off');
      return;
    }
    const v = await viewerOf(req);
    if (!v) {
      refuse(req, res, 401, 'sign in to open diffs');
      return;
    }
    const row = await fleet.db.getSession(req.params.id!);
    if (!row || !fleet.isLive(row.id)) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return;
    }
    if (row.owner === null || nameKey(row.owner) !== nameKey(v.name)) {
      refuse(req, res, 403, 'not your session', { owner: row.owner });
      return;
    }
    const path = typeof req.body?.path === 'string' ? req.body.path : '';
    if (!path || path.length > LIMITS.filePath) {
      res.status(400).json({ ok: false, error: 'path is needed', path: '$.path' });
      return;
    }
    if (fleet.diffs.optionOn(row.id) !== true || fleet.diffs.preloadOn(row.id) !== true) {
      refuse(req, res, 403, 'file diff is off');
      return;
    }
    await people?.log('file_diff_opened', `${path} in ${row.name} (${row.id.slice(0, 8)})`, sourceOf(req), now(), v.actor);
    logger.info('file_diff.opened', `podium: a file diff was opened in session ${row.id}`, { session_id: row.id, status: 'loaded ahead', source: sourceOf(req) });
    res.status(204).end();
  }));

  browser.get('/sessions/:id/asks/:askId', asyncHandler(async (req, res) => {
    const got = await browserSession(req, res);
    if (!got) return;
    const detail = fleet.respond.detail(got.row.id, req.params.askId!, got.v.name, got.row.last_seen_at);
    if (!detail) {
      res.status(404).json({ ok: false, error: 'unknown ask' });
      return;
    }
    res.json(detail);
  }));

  browser.post('/sessions/:id/asks/:askId/answer', asyncHandler(async (req, res) => {
    const got = await browserSession(req, res);
    if (!got) return;
    const out = fleet.respond.answer(got.row.id, req.params.askId!, got.v.name, req.body);
    if (!out.ok) {
      if (out.err.status !== 400) logger.info('respond.refused', `podium: an answer to session ${got.row.id} was refused: ${out.err.error}`, { session_id: got.row.id, status: out.err.status, reason: out.err.error });
      answerError(res, out.err);
      return;
    }
    await audit(req, got.v, got.row, out.delivery);
    res.status(202).json({ ok: true, deliveryId: out.delivery.id });
  }));

  browser.post('/sessions/:id/messages', asyncHandler(async (req, res) => {
    const got = await browserSession(req, res);
    if (!got) return;
    const out = fleet.respond.message(got.row.id, got.v.name, req.body);
    if (!out.ok) {
      answerError(res, out.err);
      return;
    }
    await audit(req, got.v, got.row, out.delivery);
    res.status(202).json({ ok: true, deliveryId: out.delivery.id, queued: got.row.status === 'running' });
  }));

  browser.delete('/deliveries/:deliveryId', asyncHandler(async (req, res) => {
    if (!enabled()) {
      refuse(req, res, 403, 'responding is off');
      return;
    }
    const v = await viewerOf(req);
    if (!v) {
      refuse(req, res, 403, 'sign in to respond');
      return;
    }
    const out = withSource(sourceOf(req), () => fleet.respond.discard(req.params.deliveryId!, v.name, v.admin));
    if (out === 'unknown') res.status(404).json({ ok: false, error: 'unknown delivery' });
    else if (out === 'forbidden') refuse(req, res, 403, 'not your answer');
    else if (out === 'handed-over') res.status(409).json({ ok: false, error: 'handed over' });
    else res.json({ ok: true });
  }));

  /**
   * A loop's stored Activity history, a page at a time (#432). Only the session's owner or an Admin, signed in. It works with
   * `respond` off: it needs a keep policy, which needs a token. Any session in the main database, live or not. The text is
   * never logged.
   */
  browser.get('/sessions/:id/activity-history', asyncHandler(async (req, res) => {
    const v = await viewerOf(req);
    if (!v) {
      refuse(req, res, 401, 'sign in to open the stored activity');
      return;
    }
    const row = await fleet.db.getSession(req.params.id!);
    if (!row) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return;
    }
    if (fleet.activityHistorySettings.get().policy === 'default') {
      res.status(404).json({ ok: false, error: 'no activity is kept' });
      return;
    }
    if (!viewerOwns(v, row)) {
      refuse(req, res, 403, 'not your session', { owner: row.owner });
      return;
    }
    const loop = req.query.loop === undefined || req.query.loop === '' ? MAIN_LOOP : req.query.loop;
    if (typeof loop !== 'string' || (loop !== MAIN_LOOP && !(await fleet.db.getAgents(row.id)).some((a) => a.id === loop))) {
      res.status(404).json({ ok: false, error: 'unknown loop', path: '$.loop' });
      return;
    }
    const read = parseRead(req.query);
    if (!read.ok) {
      res.status(400).json({ ok: false, error: read.error, path: '$.query' });
      return;
    }
    const limit = Math.min(Math.max(read.value.limit ?? ACTIVITY_HISTORY_PAGE, 1), ACTIVITY_HISTORY_PAGE_MAX);
    const page: ActivityHistoryPage = await fleet.activityHistory.page(row.id, loop, read.value.before, limit);
    res.json(page);
  }));

  d.extendBrowser?.(browser, { viewerOf });
  router.use('/respond', browser);
  return {
    reader: async (req) => {
      const v = await viewerOf(req);
      return (row) => v !== null && viewerOwns(v, row);
    },
  };
}

/** For the report route: whether this session takes answers now, and what waits for it (6.1). */
export async function replyFor(fleet: Fleet, token: string | null, sessionId: string): Promise<{ respond: boolean; deliveries: Delivery[]; diffs: DiffRequest[] }> {
  const owner = (await fleet.db.getSession(sessionId))?.owner ?? null;
  const respond = token !== null && fleet.respondFlagsOn() && owner !== null;
  const diffs = token !== null && fleet.features.featureOn(FILE_DIFF) && owner !== null ? fleet.diffs.listFor(sessionId) : [];
  return { respond, deliveries: respond ? fleet.respond.deliveriesFor(sessionId) : [], diffs };
}

