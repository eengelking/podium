// Orchestrator messaging (#347, #412): the types shared by the rights store (peerRights.ts), the message store
// (peerMessages.ts) and the routes that join them (peers.ts, peerRoutes.ts). SPEC 7.7 "Orchestrator messaging" has the
// rules; every one of them holds whatever else is set.
//
// Words used here:
// - A reporter is one machine plus one person's token (`reporters.key`). Rights belong to reporters.
// - A link is an unordered pair of reporters, the same reporter twice included (two orchestrators on one machine).
//   Pause, Remove, the per-minute rate and retention are per link. `linkKey(a, b)` names one.
// - A conversation is the messages between two orchestrators (sessions) on a link. Round trips are counted per
//   conversation, since the last message its owner approved.
// - An orchestrator is a session's main loop. Only an orchestrator sends or receives; a session is one.

import { shortId } from './protocol.js';
import type { PeerLevel, PeerAnswer, PeerRequest, PeerRequestKind, PeerResult, PeerDelivery, ReporterCompat } from './protocol.js';
import type { PeerLimits, ReporterState } from '../storage/rows.js';

export type { PeerLimits } from '../storage/rows.js';

/** `<a>|<b>` with the two keys sorted, so a link has one name whichever way a message goes. */
export function linkKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * A person's end of a link (#1034): `person:<name, folded>`. A link joins two reporters, but when one person writes to another person's agent the
 * link joins that person to the agent's reporter, and `from` is this key. Such a row is owned by the agent's owner, who answers for it; the person
 * may pause or remove it too, and neither may do more than that to the other.
 */
export const isPersonKey = (k: string): boolean => k.startsWith('person:');

/** Whether a level allows sending, and how. */
export const canSee = (l: PeerLevel): boolean => l !== 'none';
export const canSend = (l: PeerLevel): boolean => l === 'ask' || l === 'send';

/** A refusal: the HTTP status the route answers with, and the reason in plain words, said to the person or the model as is. */
export interface Refusal {
  ok: false;
  status: 400 | 403 | 404 | 409 | 410 | 422 | 429;
  error: string;
}
/** The short id of a session (`shortId`): enough to tell same-named orchestrators apart in `name@machine#id`. */
export const peerShortId = (sessionId: string): string => shortId(sessionId);

export const refuse = (status: Refusal['status'], error: string): Refusal => ({ ok: false, status, error });

/** Who did something, for the logs: a person's name, or `Admin` for the admin secret, and whether they acted as an Admin. */
export interface Actor {
  name: string;
  admin: boolean;
}

/** A reporter as the stores need it, read from the reporters table. */
export interface ReporterRef {
  key: string;
  /** The machine name, or the key when the reporter sent none. */
  machine: string;
  /** The owner's name as the server recorded it; null with authentication off. */
  owner: string | null;
  /** True when it reports with the admin secret: such a reporter belongs to no one and never takes part. */
  adminSecret: boolean;
  os: string | null;
  /** The `peers` option as last reported; null from a reporter too old to send it. */
  peers: boolean | null;
  version: string;
  /** Which reporter it is (`reporter.name`), so a version warning names it (#852). */
  reporterName: string;
}

/** A reporter's machine name by key, or the key itself when it is unknown. A trail handler gets one that answers at once. */
export type MachineName = (key: string) => string;

/** Looks a reporter up by key, and lists one owner's reporters (compared case-insensitively, `nameKey`). */
export interface ReporterLookup {
  get(key: string): ReporterRef | null;
  ofOwner(owner: string): ReporterRef[];
}

/** A reporter with its state and last report, worked out as Admin > Reporters works them out (#415). */
export interface SeenReporterRef extends ReporterRef {
  state: ReporterState;
  lastSeenAt: number;
  /** The reporter's version against what this server supports, as Admin > Reporters shows it. */
  compat: ReporterCompat;
}

/** The lookup the reporters table gives the service: also what the owner's read on My reporters lists (#415). */
export interface PeerReporterLookup extends ReporterLookup {
  /** When the server started: a reporter last heard before it is "Not since restart". */
  readonly startedAt: number;
  ofOwnerSeen(owner: string, now: number): SeenReporterRef[];
}

