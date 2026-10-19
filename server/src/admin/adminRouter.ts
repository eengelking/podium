// The Admin API, mounted at /api/admin (issue #36). Opened with the admin secret (PODIUM_TOKEN); after that a random session id
// lives in an HttpOnly, SameSite=Strict cookie and in this process's memory only. A restart, a secret rotation (which needs a
// restart) or ten idle minutes ends it. Nothing here ever returns, logs or stores a token or the secret: a token is shown once,
// in the response that creates or rotates it.
import { randomBytes } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { ADMIN_SECRET_ACTOR, PeopleError, sourceAddress, type PeopleStore, type PersonRow } from '../fleet/people.js';
import { checkNameToken } from '../fleet/nameToken.js';
import type { RespondBridge } from '../fleet/respondBridge.js';
import { serverBuild } from '../fleet/build.js';
import { serverVersion } from '../fleet/compat.js';
import { NOTICES, isNoticeId, type WallSettings } from '../fleet/wallSettings.js';
import type { ModelPriceStore } from '../fleet/modelPrices.js';
import { REPORTER_STATES, type IgnoreKind, type ReporterState, type ReporterStore } from '../fleet/reporters.js';
import { FEATURES, isFeatureId, RESPOND, type FeatureFlags } from '../fleet/featureFlags.js';
import { PRICES_AS_OF, type PriceSet } from '../fleet/pricing.js';
import { Lockout } from '../fleet/lockout.js';
import type { PeerService } from '../fleet/peers.js';
import { messageView } from '../fleet/peerRoutes.js';
import { PEER_LEVELS, type PeerLevel } from '../fleet/protocol.js';
import type { Actor, Refusal } from '../fleet/peerTypes.js';
import { createLogger, loggerFromLine, type Fields, type Logger } from '../logging/logger.js';

export interface AdminRouterOptions {
  /** The admin secret. null when the server runs without authentication: Admin is then switched off. */
  secret: string | null;
  people: PeopleStore;
  /** The wall's notice switches. Without it the Settings tab has nothing to change. */
  wall?: WallSettings;
  /** The Admin's model prices (issue #117). Without it the Model prices group has nothing to change. */
  prices?: ModelPriceStore;
  /** The server-wide feature flags (#118). Without it the Feature flags group has nothing to change. */
  features?: FeatureFlags;
  /** Every reporter the server has heard from (#142). Without it the Reporters tab has nothing to list. */
  reporters?: ReporterStore;
  /** Orchestrator messaging (#347): the limits, a reporter's links, proposals, Pause all links and the conversations. */
  peers?: PeerService;
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
  /** How long the admin log is kept (#303); `GET /log` reports it so the Admin page can say so. */
  logRetainMs?: number;
  /** The server's logger (#140): each Admin change is an `admin.<action>` event with the source address. */
  logger?: Logger;
  /** A plain line sink, kept for callers from before the logger. */
  log?: (line: string) => void;
}

