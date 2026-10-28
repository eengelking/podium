// Express router for Podium, mounted at /api/fleet (SPEC 7.1, 7.7).
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Fleet } from './fleet.js';
import { serverBuild } from './build.js';
import { checkReporter, REPORTER_SUPPORT, serverVersion } from './compat.js';
import { MAIN_LOOP, validateReport } from './protocol.js';
import { everyOf, type ActivityReply } from './activity.js';
import { OwnerConflict } from './ingest.js';
import { ADMIN_OWNER, nameKey, sourceAddress, type PersonRow } from './people.js';
import { ReporterStore, type IgnoreRule, type IgnoreTarget, type ReporterSeen } from './reporters.js';
import type { PeopleStoreApi, PersonCertsApi, ReporterStoreApi } from '../storage/types.js';
import { parsePersonToken, safeEqualStr, tokenMatches } from './tokens.js';
import { createLogger, loggerFromLine, type Logger } from '../logging/logger.js';
import { GuessThrottle, Lockout } from './lockout.js';
import { mountRespondRoutes, replyFor, type RespondAccess } from './respondRoutes.js';
import { mountPeerBrowserRoutes, mountPeerRoutes, peerReplyFor, peersEnabled, type PeerDeps } from './peerRoutes.js';
import { mountRecordingBrowserRoutes, mountRecordingRoutes, recordingEnabled, wireRecordingLogs } from './recordingRoutes.js';
import type { RespondBridge } from './respondBridge.js';
import { isNewer } from './updateCheck.js';
import { refusableOverHttp, type ReporterTransport } from '../tlsHttp.js';
import { asyncHandler } from './asyncHandler.js';
import { certAuth, type ClientSocket } from '../tlsClientAuth.js';

export interface FleetRouterOptions {
  /** The admin secret (PODIUM_TOKEN). When set, POST /report, DELETE and POST /hook need a credential in X-Podium-Token: this, or a person's token. */
  token?: string | null;
  /** Per-person tokens. Without it only the admin secret works. */
  people?: PeopleStoreApi | null;
  /** Where every accepted report's sender is recorded, for the Admin's Reporters page (#142). */
  reporters?: ReporterStoreApi | null;
  /** The server's logger (#140). Never given a report body, a token or typed text. */
  logger?: Logger;
  /** A plain line sink, kept for callers from before the logger: text lines, as `logger` would print them. */
  log?: (line: string) => void;
  /** Wrong-try counter shared with Admin's unlock, for the sign-in to respond (#206). A fresh one when absent. */
  lockout?: Lockout;
  /** Throttle for wrong secrets sent as X-Podium-Token, separate from `lockout` (#255). A fresh one when absent. */
  guesses?: GuessThrottle;
  /** Filled in so Admin can open for a browser already signed in to respond as an Administrator (#215). */
  respondBridge?: RespondBridge;
  /** Runs ahead of the sign-in to respond, to note a plain-HTTP connection (#306). It never blocks. */
  onSignIn?: RequestHandler;
  /** Built-in TLS (#583): the certificates people authenticate with. A client certificate on the connection decides who the sender is, ahead of any token. */
  certs?: { store: PersonCertsApi; trustedIssuers: () => string[] };
  /** Built-in TLS (#589): told which transport each reporter last used, for the Admin's count of reporters on HTTP. */
  transport?: ReporterTransport;
}

export const BODY_LIMIT = '512kb';

/** Who a request's X-Podium-Token says it is. */
export type Identity = { kind: 'person'; person: PersonRow } | { kind: 'admin' } | { kind: 'open' };

/** Who a request is, or why it was refused (the reason goes to the log, never to the client, and never the token). */
async function identify(opts: FleetRouterOptions, given: unknown): Promise<Identity | { refused: string }> {
  const presented = typeof given === 'string' ? given : '';
  const parsed = presented ? parsePersonToken(presented) : null;
  if (parsed && opts.people) {
    const person = await opts.people.findByKeyId(parsed.keyId);
    if (!person) return { refused: 'unknown person token' };
    if (person.revokedAt !== null) return { refused: 'revoked person token' };
    if (!tokenMatches(presented, person.tokenHash)) return { refused: 'wrong person token' };
    return { kind: 'person', person };
  }
  if (opts.token) {
    if (!presented) return { refused: 'missing token' };
    if (!safeEqualStr(opts.token, presented)) return { refused: 'wrong token' };
    return !opts.people || (await opts.people.adminReportingAllowed()) ? { kind: 'admin' } : { refused: 'reporting with the admin secret is off' };
  }
  // Authentication is off. A token that was presented but is not a person's is simply ignored.
  return { kind: 'open' };
}

