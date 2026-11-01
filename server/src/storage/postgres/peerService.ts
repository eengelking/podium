// Orchestrator messaging (#347, #412, SPEC 7.7) on PostgreSQL (#822): the one place the rights store, the message store and the
// Admin's settings meet. Every method is async; the glue in peers.ts runs each storage-touching one as one transaction.
import { PgPeerRights } from './peerRights.js';
import { PgPeerMessages } from './peerMessages.js';
import { PgPeerSettings } from './peerSettings.js';
import { isIdle, type Actor, type MachineName, type RightRow, type AnswerOutcome, type MessageTrail, type OwnerRequestView, type PeerRequestRow, type Refusal, type RightsTrail } from '../../fleet/peerTypes.js';
import { PEER_LIMITS, type PeerAnswer, type PeerRequest, type Report } from '../../fleet/protocol.js';
import type { PeerLimits } from '../settings.js';
import { LEVEL_WORDS, type PeerReply, type OwnerPeersView, type AdminPeersView } from '../rows.js';
import type { AsyncPeerReporterLookup } from '../types.js';
import type { PgDb } from './conn.js';

/** The keys of the reporters a trail names, so their machine names can be read before the handler runs. */
export function trailKeys(t: object): string[] {
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v !== 'object' || v === null) return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && ['from', 'to', 'a', 'b', 'fromKey', 'toKey'].includes(k)) keys.add(x);
      else if (typeof x === 'object') walk(x);
    }
  };
  walk(t);
  return [...keys];
}

export class PgPeerService {
  readonly settings: PgPeerSettings;
  readonly rights: PgPeerRights;
  readonly messages: PgPeerMessages;
  /** Replaced by the routes, so a right's event reaches the logs. */
  onRights: (t: RightsTrail, machine: MachineName) => void = () => {};
  /** Replaced by the routes, so a message's event reaches the logs. */
  onMessage: (t: MessageTrail, machine: MachineName) => void = () => {};

  constructor(
    db: PgDb,
    readonly reporters: AsyncPeerReporterLookup,
    private readonly now: () => number = Date.now,
    /** The Admin's `peer-messaging` flag. */
    readonly flagOn: () => boolean = () => false,
  ) {
    this.db = db;
    this.settings = new PgPeerSettings(db);
    this.rights = new PgPeerRights(db, reporters, now, async (t) => this.onRights(t, await this.machineNames(t)));
    this.messages = new PgPeerMessages(
      db,
      {
        effective: (from, to) => this.rights.effective(from, to),
        limits: async (owner) => this.rights.limits(owner, await this.settings.limits()),
        openMessageRequest: (input) => this.rights.openMessageRequest(input),
        closeMessageRequest: (id, outcome) => this.rights.closeMessageRequest(id, outcome),
      },
      reporters,
      now,
      async (t) => this.onMessage(t, await this.machineNames(t)),
    );
  }

  private readonly db: PgDb;

  /** A lookup of machine names for the reporters a trail names, read now so the handler can use it at once. An unknown key names itself. */
  private async machineNames(t: object): Promise<MachineName> {
    const names = new Map<string, string>();
    for (const k of trailKeys(t)) names.set(k, (await this.reporters.get(k))?.machine ?? k);
    return (key) => names.get(key) ?? key;
  }

  /** After every accepted report from a reporter the server recorded (not the simulator, not settings hooks). */
  note(sessionId: string, reporterKey: string, owner: string, report: Report): Promise<void> {
    const s = report.session;
    return this.messages.note({
      sessionId,
      reporterKey,
      owner,
      name: s.name,
      machine: report.machine?.name ?? reporterKey,
      os: report.machine?.os ?? null,
      project: s.repoName ?? s.projectRoot,
      status: s.status,
      waitReason: s.waitReason,
      peers: s.peers,
    });
  }

