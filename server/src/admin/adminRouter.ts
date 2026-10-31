// The Admin API, mounted at /api/admin (issue #36). Opened with the admin secret (PODIUM_TOKEN); after that a random session id
// lives in an HttpOnly, SameSite=Strict cookie and in this process's memory only. A restart, a secret rotation (which needs a
// restart) or ten idle minutes ends it. Nothing here ever returns, logs or stores a token or the secret: a token is shown once,
// in the response that creates or rotates it.
import { randomBytes } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { jsonBody } from '../jsonBody.js';
import { ADMIN_SECRET_ACTOR, PeopleError, sourceAddress, NOTICES, isNoticeId, REPORTER_STATES, FEATURES, isFeatureId, RESPOND, type PersonRow, type ForgetSetting, type IgnoreKind, type ReporterState } from '../storage/rows.js';
import type { ActivityHistoryApi, PeerStoreApi, PeopleStoreApi, PersonCertsApi, ReporterStoreApi, SessionRecordingsApi, Storage } from '../storage/types.js';
import { asyncHandler } from '../fleet/asyncHandler.js';
import { checkNameToken } from '../fleet/nameToken.js';
import type { RespondBridge } from '../fleet/respondBridge.js';
import { serverBuild } from '../fleet/build.js';
import { serverVersion } from '../fleet/compat.js';
import type { LiveActivityHistorySettings, LiveFeatureFlags, LiveModelPrices, LiveRecordingSettings, LiveWallSettings } from '../fleet/liveSettings.js';
import { PRICES_AS_OF, type PriceSet } from '../fleet/pricing.js';
import { Lockout } from '../fleet/lockout.js';
import { messageView, rangeOf } from '../fleet/peerRoutes.js';
import { createReportRouter } from '../fleet/reportRoutes.js';
import type { ReportDeps } from '../fleet/reports.js';
import { PEER_LEVELS, type PeerLevel } from '../fleet/protocol.js';
import type { Actor, Refusal } from '../fleet/peerTypes.js';
import { ALLOW_HTTP_KEY, type ServingRenewer } from '../tlsRenew.js';
import type { LiveTlsSettings } from '../tlsLive.js';
import type { ReporterTransport } from '../tlsHttp.js';
import type { CaRotation } from '../tlsServer.js';
import { TlsError } from '../tlsCa.js';
import { CROSS_DAYS } from '../tlsRotation.js';
import { fileSafe, issueConfigFor, type ConfigFile, type PersonIssuer } from '../tlsPeople.js';
import { sizeText } from '../fleet/sizeText.js';
import { capWords, countWords, policyWords } from '../fleet/activityHistoryWords.js';
import { ACTIVITY_LOG_KINDS, type ActivityHistorySettings, type ActivityHistoryState, type StoredDeleteBody, type StoredDeleteResult } from '../fleet/activityHistoryTypes.js';
import { parseDeleteBody, parseFilter, parsePaging, parseSettings } from '../fleet/activityHistoryInput.js';
import type { RecordingState } from '../fleet/protocol.js';
import { createLogger, loggerFromLine, type Fields, type Logger } from '../logging/logger.js';

export interface AdminRouterOptions {
  /** The admin secret. null when the server runs without authentication: Admin is then switched off. */
  secret: string | null;
  /** The storage's transaction, for the Admin changes that read, decide and write (revoking the last Administrator, say) as one step. */
  storage: Pick<Storage, 'tx'>;
  people: PeopleStoreApi;
  /** The wall's notice switches. Without it the Settings tab has nothing to change. */
  wall?: LiveWallSettings;
  /** The Admin's model prices (issue #117). Without it the Model prices group has nothing to change. */
  prices?: LiveModelPrices;
  /** The server-wide feature flags (#118). Without it the Feature flags group has nothing to change. */
  features?: LiveFeatureFlags;
  /** Every reporter the server has heard from (#142). Without it the Reporters tab has nothing to list. */
  reporters?: ReporterStoreApi;
  /** Orchestrator messaging (#347): the limits, a reporter's links, proposals, Pause all links and the conversations. */
  peers?: PeerStoreApi;
  /** The Activity history (#432): its store and the Admin's choice. Without it the Activity history routes answer 404. */
  activityHistory?: { history: ActivityHistoryApi; settings: LiveActivityHistorySettings };
  /** Built-in TLS (#577, T4): the serving certificate's settings and its renewer. `renewer()` is null while TLS is off, and the routes then answer 404. */
  certificates?: {
    settings: LiveTlsSettings;
    renewer: () => ServingRenewer | null;
    /** People's certificates (#583, T5): the store, and what it takes to issue one. `issuer()` is null while TLS is off, and the person routes then answer 404. */
    people?: { store: PersonCertsApi; issuer: () => PersonIssuer | null };
    /** Rotating and retiring the CA (#588). Null while TLS is off. */
    rotation?: () => CaRotation | null;
    /** Which reporters are on HTTP now (#589), for the count the switch names. */
    transport?: ReporterTransport;
  };
  /** Session recording (#353): the store, the Admin's limits and a way to tell open consoles a recording changed. Without it the recording routes answer 404. */
  recordings?: { service: SessionRecordingsApi; settings: LiveRecordingSettings; changed: (sessionId: string) => void };
  /** What the Reporting pages read (#484). Without it the report routes are not mounted. */
  reports?: ReportDeps;
  now?: () => number;
  /** Idle time before a session ends. */
  idleMs?: number;
  /** Wrong tries before a source is locked out, and for how long. */
  maxFails?: number;
  lockMs?: number;
  /** The wrong-try counter, shared with the console's sign-in to respond (#206). Made from maxFails and lockMs when absent. */
  lockout?: Lockout;
  /** Lets a browser already signed in to respond as an Administrator open Admin without signing in again (#215). */
  respondBridge?: RespondBridge;
  /** Called when the Admin turns Respond from Podium on, for the plain-HTTP warning (#306). */
  onRespondOn?: () => void;
  /** Called after a successful save of the Activity history setting, so open consoles get a fresh snapshot. */
  onActivityHistoryChanged?: () => void;
  /** How long the admin log is kept (#303); `GET /log` reports it so the Admin page can say so. */
  logRetainMs?: number;
  /** The server's logger (#140): each Admin change is an `admin.<action>` event with the source address. */
  logger?: Logger;
  /** A plain line sink, kept for callers from before the logger. */
  log?: (line: string) => void;
}

const COOKIE = 'podium_admin';
const MAX_SESSIONS = 20;
export const ADMIN_IDLE_MS = 10 * 60_000;

const sourceOf = (req: Request): string => sourceAddress(req.ip);

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const idParam = (v: string): number | null => (/^\d{1,12}$/.test(v) ? Number(v) : null);

/** A person as the Admin UI sees one: never the hash or any of the secret. The token is named by `pdm_<key id>` (#218). */
function publicPerson(p: PersonRow, groupName: string | null) {
  return {
    id: p.id,
    name: p.name,
    credential: `pdm_${p.keyId}`,
    groupId: p.groupId,
    groupName,
    createdAt: p.createdAt,
    rotatedAt: p.rotatedAt,
    revokedAt: p.revokedAt,
    lastReportAt: p.lastReportAt,
    machines: [] as string[],
  };
}

