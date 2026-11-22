// The direct-message side of Chat (#1034). A conversation is stored in `peer_messages` and is read only by its owner and an Admin. The person is a peer
// in it: they message one of their agents, or add to a conversation between two. A text goes to the agent as a message of the console (the existing
// delivery and the reporter's consent), and the same text is stored here with who wrote it. This file never reads or writes a channel: the audience of a
// table is the table, and `chatSeparation.test.ts` holds this file to it.
import { isSentToAgent, mergesAsOne } from '../storage/peerEdit.js';
import { nameKey } from '../storage/rows.js';
import { isPersonKey, type ConversationSummary, type PeerChange, type LinkPauser, type MessageRow, type MessageState, type MessageTrail, type OwnerConversation, type PersonLinkOp, type Refusal } from './peerTypes.js';
import { PEER_DROP_WORDS } from './protocol.js';
import { ChatCore, changeRefusal, changeState, endedNotice, sentWords, type ChangeWords, type DeliveryOutcome } from './chatCore.js';
import { readSubject, type AdminReads, type ReadSubject, type Told } from './chatAdminReads.js';
import { dmThread, fail, isPersonId, noConversation, noOwnMessages, personId, type AdminReading, type ChatViewer, type Fail } from './chatTypes.js';

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

/** One orchestrator in the New direct message picker (#1035). */
export interface DirectTarget {
  sessionId: string;
  name: string;
  machine: string;
  /** `name@machine`, which is also how an @ addresses it. */
  address: string;
  /** The person who owns the agent, as written. */
  owner: string;
  /** Whether the viewer owns it. */
  own: boolean;
  status: 'running' | 'waiting' | 'done';
  waitReason: 'permission' | 'input' | null;
  /** Whether a message can be handed over now; `why` says in words when it cannot. */
  canMessage: boolean;
  why: string | null;
  /** True for another person's agent unless its owner already opened a link: the first message waits in the owner's My reporters. */
  needsApproval: boolean;
  /** Where the link between the viewer and another person's agent stands; null for the viewer's own agent. */
  link: 'none' | 'open' | 'paused' | 'removed' | null;
  /** The thread of the conversation, which exists once a message was sent: `POST /chat/dm/me/<sessionId>/messages` starts or continues it. */
  thread: string;
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

interface DirectMessageView {
  id: string;
  author: 'agent' | 'person';
  /** `name` is display text. `personId` is the author's `people.id` for a person's message (what the console compares to the viewer's id to decide whose it is, #1284); null for an agent and for a message whose author has since been deleted. */
  from: { kind: 'agent' | 'person'; sessionId: string | null; personId: number | null; name: string; machine: string };
  /** Who it went to: one agent, or both when the person added to a conversation between two. */
  to: { sessionId: string; name: string; machine: string; state: MessageState; why: string | null }[];
  /** '' for a message its author deleted (#1269). */
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
  /** When the author last changed the text (#1269); null for a message never edited. */
  editedAt: number | null;
  /** When the author deleted it (#1269); null for a message that stands. */
  deletedAt: number | null;
  /** Whether the viewer, who must be the author (by id, never by name), may edit or delete it now (#1269). A message to two agents is one message: sent to either, it is locked. */
  canChange: boolean;
  /** In words, why the author cannot change it now: it has been sent to an agent. Null when they can, when it is deleted and when the viewer is not its author. */
  changeWhy: string | null;
}

const rank = (s: MessageState): number => (s === 'dropped' || s === 'declined' ? 3 : s === 'delivered' ? 0 : 1);

const lockedWords = (rows: MessageRow[]): string => {
  // The rows that were sent name the agents; when the caller knows only that the store said locked, every row it has names one.
  const sent = rows.filter((r) => isSentToAgent(r));
  return sentWords([...new Set((sent.length ? sent : rows).map((r) => r.toName))]);
};

/** What a Direct Message says when the store refuses to change a message. */
const DIRECT_WORDS: ChangeWords = { notFound: 'There is no such message in this conversation.', notYours: 'Only the person who wrote a message can change it.', deleted: 'This message has already been deleted.' };

/** Whether the viewer may change the message these rows are (the rows of one message), and when not, why. The author is the person's id; the lock is the store's predicate over every row. */
function changeOf(rows: MessageRow[], viewer: ChatViewer | null): { canChange: boolean; changeWhy: string | null } {
  const first = rows[0]!;
  const mine = first.deletedAt === null && viewer !== null && viewer.personId !== null && first.author === 'person' && first.authorId !== null && first.authorId === viewer.personId;
  return changeState(mine, rows.some((r) => isSentToAgent(r)), () => lockedWords(rows));
}

/** A conversation's rows as the thread shows them, each message with the rows it is made of: a person's text that went to both agents of a conversation is one message. */
function groupRows(rows: MessageRow[], viewer: ChatViewer | null): { view: DirectMessageView; rows: MessageRow[] }[] {
  const out: { view: DirectMessageView; rows: MessageRow[] }[] = [];
  for (const m of rows) {
    const target = { sessionId: m.toSession, name: m.toName, machine: m.toMachine, state: m.state, why: m.why };
    const last = out.at(-1);
    if (last && mergesAsOne(last.rows[0]!, m) && !last.view.to.some((t) => t.sessionId === m.toSession)) {
      last.rows.push(m);
      last.view.to.push(target);
      const worst = last.view.to.reduce((a, b) => (rank(b.state) > rank(a.state) ? b : a), last.view.to[0]!);
      last.view.state = worst.state;
      last.view.why = worst.why;
      last.view.stateAt = Math.max(last.view.stateAt, m.stateAt);
      continue;
    }
    out.push({
      rows: [m],
      view: {
        id: m.id,
        author: m.author,
        from: m.author === 'person' ? { kind: 'person', sessionId: null, personId: m.authorId, name: m.fromName, machine: '' } : { kind: 'agent', sessionId: m.fromSession, personId: null, name: m.fromName, machine: m.fromMachine },
        to: [target],
        text: m.text,
        sentAt: m.sentAt,
        state: m.state,
        stateAt: m.stateAt,
        why: m.why,
        reason: reasonOf(m),
        waitingFor: m.state === 'approval' ? m.owner : null,
        approved: m.approved,
        editedAt: m.editedAt,
        deletedAt: m.deletedAt,
        canChange: false,
        changeWhy: null,
      },
    });
  }
  for (const g of out) Object.assign(g.view, changeOf(g.rows, viewer));
  return out;
}

/** A conversation's messages as the page shows them. */
const directMessages = (rows: MessageRow[], viewer: ChatViewer | null): DirectMessageView[] => groupRows(rows, viewer).map((g) => g.view);

/** A declined or dropped message's reason in words, for the person who wrote it. */
function reasonOf(m: Pick<MessageRow, 'state' | 'why' | 'owner' | 'toName'>): string | null {
  if (m.state === 'declined') return `${m.owner} declined it.`;
  if (m.state !== 'dropped' || !m.why) return null;
  if (m.why === 'receiver-ended') return `${m.toName} ended before it got the message.`;
  if (m.why === 'link-removed') return `${m.owner} removed the link.`;
  if (m.why === 'deleted') return 'Deleted by its sender.';
  return `${PEER_DROP_WORDS[m.why] ?? m.why}.`.replace(/^./, (c) => c.toUpperCase());
}

export class DirectChat {
  constructor(
    private readonly core: ChatCore,
    private readonly reads: AdminReads,
  ) {
    // The channel side changes the copy of a message that waits for another person's approval through this (#1269).
    core.changeAcross = (viewer, copyId, op) => this.changeAcross(viewer, copyId, op);
  }

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
    if (!personEnd || !agentEnd || (c.ownerId !== null && personEnd.sessionId === personId(c.ownerId))) return null;
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
    // Ownership is the person's id, never the name (#1284): a newcomer who takes a deleted person's name owns none of their conversations.
    if (viewer.personId !== null && c.ownerId === viewer.personId) return 'owner';
    if (viewer.personId !== null && (c.a.sessionId === personId(viewer.personId) || c.b.sessionId === personId(viewer.personId))) return 'sender';
    return viewer.admin ? 'admin' : null;
  }

