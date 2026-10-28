// Orchestrator messaging (#347, #412): the message store. SPEC 7.7 "Orchestrator messaging" has the rules and 5.3 the
// reporter's side. Messages, with their text, are kept in `peer_messages` (db.ts migration 20) until retention or their
// sessions' deletion; the live directory of orchestrators and Podium's own notices to them are memory only, and the
// next report refills the directory after a restart. Nothing is stored for a refused message, and nothing here logs:
// each event goes to `trail` as a row, and the routes decide what to write (never the text).
import { randomBytes } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { PEER_LIMITS, type PeerDelivery, type PeerResult } from '../../fleet/protocol.js';
import { nameKey } from './people.js';
import {
  HELD_STATES,
  canSend,
  isIdle,
  linkKey,
  peerShortId,
  refuse,
  type Actor,
  type ConversationSummary,
  type DropWhy,
  type LeftOut,
  type LiveOrchestrator,
  type MessageRow,
  type MessageState,
  type MessageTrail,
  type PeerListing,
  type PeerMessagesApi,
  type PeerRightsView,
  type Refusal,
  type ReporterLookup,
  type SendOutcome,
} from '../../fleet/peerTypes.js';

/** Two orchestrators share an address when their names and machines match the way `resolve` compares them. */
const addressKey = (o: LiveOrchestrator): string => `${nameKey(o.name)}@${nameKey(o.machine)}`;

/** Notices kept for one orchestrator; the oldest goes first. */
export const MAX_NOTICES = 20;
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
}

interface Notice {
  id: string;
  at: number;
  text: string;
}

/** The part of a message round trips are counted from. */
export interface TripRow {
  fromSession: string;
  state: MessageState;
  approved: boolean;
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
});

/**
 * Text with every control character other than a line break or a tab replaced by a space. A loop over char codes, not
 * a regex with control characters in it (SonarCloud typescript:S6324).
 */
export function cleanPeerText(raw: string): string {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    out.push((c < 32 && c !== 9 && c !== 10) || c === 127 ? ' ' : raw[i]);
  }
  return out.join('');
}

/**
 * Round trips in a conversation since its owner last approved a message: the stored messages that were not declined
 * or dropped, from the newest approved one on (all of them when none was), in order; each change of direction is half
 * a round trip, rounded up.
 */
