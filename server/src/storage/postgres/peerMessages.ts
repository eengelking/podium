// Orchestrator messaging (#347, #412): the message store. SPEC 7.7 "Orchestrator messaging" has the rules and 5.3 the
// reporter's side. Messages, with their text, are kept in `peer_messages` (db.ts migration 20) until retention or their
// sessions' deletion; the live directory of orchestrators and Podium's own notices to them are memory only, and the
// next report refills the directory after a restart. Nothing is stored for a refused message, and nothing here logs:
// each event goes to `trail` as a row, and the routes decide what to write (never the text).
import { randomBytes } from 'node:crypto';
import { PEER_LIMITS, type PeerDelivery, type PeerResult } from '../../fleet/protocol.js';
import {
  HELD_STATES,
  CROSS_PENDING_MAX,
  personKeyOf,
  type AcrossInput,
  canSend,
  takesMessages,
  linkKey,
  refuse,
  type Actor,
  type ConversationSummary,
  type DropWhy,
  type EffectiveRight,
  type LeftOut,
  type PeerListResult,
  type PersonListing,
  type LiveInput,
  type LiveOrchestrator,
  type MessageAuthor,
  type MessagePage,
  type MessageRow,
  type PeerChange,
  type PeerMessageEdit,
  type MessageState,
  type OwnerConversation,
  type PersonMessageInput,
  type MessageTrail,
  type PeerRequestRow,
  type Refusal,
  type RightRow,
  type SendOutcome,
} from '../../fleet/peerTypes.js';
import { nameKey } from '../rows.js';
import { decideChange, overLimitWords } from '../peerEdit.js';
import { countConversations, type ConversationGroupRow } from '../conversationCounts.js';
import { headOf, linksOf, pairsOf, toSummary, type SummaryHead } from '../peerSummary.js';
import { leftOutWhy, listingOf, mayBeLeftOut, onPersonReporter, reachedOf, rightKeys, sameOwnerOn, sortListings } from '../peerReach.js';
import type { PeerLimits } from '../settings.js';
import type { AsyncPeerReporterLookup } from '../types.js';
import { MAX_NOTICES, REPLY_WORDS, cleanNameText, cleanPeerText, decodeCursor, encodeCursor, latestOf, pageSize, roundTripsUsed, settleName, type TripRow } from '../peerText.js';
import type { PgDb } from './conn.js';

const RATE_WINDOW_MS = 60_000;

interface DbMessage {
  id: string;
  owner: string;
  owner_id?: number | null;
  link: string;
  from_key: string;
  to_key: string;
  from_session: string;
  to_session: string;
  from_name: string;
  from_machine: string;
  to_name: string;
  to_machine: string;
  text: string;
  sent_at: number;
  state: string;
  state_at: number;
  why: string | null;
  approved: number;
  author: string;
  author_id?: number | null;
  from_agent?: number | null;
  to_agent?: number | null;
  edited_at?: number | null;
  deleted_at?: number | null;
  hidden_at?: number | null;
  seq?: number;
}

interface Notice {
  id: string;
  at: number;
  text: string;
}

const newId = (): string => `dlv_${randomBytes(12).toString('hex')}`;

/** Two session ids, the smaller first, as a conversation names its ends. */
const ordered = (x: string, y: string): [string, string] => (x <= y ? [x, y] : [y, x]);

const toRow = (r: DbMessage): MessageRow => ({
  id: r.id,
  owner: r.owner,
  ownerId: r.owner_id == null ? null : Number(r.owner_id),
  link: r.link,
  fromKey: r.from_key,
  toKey: r.to_key,
  fromSession: r.from_session,
  toSession: r.to_session,
  fromName: r.from_name,
  fromMachine: r.from_machine,
  toName: r.to_name,
  toMachine: r.to_machine,
  // A tombstone has no text, even if a write that should have emptied it went wrong.
  text: r.deleted_at == null ? r.text : '',
  sentAt: r.sent_at,
  state: r.state as MessageState,
  stateAt: r.state_at,
  why: r.why as DropWhy | null,
  approved: r.approved === 1,
  author: r.author as MessageAuthor,
  authorId: r.author_id == null ? null : Number(r.author_id),
  fromAgent: r.from_agent == null ? null : Number(r.from_agent),
  toAgent: r.to_agent == null ? null : Number(r.to_agent),
  editedAt: r.edited_at == null ? null : Number(r.edited_at),
  deletedAt: r.deleted_at == null ? null : Number(r.deleted_at),
});

/** Why a held message was let go, as its sender's notice says it. `messaging-off` tells no one, so it has no words. */
function dropReason(m: MessageRow, why: Exclude<DropWhy, 'messaging-off'>): string {
  switch (why) {
    case 'receiver-ended':
      return `${m.toName}${m.toAgent === null ? '' : ` (id ${m.toAgent})`} is no longer available, because it ended first`;
    case 'session-deleted':
      return `${m.toName}'s session was deleted in Podium`;
    case 'link-removed':
      return `the link between ${m.fromMachine} and ${m.toMachine} was removed`;
    default:
      return `${m.toName}'s session did not take it`;
  }
}

const HELD_SQL = HELD_STATES.map((s) => `'${s}'`).join(', ');
/**
 * A hidden conversation is due for deletion when it has been hidden longer than the longest resume window of its two agents (#1113): the days the
 * harness lets a person resume them, which `sessions.resume_window_days` holds. When neither agent has a known window (a session stored before it was
 * reported, or a person's end of a conversation) the grace period decides. The two placeholders are `now` and `now - graceMs`.
 */
const HIDDEN_DUE_SQL = `hidden_at IS NOT NULL AND hidden_at < COALESCE(CAST(? AS BIGINT) - (SELECT MAX(resume_window_days) FROM sessions WHERE id IN (from_session, to_session)) * 86400000, CAST(? AS BIGINT))`;
const TRIP_COLS = 'from_session, state, approved, author';
const PAIR_WHERE = '(from_session = ? AND to_session = ?) OR (from_session = ? AND to_session = ?)';


