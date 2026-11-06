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
  type AcrossInput,
  canSend,
  isIdle,
  linkKey,
  peerShortId,
  refuse,
  type Actor,
  type ConversationSummary,
  type DropWhy,
  type LeftOut,
  type PeerListResult,
  type PersonListing,
  type LiveOrchestrator,
  type MessageAuthor,
  type MessagePage,
  type MessageRow,
  type MessageState,
  type OwnerConversation,
  type PersonMessageInput,
  type MessageTrail,
  type PeerListing,
  type PeerMessagesApi,
  type PeerRightsView,
  type Refusal,
  type ReporterLookup,
  type SendOutcome,
} from '../../fleet/peerTypes.js';
import { nameKey } from '../rows.js';
import { MAX_NOTICES, REPLY_WORDS, cleanPeerText, decodeCursor, encodeCursor, pageSize, roundTripsUsed, shownCount, type TripRow } from '../peerText.js';

/** Two orchestrators share an address when their names and machines match the way `resolve` compares them. */
const addressKey = (o: LiveOrchestrator): string => `${nameKey(o.name)}@${nameKey(o.machine)}`;

const RATE_WINDOW_MS = 60_000;

interface DbMessage {
  id: string;
  owner: string;
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
  link: r.link,
  fromKey: r.from_key,
  toKey: r.to_key,
  fromSession: r.from_session,
  toSession: r.to_session,
  fromName: r.from_name,
  fromMachine: r.from_machine,
  toName: r.to_name,
  toMachine: r.to_machine,
  text: r.text,
  sentAt: r.sent_at,
  state: r.state as MessageState,
  stateAt: r.state_at,
  why: r.why as DropWhy | null,
  approved: r.approved === 1,
  author: r.author as MessageAuthor,
});

/** Why a held message was let go, as its sender's notice says it. `messaging-off` tells no one, so it has no words. */
function dropReason(m: MessageRow, why: Exclude<DropWhy, 'messaging-off'>): string {
  switch (why) {
    case 'receiver-ended':
      return `${m.toName} ended first`;
    case 'session-deleted':
      return `${m.toName}'s session was deleted in Podium`;
    case 'link-removed':
      return `the link between ${m.fromMachine} and ${m.toMachine} was removed`;
    default:
      return `${m.toName}'s session did not take it`;
  }
}

