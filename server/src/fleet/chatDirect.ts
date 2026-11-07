// The direct-message side of Chat (#1034). A conversation is stored in `peer_messages` and is read only by its owner and an Admin. The person is a peer
// in it: they message one of their agents, or add to a conversation between two. A text goes to the agent as a message of the console (the existing
// delivery and the reporter's consent), and the same text is stored here with who wrote it. This file never reads or writes a channel: the audience of a
// table is the table, and `chatSeparation.test.ts` holds this file to it.
import { MERGE_MS } from '../storage/peerText.js';
import { nameKey } from '../storage/rows.js';
import { isPersonKey, type ConversationSummary, type LinkPauser, type MessageRow, type MessageState, type MessageTrail, type OwnerConversation, type PersonLinkOp, type Refusal } from './peerTypes.js';
import { PEER_DROP_WORDS } from './protocol.js';
import { ChatCore, type DeliveryOutcome } from './chatCore.js';
import type { AdminReads, ReadSubject, Told } from './chatAdminReads.js';
import { dmThread, fail, isPersonId, personId, type AdminReading, type ChatViewer, type Fail } from './chatTypes.js';

export interface PartyView {
  sessionId: string;
  name: string;
  machine: string;
  reporterKey: string;
  kind: 'agent' | 'person';
  /** Whether the agent is in the live set; a person is always there. */
  live: boolean;
  status: 'running' | 'waiting' | 'done' | null;
}

export interface DirectInfo {
  thread: string;
  a: PartyView;
  b: PartyView;
  owner: string;
  messages: number;
  lastAt: number;
  state: ConversationSummary['state'];
  paused: boolean;
  /** Who paused the link while it is paused: the Admin's name travels in `pausedByAdmin` (#1034). Null when it is not paused or the pauser is not known. */
  pausedBy: LinkPauser | null;
  pausedByAdmin: string | null;
  /** The Admins reading this conversation now, each with since when and until when they count as live. Empty when no one is. Never text. */
  adminReading: AdminReading[];
  canSend: { aToB: boolean; bToA: boolean };
  roundTrips: { used: number; cap: number };
  /** The names of the agents that have left the live set while others have not. */
  ended: string[];
  unread: number;
  mentions: number;
  hiddenAt: number | null;
  /** Set for a conversation between a person and another person's agent (#1034); null for one with the viewer's own agent or between two agents. */
  cross: CrossInfo | null;
}

/** The two people of a conversation across owners: the person who writes, the owner of the agent, and where their link stands. */
export interface CrossInfo {
  person: string;
  owner: string;
  /** `waiting` while a message waits for the owner; `open`, `paused`, `removed`, or `none` (no link: the owner declined, or nothing was sent yet). */
  link: 'waiting' | 'open' | 'paused' | 'removed' | 'none';
  /** Which of the two the viewer is: the person who wrote, the agent's owner, or an Admin reading. */
  viewerIs: 'sender' | 'owner' | 'admin';
  /** Who paused the link while it is paused; null when it is not, or when the pauser is not known (a pause made before it was kept). */
  pausedBy: LinkPauser | null;
  /** The Admin's name, while `pausedBy` is `admin`; null otherwise. */
  pausedByAdmin: string | null;
  /** Whether the viewer may resume it: whoever paused it, an Admin always, and either owner when the pauser is not known. */
  canResume: boolean;
}

export interface DirectMessageView {
  id: string;
  author: 'agent' | 'person';
  from: { kind: 'agent' | 'person'; sessionId: string | null; name: string; machine: string };
  /** Who it went to: one agent, or both when the person added to a conversation between two. */
  to: { sessionId: string; name: string; machine: string; state: MessageState; why: string | null }[];
  text: string;
  sentAt: number;
  state: MessageState;
  stateAt: number;
  why: string | null;
  /** The reason in words for a message that was declined or dropped; null otherwise. */
  reason: string | null;
  /** The owner a person's message waits for, while it waits for approval (#1034). */
  waitingFor: string | null;
  approved: boolean;
}

const rank = (s: MessageState): number => (s === 'dropped' || s === 'declined' ? 3 : s === 'delivered' ? 0 : 1);

/** A conversation's messages as the page shows them: a person's text that went to both agents of a conversation is shown once. */
export function directMessages(rows: MessageRow[]): DirectMessageView[] {
  const out: DirectMessageView[] = [];
  for (const m of rows) {
    const target = { sessionId: m.toSession, name: m.toName, machine: m.toMachine, state: m.state, why: m.why };
    const last = out.at(-1);
    if (m.author === 'person' && last?.author === 'person' && last.text === m.text && Math.abs(m.sentAt - last.sentAt) <= MERGE_MS && last.from.name === m.fromName && !last.to.some((t) => t.sessionId === m.toSession)) {
      last.to.push(target);
      const worst = last.to.reduce((a, b) => (rank(b.state) > rank(a.state) ? b : a), last.to[0]!);
      last.state = worst.state;
      last.why = worst.why;
      last.stateAt = Math.max(last.stateAt, m.stateAt);
      continue;
    }
    out.push({
      id: m.id,
      author: m.author,
      from: m.author === 'person' ? { kind: 'person', sessionId: null, name: m.fromName, machine: '' } : { kind: 'agent', sessionId: m.fromSession, name: m.fromName, machine: m.fromMachine },
      to: [target],
      text: m.text,
      sentAt: m.sentAt,
      state: m.state,
      stateAt: m.stateAt,
      why: m.why,
      reason: reasonOf(m),
      waitingFor: m.state === 'approval' ? m.owner : null,
      approved: m.approved,
    });
  }
  return out;
}