  /**
   * The reply's messaging fields. `on` is the routes' gate (authentication, the flag, a person's session, the `peers`
   * option); with it off nothing is handed over. Messages go only to an idle orchestrator; notices and requests always.
   */
  async reply(sessionId: string, on: boolean): Promise<PeerReply> {
    const o = on ? this.messages.live(sessionId) : null;
    if (!o) return { peers: false, peerDeliveries: [], peerRequests: [] };
    const requests = (await this.rights.openRequests(o.owner, o.reporterKey)).slice(0, PEER_LIMITS.requests);
    const peerRequests: PeerRequest[] = [];
    for (const r of requests) peerRequests.push(await this.requestView(r));
    return { peers: true, peerDeliveries: await this.messages.deliveriesFor(sessionId, isIdle(o)), peerRequests };
  }

  /**
   * `reply` with the routes' gate worked out here, in the same step as the reply: the orchestrator is live with the `peers`
   * option on and its reporter is a person's. `allowed` is authentication, the flag, and a person's credential.
   */
  async replyFor(sessionId: string, allowed: boolean): Promise<PeerReply> {
    const o = this.messages.live(sessionId);
    const ref = o ? await this.reporters.get(o.reporterKey) : null;
    return this.reply(sessionId, allowed && o?.peers === true && !!ref && !ref.adminSecret);
  }

  /** A request as the owner's sessions and My reporters show it: machines by name, and a message's text for its approval. */
  async requestView(r: PeerRequestRow): Promise<PeerRequest> {
    const machine = async (key: string) => (await this.reporters.get(key))?.machine ?? key;
    const m = r.messageId ? await this.messages.message(r.messageId) : null;
    return {
      id: r.id,
      kind: r.kind,
      at: r.createdAt,
      from: { machine: await machine(r.fromKey), name: m?.fromName ?? (r.kind === 'access' ? r.by : null) },
      to: { machine: await machine(r.toKey), name: m?.toName ?? null },
      level: r.level,
      by: r.by,
      reason: r.reason,
      text: m?.text ?? null,
    };
  }

  /** A request as the owner's read lists it: `requestView`, plus both reporters by key and the message it is about. */
  async ownerRequestView(r: PeerRequestRow): Promise<OwnerRequestView> {
    return { ...(await this.requestView(r)), fromKey: r.fromKey, toKey: r.toKey, messageId: r.messageId };
  }

  /** The owner's defaults, checked against the Admin's limits as they are in the same step, so a limit the Admin just lowered holds. */
  async setDefaults(owner: string, patch: Record<string, unknown>, actor: Actor): ReturnType<PgPeerRights['setDefaults']> {
    return this.rights.setDefaults(owner, patch, await this.settings.limits(), actor);
  }

  serverLimits(): Promise<PeerLimits> {
    return this.settings.limits();
  }

  /**
   * The owner answers a request, from the browser or a session. A message's answer delivers or declines it; an access
   * request's answer reaches the orchestrator that asked as a notice. Either way it closes everywhere at once.
   */
  async answer(id: string, owner: string, answer: PeerAnswer, actor: Actor): Promise<AnswerOutcome | Refusal> {
    const out = await this.rights.answer(id, owner, answer, actor);
    if (!out.ok) return out;
    if ('message' in out) {
      if (out.message.deliver) await this.messages.approve(out.message.id, actor);
      else await this.messages.decline(out.message.id, actor);
      return out;
    }
    const r = out.request;
    if (r.kind === 'access' && r.fromSession) {
      const to = (await this.reporters.get(r.toKey))?.machine ?? r.toKey;
      // The level the right has now: allowing never lowers one, so it can be above what was asked for.
      const level = out.applied?.level ?? r.level;
      const words = level ? LEVEL_WORDS[level].toLowerCase() : 'access';
      this.messages.notice(
        r.fromSession,
        r.outcome === 'allowed' ? `${owner} allowed your request for access to ${to}: ${words}. Run podium_peers to see what you can reach now.` : `${owner} declined your request for access to ${to}.`,
      );
    }
    return out;
  }

  /**
   * `answer`, and for a delivered message whether its link is paused, read in the same step so the answer's `paused` flag
   * is the one the delivery was made under.
   */
  answerPaused(id: string, owner: string, answer: PeerAnswer, actor: Actor): Promise<{ out: AnswerOutcome | Refusal; paused: boolean }> {
    return this.db.tx(async () => {
      const out = await this.answer(id, owner, answer, actor);
      const paused = out.ok && 'message' in out && out.message.deliver && (await this.rights.effective(out.request.fromKey, out.request.toKey)).paused;
      return { out, paused };
    });
  }

