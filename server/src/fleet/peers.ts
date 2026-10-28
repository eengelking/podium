// Orchestrator messaging (#347, #412, SPEC 7.7): the one place the rights store, the message store and the Admin's
// settings meet. The fleet owns one PeerService; the routes in peerRoutes.ts and the report route call it, and set
// `onRights` and `onMessage` so every right and message event reaches the Admin log and the server log.
import type { DatabaseSync } from 'node:sqlite';
import { PeerRights } from './peerRights.js';
import { PeerMessages } from './peerMessages.js';
import { PeerSettings, type PeerLimits } from './peerSettings.js';
import { isIdle, type Actor, type EffectiveRight, type MachineName, type OwnerDefaults, type RightRow, type SeenReporterRef, type ReporterRef, type AnswerOutcome, type MessageTrail, type OwnerRequestView, type PeerRequestRow, type Refusal, type PeerReporterLookup, type RightsTrail } from './peerTypes.js';
import { PEER_LIMITS, type PeerAnswer, type PeerDelivery, type PeerLevel, type PeerRequest, type Report } from './protocol.js';

/** A level in the words My reporters and the terminal use. */
export const LEVEL_WORDS: Record<PeerLevel, string> = { none: 'No access', see: 'Can see', ask: 'Can send, with approval', send: 'Can send' };

/** What a report's reply carries for messaging (SPEC 6.1). */
export interface PeerReply {
  peers: boolean;
  peerDeliveries: PeerDelivery[];
  peerRequests: PeerRequest[];
}

export { isIdle } from './peerTypes.js';

/** What `ownerView` gives the owner's read: the parts of GET /respond/peers that come from the stores. */
export interface OwnerPeersView {
  serverStartedAt: number;
  reporters: SeenReporterRef[];
  rights: RightRow[];
  defaults: OwnerDefaults;
  limits: { server: PeerLimits; effective: PeerLimits };
  requests: OwnerRequestView[];
}

/** What `adminView` gives Admin > Reporters > a reporter. */
export interface AdminPeersView {
  reporter: ReporterRef;
  peers: ReporterRef[];
  trust: boolean;
  rights: RightRow[];
  effective: ({ from: string; to: string } & EffectiveRight)[];
  requests: OwnerRequestView[];
}

export class PeerService {
  readonly settings: PeerSettings;
  readonly rights: PeerRights;
  readonly messages: PeerMessages;
  /** Replaced by the routes, so a right's event reaches the logs. */
  onRights: (t: RightsTrail, machine: MachineName) => void = () => {};
  /** Replaced by the routes, so a message's event reaches the logs. */
  onMessage: (t: MessageTrail, machine: MachineName) => void = () => {};
  /** Replaced by the routes: runs `fn` with `src` as the address the log rows it causes name. */
  withSource: <T>(src: string, fn: () => T) => T = (_src, fn) => fn();

  constructor(
    private readonly db: DatabaseSync,
    readonly reporters: PeerReporterLookup,
    private readonly now: () => number = Date.now,
    /** The Admin's `peer-messaging` flag. */
    readonly flagOn: () => boolean = () => false,
  ) {
    this.settings = new PeerSettings(db);
    this.rights = new PeerRights(db, reporters, now, (t) => this.onRights(t, this.machineOf));
    this.messages = new PeerMessages(
      db,
      {
        effective: (from, to) => this.rights.effective(from, to),
        limits: (owner) => this.rights.limits(owner, this.settings.limits()),
        openMessageRequest: (input) => this.rights.openMessageRequest(input),
        closeMessageRequest: (id, outcome) => this.rights.closeMessageRequest(id, outcome),
      },
      reporters,
      now,
      (t) => this.onMessage(t, this.machineOf),
    );
  }

  /** A reporter's machine name, read at once from the table, for a trail handler that names machines in its log line. */
  private readonly machineOf: MachineName = (key) => this.reporters.get(key)?.machine ?? key;