export function createAdminRouter(opts: AdminRouterOptions): Router {
  const { people, wall, prices, features, reporters, peers, storage } = opts;
  const now = opts.now ?? Date.now;
  const idleMs = opts.idleMs ?? ADMIN_IDLE_MS;
  const maxFails = opts.maxFails ?? 5;
  const lockMs = opts.lockMs ?? 15 * 60_000;
  const logger = opts.logger ?? (opts.log ? loggerFromLine(opts.log) : createLogger({ secrets: opts.secret ? [opts.secret] : [] }));
  // session id -> last activity, and the administrator who opened it (null for the admin secret)
  const sessions = new Map<string, { last: number; personId: number | null }>();
  const lockout = opts.lockout ?? new Lockout(now, maxFails, lockMs);
  const router = Router();

  /**
   * An Admin Log entry, and the same change as an `admin.<kind>` log event. The event carries the action, the
   * source address and the ids in `fields`, never the entry's free text (names, prices) or a token.
   */
  const audit = async (req: Request, kind: string, detail: string, fields: Fields = {}, actor?: string | null): Promise<void> => {
    const src = sourceOf(req);
    await people.log(kind, detail, src, now(), actor === undefined ? await actorOf(req) : actor);
    logger.log(kind === 'unlock_failed' ? 'warn' : 'info', `admin.${kind}`, `podium: admin ${kind.replace(/_/g, ' ')} from ${src}`, { action: kind, source: src, ...fields });
  };

  /** Who an unlocked request is from: the administrator's name, or the admin secret. Null when there is no open session. */
  async function actorOf(req: Request): Promise<string | null> {
    const sid = readCookie(req, COOKIE);
    const s = sid ? sessions.get(sid) : undefined;
    if (!s) return null;
    return s.personId === null ? ADMIN_SECRET_ACTOR : ((await people.getPerson(s.personId))?.name ?? null);
  }

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/session', asyncHandler(async (req, res) => {
    res.json({ enabled: opts.secret !== null, unlocked: opts.secret !== null && await sessionValid(req), version: serverVersion(), build: serverBuild() });
  }));

  // Admin is off without a token: the console is open to everyone who can reach it, so there is nothing to gate it with.
  router.use((_req, res, next) => {
    if (opts.secret === null) {
      res.status(403).json({ ok: false, error: 'Admin is off: the server is running without a token. Start it with one.' });
      return;
    }
    next();
  });

  // Cross-site protection: no CORS is offered, a change must carry a header a page on another site cannot add without a
  // preflight, and an Origin that is not this server is refused. The cookie is SameSite=Strict on top of that.
  router.use((req, res, next) => {
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
    if (!sameOrigin || req.get('x-podium-admin') !== '1') {
      res.status(403).json({ ok: false, error: 'cross-site request refused' });
      return;
    }
    next();
  });

  // The Activity history delete takes up to 200 session ids, so its own parser (below) has a larger limit.
  const STORED_DELETE = '/stored-activity/delete';
  const smallJson = jsonBody({ limit: '8kb' });
  router.use((req, res, next) => (req.path === STORED_DELETE ? next() : smallJson(req, res, next)));

  async function sessionValid(req: Request): Promise<boolean> {
    const sid = readCookie(req, COOKIE);
    if (!sid) return false;
    const s = sessions.get(sid);
    if (s === undefined) return false;
    // A session an administrator opened ends the moment they leave Administrators or their token is revoked.
    if (now() - s.last > idleMs || (s.personId !== null && !(await people.isAdministrator(s.personId)))) {
      sessions.delete(sid);
      return false;
    }
    // A lock that came in while the person was being read ends this session: do not put it back.
    if (!sessions.has(sid)) return false;
    sessions.delete(sid); // re-insert so the oldest entry is the least recently used, which is the one evicted at the cap
    sessions.set(sid, { last: now(), personId: s.personId });
    return true;
  }

  /** Opens a session for an Administrator (a person's id) or the admin secret (null), sets its cookie and logs it. */
  async function openSession(req: Request, res: Response, personId: number | null): Promise<void> {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
    const sid = randomBytes(32).toString('hex');
    sessions.set(sid, { last: now(), personId });
    res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'strict', path: '/api/admin', secure: req.secure });
    const person = personId === null ? undefined : await people.getPerson(personId);
    await audit(req, 'unlock','Admin unlocked', person ? { person_id: person.id } : {}, person ? person.name : ADMIN_SECRET_ACTOR);
    res.json({ ok: true });
  }

  router.post('/unlock', asyncHandler(async (req, res) => {
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
    // The admin secret with the name Admin, or the token of a person in Administrators with their name (issues #172, #215).
    // Both count toward the same lockout when wrong, and the answer never says which part was wrong.
    const found = await checkNameToken(people, opts.secret, name, token);
    // Wrong tries counted against this address while the person was being read: a lockout reached meanwhile refuses this one too, right or wrong.
    const lockedNow = lockout.lockedFor(src);
    if (lockedNow > 0) {
      res.status(429).json({ ok: false, error: 'too many wrong tries', retryAfterSec: Math.ceil(lockedNow / 1000) });
      return;
    }
    const administrator = found?.person && (await people.isAdministrator(found.person.id)) ? found.person : undefined;
    if (found && (administrator || found.person === null)) {
      lockout.succeed(src);
      opts.respondBridge?.release(req, administrator?.id ?? null); // the person just proved who they are, so the idle lock may let them back in (#272)
      await openSession(req, res, administrator?.id ?? null);
      return;
    }
    const { n, locked } = lockout.fail(src);
    await audit(req, 'unlock_failed', locked ? `Wrong name or token (${n}); locked for ${Math.round(lockout.lockMs / 60_000)} minutes` : `Wrong name or token (${n})`, { failures: n, locked });
    res.status(401).json({ ok: false, error: 'wrong name or token' });
  }));

  // A browser signed in to respond as an Administrator (or as Admin with the secret) opens Admin with no second sign-in (#215).
  router.post('/unlock/from-respond', asyncHandler(async (req, res) => {
    const administrator = (await opts.respondBridge?.administratorOf(req)) ?? null;
    if (!administrator) {
      res.status(401).json({ ok: false, error: 'not signed in as an Administrator' });
      return;
    }
    await openSession(req, res, administrator.personId);
  }));

  // Everything below needs an unlocked session.
  router.use(asyncHandler(async (req, res, next) => {
    if (await sessionValid(req)) return next();
    res.status(401).json({ ok: false, error: 'locked' });
  }));

  router.post('/lock', (req, res) => {
    const sid = readCookie(req, COOKIE);
    if (sid) sessions.delete(sid);
    opts.respondBridge?.hold(req); // a reload must not reopen Admin from the console sign-in (#272)
    res.clearCookie(COOKIE, { path: '/api/admin' });
    res.json({ ok: true });
  });

  const fail = (res: Response, err: unknown) => {
    if (err instanceof PeopleError) {
      res.status(err.code === 'duplicate' ? 409 : err.code === 'not_found' ? 404 : 400).json({ ok: false, error: err.message });
      return;
    }
    logger.error('request.failed', `podium: admin request failed: ${(err as Error).message}`, { route: '/api/admin', reason: (err as Error).message, status: 500 });
    res.status(500).json({ ok: false, error: 'failed' });
  };
  const groupNameOf = async (p: PersonRow) => (p.groupId === null ? null : ((await people.getGroup(p.groupId))?.name ?? null));
  const paging = (req: Request) => ({ page: Number(req.query.page), pageSize: Number(req.query.pageSize) });

  // ---- people ---------------------------------------------------------------------------------

  router.get('/people', asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const page = await people.list({ ...paging(req), q });
    // With TLS on each row also says its person's certificate (#587): the expiry the badge needs, never the key. Podium has none.
    const on = Boolean(certs?.people?.issuer());
    const rows = await Promise.all(page.rows.map(async (r) => ({ ...r, certificate: on ? await certificateOf(r.id) : null })));
    res.json({ ...page, rows, tls: on, groups: await people.allGroups() });
  }));

  /** The person's live certificate, or the latest revoked one, or null when they never had one. */
  async function certificateOf(personId: number): Promise<{ notBefore: string; notAfter: string; revoked: boolean } | null> {
    const all = (await certs?.people?.store.listFor(personId)) ?? [];
    const c = all.find((x) => x.revokedAt === null) ?? all[0];
    return c ? { notBefore: new Date(c.notBefore).toISOString(), notAfter: new Date(c.notAfter).toISOString(), revoked: c.revokedAt !== null } : null;
  }

  router.post('/people', asyncHandler(async (req, res) => {
    try {
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      const groupId = typeof req.body?.groupId === 'number' ? req.body.groupId : null;
      const { person, token } = await people.createPerson(name, groupId, now());
      await audit(req, 'person_created', `Added ${person.name}`, { person_id: person.id });
      const body: Record<string, unknown> = { ok: true, person: publicPerson(person, await groupNameOf(person)), token };
      // With TLS on the config file comes back here too, once. A failure to make it must not lose the token, which is also shown once.
      const issuer = certs?.people?.issuer();
      if (certs?.people && issuer) {
        try {
          body.config = await issueAndLog(req, person, certs.people.store, issuer);
        } catch (err) {
          const reason = (err as Error).message;
          logger.error('tls.issue_failed', `podium: could not issue a certificate to a new person: ${reason}`, { person_id: person.id, reason });
          body.configError = 'Podium could not make the certificate. Reissue the config from the person once the server log shows why.';
        }
      }
      res.status(201).json(body);
    } catch (err) {
      fail(res, err);
    }
  }));

  router.post('/people/:id/rotate', asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) return void res.status(400).json({ ok: false, error: 'bad id' });
    try {
      const out = await people.rotate(id, now());
      if (!out) return void res.status(404).json({ ok: false, error: 'unknown person' });
      await audit(req, 'token_rotated', `Rotated the token of ${out.person.name}`, { person_id: id });
      res.json({ ok: true, person: publicPerson(out.person, await groupNameOf(out.person)), token: out.token });
    } catch (err) {
      fail(res, err);
    }
  }));

  router.post('/people/:id/revoke', asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) return void res.status(400).json({ ok: false, error: 'bad id' });
    // One step: two Administrators revoked at once must not each find the other still active.
    let out: { p: PersonRow; certsRevoked: number; revoked: boolean } | null;
    try {
      out = await storage.tx(async () => {
        const p = await people.getPerson(id);
        if (!p) return null;
        await people.assertNotLastAdministrator(id);
        // Revoking the token revokes the person's certificate too, so a reporter cannot go on with the other credential (#583).
        const certsRevoked = (await certs?.people?.store.revokeFor(id, 'revoked', now())) ?? 0;
        return { p, certsRevoked, revoked: await people.revoke(id, now()) };
      });
    } catch (err) {
      if (err instanceof PeopleError) return fail(res, err);
      throw err;
    }
    if (!out) return void res.status(404).json({ ok: false, error: 'unknown person' });
    if (out.revoked) await audit(req, 'token_revoked', `Revoked the token of ${out.p.name}${out.certsRevoked > 0 ? ' and their certificate' : ''}`, { person_id: id, certificates_revoked: out.certsRevoked });
    res.json({ ok: true });
  }));

  // ---- people's certificates (#583) ---------------------------------------------------------------

  const certs = opts.certificates;
  const tlsOff = (res: Response) => void res.status(404).json({ ok: false, error: 'TLS is off' });

  /** Issues the person a certificate and logs it (the file's content never goes in the log). Returns the file for the response. */
  async function issueAndLog(req: Request, person: PersonRow, store: PersonCertsApi, issuer: PersonIssuer): Promise<ConfigFile & { expires: string; fingerprint: string }> {
    const { file, cert } = await issueConfigFor(person, store, issuer, req.get('host'), now());
    await audit(req, 'certificate_issued',`Issued a certificate to ${person.name}`, { person_id: person.id, fingerprint_sha256: cert.fingerprint, not_after: new Date(cert.notAfter).toISOString() });
    return { ...file, expires: new Date(cert.notAfter).toISOString(), fingerprint: cert.fingerprint };
  }

  /** The person and the certificate parts when TLS is on; otherwise it has already answered. */
  async function certTarget(req: Request, res: Response): Promise<{ person: PersonRow; store: PersonCertsApi; issuer: PersonIssuer } | null> {
    const c = certs?.people;
    const issuer = c?.issuer();
    if (!c || !issuer) {
      tlsOff(res);
      return null;
    }
    const id = idParam(typeof req.params.id === 'string' ? req.params.id : '');
    if (id === null) {
      res.status(400).json({ ok: false, error: 'bad id' });
      return null;
    }
    const person = await people.getPerson(id);
    if (!person) {
      res.status(404).json({ ok: false, error: 'unknown person' });
      return null;
    }
    return { person, store: c.store, issuer };
  }

  router.post('/people/:id/certificate/reissue', asyncHandler(async (req, res) => {
    const t = await certTarget(req, res);
    if (!t) return;
    try {
      const config = await issueAndLog(req, t.person, t.store, t.issuer);
      // A reissue brings a revoked person back; without it certAuth would refuse the new certificate.
      if (await people.restore(t.person.id)) await audit(req, 'person_restored', `Restored ${t.person.name} by reissuing their certificate`, { person_id: t.person.id });
      res.json({ ok: true, config });
    } catch (err) {
      logger.error('tls.issue_failed', `podium: could not issue a certificate: ${(err as Error).message}`, { person_id: t.person.id, reason: (err as Error).message });
      res.status(500).json({ ok: false, error: 'Podium could not make the certificate. The earlier one is still valid.' });
    }
  }));

  // Only the certificate: the person's token and console sign-in are unchanged, so no administrator is locked out by it.
  router.post('/people/:id/certificate/revoke', asyncHandler(async (req, res) => {
    const t = await certTarget(req, res);
    if (!t) return;
    const n = await t.store.revokeFor(t.person.id, 'revoked', now());
    if (n > 0) await audit(req, 'certificate_revoked', `Revoked the certificate of ${t.person.name}`, { person_id: t.person.id });
    res.json({ ok: true, revoked: n });
  }));

  router.post('/people/:id/revoke-all', asyncHandler(async (req, res) => {
    const t = await certTarget(req, res);
    if (!t) return;
    let out: { n: number; tokenRevoked: boolean };
    try {
      out = await storage.tx(async () => {
        await people.assertNotLastAdministrator(t.person.id);
        const n = await t.store.revokeFor(t.person.id, 'revoked', now());
        return { n, tokenRevoked: await people.revoke(t.person.id, now()) };
      });
    } catch (err) {
      if (err instanceof PeopleError) return fail(res, err);
      throw err;
    }
    if (out.n > 0 || out.tokenRevoked) await audit(req, 'revoked_all', `Revoked the certificate and the token of ${t.person.name}`, { person_id: t.person.id });
    res.json({ ok: true, revoked: out.n, tokenRevoked: out.tokenRevoked });
  }));

  // The public half only: the certificate and the CA, as a person could check or hand on. Never a key (Podium has none).
  router.get('/people/:id/certificate.pem', asyncHandler(async (req, res) => {
    const t = await certTarget(req, res);
    if (!t) return;
    const cert = await t.store.current(t.person.id);
    if (!cert) return void res.status(404).json({ ok: false, error: 'this person has no certificate' });
    res.type('application/x-pem-file').set('Content-Disposition', `attachment; filename="${fileSafe(t.person.name)}-certificate.pem"`).send(`${cert.certPem}${t.issuer.caCerts().join('')}`);
  }));

  // One route for one person or many (#243). All or nothing: a refusal deletes nobody.
  router.post('/people/delete', asyncHandler(async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BULK || ids.some((i) => !Number.isSafeInteger(i) || i < 1)) {
      return void res.status(400).json({ ok: false, error: `ids must be 1 to ${MAX_BULK} person ids` });
    }
    const sid = readCookie(req, COOKIE);
    const me = sid ? sessions.get(sid)?.personId : null;
    if (me != null && ids.includes(me)) {
      return void res.status(400).json({ ok: false, error: 'You are signed in to Admin as this person, so they cannot be deleted. Nothing was deleted.' });
    }
    try {
      const gone = await people.deleteMany(ids as number[]);
      if (gone.length === 0) return void res.status(404).json({ ok: false, error: 'unknown person' });
      for (const p of gone) await audit(req, 'person_deleted', `Deleted ${p.name}`, { person_id: p.id });
      res.json({ ok: true, removed: gone.length });
    } catch (err) {
      fail(res, err);
    }
  }));

  router.put('/people/:id/group', asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) return void res.status(400).json({ ok: false, error: 'bad id' });
    const raw = req.body?.groupId;
    if (raw !== null && typeof raw !== 'number') return void res.status(400).json({ ok: false, error: 'groupId must be a number or null' });
    // One step, so the group named in the entry is the one the person was moved to even if that group is deleted right after.
    const moved = await storage.tx(async () => {
      const p = await people.getPerson(id);
      if (!p || !(await people.setGroup(id, raw))) return null;
      return { p, group: raw === null ? null : await people.getGroup(raw) };
    });
    if (!moved) return void res.status(404).json({ ok: false, error: 'unknown person or group' });
    await audit(req, 'group_assigned', raw === null ? `${moved.p.name} moved to no group` : `${moved.p.name} moved to ${moved.group?.name}`, { person_id: id, group_id: raw });
    res.json({ ok: true });
  }));

  // ---- groups ---------------------------------------------------------------------------------

  router.get('/groups', asyncHandler(async (req, res) => {
    res.json(await people.listGroups(paging(req)));
  }));

  router.post('/groups', asyncHandler(async (req, res) => {
    try {
      const g = await people.createGroup(typeof req.body?.name === 'string' ? req.body.name : '', now());
      await audit(req, 'group_created', `Created the group ${g.name}`, { group_id: g.id });
      res.status(201).json({ ok: true, ...g });
    } catch (err) {
      fail(res, err);
    }
  }));

  router.delete('/groups/:id', asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) return void res.status(400).json({ ok: false, error: 'bad id' });
    const g = await people.getGroup(id);
    try {
      if (!g || !await people.deleteGroup(id)) return void res.status(404).json({ ok: false, error: 'unknown group' });
      await audit(req, 'group_deleted', `Deleted the group ${g.name}`, { group_id: id });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  }));

  // ---- reporters (#142) -----------------------------------------------------------------------

  const reporterKey = (v: string): string | null => (v.length >= 1 && v.length <= 150 ? v : null);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  router.get('/reporters', asyncHandler(async (req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    const dir = Number(req.query.dir);
    res.json({
      ...(await reporters.list({ ...paging(req), q: str(req.query.q), state: str(req.query.state), sort: str(req.query.sort), admin: req.query.admin === '1', dir: Number.isFinite(dir) && dir !== 0 ? dir : undefined }, now())),
      serverTime: now(),
    });
  }));

  // Bulk removal and ignore rules (issue #167). These come before `/reporters/:key`, which would take "ignores" for a key.
  const MAX_BULK = 500;
  const plural = (n: number) => `${n} reporter${n === 1 ? '' : 's'}`;

  router.post('/reporters/remove', asyncHandler(async (req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    const { keys, state, match } = (req.body ?? {}) as { keys?: unknown; state?: unknown; match?: unknown };
    let removed: number;
    if (match !== undefined) {
      // Every reporter a filter holds, which can be more than one page: what "select all that match" asks for.
      const m = match as { q?: unknown; state?: unknown; admin?: unknown };
      if (!m || typeof m !== 'object' || Array.isArray(m)) return void res.status(400).json({ ok: false, error: 'match must be a filter' });
      if (m.state !== undefined && m.state !== '' && !REPORTER_STATES.includes(m.state as ReporterState)) return void res.status(400).json({ ok: false, error: 'match.state is not a reporter state' });
      // The filter and the removal are one step, so a reporter that has stopped matching by then is not taken.
      removed = await storage.tx(async () => reporters.removeMany(await reporters.keys({ q: str(m.q), state: str(m.state), admin: m.admin === true }, now())));
    } else if (Array.isArray(keys)) {
      if (keys.length < 1 || keys.length > MAX_BULK || keys.some((k) => typeof k !== 'string' || reporterKey(k) === null)) {
        return void res.status(400).json({ ok: false, error: `keys must be 1 to ${MAX_BULK} reporter keys` });
      }
      removed = await reporters.removeMany(keys as string[]);
    } else if (typeof state === 'string' && REPORTER_STATES.includes(state as ReporterState)) {
      removed = await reporters.removeState(state as ReporterState, now());
    } else {
      return void res.status(400).json({ ok: false, error: 'give keys, a state or a match' });
    }
    await audit(req, 'reporter_removed', `Removed ${plural(removed)} from the list`, { count: removed });
    res.json({ ok: true, removed });
  }));

  router.get('/reporters/ignores', asyncHandler(async (_req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    res.json({ rules: await reporters.listIgnores() });
  }));

  router.post('/reporters/ignores', asyncHandler(async (req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    const { kind, pattern } = (req.body ?? {}) as { kind?: unknown; pattern?: unknown };
    if (typeof kind !== 'string' || typeof pattern !== 'string') return void res.status(400).json({ ok: false, error: 'give a kind and a pattern' });
    try {
      // `removed` is the drop in the list across the add, so the count and the add are one step: another change must not land between.
      const { rule, removed } = await storage.tx(async () => {
        const before = (await reporters.list({}, now())).counts.all;
        const added = await reporters.addIgnore(kind as IgnoreKind, pattern, now());
        return { rule: added, removed: before - (await reporters.list({}, now())).counts.all };
      });
      await audit(req, 'reporter_ignore_added', `Ignoring reporters whose ${rule.kind} matches ${rule.pattern}; ${plural(removed)} removed from the list`, { rule: rule.id });
      res.json({ ok: true, rule, removed });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }));

  router.delete('/reporters/ignores/:id', asyncHandler(async (req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    const id = Number(req.params.id);
    const rule = Number.isInteger(id) ? (await reporters.listIgnores()).find((r) => r.id === id) : undefined;
    if (!rule || !await reporters.removeIgnore(id)) return void res.status(404).json({ ok: false, error: 'unknown rule' });
    await audit(req, 'reporter_ignore_removed', `Stopped ignoring reporters whose ${rule.kind} matches ${rule.pattern}`, { rule: id });
    res.json({ ok: true });
  }));

  router.get('/reporters/:key', asyncHandler(async (req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    const key = reporterKey(req.params.key);
    if (key === null) return void res.status(400).json({ ok: false, error: 'bad key' });
    const d = await reporters.get(key, now(), paging(req));
    if (!d) return void res.status(404).json({ ok: false, error: 'unknown reporter' });
    res.json({ ...d, serverTime: now() });
  }));

  // Orchestrator messaging on Admin > Reporters > a reporter (#347). A change is a proposal the owner must accept;
  // Pause all links and a removal apply at once. Each is logged through the messaging trail, with this Admin as actor.
  const peerActor = async (req: Request): Promise<Actor> => ({ name: (await actorOf(req)) ?? ADMIN_SECRET_ACTOR, admin: true });
  const peerFail = (res: Response, out: Refusal) => res.status(out.status).json({ ok: false, error: out.error });
  const withPeerSource = <T>(req: Request, fn: () => T): T => (peers ? peers.withSource(sourceOf(req), fn) : fn());

  router.get('/reporters/:key/peers', asyncHandler(async (req, res) => {
    const view = peers ? await peers.adminView(req.params.key) : null;
    if (!view) return void res.status(404).json({ ok: false, error: 'unknown reporter' });
    res.json(view);
  }));

  router.post('/reporters/:key/peers/propose', asyncHandler(async (req, res) => {
    if (!peers) return void res.status(404).json({ ok: false, error: 'not available' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const from = typeof b.from === 'string' ? b.from : req.params.key;
    if (typeof b.to !== 'string' || !(PEER_LEVELS as readonly unknown[]).includes(b.level)) return void res.status(400).json({ ok: false, error: 'to must be a reporter key, level one of none, see, ask, send' });
    if (from !== req.params.key && b.to !== req.params.key) return void res.status(400).json({ ok: false, error: 'a proposal on this page must involve this reporter' });
    const actor = await peerActor(req);
    const out = await withPeerSource(req, () => peers.rights.propose(from, b.to as string, b.level as PeerLevel, actor));
    if (!out.ok) return void peerFail(res, out);
    res.status(202).json({ ok: true, requestId: out.request.id });
  }));

  router.put('/reporters/:key/peers/pause', asyncHandler(async (req, res) => {
    if (!peers) return void res.status(404).json({ ok: false, error: 'not available' });
    const paused = (req.body as { paused?: unknown } | undefined)?.paused;
    if (typeof paused !== 'boolean') return void res.status(400).json({ ok: false, error: 'paused must be true or false' });
    const actor = await peerActor(req);
    const out = await withPeerSource(req, () => peers.rights.pauseReporter(req.params.key, paused, actor));
    if (!out.ok) return void peerFail(res, out);
    res.json(out);
  }));

  router.delete('/reporters/:key/peers/:other', asyncHandler(async (req, res) => {
    if (!peers) return void res.status(404).json({ ok: false, error: 'not available' });
    const actor = await peerActor(req);
    const out = await withPeerSource(req, () => peers.removeLink(null, req.params.key, req.params.other, actor));
    if (!out.ok) return void peerFail(res, out);
    res.json(out);
  }));

  router.get('/peers/conversations', asyncHandler(async (req, res) => {
    if (!peers) return void res.status(404).json({ ok: false, error: 'not available' });
    // As the browser's read (SPEC 7.1): `live` is the default.
    const range = rangeOf(req.query.range, now());
    if (!range) return void res.status(400).json({ ok: false, error: 'range must be live, 24h or 30d' });
    res.json({ conversations: await peers.messages.conversations(range) });
  }));

  router.get('/peers/conversations/:a/:b', asyncHandler(async (req, res) => {
    if (!peers) return void res.status(404).json({ ok: false, error: 'not available' });
    const rows = await peers.messages.conversation(req.params.a, req.params.b);
    if (!rows.length) return void res.status(404).json({ ok: false, error: 'no such conversation' });
    res.json({ messages: rows.map(messageView) });
  }));

  router.delete('/reporters/:key', asyncHandler(async (req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    const key = reporterKey(req.params.key);
    if (key === null) return void res.status(400).json({ ok: false, error: 'bad key' });
    const d = await reporters.get(key, now());
    if (!d || !await reporters.remove(key)) return void res.status(404).json({ ok: false, error: 'unknown reporter' });
    await audit(req, 'reporter_removed', `Removed the reporter ${d.name} from the list`, { reporter: key });
    res.json({ ok: true });
  }));

  // ---- settings and log -----------------------------------------------------------------------

  const history = opts.activityHistory;
  const activityState = async (h: NonNullable<typeof history>): Promise<ActivityHistoryState> => ({ settings: h.settings.get(), totals: await h.history.totals(), lastPurge: h.history.lastPurge, authOn: opts.secret !== null });

  const rec = opts.recordings;
  const recordingState = async (r: NonNullable<typeof rec>) => ({ settings: r.settings.get(), totals: await r.service.totals(), authOn: opts.secret !== null });

  const featureList = () => FEATURES.map(({ defaultOn, ...f }) => ({ ...f, on: features ? features.featureOn(f.id) : defaultOn }));
  const noticeList = () => NOTICES.map((n) => ({ ...n, on: wall ? wall.noticeOn(n.id) : true }));

  router.get('/settings', asyncHandler(async (_req, res) => {
    res.json({
      allowAdminSecretReporting: await people.adminReportingAllowed(),
      features: featureList(),
      notices: noticeList(),
      showBackgroundSessions: wall?.showBackgroundSessions() ?? false,
      cardTitleMachine: wall?.cardTitleMachine() ?? false,
      modelPrices: prices?.view() ?? { asOf: PRICES_AS_OF, models: [] },
      forgetReporters: (await reporters?.forgetSetting()) ?? { enabled: false, days: 30 },
      ...(peers ? { peerMessaging: await peers.settings.get() } : {}),
      ...(history ? { activityHistory: await activityState(history) } : {}),
      ...(rec ? { recording: await recordingState(rec) } : {}),
    });
  }));

  // One setting per call: allowAdminSecretReporting, showBackgroundSessions, cardTitleMachine, features ({ id: boolean }), notices ({ id: boolean }),
  // modelPrice ({ key, std, long? }: one model's prices) or resetModelPrice (a key).
  router.put('/settings', asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    if ('allowAdminSecretReporting' in body) {
      const v = body.allowAdminSecretReporting;
      if (typeof v !== 'boolean') return void res.status(400).json({ ok: false, error: 'allowAdminSecretReporting must be true or false' });
      await people.setAdminReporting(v);
      await audit(req, 'admin_reporting_changed', `Reporting with the admin secret turned ${v ? 'on' : 'off'}`, { on: v });
      return void res.json({ ok: true, allowAdminSecretReporting: v });
    }
    if ('forgetReporters' in body) {
      const f = body.forgetReporters;
      const okShape = f && typeof f === 'object' && !Array.isArray(f) && ('enabled' in f || 'days' in f) && (f.enabled === undefined || typeof f.enabled === 'boolean');
      if (!reporters || !okShape) return void res.status(400).json({ ok: false, error: 'forgetReporters must give enabled (true or false) and/or days' });
      // The change and the read-back are one step, so the answer and the entry show this change and not a later one.
      let now_: ForgetSetting;
      try {
        now_ = await storage.tx(async () => {
          await reporters.setForgetSetting({ enabled: f.enabled, days: f.days });
          return reporters.forgetSetting();
        });
      } catch (err) {
        return void res.status(400).json({ ok: false, error: (err as Error).message });
      }
      await audit(req, 'reporters_forget_changed', now_.enabled ? `Forgetting reporters not heard from for ${now_.days} days turned on` : 'Forgetting reporters by age turned off', { on: now_.enabled, days: now_.days });
      return void res.json({ ok: true, forgetReporters: now_ });
    }
    if ('peerMessaging' in body) {
      const p = body.peerMessaging;
      if (!peers || !p || typeof p !== 'object' || Array.isArray(p)) return void res.status(400).json({ ok: false, error: 'peerMessaging must give roundTrips, perMinute, maxChars and/or retainDays' });
      const out = await peers.settings.set(p);
      if (!out.ok) return void res.status(400).json({ ok: false, error: out.error });
      const v = out.settings;
      await audit(req, 'peer_limits_changed', `Orchestrator messaging limits: ${v.roundTrips} round trips, ${v.perMinute} a minute, ${v.maxChars} characters, kept ${v.retainDays} days`, { ...v });
      return void res.json({ ok: true, peerMessaging: v });
    }
    if ('activityHistory' in body) {
      const p = body.activityHistory;
      if (!history || !p || typeof p !== 'object' || Array.isArray(p)) return void res.status(400).json({ ok: false, error: 'activityHistory must give policy, n, unit and capGb' });
      const out = await history.settings.set(p);
      if (!out.ok) return void res.status(400).json({ ok: false, error: out.error });
      await audit(req, ACTIVITY_LOG_KINDS.changed, `Activity history set to ${policyWords(out.settings)}, ${capWords(out.settings)}`, { ...out.settings });
      opts.onActivityHistoryChanged?.();
      return void res.json({ ok: true, activityHistory: await activityState(history) });
    }
    if ('recording' in body) {
      const p = body.recording;
      if (!rec || !p || typeof p !== 'object' || Array.isArray(p)) return void res.status(400).json({ ok: false, error: 'recording must give keepHours, budgetMb and/or sessionMb' });
      const out = await rec.settings.set(p);
      if (!out.ok) return void res.status(400).json({ ok: false, error: out.error });
      const { before: b, settings: a } = out;
      await audit(req, 'recording_settings_changed', `Session recording limits: kept ${b.keepHours} to ${a.keepHours} hours, disk budget ${b.budgetMb} to ${a.budgetMb} MB, one session ${b.sessionMb} to ${a.sessionMb} MB`, {
        keep_hours_before: b.keepHours,
        keep_hours: a.keepHours,
        budget_mb_before: b.budgetMb,
        budget_mb: a.budgetMb,
        session_mb_before: b.sessionMb,
        session_mb: a.sessionMb,
      });
      return void res.json({ ok: true, recording: await recordingState(rec) });
    }
    if ('showBackgroundSessions' in body) {
      const v = body.showBackgroundSessions;
      if (typeof v !== 'boolean' || !wall) return void res.status(400).json({ ok: false, error: 'showBackgroundSessions must be true or false' });
      await wall.setShowBackgroundSessions(v);
      await audit(req, 'wall_background_changed', `Background sessions ${v ? 'shown' : 'hidden'} on the wall`, { on: v });
      return void res.json({ ok: true, showBackgroundSessions: v });
    }
    if ('cardTitleMachine' in body) {
      const v = body.cardTitleMachine;
      if (typeof v !== 'boolean' || !wall) return void res.status(400).json({ ok: false, error: 'cardTitleMachine must be true or false' });
      await wall.setCardTitleMachine(v);
      await audit(req, 'wall_card_title_changed', `Cards ${v ? 'titled with the machine and the session' : 'titled with the session name alone'}`, { on: v });
      return void res.json({ ok: true, cardTitleMachine: v });
    }
    if ('features' in body) {
      const f = body.features;
      const ids = f && typeof f === 'object' && !Array.isArray(f) ? Object.keys(f) : [];
      if (!features || ids.length === 0 || ids.some((id) => !isFeatureId(id) || typeof f[id] !== 'boolean')) {
        return void res.status(400).json({ ok: false, error: 'features must map known feature ids to true or false' });
      }
      for (const id of ids) {
        const changed = await features.turn(id, f[id]);
        await audit(req, 'feature_changed', `Feature ${id} turned ${f[id] ? 'on' : 'off'}`, { setting: id, on: f[id] });
        if (id === RESPOND && f[id] && changed) opts.onRespondOn?.(); // after the audit row, so a failing warning cannot lose it
      }
      return void res.json({ ok: true, features: featureList() });
    }
    if ('notices' in body) {
      const n = body.notices;
      const ids = n && typeof n === 'object' && !Array.isArray(n) ? Object.keys(n) : [];
      if (!wall || ids.length === 0 || ids.some((id) => !isNoticeId(id) || typeof n[id] !== 'boolean')) {
        return void res.status(400).json({ ok: false, error: 'notices must map known notice ids to true or false' });
      }
      for (const id of ids) {
        await wall.setNotice(id, n[id]);
        await audit(req, 'wall_notice_changed', `Wall notice ${id} turned ${n[id] ? 'on' : 'off'}`, { setting: id, on: n[id] });
      }
      return void res.json({ ok: true, notices: noticeList() });
    }
    if ('modelPrice' in body) {
      const m = body.modelPrice;
      if (!prices || !m || typeof m !== 'object' || typeof m.key !== 'string') {
        return void res.status(400).json({ ok: false, error: 'modelPrice must name a model and give its prices' });
      }
      const before = JSON.stringify(prices.overrides());
      const err = await prices.set(m.key, { std: m.std, ...(m.long === undefined || m.long === null ? {} : { long: m.long }) });
      if (err) return void res.status(400).json({ ok: false, error: err });
      // Saving the values a row already has changes nothing, so it is not logged as a change.
      if (JSON.stringify(prices.overrides()) === before) return void res.json({ ok: true, modelPrices: prices.view() });
      const k = m.key.trim().toLowerCase();
      const p = m.std as PriceSet;
      await audit(
        req,
        'model_price_changed',
        `Set the price of ${k} per million tokens: input ${p.input}, output ${p.output}, cache read ${p.cacheRead}, cache write ${p.cacheWrite}, 1-hour cache write ${p.cacheWrite1h}` +
          (m.long ? ` (prompts over 100,000 tokens: input ${m.long.input}, output ${m.long.output})` : ''),
        { model: k },
      );
      return void res.json({ ok: true, modelPrices: prices.view() });
    }
    if ('resetModelPrice' in body) {
      const k = body.resetModelPrice;
      if (!prices || typeof k !== 'string' || !k.trim()) return void res.status(400).json({ ok: false, error: 'resetModelPrice must name a model' });
      const had = JSON.stringify(prices.overrides());
      await prices.reset(k);
      if (JSON.stringify(prices.overrides()) === had) return void res.json({ ok: true, modelPrices: prices.view() });
      await audit(req, 'model_price_reset', `Reset the price of ${k.trim().toLowerCase()} to the built-in value`, { model: k.trim().toLowerCase() });
      return void res.json({ ok: true, modelPrices: prices.view() });
    }
    res.status(400).json({ ok: false, error: 'no known setting in the request' });
  }));

  // ---- Activity history (#432) ----------------------------------------------------------------

  // The store's heavy calls are async (they work in chunks). Express 4 does not catch a rejected promise, so a failure answers here.
  const storeFailed = (res: Response) => () => void res.status(500).json({ ok: false, error: 'could not reach the stored activity' });

  router.post('/activity-history/preview', (req, res) => {
    if (!history) return void res.status(404).json({ ok: false, error: 'not available' });
    const s = parseSettings((req.body as { settings?: unknown } | undefined)?.settings, opts.secret !== null);
    if (!s.ok) return void res.status(400).json({ ok: false, error: s.error });
    history.history.preview(s.value).then((out) => void res.json(out), storeFailed(res));
  });

  router.get('/stored-activity', asyncHandler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const paging = parsePaging(q);
    if (!paging.ok) return void res.status(400).json({ ok: false, error: paging.error });
    const filter = parseFilter(q);
    if (!filter.ok) return void res.status(400).json({ ok: false, error: filter.error });
    // Source = Recordings (#353): the same page over the recordings, in the same file.
    if (filter.value.source === 'recordings') {
      if (!rec) return void res.status(404).json({ ok: false, error: 'not available' });
      const out = await rec.service.listStored(filter.value, paging.value.page, paging.value.pageSize);
      return void res.json({ ...out, totals: { ...out.totals, fileBytes: (await history?.history.totals())?.fileBytes ?? 0 } });
    }
    if (!history) return void res.status(404).json({ ok: false, error: 'not available' });
    history.history.list(filter.value, paging.value.page, paging.value.pageSize).then((out) => void res.json(out), storeFailed(res));
  }));

  const how = (b: StoredDeleteBody) => ('ids' in b ? 'ticked sessions' : 'match' in b ? 'a filter' : 'everything');
  const deletedWords = (r: StoredDeleteResult, b: StoredDeleteBody) => `Deleted ${countWords(r.entries, 'entry', 'entries')} (${sizeText(r.bytes)}) from ${countWords(r.sessions, 'session', 'sessions')}, chosen: ${how(b)}`;

  /** A recording removed by the Admin, written to the Admin log with the Admin as the one who did it and never any text. */
  const recordingDeleted = (req: Request, g: { sessionId: string; name: string; entries: number; bytes: number }) =>
    audit(req, 'recording_deleted', `Deleted the recording of ${g.name} (${g.sessionId.slice(0, 8)}): ${countWords(g.entries, 'entry', 'entries')}, ${sizeText(g.bytes)}`, { session_id: g.sessionId, entries: g.entries, bytes: g.bytes });
  /** Who the mark of a recording the Admin stopped names: the administrator, or `Admin` for the admin secret. */
  const adminName = async (req: Request): Promise<string> => {
    const who = await actorOf(req);
    return who === null || who === ADMIN_SECRET_ACTOR ? 'Admin' : who;
  };

  router.post(STORED_DELETE, jsonBody({ limit: '64kb' }), asyncHandler(async (req, res) => {
    const body = parseDeleteBody(req.body);
    if (!body.ok) return void res.status(400).json({ ok: false, error: body.error });
    if (('match' in body.value ? body.value.match.source : body.value.source) === 'recordings') {
      if (!rec) return void res.status(404).json({ ok: false, error: 'not available' });
      rec.service.removeFor(body.value).then(async (out) => {
        for (const g of out.each) {
          await recordingDeleted(req, g);
          rec.changed(g.sessionId);
        }
        res.json({ entries: out.entries, sessions: out.sessions, bytes: out.bytes, freed: out.freed });
      }).catch(storeFailed(res));
      return;
    }
    if (!history) return void res.status(404).json({ ok: false, error: 'not available' });
    history.history.deleteBy(body.value).then(async (out) => {
      await audit(req, ACTIVITY_LOG_KINDS.deleted, deletedWords(out, body.value), { entries: out.entries, sessions: out.sessions, bytes: out.bytes, chosen: how(body.value) });
      res.json(out);
    }).catch(storeFailed(res));
  }));

  // ---- certificates (#577) -----------------------------------------------------------------------

  /** Reporters over HTTP (#589): the switch, and how many reporters are on HTTP now out of all that reported lately. */
  const httpView = () => ({ allow: certs?.settings.allowReportersOverHttp() ?? true, ...(certs?.transport?.count(now()) ?? { overHttp: 0, total: 0 }) });

  /** The renewer's view with the overlap's count of reporters still on the old CA (#588). */
  const certificatesView = async (r: ServingRenewer) => {
    const v = { ...r.view(), overlapDays: CROSS_DAYS, canOverlap: certs?.rotation?.()?.canOverlap() ?? true, http: httpView() };
    if (!v.rotation) return v;
    const oldFp = v.rotation.previousCa.fingerprintSha256;
    const counts = await certs?.people?.store.reportersByIssuer(now());
    return { ...v, rotation: { ...v.rotation, reporters: { onOldCa: counts?.byIssuer[oldFp] ?? 0, total: counts?.total ?? 0 } } };
  };

  router.get('/certificates', asyncHandler(async (_req, res) => {
    const r = certs?.renewer();
    if (!r) return tlsOff(res);
    res.json({ ok: true, ...(await certificatesView(r)), reporter: certs?.settings.getReporter() });
  }));

  // The CA certificate to download, for a browser or a person who wants to check it (T8). It sits behind the unlocked Admin session like the rest of this page; there is no key to send.
  router.get('/certificates/ca.pem', (_req, res) => {
    const r = certs?.renewer();
    if (!r) return tlsOff(res);
    const pem = r.caPem();
    if (!pem) return void res.status(404).json({ ok: false, error: 'no CA certificate' });
    res.type('application/x-pem-file').set('Content-Disposition', 'attachment; filename="podium-ca.pem"').send(pem);
  });

  // Flat body keyed as in SPEC 6: { "tls.serving.lifetimeDays": 90, "tls.serving.renewBeforeDays": 30 }.
  router.put('/certificates', asyncHandler(async (req, res) => {
    const r = certs?.renewer();
    if (!certs || !r) return tlsOff(res);
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return void res.status(400).json({ ok: false, error: 'give the settings to change, such as tls.serving.renewBeforeDays' });
    const out = await certs.settings.set(body as Record<string, unknown>);
    if (!out.ok) return void res.status(400).json({ ok: false, error: out.error });
    const s = out.settings;
    const rep = certs.settings.getReporter();
    const http = httpView();
    if (out.changed.includes(ALLOW_HTTP_KEY) && http.allow !== out.wasAllowed) {
      await audit(req, 'tls_http_changed', http.allow ? 'Allowed reporters to connect over HTTP' : `Stopped allowing reporters over HTTP; ${http.overHttp} reporter${http.overHttp === 1 ? '' : 's'} connected over HTTP ${http.overHttp === 1 ? 'is' : 'are'} refused`, { allow: http.allow, reporters_on_http: http.overHttp });
    }
    if (out.changed.some((k) => k !== ALLOW_HTTP_KEY)) await audit(req, 'tls_settings_changed', `Certificate settings: serving certificate lifetime ${s.lifetimeDays} days, renewed ${s.renewBeforeDays} days before it expires; a person's certificate lifetime ${rep.lifetimeDays} days; header countdown ${s.headerCountdown ? 'on' : 'off'}`, { changed: out.changed.join(','), lifetime_days: s.lifetimeDays, renew_before_days: s.renewBeforeDays, reporter_lifetime_days: rep.lifetimeDays, header_countdown: s.headerCountdown });
    res.json({ ok: true, ...r.view(), reporter: rep, http });
  }));

  router.post('/certificates/renew', asyncHandler(async (req, res) => {
    const r = certs?.renewer();
    if (!r) return tlsOff(res);
    void r.renewNow().then(async (out) => {
      if (!out.ok) {
        await audit(req, 'tls_serving_renew_failed', 'Renewing the serving certificate failed', {});
        return void res.status(500).json({ ok: false, error: out.error, ...r.view() });
      }
      await audit(req, 'tls_serving_renewed', 'Renewed the serving certificate', { not_after: out.serving.notAfter });
      res.json({ ok: true, ...r.view() });
    }).catch(() => void res.status(500).json({ ok: false, error: 'could not renew the serving certificate' }));
  }));

  // Rotate the CA. `{ endOverlap: false }` is the planned rotation with an overlap, `{ endOverlap: true }` the hard cutover after a leaked key (#588).
  router.post('/certificates/rotate-ca', asyncHandler(async (req, res) => {
    const r = certs?.renewer();
    const rot = certs?.rotation?.();
    if (!r || !rot) return tlsOff(res);
    const body: unknown = req.body;
    const endOverlap = body && typeof body === 'object' ? (body as { endOverlap?: unknown }).endOverlap : undefined;
    if (typeof endOverlap !== 'boolean') return void res.status(400).json({ ok: false, error: 'say whether to end the overlap now: { "endOverlap": true | false }' });
    void rot.rotate(endOverlap).then(async (out) => {
      await audit(req, 'tls_ca_rotated', endOverlap ? 'Rotated the certificate authority and ended the overlap: every reporter needs a reissued config' : 'Rotated the certificate authority; the old one stays trusted until it is retired', { overlap: out.overlap, connections_closed: out.closed, ca_not_after: out.ca.notAfter });
      res.json({ ok: true, ...(await certificatesView(r)), reporter: certs?.settings.getReporter() });
    }).catch((err: unknown) => {
      // A TlsError says what is wrong in words the Admin can use; anything else is not shown.
      if (err instanceof TlsError) return void res.status(409).json({ ok: false, error: err.message });
      res.status(500).json({ ok: false, error: 'could not rotate the certificate authority' });
    });
  }));

  // Retire the old CA once no reporter needs it. The reply names how many were still on it (#588).
  router.post('/certificates/retire-ca', asyncHandler(async (req, res) => {
    const r = certs?.renewer();
    const rot = certs?.rotation?.();
    if (!r || !rot) return tlsOff(res);
    const before = (await certificatesView(r)).rotation;
    void rot.retire().then(async (out) => {
      if (!out || !before) return void res.status(409).json({ ok: false, error: 'there is no old CA to retire' });
      const refused = 'reporters' in before ? before.reporters.onOldCa : 0;
      await audit(req, 'tls_ca_retired', `Retired the old certificate authority; ${refused} reporter${refused === 1 ? '' : 's'} still used it and now need a reissued config`, { reporters_refused: refused, connections_closed: out.closed });
      res.json({ ok: true, refused, connectionsClosed: out.closed, ...(await certificatesView(r)), reporter: certs?.settings.getReporter() });
    }).catch(() => void res.status(500).json({ ok: false, error: 'could not retire the old certificate authority' }));
  }));

  // ---- Session recording (#353) ---------------------------------------------------------------

  const RECORDING_STATES_LISTED = ['recording', 'stopped', 'limit'] as const;

  router.get('/recordings', asyncHandler(async (req, res) => {
    if (!rec) return void res.status(404).json({ ok: false, error: 'not available' });
    const q = req.query as Record<string, unknown>;
    const paging = parsePaging(q);
    if (!paging.ok) return void res.status(400).json({ ok: false, error: paging.error });
    const state = q.state === undefined || q.state === '' ? undefined : (RECORDING_STATES_LISTED as readonly unknown[]).find((s) => s === q.state);
    if (q.state !== undefined && q.state !== '' && state === undefined) return void res.status(400).json({ ok: false, error: `state must be one of ${RECORDING_STATES_LISTED.join(', ')}` });
    if (q.q !== undefined && (typeof q.q !== 'string' || q.q.length > 200)) return void res.status(400).json({ ok: false, error: 'q must be text of at most 200 characters' });
    res.json(await rec.service.adminList({ ...paging.value, state: state as Exclude<RecordingState, 'off'> | undefined, q: q.q as string | undefined }));
  }));

  router.post('/recordings/:sessionId/stop', asyncHandler(async (req, res) => {
    if (!rec) return void res.status(404).json({ ok: false, error: 'not available' });
    const sid = req.params.sessionId;
    const out = await rec.service.stop(sid, await adminName(req));
    if (!out) return void res.status(404).json({ ok: false, error: 'this session has no recording' });
    if (out.changed) {
      await audit(req, 'recording_stopped', `Stopped the recording of ${sid.slice(0, 8)}`, { session_id: sid });
      rec.changed(sid);
    }
    res.json({ ok: true, grant: out.grant });
  }));

  router.delete('/recordings/:sessionId', asyncHandler(async (req, res) => {
    if (!rec) return void res.status(404).json({ ok: false, error: 'not available' });
    const sid = req.params.sessionId;
    if (!(await rec.service.has(sid))) return void res.status(404).json({ ok: false, error: 'this session has no recording' });
    rec.service.removeMany([sid]).then(async (out) => {
      for (const g of out.each) await recordingDeleted(req, g);
      rec.changed(sid);
      res.json({ ok: true, entries: out.entries, bytes: out.bytes });
    }).catch(storeFailed(res));
  }));

  if (opts.reports) router.use('/reports', createReportRouter(opts.reports));

  router.get('/log', asyncHandler(async (req, res) => {
    res.json({ ...(await people.listLog(paging(req))), ...(opts.logRetainMs === undefined ? {} : { retainMs: opts.logRetainMs }) });
  }));

  router.use((err: Error & { type?: string }, req: Request, res: Response, _next: NextFunction) => {
    void _next;
    // A body the parser refused is the client's. Anything else reached here from a handler that rejected (a store that failed, say) and
    // is answered the same way, but it is logged, or the failure would leave no trace.
    if (!(err instanceof SyntaxError) && !err.type?.startsWith('entity.')) {
      logger.error('request.failed', `podium: admin request failed: ${err.message}`, { route: `${req.baseUrl}${req.path}`, method: req.method, reason: err.message, status: 400 });
    }
    res.status(400).json({ ok: false, error: err instanceof SyntaxError ? 'bad JSON' : 'bad request' });
  });

  return router;
}