/** A declined or dropped message's reason in words, for the person who wrote it. */
export function reasonOf(m: Pick<MessageRow, 'state' | 'why' | 'owner' | 'toName'>): string | null {
  if (m.state === 'declined') return `${m.owner} declined it.`;
  if (m.state !== 'dropped' || !m.why) return null;
  if (m.why === 'receiver-ended') return `${m.toName} ended before it got the message.`;
  if (m.why === 'link-removed') return `${m.owner} removed the link.`;
  return `${PEER_DROP_WORDS[m.why] ?? m.why}.`.replace(/^./, (c) => c.toUpperCase());
}

export class DirectChat {
  constructor(
    private readonly core: ChatCore,
    private readonly reads: AdminReads,
  ) {}

  private get peers() {
    return this.core.host.peers.messages;
  }

  /** The whole peer store: rights as well as messages (a person's link to another person's agent, #1034). */
  private get peerStore() {
    return this.core.host.peers;
  }

  private liveOf(sessionId: string) {
    return this.core.host.isLive(sessionId) ? this.peers.live(sessionId) : null;
  }

  private party(p: { sessionId: string; name: string; machine: string; reporterKey: string }): PartyView {
    if (isPersonId(p.sessionId)) return { ...p, kind: 'person', live: true, status: null };
    const o = this.liveOf(p.sessionId);
    return { ...p, kind: 'agent', live: o !== null, status: o?.status ?? null };
  }

  private agentsOf(c: ConversationSummary): string[] {
    return [c.a.sessionId, c.b.sessionId].filter((id) => !isPersonId(id));
  }

  private info(c: OwnerConversation, counts: Map<string, { unread: number; mentions: number }>): DirectInfo {
    const a = this.party(c.a);
    const b = this.party(c.b);
    const thread = dmThread(a.sessionId, b.sessionId);
    const gone = [a, b].filter((p) => p.kind === 'agent' && !p.live);
    const count = counts.get(thread) ?? { unread: 0, mentions: 0 };
    return {
      thread,
      a,
      b,
      owner: c.owner,
      messages: c.messages,
      lastAt: c.lastAt,
      state: c.state,
      paused: c.paused,
      pausedBy: c.paused ? (c.pausedBy ?? null) : null,
      pausedByAdmin: c.paused && c.pausedBy === 'admin' ? (c.pausedByAdmin ?? null) : null,
      adminReading: [],
      canSend: { aToB: c.aToB, bToA: c.bToA },
      roundTrips: c.roundTrips,
      ended: gone.map((p) => p.name),
      unread: count.unread,
      mentions: count.mentions,
      hiddenAt: c.hiddenAt,
      cross: null,
    };
  }

  /** Who is in a conversation across owners, and where the link between them stands. Null for any other conversation. */
  private async crossOf(c: ConversationSummary, viewer: ChatViewer): Promise<CrossInfo | null> {
    const personEnd = [c.a, c.b].find((p) => isPersonId(p.sessionId));
    const agentEnd = [c.a, c.b].find((p) => !isPersonId(p.sessionId));
    if (!personEnd || !agentEnd || nameKey(c.owner) === personEnd.sessionId.slice('person:'.length)) return null;
    const row = await this.peerStore.rights.personLink(personEnd.sessionId, agentEnd.reporterKey);
    const link: CrossInfo['link'] = row === null ? (c.state === 'waiting' ? 'waiting' : 'none') : row.level === 'none' ? 'removed' : row.paused ? 'paused' : c.state === 'waiting' ? 'waiting' : 'open';
    const role = this.role(viewer, c);
    const viewerIs = role === 'owner' ? 'owner' : role === 'sender' ? 'sender' : 'admin';
    const pausedBy = link === 'paused' ? (row?.pausedBy ?? null) : null;
    const pausedByAdmin = pausedBy === 'admin' ? (row?.pausedByAdmin ?? null) : null;
    return { person: personEnd.name, owner: c.owner, link, viewerIs, pausedBy, pausedByAdmin, canResume: link === 'paused' && (viewerIs === 'admin' || pausedBy === null || pausedBy === viewerIs) };
  }

  /** How the viewer stands to a conversation: the owner of its agent, the person who wrote to that agent, an Admin, or no one who may read it. */
  private role(viewer: ChatViewer, c: ConversationSummary): 'owner' | 'sender' | 'admin' | null {
    if (viewer.personId !== null && nameKey(c.owner) === nameKey(viewer.name)) return 'owner';
    if (viewer.personId !== null && (c.a.sessionId === personId(viewer.name) || c.b.sessionId === personId(viewer.name))) return 'sender';
    return viewer.admin ? 'admin' : null;
  }