/** The address a report came from, as the Machines column shows it. */
const machineOf = (req: Request): string | null => (req.ip ? sourceAddress(req.ip) : null);

/** How the Reporters page names the credential: a person's token by its key id (never the token), or the admin secret. */
const credentialOf = (id: Identity): string | null => (id.kind === 'person' ? `pdm_${id.person.keyId}` : id.kind === 'admin' ? 'admin secret' : null);

/** The `hostSurface` the simulator reports; the Reporters page never lists it (#168). */
const SIMULATOR_SURFACE = 'simulator';

/** Bookkeeping for the Reporters page must never turn a stored report into a failed one. Returns the reporter's key, or null. */
async function noteReporter(opts: FleetRouterOptions, logger: Logger, seen: ReporterSeen, now: number): Promise<string | null> {
  try {
    return (await opts.reporters?.record(seen, now)) ?? null;
  } catch (err) {
    logger.warn('reporter.record_failed', `podium: could not note the reporter: ${(err as Error).message}`, { reason: (err as Error).message });
    return null;
  }
}

/** The key a sender is known by, and any other row that already holds its session, for the ignore check. */
async function keyTarget(opts: FleetRouterOptions, s: { kind: 'mod' | 'hooks'; machineId: string | null; source: string | null; sessionId: string; owner?: string | null }): Promise<{ key: string; otherKeys: string[] }> {
  const own = ReporterStore.keyOf(s);
  try {
    const keys = (await opts.reporters?.keysFor(s)) ?? [own];
    return { key: own, otherKeys: keys.filter((k) => k !== own) };
  } catch {
    return { key: own, otherKeys: [] };
  }
}

/** Refuses a report from a reporter the Admin ignores (issue #167): says so, notes it, and returns true. Nothing is stored. */
async function refuseIgnored(opts: FleetRouterOptions, logger: Logger, fleet: Fleet, req: Request, res: Response, who: IgnoreTarget): Promise<boolean> {
  let rule: IgnoreRule | undefined;
  try {
    rule = await opts.reporters?.ignoredBy(who);
  } catch (err) {
    logger.warn('reporter.ignore_check_failed', `podium: could not check the ignore rules: ${(err as Error).message}`, { reason: (err as Error).message });
  }
  if (!rule) return false;
  const reason = 'this reporter is ignored by the Admin';
  logger.warn('report.ignored', `podium: refused ${routeName(req)} from ${machineOf(req) ?? 'unknown'}: ${reason}`, { route: routeName(req), method: req.method, status: 403, reason, rule_id: rule.id, source: machineOf(req) });
  await opts.reporters?.rejected(machineOf(req), reason, fleet.now());
  res.status(403).json({ ok: false, error: reason, path: '$' });
  return true;
}

const ownerOf = (id: Identity): string | null => (id.kind === 'person' ? id.person.name : id.kind === 'admin' ? ADMIN_OWNER : null);

/** Rows per page on `GET /history` (#195): the choices the page offers, and the default. */
export const HISTORY_PAGE_SIZES = [25, 50, 100];
const HISTORY_PAGE_SIZE = 50;

function intParam(v: unknown): number | null | 'bad' {
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return 'bad';
  return Number(v);
}

/** The route a request matched, as `/api/fleet/report`. */
const routeName = (req: Request): string => `${req.baseUrl}${(req.route as { path?: string } | undefined)?.path ?? req.path}`;