  /**
   * The live orchestrators a person can start a Direct Message with (#1035), for the New direct message picker: their own, then other people's whose reporter takes part
   * in messaging (`newWith` is what the first message goes through, so this lists exactly what it accepts). `q` narrows by name, owner or machine. Each says whether it can
   * take a message now and why not in words, and whether the first message waits for its owner's approval (another person's agent without an open link). Names and
   * states only, never any text. The admin secret has no person to write as, so it is offered none.
   */
  async targets(viewer: ChatViewer, q: string): Promise<DirectTarget[]> {
    if (viewer.personId === null) return [];
    const want = q.trim().toLowerCase();
    const out: DirectTarget[] = [];
    for (const id of this.core.host.liveIds()) {
      const o = this.liveOf(id);
      if (!o) continue;
      const own = viewer.personId !== null && o.ownerId === viewer.personId;
      if (!own && o.peers !== true) continue;
      if (want && !`${o.name} ${o.owner} ${o.machine}`.toLowerCase().includes(want)) continue;
      const row = own ? null : await this.peerStore.rights.personLink(personId(viewer.personId), o.reporterKey);
      const link: DirectTarget['link'] = own ? null : row === null ? 'none' : row.level === 'none' ? 'removed' : row.paused ? 'paused' : 'open';
      const refused = own ? this.ownRefusal(o.sessionId, o.name) : await this.acrossTarget(o.sessionId);
      out.push({
        sessionId: o.sessionId,
        name: o.name,
        machine: o.machine,
        address: `${o.name}@${o.machine}`,
        owner: o.owner,
        own,
        status: o.status,
        waitReason: o.waitReason,
        canMessage: refused === null && link !== 'removed',
        why: refused ? refused.error : link === 'removed' ? `${o.owner} removed the link to ${o.name}, so it takes no messages from you.` : null,
        needsApproval: !own && link !== 'open',
        link,
        thread: dmThread(personId(viewer.personId), o.sessionId),
      });
    }
    return out.sort((a, b) => Number(b.own) - Number(a.own) || a.owner.localeCompare(b.owner) || a.address.localeCompare(b.address));
  }

  /** Why a person's own agent cannot take a message from Podium now, in words; null when it can. The same checks the delivery makes. */
  private ownRefusal(sessionId: string, name: string): Fail | null {
    if (!this.core.host.respondFlagsOn()) return fail(403, 'Responding is off, so Podium cannot hand a message to an agent. An Admin turns it on in Admin > Settings.');
    if (!this.core.host.respond.info(sessionId)?.accepts.includes('message')) return fail(422, `${name}'s reporter does not take messages from Podium. Turn on its respond option on that machine.`);
    return null;
  }

  /** The viewer's conversations, without hidden ones. Never any text. */
  async list(viewer: ChatViewer): Promise<DirectInfo[]> {
    if (viewer.personId === null) return [];
    const rs = await this.core.store.readState.list(viewer.personId);
    const counts = new Map(rs.map((r) => [r.thread, { unread: r.unread, mentions: r.mentions }]));
    const mine = await this.peers.ownerConversations(viewer.personId);
    return Promise.all(mine.map(async (c) => ({ ...this.info(c, counts), cross: await this.crossOf(c, viewer) })));
  }

