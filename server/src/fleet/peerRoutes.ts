// Routes for orchestrator messaging (#347, #412, SPEC 7.1, 7.7), mounted on the fleet router.
//
// Three sides. The mod's routes (list peers, send, ask for access, answer a request, say what became of a delivery)
// take X-Podium-Token, checked as for a report; the credential must be a person's token that owns the session, and the
// session's last report must have said `peers: true`. The owner's routes live under /respond, on responding's browser
// router, so they share its sign-in cookie, its cross-site check and its no-store header; they act only on the
// signed-in person's own reporters. One open read, /peers/traffic, gives the counts and states Traffic draws for
// everyone, never the text. The text of a message is never logged here: the Admin log and the server log get who, to
// whom, whose and what happened.
import express, { type Request, type RequestHandler, type Response, type Router } from 'express';
import type { Fleet } from './fleet.js';
import type { Identity } from './routes.js';
import { ADMIN_OWNER, ADMIN_SECRET_ACTOR, nameKey, sourceAddress, type PeopleStore, type PersonRow } from './people.js';
import { PEER_ANSWERS, PEER_LEVELS, PEER_LIMITS, PEER_RESULTS, type PeerAnswer, type PeerLevel, type PeerResult } from './protocol.js';
import type { Actor, LiveOrchestrator, MessageRow, MessageTrail, PeerRequestRow, Refusal, ReporterRef, RightsTrail } from './peerTypes.js';
import { LEVEL_WORDS, type PeerReply } from './peers.js';
import type { SessionRow } from './db.js';
import type { Logger } from '../logging/logger.js';

export interface PeerDeps {
  fleet: Fleet;
  /** The admin secret; null when authentication is off, and messaging with it. */
  token: string | null;
  people: PeopleStore | null;
  logger: Logger;
  requireToken: RequestHandler;
  identityOf: (res: Response) => Identity;
}

/** What responding's browser router lends the owner's routes. */
export interface BrowserHelpers {
  viewerOf: (req: Request) => { name: string; actor: string; admin: boolean; personId: number | null } | null;
}

/** A message holds at most 20,000 characters, up to four bytes each, plus the JSON around it. */
const MESSAGE_BODY_LIMIT = '128kb';
const DAY_MS = 86_400_000;
/** How a sent message waits, as its Admin log row says it. */
const SENT_WORDS = { approval: 'waiting for approval', sent: 'the receiver is idle', turn: "waiting for the receiver's turn to end" } as const;

const sourceOf = (req: Request): string => sourceAddress(req.ip);

/** Authentication on and the Admin's flag. The reporter's `peers` option is the session's own, checked per request. */
export const peersEnabled = (fleet: Fleet, token: string | null): boolean => token !== null && fleet.peers.flagOn();