  /** The viewer's conversations, without hidden ones. Never any text. */
  async list(viewer: ChatViewer): Promise<DirectInfo[]> {
    if (viewer.personId === null) return [];
    const rs = await this.core.store.readState.list(viewer.name);
    const counts = new Map(rs.map((r) => [r.thread, { unread: r.unread, mentions: r.mentions }]));
    const mine = await this.peers.ownerConversations(viewer.name);
    return Promise.all(mine.map(async (c) => ({ ...this.info(c, counts), cross: await this.crossOf(c, viewer) })));
  }

  /** An Admin browsing `owner`'s conversations (#1034): the same list as that person's, with no unread or mention counts, seen as the Admin. Never any text. */
  async listAbout(viewer: ChatViewer, owner: string): Promise<DirectInfo[]> {
    if (!viewer.admin) return [];
    const mine = await this.peers.ownerConversations(owner);
    return Promise.all(mine.map(async (c) => ({ ...this.info(c, new Map()), cross: await this.crossOf(c, viewer) })));
  }

  /**
   * The person's conversations that have left the list because every agent in them ended (#1051). The overview shows one only while an Admin is reading it, so
   * a person can see who is reading a conversation they cannot open. `asAdmin` is an Admin browsing the person. Never any text.
   */
  async hiddenOf(viewer: ChatViewer, owner: string, asAdmin: boolean): Promise<DirectInfo[]> {
    if (viewer.personId === null && !asAdmin) return [];
    const mine = (await this.peers.ownerConversations(owner, { includeHidden: true })).filter((c) => c.hiddenAt !== null);
    return Promise.all(mine.map(async (c) => ({ ...this.info(c, new Map()), cross: await this.crossOf(c, viewer) })));
  }

  /** How many conversations a person takes part in, hidden ones left out. */
  async countOf(owner: string): Promise<number> {
    return (await this.peers.ownerConversations(owner)).length;
  }

  /** `me` is the viewer's own place in a conversation with one agent. */
  private ids(viewer: ChatViewer, a: string, b: string): [string, string] {
    const me = viewer.personId === null ? null : personId(viewer.name);
    return [a === 'me' && me ? me : a, b === 'me' && me ? me : b];
  }

  /** The stored conversation between two ids, from its summaries (no text). */
  private async find(a: string, b: string): Promise<ConversationSummary | null> {
    const [x, y] = a <= b ? [a, b] : [b, a];
    return (await this.peers.conversations({})).find((c) => c.a.sessionId === x && c.b.sessionId === y) ?? null;
  }

  /** A live agent the viewer can start a conversation with (no message yet): their own, or another person's whose reporter takes part in messaging (#1034). */
  private newWith(viewer: ChatViewer, a: string, b: string): { sessionId: string; own: boolean } | null {
    if (viewer.personId === null) return null;
    const me = personId(viewer.name);
    const other = a === me ? b : b === me ? a : null;
    const o = other ? this.liveOf(other) : null;
    if (!o) return null;
    if (nameKey(o.owner) === nameKey(viewer.name)) return { sessionId: o.sessionId, own: true };
    return o.peers === true ? { sessionId: o.sessionId, own: false } : null;
  }

  async thread(viewer: ChatViewer, rawA: string, rawB: string, opts: { before?: string | null; limit: number }) {
    const [a, b] = this.ids(viewer, rawA, rawB);
    const c = await this.find(a, b);
    if (!c) {
      const fresh = this.newWith(viewer, a, b);
      if (!fresh) return fail(404, 'There is no such conversation.');
      const o = this.liveOf(fresh.sessionId)!;
      const me = { sessionId: personId(viewer.name), name: viewer.name, machine: '', reporterKey: '' };
      const agent = { sessionId: o.sessionId, name: o.name, machine: o.machine, reporterKey: o.reporterKey };
      const [x, y] = me.sessionId <= agent.sessionId ? [me, agent] : [agent, me];
      const cross: CrossInfo | null = fresh.own ? null : { person: viewer.name, owner: o.owner, link: 'none', viewerIs: 'sender', pausedBy: null, pausedByAdmin: null, canResume: false };
      return { ok: true as const, thread: dmThread(a, b), a: this.party(x), b: this.party(y), messages: [] as DirectMessageView[], older: null, total: 0, ended: [] as string[], owner: nameKey(fresh.own ? viewer.name : o.owner), paused: false, pausedBy: null, pausedByAdmin: null, adminReads: [] as { admin: string; startedAt: number; lastSeenAt: number }[], roundTrips: { used: 0, cap: 0 }, cross };
    }
    const role = this.role(viewer, c);
    // Someone who is not in it hears what they hear of a conversation that is not there, so the answer does not say which ones exist (#1051).
    if (!role) return fail(404, 'There is no such conversation.');
    let page;
    try {
      page = await this.peers.page(c.owner, a, b, opts);
    } catch (err) {
      return fail(400, (err as Error).message);
    }
    // An Admin's read is recorded before it is answered, so no conversation is read without a record, and its people are told. A refused read (above) records nothing.
    if (role === 'admin') await this.reads.note(viewer, this.subject(c));
    const info = this.info({ ...c, hiddenAt: null }, new Map());
    const adminReads = await this.reads.list(info.thread);
    // The records go to the person's own console here, so what is owed to them is seen (#1051).
    if (role !== 'admin') await this.reads.seen(info.thread, viewer.name);
    return { ok: true as const, thread: info.thread, a: info.a, b: info.b, messages: directMessages(page.messages), older: page.older, total: c.messages, ended: info.ended, owner: c.owner, paused: info.paused, pausedBy: info.pausedBy, pausedByAdmin: info.pausedByAdmin, adminReads, roundTrips: c.roundTrips, cross: await this.crossOf(c, viewer) };
  }