  /** An Admin browsing `owner`'s conversations (#1034): the same list as that person's, with no unread or mention counts, seen as the Admin. Never any text. */
  async listAbout(viewer: ChatViewer, owner: string): Promise<DirectInfo[]> {
    if (!viewer.admin) return [];
    const ownerId = await this.idOf(owner);
    if (ownerId === null) return [];
    const mine = await this.peers.ownerConversations(ownerId);
    return Promise.all(mine.map(async (c) => ({ ...this.info(c, new Map()), cross: await this.crossOf(c, viewer) })));
  }

  /**
   * The person's conversations that have left the list because every agent in them ended (#1051). The overview shows one only while an Admin is reading it, so
   * a person can see who is reading a conversation they cannot open. `asAdmin` is an Admin browsing the person. Never any text.
   *
   * The live readings are found first and only the hidden conversations they name are loaded (#1063): with no reading live, no conversation is read.
   */
  async hiddenOf(viewer: ChatViewer, owner: string, asAdmin: boolean): Promise<DirectInfo[]> {
    if (viewer.personId === null && !asAdmin) return [];
    // A Direct Message thread is `dm:<id>|<id>`, the pair `ownerConversations` groups by, so the store keeps only the conversations being read, and reads none when no reading is live.
    const pairs = (await this.reads.liveDmThreads()).map((t) => t.slice('dm:'.length));
    const ownerId = await this.idOf(owner);
    if (ownerId === null) return [];
    const found = (await this.peers.ownerConversations(ownerId, { includeHidden: true, pairs })).filter((c) => c.hiddenAt !== null);
    return Promise.all(found.map(async (c) => ({ ...this.info(c, new Map()), cross: await this.crossOf(c, viewer) })));
  }

  /** How many conversations each of the people takes part in, hidden ones left out, in one read for all of them (#1046). */
  async countsOf(owners: string[]): Promise<Record<string, number>> {
    const people = (await this.core.persons()).filter((p) => owners.includes(p.name));
    const byId = await this.peers.conversationCounts(people.map((p) => p.id));
    return Object.fromEntries(people.map((p) => [p.name, byId[p.id] ?? 0]));
  }

  /** The `people.id` of the person who signs in under this name now, or null: a name is only the way to find the person at the moment, and what is stored is bound to the id (#1284). */
  private async idOf(name: string): Promise<number | null> {
    return (await this.core.persons()).find((p) => p.key === nameKey(name))?.id ?? null;
  }

  /** `me` is the viewer's own place in a conversation with one agent. */
  private ids(viewer: ChatViewer, a: string, b: string): [string, string] {
    const me = viewer.personId === null ? null : personId(viewer.personId);
    return [a === 'me' && me ? me : a, b === 'me' && me ? me : b];
  }

  /** The stored conversation between two ids, from its summaries (no text). */
  private async find(a: string, b: string): Promise<ConversationSummary | null> {
    const [x, y] = a <= b ? [a, b] : [b, a];
    const c = await this.peers.conversationOf(x, y);
    return c && c.a.sessionId === x && c.b.sessionId === y ? c : null;
  }

  /** A live agent the viewer can start a conversation with (no message yet): their own, or another person's whose reporter takes part in messaging (#1034). */
  private newWith(viewer: ChatViewer, a: string, b: string): { sessionId: string; own: boolean } | null {
    if (viewer.personId === null) return null;
    const me = personId(viewer.personId);
    const other = a === me ? b : b === me ? a : null;
    const o = other ? this.liveOf(other) : null;
    if (!o) return null;
    if (o.ownerId === viewer.personId) return { sessionId: o.sessionId, own: true };
    return o.peers === true ? { sessionId: o.sessionId, own: false } : null;
  }

  async thread(viewer: ChatViewer, rawA: string, rawB: string, opts: { before?: string | null; limit: number }) {
    const [a, b] = this.ids(viewer, rawA, rawB);
    const c = await this.find(a, b);
    if (!c) {
      const fresh = this.newWith(viewer, a, b);
      if (!fresh) return noConversation();
      const o = this.liveOf(fresh.sessionId)!;
      const me = { sessionId: personId(viewer.personId!), name: viewer.name, machine: '', reporterKey: '' };
      const agent = { sessionId: o.sessionId, name: o.name, machine: o.machine, reporterKey: o.reporterKey };
      const [x, y] = me.sessionId <= agent.sessionId ? [me, agent] : [agent, me];
      const cross: CrossInfo | null = fresh.own ? null : { person: viewer.name, owner: o.owner, link: 'none', viewerIs: 'sender', pausedBy: null, pausedByAdmin: null, canResume: false };
      return { ok: true as const, thread: dmThread(a, b), a: this.party(x), b: this.party(y), messages: [] as DirectMessageView[], older: null, total: 0, ended: [] as string[], owner: nameKey(fresh.own ? viewer.name : o.owner), paused: false, pausedBy: null, pausedByAdmin: null, adminReads: [] as { admin: string; startedAt: number; lastSeenAt: number }[], roundTrips: { used: 0, cap: 0 }, cross };
    }
    const role = this.role(viewer, c);
    // Someone who is not in it hears what they hear of a conversation that is not there, so the answer does not say which ones exist (#1051).
    if (!role) return noConversation();
    // A conversation whose owner is no longer anyone (a person since deleted) belongs to nobody, so no one reads it (#1284).
    if (c.ownerId === null) return noConversation();
    let page;
    try {
      page = await this.peers.page(c.ownerId, a, b, opts);
    } catch (err) {
      return fail(400, (err as Error).message);
    }
    // An Admin's read is recorded before it is answered, so no conversation is read without a record, and its people are told. A refused read (above) records nothing.
    if (role === 'admin') await this.reads.note(viewer, await this.subject(c));
    const info = this.info({ ...c, hiddenAt: null }, new Map());
    const adminReads = await this.reads.list(info.thread);
    // The records go to the person's own console here, so what is owed to them is seen (#1051).
    if (role !== 'admin' && viewer.personId !== null) await this.reads.seen(info.thread, viewer.personId);
    return { ok: true as const, thread: info.thread, a: info.a, b: info.b, messages: directMessages(page.messages, viewer), older: page.older, total: c.messages, ended: info.ended, owner: c.owner, paused: info.paused, pausedBy: info.pausedBy, pausedByAdmin: info.pausedByAdmin, adminReads, roundTrips: c.roundTrips, cross: await this.crossOf(c, viewer) };
  }