const COOKIE = 'podium_admin';
const MAX_SESSIONS = 20;

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
  const { people, wall, prices, features, reporters, peers } = opts;
  const now = opts.now ?? Date.now;
  const idleMs = opts.idleMs ?? 10 * 60_000;
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
  const audit = (req: Request, kind: string, detail: string, fields: Fields = {}, actor: string | null = actorOf(req)) => {
    const src = sourceOf(req);
    people.log(kind, detail, src, now(), actor);
    logger.log(kind === 'unlock_failed' ? 'warn' : 'info', `admin.${kind}`, `podium: admin ${kind.replace(/_/g, ' ')} from ${src}`, { action: kind, source: src, ...fields });
  };

  /** Who an unlocked request is from: the administrator's name, or the admin secret. Null when there is no open session. */
  function actorOf(req: Request): string | null {
    const sid = readCookie(req, COOKIE);
    const s = sid ? sessions.get(sid) : undefined;
    if (!s) return null;
    return s.personId === null ? ADMIN_SECRET_ACTOR : (people.getPerson(s.personId)?.name ?? null);
  }

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/session', (req, res) => {
    res.json({ enabled: opts.secret !== null, unlocked: opts.secret !== null && sessionValid(req), version: serverVersion(), build: serverBuild() });
  });

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

  router.use(express.json({ limit: '8kb' }));

  function sessionValid(req: Request): boolean {
    const sid = readCookie(req, COOKIE);
    if (!sid) return false;
    const s = sessions.get(sid);
    if (s === undefined) return false;
    // A session an administrator opened ends the moment they leave Administrators or their token is revoked.
    if (now() - s.last > idleMs || (s.personId !== null && !people.isAdministrator(s.personId))) {
      sessions.delete(sid);
      return false;
    }
    sessions.delete(sid); // re-insert so the oldest entry is the least recently used, which is the one evicted at the cap
    sessions.set(sid, { last: now(), personId: s.personId });
    return true;
  }

  /** Opens a session for an Administrator (a person's id) or the admin secret (null), sets its cookie and logs it. */
  function openSession(req: Request, res: Response, personId: number | null): void {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
    const sid = randomBytes(32).toString('hex');
    sessions.set(sid, { last: now(), personId });
    res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'strict', path: '/api/admin', secure: req.secure });
    const person = personId === null ? undefined : people.getPerson(personId);
    audit(req, 'unlock', 'Admin unlocked', person ? { person_id: person.id } : {}, person ? person.name : ADMIN_SECRET_ACTOR);
    res.json({ ok: true });
  }

  router.post('/unlock', (req, res) => {
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
    const found = checkNameToken(people, opts.secret, name, token);
    const administrator = found?.person && people.isAdministrator(found.person.id) ? found.person : undefined;
    if (found && (administrator || found.person === null)) {
      lockout.succeed(src);
      opts.respondBridge?.release(req, administrator?.id ?? null); // the person just proved who they are, so the idle lock may let them back in (#272)
      openSession(req, res, administrator?.id ?? null);
      return;
    }
    const { n, locked } = lockout.fail(src);
    audit(req, 'unlock_failed', locked ? `Wrong name or token (${n}); locked for ${Math.round(lockout.lockMs / 60_000)} minutes` : `Wrong name or token (${n})`, { failures: n, locked });
    res.status(401).json({ ok: false, error: 'wrong name or token' });
  });

  // A browser signed in to respond as an Administrator (or as Admin with the secret) opens Admin with no second sign-in (#215).
  router.post('/unlock/from-respond', (req, res) => {
    const administrator = opts.respondBridge?.administratorOf(req) ?? null;
    if (!administrator) {
      res.status(401).json({ ok: false, error: 'not signed in as an Administrator' });
      return;
    }
    openSession(req, res, administrator.personId);
  });

  // Everything below needs an unlocked session.
  router.use((req, res, next) => {
    if (sessionValid(req)) return next();
    res.status(401).json({ ok: false, error: 'locked' });
  });

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
  const groupNameOf = (p: PersonRow) => (p.groupId === null ? null : (people.getGroup(p.groupId)?.name ?? null));
  const paging = (req: Request) => ({ page: Number(req.query.page), pageSize: Number(req.query.pageSize) });

  // ---- people ---------------------------------------------------------------------------------

  router.get('/people', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json({ ...people.list({ ...paging(req), q }), groups: people.allGroups() });
  });

  router.post('/people', (req, res) => {
    try {
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      const groupId = typeof req.body?.groupId === 'number' ? req.body.groupId : null;
      const { person, token } = people.createPerson(name, groupId, now());
      audit(req, 'person_created', `Added ${person.name}`, { person_id: person.id });
      res.status(201).json({ ok: true, person: publicPerson(person, groupNameOf(person)), token });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/people/:id/rotate', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) return void res.status(400).json({ ok: false, error: 'bad id' });
    try {
      const out = people.rotate(id, now());
      if (!out) return void res.status(404).json({ ok: false, error: 'unknown person' });
      audit(req, 'token_rotated', `Rotated the token of ${out.person.name}`, { person_id: id });
      res.json({ ok: true, person: publicPerson(out.person, groupNameOf(out.person)), token: out.token });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/people/:id/revoke', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) return void res.status(400).json({ ok: false, error: 'bad id' });
    const p = people.getPerson(id);
    if (!p) return void res.status(404).json({ ok: false, error: 'unknown person' });
    if (people.revoke(id, now())) audit(req, 'token_revoked', `Revoked the token of ${p.name}`, { person_id: id });
    res.json({ ok: true });
  });

  // One route for one person or many (#243). All or nothing: a refusal deletes nobody.
  router.post('/people/delete', (req, res) => {
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
      const gone = people.deleteMany(ids as number[]);
      if (gone.length === 0) return void res.status(404).json({ ok: false, error: 'unknown person' });
      for (const p of gone) audit(req, 'person_deleted', `Deleted ${p.name}`, { person_id: p.id });
      res.json({ ok: true, removed: gone.length });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/people/:id/group', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) return void res.status(400).json({ ok: false, error: 'bad id' });
    const raw = req.body?.groupId;
    if (raw !== null && typeof raw !== 'number') return void res.status(400).json({ ok: false, error: 'groupId must be a number or null' });
    const p = people.getPerson(id);
    if (!p || !people.setGroup(id, raw)) return void res.status(404).json({ ok: false, error: 'unknown person or group' });
    audit(req, 'group_assigned', raw === null ? `${p.name} moved to no group` : `${p.name} moved to ${people.getGroup(raw)?.name}`, { person_id: id, group_id: raw });
    res.json({ ok: true });
  });

  // ---- groups ---------------------------------------------------------------------------------

  router.get('/groups', (req, res) => {
    res.json(people.listGroups(paging(req)));
  });

  router.post('/groups', (req, res) => {
    try {
      const g = people.createGroup(typeof req.body?.name === 'string' ? req.body.name : '', now());
      audit(req, 'group_created', `Created the group ${g.name}`, { group_id: g.id });
      res.status(201).json({ ok: true, ...g });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/groups/:id', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) return void res.status(400).json({ ok: false, error: 'bad id' });
    const g = people.getGroup(id);
    try {
      if (!g || !people.deleteGroup(id)) return void res.status(404).json({ ok: false, error: 'unknown group' });
      audit(req, 'group_deleted', `Deleted the group ${g.name}`, { group_id: id });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- reporters (#142) -----------------------------------------------------------------------

  const reporterKey = (v: string): string | null => (v.length >= 1 && v.length <= 150 ? v : null);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  router.get('/reporters', (req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    const dir = Number(req.query.dir);
    res.json({
      ...reporters.list({ ...paging(req), q: str(req.query.q), state: str(req.query.state), sort: str(req.query.sort), admin: req.query.admin === '1', dir: Number.isFinite(dir) && dir !== 0 ? dir : undefined }, now()),
      serverTime: now(),
    });
  });

  // Bulk removal and ignore rules (issue #167). These come before `/reporters/:key`, which would take "ignores" for a key.
  const MAX_BULK = 500;
  const plural = (n: number) => `${n} reporter${n === 1 ? '' : 's'}`;

  router.post('/reporters/remove', (req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    const { keys, state, match } = (req.body ?? {}) as { keys?: unknown; state?: unknown; match?: unknown };
    let removed: number;
    if (match !== undefined) {
      // Every reporter a filter holds, which can be more than one page: what "select all that match" asks for.
      const m = match as { q?: unknown; state?: unknown; admin?: unknown };
      if (!m || typeof m !== 'object' || Array.isArray(m)) return void res.status(400).json({ ok: false, error: 'match must be a filter' });
      if (m.state !== undefined && m.state !== '' && !REPORTER_STATES.includes(m.state as ReporterState)) return void res.status(400).json({ ok: false, error: 'match.state is not a reporter state' });
      removed = reporters.removeMany(reporters.keys({ q: str(m.q), state: str(m.state), admin: m.admin === true }, now()));
    } else if (Array.isArray(keys)) {
      if (keys.length < 1 || keys.length > MAX_BULK || keys.some((k) => typeof k !== 'string' || reporterKey(k) === null)) {
        return void res.status(400).json({ ok: false, error: `keys must be 1 to ${MAX_BULK} reporter keys` });
      }
      removed = reporters.removeMany(keys as string[]);
    } else if (typeof state === 'string' && REPORTER_STATES.includes(state as ReporterState)) {
      removed = reporters.removeState(state as ReporterState, now());
    } else {
      return void res.status(400).json({ ok: false, error: 'give keys, a state or a match' });
    }
    audit(req, 'reporter_removed', `Removed ${plural(removed)} from the list`, { count: removed });
    res.json({ ok: true, removed });
  });

  router.get('/reporters/ignores', (_req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    res.json({ rules: reporters.listIgnores() });
  });

  router.post('/reporters/ignores', (req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    const { kind, pattern } = (req.body ?? {}) as { kind?: unknown; pattern?: unknown };
    if (typeof kind !== 'string' || typeof pattern !== 'string') return void res.status(400).json({ ok: false, error: 'give a kind and a pattern' });
    try {
      const before = reporters.list({}, now()).counts.all;
      const rule = reporters.addIgnore(kind as IgnoreKind, pattern, now());
      const removed = before - reporters.list({}, now()).counts.all;
      audit(req, 'reporter_ignore_added', `Ignoring reporters whose ${rule.kind} matches ${rule.pattern}; ${plural(removed)} removed from the list`, { rule: rule.id });
      res.json({ ok: true, rule, removed });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  router.delete('/reporters/ignores/:id', (req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    const id = Number(req.params.id);
    const rule = Number.isInteger(id) ? reporters.listIgnores().find((r) => r.id === id) : undefined;
    if (!rule || !reporters.removeIgnore(id)) return void res.status(404).json({ ok: false, error: 'unknown rule' });
    audit(req, 'reporter_ignore_removed', `Stopped ignoring reporters whose ${rule.kind} matches ${rule.pattern}`, { rule: id });
    res.json({ ok: true });
  });

  router.get('/reporters/:key', (req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    const key = reporterKey(req.params.key);
    if (key === null) return void res.status(400).json({ ok: false, error: 'bad key' });
    const d = reporters.get(key, now(), paging(req));
    if (!d) return void res.status(404).json({ ok: false, error: 'unknown reporter' });
    res.json({ ...d, serverTime: now() });
  });

  // Orchestrator messaging on Admin > Reporters > a reporter (#347). A change is a proposal the owner must accept;
  // Pause all links and a removal apply at once. Each is logged through the messaging trail, with this Admin as actor.
  const peerActor = (req: Request): Actor => ({ name: actorOf(req) ?? ADMIN_SECRET_ACTOR, admin: true });
  const peerFail = (res: Response, out: Refusal) => res.status(out.status).json({ ok: false, error: out.error });
  const withPeerSource = <T>(req: Request, fn: () => T): T => (peers ? peers.withSource(sourceOf(req), fn) : fn());

  router.get('/reporters/:key/peers', (req, res) => {
    const ref = peers?.reporters.get(req.params.key);
    if (!peers || !ref) return void res.status(404).json({ ok: false, error: 'unknown reporter' });
    const owner = ref.owner;
    const mine = owner && !ref.adminSecret ? peers.reporters.ofOwner(owner).filter((r) => !r.adminSecret) : [];
    res.json({
      reporter: ref,
      peers: mine,
      rights: owner ? peers.rights.rightsOf(owner).filter((r) => r.from === ref.key || r.to === ref.key) : [],
      effective: mine.flatMap((o) => [
        { from: ref.key, to: o.key, ...peers.rights.effective(ref.key, o.key) },
        ...(o.key === ref.key ? [] : [{ from: o.key, to: ref.key, ...peers.rights.effective(o.key, ref.key) }]),
      ]),
      requests: owner ? peers.rights.openRequests(owner, ref.key).map((r) => ({ ...peers.requestView(r), messageId: r.messageId })) : [],
    });
  });

  router.post('/reporters/:key/peers/propose', (req, res) => {
    if (!peers) return void res.status(404).json({ ok: false, error: 'not available' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const from = typeof b.from === 'string' ? b.from : req.params.key;
    if (typeof b.to !== 'string' || !(PEER_LEVELS as readonly unknown[]).includes(b.level)) return void res.status(400).json({ ok: false, error: 'to must be a reporter key, level one of none, see, ask, send' });
    if (from !== req.params.key && b.to !== req.params.key) return void res.status(400).json({ ok: false, error: 'a proposal on this page must involve this reporter' });
    const out = withPeerSource(req, () => peers.rights.propose(from, b.to as string, b.level as PeerLevel, peerActor(req)));
    if (!out.ok) return void peerFail(res, out);
    res.status(202).json({ ok: true, requestId: out.request.id });
  });

  router.put('/reporters/:key/peers/pause', (req, res) => {
    if (!peers) return void res.status(404).json({ ok: false, error: 'not available' });
    const paused = (req.body as { paused?: unknown } | undefined)?.paused;
    if (typeof paused !== 'boolean') return void res.status(400).json({ ok: false, error: 'paused must be true or false' });
    const out = withPeerSource(req, () => peers.rights.pauseReporter(req.params.key, paused, peerActor(req)));
    if (!out.ok) return void peerFail(res, out);
    res.json(out);
  });

  router.delete('/reporters/:key/peers/:other', (req, res) => {
    if (!peers) return void res.status(404).json({ ok: false, error: 'not available' });
    const out = withPeerSource(req, () => peers.removeLink(null, req.params.key, req.params.other, peerActor(req)));
    if (!out.ok) return void peerFail(res, out);
    res.json(out);
  });

  router.get('/peers/conversations', (req, res) => {
    if (!peers) return void res.status(404).json({ ok: false, error: 'not available' });
    const range = req.query.range;
    const since = range === '24h' ? now() - 86_400_000 : range === '30d' ? now() - 30 * 86_400_000 : undefined;
    if (range !== undefined && range !== 'live' && since === undefined) return void res.status(400).json({ ok: false, error: 'range must be live, 24h or 30d' });
    res.json({ conversations: peers.messages.conversations(since === undefined ? { liveOnly: range === 'live' } : { since }) });
  });

  router.get('/peers/conversations/:a/:b', (req, res) => {
    if (!peers) return void res.status(404).json({ ok: false, error: 'not available' });
    const rows = peers.messages.conversation(req.params.a, req.params.b);
    if (!rows.length) return void res.status(404).json({ ok: false, error: 'no such conversation' });
    res.json({ messages: rows.map(messageView) });
  });

  router.delete('/reporters/:key', (req, res) => {
    if (!reporters) return void res.status(404).json({ ok: false, error: 'not available' });
    const key = reporterKey(req.params.key);
    if (key === null) return void res.status(400).json({ ok: false, error: 'bad key' });
    const d = reporters.get(key, now());
    if (!d || !reporters.remove(key)) return void res.status(404).json({ ok: false, error: 'unknown reporter' });
    audit(req, 'reporter_removed', `Removed the reporter ${d.name} from the list`, { reporter: key });
    res.json({ ok: true });
  });

  // ---- settings and log -----------------------------------------------------------------------

  const featureList = () => FEATURES.map(({ defaultOn, ...f }) => ({ ...f, on: features ? features.featureOn(f.id) : defaultOn }));
  const noticeList = () => NOTICES.map((n) => ({ ...n, on: wall ? wall.noticeOn(n.id) : true }));

  router.get('/settings', (_req, res) => {
    res.json({
      allowAdminSecretReporting: people.adminReportingAllowed(),
      features: featureList(),
      notices: noticeList(),
      showBackgroundSessions: wall?.showBackgroundSessions() ?? false,
      modelPrices: prices?.view() ?? { asOf: PRICES_AS_OF, models: [] },
      forgetReporters: reporters?.forgetSetting() ?? { enabled: false, days: 30 },
      ...(peers ? { peerMessaging: peers.settings.get() } : {}),
    });
  });

  // One setting per call: allowAdminSecretReporting, showBackgroundSessions, features ({ id: boolean }), notices ({ id: boolean }),
  // modelPrice ({ key, std, long? }: one model's prices) or resetModelPrice (a key).
  router.put('/settings', (req, res) => {
    const body = req.body ?? {};
    if ('allowAdminSecretReporting' in body) {
      const v = body.allowAdminSecretReporting;
      if (typeof v !== 'boolean') return void res.status(400).json({ ok: false, error: 'allowAdminSecretReporting must be true or false' });
      people.setAdminReporting(v);
      audit(req, 'admin_reporting_changed', `Reporting with the admin secret turned ${v ? 'on' : 'off'}`, { on: v });
      return void res.json({ ok: true, allowAdminSecretReporting: v });
    }
    if ('forgetReporters' in body) {
      const f = body.forgetReporters;
      const okShape = f && typeof f === 'object' && !Array.isArray(f) && ('enabled' in f || 'days' in f) && (f.enabled === undefined || typeof f.enabled === 'boolean');
      if (!reporters || !okShape) return void res.status(400).json({ ok: false, error: 'forgetReporters must give enabled (true or false) and/or days' });
      try {
        reporters.setForgetSetting({ enabled: f.enabled, days: f.days });
      } catch (err) {
        return void res.status(400).json({ ok: false, error: (err as Error).message });
      }
      const now_ = reporters.forgetSetting();
      audit(req, 'reporters_forget_changed', now_.enabled ? `Forgetting reporters not heard from for ${now_.days} days turned on` : 'Forgetting reporters by age turned off', { on: now_.enabled, days: now_.days });
      return void res.json({ ok: true, forgetReporters: now_ });
    }
    if ('peerMessaging' in body) {
      const p = body.peerMessaging;
      if (!peers || !p || typeof p !== 'object' || Array.isArray(p)) return void res.status(400).json({ ok: false, error: 'peerMessaging must give roundTrips, perMinute, maxChars and/or retainDays' });
      const out = peers.settings.set(p);
      if (!out.ok) return void res.status(400).json({ ok: false, error: out.error });
      const v = out.settings;
      audit(req, 'peer_limits_changed', `Orchestrator messaging limits: ${v.roundTrips} round trips, ${v.perMinute} a minute, ${v.maxChars} characters, kept ${v.retainDays} days`, { ...v });
      return void res.json({ ok: true, peerMessaging: v });
    }
    if ('showBackgroundSessions' in body) {
      const v = body.showBackgroundSessions;
      if (typeof v !== 'boolean' || !wall) return void res.status(400).json({ ok: false, error: 'showBackgroundSessions must be true or false' });
      wall.setShowBackgroundSessions(v);
      audit(req, 'wall_background_changed', `Background sessions ${v ? 'shown' : 'hidden'} on the wall`, { on: v });
      return void res.json({ ok: true, showBackgroundSessions: v });
    }
    if ('features' in body) {
      const f = body.features;
      const ids = f && typeof f === 'object' && !Array.isArray(f) ? Object.keys(f) : [];
      if (!features || ids.length === 0 || ids.some((id) => !isFeatureId(id) || typeof f[id] !== 'boolean')) {
        return void res.status(400).json({ ok: false, error: 'features must map known feature ids to true or false' });
      }
      for (const id of ids) {
        const wasOn = features.featureOn(id);
        features.setFeature(id, f[id]);
        audit(req, 'feature_changed', `Feature ${id} turned ${f[id] ? 'on' : 'off'}`, { setting: id, on: f[id] });
        if (id === RESPOND && f[id] && !wasOn) opts.onRespondOn?.(); // after the audit row, so a failing warning cannot lose it
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
        wall.setNotice(id, n[id]);
        audit(req, 'wall_notice_changed', `Wall notice ${id} turned ${n[id] ? 'on' : 'off'}`, { setting: id, on: n[id] });
      }
      return void res.json({ ok: true, notices: noticeList() });
    }
    if ('modelPrice' in body) {
      const m = body.modelPrice;
      if (!prices || !m || typeof m !== 'object' || typeof m.key !== 'string') {
        return void res.status(400).json({ ok: false, error: 'modelPrice must name a model and give its prices' });
      }
      const before = JSON.stringify(prices.overrides());
      const err = prices.set(m.key, { std: m.std, ...(m.long === undefined || m.long === null ? {} : { long: m.long }) });
      if (err) return void res.status(400).json({ ok: false, error: err });
      // Saving the values a row already has changes nothing, so it is not logged as a change.
      if (JSON.stringify(prices.overrides()) === before) return void res.json({ ok: true, modelPrices: prices.view() });
      const k = m.key.trim().toLowerCase();
      const p = m.std as PriceSet;
      audit(
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
      prices.reset(k);
      if (JSON.stringify(prices.overrides()) === had) return void res.json({ ok: true, modelPrices: prices.view() });
      audit(req, 'model_price_reset', `Reset the price of ${k.trim().toLowerCase()} to the built-in value`, { model: k.trim().toLowerCase() });
      return void res.json({ ok: true, modelPrices: prices.view() });
    }
    res.status(400).json({ ok: false, error: 'no known setting in the request' });
  });

  router.get('/log', (req, res) => {
    res.json({ ...people.listLog(paging(req)), ...(opts.logRetainMs === undefined ? {} : { retainMs: opts.logRetainMs }) });
  });

  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    res.status(400).json({ ok: false, error: err instanceof SyntaxError ? 'bad JSON' : 'bad request' });
  });

  return router;
}