/** The `range` of a conversations read: live sessions (the default), the last 24 hours, or the last 30 days. */
export function rangeOf(raw: unknown, now: number): { since?: number; liveOnly?: boolean } | null {
  if (raw === undefined || raw === 'live') return { liveOnly: true };
  if (raw === '24h') return { since: now - DAY_MS };
  if (raw === '30d') return { since: now - 30 * DAY_MS };
  return null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function send(res: Response, out: Refusal): void {
  res.status(out.status).json({ ok: false, error: out.error });
}

/**
 * Writes every right and message event to the Admin log and the server log, never a message's text. Returns the
 * wrapper the routes use so a row names the address of the request that caused it ('server' for a sweep or a report).
 */
export function wirePeerLogs(fleet: Fleet, people: PeopleStore | null, logger: Logger): <T>(src: string, fn: () => T) => T {
  let source = 'server';
  const withSource = <T>(src: string, fn: () => T): T => {
    source = src;
    try {
      return fn();
    } finally {
      source = 'server';
    }
  };
  const machine = (key: string): string => fleet.peers.reporters.get(key)?.machine ?? key;
  const actorName = (a: Actor): string => (a.name === ADMIN_OWNER ? ADMIN_SECRET_ACTOR : a.name);
  const pair = (m: MessageRow): string => `${m.fromName} on ${m.fromMachine} to ${m.toName} on ${m.toMachine}, ${m.owner}'s`;
  const short = (id: string): string => id.slice(0, 12);
  const DROP_WORDS: Record<string, string> = {
    'receiver-ended': 'the receiver ended first',
    'session-deleted': 'a session was deleted',
    'link-removed': 'the link was removed',
    'messaging-off': 'orchestrator messaging was turned off',
    refused: 'the receiving reporter refused it',
  };
  const row = (kind: string, detail: string, actor: string | null, fields: Record<string, unknown>) => {
    try {
      people?.log(kind, detail, source, fleet.now(), actor);
      logger.info(`peers.${kind.replace(/^peer_/, '')}`, `podium: ${detail}`, { ...fields, source });
    } catch (err) {
      logger.warn('peers.trail_failed', `podium: could not log a messaging event: ${(err as Error).message}`, { reason: (err as Error).message });
    }
  };

  fleet.peers.onMessage = (t: MessageTrail) => {
    const m = t.message;
    const fields = { owner: m.owner, from_session: m.fromSession, to_session: m.toSession, message_id: short(m.id) };
    if (t.kind === 'sent') {
      const how = t.approvalWhy === 'round-trips' ? 'waiting for approval past the round-trip limit' : SENT_WORDS[t.state];
      row('peer_sent', `Message from ${pair(m)}: sent, ${how} [${short(m.id)}]`, m.owner, { ...fields, state: t.state });
    } else if (t.kind === 'delivered') row('peer_delivered', `Message from ${pair(m)}: delivered [${short(m.id)}]`, m.owner, fields);
    else if (t.kind === 'approved') row('peer_approved', `Message from ${pair(m)}: approved [${short(m.id)}]`, actorName(t.actor), { ...fields, admin: t.actor.admin });
    else if (t.kind === 'declined') row('peer_declined', `Message from ${pair(m)}: declined [${short(m.id)}]`, actorName(t.actor), { ...fields, admin: t.actor.admin });
    else row('peer_dropped', `Message from ${pair(m)}: dropped, ${DROP_WORDS[t.why] ?? t.why} [${short(m.id)}]`, m.owner, { ...fields, why: t.why });
  };

  const requestRow = (kind: string, r: PeerRequestRow, actor: string, prefix = '') => {
    const what = r.kind === 'message' ? 'a message' : `${machine(r.fromKey)} to ${machine(r.toKey)}: ${r.level ? LEVEL_WORDS[r.level] : ''}`;
    row(kind, `${prefix}${what}, ${r.owner}'s [${short(r.id)}]`, actor, { owner: r.owner, request_id: short(r.id), request_kind: r.kind });
  };

  fleet.peers.onRights = (t: RightsTrail) => {
    switch (t.kind) {
      case 'set':
        row('peer_right_set', `${machine(t.right.from)} to ${machine(t.right.to)}, ${t.right.owner}'s: ${LEVEL_WORDS[t.right.level]}`, actorName(t.actor), { owner: t.right.owner, from_key: t.right.from, to_key: t.right.to, level: t.right.level, admin: t.actor.admin });
        break;
      case 'paused':
      case 'resumed':
      case 'removed':
        row(`peer_right_${t.kind}`, `Link between ${machine(t.a)} and ${machine(t.b)}, ${t.owner}'s: ${t.kind}`, actorName(t.actor), { owner: t.owner, a_key: t.a, b_key: t.b, admin: t.actor.admin });
        break;
      case 'access-requested':
        requestRow('peer_access_requested', t.request, t.request.owner, `${t.request.by} asked for `);
        break;
      case 'proposed':
      case 'accepted':
      case 'declined':
        requestRow(`peer_right_${t.kind}`, t.request, actorName(t.actor));
        break;
      case 'defaults':
        row('peer_defaults_changed', `Messaging defaults changed, ${t.owner}'s`, actorName(t.actor), { owner: t.owner, admin: t.actor.admin });
        break;
    }
  };
  fleet.peers.withSource = withSource;
  return withSource;
}

/** For the report route: the messaging fields of the reply (6.1). Off unless every switch the server knows of is on. */
export function peerReplyFor(fleet: Fleet, token: string | null, sessionId: string, id: Identity): PeerReply {
  const o = fleet.peers.messages.live(sessionId);
  const ref = o ? fleet.peers.reporters.get(o.reporterKey) : null;
  const on = peersEnabled(fleet, token) && id.kind === 'person' && o?.peers === true && !!ref && !ref.adminSecret;
  return fleet.peers.reply(sessionId, on);
}

export function mountPeerRoutes(router: Router, d: PeerDeps): void {
  const { fleet, logger } = d;
  const now = fleet.now;
  const json = express.json({ limit: MESSAGE_BODY_LIMIT });
  const withSource = wirePeerLogs(fleet, d.people, logger);
  const enabled = () => peersEnabled(fleet, d.token);

  const refuse = (req: Request, res: Response, status: number, reason: string) => {
    logger.warn('peers.refused', `podium: refused ${req.method} ${req.baseUrl}${req.path} from ${sourceOf(req)}: ${reason}`, { status, reason, source: sourceOf(req), session_id: req.params.id ?? null });
    res.status(status).json({ ok: false, error: reason });
  };

  /** The orchestrator a mod route is about, when messaging is on and a person's token owns its session; otherwise answers and returns null. */
  const modPeer = (req: Request, res: Response): { row: SessionRow; o: LiveOrchestrator; person: PersonRow } | null => {
    if (!enabled()) {
      refuse(req, res, 403, 'orchestrator messaging is off');
      return null;
    }
    const row = fleet.db.getSession(req.params.id!);
    if (!row || !fleet.isLive(row.id)) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return null;
    }
    const id = d.identityOf(res);
    if (id.kind !== 'person') {
      refuse(req, res, 403, 'a reporter on the admin secret cannot take part');
      return null;
    }
    if (row.owner === null || nameKey(row.owner) !== nameKey(id.person.name)) {
      refuse(req, res, 403, 'not your session');
      return null;
    }
    const o = fleet.peers.messages.live(row.id);
    if (o?.peers !== true) {
      refuse(req, res, 403, "messaging is off on this machine: turn on the reporter's peers option there");
      return null;
    }
    return { row, o, person: id.person };
  };

  router.get('/sessions/:id/peers', d.requireToken, (req, res) => {
    const m = modPeer(req, res);
    if (!m) return;
    res.json({ ok: true, ...fleet.peers.messages.list(m.row.id) });
  });

  router.post('/sessions/:id/peers/messages', d.requireToken, json, (req, res) => {
    const m = modPeer(req, res);
    if (!m) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const to = str(body.to);
    const text = str(body.text);
    if (to === null || !to.trim() || to.length > PEER_LIMITS.address) return void res.status(400).json({ ok: false, error: 'to must be name@machine', path: '$.to' });
    if (text === null) return void res.status(400).json({ ok: false, error: 'text must be a string', path: '$.text' });
    const out = withSource(sourceOf(req), () => fleet.peers.messages.send(m.row.id, to, text));
    if (!out.ok) {
      refuse(req, res, out.status, out.error);
      return;
    }
    res.status(202).json(out);
  });

  router.post('/sessions/:id/peers/access', d.requireToken, json, (req, res) => {
    const m = modPeer(req, res);
    if (!m) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const to = str(body.to);
    const reason = str(body.reason) ?? '';
    if (body.right !== 'see' && body.right !== 'send') return void res.status(400).json({ ok: false, error: 'right must be see or send', path: '$.right' });
    if (to === null || !to.trim() || to.length > PEER_LIMITS.address) return void res.status(400).json({ ok: false, error: 'to must be a machine, or name@machine', path: '$.to' });
    const target = reporterNamed(fleet.peers.reporters.ofOwner(m.o.owner), to);
    if ('error' in target) return void refuse(req, res, target.status, target.error);
    const out = withSource(sourceOf(req), () =>
      fleet.peers.rights.requestAccess({ owner: m.o.owner, fromKey: m.o.reporterKey, toKey: target.key, right: body.right as 'see' | 'send', reason, by: m.o.name, fromSession: m.row.id }),
    );
    if (!out.ok) return void refuse(req, res, out.status, out.error);
    if (out.state === 'asked') res.status(202).json({ ok: true, state: 'asked', requestId: out.request.id, to: target.machine });
    else if (out.state === 'allowed') res.json({ ok: true, state: 'allowed', level: out.applied.level, to: target.machine });
    else res.json({ ok: true, state: 'declined', to: target.machine });
  });

  router.post('/sessions/:id/peers/requests/:requestId', d.requireToken, json, (req, res) => {
    const m = modPeer(req, res);
    if (!m) return;
    const answer = (req.body as { answer?: unknown } | undefined)?.answer;
    if (!(PEER_ANSWERS as readonly unknown[]).includes(answer)) return void res.status(400).json({ ok: false, error: 'answer must be allow, decline or deliver', path: '$.answer' });
    const out = withSource(sourceOf(req), () => fleet.peers.answer(req.params.requestId!, m.o.owner, answer as PeerAnswer, { name: m.person.name, admin: false }));
    if (!out.ok) return void refuse(req, res, out.status, out.error);
    // The level the right now has, which raise() can make higher than the request's, so /podium allow names it (#414).
    const applied = 'applied' in out ? out.applied : null;
    res.json({ ok: true, outcome: out.request.outcome, ...(applied ? { level: applied.level } : {}) });
  });

  router.post('/sessions/:id/peers/deliveries/:deliveryId/result', d.requireToken, json, (req, res) => {
    const m = modPeer(req, res);
    if (!m) return;
    const result = (req.body as { result?: unknown } | undefined)?.result;
    if (!(PEER_RESULTS as readonly unknown[]).includes(result)) return void res.status(400).json({ ok: false, error: 'result must be took, queued or refused', path: '$.result' });
    const out = withSource(sourceOf(req), () => fleet.peers.messages.result(m.row.id, req.params.deliveryId!, result as PeerResult));
    if (out === 'unknown') return void res.status(404).json({ ok: false, error: 'unknown delivery' });
    res.json({ ok: true });
  });

  /** Traffic's open read (8.1): which orchestrators talk, and how much, for anyone who can read the console. Never the text. */
  router.get('/peers/traffic', (req, res) => {
    const range = rangeOf(req.query.range, now());
    if (!range) return void res.status(400).json({ ok: false, error: 'range must be live, 24h or 30d' });
    if (!enabled()) return void res.json({ enabled: false, conversations: [] });
    res.json({ enabled: true, conversations: fleet.peers.messages.conversations(range), retainDays: fleet.peers.settings.get().retainDays, serverTime: now() });
  });
}