  /** Who is told when an Admin reads this conversation: its owner, and the person who wrote when it is across owners, in every live reporter session of each. */
  private subject(c: ConversationSummary): ReadSubject {
    return { scope: 'dm', thread: dmThread(c.a.sessionId, c.b.sessionId), owners: this.peopleOf(c), phrase: `is reading your Podium conversation between ${c.a.name} and ${c.b.name}` };
  }

  /** The people of a conversation, folded: its owner, and the person who wrote when it is across owners. */
  private peopleOf(c: ConversationSummary): string[] {
    const person = [c.a, c.b].find((p) => isPersonId(p.sessionId));
    return [...new Set([nameKey(c.owner), ...(person ? [nameKey(person.sessionId.slice('person:'.length))] : [])])];
  }

  /**
   * An Admin reads the text of the conversation between two ids on a route outside Chat (the Admin's Reporters page, or Traffic): the same record, Admin log line
   * and notices as an Admin's read in Chat (#1072). Called before the text is answered, so a failure to record stops the read. False when there is no such
   * conversation, and then nothing was recorded.
   */
  async noteAdminRead(viewer: ChatViewer, a: string, b: string): Promise<boolean> {
    const c = await this.find(a, b);
    if (!c) return false;
    // Only an Admin who is not in the conversation is noticed, as in Chat: its owner, and the person who wrote to it, read their own (the read is still served).
    if (this.role(viewer, c) === 'admin') await this.reads.note(viewer, this.subject(c));
    return true;
  }

  /** What the callout of a thread says, from its conversation: for the reporter sessions of its people. Null when there is no such conversation. */
  async subjectOf(thread: string): Promise<ReadSubject | null> {
    const c = (await this.peers.conversations({})).find((x) => dmThread(x.a.sessionId, x.b.sessionId) === thread);
    return c ? this.subject(c) : null;
  }

  /**
   * The sessions of a conversation's people that are live, each told in words that name the conversation. Every live session of the owner and of the person
   * who wrote is told, not only the agents in it (#1051).
   */
  private told(c: ConversationSummary, about: string): Told[] {
    return this.peopleOf(c).flatMap((p) => this.reads.sessionsOf(p).map((sessionId) => ({ sessionId, about })));
  }

  /** An Admin is about to pause or resume a link: it stays on the conversation's record, and each of its people's sessions is told which link it was. */
  private async stoppedLink(viewer: ChatViewer, c: ConversationSummary, op: 'pause' | 'resume'): Promise<void> {
    const link = `the link between ${c.a.name} and ${c.b.name}`;
    await this.reads.stopped(viewer, dmThread(c.a.sessionId, c.b.sessionId), op === 'pause' ? 'paused' : 'resumed', this.told(c, link), this.peopleOf(c));
  }

  /** An Admin's open conversation says it is still being read, so its people keep seeing it. Content-free. */
  async reading(viewer: ChatViewer, rawA: string, rawB: string): Promise<{ ok: true } | Fail> {
    if (!viewer.admin) return fail(403, 'Only an Admin reads a conversation that is not their own.');
    const [a, b] = this.ids(viewer, rawA, rawB);
    const c = await this.find(a, b);
    if (!c) return fail(404, 'There is no such conversation.');
    if (this.role(viewer, c) !== 'admin') return fail(403, 'That conversation is yours, so reading it is not recorded.');
    await this.reads.note(viewer, this.subject(c), true);
    return { ok: true };
  }