const HELD_SQL = HELD_STATES.map((s) => `'${s}'`).join(', ');
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

  note(o: LiveOrchestrator): void {
    if (o.status === 'done') {
      this.ended(o.sessionId);
      return;
    }
    this.liveDir.set(o.sessionId, { ...o });
  }

  live(sessionId: string): LiveOrchestrator | null {
    return this.liveDir.get(sessionId) ?? null;
  }

  /** Whether the orchestrator's reporter is a person's: known, and not on the admin secret. */
  private onPersonReporter(o: LiveOrchestrator): boolean {
    const r = this.reporters.get(o.reporterKey);
    return r !== null && !r.adminSecret;
  }

  /** The orchestrators `sender` could reach: the same owner's, messaging on, on a person's reporter, and seen by the sender's reporter. The sender itself is kept. */
  private reachable(sender: LiveOrchestrator): LiveOrchestrator[] {
    const owner = nameKey(sender.owner);
    return [...this.liveDir.values()].filter(
      (o) =>
        nameKey(o.owner) === owner &&
        o.peers === true &&
        this.onPersonReporter(o) &&
        (o.sessionId === sender.sessionId || this.rights.effective(sender.reporterKey, o.reporterKey).level !== 'none'),
    );
  }

  /** The sender, when it can take part: live, messaging on, on a person's reporter. */
  private sender(sessionId: string): LiveOrchestrator | null {
    const s = this.liveDir.get(sessionId);
    return s && s.peers === true && this.onPersonReporter(s) ? s : null;
  }

  /** The people who wrote to this agent through Chat and whose link is still there (#1034); one who has no link, or whose was removed, is not listed. */
  private peopleOf(sender: LiveOrchestrator): PersonListing[] {
    const rows = this.stmt(`SELECT from_session, from_name FROM peer_messages WHERE to_session = ? AND author = 'person' AND from_session LIKE 'person:%' ORDER BY sent_at, seq`).all(sender.sessionId) as unknown as { from_session: string; from_name: string }[];
    const names = new Map(rows.map((r) => [r.from_session, r.from_name]));
    const out: PersonListing[] = [];
    for (const [address, name] of names) {
      const link = this.rights.personLink(address, sender.reporterKey);
      if (link && link.level !== 'none') out.push({ address, name, paused: link.paused });
      else if (!link && address === `person:${nameKey(sender.owner)}`) out.push({ address, name, paused: false });
    }
    return out.sort((a, b) => a.address.localeCompare(b.address));
  }

  list(sessionId: string): PeerListResult {
    const sender = this.sender(sessionId);
    if (!sender) return { peers: [], leftOut: [], people: [] };
    const others = this.reachable(sender).filter((o) => o.sessionId !== sender.sessionId);
    const copies = new Map<string, number>();
    for (const o of others) copies.set(addressKey(o), (copies.get(addressKey(o)) ?? 0) + 1);
    const peers: PeerListing[] = others
      .map((o) => {
        const right = this.rights.effective(sender.reporterKey, o.reporterKey);
        return {
          address: `${o.name}@${o.machine}`,
          id: peerShortId(o.sessionId),
          duplicate: (copies.get(addressKey(o)) ?? 0) > 1,
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
    for (const r of this.reporters.ofOwner(sender.owner)) {
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

  /** `name@machine`, split at the last `@`, among the orchestrators the sender can reach. `name@machine#id` picks one of several that share the name (#500). */
  private resolve(sender: LiveOrchestrator, to: string): LiveOrchestrator | Refusal {
    const address = to.trim();
    const unseen = refuse(404, `You cannot see an orchestrator called ${address}. Run podium_peers for the list.`);
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
    const others = matches.filter((o) => o.sessionId !== sender.sessionId);
    const plain = `${address.slice(0, at)}@${hash < 0 || wholeName.length ? rest : rest.slice(0, hash)}`;
    const ids = (list: LiveOrchestrator[]): string => list.map((o) => `${plain}#${peerShortId(o.sessionId)}`).join(', ');
    const tooMany = (list: LiveOrchestrator[]): Refusal =>
      refuse(409, `There are ${list.length} orchestrators called ${plain}, so Podium cannot tell which one you mean. Send to one by its id: ${ids(list)}. podium_peers lists the ids.`);
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
  private replyToPerson(sender: LiveOrchestrator, address: string, clean: string, limits: { perMinute: number; roundTrips: number }): SendOutcome | Refusal {
    const unseen = refuse(404, REPLY_WORDS.unseen(address));
    const personKey = `person:${nameKey(address.slice('person:'.length))}`;
    // The newest message the person wrote to this very session names them as they are shown.
    const wrote = this.stmt(`SELECT from_name FROM peer_messages WHERE from_session = ? AND to_session = ? AND author = 'person' ORDER BY sent_at DESC, seq DESC LIMIT 1`).get(personKey, sender.sessionId) as { from_name: string } | undefined;
    const link = this.rights.personLink(personKey, sender.reporterKey);
    // The agent's own owner (#1034) wrote from Chat with no link between them: a person's own agents need none. A conversation the owner deleted has no message left to answer.
    const own = personKey === `person:${nameKey(sender.owner)}`;
    if (!wrote || (!link && !own)) return unseen;
    if (link && link.level === 'none') return refuse(403, REPLY_WORDS.removed(sender.owner, wrote.from_name));
    if (link && link.paused) return refuse(409, REPLY_WORDS.paused(wrote.from_name));
    const now = this.now();
    const recent = (this.stmt(`SELECT COUNT(*) AS n FROM peer_messages WHERE from_session = ? AND to_session = ? AND author = 'agent' AND sent_at > ?`).get(sender.sessionId, personKey, now - RATE_WINDOW_MS) as { n: number }).n;
    if (recent >= limits.perMinute) return refuse(429, REPLY_WORDS.rate(recent, wrote.from_name));
    const id = newId();
    this.stmt(
      `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'delivered', ?, NULL, 0, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages), 'agent')`,
    ).run(id, sender.owner, linkKey(personKey, sender.reporterKey), sender.reporterKey, personKey, sender.sessionId, personKey, sender.name, sender.machine, wrote.from_name, clean, now, now);
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
    const limits = this.rights.limits(sender.owner);
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
      `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages))`,
    ).run(id, sender.owner, link, sender.reporterKey, target.reporterKey, sender.sessionId, target.sessionId, sender.name, sender.machine, target.name, target.machine, clean, now, state, now);
    let requestId: string | null = null;
    if (approvalWhy) {
      requestId = this.rights.openMessageRequest({ owner: sender.owner, fromKey: sender.reporterKey, toKey: target.reporterKey, by: sender.name, fromSession: sender.sessionId, messageId: id }).id;
    }
    let outState: SendOutcome['state'] = isIdle(target) ? 'sent' : 'turn';
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

  deliveriesFor(sessionId: string, idle: boolean): PeerDelivery[] {
    const out: PeerDelivery[] = (this.notices.get(sessionId) ?? []).map((n) => ({ id: n.id, kind: 'notice', at: n.at, from: null, text: n.text }));
    const messages = idle
      ? this.rows(`SELECT * FROM peer_messages WHERE to_session = ? AND state IN ('ready', 'handed') ORDER BY sent_at, seq`, sessionId).filter(
          (m) => !this.rights.effective(m.fromKey, m.toKey).paused,
        )
      : [];
    for (const m of messages) {
      // A person's text (#1034) is handed over as a person's, with this session's owner named, so the reporter frames it as not the owner's.
      const from = m.author === 'person' ? { name: m.fromName, machine: m.fromMachine, owner: m.owner, person: true } : { name: m.fromName, machine: m.fromMachine, owner: m.owner, ...(m.fromSession ? { id: peerShortId(m.fromSession) } : {}) };
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

  conversations(filter: { owner?: string; since?: number; liveOnly?: boolean }): ConversationSummary[] {
    // A summary never carries the text, so it is not read: this backs the open Traffic read, over every owner's messages.
    const all = this.rows(
      `SELECT id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, '' AS text, sent_at, state, state_at, why, approved, author
       FROM peer_messages ORDER BY sent_at, seq`,
    );
    const owner = filter.owner === undefined ? null : nameKey(filter.owner);
    const groups = new Map<string, MessageRow[]>();
    for (const m of all) {
      if (owner !== null && nameKey(m.owner) !== owner) continue;
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
      messages: shownCount(g),
      lastAt: last.sentAt,
      state,
      paused,
      ...(paused ? pausedByOf(ab, ba) : {}),
      aToB: canSend(ab.level),
      bToA: canSend(ba.level),
      roundTrips: { used: roundTripsUsed(g), cap: this.rights.limits(named.owner).roundTrips },
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
  private ownsPair(owner: string, a: string, b: string): boolean {
    // order-insensitive: a set of owners, compared as a whole.
    const owners = this.stmt(`SELECT DISTINCT owner FROM peer_messages WHERE ${PAIR_WHERE}`).all(a, b, b, a) as unknown as { owner: string }[];
    return owners.length > 0 && owners.every((r) => nameKey(r.owner) === nameKey(owner));
  }

  sendFromPerson(input: PersonMessageInput): MessageRow | Refusal {
    const clean = cleanPeerText(input.text);
    if (!clean.trim()) return refuse(400, 'The message is empty. Write the text to send.');
    const owner = nameKey(input.owner);
    const target = this.liveDir.get(input.toSession);
    if (!target) {
      // order-insensitive: only whether there is any row counts.
      const known = this.stmt('SELECT COUNT(*) AS n FROM peer_messages WHERE to_session = ? OR from_session = ?').get(input.toSession, input.toSession) as { n: number };
      return known.n > 0 ? refuse(409, 'That agent has ended, so Podium did not queue the message. It would never be taken.') : refuse(404, 'There is no such agent.');
    }
    if (nameKey(target.owner) !== owner) return refuse(404, 'There is no such agent.');
    if (target.peers !== true) return refuse(403, `${target.name} is not taking part in orchestrator messaging. It needs the peers option on in podium-reporter on its machine.`);
    const limits = this.rights.limits(target.owner);
    if (clean.length > limits.maxChars) {
      const n = (v: number): string => v.toLocaleString('en-US');
      return refuse(422, `The message is ${n(clean.length)} characters, over the limit of ${n(limits.maxChars)}. Send a shorter one.`);
    }
    let fromSession = `person:${owner}`;
    let fromKey = '';
    let link = linkKey(fromSession, target.reporterKey);
    if (input.withSession) {
      if (!this.ownsPair(input.owner, input.toSession, input.withSession)) return refuse(404, 'There is no such conversation.');
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
      `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, 'ready', ?, NULL, 0, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages), 'person')`,
    ).run(id, target.owner, link, fromKey, target.reporterKey, fromSession, input.toSession, cleanPeerText(input.person).trim() || input.person, target.name, target.machine, clean, now, now);
    return this.row(id) as MessageRow;
  }

  sendAcross(input: AcrossInput): MessageRow | Refusal {
    const clean = cleanPeerText(input.text);
    if (!clean.trim()) return refuse(400, 'The message is empty. Write the text to send.');
    const person = nameKey(input.person);
    const personKey = `person:${person}`;
    const target = this.liveDir.get(input.toSession);
    if (!target) {
      // order-insensitive: only whether there is any row counts.
      const known = this.stmt('SELECT COUNT(*) AS n FROM peer_messages WHERE to_session = ? OR from_session = ?').get(input.toSession, input.toSession) as { n: number };
      return known.n > 0 ? refuse(409, 'That agent has ended, so Podium did not send the message. It would never be taken.') : refuse(404, 'There is no such agent.');
    }
    if (nameKey(target.owner) === person) return refuse(422, 'That agent is yours. Write to it from your own conversation with it.');
    if (target.peers !== true || !this.onPersonReporter(target)) return refuse(403, `${target.name} is not taking part in orchestrator messaging, so it cannot be written to.`);
    const limits = this.rights.limits(target.owner);
    if (clean.length > limits.maxChars) {
      const n = (v: number): string => v.toLocaleString('en-US');
      return refuse(422, `The message is ${n(clean.length)} characters, over the limit of ${n(limits.maxChars)}. Send a shorter one.`);
    }
    const link = this.rights.personLink(personKey, target.reporterKey);
    if (link?.level === 'none') return refuse(403, `${target.owner} removed the link between you and ${target.name}, so Podium did not send the message. ${target.owner} can open it again.`);
    if (link?.paused) return refuse(409, `The link between you and ${target.name} is paused, so Podium did not send the message. It goes through once the link is resumed.`);
    if (!link) {
      // order-insensitive: only the counts of this person's waiting messages matter.
      const waiting = this.rows(`SELECT * FROM peer_messages WHERE from_session = ? AND state = 'approval'`, personKey);
      if (waiting.some((m) => m.toSession === input.toSession)) return refuse(409, `Your earlier message to ${target.name} still waits for ${target.owner} to approve it. Wait for the answer before you write again.`);
      if (waiting.filter((m) => nameKey(m.owner) === nameKey(target.owner)).length >= CROSS_PENDING_MAX) {
        return refuse(429, `You already have ${CROSS_PENDING_MAX} messages waiting for ${target.owner} to approve. Wait for answers before you write more.`);
      }
    }
    const state: MessageState = link ? 'ready' : 'approval';
    const id = newId();
    const now = this.now();
    this.stmt(
      `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, NULL, 0, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages), 'person')`,
    ).run(id, target.owner, linkKey(personKey, target.reporterKey), personKey, target.reporterKey, personKey, input.toSession, cleanPeerText(input.person).trim() || input.person, target.name, target.machine, clean, now, state, now);
    if (state === 'approval') {
      this.rights.openMessageRequest({ owner: target.owner, fromKey: personKey, toKey: target.reporterKey, by: input.person, fromSession: personKey, messageId: id });
    }
    this.trail({ kind: 'sent', message: this.row(id) as MessageRow, state: state === 'approval' ? 'approval' : isIdle(target) ? 'sent' : 'turn', approvalWhy: state === 'approval' ? 'link' : null });
    return this.row(id) as MessageRow;
  }

  page(owner: string, a: string, b: string, opts: { before?: string | null; limit: number }): MessagePage {
    const before = opts.before === undefined || opts.before === null ? null : decodeCursor(opts.before);
    const limit = pageSize(opts.limit);
    if (!this.ownsPair(owner, a, b)) return { messages: [], older: null };
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

  deleteConversation(owner: string, a: string, b: string): number {
    if (!this.ownsPair(owner, a, b)) return 0;
    for (const m of this.rows(`SELECT * FROM peer_messages WHERE (${PAIR_WHERE}) AND state IN (${HELD_SQL}) ORDER BY sent_at, seq`, a, b, b, a)) this.rights.closeMessageRequest(m.id, 'dropped');
    return Number(this.stmt(`DELETE FROM peer_messages WHERE ${PAIR_WHERE}`).run(a, b, b, a).changes);
  }

  ownerConversations(owner: string, opts: { includeHidden?: boolean } = {}): OwnerConversation[] {
    const all = this.stmt(
      `SELECT id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, '' AS text, sent_at, state, state_at, why, approved, author, hidden_at
       FROM peer_messages ORDER BY sent_at, seq`,
    ).all() as unknown as DbMessage[];
    const key = nameKey(owner);
    // The person is in a conversation they own, and in one they started with another person's agent (#1034): there `person:<key>` is one of its two ends.
    const me = `person:${key}`;
    const groups = new Map<string, DbMessage[]>();
    for (const r of all) {
      if (nameKey(r.owner) !== key && r.from_session !== me && r.to_session !== me) continue;
      const pair = ordered(r.from_session, r.to_session).join('|');
      const g = groups.get(pair) ?? [];
      g.push(r);
      groups.set(pair, g);
    }
    const out: OwnerConversation[] = [];
    for (const g of groups.values()) {
      const hiddenAt = g.every((r) => r.hidden_at != null) ? Math.max(...g.map((r) => r.hidden_at as number)) : null;
      if (hiddenAt !== null && !opts.includeHidden) continue;
      out.push({ ...this.summary(g.map(toRow)), hiddenAt });
    }
    return out.sort((x, y) => y.lastAt - x.lastAt || x.a.sessionId.localeCompare(y.a.sessionId) || x.b.sessionId.localeCompare(y.b.sessionId));
  }

  hideConversation(owner: string, a: string, b: string): number {
    if (!this.ownsPair(owner, a, b)) return 0;
    return Number(this.stmt(`UPDATE peer_messages SET hidden_at = ? WHERE hidden_at IS NULL AND (${PAIR_WHERE})`).run(this.now(), a, b, b, a).changes);
  }

  showConversation(owner: string, a: string, b: string): number {
    if (!this.ownsPair(owner, a, b)) return 0;
    return Number(this.stmt(`UPDATE peer_messages SET hidden_at = NULL WHERE hidden_at IS NOT NULL AND (${PAIR_WHERE})`).run(a, b, b, a).changes);
  }

  purgeHidden(olderThan: number): number {
    for (const m of this.rows(`SELECT * FROM peer_messages WHERE hidden_at IS NOT NULL AND hidden_at < ? AND state IN (${HELD_SQL}) ORDER BY sent_at, seq`, olderThan)) this.rights.closeMessageRequest(m.id, 'dropped');
    return Number(this.stmt('DELETE FROM peer_messages WHERE hidden_at IS NOT NULL AND hidden_at < ?').run(olderThan).changes);
  }
}
