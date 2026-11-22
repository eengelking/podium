// Orchestrator messaging (#347, #412): the message store. SPEC 7.7 "Orchestrator messaging" has the rules and 5.3 the
// reporter's side. Messages, with their text, are kept in `peer_messages` (db.ts migration 20) until retention or their
// sessions' deletion; the live directory of orchestrators and Podium's own notices to them are memory only, and the
// next report refills the directory after a restart. Nothing is stored for a refused message, and nothing here logs:
// each event goes to `trail` as a row, and the routes decide what to write (never the text).
import { randomBytes } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { pausedByOf } from '../peerText.js';
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
  type LeftOut,
  type PeerListResult,
  type PersonListing,
  type LiveInput,
  type LiveOrchestrator,
  type MessageAuthor,
  type MessagePage,
  type MessageRow,
  type MessageState,
  type OwnerConversation,
  type PersonMessageInput,
  type MessageTrail,
  type PeerListing,
  type PeerChange,
  type PeerMessageEdit,
  type PeerMessagesApi,
  type PeerRightsView,
  type Refusal,
  type ReporterLookup,
  type SendOutcome,
} from '../../fleet/peerTypes.js';
import { nameKey } from '../rows.js';
import { decideChange, overLimitWords } from '../peerEdit.js';
import { countConversations, type ConversationGroupRow } from '../conversationCounts.js';
import { MAX_NOTICES, REPLY_WORDS, cleanNameText, cleanPeerText, decodeCursor, encodeCursor, latestOf, pageSize, roundTripsUsed, settleName, shownCount, type TripRow } from '../peerText.js';

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