  /** Who is told when an Admin reads this conversation: its owner, and the person who wrote when it is across owners, in every live reporter session of each. */
  private async subject(c: ConversationSummary): Promise<ReadSubject> {
    const person = [c.a, c.b].find((p) => isPersonId(p.sessionId));
    return readSubject('dm', dmThread(c.a.sessionId, c.b.sessionId), `is reading your Podium conversation between ${c.a.name} and ${c.b.name}`, { names: [c.owner, ...(person ? [person.name] : [])], ids: this.peopleIdsOf(c) });
  }

  /**
   * The people of a conversation by `people.id` (#1284), who are told and owed the record: the owner by the id the conversation kept, and the person who wrote by the id in their end of the link
   * (`person:<id>`). An end that is no person (`person:gone:<name>`, a deleted person) is no one, never a newcomer who has since taken the name.
   */
  private peopleIdsOf(c: Pick<ConversationSummary, 'a' | 'b' | 'ownerId'>): number[] {
    const ids = new Set<number>();
    if (c.ownerId !== null) ids.add(c.ownerId);
    for (const p of [c.a, c.b]) {
      const id = isPersonId(p.sessionId) ? Number(p.sessionId.slice('person:'.length)) : Number.NaN;
      if (Number.isInteger(id)) ids.add(id);
    }
    return [...ids];
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
    if (this.role(viewer, c) === 'admin') await this.reads.note(viewer, await this.subject(c));
    return true;
  }

  /** What the callout of a thread says, from its conversation: for the reporter sessions of its people. Null when there is no such conversation. */
  async subjectOf(thread: string): Promise<ReadSubject | null> {
    const ids = thread.startsWith('dm:') ? thread.slice('dm:'.length).split('|') : [];
    const [x, y] = ids;
    const c = ids.length === 2 && x !== undefined && y !== undefined && dmThread(x, y) === thread ? await this.find(x, y) : null;
    return c ? this.subject(c) : null;
  }

  /**
   * The sessions of a conversation's people that are live, each told in words that name the conversation. Every live session of the owner and of the person
   * who wrote is told, not only the agents in it (#1051).
   */
  private told(people: number[], about: string): Told[] {
    return people.flatMap((p) => this.reads.sessionsOf(p).map((sessionId) => ({ sessionId, about })));
  }

  /** An Admin is about to pause or resume a link: it stays on the conversation's record, and each of its people's sessions is told which link it was. */
  private async stoppedLink(viewer: ChatViewer, c: ConversationSummary, op: 'pause' | 'resume'): Promise<void> {
    const link = `the link between ${c.a.name} and ${c.b.name}`;
    const people = this.peopleIdsOf(c);
    await this.reads.stopped(viewer, dmThread(c.a.sessionId, c.b.sessionId), op === 'pause' ? 'paused' : 'resumed', this.told(people, link), people);
  }

  /** An Admin's open conversation says it is still being read, so its people keep seeing it. Content-free. */
  async reading(viewer: ChatViewer, rawA: string, rawB: string): Promise<{ ok: true } | Fail> {
    if (!viewer.admin) return fail(403, 'Only an Admin reads a conversation that is not their own.');
    const [a, b] = this.ids(viewer, rawA, rawB);
    const c = await this.find(a, b);
    if (!c) return noConversation();
    if (this.role(viewer, c) !== 'admin') return fail(403, 'That conversation is yours, so reading it is not recorded.');
    await this.reads.note(viewer, await this.subject(c), true);
    return { ok: true };
  }

  /** The person writes. See the file's head for the path; the text is redacted first, and nothing is stored for an agent that did not take it. */
  async send(viewer: ChatViewer, rawA: string, rawB: string, body: Record<string, unknown>) {
    if (viewer.personId === null) return fail(403, 'Only the person who owns a conversation can add to it.');
    const [a, b] = this.ids(viewer, rawA, rawB);
    const owner = nameKey(viewer.name);
    const c = await this.find(a, b);
    const role = c ? this.role(viewer, c) : null;
    const me = personId(viewer.personId);
    // Another person's agent (#1034): the person asks its owner. The agent's owner writes to it from their own conversation with it.
    if (c && role === 'owner' && [c.a.sessionId, c.b.sessionId].some((id) => isPersonId(id) && id !== me)) return fail(409, 'This conversation is with another person. Write to your agent from your own conversation with it.');
    if (c && role === 'sender') return this.sendAcrossDm(viewer, [a, b].find((id) => !isPersonId(id))!, body);
    if (c && !role) return noConversation();
    if (c && role !== 'owner') return fail(403, 'Only the people in a conversation can add to it, and an Admin can read it.');
    const fresh = c ? null : this.newWith(viewer, a, b);
    if (!c && !fresh) {
      // A conversation with an agent that ended is concluded and gone (#1283), so a new message to it is told why, not that nothing is there. A session that is still live
      // but not open to this person is not that, and keeps the answer of a conversation that does not exist.
      const other = a === me ? b : b === me ? a : null;
      const known = other !== null && !isPersonId(other) && !this.liveOf(other) ? await this.core.host.sessionOf(other) : null;
      // Only the person's own agent is named: another person's stored session is not theirs to learn exists, or what it is called.
      if (known !== null && viewer.personId !== null && known.ownerId === viewer.personId) return fail(409, `${known.name} has ended, so Podium did not queue the message. It would never be taken.`);
      return noConversation();
    }
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
      if (o.ownerId === null || o.ownerId !== viewer.personId) return noConversation();
      const other = agents.find((x) => x !== sid);
      // The person's own conversation with this one agent: it may answer in the thread. A word added to a conversation between two agents has no such thread to answer in.
      const sent = this.core.deliver(sid, viewer.name, o.name, text, 'chat', !other, null, viewer.personId);
      if (!sent.ok) {
        errors.push({ sessionId: sid, name: o.name, status: sent.status, error: sent.error });
        continue;
      }
      const row = await this.peers.sendFromPerson({ ownerId: viewer.personId, person: viewer.name, toSession: sid, ...(other ? { withSession: other } : {}), text, state: 'queued', authorId: viewer.personId });
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
    this.core.signal('dm');
    return { ok: true as const, message: directMessages(stored, viewer)[0]!, skipped, errors };
  }