  /** The person writes. See the file's head for the path; the text is redacted first, and nothing is stored for an agent that did not take it. */
  async send(viewer: ChatViewer, rawA: string, rawB: string, body: Record<string, unknown>) {
    if (viewer.personId === null) return fail(403, 'Only the person who owns a conversation can add to it.');
    const [a, b] = this.ids(viewer, rawA, rawB);
    const owner = nameKey(viewer.name);
    const c = await this.find(a, b);
    const role = c ? this.role(viewer, c) : null;
    const me = personId(viewer.name);
    // Another person's agent (#1034): the person asks its owner. The agent's owner writes to it from their own conversation with it.
    if (c && role === 'owner' && [c.a.sessionId, c.b.sessionId].some((id) => isPersonId(id) && id !== me)) return fail(409, 'This conversation is with another person. Write to your agent from your own conversation with it.');
    if (c && role === 'sender') return this.sendAcrossDm(viewer, [a, b].find((id) => !isPersonId(id))!, body);
    if (c && !role) return fail(404, 'There is no such conversation.');
    if (c && role !== 'owner') return fail(403, 'Only the people in a conversation can add to it, and an Admin can read it.');
    const fresh = c ? null : this.newWith(viewer, a, b);
    if (!c && !fresh) return fail(404, 'There is no such conversation.');
    if (fresh && !fresh.own) return this.sendAcrossDm(viewer, fresh.sessionId, body);
    if (typeof body.text !== 'string' || !body.text.trim()) return fail(400, 'The message is empty. Write the text to send.');
    // The checks that cost nothing come before the scan for secrets, which reads every character: type, length, then rate (#1051).
    const early = await this.early(viewer, body.text, true);
    if (early) return early;
    const text = this.core.redact(body.text);
    const agents = [a, b].filter((id) => !isPersonId(id));
    const want = Array.isArray(body.to) ? body.to.filter((x): x is string => typeof x === 'string') : agents;
    if (!want.length || want.some((id) => !agents.includes(id))) return fail(400, 'to must name an agent of this conversation.');
    const names = new Map<string, string>([c?.a, c?.b].flatMap((p) => (p ? [[p.sessionId, p.name] as [string, string]] : [])));
    const nameOf = (id: string): string => this.peers.live(id)?.name ?? names.get(id) ?? id;
    const skipped: { sessionId: string; name: string; why: string }[] = [];
    const errors: { sessionId: string; name: string; status: number; error: string }[] = [];
    const live = want.filter((id) => {
      if (this.liveOf(id)) return true;
      skipped.push({ sessionId: id, name: nameOf(id), why: `${nameOf(id)} has ended, so it will not receive this message.` });
      return false;
    });
    if (!live.length) return fail(409, `${want.length > 1 ? 'Every agent in this conversation has' : `${nameOf(want[0]!)} has`} ended, so Podium did not queue the message. It would never be taken.`);
    const stored: MessageRow[] = [];
    for (const sid of live) {
      const o = this.liveOf(sid)!;
      if (nameKey(o.owner) !== owner) return fail(404, 'There is no such conversation.');
      const other = agents.find((x) => x !== sid);
      // The person's own conversation with this one agent: it may answer in the thread. A word added to a conversation between two agents has no such thread to answer in.
      const sent = this.core.deliver(sid, viewer.name, o.name, text, !other);
      if (!sent.ok) {
        errors.push({ sessionId: sid, name: o.name, status: sent.status, error: sent.error });
        continue;
      }
      const row = await this.peers.sendFromPerson({ owner: viewer.name, person: viewer.name, toSession: sid, ...(other ? { withSession: other } : {}), text, state: 'queued' });
      if ('ok' in row) {
        this.core.host.respond.discard(sent.delivery.id, viewer.name, true);
        errors.push({ sessionId: sid, name: o.name, status: (row as Refusal).status, error: (row as Refusal).error });
        continue;
      }
      // Stored as queued from the start (no window in which a report could see it ready), so the peer path does not hand it a second time.
      this.core.watch(sent.delivery.id, (out) => this.followed(sid, row.id, out));
      this.core.onEvent({ kind: 'dm_sent', owner, by: viewer.actor, messageId: row.id, sessionId: sid });
      stored.push(row);
    }
    if (!stored.length) {
      const first = errors[0]!;
      return fail(first.status, first.error);
    }
    this.core.signal({ scope: 'dm', owner });
    return { ok: true as const, message: directMessages(stored)[0]!, skipped, errors };
  }

  // ---- A person writes to another person's agent (#1034) ------------------------------------------------------------

  /** The count the owner's stream signal carries: messages from other people that wait for the owner's approval. A count only. */
  async approvalsFor(owner: string): Promise<number> {
    return (await this.peerStore.rights.openRequests(owner)).filter((r) => r.kind === 'message' && isPersonKey(r.fromKey)).length;
  }

  /** Tells the person's consoles, and the owner's with the count of what waits for them. Never any text. */
  private async tell(person: string, owner: string): Promise<void> {
    this.core.signal({ scope: 'dm', owner: nameKey(person) });
    if (nameKey(owner) !== nameKey(person)) this.core.signal({ scope: 'dm', owner: nameKey(owner), approvals: await this.approvalsFor(owner) });
  }

  /** The text of a person's message to another person's agent: stored and held for the agent's owner, or sent at once over a link the owner opened. */
  private async acrossRow(viewer: ChatViewer, sessionId: string, text: string, rate: boolean, redact = false): Promise<{ ok: true; row: MessageRow } | Fail> {
    if (viewer.personId === null) return fail(403, "Only a signed-in person can write to another person's agent.");
    const early = await this.early(viewer, text, rate);
    if (early) return early;
    const refused = await this.acrossTarget(sessionId);
    if (refused) return refused;
    // The text comes in raw from a direct message (checked above first) and already redacted from a channel post.
    const row = await this.peers.sendAcross({ person: viewer.name, toSession: sessionId, text: redact ? this.core.redact(text) : text });
    if ('ok' in row) return fail(row.status, row.error);
    this.core.onEvent({ kind: 'across', owner: nameKey(row.owner), person: nameKey(viewer.name), by: viewer.actor, messageId: row.id, sessionId, approval: row.state === 'approval' });
    await this.tell(viewer.name, row.owner);
    return { ok: true, row };
  }