  /** What My reporters (GET /respond/peers) shows of one owner, read in one step. */
  ownerView(owner: string, now: number): Promise<OwnerPeersView> {
    return this.db.tx(async () => {
      const server = await this.settings.limits();
      const requests: OwnerRequestView[] = [];
      for (const r of await this.rights.openRequests(owner)) requests.push(await this.ownerRequestView(r));
      return {
        serverStartedAt: this.reporters.startedAt,
        reporters: (await this.reporters.ofOwnerSeen(owner, now)).filter((r) => !r.adminSecret),
        rights: await this.rights.rightsOf(owner),
        defaults: await this.rights.defaults(owner),
        limits: { server, effective: await this.rights.limits(owner, server) },
        requests,
      };
    });
  }

  /**
   * Admin > Reporters > a reporter (#347), or null for an unknown key. The stored rights and requests of every pair of the
   * owner's reporters, not only this one's: the page's Grid draws them all, in one read (#416). The effective levels are
   * this reporter's pairs only, for Pause all links: working them out for every pair would cost a few queries per pair on
   * each poll, and the Grid reads levels from the rights.
   */
  adminView(key: string): Promise<AdminPeersView | null> {
    return this.db.tx(async () => {
      const ref = await this.reporters.get(key);
      if (!ref) return null;
      const owner = ref.owner;
      const mine = owner && !ref.adminSecret ? (await this.reporters.ofOwner(owner)).filter((r) => !r.adminSecret) : [];
      const keys = new Set(mine.map((r) => r.key));
      const effective: AdminPeersView['effective'] = [];
      for (const o of mine) {
        effective.push({ from: ref.key, to: o.key, ...(await this.rights.effective(ref.key, o.key)) });
        if (o.key !== ref.key) effective.push({ from: o.key, to: ref.key, ...(await this.rights.effective(o.key, ref.key)) });
      }
      const requests: OwnerRequestView[] = [];
      if (mine.length && owner) {
        for (const r of (await this.rights.openRequests(owner)).filter((x) => keys.has(x.fromKey) && keys.has(x.toKey))) requests.push(await this.ownerRequestView(r));
      }
      const rights: RightRow[] = owner ? (await this.rights.rightsOf(owner)).filter((r) => keys.has(r.from) && keys.has(r.to)) : [];
      return {
        reporter: ref,
        peers: mine,
        trust: owner && mine.length ? (await this.rights.defaults(owner)).trust : false,
        rights,
        effective,
        requests,
      };
    });
  }

  /** Removes a link, and drops what still waits on it. */
  async removeLink(owner: string | null, a: string, b: string, actor: Actor): Promise<{ ok: true } | Refusal> {
    const out = await this.rights.removeLink(owner, a, b, actor);
    if (out.ok) await this.messages.linkRemoved(a, b);
    return out;
  }

  ended(sessionId: string): Promise<void> {
    return this.messages.ended(sessionId);
  }

  async deleted(sessionIds: string[]): Promise<void> {
    if (sessionIds.length) await this.messages.deleted(sessionIds);
  }

  /** The flag went off: every held message is dropped. */
  dropAll(): Promise<void> {
    return this.messages.dropAll();
  }

  /**
   * The hourly sweep: conversations quiet for the Admin's period, closed requests past it, and messages whose session
   * the server no longer holds (sessions are deleted 30 days after they end).
   */
  retain(): Promise<{ messages: number; requests: number }> {
    return this.db.tx(async () => {
      const cutoff = this.now() - (await this.settings.retainMs());
      const quiet = await this.messages.retain(cutoff);
      const orphans = await this.db.run('DELETE FROM peer_messages WHERE from_session NOT IN (SELECT id FROM sessions) OR to_session NOT IN (SELECT id FROM sessions)');
      return { messages: quiet + orphans, requests: await this.rights.retain(cutoff) };
    });
  }
}