  // ---- A person changes their own message (#1269) -------------------------------------------------------------------------

  /** The conversation and the stored message a change is about, when the viewer is a person in that conversation and the message is one of its own; otherwise the refusal. */
  private async changeScope(viewer: ChatViewer, rawA: string, rawB: string, id: string): Promise<{ c: ConversationSummary; a: string; b: string; row: MessageRow } | Fail> {
    if (viewer.personId === null) return noOwnMessages();
    const [a, b] = this.ids(viewer, rawA, rawB);
    const c = await this.find(a, b);
    const role = c ? this.role(viewer, c) : null;
    if (!c || !role) return noConversation();
    // An Admin reads a conversation and stops it; a message is changed by its author, from their own part of it.
    if (role === 'admin') return fail(403, 'An Admin can read a conversation but cannot change its messages.');
    const row = id.length <= 64 ? await this.peers.message(id) : null;
    // A message of another conversation is not found here, so the id says nothing of where it is.
    if (!row || row.ownerId === null || row.ownerId !== c.ownerId || dmThread(row.fromSession, row.toSession) !== dmThread(c.a.sessionId, c.b.sessionId)) return fail(404, 'There is no such message in this conversation.');
    return { c, a, b, row };
  }

  /** The rows of the message `id` as the thread now shows it (a message to two agents is more than one), or null when the page does not hold it. */
  private async rowsOf(c: ConversationSummary, a: string, b: string, id: string): Promise<MessageRow[] | null> {
    try {
      if (c.ownerId === null) return null;
      const page = await this.peers.page(c.ownerId, a, b, { limit: 100 });
      return groupRows(page.messages, null).find((g) => g.rows.some((r) => r.id === id))?.rows ?? null;
    } catch {
      return null;
    }
  }

  private async refused(out: Extract<PeerChange, { ok: false }>, scope: { c: ConversationSummary; a: string; b: string; row: MessageRow }): Promise<Fail> {
    // Over the length limit of the agent's owner: the send's own words and status.
    if (out.reason === 'too-long') return fail(out.status, out.error);
    return changeRefusal(out.reason, DIRECT_WORDS, async () => lockedWords((await this.rowsOf(scope.c, scope.a, scope.b, scope.row.id)) ?? [scope.row]));
  }

  /** Tells the consoles of both people that a message changed, and the owner's count of what waits for them (a delete closes a request), and the Admin log: ids and where, never the text. */
  private changed(kind: 'message_edited' | 'message_deleted', viewer: ChatViewer, c: ConversationSummary, id: string): void {
    this.core.onEvent({ kind, scope: 'dm', channel: null, owner: nameKey(c.owner), by: viewer.actor, messageId: id });
    const person = [c.a, c.b].find((p) => isPersonId(p.sessionId));
    if (person && (c.ownerId === null || person.sessionId !== personId(c.ownerId))) this.tell(person.name, c.owner);
    else this.core.signal('dm');
  }

  /** The message as a read returns it, now that it changed: every row it is made of, so a message to two agents answers with both. */
  private async viewAfter(viewer: ChatViewer, scope: { c: ConversationSummary; a: string; b: string }, row: MessageRow): Promise<DirectMessageView> {
    return directMessages((await this.rowsOf(scope.c, scope.a, scope.b, row.id)) ?? [row], viewer)[0]!;
  }

  /** The author edits their own message: the new text is checked and redacted as a new one is, and nothing is delivered. */
  editMessage(viewer: ChatViewer, rawA: string, rawB: string, id: string, body: Record<string, unknown>): Promise<{ ok: true; message: DirectMessageView } | Fail> {
    return this.change(viewer, rawA, rawB, id, body);
  }

  /** The author deletes their own message: a tombstone stays for both people, and a request that waited for its owner is closed. */
  deleteMessage(viewer: ChatViewer, rawA: string, rawB: string, id: string): Promise<{ ok: true; message: DirectMessageView } | Fail> {
    return this.change(viewer, rawA, rawB, id, null);
  }