  /**
   * What is checked of a person's text before anything reads it (#1051): its length against Chat's limit, then, for a message written in a conversation, the
   * person's per-minute limit. The scan for secrets runs after both, so a text that is refused costs nothing to refuse.
   */
  private async early(viewer: ChatViewer, text: string, rate: boolean): Promise<Fail | null> {
    const limits = await this.core.limits();
    if (text.length > limits.maxChars) return fail(422, `The message is ${text.length.toLocaleString('en-US')} characters, over the limit of ${limits.maxChars.toLocaleString('en-US')}. Send a shorter one.`);
    if (rate) {
      const wait = this.core.rate(`person:${nameKey(viewer.name)}`, limits.perMinute);
      if (wait !== null) return fail(429, `That is more than ${limits.perMinute} messages a minute, the limit here. Try again in ${wait} seconds.`);
    }
    return null;
  }

  /**
   * Whether the agent can be written to by a person who is not its owner (#1051): its reporter takes messages from Podium (the Admin's respond switches, the
   * respond level at questions or higher and the activity feed on, which is what a Direct Message to your own agent needs), and it declares the `adminNotices`
   * capability, which means it shows the Admin callout and frames a person's text. Said before the owner is asked, so a message that could never be taken waits for no one.
   */
  private async acrossTarget(sessionId: string): Promise<Fail | null> {
    const o = this.peers.live(sessionId);
    if (!o || o.peers !== true) return null;
    if (!this.core.host.respondFlagsOn()) return fail(403, 'Responding is off, so Podium cannot hand a message to an agent. An Admin turns it on in Admin > Settings.');
    if (!this.core.host.respond.info(sessionId)?.accepts.includes('message')) {
      return fail(422, `${o.name} does not take messages from Podium: its owner has its respond level off, or its activity feed off, in podium-reporter on its machine. ${o.owner} can turn them on.`);
    }
    if (!this.core.host.respond.adminNotices(sessionId)) {
      return fail(422, `${o.name} runs a podium-reporter that is too old to show its person who is reading, or to mark your text as a person's. ${o.owner} can update podium-reporter on ${o.machine}.`);
    }
    return null;
  }

  /** What the channel side asks: the same, with its own text (already redacted) and its own rate limit. */
  async across(viewer: ChatViewer, sessionId: string, text: string, opts: { rate: boolean }): Promise<{ ok: true; state: 'approval' | 'ready'; owner: string } | Fail> {
    const out = await this.acrossRow(viewer, sessionId, text, opts.rate);
    if ('status' in out) return out;
    return { ok: true, state: out.row.state === 'approval' ? 'approval' : 'ready', owner: out.row.owner };
  }

  private async sendAcrossDm(viewer: ChatViewer, agentId: string, body: Record<string, unknown>) {
    if (typeof body.text !== 'string' || !body.text.trim()) return fail(400, 'The message is empty. Write the text to send.');
    if (Array.isArray(body.to) && body.to.some((x) => x !== agentId)) return fail(400, 'to must name an agent of this conversation.');
    const out = await this.acrossRow(viewer, agentId, body.text, true, true);
    if ('status' in out) return out;
    return { ok: true as const, message: directMessages([out.row])[0]!, skipped: [] as { sessionId: string; name: string; why: string }[], errors: [] as { sessionId: string; name: string; status: number; error: string }[] };
  }