/** One of the owner's reporters by its machine name (or the machine part of `name@machine`), case-insensitively. */
function reporterNamed(mine: ReporterRef[], to: string): ReporterRef | { status: 404 | 409; error: string } {
  const at = to.lastIndexOf('@');
  const want = (at >= 0 ? to.slice(at + 1) : to).trim().toLowerCase();
  const found = mine.filter((r) => !r.adminSecret && r.machine.toLowerCase() === want);
  if (found.length === 1) return found[0]!;
  if (found.length > 1) return { status: 409, error: `Two of your reporters are called ${want}. Ask your person to tell them apart on My reporters.` };
  return { status: 404, error: `No reporter of yours is called ${want}. Run podium_peers for the machines you have.` };
}

/** The owner's routes, on responding's browser router: My reporters (C4) and the conversations Traffic opens (C6). */
export function mountPeerBrowserRoutes(browser: Router, d: PeerDeps, h: BrowserHelpers): void {
  const { fleet, logger } = d;
  const now = fleet.now;
  const enabled = () => peersEnabled(fleet, d.token);
  const withSource = <T>(src: string, fn: () => T): T => fleet.peers.withSource(src, fn);

  const refuse = (req: Request, res: Response, status: number, reason: string) => {
    logger.warn('peers.refused', `podium: refused ${req.method} ${req.baseUrl}${req.path} from ${sourceOf(req)}: ${reason}`, { status, reason, source: sourceOf(req) });
    res.status(status).json({ ok: false, error: reason });
  };

  /** The signed-in person whose reporters a route manages; the admin secret has none. Otherwise answers and returns null. */
  const owner = (req: Request, res: Response): { name: string; actor: Actor } | null => {
    if (!enabled()) {
      refuse(req, res, 403, 'orchestrator messaging is off');
      return null;
    }
    const v = h.viewerOf(req);
    if (!v) {
      refuse(req, res, 403, 'sign in to manage your reporters');
      return null;
    }
    if (v.personId === null) {
      refuse(req, res, 403, 'the admin secret has no reporters of its own: sign in with your own name and token');
      return null;
    }
    return { name: v.name, actor: { name: v.actor, admin: false } };
  };

  const liveOn = (key: string) =>
    fleet
      .liveIds()
      .map((id) => fleet.peers.messages.live(id))
      .filter((o): o is LiveOrchestrator => !!o && o.reporterKey === key)
      .map((o) => ({ sessionId: o.sessionId, name: o.name, status: o.status, peers: o.peers === true }));

  browser.get('/peers', (req, res) => {
    const me = owner(req, res);
    if (!me) return;
    const server = fleet.peers.serverLimits();
    const t = now();
    res.json({
      enabled: true,
      owner: me.name,
      // Each reporter's state and last report as Admin > Reporters has them (#415), timed by the server's clock as there.
      serverTime: t,
      serverStartedAt: fleet.peers.reporters.startedAt,
      reporters: fleet.peers.reporters.ofOwnerSeen(me.name, t).filter((r) => !r.adminSecret).map((r) => ({ ...r, live: liveOn(r.key) })),
      rights: fleet.peers.rights.rightsOf(me.name),
      defaults: fleet.peers.rights.defaults(me.name),
      limits: { server, effective: fleet.peers.rights.limits(me.name, server) },
      requests: fleet.peers.rights.openRequests(me.name).map((r) => fleet.peers.ownerRequestView(r)),
    });
  });

  browser.put('/peers/rights', (req, res) => {
    const me = owner(req, res);
    if (!me) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!(PEER_LEVELS as readonly unknown[]).includes(b.level)) return void res.status(400).json({ ok: false, error: 'level must be none, see, ask or send', path: '$.level' });
    if (typeof b.from !== 'string' || typeof b.to !== 'string') return void res.status(400).json({ ok: false, error: 'from and to must be reporter keys' });
    const out = withSource(sourceOf(req), () => fleet.peers.rights.setRight(me.name, b.from as string, b.to as string, b.level as PeerLevel, me.actor));
    if (!out.ok) return void send(res, out);
    res.json(out);
  });

  /** Pause link or Resume link: both directions, at once, keeping the rights. */
  browser.put('/peers/links', (req, res) => {
    const me = owner(req, res);
    if (!me) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.a !== 'string' || typeof b.b !== 'string' || typeof b.paused !== 'boolean') return void res.status(400).json({ ok: false, error: 'a and b must be reporter keys, paused a boolean' });
    const out = withSource(sourceOf(req), () => fleet.peers.rights.pauseLink(me.name, b.a as string, b.b as string, b.paused as boolean, me.actor));
    if (!out.ok) return void send(res, out);
    res.json(out);
  });

  /** Remove link: both directions lose every right, and a message still waiting on it is dropped. */
  browser.delete('/peers/links', (req, res) => {
    const me = owner(req, res);
    if (!me) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.a !== 'string' || typeof b.b !== 'string') return void res.status(400).json({ ok: false, error: 'a and b must be reporter keys' });
    const out = withSource(sourceOf(req), () => fleet.peers.removeLink(me.name, b.a as string, b.b as string, me.actor));
    if (!out.ok) return void send(res, out);
    res.json(out);
  });

  browser.put('/peers/defaults', (req, res) => {
    const me = owner(req, res);
    if (!me) return;
    const out = withSource(sourceOf(req), () => fleet.peers.rights.setDefaults(me.name, (req.body ?? {}) as Record<string, unknown>, fleet.peers.serverLimits(), me.actor));
    if (!out.ok) return void send(res, out);
    res.json(out);
  });

  browser.post('/peers/requests/:requestId', (req, res) => {
    const me = owner(req, res);
    if (!me) return;
    const answer = (req.body as { answer?: unknown } | undefined)?.answer;
    if (!(PEER_ANSWERS as readonly unknown[]).includes(answer)) return void res.status(400).json({ ok: false, error: 'answer must be allow, decline or deliver', path: '$.answer' });
    const out = withSource(sourceOf(req), () => fleet.peers.answer(req.params.requestId!, me.name, answer as PeerAnswer, me.actor));
    if (!out.ok) return void send(res, out);
    res.json({ ok: true, outcome: out.request.outcome });
  });

  browser.get('/peers/conversations', (req, res) => {
    const me = owner(req, res);
    if (!me) return;
    const range = rangeOf(req.query.range, now());
    if (!range) return void res.status(400).json({ ok: false, error: 'range must be live, 24h or 30d' });
    res.json({ conversations: fleet.peers.messages.conversations({ ...range, owner: me.name }) });
  });

  /** One conversation's messages, with their text: only its owner, or an Admin (the admin secret or an Administrator). */
  browser.get('/peers/conversations/:a/:b', (req, res) => {
    if (!enabled()) return void refuse(req, res, 403, 'orchestrator messaging is off');
    const v = h.viewerOf(req);
    if (!v) return void refuse(req, res, 403, 'sign in to read a conversation');
    const rows = fleet.peers.messages.conversation(req.params.a!, req.params.b!);
    if (!rows.length) return void res.status(404).json({ ok: false, error: 'no such conversation' });
    if (!v.admin && nameKey(rows[0]!.owner) !== nameKey(v.name)) return void refuse(req, res, 403, 'only its owner and an Admin can read a conversation');
    res.json({ messages: rows.map(messageView) });
  });
}

/** A message as a conversation shows it: who, to whom, when, where it is, and its text drawn as text by the page. */
export function messageView(m: MessageRow) {
  return {
    id: m.id,
    from: { sessionId: m.fromSession, name: m.fromName, machine: m.fromMachine, reporterKey: m.fromKey },
    to: { sessionId: m.toSession, name: m.toName, machine: m.toMachine, reporterKey: m.toKey },
    owner: m.owner,
    text: m.text,
    sentAt: m.sentAt,
    state: m.state,
    stateAt: m.stateAt,
    why: m.why,
    approved: m.approved,
  };
}