  /** An edit (`edit` is the request's body) or a delete (null) of the author's own message. The store decides who may and whether it is locked. */
  private async change(viewer: ChatViewer, rawA: string, rawB: string, id: string, edit: Record<string, unknown> | null): Promise<{ ok: true; message: DirectMessageView } | Fail> {
    const scope = await this.changeScope(viewer, rawA, rawB, id);
    if ('status' in scope) return scope;
    const by = () => ({ author: viewer.personId as number, now: this.core.host.now() });
    let out;
    if (edit) {
      if (typeof edit.text !== 'string' || !edit.text.trim()) return fail(400, 'The message is empty. Write the text to send.');
      // The same order as a new message: length, then the person's limit, then the scan for secrets.
      const early = await this.early(viewer, edit.text, true);
      if (early) return early;
      const text = this.core.redact(edit.text);
      // A send refuses what is empty once cleaned; so does an edit, or it would leave a message with no text that is not a tombstone.
      if (!text.trim()) return fail(400, 'The message is empty. Write the text to send.');
      out = await this.peers.editMessage(id, { ...by(), text });
    } else out = await this.peers.deleteMessage(id, by());
    if (!out.ok) return this.refused(out, scope);
    this.changed(edit ? 'message_edited' : 'message_deleted', viewer, scope.c, id);
    return { ok: true, message: await this.viewAfter(viewer, scope, out.message) };
  }

  /**
   * The channel side changes the copy of one of its messages that waits for another person's approval (#1269): `copyId` is the direct message the person's `@` made. It is
   * the person's own message, so the store's checks apply as to any edit: its author by id, not a tombstone, not yet sent to the agent (`locked`, in the words of any locked
   * message), and an edit also within the length limit of the agent's owner, in the send's words. A delete drops the copy and closes the owner's request. Nobody is told in
   * words here: the author did it, and the channel side logs the change of the message it belongs to.
   */
  async changeAcross(viewer: ChatViewer, copyId: string, op: { kind: 'edit'; text: string } | { kind: 'delete' }): Promise<{ ok: true } | Fail> {
    if (viewer.personId === null) return noOwnMessages();
    const row = await this.peers.message(copyId);
    if (!row) return fail(404, 'There is no such message.');
    const now = this.core.host.now();
    const out = op.kind === 'edit' ? await this.peers.editMessage(copyId, { author: viewer.personId, text: op.text, now }) : await this.peers.deleteMessage(copyId, { author: viewer.personId, now });
    if (!out.ok) {
      if (out.reason === 'too-long') return fail(out.status, out.error);
      return changeRefusal(out.reason, { ...DIRECT_WORDS, notFound: 'There is no such message.' }, async () => lockedWords([(await this.peers.message(copyId)) ?? row]));
    }
    // The store changed the message only for its author, so the person is the viewer.
    this.tell(viewer.name, row.owner);
    return { ok: true };
  }

  // ---- A person writes to another person's agent (#1034) ------------------------------------------------------------

  /** Messages from other people that wait for the owner's approval: the count the overview shows its owner. */
  async approvalsFor(ownerId: number | null): Promise<number> {
    return (await this.peerStore.rights.openRequests(ownerId)).filter((r) => r.kind === 'message' && isPersonKey(r.fromKey)).length;
  }

  /** Tells the person's consoles, and the owner's when it is another person. Never any text. */
  private tell(person: string, owner: string): void {
    this.core.signal('dm', nameKey(owner) === nameKey(person) ? 1 : 2);
  }

  /** The text of a person's message to another person's agent: stored and held for the agent's owner, or sent at once over a link the owner opened. */
  private async acrossRow(viewer: ChatViewer, sessionId: string, text: string, rate: boolean, redact = false): Promise<{ ok: true; row: MessageRow } | Fail> {
    if (viewer.personId === null) return fail(403, "Only a signed-in person can write to another person's agent.");
    const early = await this.early(viewer, text, rate);
    if (early) return early;
    const refused = await this.acrossTarget(sessionId);
    if (refused) return refused;
    // The text comes in raw from a direct message (checked above first) and already redacted from a channel post.
    const row = await this.peers.sendAcross({ person: viewer.name, personId: viewer.personId, toSession: sessionId, text: redact ? this.core.redact(text) : text, authorId: viewer.personId });
    if ('ok' in row) return fail(row.status, row.error);
    this.core.onEvent({ kind: 'across', owner: nameKey(row.owner), person: nameKey(viewer.name), by: viewer.actor, messageId: row.id, sessionId, approval: row.state === 'approval' });
    this.tell(viewer.name, row.owner);
    return { ok: true, row };
  }