  /**
   * Pause link, Resume link, Remove link, or (the agent's owner only) open it again after a removal, for a conversation across owners. The person who
   * wrote and the agent's owner may each pause, resume or remove at any time; either one's pause holds for both, and a removal keeps the link removed.
   */
  async link(viewer: ChatViewer, rawA: string, rawB: string, rawOp: unknown): Promise<{ ok: true; link: CrossInfo['link'] } | Fail> {
    const op = (['pause', 'resume', 'remove', 'allow'] as const).find((x) => x === rawOp) as PersonLinkOp | undefined;
    if (!op) return fail(400, 'op must be pause, resume, remove or allow.');
    const [a, b] = this.ids(viewer, rawA, rawB);
    const c = await this.find(a, b);
    if (!c) return fail(404, 'There is no such conversation.');
    const role = this.role(viewer, c);
    if (!role) return fail(404, 'There is no such conversation.');
    const cross = await this.crossOf(c, viewer);
    // An Admin can stop any conversation (pause it, and resume what they paused or anyone did) but never remove its link: that is the people's.
    if (role === 'admin' && op !== 'pause' && op !== 'resume') return fail(403, 'An Admin can pause and resume a link, not remove it. Its people do that.');
    if (!cross) {
      if (role !== 'admin') return fail(404, 'That link is between two of your own reporters. Change it on My reporters.');
      return this.adminLink(viewer, c, op);
    }
    if (op === 'allow' && role === 'sender') return fail(403, `Only ${cross.owner} can open the link again.`);
    // Allow opens a link that was removed. A paused link is resumed by whoever paused it (#1051), so an allow never lifts a pause.
    if (op === 'allow' && cross.link === 'paused') return fail(409, 'This link is paused. Resume it (the one who paused it, or an Administrator, can) instead of opening it again.');
    const personEnd = [c.a, c.b].find((p) => isPersonId(p.sessionId))!;
    const agentEnd = [c.a, c.b].find((p) => !isPersonId(p.sessionId))!;
    // Only whoever paused a link can resume it, and an Admin (#1034). A pause whose pauser is not known may be resumed by either owner.
    if (op === 'resume' && !cross.canResume && cross.link === 'paused') {
      const who = cross.pausedBy === 'sender' ? cross.person : cross.pausedBy === 'owner' ? cross.owner : 'An Administrator';
      return fail(403, cross.pausedBy === 'admin' ? 'An Administrator paused this link, so only an Administrator can resume it.' : `${who} paused this link, so only ${who} can resume it.`);
    }
    // A pause stays with whoever made it: pausing again does not take it over, so the one who paused can still resume it. Only an Admin's pause replaces another's.
    if (op === 'pause' && cross.link === 'paused' && role !== 'admin') return { ok: true, link: cross.link };
    // An Admin's stop is recorded before it is done (#1051), so a stop that could not be recorded does not happen.
    if (role === 'admin' && (op === 'pause' || op === 'resume') && (op === 'pause') !== (cross.link === 'paused')) await this.stoppedLink(viewer, c, op);
    const out = await this.peerStore.setPersonLink(personEnd.sessionId, agentEnd.reporterKey, op, { name: viewer.actor, admin: role === 'admin' }, op === 'pause' ? role : undefined);
    if (!out.ok) return fail(out.status, out.error);
    await this.tell(personEnd.name, c.owner);
    return { ok: true, link: (await this.crossOf(c, viewer))?.link ?? 'none' };
  }

  /** An Admin pauses or resumes the link between two of a person's own reporters, by the pause the owner has on My reporters, tagged as the Admin's. */
  private async adminLink(viewer: ChatViewer, c: ConversationSummary, op: PersonLinkOp): Promise<{ ok: true; link: CrossInfo['link'] } | Fail> {
    if (isPersonId(c.a.sessionId) || isPersonId(c.b.sessionId)) return fail(404, 'That conversation has no link to pause.');
    await this.stoppedLink(viewer, c, op === 'pause' ? 'pause' : 'resume');
    const out = await this.peerStore.rights.pauseLink(null, c.a.reporterKey, c.b.reporterKey, op === 'pause', { name: viewer.actor, admin: true });
    if (!out.ok) return fail(out.status, out.error);
    this.core.signal({ scope: 'dm', owner: nameKey(c.owner) });
    return { ok: true, link: op === 'pause' ? 'paused' : 'open' };
  }

  /**
   * A new message in a conversation is one more unread for each person who can read it and did not write it, and a mention for the one it is addressed to
   * (the owner of the agent a person wrote to). A person's message to their own agent counts for no one: they wrote it.
   */
  private async count(m: MessageRow): Promise<void> {
    const owner = nameKey(m.owner);
    if (m.author === 'person' && isPersonId(m.fromSession) && m.fromSession === `person:${owner}`) return;
    const thread = dmThread(m.fromSession, m.toSession);
    // An agent's answer to the person who wrote to it (#1034): one more unread for the person, and a mention, since it is addressed to them. When that person
    // is the agent's own owner there is one reader, so one count, and it is the mention.
    const toPerson = m.author === 'agent' && isPersonId(m.toSession) ? m.toSession.slice('person:'.length) : null;
    if (toPerson !== owner) await this.core.count(owner, thread, 'dm', m.author === 'person');
    if (toPerson !== null) await this.core.count(toPerson, thread, 'dm', true);
  }

  /** What the owner's answer, a drop or a delivery did to a person's message to another person's agent: the channel side moves the mention the person wrote. */
  peerTrail(t: MessageTrail): void {
    const m = t.message;
    // An agent's answer to a person is stored delivered, and counts like a new message (#1034).
    if (t.kind === 'sent' || (t.kind === 'delivered' && m.author === 'agent' && isPersonId(m.toSession))) void this.count(m).catch((err: unknown) => this.core.host.warn('a direct message in Chat could not be counted', err));
    if (m.author !== 'person' || !isPersonId(m.fromSession) || nameKey(m.owner) === m.fromSession.slice('person:'.length)) return;
    const person = m.fromSession.slice('person:'.length);
    const update = (from: ('approval' | 'waiting')[], state: 'waiting' | 'working' | 'dropped', why: string | null) => this.core.tellAcross({ person, sessionId: m.toSession, from, state, why });
    if (t.kind === 'approved') update(['approval'], 'waiting', null);
    else if (t.kind === 'declined') update(['approval'], 'dropped', `${m.owner} declined it`);
    else if (t.kind === 'delivered') update(['waiting', 'approval'], 'working', null);
    else if (t.kind === 'dropped') update(['approval', 'waiting'], 'dropped', reasonOf({ state: 'dropped', why: t.why, owner: m.owner, toName: m.toName })?.replace(/\.$/, '') ?? null);
    else return;
    void this.tell(m.fromName, m.owner).catch((err: unknown) => this.core.host.warn('a direct message in Chat could not signal', err));
  }