// ---- Rights, defaults and requests (peerRights.ts, agent A) ---------------------------------------------------

/** What an owner sets on My reporters > Defaults. */
export interface OwnerDefaults {
  /** Trust my own reporters: every pair of the owner's reporters can send without approval, reporters added later included. */
  trust: boolean;
  /** When an orchestrator asks for access with podium_request_access: Ask me, Allow or Decline. Never applies to an Admin's proposal. */
  onRequest: 'ask' | 'allow' | 'decline';
  /** A new right to send starts as With approval (`ask`) or Without approval (`send`). */
  newSend: 'ask' | 'send';
  /** The owner's stricter limits, each at most the Admin's; a missing one takes the Admin's. */
  limits: Partial<PeerLimits>;
}

export const OWNER_DEFAULTS: OwnerDefaults = { trust: false, onRequest: 'ask', newSend: 'ask', limits: {} };

/** One direction between two reporters, as stored. */
export interface RightRow {
  from: string;
  to: string;
  owner: string;
  level: PeerLevel;
  paused: boolean;
  /** Who paused a person's link (#1034): the person who writes, the agent's owner, or an Admin. Absent when the link is not paused, and for a pause made before it was kept. */
  pausedBy?: LinkPauser;
  setAt: number;
}

/** Who paused a link between a person and another person's agent (#1034). Only they, or an Admin, can resume it. */
export type LinkPauser = 'sender' | 'owner' | 'admin';
export const LINK_PAUSERS: readonly LinkPauser[] = ['sender', 'owner', 'admin'];

/** The right that applies now: `send` under Trust, else the stored level; `paused` from the stored row. */
export interface EffectiveRight {
  level: PeerLevel;
  paused: boolean;
}

/** The most messages one person may have waiting for one owner's approval (#1034), so a flood cannot fill an owner's list. */
export const CROSS_PENDING_MAX = 5;

export type PersonLinkOp = 'allow' | 'pause' | 'resume' | 'remove';
export const PERSON_LINK_OPS: readonly PersonLinkOp[] = ['allow', 'pause', 'resume', 'remove'];

export interface PeerRequestRow {
  id: string;
  owner: string;
  kind: PeerRequestKind;
  /** The reporter that would get the right, or the sending reporter of a message. */
  fromKey: string;
  toKey: string;
  /** The right proposed or asked for; null for a message. */
  level: PeerLevel | null;
  /** An orchestrator's reason, for an access request. */
  reason: string | null;
  /** `Admin` for a proposal; the orchestrator's name for an access request or a message. */
  by: string;
  /** The session that asked (an access request) or sent (a message), so its answer can reach it as a notice. */
  fromSession: string | null;
  messageId: string | null;
  createdAt: number;
  closedAt: number | null;
  outcome: 'allowed' | 'declined' | 'delivered' | 'dropped' | null;
}

/**
 * A request as the owner's read lists it (GET /respond/peers): the protocol's view, plus both reporters by key, so My
 * reporters matches it to a Grid cell even when two machines share a name, and the message it is about. The mod's
 * `peerRequests` keep the protocol's shape.
 */
export type OwnerRequestView = PeerRequest & { fromKey: string; toKey: string; messageId: string | null; /** The request is a person's message to this owner's agent (#1034): `fromKey` is `person:<name>`, not a reporter. */ fromPerson: boolean };

/** What answering a request did. For a message, the message store acts on `message`. */
export type AnswerOutcome =
  | { ok: true; request: PeerRequestRow; applied: RightRow | null }
  | { ok: true; request: PeerRequestRow; message: { id: string; deliver: boolean } };

/** What podium_request_access led to, by the owner's default. */
export type AccessOutcome =
  | { ok: true; state: 'asked'; request: PeerRequestRow }
  | { ok: true; state: 'allowed'; applied: RightRow }
  | { ok: true; state: 'declined' };

/**
 * The rights store. Every write that joins two reporters refuses (403) when their owners differ (case-insensitive) or
 * either reports with the admin secret or is owned by `Admin`, whatever the settings say, and stores nothing then.
 * Owner checks of the caller (is this browser's person the owner of `from`) are done by the caller, through `owner`
 * arguments, so the store can say "not your reporter" (403).
 */
