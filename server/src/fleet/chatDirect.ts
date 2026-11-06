// The direct-message side of Chat (#1034). A conversation is stored in `peer_messages` and is read only by its owner and an Admin. The person is a peer
// in it: they message one of their agents, or add to a conversation between two. A text goes to the agent as a message of the console (the existing
// delivery and the reporter's consent), and the same text is stored here with who wrote it. This file never reads or writes a channel: the audience of a
// table is the table, and `chatSeparation.test.ts` holds this file to it.
import { nameKey } from '../storage/rows.js';
import type { ConversationSummary, MessageRow, MessageState, OwnerConversation, Refusal } from './peerTypes.js';
import { ChatCore, type DeliveryOutcome } from './chatCore.js';
import { dmThread, fail, isPersonId, personId, type ChatViewer, type Fail } from './chatTypes.js';

const MERGE_MS = 2000;

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
  canSend: { aToB: boolean; bToA: boolean };
  roundTrips: { used: number; cap: number };
  /** The names of the agents that have left the live set while others have not. */
  ended: string[];
  unread: number;
  mentions: number;
  hiddenAt: number | null;
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
      const worst = last.to.reduce((a, b) => (rank(b.state) > rank(a.state) ? b : a));
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
      approved: m.approved,
    });
  }
  return out;
}

export class DirectChat {
  constructor(private readonly core: ChatCore) {}

  private get peers() {
    return this.core.host.peers.messages;
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
      canSend: { aToB: c.aToB, bToA: c.bToA },
      roundTrips: c.roundTrips,
      ended: gone.map((p) => p.name),
      unread: count.unread,
      mentions: count.mentions,
      hiddenAt: c.hiddenAt,
    };
  }

  /** The viewer's conversations, without hidden ones. Never any text. */
  async list(viewer: ChatViewer): Promise<DirectInfo[]> {
    if (viewer.personId === null) return [];
    const rs = await this.core.store.readState.list(viewer.name);
    const counts = new Map(rs.map((r) => [r.thread, { unread: r.unread, mentions: r.mentions }]));
    return (await this.peers.ownerConversations(viewer.name)).map((c) => this.info(c, counts));
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

  /** The viewer's own agent, live, for a conversation that has no message yet. */
  private newWith(viewer: ChatViewer, a: string, b: string): { sessionId: string } | null {
    if (viewer.personId === null) return null;
    const me = personId(viewer.name);
    const other = a === me ? b : b === me ? a : null;
    const o = other ? this.liveOf(other) : null;
    return o && nameKey(o.owner) === nameKey(viewer.name) ? { sessionId: o.sessionId } : null;
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
      return { ok: true as const, thread: dmThread(a, b), a: this.party(x), b: this.party(y), messages: [] as DirectMessageView[], older: null, total: 0, ended: [] as string[], owner: nameKey(viewer.name), paused: false, roundTrips: { used: 0, cap: 0 } };
    }
    if (!viewer.admin && nameKey(c.owner) !== nameKey(viewer.name)) return fail(403, 'Only its owner and an Admin can read a conversation.');
    let page;
    try {
      page = await this.peers.page(c.owner, a, b, opts);
    } catch (err) {
      return fail(400, (err as Error).message);
    }
    const info = this.info({ ...c, hiddenAt: null }, new Map());
    return { ok: true as const, thread: info.thread, a: info.a, b: info.b, messages: directMessages(page.messages), older: page.older, total: c.messages, ended: info.ended, owner: c.owner, paused: c.paused, roundTrips: c.roundTrips };
  }

  /** The person writes. See the file's head for the path; the text is redacted first, and nothing is stored for an agent that did not take it. */
  async send(viewer: ChatViewer, rawA: string, rawB: string, body: Record<string, unknown>) {
    if (viewer.personId === null) return fail(403, 'Only the person who owns a conversation can add to it.');
    const [a, b] = this.ids(viewer, rawA, rawB);
    const owner = nameKey(viewer.name);
    const c = await this.find(a, b);
    if (c && nameKey(c.owner) !== owner) return fail(403, 'Only its owner and an Admin can read a conversation, and only its owner can add to it.');
    if (!c && !this.newWith(viewer, a, b)) return fail(404, 'There is no such conversation.');
    if (typeof body.text !== 'string' || !body.text.trim()) return fail(400, 'The message is empty. Write the text to send.');
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
      const sent = this.core.deliver(sid, viewer.name, o.name, text);
      if (!sent.ok) {
        errors.push({ sessionId: sid, name: o.name, status: sent.status, error: sent.error });
        continue;
      }
      const other = agents.find((x) => x !== sid);
      const row = await this.peers.sendFromPerson({ owner: viewer.name, person: viewer.name, toSession: sid, ...(other ? { withSession: other } : {}), text });
      if ('ok' in row) {
        this.core.host.respond.discard(sent.delivery.id, viewer.name, true);
        errors.push({ sessionId: sid, name: o.name, status: (row as Refusal).status, error: (row as Refusal).error });
        continue;
      }
      // Stored as queued, so the peer path (which hands a ready message to an idle orchestrator) does not hand it a second time.
      await this.peers.result(sid, row.id, 'queued');
      this.core.watch(sent.delivery.id, (out) => this.followed(sid, row.id, out));
      this.core.onEvent({ kind: 'dm_sent', owner, by: viewer.actor, messageId: row.id, sessionId: sid });
      stored.push({ ...row, state: 'queued' });
    }
    if (!stored.length) {
      const first = errors[0]!;
      return fail(first.status, first.error);
    }
    this.core.signal({ scope: 'dm', owner });
    return { ok: true as const, message: directMessages(stored)[0]!, skipped, errors };
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

  /** Delete conversation: the messages and the row go; the link and its rights stay. */
  async remove(viewer: ChatViewer, rawA: string, rawB: string): Promise<{ ok: true; removed: number } | Fail> {
    if (viewer.personId === null) return fail(403, 'Only the person who owns a conversation can delete it.');
    const [a, b] = this.ids(viewer, rawA, rawB);
    const c = await this.find(a, b);
    if (!c) return fail(404, 'There is no such conversation.');
    if (nameKey(c.owner) !== nameKey(viewer.name)) return fail(403, 'Only its owner can delete a conversation.');
    const removed = await this.peers.deleteConversation(viewer.name, a, b);
    await this.core.store.readState.forget(dmThread(a, b));
    this.core.onEvent({ kind: 'dm_deleted', owner: nameKey(viewer.name), by: viewer.actor, a, b, count: removed });
    this.core.signal({ scope: 'dm', owner: nameKey(viewer.name) });
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

  /** Every owner's conversations, against the live set now: at start and hourly, for what changed while the server was down. */
  async reconcile(): Promise<void> {
    for (const owner of new Set((await this.peers.conversations({})).map((c) => c.owner))) await this.reconcileOwner(owner, null);
  }

  /** Deletes the messages of conversations hidden longer than the grace period. */
  async purge(graceMs: number): Promise<number> {
    return this.peers.purgeHidden(this.core.host.now() - graceMs);
  }
}