  /** What the agent did with a text: taken is Delivered, refused is Dropped. An agent that ended drops its queued messages itself. */
  private followed(sessionId: string, id: string, out: DeliveryOutcome): void {
    const result = out.kind === 'took' ? 'took' : out.kind === 'not-delivered' ? 'refused' : null;
    if (!result) return;
    void this.peers
      .result(sessionId, id, result)
      .then(() => this.core.signal({ scope: 'dm', owner: null }))
      .catch((err: unknown) => this.core.host.warn('a direct message in Chat could not be updated', err));
  }

  /** Delete conversation: the messages and the row go; the link and its rights stay. Either person of a conversation across owners may. */
  async remove(viewer: ChatViewer, rawA: string, rawB: string): Promise<{ ok: true; removed: number } | Fail> {
    if (viewer.personId === null) return fail(403, 'Only the people in a conversation can delete it.');
    const [a, b] = this.ids(viewer, rawA, rawB);
    const c = await this.find(a, b);
    if (!c) return fail(404, 'There is no such conversation.');
    const role = this.role(viewer, c);
    if (!role) return fail(404, 'There is no such conversation.');
    if (role !== 'owner' && role !== 'sender') return fail(403, 'Only the people in a conversation can delete it.');
    const removed = await this.peers.deleteConversation(c.owner, a, b);
    await this.core.store.readState.forget(dmThread(a, b));
    await this.reads.forget(dmThread(a, b));
    this.core.onEvent({ kind: 'dm_deleted', owner: nameKey(c.owner), by: viewer.actor, a, b, count: removed });
    this.core.signal({ scope: 'dm', owner: nameKey(c.owner) });
    const person = [c.a, c.b].find((p) => isPersonId(p.sessionId));
    if (person && role === 'sender') this.core.signal({ scope: 'dm', owner: nameKey(viewer.name) });
    else if (person && nameKey(person.name) !== nameKey(c.owner)) this.core.signal({ scope: 'dm', owner: nameKey(person.name) });
    return { ok: true, removed };
  }

  /** Whether the viewer may count a thread: it is one of their conversations. */
  async owns(viewer: ChatViewer, thread: string): Promise<boolean> {
    if (viewer.personId === null) return false;
    return (await this.peers.ownerConversations(viewer.name, { includeHidden: true })).some((c) => dmThread(c.a.sessionId, c.b.sessionId) === thread);
  }

  // ---- A conversation leaves the list, and comes back ---------------------------------------------------------------

  /** Hides what has no live agent left, and shows what has one again, among the owner's conversations that include `sessionId` (or all of them). */
  private async reconcileOwner(owner: string, only: string | null): Promise<void> {
    let changed = false;
    for (const c of await this.peers.ownerConversations(owner, { includeHidden: true })) {
      if (only !== null && c.a.sessionId !== only && c.b.sessionId !== only) continue;
      const anyLive = this.agentsOf(c).some((id) => this.core.host.isLive(id));
      if (!anyLive && c.hiddenAt === null) changed = (await this.peers.hideConversation(owner, c.a.sessionId, c.b.sessionId)) > 0 || changed;
      else if (anyLive && c.hiddenAt !== null) changed = (await this.peers.showConversation(owner, c.a.sessionId, c.b.sessionId)) > 0 || changed;
    }
    if (changed) this.core.signal({ scope: 'dm', owner: nameKey(owner) });
  }

  async sessionChanged(sessionId: string, owner: string): Promise<void> {
    await this.reconcileOwner(owner, sessionId);
    this.core.signal({ scope: 'dm', owner: nameKey(owner) });
  }

  /** A session reported: its hidden conversations come back. `reconcileOwner` signals the consoles only when one did. */
  async sessionSeen(sessionId: string, owner: string): Promise<void> {
    await this.reconcileOwner(owner, sessionId);
  }

  /** Every owner's conversations, against the live set now: at start and hourly, for what changed while the server was down. */
  async reconcile(): Promise<void> {
    for (const owner of new Set((await this.peers.conversations({})).map((c) => c.owner))) await this.reconcileOwner(owner, null);
  }

  /** The threads of every conversation that still exists, hidden ones included. */
  async threads(): Promise<Set<string>> {
    return new Set((await this.peers.conversations({})).map((c) => dmThread(c.a.sessionId, c.b.sessionId)));
  }

  /** Deletes the messages of conversations hidden longer than the grace period. */
  async purge(graceMs: number): Promise<number> {
    return this.peers.purgeHidden(this.core.host.now() - graceMs);
  }
}