export interface PeerRightsApi {
  defaults(owner: string): OwnerDefaults;
  /** Changes some defaults. A limit over the Admin's (`server`) or out of range is a 400 and nothing changes. */
  setDefaults(owner: string, patch: Record<string, unknown>, server: PeerLimits, actor: Actor): { ok: true; defaults: OwnerDefaults } | Refusal;
  /** The limits that apply to an owner's links: the stricter of the Admin's and the owner's. */
  limits(owner: string, server: PeerLimits): PeerLimits;

  effective(from: string, to: string): EffectiveRight;
  /** Every stored row between the owner's reporters. */
  rightsOf(owner: string): RightRow[];
  /** The owner sets one direction (`none` deletes it, keeping a paused flag only if it was paused). */
  setRight(owner: string, from: string, to: string, level: PeerLevel, actor: Actor): { ok: true; right: RightRow | null } | Refusal;
  /** The owner, or an Admin at once, pauses or resumes both directions of a link. Keeps the rights. */
  pauseLink(owner: string | null, a: string, b: string, paused: boolean, actor: Actor): { ok: true } | Refusal;
  /** The owner, or an Admin at once, removes both directions of a link. Under Trust it leaves the link paused, so a removal holds. */
  removeLink(owner: string | null, a: string, b: string, actor: Actor): { ok: true } | Refusal;
  /** An Admin's Pause all links (or resume) for one reporter: every link it is in, at once, under Trust too. */
  pauseReporter(key: string, paused: boolean, actor: Actor): { ok: true; links: number } | Refusal;
  /** The link from a person (`person:<name>`) to an agent's reporter, or null when there is none. A `none` row is a removed link: it holds, so the person cannot ask again by writing again. */
  personLink(personKey: string, toKey: string): RightRow | null;
  /**
   * Changes the link between a person and another person's reporter (#1034): `allow` opens it (sending without approval), `pause` and `resume` hold and
   * release what goes over it, `remove` leaves a removed link. It never lets a person touch their own reporters, and it is refused (403) for a reporter
   * on the admin secret. Who may ask (the reporter's owner, the person, an Admin) is the caller's check.
   */
  /** `pausedBy` is kept with a pause (#1034): who may resume it. */
  setPersonLink(personKey: string, toKey: string, op: PersonLinkOp, actor: Actor, pausedBy?: LinkPauser): { ok: true; right: RightRow | null } | Refusal;

  /** An Admin proposes a right; it applies only when the owner accepts it. No default accepts it. */
  propose(from: string, to: string, level: PeerLevel, actor: Actor): { ok: true; request: PeerRequestRow } | Refusal;
  /** An orchestrator asks for a right to see or send, through the owner's default. A right to send is created as `newSend`. */
  requestAccess(input: { owner: string; fromKey: string; toKey: string; right: 'see' | 'send'; reason: string; by: string; fromSession: string }): AccessOutcome | Refusal;
  /** Opens the approval request for a message that waits for its owner. */
  openMessageRequest(input: { owner: string; fromKey: string; toKey: string; by: string; fromSession: string; messageId: string }): PeerRequestRow;
  /** Closes a message's request when the message is dropped or delivered some other way. A no-op when there is none. */
  closeMessageRequest(messageId: string, outcome: 'delivered' | 'dropped' | 'declined'): void;
  /** Open requests of one owner, oldest first; with `about`, only those whose from or to reporter is that key. */
  openRequests(owner: string, about?: string): PeerRequestRow[];
  getRequest(id: string): PeerRequestRow | null;
  /**
   * The owner answers (from the browser or a session): `allow` a proposal or access request, `deliver` a message,
   * `decline` either. 404 unknown, 403 another owner's, 410 already closed (with how), 422 an answer that does not fit.
   */
  answer(id: string, owner: string, answer: PeerAnswer, actor: Actor): AnswerOutcome | Refusal;
  /** Deletes closed requests older than `cutoff`, and requests about a reporter that no longer exists. */
  retain(cutoff: number): number;
}