  /**
   * What is checked of a person's text before anything reads it (#1051): its length against Chat's limit, then, for a message written in a conversation, the
   * person's per-minute limit. The scan for secrets runs after both, so a text that is refused costs nothing to refuse.
   */
  private async early(viewer: ChatViewer, text: string, rate: boolean): Promise<Fail | null> {
    const limits = await this.core.limits();
    return this.core.tooLong(text.length, limits) ?? (rate ? this.core.tooFast(`person:${nameKey(viewer.name)}`, limits) : null);
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
  async across(viewer: ChatViewer, sessionId: string, text: string, opts: { rate: boolean }): Promise<{ ok: true; state: 'approval' | 'ready'; owner: string; messageId: string } | Fail> {
    const out = await this.acrossRow(viewer, sessionId, text, opts.rate);
    if ('status' in out) return out;
    return { ok: true, state: out.row.state === 'approval' ? 'approval' : 'ready', owner: out.row.owner, messageId: out.row.id };
  }

  private async sendAcrossDm(viewer: ChatViewer, agentId: string, body: Record<string, unknown>) {
    if (typeof body.text !== 'string' || !body.text.trim()) return fail(400, 'The message is empty. Write the text to send.');
    if (Array.isArray(body.to) && body.to.some((x) => x !== agentId)) return fail(400, 'to must name an agent of this conversation.');
    const out = await this.acrossRow(viewer, agentId, body.text, true, true);
    if ('status' in out) return out;
    return { ok: true as const, message: directMessages([out.row], viewer)[0]!, skipped: [] as { sessionId: string; name: string; why: string }[], errors: [] as { sessionId: string; name: string; status: number; error: string }[] };
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
    if (!c) return noConversation();
    const role = this.role(viewer, c);
    if (!role) return noConversation();
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
    this.tell(personEnd.name, c.owner);
    return { ok: true, link: (await this.crossOf(c, viewer))?.link ?? 'none' };
  }

  /** An Admin pauses or resumes the link between two of a person's own reporters, by the pause the owner has on My reporters, tagged as the Admin's. */
  private async adminLink(viewer: ChatViewer, c: ConversationSummary, op: PersonLinkOp): Promise<{ ok: true; link: CrossInfo['link'] } | Fail> {
    if (isPersonId(c.a.sessionId) || isPersonId(c.b.sessionId)) return fail(404, 'That conversation has no link to pause.');
    await this.stoppedLink(viewer, c, op === 'pause' ? 'pause' : 'resume');
    const out = await this.peerStore.rights.pauseLink(null, c.a.reporterKey, c.b.reporterKey, op === 'pause', { name: viewer.actor, admin: true });
    if (!out.ok) return fail(out.status, out.error);
    this.core.signal('dm');
    return { ok: true, link: op === 'pause' ? 'paused' : 'open' };
  }

  /**
   * A new message in a conversation is one more unread for each person who can read it and did not write it, and a mention for the one it is addressed to
   * (the owner of the agent a person wrote to). A person's message to their own agent counts for no one: they wrote it.
   */
  private async count(m: MessageRow): Promise<void> {
    const ownerKey = m.ownerId === null ? null : personId(m.ownerId);
    if (m.author === 'person' && isPersonId(m.fromSession) && m.fromSession === ownerKey) return;
    const thread = dmThread(m.fromSession, m.toSession);
    // An agent's answer to the person who wrote to it (#1034): one more unread for the person, and a mention, since it is addressed to them. When that person
    // is the agent's own owner there is one reader, so one count, and it is the mention.
    const toPerson = m.author === 'agent' && isPersonId(m.toSession) ? m.toSession : null;
    // Counts are kept under the person's id (#1284). A conversation whose owner is no person counts for no one.
    if (m.ownerId !== null && (toPerson === null || toPerson !== ownerKey)) await this.core.count({ id: m.ownerId, name: m.owner }, thread, 'dm', m.author === 'person');
    // The person's name as the agent's answer shows it (`toName`) is display only; `person:gone:<name>` is no person and counts for no one.
    const toId = toPerson === null ? Number.NaN : Number(toPerson.slice('person:'.length));
    if (Number.isInteger(toId)) await this.core.count({ id: toId, name: m.toName }, thread, 'dm', true);
  }

  /** What the owner's answer, a drop or a delivery did to a person's message to another person's agent: the channel side moves the mention the person wrote. */
  peerTrail(t: MessageTrail): void {
    const m = t.message;
    // An agent's answer to a person is stored delivered, and counts like a new message (#1034).
    if (t.kind === 'sent' || (t.kind === 'delivered' && m.author === 'agent' && isPersonId(m.toSession))) void this.count(m).catch((err: unknown) => this.core.host.warn('a direct message in Chat could not be counted', err));
    if (m.author !== 'person' || !isPersonId(m.fromSession) || (m.ownerId !== null && m.fromSession === personId(m.ownerId))) return;
    // The person who wrote it is found by the id the message kept (#1284); a message whose writer is not known (stored before ids, and matched no one) moves no mention.
    const writerId = m.authorId ?? null;
    const update = (from: ('approval' | 'waiting')[], state: 'waiting' | 'working' | 'dropped', why: string | null) => {
      if (writerId !== null) this.core.tellAcross({ personId: writerId, sessionId: m.toSession, from, state, why });
    };
    if (t.kind === 'approved') update(['approval'], 'waiting', null);
    else if (t.kind === 'declined') update(['approval'], 'dropped', `${m.owner} declined it`);
    else if (t.kind === 'delivered') update(['waiting', 'approval'], 'working', null);
    else if (t.kind === 'dropped') update(['approval', 'waiting'], 'dropped', reasonOf({ state: 'dropped', why: t.why, owner: m.owner, toName: m.toName })?.replace(/\.$/, '') ?? null);
    else return;
    this.tell(m.fromName, m.owner);
  }

  /** What the agent did with a text: taken is Delivered, refused is Dropped. An agent that ended drops its queued messages itself. */
  private followed(sessionId: string, id: string, out: DeliveryOutcome): void {
    const result = out.kind === 'took' ? 'took' : out.kind === 'not-delivered' ? 'refused' : null;
    if (!result) return;
    void this.peers
      .result(sessionId, id, result)
      .then(() => this.core.signal('dm'))
      .catch((err: unknown) => this.core.host.warn('a direct message in Chat could not be updated', err));
  }

  /** Delete conversation: the messages and the row go; the link and its rights stay. Either person of a conversation across owners may. */
  async remove(viewer: ChatViewer, rawA: string, rawB: string): Promise<{ ok: true; removed: number } | Fail> {
    if (viewer.personId === null) return fail(403, 'Only the people in a conversation can delete it.');
    const [a, b] = this.ids(viewer, rawA, rawB);
    const c = await this.find(a, b);
    if (!c) return noConversation();
    const role = this.role(viewer, c);
    if (!role) return noConversation();
    if (role !== 'owner' && role !== 'sender') return fail(403, 'Only the people in a conversation can delete it.');
    if (c.ownerId === null) return noConversation();
    const removed = await this.peers.deleteConversation(c.ownerId, a, b);
    await this.reads.drop(dmThread(a, b));
    this.core.onEvent({ kind: 'dm_deleted', owner: nameKey(c.owner), by: viewer.actor, a, b, count: removed });
    this.core.signal('dm');
    const person = [c.a, c.b].find((p) => isPersonId(p.sessionId));
    if (person && role === 'sender') this.core.signal('dm');
    else if (person && (c.ownerId === null || person.sessionId !== personId(c.ownerId))) this.core.signal('dm');
    return { ok: true, removed };
  }

  /** Whether the viewer may count a thread: it is one of their conversations. */
  async owns(viewer: ChatViewer, thread: string): Promise<boolean> {
    if (viewer.personId === null) return false;
    return (await this.peers.ownerConversations(viewer.personId, { includeHidden: true })).some((c) => dmThread(c.a.sessionId, c.b.sessionId) === thread);
  }

  // ---- A conversation leaves the list, and comes back ---------------------------------------------------------------

  /** Hides what has no live agent left, and shows what has one again, among the owner's conversations that include `sessionId` (or all of them). */
  private async reconcileOwner(owner: string, ownerId: number, only: string | null): Promise<void> {
    let changed = false;
    for (const c of await this.peers.ownerConversations(ownerId, { includeHidden: true })) {
      if (only !== null && c.a.sessionId !== only && c.b.sessionId !== only) continue;
      const anyLive = this.agentsOf(c).some((id) => this.core.host.isLive(id));
      if (!anyLive && c.hiddenAt === null) changed = (await this.peers.hideConversation(ownerId, c.a.sessionId, c.b.sessionId)) > 0 || changed;
      else if (anyLive && c.hiddenAt !== null) changed = (await this.peers.showConversation(ownerId, c.a.sessionId, c.b.sessionId)) > 0 || changed;
    }
    if (changed) this.core.signal('dm');
  }

  async sessionChanged(sessionId: string, owner: string): Promise<void> {
    const ownerId = await this.idOf(owner);
    if (ownerId !== null) await this.reconcileOwner(owner, ownerId, sessionId);
    this.core.signal('dm');
  }

  /**
   * An agent ended for good (#1283): every Direct Message it is in is concluded. The conversation and its text are deleted, as a person's Delete conversation does,
   * the agent that remains (if one is live) is told in Podium's own voice once, and the consoles are told the list changed. Concluding twice finds nothing the second
   * time and does nothing. A conversation between people alone has no agent, so it is never found here. A session that only lost its heartbeat does not come
   * here: it may report again, and its conversation is hidden instead (`reconcileOwner`).
   */
  async conclude(sessionId: string): Promise<void> {
    const told = new Set<string>();
    const found = (await this.peers.conversations({})).filter((c) => c.a.sessionId === sessionId || c.b.sessionId === sessionId);
    for (const c of found) {
      if (c.ownerId === null) continue;
      const [gone, other] = c.a.sessionId === sessionId ? [c.a, c.b] : [c.b, c.a];
      const thread = dmThread(c.a.sessionId, c.b.sessionId);
      // A person's message the agent never took, one still waiting for its owner's approval among them, goes with the conversation; the person is told how many.
      const undelivered = (await this.peers.conversation(c.a.sessionId, c.b.sessionId)).filter((m) => m.author === 'person' && m.state === 'dropped').length;
      const removed = await this.peers.deleteConversation(c.ownerId, c.a.sessionId, c.b.sessionId);
      if (removed === 0) continue;
      await this.reads.drop(thread);
      if (!isPersonId(other.sessionId) && !told.has(other.sessionId) && this.core.host.isLive(other.sessionId)) {
        told.add(other.sessionId);
        await this.peers.notice(other.sessionId, endedNotice(gone.name));
      }
      await this.remember(c, gone, other, thread, undelivered);
      this.core.onEvent({ kind: 'dm_concluded', owner: nameKey(c.owner), a: c.a.sessionId, b: c.b.sessionId, count: removed });
      this.core.signal('dm');
      const person = [c.a, c.b].find((p) => isPersonId(p.sessionId));
      if (person && (c.ownerId === null || person.sessionId !== personId(c.ownerId))) this.core.signal('dm');
    }
  }

  /** Records a conclusion for the people in it: the conversation's owner, a person in the pair, and the owner of the agent that remains. */
  private async remember(c: OwnerConversation | ConversationSummary, gone: { name: string }, other: { sessionId: string; name: string }, thread: string, undelivered: number): Promise<void> {
    const people = new Set(this.peopleIdsOf(c));
    if (!isPersonId(other.sessionId)) {
      const owner = (await this.core.host.sessionOf(other.sessionId))?.ownerId ?? null;
      if (owner !== null) people.add(owner);
    }
    this.core.concluded.add(people, { thread, agent: gone.name, with: [other.name], ...(undelivered > 0 ? { undelivered } : {}) });
    this.core.signal('dm');
  }

  /** A session reported: its hidden conversations come back. `reconcileOwner` signals the consoles only when one did. */
  async sessionSeen(sessionId: string, owner: string): Promise<void> {
    const ownerId = await this.idOf(owner);
    if (ownerId !== null) await this.reconcileOwner(owner, ownerId, sessionId);
  }

  /** Every owner's conversations, against the live set now: at start and hourly, for what changed while the server was down. */
  async reconcile(): Promise<void> {
    const owners = new Map<number, string>();
    for (const c of await this.peers.conversations({})) if (c.ownerId !== null) owners.set(c.ownerId, c.owner);
    for (const [ownerId, owner] of owners) await this.reconcileOwner(owner, ownerId, null);
  }

  /** The threads of every conversation that still exists, hidden ones included. */
  async threads(): Promise<Set<string>> {
    return new Set((await this.peers.conversations({})).map((c) => dmThread(c.a.sessionId, c.b.sessionId)));
  }

  /** Deletes the messages of conversations hidden longer than their agents' resume window, or the grace period when no window is known (#1113). */
  async purge(graceMs: number): Promise<number> {
    return this.peers.purgeHidden(this.core.host.now(), graceMs);
  }
}