export function roundTripsUsed(rows: readonly TripRow[]): number {
  const kept = rows.filter((r) => r.state !== 'declined' && r.state !== 'dropped');
  let start = 0;
  kept.forEach((r, i) => {
    if (r.approved) start = i;
  });
  let changes = 0;
  for (let i = start + 1; i < kept.length; i++) if (kept[i].fromSession !== kept[i - 1].fromSession) changes++;
  return Math.ceil(changes / 2);
}

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
const TRIP_COLS = 'from_session, state, approved';
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

  list(sessionId: string): { peers: PeerListing[]; leftOut: LeftOut[] } {
    const sender = this.sender(sessionId);
    if (!sender) return { peers: [], leftOut: [] };
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
    return { peers, leftOut };
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
    const rs = this.stmt(`SELECT ${TRIP_COLS} FROM peer_messages WHERE ${PAIR_WHERE} ORDER BY sent_at, rowid`).all(a, b, b, a) as unknown as {
      from_session: string;
      state: string;
      approved: number;
    }[];
    return rs.map((r) => ({ fromSession: r.from_session, state: r.state as MessageState, approved: r.approved === 1 }));
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
      `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0)`,
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
      ? this.rows(`SELECT * FROM peer_messages WHERE to_session = ? AND state IN ('ready', 'handed') ORDER BY sent_at, rowid`, sessionId).filter(
          (m) => !this.rights.effective(m.fromKey, m.toKey).paused,
        )
      : [];
    for (const m of messages) {
      out.push({ id: m.id, kind: 'message', at: m.sentAt, from: { name: m.fromName, machine: m.fromMachine, owner: m.owner, ...(m.fromSession ? { id: peerShortId(m.fromSession) } : {}) }, text: m.text });
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
    if (why !== 'messaging-off') this.notice(row.fromSession, `Your message to ${row.toName} on ${row.toMachine} was not delivered: ${dropReason(row, why)}. It stays in Podium > Traffic.`);
  }

  ended(sessionId: string): void {
    this.liveDir.delete(sessionId);
    this.notices.delete(sessionId);
    for (const m of this.rows(`SELECT * FROM peer_messages WHERE to_session = ? AND state IN (${HELD_SQL}) ORDER BY sent_at, rowid`, sessionId)) this.drop(m, 'receiver-ended');
  }

  deleted(sessionIds: string[]): void {
    // Forgotten first, so a deleted sender is not told.
    for (const sid of sessionIds) {
      this.liveDir.delete(sid);
      this.notices.delete(sid);
    }
    for (const sid of sessionIds) {
      for (const m of this.rows(`SELECT * FROM peer_messages WHERE (from_session = ? OR to_session = ?) AND state IN (${HELD_SQL}) ORDER BY sent_at, rowid`, sid, sid)) {
        this.drop(m, 'session-deleted');
      }
      this.stmt('DELETE FROM peer_messages WHERE from_session = ? OR to_session = ?').run(sid, sid);
    }
  }

  linkRemoved(a: string, b: string): void {
    for (const m of this.rows(`SELECT * FROM peer_messages WHERE link = ? AND state IN (${HELD_SQL}) ORDER BY sent_at, rowid`, linkKey(a, b))) this.drop(m, 'link-removed');
  }

  dropAll(): void {
    for (const m of this.rows(`SELECT * FROM peer_messages WHERE state IN (${HELD_SQL}) ORDER BY sent_at, rowid`)) this.drop(m, 'messaging-off');
    this.notices.clear();
  }

  // ---- Reading -----------------------------------------------------------------------------------------------------

  conversations(filter: { owner?: string; since?: number; liveOnly?: boolean }): ConversationSummary[] {
    // A summary never carries the text, so it is not read: this backs the open Traffic read, over every owner's messages.
    const all = this.rows(
      `SELECT id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, '' AS text, sent_at, state, state_at, why, approved
       FROM peer_messages ORDER BY sent_at, rowid`,
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
    const from = { sessionId: last.fromSession, name: last.fromName, machine: last.fromMachine, reporterKey: last.fromKey };
    const to = { sessionId: last.toSession, name: last.toName, machine: last.toMachine, reporterKey: last.toKey };
    const [a, b] = from.sessionId <= to.sessionId ? [from, to] : [to, from];
    const ab = this.rights.effective(a.reporterKey, b.reporterKey);
    const ba = this.rights.effective(b.reporterKey, a.reporterKey);
    const paused = ab.paused || ba.paused;
    let state: ConversationSummary['state'] = 'active';
    if (g.some((m) => m.state === 'approval')) state = 'waiting';
    else if (paused) state = 'paused';
    return {
      link: last.link,
      a,
      b,
      owner: last.owner,
      messages: g.length,
      lastAt: last.sentAt,
      state,
      paused,
      aToB: canSend(ab.level),
      bToA: canSend(ba.level),
      roundTrips: { used: roundTripsUsed(g), cap: this.rights.limits(last.owner).roundTrips },
    };
  }

  conversation(a: string, b: string): MessageRow[] {
    return this.rows(`SELECT * FROM peer_messages WHERE ${PAIR_WHERE} ORDER BY sent_at, rowid`, a, b, b, a);
  }

  retain(cutoff: number): number {
    const r = this.stmt('DELETE FROM peer_messages WHERE link IN (SELECT link FROM peer_messages GROUP BY link HAVING MAX(sent_at) < ?)').run(cutoff);
    return Number(r.changes);
  }
}