// ---- Messages (peerMessages.ts, agent B) -----------------------------------------------------------------------

/** One live orchestrator, as its last report described it. Kept in memory and refilled by the next report after a restart. */
export interface LiveOrchestrator {
  sessionId: string;
  reporterKey: string;
  /** The session's owner as the server decided it from the token. */
  owner: string;
  name: string;
  machine: string;
  os: string | null;
  project: string | null;
  status: 'running' | 'waiting' | 'done';
  waitReason: 'permission' | 'input' | null;
  /** The `peers` option in this report; undefined from a reporter too old to send it, whose sessions are never listed. */
  peers: boolean | undefined;
}

/** A session that can take a message now: idle at the prompt, with no permission dialog open. */
export const isIdle = (o: Pick<LiveOrchestrator, 'status' | 'waitReason'>): boolean => o.status === 'waiting' && o.waitReason !== 'permission';

/** What the message store needs from the rights store: a narrow view, so either can be tested alone. */
export interface PeerRightsView {
  effective(from: string, to: string): EffectiveRight;
  personLink: PeerRightsApi['personLink'];
  limits(owner: string): PeerLimits;
  openMessageRequest: PeerRightsApi['openMessageRequest'];
  closeMessageRequest: PeerRightsApi['closeMessageRequest'];
}

/** Where a message is. `approval` waits for the owner; `ready` waits for the receiver to be idle; `handed` is in a reply with no result yet. */
export type MessageState = 'approval' | 'ready' | 'handed' | 'queued' | 'delivered' | 'declined' | 'dropped';
export const HELD_STATES: readonly MessageState[] = ['approval', 'ready', 'handed', 'queued'];

/** Why the server let go of a held message. Each is said to its sender in a notice and written to the logs. */
export type DropWhy = 'receiver-ended' | 'session-deleted' | 'link-removed' | 'messaging-off' | 'refused';

/** Who wrote a message: an agent (an orchestrator, over podium_send) or the owning person (from the Chat page, #1034). Every message stored before this was an agent's. */
export type MessageAuthor = 'agent' | 'person';

export interface MessageRow {
  id: string;
  owner: string;
  link: string;
  fromKey: string;
  toKey: string;
  fromSession: string;
  toSession: string;
  fromName: string;
  fromMachine: string;
  toName: string;
  toMachine: string;
  text: string;
  sentAt: number;
  state: MessageState;
  stateAt: number;
  why: DropWhy | null;
  /** The owner approved this one (a link with approval, or past the round-trip cap); round trips count from the last such message. */
  approved: boolean;
  /**
   * Who wrote it. A person's message has `fromName` the person's name and no machine; its `fromSession` is the other agent of the conversation when the
   * person added to a conversation between two agents, and `person:<owner, folded>` when it is the person with one agent (a conversation of their own).
   */
  author: MessageAuthor;
}

/** One page of a conversation, oldest first within the page. `older` is the cursor for the page before it, or null when this one starts the conversation. */
export interface MessagePage {
  messages: MessageRow[];
  older: string | null;
}

/** What the person writes in the Chat page to one of their agents (#1034). */
export interface PersonMessageInput {
  owner: string;
  /** The name the message shows. */
  person: string;
  /** The agent that gets it. */
  toSession: string;
  /** The other agent of the conversation the person is adding to; absent for the person's own conversation with `toSession`. */
  withSession?: string;
  text: string;
}

/** What a person writes to another person's agent (#1034). It is held for the agent's owner unless the owner has opened a link to the person. */
export interface AcrossInput {
  /** The person's name as shown. */
  person: string;
  /** The agent that would get it. */
  toSession: string;
  text: string;
}

/** What podium_send answers when a message was taken. `paused` says the link is paused, so it waits for a resume too. */
export interface SendOutcome {
  ok: true;
  id: string;
  /** `sent`: the receiver is idle and gets it in its next reply. `turn`: it gets it when its turn ends. `approval`: it waits for the owner. */
  state: 'sent' | 'turn' | 'approval';
  paused: boolean;
  /** Why it waits for approval: the link needs it, or the round-trip cap was reached. */
  approvalWhy: 'link' | 'round-trips' | null;
  /** The approval request's id, when it waits for one. */
  requestId: string | null;
  to: { name: string; machine: string };
  /** Round trips in this conversation since the last approval, after this message, and the cap. */
  roundTrips: { used: number; cap: number };
  /** Set when the message was an answer to a person who wrote to this agent through Chat (#1034): stored as delivered, with no orchestrator to hand it to. */
  person?: true;
}