export class PeerMessages implements PeerMessagesApi {
  private readonly stmts = new Map<string, StatementSync>();
  private readonly liveDir = new Map<string, LiveOrchestrator>();
  private readonly notices = new Map<string, Notice[]>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly rights: PeerRightsView,
    private readonly reporters: ReporterLookup,
    private readonly now: () => number = Date.now,
    private readonly trail: (t: MessageTrail) => void = () => {},
  ) {}

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private rows(sql: string, ...args: (string | number)[]): MessageRow[] {
    return (this.stmt(sql).all(...args) as unknown as DbMessage[]).map(toRow);
  }

  private row(id: string): MessageRow | null {
    const r = this.stmt('SELECT * FROM peer_messages WHERE id = ?').get(id) as DbMessage | undefined;
    return r ? toRow(r) : null;
  }

  /** One stored message by id, with its text, or null. */
  message(id: string): MessageRow | null {
    return this.row(id);
  }

  private setState(id: string, state: MessageState, why: DropWhy | null = null): MessageRow {
    this.stmt('UPDATE peer_messages SET state = ?, why = ?, state_at = ? WHERE id = ?').run(state, why, this.now(), id);
    return this.row(id) as MessageRow;
  }

  // ---- The live directory ------------------------------------------------------------------------------------------

  note(o: LiveInput): void {
    if (o.status === 'done') {
      this.ended(o.sessionId);
      return;
    }
    const prev = this.liveDir.get(o.sessionId);
    this.liveDir.set(o.sessionId, { ...o, agentId: prev?.agentId ?? this.agentIdOf(o.sessionId), name: this.settledName(o, prev) });
  }

  /** The agent id of a session that has one, or null (a conversation's other end that the server never heard report). */
  private agentOf(sessionId: string): number | null {
    const r = this.stmt('SELECT id FROM agent_ids WHERE session_id = ?').get(sessionId) as { id: number } | undefined;
    return r ? Number(r.id) : null;
  }

  /** The id the server gave this session (#1284), made on the first report and never changed: one row per session id, and a number is never handed out twice. */
  private agentIdOf(sessionId: string): number {
    this.stmt('INSERT OR IGNORE INTO agent_ids (session_id) VALUES (?)').run(sessionId);
    return Number((this.stmt('SELECT id FROM agent_ids WHERE session_id = ?').get(sessionId) as { id: number }).id);
  }

  /** The agent's name with no other live agent of its owner holding it (#1284): its reported name, or that name and the first free number from 2 ("Lower Left 2"); one it already has stays while it is free. */
  private settledName(o: LiveInput, prev: LiveOrchestrator | undefined): string {
    const taken = new Set([...this.liveDir.values()].filter((x) => x.sessionId !== o.sessionId && x.ownerId === o.ownerId).map((x) => nameKey(x.name)));
    return settleName(o.name, prev?.name, taken, nameKey);
  }

  live(sessionId: string): LiveOrchestrator | null {
    return this.liveDir.get(sessionId) ?? null;
  }

  /** Whether the orchestrator's reporter is its person's: known, not on the admin secret, and filed under the same `people.id` the orchestrator reported with (#1284), so a reporter that changed hands is not the one it ran on. */
  private onPersonReporter(o: LiveOrchestrator): o is LiveOrchestrator & { ownerId: number } {
    const r = this.reporters.get(o.reporterKey);
    return r !== null && !r.adminSecret && o.ownerId !== null && r.ownerId === o.ownerId;
  }

  /** The orchestrators `sender` could reach: the same owner's, messaging on, on a person's reporter, and seen by the sender's reporter. The sender itself is kept. */
  private reachable(sender: LiveOrchestrator): LiveOrchestrator[] {
    const owner = sender.ownerId;
    return [...this.liveDir.values()].filter(
      (o) =>
        owner !== null &&
        o.ownerId === owner &&
        o.peers === true &&
        this.onPersonReporter(o) &&
        (o.sessionId === sender.sessionId || this.rights.effective(sender.reporterKey, o.reporterKey).level !== 'none'),
    );
  }

  /** The sender, when it can take part: live, messaging on, on a person's reporter. */
  private sender(sessionId: string): (LiveOrchestrator & { ownerId: number }) | null {
    const s = this.liveDir.get(sessionId);
    return s && s.peers === true && this.onPersonReporter(s) ? s : null;
  }

  /** The people who wrote to this agent through Chat and whose link is still there (#1034); one who has no link, or whose was removed, is not listed. */
  private peopleOf(sender: LiveOrchestrator): PersonListing[] {
    const rows = this.stmt(`SELECT from_session, from_name FROM peer_messages WHERE to_session = ? AND author = 'person' AND substr(from_session, 1, 7) = 'person:' ORDER BY sent_at, seq`).all(sender.sessionId) as unknown as { from_session: string; from_name: string }[];
    const names = new Map(rows.map((r) => [r.from_session, r.from_name]));
    const out: PersonListing[] = [];
    for (const [address, name] of names) {
      const link = this.rights.personLink(address, sender.reporterKey);
      if (link && link.level !== 'none') out.push({ address, name, paused: link.paused });
      else if (!link && sender.ownerId !== null && address === personKeyOf(sender.ownerId)) out.push({ address, name, paused: false });
    }
    return out.sort((a, b) => a.address.localeCompare(b.address));
  }

  list(sessionId: string): PeerListResult {
    const sender = this.sender(sessionId);
    if (!sender) return { peers: [], leftOut: [], people: [] };
    const others = this.reachable(sender).filter((o) => o.sessionId !== sender.sessionId);
    const peers: PeerListing[] = others
      .map((o) => {
        const right = this.rights.effective(sender.reporterKey, o.reporterKey);
        return {
          address: `${o.name}@${o.machine}`,
          id: String(o.agentId),
          name: o.name,
          machine: o.machine,
          os: o.os,
          project: o.project,
          status: o.status,
          level: right.level as PeerListing['level'],
          paused: right.paused,
        };
      })
      .sort((a, b) => a.address.localeCompare(b.address) || a.id.localeCompare(b.id));
    const listed = new Set(others.map((o) => o.reporterKey));
    const leftOut: LeftOut[] = [];
    for (const r of this.reporters.ofOwner(sender.ownerId)) {
      // The sender's own reporter is where it runs, not a machine left out (the mockup lists only the others).
      if (r.adminSecret || r.key === sender.reporterKey || listed.has(r.key)) continue;
      let why: LeftOut['why'] = 'no orchestrator running';
      if (r.peers === null) why = 'reporter too old to message';
      else if (!r.peers) why = 'messaging off on the machine';
      else if (this.rights.effective(sender.reporterKey, r.key).level === 'none') why = 'no right to see it';
      leftOut.push({ machine: r.machine, why });
    }
    return { peers, leftOut, people: this.peopleOf(sender) };
  }

  // ---- Sending -----------------------------------------------------------------------------------------------------

  /** `name@machine`, split at the last `@`, among the orchestrators the sender can reach. `name@machine#id` pins one by its never-reused id (#500, #1284). */
  private resolve(sender: LiveOrchestrator, to: string): LiveOrchestrator | Refusal {
    const address = to.trim();
    const unseen = refuse(404, `You cannot see an orchestrator called ${address}. Run podium_peers for the list.`);
    // A bare `#id` is the agent's id alone (#1284): it names one agent whatever it is called.
    const bare = /^#(\d+)$/.exec(address);
    if (bare) return this.byAgentId(sender, Number(bare[1]), address) ?? unseen;
    const at = address.lastIndexOf('@');
    if (at < 0) return unseen;
    const name = nameKey(address.slice(0, at));
    const rest = address.slice(at + 1);
    const hash = rest.lastIndexOf('#');
    const reachable = this.reachable(sender);
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
      const hit = this.byAgentId(sender, Number(wantId), address);
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

  /** The reachable agent with this id, a refusal when it is the sender or when it has ended (#1284), or null when the sender has never been able to see one. */
  private byAgentId(sender: LiveOrchestrator, agentId: number, address: string): LiveOrchestrator | Refusal | null {
    const hit = this.reachable(sender).find((o) => o.agentId === agentId);
    if (hit) return hit.sessionId === sender.sessionId ? refuse(422, `${address} is this orchestrator. Send to another one; podium_peers lists them.`) : hit;
    return this.gone(sender, agentId);
  }

  /** The refusal for an agent of the sender's owner that has ended: it says who, by name and id, and that it is no longer available. Null for an id that is live (so only unseen), unknown, or another owner's. */
  private gone(sender: LiveOrchestrator, agentId: number): Refusal | null {
    const a = this.stmt('SELECT a.session_id AS session_id, s.id AS sid, s.name AS name, s.owner_id AS owner_id FROM agent_ids a LEFT JOIN sessions s ON s.id = a.session_id WHERE a.id = ?').get(agentId) as { session_id: string; sid: string | null; name: string | null; owner_id: number | null } | undefined;
    if (!a || this.liveDir.has(a.session_id) || sender.ownerId === null) return null;
    let name = a.name;
    // A session whose person was deleted has no id and is nobody's (#1284), so it is no one's to be told about.
    if (a.sid !== null && (a.owner_id === null || Number(a.owner_id) !== sender.ownerId)) return null;
    if (a.sid === null) {
      // The session row is gone (they are deleted 30 days after the session ends): the name it had in the owner's last message to or from it is what is left.
      const m = this.stmt('SELECT CASE WHEN to_agent = ? THEN to_name ELSE from_name END AS name FROM peer_messages WHERE owner_id = ? AND (to_agent = ? OR from_agent = ?) ORDER BY sent_at DESC, seq DESC LIMIT 1').get(agentId, sender.ownerId, agentId, agentId) as { name: string } | undefined;
      if (!m) return null;
      name = m.name;
    }
    return refuse(409, `The agent ${name} (id ${agentId}) is no longer available: its session has ended, so Podium did not queue the message. podium_peers lists who you can reach now.`);
  }

  private tripRows(a: string, b: string): TripRow[] {
    const rs = this.stmt(`SELECT ${TRIP_COLS} FROM peer_messages WHERE ${PAIR_WHERE} ORDER BY sent_at, seq`).all(a, b, b, a) as unknown as {
      from_session: string;
      state: string;
      approved: number;
      author: string;
    }[];
    return rs.map((r) => ({ fromSession: r.from_session, state: r.state as MessageState, approved: r.approved === 1, author: r.author as MessageAuthor }));
  }

  /**
   * An agent answers a person who wrote to it through Chat (#1034), over the link its owner opened and no other. Stored as delivered in the same conversation:
   * the person has no reporter to hand it to. Anything else, including a person who never wrote to this agent, is the generic "cannot see".
   */
  private replyToPerson(sender: LiveOrchestrator & { ownerId: number }, address: string, clean: string, limits: { perMinute: number; roundTrips: number }): SendOutcome | Refusal {
    const unseen = refuse(404, REPLY_WORDS.unseen(address));
    // The reporter addresses a person by the name it was shown (`person:Ed`), and podium_peers lists them by key (`person:5`). Either finds the key of a person who wrote to this very session: the name only picks among
    // the people who did (#1284), so a newcomer who takes a deleted person's name, who never wrote to it, is not found.
    const asked = address.slice('person:'.length).trim();
    let personKey: string | null = /^\d+$/.test(asked) ? `person:${asked}` : null;
    if (personKey === null) {
      const wrote = (this.stmt(`SELECT DISTINCT from_session, from_name FROM peer_messages WHERE to_session = ? AND author = 'person' AND substr(from_session, 1, 7) = 'person:' ORDER BY from_session`).all(sender.sessionId) as unknown as { from_session: string; from_name: string }[]).filter((r) => /^person:\d+$/.test(r.from_session) && nameKey(r.from_name) === nameKey(asked));
      personKey = wrote.length === 1 ? wrote[0]!.from_session : null;
    }
    if (personKey === null) return unseen;
    // The newest message the person wrote to this very session names them as they are shown.
    const wrote = this.stmt(`SELECT from_name FROM peer_messages WHERE from_session = ? AND to_session = ? AND author = 'person' ORDER BY sent_at DESC, seq DESC LIMIT 1`).get(personKey, sender.sessionId) as { from_name: string } | undefined;
    const link = this.rights.personLink(personKey, sender.reporterKey);
    // The agent's own owner (#1034) wrote from Chat with no link between them: a person's own agents need none. A conversation the owner deleted has no message left to answer.
    const own = personKey === personKeyOf(sender.ownerId);
    if (!wrote || (!link && !own)) return unseen;
    if (link && link.level === 'none') return refuse(403, REPLY_WORDS.removed(sender.owner, wrote.from_name));
    if (link && link.paused) return refuse(409, REPLY_WORDS.paused(wrote.from_name));
    const now = this.now();
    const recent = (this.stmt(`SELECT COUNT(*) AS n FROM peer_messages WHERE from_session = ? AND to_session = ? AND author = 'agent' AND sent_at > ?`).get(sender.sessionId, personKey, now - RATE_WINDOW_MS) as { n: number }).n;
    if (recent >= limits.perMinute) return refuse(429, REPLY_WORDS.rate(recent, wrote.from_name));
    const id = newId();
    this.stmt(
      `INSERT INTO peer_messages (id, owner, owner_id, link, from_key, to_key, from_session, to_session, from_agent, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'delivered', ?, NULL, 0, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages), 'agent')`,
    ).run(id, sender.owner, sender.ownerId, linkKey(personKey, sender.reporterKey), sender.reporterKey, personKey, sender.sessionId, personKey, sender.agentId, sender.name, sender.machine, wrote.from_name, clean, now, now);
    this.trail({ kind: 'delivered', message: this.row(id) as MessageRow });
    return { ok: true, id, state: 'sent', paused: false, approvalWhy: null, requestId: null, to: { name: wrote.from_name, machine: '' }, roundTrips: { used: 0, cap: limits.roundTrips }, person: true };
  }

  send(fromSession: string, to: string, text: string): SendOutcome | Refusal {
    const sender = this.sender(fromSession);
    if (!sender) {
      return refuse(403, 'This session is not taking part in orchestrator messaging. It needs the peers option on in podium-reporter on this machine, and a report Podium has accepted since.');
    }
    const clean = cleanPeerText(text);
    if (!clean.trim()) return refuse(400, 'The message is empty. Write the text to send.');
    const limits = this.rights.limits(sender.ownerId);
    if (clean.length > limits.maxChars) {
      const n = (v: number): string => v.toLocaleString('en-US');
      return refuse(422, `The message is ${n(clean.length)} characters, over the limit of ${n(limits.maxChars)} on this link. Send a shorter one, or a file path instead of the file.`);
    }
    if (/^person:/i.test(to.trim())) return this.replyToPerson(sender, to.trim(), clean, limits);
    const target = this.resolve(sender, to);
    if ('ok' in target) return target;
    const right = this.rights.effective(sender.reporterKey, target.reporterKey);
    if (!canSend(right.level)) {
      return refuse(403, `${sender.machine} can see ${target.machine} but has no right to send there. Ask ${sender.owner} for one with podium_request_access.`);
    }
    const link = linkKey(sender.reporterKey, target.reporterKey);
    const now = this.now();
    const recent = (this.stmt('SELECT COUNT(*) AS n FROM peer_messages WHERE link = ? AND sent_at > ?').get(link, now - RATE_WINDOW_MS) as { n: number }).n;
    if (recent >= limits.perMinute) {
      return refuse(429, `There have been ${recent} messages between ${sender.machine} and ${target.machine} in the last minute, the limit on this link. Wait a minute, then send again.`);
    }
    const trips = this.tripRows(sender.sessionId, target.sessionId);
    let approvalWhy: SendOutcome['approvalWhy'] = null;
    if (right.level === 'ask') approvalWhy = 'link';
    else if (roundTripsUsed(trips) >= limits.roundTrips) approvalWhy = 'round-trips';
    const id = newId();
    const state: MessageState = approvalWhy ? 'approval' : 'ready';
    this.stmt(
      `INSERT INTO peer_messages (id, owner, owner_id, link, from_key, to_key, from_session, to_session, from_agent, to_agent, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages))`,
    ).run(id, sender.owner, sender.ownerId, link, sender.reporterKey, target.reporterKey, sender.sessionId, target.sessionId, sender.agentId, target.agentId, sender.name, sender.machine, target.name, target.machine, clean, now, state, now);
    let requestId: string | null = null;
    if (approvalWhy) {
      requestId = this.rights.openMessageRequest({ owner: sender.owner, ownerId: sender.ownerId, fromKey: sender.reporterKey, toKey: target.reporterKey, by: sender.name, fromSession: sender.sessionId, messageId: id }).id;
    }
    let outState: SendOutcome['state'] = takesMessages(target) ? 'sent' : 'turn';
    if (approvalWhy) outState = 'approval';
    this.trail({ kind: 'sent', message: this.row(id) as MessageRow, state: outState, approvalWhy });
    return {
      ok: true,
      id,
      state: outState,
      paused: right.paused,
      approvalWhy,
      requestId,
      to: { name: target.name, machine: target.machine },
      roundTrips: { used: roundTripsUsed([...trips, { fromSession: sender.sessionId, state, approved: false }]), cap: limits.roundTrips },
    };
  }

  // ---- Delivery ----------------------------------------------------------------------------------------------------

  deliveriesFor(sessionId: string, takes: boolean): PeerDelivery[] {
    const out: PeerDelivery[] = (this.notices.get(sessionId) ?? []).map((n) => ({ id: n.id, kind: 'notice', at: n.at, from: null, text: n.text }));
    const messages = takes
      ? this.rows(`SELECT * FROM peer_messages WHERE to_session = ? AND state IN ('ready', 'handed') AND deleted_at IS NULL ORDER BY sent_at, seq`, sessionId).filter(
          (m) => !this.rights.effective(m.fromKey, m.toKey).paused,
        )
      : [];
    for (const m of messages) {
      // A person's text (#1034) is handed over as a person's, with this session's owner named, so the reporter frames it as not the owner's.
      const from = m.author === 'person' ? { name: m.fromName, machine: m.fromMachine, owner: m.owner, person: true } : { name: m.fromName, machine: m.fromMachine, owner: m.owner, ...(m.fromAgent !== null ? { id: String(m.fromAgent) } : {}) };
      out.push({ id: m.id, kind: 'message', at: m.sentAt, from, text: m.text });
    }
    const picked = out.sort((a, b) => a.at - b.at).slice(0, PEER_LIMITS.deliveries);
    const now = this.now();
    for (const d of picked) {
      if (d.kind === 'message') this.stmt(`UPDATE peer_messages SET state = 'handed', handed = 1, state_at = ? WHERE id = ? AND state = 'ready'`).run(now, d.id);
    }
    return picked;
  }

  result(sessionId: string, id: string, result: PeerResult): 'new' | 'repeat' | 'unknown' {
    const queued = this.notices.get(sessionId) ?? [];
    const at = queued.findIndex((n) => n.id === id);
    if (at >= 0) {
      queued.splice(at, 1);
      return 'new';
    }
    const m = this.row(id);
    if (m?.toSession !== sessionId) return 'unknown';
    const same = (m.state === 'queued' && result === 'queued') || (m.state === 'delivered' && result === 'took') || (m.state === 'dropped' && m.why === 'refused' && result === 'refused');
    if (same) return 'repeat';
    if (m.state !== 'ready' && m.state !== 'handed' && m.state !== 'queued') return 'unknown';
    if (result === 'took') this.trail({ kind: 'delivered', message: this.setState(id, 'delivered') });
    else if (result === 'queued') this.setState(id, 'queued');
    else this.drop(m, 'refused');
    return 'new';
  }

  approve(messageId: string, actor: Actor): boolean {
    const m = this.row(messageId);
    if (m?.state !== 'approval') return false;
    this.stmt('UPDATE peer_messages SET approved = 1 WHERE id = ?').run(messageId);
    this.trail({ kind: 'approved', message: this.setState(messageId, 'ready'), actor });
    return true;
  }

  decline(messageId: string, actor: Actor): boolean {
    const m = this.row(messageId);
    if (m?.state !== 'approval') return false;
    const row = this.setState(messageId, 'declined');
    this.trail({ kind: 'declined', message: row, actor });
    this.notice(row.fromSession, `Your message to ${row.toName} on ${row.toMachine} was declined by ${actor.name}. It stays in Podium > Traffic.`);
    return true;
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
  private drop(m: MessageRow, why: DropWhy): void {
    const row = this.setState(m.id, 'dropped', why);
    this.trail({ kind: 'dropped', message: row, why });
    this.rights.closeMessageRequest(m.id, 'dropped');
    if (why !== 'messaging-off' && row.author === 'agent') this.notice(row.fromSession, `Your message to ${row.toName} on ${row.toMachine} was not delivered: ${dropReason(row, why)}. It stays in Podium > Traffic.`);
  }

  ended(sessionId: string): void {
    this.liveDir.delete(sessionId);
    this.notices.delete(sessionId);
    for (const m of this.rows(`SELECT * FROM peer_messages WHERE to_session = ? AND state IN (${HELD_SQL}) ORDER BY sent_at, seq`, sessionId)) this.drop(m, 'receiver-ended');
  }

  deleted(sessionIds: string[]): void {
    // Forgotten first, so a deleted sender is not told.
    for (const sid of sessionIds) {
      this.liveDir.delete(sid);
      this.notices.delete(sid);
    }
    for (const sid of sessionIds) {
      for (const m of this.rows(`SELECT * FROM peer_messages WHERE (from_session = ? OR to_session = ?) AND state IN (${HELD_SQL}) ORDER BY sent_at, seq`, sid, sid)) {
        this.drop(m, 'session-deleted');
      }
      this.stmt('DELETE FROM peer_messages WHERE from_session = ? OR to_session = ?').run(sid, sid);
    }
  }

  linkRemoved(a: string, b: string): void {
    for (const m of this.rows(`SELECT * FROM peer_messages WHERE link = ? AND state IN (${HELD_SQL}) ORDER BY sent_at, seq`, linkKey(a, b))) this.drop(m, 'link-removed');
  }

  dropAll(): void {
    for (const m of this.rows(`SELECT * FROM peer_messages WHERE state IN (${HELD_SQL}) ORDER BY sent_at, seq`)) this.drop(m, 'messaging-off');
    this.notices.clear();
  }

  // ---- Reading -----------------------------------------------------------------------------------------------------

  conversations(filter: { ownerId?: number; since?: number; liveOnly?: boolean }): ConversationSummary[] {
    // A summary never carries the text, so it is not read: this backs the open Traffic read, over every owner's messages.
    const all = this.rows(
      `SELECT id, owner, owner_id, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, '' AS text, sent_at, state, state_at, why, approved, author, author_id, edited_at, deleted_at
       FROM peer_messages ORDER BY sent_at, seq`,
    );
    const owner = filter.ownerId ?? null;
    const groups = new Map<string, MessageRow[]>();
    for (const m of all) {
      if (owner !== null && m.ownerId !== owner) continue;
      const pair = ordered(m.fromSession, m.toSession).join('|');
      const g = groups.get(pair) ?? [];
      g.push(m);
      groups.set(pair, g);
    }
    const out: ConversationSummary[] = [];
    for (const g of groups.values()) {
      const s = this.summary(g);
      if (filter.since !== undefined && s.lastAt < filter.since) continue;
      if (filter.liveOnly && !this.liveDir.has(s.a.sessionId) && !this.liveDir.has(s.b.sessionId)) continue;
      out.push(s);
    }
    return out.sort((x, y) => y.lastAt - x.lastAt);
  }

  /** One conversation's summary, from its messages in order. The names are the newest message's. */
  private summary(g: MessageRow[]): ConversationSummary {
    const last = g.at(-1) as MessageRow;
    // The names are the newest message an agent wrote; a person's message in a conversation between two agents carries the person's name.
    const named = [...g].reverse().find((m) => m.author === 'agent') ?? last;
    const from = { sessionId: named.fromSession, name: named.fromName, machine: named.fromMachine, reporterKey: named.fromKey };
    const to = { sessionId: named.toSession, name: named.toName, machine: named.toMachine, reporterKey: named.toKey };
    const [a, b] = from.sessionId <= to.sessionId ? [from, to] : [to, from];
    const ab = this.rights.effective(a.reporterKey, b.reporterKey);
    const ba = this.rights.effective(b.reporterKey, a.reporterKey);
    const paused = ab.paused || ba.paused;
    let state: ConversationSummary['state'] = 'active';
    if (g.some((m) => m.state === 'approval')) state = 'waiting';
    else if (paused) state = 'paused';
    return {
      link: named.link,
      a,
      b,
      owner: named.owner,
      ownerId: named.ownerId,
      messages: shownCount(g),
      lastAt: last.sentAt,
      state,
      paused,
      ...(paused ? pausedByOf(ab, ba) : {}),
      aToB: canSend(ab.level),
      bToA: canSend(ba.level),
      roundTrips: { used: roundTripsUsed(g), cap: this.rights.limits(named.ownerId).roundTrips },
    };
  }

  conversation(a: string, b: string): MessageRow[] {
    return this.rows(`SELECT * FROM peer_messages WHERE ${PAIR_WHERE} ORDER BY sent_at, seq`, a, b, b, a);
  }

  retain(cutoff: number): number {
    const r = this.stmt('DELETE FROM peer_messages WHERE link IN (SELECT link FROM peer_messages GROUP BY link HAVING MAX(sent_at) < ?)').run(cutoff);
    return Number(r.changes);
  }

  // ---- The Chat page (#1034) ---------------------------------------------------------------------------------------

  /** Whether the pair has messages and every one of them is the owner's. A conversation belongs to one owner; this is the guard that keeps another owner's read, delete or hide from reaching it. */
  private ownsPair(ownerId: number, a: string, b: string): boolean {
    // order-insensitive: a set of owners, compared as a whole. A row with no owner (a person since deleted) is nobody's.
    const owners = this.stmt(`SELECT DISTINCT owner_id FROM peer_messages WHERE ${PAIR_WHERE}`).all(a, b, b, a) as unknown as { owner_id: number | null }[];
    return owners.length > 0 && owners.every((r) => r.owner_id !== null && Number(r.owner_id) === ownerId);
  }

  sendFromPerson(input: PersonMessageInput): MessageRow | Refusal {
    const clean = cleanPeerText(input.text);
    if (!clean.trim()) return refuse(400, 'The message is empty. Write the text to send.');
    const target = this.liveDir.get(input.toSession);
    if (!target) {
      // order-insensitive: only whether there is any row counts.
      const known = this.stmt('SELECT (SELECT COUNT(*) FROM peer_messages WHERE to_session = ? OR from_session = ?) + (SELECT COUNT(*) FROM sessions WHERE id = ?) AS n').get(input.toSession, input.toSession, input.toSession) as { n: number };
      return known.n > 0 ? refuse(409, 'That agent has ended, so Podium did not queue the message. It would never be taken.') : refuse(404, 'There is no such agent.');
    }
    if (target.ownerId !== input.ownerId) return refuse(404, 'There is no such agent.');
    if (target.peers !== true) return refuse(403, `${target.name} is not taking part in orchestrator messaging. It needs the peers option on in podium-reporter on its machine.`);
    const limits = this.rights.limits(input.ownerId);
    if (clean.length > limits.maxChars) {
      return refuse(422, overLimitWords(clean.length, limits.maxChars));
    }
    let fromSession = personKeyOf(input.ownerId);
    let fromKey = '';
    let link = linkKey(fromSession, target.reporterKey);
    if (input.withSession) {
      if (!this.ownsPair(input.ownerId, input.toSession, input.withSession)) return refuse(404, 'There is no such conversation.');
      const newest = this.stmt(`SELECT link, from_session, from_key, to_key FROM peer_messages WHERE ${PAIR_WHERE} ORDER BY sent_at DESC, seq DESC LIMIT 1`).get(input.toSession, input.withSession, input.withSession, input.toSession) as
        | { link: string; from_session: string; from_key: string; to_key: string }
        | undefined;
      if (!newest) return refuse(404, 'There is no such conversation.');
      fromSession = input.withSession;
      fromKey = newest.from_session === input.withSession ? newest.from_key : newest.to_key;
      link = newest.link;
    }
    const id = newId();
    const now = this.now();
    this.stmt(
      `INSERT INTO peer_messages (id, owner, owner_id, link, from_key, to_key, from_session, to_session, from_agent, to_agent, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq, author, author_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, NULL, 0, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages), 'person', ?)`,
    ).run(id, target.owner, input.ownerId, link, fromKey, target.reporterKey, fromSession, input.toSession, input.withSession ? (this.liveDir.get(input.withSession)?.agentId ?? this.agentOf(input.withSession)) : null, target.agentId, cleanNameText(input.person).trim() || input.person, target.name, target.machine, clean, now, input.state ?? 'ready', now, input.authorId ?? null);
    return this.row(id) as MessageRow;
  }

  sendAcross(input: AcrossInput): MessageRow | Refusal {
    const clean = cleanPeerText(input.text);
    if (!clean.trim()) return refuse(400, 'The message is empty. Write the text to send.');
    const personKey = personKeyOf(input.personId);
    const target = this.liveDir.get(input.toSession);
    if (!target) {
      // order-insensitive: only whether there is any row counts.
      const known = this.stmt('SELECT (SELECT COUNT(*) FROM peer_messages WHERE to_session = ? OR from_session = ?) + (SELECT COUNT(*) FROM sessions WHERE id = ?) AS n').get(input.toSession, input.toSession, input.toSession) as { n: number };
      return known.n > 0 ? refuse(409, 'That agent has ended, so Podium did not send the message. It would never be taken.') : refuse(404, 'There is no such agent.');
    }
    if (target.ownerId === input.personId) return refuse(422, 'That agent is yours. Write to it from your own conversation with it.');
    if (target.peers !== true || !this.onPersonReporter(target)) return refuse(403, `${target.name} is not taking part in orchestrator messaging, so it cannot be written to.`);
    const limits = this.rights.limits(target.ownerId);
    if (clean.length > limits.maxChars) {
      return refuse(422, overLimitWords(clean.length, limits.maxChars));
    }
    const link = this.rights.personLink(personKey, target.reporterKey);
    if (link?.level === 'none') return refuse(403, `${target.owner} removed the link between you and ${target.name}, so Podium did not send the message. ${target.owner} can open it again.`);
    if (link?.paused) return refuse(409, `The link between you and ${target.name} is paused, so Podium did not send the message. It goes through once the link is resumed.`);
    if (!link) {
      // order-insensitive: only the counts of this person's waiting messages matter.
      const waiting = this.rows(`SELECT * FROM peer_messages WHERE from_session = ? AND state = 'approval'`, personKey);
      if (waiting.some((m) => m.toSession === input.toSession)) return refuse(409, `Your earlier message to ${target.name} still waits for ${target.owner} to approve it. Wait for the answer before you write again.`);
      if (waiting.filter((m) => m.ownerId === target.ownerId).length >= CROSS_PENDING_MAX) {
        return refuse(429, `You already have ${CROSS_PENDING_MAX} messages waiting for ${target.owner} to approve. Wait for answers before you write more.`);
      }
    }
    const state: MessageState = link ? 'ready' : 'approval';
    const id = newId();
    const now = this.now();
    this.stmt(
      `INSERT INTO peer_messages (id, owner, owner_id, link, from_key, to_key, from_session, to_session, to_agent, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq, author, author_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, NULL, 0, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages), 'person', ?)`,
    ).run(id, target.owner, target.ownerId, linkKey(personKey, target.reporterKey), personKey, target.reporterKey, personKey, input.toSession, target.agentId, cleanNameText(input.person).trim() || input.person, target.name, target.machine, clean, now, state, now, input.authorId ?? null);
    if (state === 'approval') {
      this.rights.openMessageRequest({ owner: target.owner, ownerId: target.ownerId, fromKey: personKey, toKey: target.reporterKey, by: input.person, fromSession: personKey, messageId: id });
    }
    this.trail({ kind: 'sent', message: this.row(id) as MessageRow, state: state === 'approval' ? 'approval' : takesMessages(target) ? 'sent' : 'turn', approvalWhy: state === 'approval' ? 'link' : null });
    return this.row(id) as MessageRow;
  }

  page(ownerId: number, a: string, b: string, opts: { before?: string | null; limit: number }): MessagePage {
    const before = opts.before === undefined || opts.before === null ? null : decodeCursor(opts.before);
    const limit = pageSize(opts.limit);
    if (!this.ownsPair(ownerId, a, b)) return { messages: [], older: null };
    const newestFirst = (
      before
        ? this.stmt(`SELECT * FROM peer_messages WHERE (${PAIR_WHERE}) AND (sent_at < ? OR (sent_at = ? AND seq < ?)) ORDER BY sent_at DESC, seq DESC LIMIT ?`).all(a, b, b, a, before.at, before.at, before.seq, limit + 1)
        : this.stmt(`SELECT * FROM peer_messages WHERE ${PAIR_WHERE} ORDER BY sent_at DESC, seq DESC LIMIT ?`).all(a, b, b, a, limit + 1)
    ) as unknown as DbMessage[];
    // The extra row only says there is an older page; the cursor names the oldest row kept, and a page back starts strictly before it.
    const kept = newestFirst.slice(0, limit).reverse();
    const oldest = kept[0];
    return { messages: kept.map(toRow), older: newestFirst.length > limit && oldest ? encodeCursor(oldest.sent_at, oldest.seq as number) : null };
  }

  /** The rows an author's change would touch, or why it is refused (#1269): the one asked for and every row the thread merges with it, decided on one read, in the step the caller holds. */
  private changeOf(id: string, author: number): ReturnType<typeof decideChange> {
    const row = this.row(id);
    return decideChange(row, row ? this.conversation(row.fromSession, row.toSession) : [], author);
  }

  editMessage(id: string, x: PeerMessageEdit): PeerChange {
    const change = this.changeOf(id, x.author);
    if (!change.ok) return change;
    // The owner's limit, as a send checks it, on the text as it is stored (#1269).
    const clean = cleanPeerText(x.text);
    const max = (this.rights.limits(change.group[0]!.ownerId)).maxChars;
    if (clean.length > max) return { ok: false as const, reason: 'too-long' as const, status: 422 as const, error: overLimitWords(clean.length, max) };
    for (const m of change.group) this.stmt('UPDATE peer_messages SET text = ?, edited_at = ? WHERE id = ?').run(x.text, x.now, m.id);
    return { ok: true, message: this.row(id) as MessageRow };
  }

  deleteMessage(id: string, x: { author: number; now: number }): PeerChange {
    const change = this.changeOf(id, x.author);
    if (!change.ok) return change;
    for (const m of change.group) {
      this.stmt(`UPDATE peer_messages SET text = '', deleted_at = ? WHERE id = ?`).run(x.now, m.id);
      // Never approved or handed over now: dropped, with its approval request closed.
      if (m.state === 'approval' || m.state === 'ready') this.drop({ ...m, text: '', deletedAt: x.now }, 'deleted');
    }
    return { ok: true, message: this.row(id) as MessageRow };
  }

  deleteConversation(ownerId: number, a: string, b: string): number {
    if (!this.ownsPair(ownerId, a, b)) return 0;
    for (const m of this.rows(`SELECT * FROM peer_messages WHERE (${PAIR_WHERE}) AND state IN (${HELD_SQL}) ORDER BY sent_at, seq`, a, b, b, a)) this.rights.closeMessageRequest(m.id, 'dropped');
    return Number(this.stmt(`DELETE FROM peer_messages WHERE ${PAIR_WHERE}`).run(a, b, b, a).changes);
  }

  conversationOf(a: string, b: string): ConversationSummary | null {
    // A summary never carries the text, so it is not read: only this pair's rows, by its two session ids.
    const rows = this.rows(`SELECT id, owner, owner_id, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, '' AS text, sent_at, state, state_at, why, approved, author, author_id, edited_at, deleted_at FROM peer_messages WHERE ${PAIR_WHERE} ORDER BY sent_at, seq`, a, b, b, a);
    return rows.length > 0 ? this.summary(rows) : null;
  }

  conversationCounts(ownerIds: number[]): Record<number, number> {
    return countConversations(this.stmt(
        'SELECT owner_id, from_session, to_session, MIN(CASE WHEN hidden_at IS NULL THEN 0 ELSE 1 END) AS all_hidden FROM peer_messages GROUP BY owner_id, from_session, to_session ORDER BY COALESCE(owner_id, 0), from_session, to_session',
      ).all() as unknown as ConversationGroupRow[], ownerIds);
  }

  ownerConversations(ownerId: number, opts: { includeHidden?: boolean; pairs?: string[] } = {}): OwnerConversation[] {
    if (opts.pairs && opts.pairs.length === 0) return [];
    const all = this.stmt(
      `SELECT id, owner, owner_id, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, '' AS text, sent_at, state, state_at, why, approved, author, author_id, edited_at, deleted_at, hidden_at
       FROM peer_messages ORDER BY sent_at, seq`,
    ).all() as unknown as DbMessage[];
    const only = opts.pairs ? new Set(opts.pairs) : null;
    // The person is in a conversation they own, and in one they started with another person's agent (#1034): there `person:<id>` is one of its two ends.
    const me = personKeyOf(ownerId);
    const groups = new Map<string, DbMessage[]>();
    for (const r of all) {
      if ((r.owner_id == null || Number(r.owner_id) !== ownerId) && r.from_session !== me && r.to_session !== me) continue;
      const pair = ordered(r.from_session, r.to_session).join('|');
      if (only && !only.has(pair)) continue;
      const g = groups.get(pair) ?? [];
      g.push(r);
      groups.set(pair, g);
    }
    const out: OwnerConversation[] = [];
    for (const g of groups.values()) {
      const hiddenAt = g.every((r) => r.hidden_at != null) ? latestOf(g.map((r) => r.hidden_at as number)) : null;
      if (hiddenAt !== null && !opts.includeHidden) continue;
      out.push({ ...this.summary(g.map(toRow)), hiddenAt });
    }
    return out.sort((x, y) => y.lastAt - x.lastAt || x.a.sessionId.localeCompare(y.a.sessionId) || x.b.sessionId.localeCompare(y.b.sessionId));
  }

  hideConversation(ownerId: number, a: string, b: string): number {
    if (!this.ownsPair(ownerId, a, b)) return 0;
    return Number(this.stmt(`UPDATE peer_messages SET hidden_at = ? WHERE hidden_at IS NULL AND (${PAIR_WHERE})`).run(this.now(), a, b, b, a).changes);
  }

  showConversation(ownerId: number, a: string, b: string): number {
    if (!this.ownsPair(ownerId, a, b)) return 0;
    return Number(this.stmt(`UPDATE peer_messages SET hidden_at = NULL WHERE hidden_at IS NOT NULL AND (${PAIR_WHERE})`).run(a, b, b, a).changes);
  }

  purgeHidden(now: number, graceMs: number): number {
    for (const m of this.rows(`SELECT * FROM peer_messages WHERE ${HIDDEN_DUE_SQL} AND state IN (${HELD_SQL}) ORDER BY sent_at, seq`, now, now - graceMs)) this.rights.closeMessageRequest(m.id, 'dropped');
    return Number(this.stmt(`DELETE FROM peer_messages WHERE ${HIDDEN_DUE_SQL}`).run(now, now - graceMs).changes);
  }
}