export function createFleetRouter(fleet: Fleet, opts: FleetRouterOptions = {}): Router {
  const logger = opts.logger ?? (opts.log ? loggerFromLine(opts.log) : createLogger({ secrets: opts.token ? [opts.token] : [] }));
  const router = Router();
  // Set when the respond routes are mounted below; the live activity route reads the viewer through it.
  let respondAccess: RespondAccess | undefined;
  const json = express.json({ limit: BODY_LIMIT, type: ['application/json', 'application/*+json'] });

  const guesses = opts.guesses ?? new GuessThrottle(fleet.now);
  /** A person's token is 192 random bits, so it cannot be guessed and is never throttled; anything else could be a guess at the admin secret. */
  const mayBeGuess = (given: unknown): given is string => typeof given === 'string' && given !== '' && !(opts.people && parsePersonToken(given));

  const requireToken = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const given = req.get('x-podium-token');
    const source = machineOf(req) ?? 'unknown';
    // A client certificate is checked on every request, so a revoke reaches a connection that is still open. One that is
    // presented but not trusted is refused outright and never falls back to a token (SPEC 6, *Authenticating by certificate*).
    if (opts.certs && opts.people) {
      const c = await certAuth(req.socket as unknown as ClientSocket, { certs: opts.certs.store, people: opts.people, trustedIssuers: opts.certs.trustedIssuers, now: fleet.now });
      if (c.kind === 'person') {
        res.locals.identity = { kind: 'person', person: c.person } satisfies Identity;
        return next();
      }
      if (c.kind === 'refused') {
        const route = routeName(req);
        logger.warn('auth.failed', `podium: refused ${req.method} ${route} from ${source}: ${c.reason}`, { route, method: req.method, status: 401, reason: c.reason, source: machineOf(req) });
        await opts.reporters?.rejected(machineOf(req), c.reason, fleet.now());
        res.status(401).json({ ok: false, error: 'client certificate refused', path: '$' });
        return;
      }
    }
    // A throttled address gets no answer for anything that could be a guess, even the right secret, or the throttle would confirm one.
    const lockedFor = opts.token && mayBeGuess(given) ? guesses.lockedFor(source) : 0;
    if (lockedFor > 0) {
      const route = routeName(req);
      logger.warn('auth.failed', `podium: throttled ${req.method} ${route} from ${source}: too many wrong secrets`, {
        route,
        method: req.method,
        status: 429,
        reason: 'too many wrong secrets',
        source,
      });
      await opts.reporters?.rejected(machineOf(req), 'too many wrong secrets', fleet.now());
      res.set('Retry-After', String(Math.ceil(lockedFor / 1000)));
      res.status(429).json({ ok: false, error: 'too many wrong tries', retryAfterSec: Math.ceil(lockedFor / 1000) });
      return;
    }
    const id = await identify(opts, given);
    if ('refused' in id && opts.token && mayBeGuess(given) && id.refused === 'wrong token') guesses.fail(source, given);
    if (!('refused' in id)) {
      res.locals.identity = id;
      return next();
    }
    const route = routeName(req);
    logger.warn('auth.failed', `podium: refused ${req.method} ${route} from ${machineOf(req) ?? 'unknown'}: ${id.refused}`, {
      route,
      method: req.method,
      status: 401,
      reason: id.refused,
      source: machineOf(req),
    });
    await opts.reporters?.rejected(machineOf(req), id.refused, fleet.now());
    res.status(401).json({ ok: false, error: 'missing or wrong X-Podium-Token', path: '$' });
  });
  const identityOf = (res: Response): Identity => res.locals.identity as Identity;

  router.post('/report', requireToken, json, asyncHandler(async (req, res) => {
    const result = validateReport(req.body);
    if (!result.ok) {
      logger.warn('report.rejected', `podium: rejected report at ${result.path}: ${result.error}`, {
        reason: result.error,
        path: result.path,
        status: 400,
        source: machineOf(req),
      });
      await opts.reporters?.rejected(machineOf(req), `${result.error} (${result.path})`, fleet.now());
      res.status(400).json({ ok: false, error: result.error, path: result.path });
      return;
    }
    const id = identityOf(res);
    // The token decides who the sender is; the name it carries must agree (a consistency check, since names are visible).
    if (id.kind === 'person' && nameKey(result.report.userName ?? '') !== nameKey(id.person.name)) {
      logger.warn('auth.failed', `podium: refused a report from ${machineOf(req) ?? 'unknown'}: the token does not belong to that name`, {
        route: routeName(req),
        method: req.method,
        status: 401,
        reason: 'the token does not belong to that name',
        owner: id.person.name,
        source: machineOf(req),
        session_id: result.report.session.id,
      });
      await opts.reporters?.rejected(machineOf(req), 'the token does not belong to that name', fleet.now());
      res.status(401).json({ ok: false, error: 'the token does not belong to that name', path: '$.userName' });
      return;
    }
    const machineId = result.report.machine?.id ?? null;
    const asHooks = result.report.reporter.hostSurface === 'settings-hooks';
    if (
      result.report.reporter.hostSurface !== SIMULATOR_SURFACE &&
      (await refuseIgnored(opts, logger, fleet, req, res, {
        ...(await keyTarget(opts, { kind: asHooks ? 'hooks' : 'mod', machineId, source: machineOf(req), sessionId: result.report.session.id, owner: ownerOf(id) })),
        source: machineOf(req),
        version: result.report.reporter.version,
      }))
    ) {
      return;
    }
    try {
      const out = await fleet.ingest(result.report, ownerOf(id));
      if (id.kind === 'person') await opts.people?.touch(id.person.id, machineOf(req), fleet.now(), result.report.machine); // only a report that was stored counts
      const r = result.report;
      // The simulator (`npm run podium:sim`) says so in hostSurface; it is never listed, so a run leaves no reporter row behind (#168).
      if (r.reporter.hostSurface !== SIMULATOR_SURFACE) {
        const key = await noteReporter(
          opts,
          logger,
          {
            kind: asHooks ? 'hooks' : 'mod',
            machineId: r.machine?.id ?? null,
            machineName: r.machine?.name ?? null,
            source: machineOf(req),
            owner: ownerOf(id),
            credential: credentialOf(id),
            version: r.reporter.version,
            engineVersion: r.reporter.engineVersion,
            sessionId: out.sessionId,
            os: r.machine?.os ?? null,
            peers: r.session.peers ?? null,
          },
          fleet.now(),
        );
        if (key) opts.transport?.note(key, !refusableOverHttp(req), fleet.now());
        // Orchestrator messaging (#347) knows a session by its reporter, and only a person's own reporter takes part.
        if (key && id.kind === 'person' && !asHooks) await fleet.peers.note(out.sessionId, key, id.person.name, r);
      }
      logger.debug('report.accepted', `podium: report for session ${out.sessionId}`, {
        session_id: out.sessionId,
        owner: ownerOf(id),
        events: result.report.events.length,
        new_events: out.newEvents.length,
        agents: result.report.agents.length,
        status: result.report.session.status,
        reporter_version: result.report.reporter.version,
      });
      res.json({ ok: true, serverTime: fleet.now(), ackedEvents: result.report.events.length, sessionId: out.sessionId, liveSessions: await fleet.visibleCount(), serverVersion: serverVersion(), serverBuild: serverBuild(), reporterSupport: REPORTER_SUPPORT, reporterCompat: checkReporter(result.report.reporter.version), watch: await fleet.watchedLoops(out.sessionId), watchOutput: fleet.activity.watchedOutput(out.sessionId), ...(await replyFor(fleet, opts.token ?? null, out.sessionId)), ...(await peerReplyFor(fleet, opts.token ?? null, out.sessionId, id)), recording: await fleet.recordings.grant(out.sessionId) });
    } catch (err) {
      if (err instanceof OwnerConflict) {
        logger.warn('report.conflict', `podium: refused a report for session ${result.report.session.id}: it belongs to someone else`, {
          session_id: result.report.session.id,
          owner: ownerOf(id),
          status: 409,
          reason: 'that session belongs to someone else',
          source: machineOf(req),
        });
        res.status(409).json({ ok: false, error: 'that session belongs to someone else', path: '$.session.id' });
        return;
      }
      logger.error('ingest.failed', `podium: ingest failed for a report: ${(err as Error).message}`, {
        session_id: result.report.session.id,
        reason: (err as Error).message,
        status: 500,
      });
      res.status(500).json({ ok: false, error: 'ingest failed', path: '$' });
    }
  }));

  // Classic settings hooks (T5.1): each hook POSTs its stdin payload here.
  router.post('/hook', requireToken, json, asyncHandler(async (req, res) => {
    try {
      const id = identityOf(res);
      const hookSession = typeof req.body?.session_id === 'string' ? (req.body.session_id as string) : '';
      if (await refuseIgnored(opts, logger, fleet, req, res, { ...(await keyTarget(opts, { kind: 'hooks', machineId: null, source: machineOf(req), sessionId: hookSession })), source: machineOf(req), version: 'hooks' })) return;
      const out = await fleet.ingestHook(req.body, ownerOf(id));
      if (!out.ok) {
        logger.warn('hook.rejected', `podium: rejected hook payload at ${out.path}: ${out.error}`, {
          reason: out.error,
          path: out.path,
          status: 400,
          source: machineOf(req),
        });
        await opts.reporters?.rejected(machineOf(req), `${out.error} (${out.path})`, fleet.now());
        res.status(400).json(out);
        return;
      }
      if (id.kind === 'person') await opts.people?.touch(id.person.id, machineOf(req), fleet.now());
      const hookKey = await noteReporter(
        opts,
        logger,
        { kind: 'hooks', machineId: null, machineName: null, source: machineOf(req), owner: ownerOf(id), credential: credentialOf(id), version: 'hooks', engineVersion: null, sessionId: out.sessionId },
        fleet.now(),
      );
      if (hookKey) opts.transport?.note(hookKey, !refusableOverHttp(req), fleet.now());
      res.json({ ok: true, sessionId: out.sessionId });
    } catch (err) {
      if (err instanceof OwnerConflict) {
        const sid = typeof req.body?.session_id === 'string' ? (req.body.session_id as string) : null;
        logger.warn('report.conflict', `podium: refused a hook payload for session ${sid ?? 'unknown'}: it belongs to someone else`, {
          session_id: sid,
          status: 409,
          reason: 'that session belongs to someone else',
          source: machineOf(req),
        });
        res.status(409).json({ ok: false, error: 'that session belongs to someone else', path: '$.session_id' });
        return;
      }
      logger.error('ingest.failed', `podium: hook ingest failed: ${(err as Error).message}`, { reason: (err as Error).message, status: 500, route: routeName(req) });
      res.status(500).json({ ok: false, error: 'ingest failed', path: '$' });
    }
  }));

  router.get('/state', asyncHandler(async (_req, res) => {
    res.json(await fleet.state());
  }));

  router.get('/stream', asyncHandler(async (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (fleet.hub.isFull) {
      res.end('event: error\ndata: {"error":"too many clients"}\n\n');
      return;
    }
    res.flushHeaders();
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    // The client joins in the message queue, behind everything asked for before it, with the snapshot as its first message.
    const id = await fleet.attach({
      write: (chunk: string) => {
        if (res.writableEnded || res.destroyed) throw new Error('closed');
        res.write(chunk);
      },
      end: () => res.end(),
    });
    // null here means the client vanished while being added: there is nobody left to tell.
    if (id === null) return;
    const drop = () => fleet.hub.remove(id);
    req.on('close', drop);
    res.on('error', drop);
  }));

  router.get('/sessions/:id', asyncHandler(async (req, res) => {
    const view = await fleet.view(req.params.id);
    if (!view) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return;
    }
    res.json(view);
  }));

  // The whole prompt and answer, fetched when the console opens them (issue #97). Not in the state or
  // the stream: they can be tens of kilobytes per agent.
  router.get('/sessions/:id/agents/:agentId/text', asyncHandler(async (req, res) => {
    const t = await fleet.db.getAgentTexts(req.params.id, req.params.agentId);
    if (!t) {
      res.status(404).json({ ok: false, error: 'no full text for this agent', path: '$.agentId' });
      return;
    }
    res.json(t);
  }));

  // An agent's recent activity (#118). Each fetch takes or renews the viewer's lease on that loop for `every` seconds
  // plus a margin; the reply to the next report then asks the mod for its entries. `@orchestrator` is the main loop.
  // In memory only, never in the state or the stream. No token, like the other reads.
  router.get('/sessions/:id/agents/:agentId/activity', asyncHandler(async (req, res) => {
    const { id, agentId } = req.params;
    if (!(await fleet.db.getSession(id)) || (agentId !== MAIN_LOOP && !(await fleet.db.getAgents(id)).some((a) => a.id === agentId))) {
      res.status(404).json({ ok: false, error: 'unknown session or agent', path: '$.agentId' });
      return;
    }
    // With the Admin's flag off (Admin > Settings > Feature flags) no lease is taken; the panel keeps asking and says so.
    let body: ActivityReply;
    if (!fleet.activity.on) body = { entries: [], since: null, live: fleet.isLive(id), enabled: false, serverTime: fleet.now() };
    else if (!fleet.isLive(id)) body = { entries: [], since: null, live: false, enabled: true, serverTime: fleet.now() };
    else body = { ...fleet.activity.watch(id, agentId, everyOf(req.query.every)), live: true, enabled: true, serverTime: fleet.now() };
    // What is stored for this loop, as counts. Present only under a keep policy and when the loop has entries, so under the
    // default policy the reply is exactly what it was. `canRead` is the viewer's own sign-in; it never refuses the request.
    const note = await fleet.activityHistory.note(id, agentId);
    if (note) {
      const row = await fleet.db.getSession(id);
      body.history = { ...note, canRead: !!row && ((await respondAccess?.reader(req))?.(row) ?? false), owner: row?.owner ?? null };
    }
    res.set('Cache-Control', 'no-store').json(body);
  }));

  router.delete('/sessions/:id', requireToken, asyncHandler(async (req, res) => {
    if (!(await fleet.deleteSession(req.params.id))) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return;
    }
    res.json({ ok: true });
  }));

  // Remove on a heartbeat-lost card. It only hides a card the server was about to drop anyway, so it takes
  // no token, like the other reads the dashboard makes. SPEC 7.1, 7.5.
  router.post('/sessions/:id/drop', asyncHandler(async (req, res) => {
    const out = await fleet.dropSession(req.params.id);
    if (out === 'unknown') {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return;
    }
    if (out === 'not-stale') {
      res.status(409).json({ ok: false, error: 'session is not heartbeat lost', path: '$.id' });
      return;
    }
    res.json({ ok: true });
  }));

  // Closing a wall notice and the Show/Hide link on the background-sessions note. Both only change how the wall
  // looks, like Remove above, so they take no token (and no admin cookie: the wall has none). SPEC 7.1, 8.1.
  router.post('/notices/:id/close', asyncHandler(async (req, res) => {
    if (!(await fleet.wall.setNotice(req.params.id, false))) {
      res.status(400).json({ ok: false, error: 'unknown notice', path: '$.id' });
      return;
    }
    await opts.people?.log('wall_notice_changed', `Wall notice ${req.params.id} turned off from the wall`, machineOf(req) ?? '', fleet.now());
    logger.info('admin.wall_notice_changed', `podium: wall notice ${req.params.id} turned off from the wall`, { action: 'wall_notice_changed', setting: req.params.id, on: false, source: machineOf(req) });
    res.json({ ok: true });
  }));

  // Closing the update notice hides the release it names for everyone; a still newer release shows it again (#499, SPEC 8.1).
  router.post('/update-notice/close', json, asyncHandler(async (req, res) => {
    const v = req.body?.version;
    if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) {
      res.status(400).json({ ok: false, error: 'version must be MAJOR.MINOR.PATCH', path: '$.version' });
      return;
    }
    // Only a release the server is offering can be closed; a made-up newer version would hide every later release.
    const offered = fleet.updates.latest();
    if (!offered || isNewer(v, offered.latest)) {
      res.status(400).json({ ok: false, error: 'that release is not the one on offer', path: '$.version' });
      return;
    }
    await fleet.wall.dismissUpdate(v);
    await opts.people?.log('wall_update_dismissed', `Update notice for ${v} closed on the wall`, machineOf(req) ?? '', fleet.now());
    logger.info('admin.wall_update_dismissed', `podium: update notice for ${v} closed on the wall`, { action: 'wall_update_dismissed', version: v, source: machineOf(req) });
    res.json({ ok: true });
  }));

  router.put('/wall/background-sessions', json, asyncHandler(async (req, res) => {
    const v = req.body?.show;
    if (typeof v !== 'boolean') {
      res.status(400).json({ ok: false, error: 'show must be true or false', path: '$.show' });
      return;
    }
    await fleet.wall.setShowBackgroundSessions(v);
    await opts.people?.log('wall_background_changed', `Background sessions ${v ? 'shown' : 'hidden'} on the wall`, machineOf(req) ?? '', fleet.now());
    logger.info('admin.wall_background_changed', `podium: background sessions ${v ? 'shown' : 'hidden'} on the wall`, { action: 'wall_background_changed', on: v, source: machineOf(req) });
    res.json({ ok: true });
  }));

  router.get('/events', asyncHandler(async (req, res) => {
    const before = intParam(req.query.before);
    const limit = intParam(req.query.limit);
    const sessionId = req.query.sessionId;
    if (before === 'bad' || limit === 'bad' || (sessionId !== undefined && typeof sessionId !== 'string')) {
      res.status(400).json({ ok: false, error: 'bad query', path: '$.query' });
      return;
    }
    const n = Math.max(1, Math.min(200, limit ?? 50));
    res.json({ events: await fleet.events({ sessionId: sessionId || null, before, limit: n }) });
  }));

  router.get('/history', asyncHandler(async (req, res) => {
    const day = typeof req.query.day === 'string' ? req.query.day : '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!m) {
      res.status(400).json({ ok: false, error: 'day must be YYYY-MM-DD', path: '$.query.day' });
      return;
    }
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const start = new Date(y, mo - 1, d);
    // Date rolls 2026-02-31 over to March 3rd; a day that does not exist is a 400.
    if (start.getFullYear() !== y || start.getMonth() !== mo - 1 || start.getDate() !== d) {
      res.status(400).json({ ok: false, error: 'day is not a real date', path: '$.query.day' });
      return;
    }
    const page = intParam(req.query.page);
    const size = intParam(req.query.pageSize);
    if (page === 'bad' || size === 'bad' || page === 0 || (size !== null && !HISTORY_PAGE_SIZES.includes(size))) {
      res.status(400).json({ ok: false, error: `page must be 1 or more and pageSize one of ${HISTORY_PAGE_SIZES.join(', ')}`, path: '$.query' });
      return;
    }
    const pageSize = size ?? HISTORY_PAGE_SIZE;
    // The day's boundaries are the server's local midnight (the dashboard is for one machine).
    const from = start.getTime();
    const to = new Date(y, mo - 1, d + 1).getTime();
    // A page past the end is the last page, so a day that shrank under an open tab still shows rows.
    // A row says its recording is kept only to the session's owner and an Admin (#353).
    const { rows, total, page: at } = await fleet.historyPage(from, to, page ?? 1, pageSize, (await respondAccess?.reader(req)) ?? (() => false));
    res.json({ day, sessions: rows, total, page: at, pageSize });
  }));

  router.get('/health', asyncHandler(async (_req, res) => {
    res.json(await fleet.health());
  }));

  // Orchestrator messaging (#347): the mod's routes here, the owner's on responding's browser router below.
  const peerDeps: PeerDeps = { fleet, token: opts.token ?? null, people: opts.people ?? null, logger, requireToken, identityOf };
  mountPeerRoutes(router, peerDeps);

  // Session recording (#353): the mod's batch route here, the owner's and the Admin's on responding's browser router below.
  wireRecordingLogs(fleet, opts.people ?? null, logger);
  mountRecordingRoutes(router, peerDeps);

  // Responding from Podium (#206): the mod's ask routes and the browser's /respond routes.
  respondAccess = mountRespondRoutes(router, {
    fleet,
    token: opts.token ?? null,
    people: opts.people ?? null,
    logger,
    lockout: opts.lockout ?? new Lockout(fleet.now),
    bridge: opts.respondBridge,
    onSignIn: opts.onSignIn,
    requireToken,
    identityOf,
    alsoSignIn: () => peersEnabled(fleet, opts.token ?? null) || recordingEnabled(fleet, opts.token ?? null),
    extendBrowser: (browser, h) => {
      mountPeerBrowserRoutes(browser, peerDeps, h);
      mountRecordingBrowserRoutes(browser, peerDeps, h);
    },
  });

  router.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'not found', path: '$' });
  });

  // Body-parser errors (malformed JSON, too large, bad charset) become 4xx; anything else 500.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((err: { type?: string; status?: number; message?: string }, req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.too.large') {
      res.status(413).json({ ok: false, error: `body over ${BODY_LIMIT}`, path: '$' });
      return;
    }
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ ok: false, error: 'malformed JSON', path: '$' });
      return;
    }
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    logger.error('request.failed', `podium: request failed (${status}): ${err.type ?? err.message ?? 'error'}`, {
      status,
      reason: err.type ?? err.message ?? 'error',
      method: req.method,
      route: routeName(req),
    });
    res.status(status).json({ ok: false, error: status === 500 ? 'internal error' : (err.type ?? 'bad request'), path: '$' });
  });

  return router;
}