/** What the message store needs from the rights store: a narrow view, so either can be tested alone. */
export interface PgPeerRightsView {
  effective(from: string, to: string): Promise<EffectiveRight>;
  effectiveMany(links: readonly (readonly [string, string])[]): Promise<EffectiveRight[]>;
  personLink(personKey: string, toKey: string): Promise<RightRow | null>;
  limits(ownerId: number | null): Promise<PeerLimits>;
  limitsMany(ownerIds: readonly (number | null)[]): Promise<PeerLimits[]>;
  openMessageRequest(input: { owner: string; ownerId: number; fromKey: string; toKey: string; by: string; fromSession: string; messageId: string }): Promise<PeerRequestRow>;
  closeMessageRequest(messageId: string, outcome: 'delivered' | 'dropped' | 'declined'): Promise<void>;
}

export class PgPeerMessages {
  private readonly liveDir = new Map<string, LiveOrchestrator>();
  private readonly notices = new Map<string, Notice[]>();

  constructor(
    private readonly db: PgDb,
    private readonly rights: PgPeerRightsView,
    private readonly reporters: AsyncPeerReporterLookup,
    private readonly now: () => number = Date.now,
    /** It may be async: the step waits for it. */
    private readonly trail: (t: MessageTrail) => void | Promise<void> = () => {},
  ) {}

  private async rows(sql: string, args: (string | number)[] = []): Promise<MessageRow[]> {
    return (await this.db.all<DbMessage>(sql, args)).map(toRow);
  }

  private async row(id: string): Promise<MessageRow | null> {
    const r = await this.db.get<DbMessage>('SELECT * FROM peer_messages WHERE id = ?', [id]);
    return r ? toRow(r) : null;
  }

  /** One stored message by id, with its text, or null. */
  message(id: string): Promise<MessageRow | null> {
    return this.row(id);
  }

  private async setState(id: string, state: MessageState, why: DropWhy | null = null): Promise<MessageRow> {
    await this.db.run('UPDATE peer_messages SET state = ?, why = ?, state_at = ? WHERE id = ?', [state, why, this.now(), id]);
    return (await this.row(id)) as MessageRow;
  }

  // ---- The live directory ------------------------------------------------------------------------------------------

  async note(o: LiveInput): Promise<void> {
    if (o.status === 'done') {
      await this.ended(o.sessionId);
      return;
    }
    const prev = this.liveDir.get(o.sessionId);
    const agentId = prev?.agentId ?? (await this.agentIdOf(o.sessionId));
    // Read after the await, so the names taken are those as the directory is when this one is written.
    this.liveDir.set(o.sessionId, { ...o, agentId, name: this.settledName(o, this.liveDir.get(o.sessionId) ?? prev) });
  }

  /** The agent id of a session that has one, or null (a conversation's other end that the server never heard report). */
  private async agentOf(sessionId: string): Promise<number | null> {
    const r = await this.db.get<{ id: number }>('SELECT id FROM agent_ids WHERE session_id = ?', [sessionId]);
    return r ? Number(r.id) : null;
  }

  /** The id the server gave this session (#1284), made on the first report and never changed: one row per session id, and a number is never handed out twice. */
  private async agentIdOf(sessionId: string): Promise<number> {
    await this.db.run('INSERT INTO agent_ids (session_id) VALUES (?) ON CONFLICT (session_id) DO NOTHING', [sessionId]);
    return (await this.agentOf(sessionId)) as number;
  }

  /** The agent's name with no other live agent of its owner holding it (#1284): its reported name, or that name and the first free number from 2 ("Lower Left 2"); one it already has stays while it is free. */
  private settledName(o: LiveInput, prev: LiveOrchestrator | undefined): string {
    const taken = new Set([...this.liveDir.values()].filter((x) => x.sessionId !== o.sessionId && x.ownerId === o.ownerId).map((x) => nameKey(x.name)));
    return settleName(o.name, prev?.name, taken, nameKey);
  }

  live(sessionId: string): LiveOrchestrator | null {
    return this.liveDir.get(sessionId) ?? null;
  }

  /** Whether the orchestrator runs on its person's own reporter (`onPersonReporter`), read for this one. */
  private async onOwnReporter(o: LiveOrchestrator): Promise<boolean> {
    return onPersonReporter(o, await this.reporters.get(o.reporterKey));
  }

  /**
   * The orchestrators `sender` could reach: the same owner's, messaging on, on a person's reporter, and seen by the sender's reporter. The sender itself is kept. The reporters are read once and the
   * sender's rights once for all of them (#1296), so this costs the same for five orchestrators as for fifty. `rights` is the sender's right to each reporter it read, and to those in `more`.
   */
  private async reach(sender: LiveOrchestrator, more: readonly string[] = []): Promise<{ live: LiveOrchestrator[]; rights: ReadonlyMap<string, EffectiveRight> }> {
    const candidates = sameOwnerOn(sender, this.liveDir.values());
    const reporters = new Map((await this.reporters.getMany(candidates.map((o) => o.reporterKey))).map((r) => [r.key, r]));
    const keys = rightKeys(sender, candidates, reporters, more);
    const got = await this.rights.effectiveMany(keys.map((k) => [sender.reporterKey, k] as const));
    const rights = new Map(keys.map((k, i) => [k, got[i] as EffectiveRight]));
    return { live: reachedOf(sender, candidates, { reporters, rights }), rights };
  }

  private async reachable(sender: LiveOrchestrator): Promise<LiveOrchestrator[]> {
    return (await this.reach(sender)).live;
  }

  /** The sender, when it can take part: live, messaging on, on a person's reporter. */
  private async sender(sessionId: string): Promise<(LiveOrchestrator & { ownerId: number }) | null> {
    const s = this.liveDir.get(sessionId);
    return s && s.ownerId !== null && s.peers === true && (await this.onOwnReporter(s)) ? (s as LiveOrchestrator & { ownerId: number }) : null;
  }

  /** The people who wrote to this agent through Chat and whose link is still there (#1034); one who has no link, or whose was removed, is not listed. */
  private async peopleOf(sender: LiveOrchestrator): Promise<PersonListing[]> {
    const rows = await this.db.all<{ from_session: string; from_name: string }>(`SELECT from_session, from_name FROM peer_messages WHERE to_session = ? AND author = 'person' AND substr(from_session, 1, 7) = 'person:' ORDER BY sent_at, seq`, [sender.sessionId]);
    const names = new Map(rows.map((r) => [r.from_session, r.from_name]));
    const out: PersonListing[] = [];
    for (const [address, name] of names) {
      const link = await this.rights.personLink(address, sender.reporterKey);
      if (link && link.level !== 'none') out.push({ address, name, paused: link.paused });
      else if (!link && sender.ownerId !== null && address === personKeyOf(sender.ownerId)) out.push({ address, name, paused: false });
    }
    return out.sort((a, b) => a.address.localeCompare(b.address));
  }