  /** After every accepted report from a reporter the server recorded (not the simulator, not settings hooks). */
  note(sessionId: string, reporterKey: string, owner: string, report: Report): void {
    const s = report.session;
    this.messages.note({
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
  reply(sessionId: string, on: boolean): PeerReply {
    const o = on ? this.messages.live(sessionId) : null;
    if (!o) return { peers: false, peerDeliveries: [], peerRequests: [] };
    const requests = this.rights.openRequests(o.owner, o.reporterKey).slice(0, PEER_LIMITS.requests);
    return { peers: true, peerDeliveries: this.messages.deliveriesFor(sessionId, isIdle(o)), peerRequests: requests.map((r) => this.requestView(r)) };
  }

  /**
   * `reply` with the routes' gate worked out here, in the same step as the reply: the orchestrator is live with the `peers`
   * option on and its reporter is a person's. `allowed` is authentication, the flag, and a person's credential.
   */
  replyFor(sessionId: string, allowed: boolean): PeerReply {
    const o = this.messages.live(sessionId);
    const ref = o ? this.reporters.get(o.reporterKey) : null;
    return this.reply(sessionId, allowed && o?.peers === true && !!ref && !ref.adminSecret);
  }

  /** A request as the owner's sessions and My reporters show it: machines by name, and a message's text for its approval. */
  requestView(r: PeerRequestRow): PeerRequest {
    const machine = (key: string) => this.reporters.get(key)?.machine ?? key;
    const m = r.messageId ? this.messages.message(r.messageId) : null;
    return {
      id: r.id,
      kind: r.kind,
      at: r.createdAt,
      from: { machine: machine(r.fromKey), name: m?.fromName ?? (r.kind === 'access' ? r.by : null) },
      to: { machine: machine(r.toKey), name: m?.toName ?? null },
      level: r.level,
      by: r.by,
      reason: r.reason,
      text: m?.text ?? null,
    };
  }

  /** A request as the owner's read lists it: `requestView`, plus both reporters by key and the message it is about. */
  ownerRequestView(r: PeerRequestRow): OwnerRequestView {
    return { ...this.requestView(r), fromKey: r.fromKey, toKey: r.toKey, messageId: r.messageId };
  }

  /** The owner's defaults, checked against the Admin's limits as they are in the same step, so a limit the Admin just lowered holds. */
  setDefaults(owner: string, patch: Record<string, unknown>, actor: Actor): ReturnType<PeerRights['setDefaults']> {
    return this.rights.setDefaults(owner, patch, this.settings.limits(), actor);
  }

  serverLimits(): PeerLimits {
    return this.settings.limits();
  }

  /**
   * The owner answers a request, from the browser or a session. A message's answer delivers or declines it; an access
   * request's answer reaches the orchestrator that asked as a notice. Either way it closes everywhere at once.
   */
  answer(id: string, owner: string, answer: PeerAnswer, actor: Actor): AnswerOutcome | Refusal {
    const out = this.rights.answer(id, owner, answer, actor);
    if (!out.ok) return out;
    if ('message' in out) {
      if (out.message.deliver) this.messages.approve(out.message.id, actor);
      else this.messages.decline(out.message.id, actor);
      return out;
    }
    const r = out.request;
    if (r.kind === 'access' && r.fromSession) {
      const to = this.reporters.get(r.toKey)?.machine ?? r.toKey;
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
  answerPaused(id: string, owner: string, answer: PeerAnswer, actor: Actor): { out: AnswerOutcome | Refusal; paused: boolean } {
    const out = this.answer(id, owner, answer, actor);
    const paused = out.ok && 'message' in out && out.message.deliver && this.rights.effective(out.request.fromKey, out.request.toKey).paused;
    return { out, paused };
  }

  /** What My reporters (GET /respond/peers) shows of one owner, read in one step. */
  ownerView(owner: string, now: number): OwnerPeersView {
    const server = this.settings.limits();
    return {
      serverStartedAt: this.reporters.startedAt,
      reporters: this.reporters.ofOwnerSeen(owner, now).filter((r) => !r.adminSecret),
      rights: this.rights.rightsOf(owner),
      defaults: this.rights.defaults(owner),
      limits: { server, effective: this.rights.limits(owner, server) },
      requests: this.rights.openRequests(owner).map((r) => this.ownerRequestView(r)),
    };
  }

  /**
   * Admin > Reporters > a reporter (#347), or null for an unknown key. The stored rights and requests of every pair of the
   * owner's reporters, not only this one's: the page's Grid draws them all, in one read (#416). The effective levels are
   * this reporter's pairs only, for Pause all links: working them out for every pair would cost a few queries per pair on
   * each poll, and the Grid reads levels from the rights.
   */
  adminView(key: string): AdminPeersView | null {
    const ref = this.reporters.get(key);
    if (!ref) return null;
    const owner = ref.owner;
    const mine = owner && !ref.adminSecret ? this.reporters.ofOwner(owner).filter((r) => !r.adminSecret) : [];
    const keys = new Set(mine.map((r) => r.key));
    return {
      reporter: ref,
      peers: mine,
      trust: owner && mine.length ? this.rights.defaults(owner).trust : false,
      rights: owner ? this.rights.rightsOf(owner).filter((r) => keys.has(r.from) && keys.has(r.to)) : [],
      effective: mine.flatMap((o) => [
        { from: ref.key, to: o.key, ...this.rights.effective(ref.key, o.key) },
        ...(o.key === ref.key ? [] : [{ from: o.key, to: ref.key, ...this.rights.effective(o.key, ref.key) }]),
      ]),
      requests: mine.length && owner ? this.rights.openRequests(owner).filter((r) => keys.has(r.fromKey) && keys.has(r.toKey)).map((r) => this.ownerRequestView(r)) : [],
    };
  }

  /** Removes a link, and drops what still waits on it. */
  removeLink(owner: string | null, a: string, b: string, actor: Actor): { ok: true } | Refusal {
    const out = this.rights.removeLink(owner, a, b, actor);
    if (out.ok) this.messages.linkRemoved(a, b);
    return out;
  }

  ended(sessionId: string): void {
    this.messages.ended(sessionId);
  }

  deleted(sessionIds: string[]): void {
    if (sessionIds.length) this.messages.deleted(sessionIds);
  }

  /** The flag went off: every held message is dropped. */
  dropAll(): void {
    this.messages.dropAll();
  }

  /**
   * The hourly sweep: conversations quiet for the Admin's period, closed requests past it, and messages whose session
   * the server no longer holds (sessions are deleted 30 days after they end).
   */
  retain(): { messages: number; requests: number } {
    const cutoff = this.now() - this.settings.retainMs();
    const quiet = this.messages.retain(cutoff);
    const orphans = Number(
      this.db.prepare('DELETE FROM peer_messages WHERE from_session NOT IN (SELECT id FROM sessions) OR to_session NOT IN (SELECT id FROM sessions)').run().changes,
    );
    return { messages: quiet + orphans, requests: this.rights.retain(cutoff) };
  }
}