/** A person who wrote to this agent through Chat and whom it may answer with `podium_send` to `person:<name>` (#1034): the owner's link to them is open or paused. */
export interface PersonListing {
  address: string;
  name: string;
  paused: boolean;
}

/** What podium_peers answers: the orchestrators, the machines left out, and the people this agent may answer. */
export interface PeerListResult {
  peers: PeerListing[];
  leftOut: LeftOut[];
  people: PersonListing[];
}

/** One orchestrator in podium_peers' answer. */
export interface PeerListing {
  address: string;
  /** The session's short id (`peerShortId`), which `address#id` accepts when other orchestrators share the name (#500). */
  id: string;
  /** More than one orchestrator the asker can reach has this name on this machine, so a plain `address` is refused. */
  duplicate: boolean;
  name: string;
  machine: string;
  os: string | null;
  project: string | null;
  status: 'running' | 'waiting' | 'done';
  /** What the asking orchestrator can do there: see only, send with approval, send. */
  level: Exclude<PeerLevel, 'none'>;
  paused: boolean;
}

/** One of the owner's reporters podium_peers leaves out, and why, in words. */
export interface LeftOut {
  machine: string;
  why: 'messaging off on the machine' | 'reporter too old to message' | 'no right to see it' | 'no orchestrator running';
}

/** A conversation as Traffic and My reporters list it: never the text. */
export interface ConversationSummary {
  link: string;
  /** The two orchestrators, ordered by session id. */
  a: { sessionId: string; name: string; machine: string; reporterKey: string };
  b: { sessionId: string; name: string; machine: string; reporterKey: string };
  owner: string;
  messages: number;
  lastAt: number;
  /** `waiting` while a message waits for approval, `paused` while the link is paused, else `active`. */
  state: 'active' | 'waiting' | 'paused';
  /** Whether the link is paused, which `state` hides while a message also waits for approval (#417). */
  paused: boolean;
  /** Whether each direction can send now. */
  aToB: boolean;
  bToA: boolean;
  roundTrips: { used: number; cap: number };
}

/** A conversation as the Chat page lists it: `hiddenAt` is when every agent in it had left, or null while it is shown. */
export interface OwnerConversation extends ConversationSummary {
  hiddenAt: number | null;
}

/** A log line's worth of a message event: never the text. */
export type MessageTrail =
  | { kind: 'sent'; message: MessageRow; state: SendOutcome['state']; approvalWhy: SendOutcome['approvalWhy'] }
  | { kind: 'delivered'; message: MessageRow }
  | { kind: 'declined'; message: MessageRow; actor: Actor }
  | { kind: 'approved'; message: MessageRow; actor: Actor }
  | { kind: 'dropped'; message: MessageRow; why: DropWhy };

/** A log line's worth of a rights event. */
export type RightsTrail =
  | { kind: 'set'; right: RightRow | { from: string; to: string; owner: string; level: 'none' }; actor: Actor }
  | { kind: 'paused' | 'resumed'; owner: string; a: string; b: string; actor: Actor }
  | { kind: 'removed'; owner: string; a: string; b: string; actor: Actor }
  | { kind: 'person-link'; op: PersonLinkOp; owner: string; person: string; toKey: string; actor: Actor }
  | { kind: 'proposed'; request: PeerRequestRow; actor: Actor }
  | { kind: 'access-requested'; request: PeerRequestRow }
  | { kind: 'accepted' | 'declined'; request: PeerRequestRow; actor: Actor }
  | { kind: 'defaults'; owner: string; actor: Actor };