  async list(sessionId: string): Promise<PeerListResult> {
    const sender = await this.sender(sessionId);
    if (!sender) return { peers: [], leftOut: [], people: [] };
    const machines = (await this.reporters.ofOwner(sender.ownerId)).filter((r) => mayBeLeftOut(r, sender));
    const { live, rights } = await this.reach(sender, machines.filter((r) => r.peers === true).map((r) => r.key));
    const others = live.filter((o) => o.sessionId !== sender.sessionId);
    const peers = sortListings(others.map((o) => listingOf(o, rights.get(o.reporterKey) as EffectiveRight)));
    const listed = new Set(others.map((o) => o.reporterKey));
    const leftOut: LeftOut[] = machines.filter((r) => !listed.has(r.key)).map((r) => ({ machine: r.machine, why: leftOutWhy(r, rights.get(r.key)) }));
    return { peers, leftOut, people: await this.peopleOf(sender) };
  }

  // ---- Sending -----------------------------------------------------------------------------------------------------

  /** `name@machine`, split at the last `@`, among the orchestrators the sender can reach. `name@machine#id` pins one by its never-reused id (#500, #1284). */
  private async resolve(sender: LiveOrchestrator, to: string): Promise<LiveOrchestrator | Refusal> {
    const address = to.trim();
    const unseen = refuse(404, `You cannot see an orchestrator called ${address}. Run podium_peers for the list.`);
    // A bare `#id` is the agent's id alone (#1284): it names one agent whatever it is called.
    const bare = /^#(\d+)$/.exec(address);
    if (bare) return (await this.byAgentId(sender, Number(bare[1]), address)) ?? unseen;
    const at = address.lastIndexOf('@');
    if (at < 0) return unseen;
    const name = nameKey(address.slice(0, at));
    const rest = address.slice(at + 1);
    const hash = rest.lastIndexOf('#');
    const reachable = await this.reachable(sender);
    const onMachine = (m: string): LiveOrchestrator[] => reachable.filter((o) => nameKey(o.name) === name && nameKey(o.machine) === nameKey(m));
    let matches = onMachine(hash < 0 ? rest : rest.slice(0, hash));
    // A machine whose own name holds a `#` is still addressable by the whole text (#500).
    const wholeName = hash >= 0 && matches.length === 0 ? onMachine(rest) : [];
    if (wholeName.length) matches = wholeName;
    const wantId = hash < 0 || wholeName.length ? '' : rest.slice(hash + 1).trim().toLowerCase();
    // A `#` with no id after it names nothing.
    if (hash >= 0 && !wholeName.length && !wantId) return unseen;
    const others = matches.filter((o) => o.sessionId !== sender.sessionId);
    const plain = `${address.slice(0, at)}@${hash < 0 || wholeName.length ? rest : rest.slice(0, hash)}`;
    const ids = (list: LiveOrchestrator[]): string => list.map((o) => `${plain}#${o.agentId}`).join(', ');
    const tooMany = (list: LiveOrchestrator[]): Refusal =>
      refuse(409, `There are ${list.length} orchestrators called ${plain}, so Podium cannot tell which one you mean. Send to one by its id: ${ids(list)}. podium_peers lists the ids.`);
    if (/^\d+$/.test(wantId)) {
      const hit = await this.byAgentId(sender, Number(wantId), address, reachable);
      // The id names the agent; the name and machine in front of it must be the ones it has, so `Lower Left@Mac#7` is never delivered to agent 7 under another name.
      const named = matches.some((o) => o.agentId === Number(wantId));
      return hit && (named || ('ok' in hit && hit.status === 409)) ? hit : unseen;
    }
    if (wantId) {
      const byId = others.filter((o) => o.sessionId.toLowerCase().startsWith(wantId));
      if (byId.length > 1) return tooMany(byId);
      if (byId.length === 1) return byId[0];
      return matches.some((o) => o.sessionId === sender.sessionId && o.sessionId.toLowerCase().startsWith(wantId)) ? refuse(422, `${address} is this orchestrator. Send to another one; podium_peers lists them.`) : unseen;
    }
    if (others.length > 1) return tooMany(others);
    if (others.length === 1) return others[0];
    if (matches.length) return refuse(422, `${address} is this orchestrator. Send to another one; podium_peers lists them.`);
    return unseen;
  }

  /** The reachable agent with this id (from `reachable` when the caller has already read it), a refusal when it is the sender or when it has ended (#1284), or null when the sender has never been able to see one. */
  private async byAgentId(sender: LiveOrchestrator, agentId: number, address: string, reachable?: LiveOrchestrator[]): Promise<LiveOrchestrator | Refusal | null> {
    const hit = (reachable ?? (await this.reachable(sender))).find((o) => o.agentId === agentId);
    if (hit) return hit.sessionId === sender.sessionId ? refuse(422, `${address} is this orchestrator. Send to another one; podium_peers lists them.`) : hit;
    return this.gone(sender, agentId);
  }

  /** The refusal for an agent of the sender's owner that has ended: it says who, by name and id, and that it is no longer available. Null for an id that is live (so only unseen), unknown, or another owner's. */
  private async gone(sender: LiveOrchestrator, agentId: number): Promise<Refusal | null> {
    const a = await this.db.get<{ session_id: string; sid: string | null; name: string | null; owner_id: number | null }>('SELECT a.session_id AS session_id, s.id AS sid, s.name AS name, s.owner_id AS owner_id FROM agent_ids a LEFT JOIN sessions s ON s.id = a.session_id WHERE a.id = ?', [agentId]);
    if (!a || this.liveDir.has(a.session_id) || sender.ownerId === null) return null;
    let name = a.name;
    // A session whose person was deleted has no id and is nobody's (#1284), so it is no one's to be told about.
    if (a.sid !== null && (a.owner_id === null || Number(a.owner_id) !== sender.ownerId)) return null;
    if (a.sid === null) {
      // The session row is gone (they are deleted 30 days after the session ends): the name it had in the owner's last message to or from it is what is left.
      const m = await this.db.get<{ name: string }>('SELECT CASE WHEN to_agent = ? THEN to_name ELSE from_name END AS name FROM peer_messages WHERE owner_id = ? AND (to_agent = ? OR from_agent = ?) ORDER BY sent_at DESC, seq DESC LIMIT 1', [agentId, sender.ownerId, agentId, agentId]);
      if (!m) return null;
      name = m.name;
    }
    return refuse(409, `The agent ${name} (id ${agentId}) is no longer available: its session has ended, so Podium did not queue the message. podium_peers lists who you can reach now.`);
  }