/**
 * The message store. Text is cleaned of control characters other than line breaks before any check, and then refused
 * (never cut) over the owner's `maxChars`. `to` is `name@machine`, resolved only among the sender owner's live
 * orchestrators whose last report said `peers: true`; an unknown, ambiguous, or unseen (no right to see) name is a
 * 404 that does not say which. Sending to oneself is a 422. A right to see only is a 403 that says to ask for access.
 * Over the per-minute rate on the link is a 429 that says to wait. Past the round-trip cap the message waits for
 * approval, as it does on a link with approval. Nothing is stored for a refused message.
 */
export interface PeerMessagesApi {
  /** Notes a live orchestrator from its report (the server calls it after every accepted report). */
  note(o: LiveOrchestrator): void;
  live(sessionId: string): LiveOrchestrator | null;
  /** One stored message by id, with its text, or null. */
  message(id: string): MessageRow | null;
  /** What podium_peers answers for this orchestrator. */
  list(sessionId: string): PeerListResult;
  send(fromSession: string, to: string, text: string): SendOutcome | Refusal;
  /** The messages and notices for this orchestrator, oldest first, at most 20; messages only while `idle`. Marks messages handed. */
  deliveriesFor(sessionId: string, idle: boolean): PeerDelivery[];
  /** The mod's result. `new`, `repeat` (the same result again, logged once), or `unknown` (404). */
  result(sessionId: string, id: string, result: PeerResult): 'new' | 'repeat' | 'unknown';
  /** The owner approved a message waiting for approval: it becomes `ready`, and round trips count from it. */
  approve(messageId: string, actor: Actor): boolean;
  /** The owner declined it: `declined`, and its sender is told. */
  decline(messageId: string, actor: Actor): boolean;
  /** Queues Podium's own sentence for an orchestrator (memory only, at most 20 per session). */
  notice(sessionId: string, text: string): void;
  /** The receiver ended (reported done, or left the live set): its held messages are dropped and their senders told. */
  ended(sessionId: string): void;
  /** Sessions were deleted: their held messages are dropped, then every message they sent or received is deleted. */
  deleted(sessionIds: string[]): void;
  /** A link was removed: its held messages are dropped, and their senders told. */
  linkRemoved(a: string, b: string): void;
  /** The flag went off: every held message is dropped, notices are cleared. */
  dropAll(): void;
  conversations(filter: { owner?: string; since?: number; liveOnly?: boolean }): ConversationSummary[];
  /** Every message of one conversation, oldest first, with text. The caller checks who may read it. */
  conversation(a: string, b: string): MessageRow[];
  /** Deletes messages on links whose newest message is older than `cutoff`. Returns how many. */
  retain(cutoff: number): number;
  /** The person writes to one of their live agents (#1034); see `PersonMessageInput`. Stored `ready`, so the agent's next delivery carries it. */
  sendFromPerson(input: PersonMessageInput): MessageRow | Refusal;
  /** One page of the owner's conversation, the newest page first; `before` is the `older` of the page after it. A cursor that was not given out throws. */
  page(owner: string, a: string, b: string, opts: { before?: string | null; limit: number }): MessagePage;
  /**
   * A person writes to an agent of another person (#1034). Stored `approval` with a request for the agent's owner when no link is open, `ready` when one
   * is, and refused when the link was removed or is paused, when a message from this person already waits for the owner, or when the person already has
   * too many waiting at this owner. Everything it says names only the agent written to, never another of the owner's.
   */
  sendAcross(input: AcrossInput): MessageRow | Refusal;
  /** Deletes the owner's messages of one conversation. Returns how many. */
  deleteConversation(owner: string, a: string, b: string): number;
  /** The conversations `owner` owns, newest first, hidden ones only when `includeHidden`; and those `owner` took part in as the person who wrote to another person's agent (#1034). Never another person's other conversations. */
  ownerConversations(owner: string, opts?: { includeHidden?: boolean }): OwnerConversation[];
  /** Hides the owner's conversation (every agent in it has left), keeping its messages. Returns how many it marked; 0 when it is hidden already. */
  hideConversation(owner: string, a: string, b: string): number;
  /** Shows a hidden conversation again (the same peers are back). Returns how many it cleared. */
  showConversation(owner: string, a: string, b: string): number;
  /** Deletes the messages of conversations hidden before `olderThan`. Returns how many. */
  purgeHidden(olderThan: number): number;
}