  private async tripRows(a: string, b: string): Promise<TripRow[]> {
    const rs = await this.db.all<{ from_session: string; state: string; approved: number; author: string }>(
      `SELECT ${TRIP_COLS} FROM peer_messages WHERE ${PAIR_WHERE} ORDER BY sent_at, seq`,
      [a, b, b, a],
    );
    return rs.map((r) => ({ fromSession: r.from_session, state: r.state as MessageState, approved: r.approved === 1, author: r.author as MessageAuthor }));
  }

  /** An agent answers a person who wrote to it through Chat (#1034); see the SQLite adapter, which this follows step by step. Runs inside `send`'s transaction. */
  private async replyToPerson(sender: LiveOrchestrator & { ownerId: number }, address: string, clean: string, limits: { perMinute: number; roundTrips: number }): Promise<SendOutcome | Refusal> {
    const unseen = refuse(404, REPLY_WORDS.unseen(address));
    // The reporter addresses a person by the name it was shown (`person:Ed`), and podium_peers lists them by key (`person:5`). Either finds the key of a person who wrote to this very session: the name only picks among
    // the people who did (#1284), so a newcomer who takes a deleted person's name, who never wrote to it, is not found.
    const asked = address.slice('person:'.length).trim();
    let personKey: string | null = /^\d+$/.test(asked) ? `person:${asked}` : null;
    if (personKey === null) {
      const wrote = (await this.db.all<{ from_session: string; from_name: string }>(`SELECT DISTINCT from_session, from_name FROM peer_messages WHERE to_session = ? AND author = 'person' AND substr(from_session, 1, 7) = 'person:' ORDER BY from_session`, [sender.sessionId])).filter((r) => /^person:\d+$/.test(r.from_session) && nameKey(r.from_name) === nameKey(asked));
      personKey = wrote.length === 1 ? wrote[0]!.from_session : null;
    }
    if (personKey === null) return unseen;
    // The newest message the person wrote to this very session names them as they are shown.
    const wrote = await this.db.get<{ from_name: string }>(`SELECT from_name FROM peer_messages WHERE from_session = ? AND to_session = ? AND author = 'person' ORDER BY sent_at DESC, seq DESC LIMIT 1`, [personKey, sender.sessionId]);
    const link = await this.rights.personLink(personKey, sender.reporterKey);
    // The agent's own owner (#1034) wrote from Chat with no link between them: a person's own agents need none. A conversation the owner deleted has no message left to answer.
    const own = personKey === personKeyOf(sender.ownerId);
    if (!wrote || (!link && !own)) return unseen;
    if (link && link.level === 'none') return refuse(403, REPLY_WORDS.removed(sender.owner, wrote.from_name));
    if (link && link.paused) return refuse(409, REPLY_WORDS.paused(wrote.from_name));
    const now = this.now();
    const recent = (await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM peer_messages WHERE from_session = ? AND to_session = ? AND author = 'agent' AND sent_at > ?`, [sender.sessionId, personKey, now - RATE_WINDOW_MS]))!.n;
    if (recent >= limits.perMinute) return refuse(429, REPLY_WORDS.rate(recent, wrote.from_name));
    const id = newId();
    // `seq` is the next number in the table: the gate in `PgDb.tx` lets one transaction at a time reach this insert.
    await this.db.run(
      `INSERT INTO peer_messages (id, owner, owner_id, link, from_key, to_key, from_session, to_session, from_agent, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, seq, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'delivered', ?, NULL, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages), 'agent')`,
      [id, sender.owner, sender.ownerId, linkKey(personKey, sender.reporterKey), sender.reporterKey, personKey, sender.sessionId, personKey, sender.agentId, sender.name, sender.machine, wrote.from_name, clean, now, now],
    );
    await this.trail({ kind: 'delivered', message: (await this.row(id)) as MessageRow });
    return { ok: true as const, id, state: 'sent', paused: false, approvalWhy: null, requestId: null, to: { name: wrote.from_name, machine: '' }, roundTrips: { used: 0, cap: limits.roundTrips }, person: true };
  }

  send(fromSession: string, to: string, text: string): Promise<SendOutcome | Refusal> {
    return this.db.tx(async () => {
      const sender = await this.sender(fromSession);
      if (!sender) {
        return refuse(403, 'This session is not taking part in orchestrator messaging. It needs the peers option on in podium-reporter on this machine, and a report Podium has accepted since.');
      }
      const clean = cleanPeerText(text);
      if (!clean.trim()) return refuse(400, 'The message is empty. Write the text to send.');
      const limits = await this.rights.limits(sender.ownerId);
      if (clean.length > limits.maxChars) {
        const n = (v: number): string => v.toLocaleString('en-US');
        return refuse(422, `The message is ${n(clean.length)} characters, over the limit of ${n(limits.maxChars)} on this link. Send a shorter one, or a file path instead of the file.`);
      }
      if (/^person:/i.test(to.trim())) return this.replyToPerson(sender, to.trim(), clean, limits);
      const target = await this.resolve(sender, to);
      if ('ok' in target) return target;
      const right = await this.rights.effective(sender.reporterKey, target.reporterKey);
      if (!canSend(right.level)) {
        return refuse(403, `${sender.machine} can see ${target.machine} but has no right to send there. Ask ${sender.owner} for one with podium_request_access.`);
      }
      const link = linkKey(sender.reporterKey, target.reporterKey);
      const now = this.now();
      const recent = (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM peer_messages WHERE link = ? AND sent_at > ?', [link, now - RATE_WINDOW_MS]))!.n;
      if (recent >= limits.perMinute) {
        return refuse(429, `There have been ${recent} messages between ${sender.machine} and ${target.machine} in the last minute, the limit on this link. Wait a minute, then send again.`);
      }
      const trips = await this.tripRows(sender.sessionId, target.sessionId);
      let approvalWhy: SendOutcome['approvalWhy'] = null;
      if (right.level === 'ask') approvalWhy = 'link';
      else if (roundTripsUsed(trips) >= limits.roundTrips) approvalWhy = 'round-trips';
      const id = newId();
      const state: MessageState = approvalWhy ? 'approval' : 'ready';
      // `seq` is the next number in the table: the gate in `PgDb.tx` lets one transaction at a time reach this insert.
      await this.db.run(
        `INSERT INTO peer_messages (id, owner, owner_id, link, from_key, to_key, from_session, to_session, from_agent, to_agent, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages))`,
        [id, sender.owner, sender.ownerId, link, sender.reporterKey, target.reporterKey, sender.sessionId, target.sessionId, sender.agentId, target.agentId, sender.name, sender.machine, target.name, target.machine, clean, now, state, now],
      );
      let requestId: string | null = null;
      if (approvalWhy) {
        requestId = (await this.rights.openMessageRequest({ owner: sender.owner, ownerId: sender.ownerId, fromKey: sender.reporterKey, toKey: target.reporterKey, by: sender.name, fromSession: sender.sessionId, messageId: id })).id;
      }
      let outState: SendOutcome['state'] = takesMessages(target) ? 'sent' : 'turn';
      if (approvalWhy) outState = 'approval';
      await this.trail({ kind: 'sent', message: (await this.row(id)) as MessageRow, state: outState, approvalWhy });
      return {
        ok: true as const,
        id,
        state: outState,
        paused: right.paused,
        approvalWhy,
        requestId,
        to: { name: target.name, machine: target.machine },
        roundTrips: { used: roundTripsUsed([...trips, { fromSession: sender.sessionId, state, approved: false }]), cap: limits.roundTrips },
      };
    });
  }

  // ---- Delivery ----------------------------------------------------------------------------------------------------

  deliveriesFor(sessionId: string, takes: boolean): Promise<PeerDelivery[]> {
    return this.db.tx(async () => {
      const out: PeerDelivery[] = (this.notices.get(sessionId) ?? []).map((n) => ({ id: n.id, kind: 'notice', at: n.at, from: null, text: n.text }));
      const messages: MessageRow[] = [];
      if (takes) {
        for (const m of await this.rows(`SELECT * FROM peer_messages WHERE to_session = ? AND state IN ('ready', 'handed') AND deleted_at IS NULL ORDER BY sent_at, seq`, [sessionId])) {
          if (!(await this.rights.effective(m.fromKey, m.toKey)).paused) messages.push(m);
        }
      }
      for (const m of messages) {
        // A person's text (#1034) is handed over as a person's, with this session's owner named, so the reporter frames it as not the owner's.
        const from = m.author === 'person' ? { name: m.fromName, machine: m.fromMachine, owner: m.owner, person: true } : { name: m.fromName, machine: m.fromMachine, owner: m.owner, ...(m.fromAgent !== null ? { id: String(m.fromAgent) } : {}) };
        out.push({ id: m.id, kind: 'message', at: m.sentAt, from, text: m.text });
      }
      const picked = out.sort((a, b) => a.at - b.at).slice(0, PEER_LIMITS.deliveries);
      const now = this.now();
      for (const d of picked) {
        if (d.kind === 'message') await this.db.run(`UPDATE peer_messages SET state = 'handed', state_at = ? WHERE id = ? AND state = 'ready'`, [now, d.id]);
      }
      return picked;
    });
  }

  result(sessionId: string, id: string, result: PeerResult): Promise<'new' | 'repeat' | 'unknown'> {
    return this.db.tx(async () => {
      const queued = this.notices.get(sessionId) ?? [];
      const at = queued.findIndex((n) => n.id === id);
      if (at >= 0) {
        queued.splice(at, 1);
        return 'new' as const;
      }
      const m = await this.row(id);
      if (m?.toSession !== sessionId) return 'unknown' as const;
      const same = (m.state === 'queued' && result === 'queued') || (m.state === 'delivered' && result === 'took') || (m.state === 'dropped' && m.why === 'refused' && result === 'refused');
      if (same) return 'repeat' as const;
      if (m.state !== 'ready' && m.state !== 'handed' && m.state !== 'queued') return 'unknown' as const;
      if (result === 'took') await this.trail({ kind: 'delivered', message: await this.setState(id, 'delivered') });
      else if (result === 'queued') await this.setState(id, 'queued');
      else await this.drop(m, 'refused');
      return 'new' as const;
    });
  }

  approve(messageId: string, actor: Actor): Promise<boolean> {
    return this.db.tx(async () => {
      const m = await this.row(messageId);
      if (m?.state !== 'approval') return false;
      await this.db.run('UPDATE peer_messages SET approved = 1 WHERE id = ?', [messageId]);
      await this.trail({ kind: 'approved', message: await this.setState(messageId, 'ready'), actor });
      return true;
    });
  }

  decline(messageId: string, actor: Actor): Promise<boolean> {
    return this.db.tx(async () => {
      const m = await this.row(messageId);
      if (m?.state !== 'approval') return false;
      const row = await this.setState(messageId, 'declined');
      await this.trail({ kind: 'declined', message: row, actor });
      this.notice(row.fromSession, `Your message to ${row.toName} on ${row.toMachine} was declined by ${actor.name}. It stays in Podium > Traffic.`);
      return true;
    });
  }

  // ---- Notices and drops -------------------------------------------------------------------------------------------

  notice(sessionId: string, text: string): void {
    if (!this.liveDir.has(sessionId)) return;
    const list = this.notices.get(sessionId) ?? [];
    list.push({ id: newId(), at: this.now(), text });
    if (list.length > MAX_NOTICES) list.splice(0, list.length - MAX_NOTICES);
    this.notices.set(sessionId, list);
  }

  /** Lets go of one held message: dropped, its approval request closed, and (unless `messaging-off`) its sender told while live. */
  private async drop(m: MessageRow, why: DropWhy): Promise<void> {
    const row = await this.setState(m.id, 'dropped', why);
    await this.trail({ kind: 'dropped', message: row, why });
    await this.rights.closeMessageRequest(m.id, 'dropped');
    if (why !== 'messaging-off' && row.author === 'agent') this.notice(row.fromSession, `Your message to ${row.toName} on ${row.toMachine} was not delivered: ${dropReason(row, why)}. It stays in Podium > Traffic.`);
  }

  ended(sessionId: string): Promise<void> {
    return this.db.tx(async () => {
      this.liveDir.delete(sessionId);
      this.notices.delete(sessionId);
      for (const m of await this.rows(`SELECT * FROM peer_messages WHERE to_session = ? AND state IN (${HELD_SQL}) ORDER BY sent_at, seq`, [sessionId])) await this.drop(m, 'receiver-ended');
    });
  }

  deleted(sessionIds: string[]): Promise<void> {
    return this.db.tx(async () => {
      // Forgotten first, so a deleted sender is not told.
      for (const sid of sessionIds) {
        this.liveDir.delete(sid);
        this.notices.delete(sid);
      }
      for (const sid of sessionIds) {
        for (const m of await this.rows(`SELECT * FROM peer_messages WHERE (from_session = ? OR to_session = ?) AND state IN (${HELD_SQL}) ORDER BY sent_at, seq`, [sid, sid])) {
          await this.drop(m, 'session-deleted');
        }
        await this.db.run('DELETE FROM peer_messages WHERE from_session = ? OR to_session = ?', [sid, sid]);
      }
    });
  }

  linkRemoved(a: string, b: string): Promise<void> {
    return this.db.tx(async () => {
      for (const m of await this.rows(`SELECT * FROM peer_messages WHERE link = ? AND state IN (${HELD_SQL}) ORDER BY sent_at, seq`, [linkKey(a, b)])) await this.drop(m, 'link-removed');
    });
  }

  dropAll(): Promise<void> {
    return this.db.tx(async () => {
      for (const m of await this.rows(`SELECT * FROM peer_messages WHERE state IN (${HELD_SQL}) ORDER BY sent_at, seq`)) await this.drop(m, 'messaging-off');
      this.notices.clear();
    });
  }

  // ---- Reading -----------------------------------------------------------------------------------------------------

  async conversations(filter: { ownerId?: number; since?: number; liveOnly?: boolean }): Promise<ConversationSummary[]> {
    // A summary never carries the text, so it is not read: this backs the open Traffic read, over every owner's messages (or one owner's, which the database narrows).
    const owner = filter.ownerId ?? null;
    const all = await this.rows(
      `SELECT id, owner, owner_id, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, '' AS text, sent_at, state, state_at, why, approved, author, author_id, edited_at, deleted_at
       FROM peer_messages${owner === null ? '' : ' WHERE owner_id = ?'} ORDER BY sent_at, seq`,
      owner === null ? [] : [owner],
    );
    const groups = new Map<string, MessageRow[]>();
    for (const m of all) {
      const pair = ordered(m.fromSession, m.toSession).join('|');
      const g = groups.get(pair) ?? [];
      g.push(m);
      groups.set(pair, g);
    }
    const kept = [...groups.values()]
      .map((g) => ({ g, head: headOf(g) }))
      .filter(({ g, head: { a, b } }) => (filter.since === undefined || (g.at(-1) as MessageRow).sentAt >= filter.since) && (!filter.liveOnly || this.liveDir.has(a.sessionId) || this.liveDir.has(b.sessionId)));
    return (await this.summaries(kept.map(({ g }) => g), kept.map(({ head }) => head))).sort((x, y) => y.lastAt - x.lastAt);
  }

  /** The summaries of these conversations (each one's messages in order): the rights of every link and the limits of every owner are read once for all of them, so the statements do not grow with the conversations (#1309). */
  private async summaries(groups: MessageRow[][], heads: SummaryHead[] = groups.map(headOf)): Promise<ConversationSummary[]> {
    const rights = await this.rights.effectiveMany(heads.flatMap(linksOf));
    const caps = await this.rights.limitsMany(heads.map((h) => h.named.ownerId));
    return groups.map((g, i) => toSummary(g, heads[i]!, rights[2 * i]!, rights[2 * i + 1]!, caps[i]!.roundTrips));
  }

  conversation(a: string, b: string): Promise<MessageRow[]> {
    return this.rows(`SELECT * FROM peer_messages WHERE ${PAIR_WHERE} ORDER BY sent_at, seq`, [a, b, b, a]);
  }

  /** Deletes messages on links whose newest message is older than `cutoff`. Returns how many. */
  retain(cutoff: number): Promise<number> {
    return this.db.run('DELETE FROM peer_messages WHERE link IN (SELECT link FROM peer_messages GROUP BY link HAVING MAX(sent_at) < ?)', [cutoff]);
  }

  // ---- The Chat page (#1034) ---------------------------------------------------------------------------------------

  /** Whether the pair has messages and every one of them is the owner's. A conversation belongs to one owner; this is the guard that keeps another owner's read, delete or hide from reaching it. */
  private async ownsPair(ownerId: number, a: string, b: string): Promise<boolean> {
    // order-insensitive: a set of owners, compared as a whole. A row with no owner (a person since deleted) is nobody's.
    const owners = await this.db.all<{ owner_id: number | null }>(`SELECT DISTINCT owner_id FROM peer_messages WHERE ${PAIR_WHERE}`, [a, b, b, a]);
    return owners.length > 0 && owners.every((r) => r.owner_id !== null && Number(r.owner_id) === ownerId);
  }

  async sendFromPerson(input: PersonMessageInput): Promise<MessageRow | Refusal> {
    const clean = cleanPeerText(input.text);
    if (!clean.trim()) return refuse(400, 'The message is empty. Write the text to send.');
    const target = this.liveDir.get(input.toSession);
    if (!target) {
      // order-insensitive: only whether there is any row counts.
      const known = await this.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM peer_messages WHERE to_session = ? OR from_session = ?) + (SELECT COUNT(*) FROM sessions WHERE id = ?) AS n', [input.toSession, input.toSession, input.toSession]);
      return (known?.n ?? 0) > 0 ? refuse(409, 'That agent has ended, so Podium did not queue the message. It would never be taken.') : refuse(404, 'There is no such agent.');
    }
    if (target.ownerId !== input.ownerId) return refuse(404, 'There is no such agent.');
    if (target.peers !== true) return refuse(403, `${target.name} is not taking part in orchestrator messaging. It needs the peers option on in podium-reporter on its machine.`);
    const limits = await this.rights.limits(input.ownerId);
    if (clean.length > limits.maxChars) {
      return refuse(422, overLimitWords(clean.length, limits.maxChars));
    }
    let fromSession = personKeyOf(input.ownerId);
    let fromKey = '';
    let link = linkKey(fromSession, target.reporterKey);
    if (input.withSession) {
      if (!(await this.ownsPair(input.ownerId, input.toSession, input.withSession))) return refuse(404, 'There is no such conversation.');
      const newest = await this.db.get<{ link: string; from_session: string; from_key: string; to_key: string }>(
        `SELECT link, from_session, from_key, to_key FROM peer_messages WHERE ${PAIR_WHERE} ORDER BY sent_at DESC, seq DESC LIMIT 1`,
        [input.toSession, input.withSession, input.withSession, input.toSession],
      );
      if (!newest) return refuse(404, 'There is no such conversation.');
      fromSession = input.withSession;
      fromKey = newest.from_session === input.withSession ? newest.from_key : newest.to_key;
      link = newest.link;
    }
    const id = newId();
    const now = this.now();
    // `seq` is the next number in the table: the gate in `PgDb.tx` lets one transaction at a time reach this insert.
    await this.db.run(
      `INSERT INTO peer_messages (id, owner, owner_id, link, from_key, to_key, from_session, to_session, from_agent, to_agent, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, seq, author, author_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, NULL, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages), 'person', ?)`,
      [id, target.owner, input.ownerId, link, fromKey, target.reporterKey, fromSession, input.toSession, input.withSession ? (this.liveDir.get(input.withSession)?.agentId ?? (await this.agentOf(input.withSession))) : null, target.agentId, cleanNameText(input.person).trim() || input.person, target.name, target.machine, clean, now, input.state ?? 'ready', now, input.authorId ?? null],
    );
    return (await this.row(id)) as MessageRow;
  }

  async sendAcross(input: AcrossInput): Promise<MessageRow | Refusal> {
    const clean = cleanPeerText(input.text);
    if (!clean.trim()) return refuse(400, 'The message is empty. Write the text to send.');
    const personKey = personKeyOf(input.personId);
    const target = this.liveDir.get(input.toSession);
    if (!target) {
      // order-insensitive: only whether there is any row counts.
      const known = await this.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM peer_messages WHERE to_session = ? OR from_session = ?) + (SELECT COUNT(*) FROM sessions WHERE id = ?) AS n', [input.toSession, input.toSession, input.toSession]);
      return (known?.n ?? 0) > 0 ? refuse(409, 'That agent has ended, so Podium did not send the message. It would never be taken.') : refuse(404, 'There is no such agent.');
    }
    if (target.ownerId === input.personId) return refuse(422, 'That agent is yours. Write to it from your own conversation with it.');
    if (target.peers !== true || target.ownerId === null || !(await this.onOwnReporter(target))) return refuse(403, `${target.name} is not taking part in orchestrator messaging, so it cannot be written to.`);
    const limits = await this.rights.limits(target.ownerId);
    if (clean.length > limits.maxChars) {
      return refuse(422, overLimitWords(clean.length, limits.maxChars));
    }
    const link = await this.rights.personLink(personKey, target.reporterKey);
    if (link?.level === 'none') return refuse(403, `${target.owner} removed the link between you and ${target.name}, so Podium did not send the message. ${target.owner} can open it again.`);
    if (link?.paused) return refuse(409, `The link between you and ${target.name} is paused, so Podium did not send the message. It goes through once the link is resumed.`);
    if (!link) {
      // order-insensitive: only the counts of this person's waiting messages matter.
      const waiting = await this.rows(`SELECT * FROM peer_messages WHERE from_session = ? AND state = 'approval'`, [personKey]);
      if (waiting.some((m) => m.toSession === input.toSession)) return refuse(409, `Your earlier message to ${target.name} still waits for ${target.owner} to approve it. Wait for the answer before you write again.`);
      if (waiting.filter((m) => m.ownerId === target.ownerId).length >= CROSS_PENDING_MAX) {
        return refuse(429, `You already have ${CROSS_PENDING_MAX} messages waiting for ${target.owner} to approve. Wait for answers before you write more.`);
      }
    }
    const state: MessageState = link ? 'ready' : 'approval';
    const id = newId();
    const now = this.now();
    // `seq` is the next number in the table: the gate in `PgDb.tx` lets one transaction at a time reach this insert.
    await this.db.run(
      `INSERT INTO peer_messages (id, owner, owner_id, link, from_key, to_key, from_session, to_session, to_agent, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, seq, author, author_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, NULL, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages), 'person', ?)`,
      [id, target.owner, target.ownerId, linkKey(personKey, target.reporterKey), personKey, target.reporterKey, personKey, input.toSession, target.agentId, cleanNameText(input.person).trim() || input.person, target.name, target.machine, clean, now, state, now, input.authorId ?? null],
    );
    if (state === 'approval') {
      await this.rights.openMessageRequest({ owner: target.owner, ownerId: target.ownerId, fromKey: personKey, toKey: target.reporterKey, by: input.person, fromSession: personKey, messageId: id });
    }
    await this.trail({ kind: 'sent', message: (await this.row(id)) as MessageRow, state: state === 'approval' ? 'approval' : takesMessages(target) ? 'sent' : 'turn', approvalWhy: state === 'approval' ? 'link' : null });
    return (await this.row(id)) as MessageRow;
  }

  async page(ownerId: number, a: string, b: string, opts: { before?: string | null; limit: number }): Promise<MessagePage> {
    const before = opts.before === undefined || opts.before === null ? null : decodeCursor(opts.before);
    const limit = pageSize(opts.limit);
    if (!(await this.ownsPair(ownerId, a, b))) return { messages: [], older: null };
    const newestFirst = before
      ? await this.db.all<DbMessage>(`SELECT * FROM peer_messages WHERE (${PAIR_WHERE}) AND (sent_at < ? OR (sent_at = ? AND seq < ?)) ORDER BY sent_at DESC, seq DESC LIMIT ?`, [a, b, b, a, before.at, before.at, before.seq, limit + 1])
      : await this.db.all<DbMessage>(`SELECT * FROM peer_messages WHERE ${PAIR_WHERE} ORDER BY sent_at DESC, seq DESC LIMIT ?`, [a, b, b, a, limit + 1]);
    // The extra row only says there is an older page; the cursor names the oldest row kept, and a page back starts strictly before it.
    const kept = newestFirst.slice(0, limit).reverse();
    const oldest = kept[0];
    return { messages: kept.map(toRow), older: newestFirst.length > limit && oldest ? encodeCursor(oldest.sent_at, oldest.seq as number) : null };
  }

  /** The rows an author's change would touch, or why it is refused (#1269): the one asked for and every row the thread merges with it, decided on one read, inside the transaction the caller holds. */
  private async changeOf(id: string, author: number): Promise<ReturnType<typeof decideChange>> {
    const row = await this.row(id);
    return decideChange(row, row ? await this.conversation(row.fromSession, row.toSession) : [], author);
  }

  editMessage(id: string, x: PeerMessageEdit): Promise<PeerChange> {
    return this.db.tx(async () => {
      const change = await this.changeOf(id, x.author);
      if (!change.ok) return change;
      // The owner's limit, as a send checks it, on the text as it is stored (#1269).
      const clean = cleanPeerText(x.text);
      const max = (await this.rights.limits(change.group[0]!.ownerId)).maxChars;
      if (clean.length > max) return { ok: false as const, reason: 'too-long' as const, status: 422 as const, error: overLimitWords(clean.length, max) };
      for (const m of change.group) await this.db.run('UPDATE peer_messages SET text = ?, edited_at = ? WHERE id = ?', [x.text, x.now, m.id]);
      return { ok: true as const, message: (await this.row(id)) as MessageRow };
    });
  }

  deleteMessage(id: string, x: { author: number; now: number }): Promise<PeerChange> {
    return this.db.tx(async () => {
      const change = await this.changeOf(id, x.author);
      if (!change.ok) return change;
      for (const m of change.group) {
        await this.db.run(`UPDATE peer_messages SET text = '', deleted_at = ? WHERE id = ?`, [x.now, m.id]);
        // Never approved or handed over now: dropped, with its approval request closed.
        if (m.state === 'approval' || m.state === 'ready') await this.drop({ ...m, text: '', deletedAt: x.now }, 'deleted');
      }
      return { ok: true as const, message: (await this.row(id)) as MessageRow };
    });
  }

  async deleteConversation(ownerId: number, a: string, b: string): Promise<number> {
    if (!(await this.ownsPair(ownerId, a, b))) return 0;
    for (const m of await this.rows(`SELECT * FROM peer_messages WHERE (${PAIR_WHERE}) AND state IN (${HELD_SQL}) ORDER BY sent_at, seq`, [a, b, b, a])) await this.rights.closeMessageRequest(m.id, 'dropped');
    return this.db.run(`DELETE FROM peer_messages WHERE ${PAIR_WHERE}`, [a, b, b, a]);
  }

  async conversationOf(a: string, b: string): Promise<ConversationSummary | null> {
    // A summary never carries the text, so it is not read: only this pair's rows, by its two session ids.
    const rows = await this.rows(`SELECT id, owner, owner_id, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, '' AS text, sent_at, state, state_at, why, approved, author, author_id, edited_at, deleted_at FROM peer_messages WHERE ${PAIR_WHERE} ORDER BY sent_at, seq`, [a, b, b, a]);
    return rows.length > 0 ? (await this.summaries([rows]))[0]! : null;
  }

  async conversationCounts(ownerIds: number[]): Promise<Record<number, number>> {
    return countConversations(await this.db.all<ConversationGroupRow>(
        'SELECT owner_id, from_session, to_session, MIN(CASE WHEN hidden_at IS NULL THEN 0 ELSE 1 END) AS all_hidden FROM peer_messages GROUP BY owner_id, from_session, to_session ORDER BY COALESCE(owner_id, 0), from_session, to_session',
      ), ownerIds);
  }

  async ownerConversations(ownerId: number, opts: { includeHidden?: boolean; pairs?: string[] } = {}): Promise<OwnerConversation[]> {
    if (opts.pairs && opts.pairs.length === 0) return [];
    // The person is in a conversation they own, and in one they started with another person's agent (#1034): there `person:<id>` is one of its two ends. The database finds only those rows (#1309).
    const me = personKeyOf(ownerId);
    const all = await this.db.all<DbMessage>(
      `SELECT id, owner, owner_id, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, '' AS text, sent_at, state, state_at, why, approved, author, author_id, edited_at, deleted_at, hidden_at
       FROM peer_messages WHERE owner_id = ? OR from_session = ? OR to_session = ? ORDER BY sent_at, seq`,
      [ownerId, me, me],
    );
    const only = opts.pairs ? new Set(opts.pairs) : null;
    const groups = new Map<string, DbMessage[]>();
    for (const r of all) {
      const pair = ordered(r.from_session, r.to_session).join('|');
      if (only && !only.has(pair)) continue;
      const g = groups.get(pair) ?? [];
      g.push(r);
      groups.set(pair, g);
    }
    const shown: { g: DbMessage[]; hiddenAt: number | null }[] = [];
    for (const g of groups.values()) {
      const hiddenAt = g.every((r) => r.hidden_at != null) ? latestOf(g.map((r) => r.hidden_at as number)) : null;
      if (hiddenAt !== null && !opts.includeHidden) continue;
      shown.push({ g, hiddenAt });
    }
    const summaries = await this.summaries(shown.map(({ g }) => g.map(toRow)));
    return shown.map(({ hiddenAt }, i) => ({ ...summaries[i]!, hiddenAt })).sort((x, y) => y.lastAt - x.lastAt || x.a.sessionId.localeCompare(y.a.sessionId) || x.b.sessionId.localeCompare(y.b.sessionId));
  }

  async conversationPairs(): Promise<[string, string][]> {
    // order-insensitive: each pair is kept once and `pairsOf` sorts them.
    return pairsOf(await this.db.all<{ from_session: string; to_session: string }>('SELECT DISTINCT from_session, to_session FROM peer_messages'));
  }

  async hideConversation(ownerId: number, a: string, b: string): Promise<number> {
    if (!(await this.ownsPair(ownerId, a, b))) return 0;
    return this.db.run(`UPDATE peer_messages SET hidden_at = ? WHERE hidden_at IS NULL AND (${PAIR_WHERE})`, [this.now(), a, b, b, a]);
  }

  async showConversation(ownerId: number, a: string, b: string): Promise<number> {
    if (!(await this.ownsPair(ownerId, a, b))) return 0;
    return this.db.run(`UPDATE peer_messages SET hidden_at = NULL WHERE hidden_at IS NOT NULL AND (${PAIR_WHERE})`, [a, b, b, a]);
  }

  async purgeHidden(now: number, graceMs: number): Promise<number> {
    for (const m of await this.rows(`SELECT * FROM peer_messages WHERE ${HIDDEN_DUE_SQL} AND state IN (${HELD_SQL}) ORDER BY sent_at, seq`, [now, now - graceMs])) await this.rights.closeMessageRequest(m.id, 'dropped');
    return this.db.run(`DELETE FROM peer_messages WHERE ${HIDDEN_DUE_SQL}`, [now, now - graceMs]);
  }
}
