// Chat's conversations of people and agents (#1278, DECISIONS 74): a Direct Message of two or more members, each a person or one of the viewer's own live agents. The fourth
// audience, kept in its own tables (`conversation_*`) and read only here: nothing in this file reads a channel's message or a `peer_messages` row.
//
// Who may read: a member (a person), and no one else. An Admin who is not a member reads a conversation only while an agent is a member of it, so the Admin can stop a runaway;
// that read is recorded before it is answered and every person in it is told (the shared `AdminReads`). A conversation of people alone answers an Admin with `404`, as it
// answers any stranger, so nothing says whether it exists, who is in it or how many messages it has.
import { nameKey } from '../storage/rows.js';
import type { Conversation, ConversationMember, ConversationMemberInput, ConversationMessage, ConversationTargetInput } from '../storage/types.js';
import { readSubject, type AdminReads, type ReadSubject } from './chatAdminReads.js';
import { resolveTargets, type TargetMember } from './chatConversationTargets.js';
import { changeRefusal, changeState, endedNotice, type ChangeWords, type ChatCore, type ChatLimits, type DeliveryOutcome } from './chatCore.js';
import type { LiveOrchestrator } from './peerTypes.js';
import { fail, noConversation, type AdminReading, type ChatViewer, type Fail } from './chatTypes.js';

/** The thread a conversation's counts and Admin records are kept under. */
const conversationThread = (id: string): string => `convo:${id}`;
/** The conversation a thread names, or null when it is not a conversation's. */
export const conversationOfThread = (thread: string): string | null => (thread.startsWith('convo:') ? thread.slice('convo:'.length) : null);

const TEXT_MAX_GUARD = 100_000;
/** What a conversation says when the store refuses to change a message, and of one an agent has been handed: it names no agent, since the message may have gone to several. */
const CONVERSATION_WORDS: ChangeWords = { notFound: 'There is no such message.', notYours: 'You can change only your own messages.', deleted: 'That message was already deleted.' };
const HANDED_WORDS = 'Podium has already sent this to an agent, so it can no longer be changed.';
/** How long after a person's message an agent may answer it in the conversation (#1299): the window a channel gives an agent called into it. */
const AGENT_ANSWER_WINDOW_MS = 60 * 60 * 1000;
/** How many pages of the conversation one answer may read back through to find the message it answers: 10 of 100 is 1,000 messages. */
const AGENT_ANSWER_PAGES = 10;

/** One member as a person sees it. `you` is the viewer's own place. */
export interface MemberView {
  kind: 'person' | 'agent';
  name: string;
  you: boolean;
  /** The person who added them, by name when they are known; null for the person who opened it. */
  addedBy: string | null;
  /** An agent that ended for good (#1283): it can no longer send or be sent to. Absent for a person and for an agent that has not. */
  ended?: boolean;
  /** What an @ in this conversation types to address them (#1282): `name@console` for a person, `name@machine` for an agent that is running, null for one that has ended. */
  address: string | null;
  /** An agent's session id, for its state in the @ list; null for a person. */
  sessionId: string | null;
}

const NONE: ReadonlySet<string> = new Set();

/** One conversation in the overview. Names, counts and times only, never any text. */
export interface ConversationInfo {
  id: string;
  thread: string;
  members: MemberView[];
  /** Whether an agent is a member now. An Admin may read it only then, and everyone in it is told when one does. */
  hasAgent: boolean;
  unread: number;
  mentions: number;
  messages: number;
  lastAt: number;
  adminReading: AdminReading[];
}

/** One message of a conversation as the page shows it. */
export interface ConversationMessageView {
  id: string;
  author: { kind: 'person' | 'agent'; name: string; you: boolean };
  text: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  replyTo: string | null;
  canChange: boolean;
  changeWhy: string | null;
  /**
   * Who it went to or named (#1282). Empty for a message with no agent in the conversation and for one written before this was kept. When any `named` is true the writer addressed those members
   * with an @ and the message was for them alone; otherwise it was for everyone and these are the agents that took it. A person has no `state`: they are told by the unread count.
   */
  deliveries: { kind: 'person' | 'agent'; name: string; named: boolean; state: 'queued' | 'delivered' | 'dropped' | null }[];
}

/** What a viewer may ask for as a member of a conversation. */
type Role = 'member' | 'admin';

const MAX_LIMIT = 100;

export class ConversationChat {
  constructor(
    private readonly core: ChatCore,
    private readonly reads: AdminReads,
  ) {}

  private get store() {
    return this.core.store.conversations;
  }

  private memberOf(viewer: ChatViewer, c: Conversation): ConversationMember | null {
    if (viewer.personId === null) return null;
    return c.members.find((m) => m.leftAt === null && m.kind === 'person' && m.ref === String(viewer.personId)) ?? null;
  }

  private hasAgent(c: Conversation): boolean {
    return c.members.some((m) => m.leftAt === null && m.kind === 'agent');
  }

  /** The viewer's place in it: a member, or an Admin who may read it because an agent is in it. Null for anyone else, a stranger and an Admin of a conversation of people alone. */
  private roleOf(viewer: ChatViewer, c: Conversation): Role | null {
    if (this.memberOf(viewer, c)) return 'member';
    if (viewer.admin && this.hasAgent(c)) return 'admin';
    return null;
  }

  /** The people in it by `people.id` (a person member's `ref`, #1284): who is told and owed the record, whatever they are called now. */
  private personIdsOf(c: Conversation): number[] {
    return [...new Set(c.members.filter((m) => m.leftAt === null && m.kind === 'person').map((m) => Number(m.ref)))];
  }

  /** Who is told when an Admin reads it: every person in it, in every live reporter session. */
  private subject(c: Conversation): ReadSubject {
    const here = c.members.filter((m) => m.leftAt === null);
    return readSubject('dm', conversationThread(c.id), `is reading your Podium conversation with ${here.map((m) => m.name).join(', ')}`, { names: here.filter((m) => m.kind === 'person').map((m) => m.name), ids: this.personIdsOf(c) });
  }

  /** The thread's subject for the Admin records, from its conversation. Null when there is none, or none an Admin may read. */
  async subjectOf(thread: string): Promise<ReadSubject | null> {
    const id = conversationOfThread(thread);
    const c = id ? await this.store.get(id) : null;
    return c && this.hasAgent(c) ? this.subject(c) : null;
  }

  private views(viewer: ChatViewer, c: Conversation, ended: ReadonlySet<string> = NONE): MemberView[] {
    const byRef = new Map(c.members.map((m) => [`${m.kind}:${m.ref}`, m.name]));
    return c.members
      .filter((m) => m.leftAt === null)
      .map((m) => {
        const t = this.asTarget(m);
        return {
          kind: m.kind,
          name: m.name,
          you: m.kind === 'person' && viewer.personId !== null && m.ref === String(viewer.personId),
          addedBy: m.addedBy === null ? null : (byRef.get(`person:${m.addedBy}`) ?? null),
          address: m.kind === 'person' ? `${m.name}@console` : t.machine === null ? null : `${m.name}@${t.machine}`,
          sessionId: m.kind === 'agent' ? m.ref : null,
          ...(m.kind === 'agent' && ended.has(m.ref) ? { ended: true } : {}),
        };
      });
  }

  /** The agents of these conversations that ended for good (#1283): finished, or gone from the server. Read from the session, so it holds after a restart. A lost heartbeat is not that. */
  private async endedIn(list: Conversation[]): Promise<Set<string>> {
    const out = new Set<string>();
    const refs = new Set(list.flatMap((c) => c.members.filter((m) => m.leftAt === null && m.kind === 'agent').map((m) => m.ref)));
    for (const ref of refs) {
      if (this.core.host.isLive(ref)) continue;
      const s = await this.core.host.sessionOf(ref);
      if (s === null || s.ended === true) out.add(ref);
    }
    return out;
  }

  /** The viewer's conversations, newest activity first, for the overview: names, counts and times. */
  async list(viewer: ChatViewer): Promise<ConversationInfo[]> {
    if (viewer.personId === null) return [];
    const counts = new Map((await this.core.store.readState.list(viewer.personId)).map((r) => [r.thread, r]));
    const mine = await this.store.listFor({ kind: 'person', ref: String(viewer.personId) });
    const ended = await this.endedIn(mine);
    return mine.map((c) => this.info(viewer, c, counts.get(conversationThread(c.id)), ended));
  }

  /**
   * An Admin who browses a person's Chat (#1034): only the conversations an Admin may read, those with an agent in them, as names and counts. A conversation of people alone
   * is left out, so it is not even named (decision 74). The counts are 0: they are not the Admin's to see.
   */
  async listAbout(viewer: ChatViewer, name: string): Promise<ConversationInfo[]> {
    const person = (await this.core.persons()).find((p) => p.key === nameKey(name));
    if (!person) return [];
    const mine = await this.store.listFor({ kind: 'person', ref: String(person.id) });
    const withAgent = mine.filter((c) => this.hasAgent(c));
    const ended = await this.endedIn(withAgent);
    return withAgent.map((c) => this.info({ ...viewer, personId: person.id }, c, undefined, ended));
  }

  info(viewer: ChatViewer, c: Conversation, state: { unread: number; mentions: number } | undefined, ended: ReadonlySet<string> = NONE): ConversationInfo {
    return {
      id: c.id,
      thread: conversationThread(c.id),
      members: this.views(viewer, c, ended),
      hasAgent: this.hasAgent(c),
      unread: state?.unread ?? 0,
      mentions: state?.mentions ?? 0,
      messages: c.messages,
      lastAt: c.lastAt,
      adminReading: [],
    };
  }

  /** The thread of every conversation that exists, so the Admin records and counts of one that is gone can be removed. */
  async existing(): Promise<Set<string>> {
    return new Set((await this.store.ids()).map(conversationThread));
  }

  /** Whether the viewer's counts may be kept for this thread: they are a member of it. */
  async owns(viewer: ChatViewer, thread: string): Promise<boolean> {
    const id = conversationOfThread(thread);
    const c = id ? await this.store.get(id) : null;
    return !!c && !!this.memberOf(viewer, c);
  }

  /** Everyone the viewer can start a conversation with, narrowed by `q`: names, and the id of the conversation that already holds exactly the viewer and that person. */
  async peopleFor(viewer: ChatViewer, q: string): Promise<{ ok: true; people: { name: string; conversation: string | null }[] } | Fail> {
    if (viewer.personId === null) return { ok: true, people: [] };
    const needle = q.trim().toLowerCase();
    const mine = await this.store.listFor({ kind: 'person', ref: String(viewer.personId) });
    const pair = new Map<string, string>();
    for (const c of mine) {
      const now = c.members.filter((m) => m.leftAt === null);
      const other = now.length === 2 && now.every((m) => m.kind === 'person') ? now.find((m) => m.ref !== String(viewer.personId)) : undefined;
      if (other && !pair.has(other.ref)) pair.set(other.ref, c.id);
    }
    const people = (await this.core.persons())
      .filter((p) => p.id !== viewer.personId && (!needle || p.name.toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ name: p.name, conversation: pair.get(String(p.id)) ?? null }));
    return { ok: true, people };
  }

  /**
   * Turns what the browser sent into members: a person by name, an agent by session id. The agent must be a live orchestrator of the viewer's own; adding another person's
   * agent is not built yet and is refused in words. Never trusts a name or an id it cannot find.
   */
  private async resolve(viewer: ChatViewer, raw: unknown): Promise<{ ok: true; members: ConversationMemberInput[] } | Fail> {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 49) return fail(400, 'members must be a list of 1 to 49 people or agents.');
    const dir = await this.core.persons();
    const out: ConversationMemberInput[] = [];
    for (const item of raw as unknown[]) {
      const m = (item ?? {}) as Record<string, unknown>;
      if (m.kind === 'person' && typeof m.name === 'string') {
        const p = dir.find((x) => x.key === nameKey(m.name as string));
        if (!p) return fail(404, `There is no person named ${(m.name as string).slice(0, 80)}.`);
        out.push({ kind: 'person', ref: String(p.id), name: p.name });
      } else if (m.kind === 'agent' && typeof m.sessionId === 'string') {
        const s = await this.core.host.sessionOf(m.sessionId);
        if (!s || !this.core.host.isLive(m.sessionId)) return fail(409, 'That agent is not running, so it cannot be added.');
        if (s.ownerId === null || s.ownerId !== viewer.personId) return fail(403, `Adding another person's agent to a conversation is not available yet. Ask ${s.owner ?? 'its owner'} to add it from their own conversation.`);
        out.push({ kind: 'agent', ref: m.sessionId, name: s.name });
      } else return fail(400, 'A member is { kind: "person", name } or { kind: "agent", sessionId }.');
    }
    return { ok: true, members: out };
  }

  private view(viewer: ChatViewer, m: ConversationMessage): ConversationMessageView {
    const mine = viewer.personId !== null && m.authorKind === 'person' && m.authorId === viewer.personId;
    const gone = m.deletedAt !== null;
    return {
      id: m.id,
      author: { kind: m.authorKind, name: m.authorName, you: mine },
      text: m.text,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      deletedAt: m.deletedAt,
      replyTo: m.replyTo,
      ...changeState(mine && !gone, m.handedAt !== null, () => HANDED_WORDS),
      deliveries: gone ? [] : m.deliveries.map((d) => ({ kind: d.kind, name: d.name, named: d.named, state: d.state })),
    };
  }

  /** Cleans a person's text and checks its length against the Admin's limit, in the conversation's words. */
  private text(raw: unknown, limits: ChatLimits): { ok: true; text: string } | Fail {
    if (typeof raw !== 'string' || raw.length > TEXT_MAX_GUARD) return fail(400, 'text must be a string.');
    const text = this.core.redact(raw).trim();
    if (!text) return fail(400, 'Write something to send.');
    return this.core.tooLong(text.length, limits, 'convo') ?? { ok: true, text };
  }

  /**
   * Opens the conversation of the viewer and these members, or returns the one that already holds exactly them, and sends the first message when there is one. Another
   * person is never asked for anything: a conversation of people needs no approval. `201` for a new one, `200` for one that existed.
   */
  async open(viewer: ChatViewer, body: Record<string, unknown>): Promise<{ ok: true; created: boolean; conversation: ConversationInfo; message?: ConversationMessageView; skipped: string[] } | Fail> {
    if (viewer.personId === null) return fail(403, 'Only a person can start a conversation. The admin secret has no person to write as.');
    const got = await this.resolve(viewer, body.members);
    if (!got.ok) return got;
    const limits = body.text === undefined || body.text === null ? null : await this.core.limits();
    const first = limits && this.text(body.text, limits);
    if (first && !first.ok) return first;
    const me: ConversationMemberInput = { kind: 'person', ref: String(viewer.personId), name: viewer.name };
    let opened;
    try {
      opened = await this.store.open({ members: [me, ...got.members], createdBy: viewer.personId }, this.core.host.now());
    } catch (err) {
      return fail(400, (err as Error).message);
    }
    let message: ConversationMessageView | undefined;
    let skipped: string[] = [];
    if (first?.ok) {
      const sent = await this.send(viewer, opened.conversation.id, { text: first.text }, limits);
      // The conversation exists now, so a refused first message is told with it and not as a failure of the whole: the person sends it again from the thread.
      if (!sent.ok) skipped = [`The first message was not sent: ${sent.error}`];
      else {
        message = sent.message;
        skipped = sent.skipped;
      }
    }
    if (opened.created) this.core.onEvent({ kind: 'conversation_opened', by: viewer.actor, conversation: opened.conversation.id, members: opened.conversation.members.length });
    const c = (await this.store.get(opened.conversation.id)) as Conversation;
    return { ok: true, created: opened.created, conversation: this.info(viewer, c, undefined, await this.endedIn([c])), ...(message ? { message } : {}), skipped };
  }

  /** One page of a conversation. A member reads their own; an Admin reads one with an agent in it, recorded and told before it answers; anyone else gets a `404`. */
  async thread(viewer: ChatViewer, id: string, opts: { before?: string | null; limit: number }) {
    const c = await this.store.get(id);
    const role = c ? this.roleOf(viewer, c) : null;
    if (!c || !role) return noConversation();
    let page;
    try {
      page = await this.store.page(id, { before: opts.before ?? null, limit: Math.min(MAX_LIMIT, opts.limit) });
    } catch (err) {
      return fail(400, (err as Error).message);
    }
    // An Admin's read is recorded before it is answered, so no conversation is read without a record, and its people are told.
    if (role === 'admin') await this.reads.note(viewer, this.subject(c));
    const thread = conversationThread(id);
    const adminReads = await this.reads.list(thread);
    if (role === 'member' && viewer.personId !== null) await this.reads.seen(thread, viewer.personId);
    return { ok: true as const, conversation: this.info(viewer, c, undefined, await this.endedIn([c])), messages: page.messages.map((m) => this.view(viewer, m)), older: page.older, total: c.messages, adminReads };
  }

  /** An Admin's open conversation says it is still being read, every 15 seconds. Content-free. */
  async reading(viewer: ChatViewer, id: string): Promise<{ ok: true } | Fail> {
    if (!viewer.admin) return fail(403, 'Only an Admin reads a conversation that is not their own.');
    const c = await this.store.get(id);
    if (!c || this.roleOf(viewer, c) !== 'admin') return noConversation();
    await this.reads.note(viewer, this.subject(c), true);
    return { ok: true };
  }

  /** A member as an @ reads it: an agent that is running has a machine and an agent id, one that has ended or a person has neither. */
  private asTarget(m: ConversationMember): TargetMember {
    const live = m.kind === 'agent' && this.core.host.isLive(m.ref) ? this.core.host.peers.messages.live(m.ref) : null;
    return { kind: m.kind, ref: m.ref, name: m.name, machine: live?.machine ?? null, agentId: live?.agentId ?? null };
  }

  /** What an agent did with the text: taken is Delivered, refused or dropped is not taken. Queued on the way changes nothing. */
  private followed(id: string, messageId: string, m: { kind: 'person' | 'agent'; ref: string }, o: DeliveryOutcome): void {
    const state = o.kind === 'took' ? 'delivered' : o.kind === 'queued' ? null : 'dropped';
    if (!state) return;
    void this.store
      .setDelivery(id, messageId, m, state, this.core.host.now())
      .then(() => this.core.signal('dm'))
      .catch((err: unknown) => this.core.host.warn('a delivery in a conversation could not be updated', err));
  }

  /** A member writes. The text is redacted and limited first. It is stored, every other person in it is counted one unread, and each agent in it is handed the text. */
  async send(viewer: ChatViewer, id: string, body: Record<string, unknown>, known: ChatLimits | null = null): Promise<{ ok: true; message: ConversationMessageView; skipped: string[] } | Fail> {
    if (viewer.personId === null) return fail(403, 'Only a person in a conversation can write in it.');
    const c = await this.store.get(id);
    if (!c || !this.memberOf(viewer, c)) return noConversation();
    const limits = known ?? (await this.core.limits());
    const t = this.text(body.text, limits);
    if (!t.ok) return t;
    // Who it is for (#1282): an @ names members of this conversation and no one else; with none, it is for every agent in it. A refusal stores and hands over nothing, and costs no rate.
    const present = c.members.filter((m) => m.leftAt === null);
    const named = resolveTargets(t.text, present.map((m) => this.asTarget(m)), { kind: 'person', ref: String(viewer.personId) });
    if (!named.ok) return fail(422, named.error);
    const targets: ConversationTargetInput[] = named.targets ?? present.filter((m) => m.kind === 'agent').map((m) => ({ kind: 'agent' as const, ref: m.ref, name: m.name, named: false }));
    const fast = this.core.tooFast(`convo:${nameKey(viewer.name)}`, limits, 'convo');
    if (fast) return fast;
    const replyTo = typeof body.replyTo === 'string' && body.replyTo.length <= 80 ? body.replyTo : null;
    const stored = await this.store.post(id, { authorKind: 'person', authorRef: String(viewer.personId), authorName: viewer.name, authorId: viewer.personId, text: t.text, replyTo, targets }, this.core.host.now());
    if (!stored) return noConversation();
    // Every other person in it is told there is something new: a count, never text. A person it names also has a mention.
    const namedPeople = new Set(targets.filter((x) => x.kind === 'person' && x.named).map((x) => x.ref));
    for (const m of present) if (m.kind === 'person' && m.ref !== String(viewer.personId)) await this.core.count({ id: Number(m.ref), name: m.name }, conversationThread(id), 'dm', namedPeople.has(m.ref));
    const skipped: string[] = [];
    const ended = await this.endedIn([c]);
    for (const m of targets) {
      if (m.kind !== 'agent') continue;
      // An agent that ended for good is not sent anything (#1283); the person is told, as for any agent that did not take it.
      if (ended.has(m.ref)) {
        skipped.push(`${m.name}: it ended, so it did not get this message.`);
        await this.store.setDelivery(id, stored.id, m, 'dropped', this.core.host.now()).catch((err: unknown) => this.core.host.warn('a delivery in a conversation could not be updated', err));
        continue;
      }
      // The message names this conversation, so the agent answers in it with `convo:<id>` (#1299).
      const out = this.core.deliver(m.ref, viewer.actor, m.name, t.text, 'chat', true, null, viewer.personId, id);
      if (!out.ok) {
        skipped.push(`${m.name}: ${out.error}`);
        // The message is already stored and other agents may still be handed it, so a failure to record this one must not stop the loop or fail the send.
        await this.store.setDelivery(id, stored.id, m, 'dropped', this.core.host.now()).catch((err: unknown) => this.core.host.warn('a delivery in a conversation could not be updated', err));
        continue;
      }
      this.core.watch(out.delivery.id, (o) => this.followed(id, stored.id, m, o));
      // From this moment the agent has the text, so the message can no longer be edited or deleted.
      await this.store.markHanded(id, stored.id, this.core.host.now());
    }
    this.core.onEvent({ kind: 'conversation_sent', by: viewer.actor, conversation: id, messageId: stored.id });
    const now = (await this.store.getMessage(id, stored.id)) ?? stored;
    return { ok: true, message: this.view(viewer, now), skipped };
  }

  /**
   * An agent answers in a conversation it is in (#1299), the way a person's message to it named: `podium_send` to `convo:<id>`. Only a member answers, and only
   * where a person's message was handed to it in the last hour, so an agent does not start a conversation nobody asked it to join. The answer is cleaned and limited as a
   * person's is, stored as the agent's, and counted unread for every person in it.
   */
  async agentSend(o: LiveOrchestrator, id: string, body: Record<string, unknown>): Promise<{ ok: true; id: string; createdAt: number } | Fail> {
    const c = await this.store.get(id);
    if (!c || !c.members.some((m) => m.leftAt === null && m.kind === 'agent' && m.ref === o.sessionId)) return noConversation();
    const limits = await this.core.limits();
    const t = this.text(body.text, limits);
    if (!t.ok) return t;
    const fast = this.core.tooFast(`convo-agent:${o.sessionId}`, limits, 'convo');
    if (fast) return fast;
    if (!(await this.askedWithinWindow(id, o.sessionId))) return fail(403, 'Nobody has written to you in this conversation in the last hour, so Podium did not post your answer.');
    const stored = await this.store.post(id, { authorKind: 'agent', authorRef: o.sessionId, authorName: o.name, text: t.text }, this.core.host.now());
    if (!stored) return noConversation();
    for (const m of c.members) if (m.leftAt === null && m.kind === 'person') await this.core.count({ id: Number(m.ref), name: m.name }, conversationThread(id), 'dm', false);
    this.core.onEvent({ kind: 'conversation_sent', by: o.name, conversation: id, messageId: stored.id });
    return { ok: true, id: stored.id, createdAt: stored.createdAt };
  }

  /**
   * Whether a person's message in the last hour was handed, or is to be handed, to this agent (#1299). It looks back through the newest pages until a message is older than the
   * window, so a busy conversation does not hide the message the agent is answering, and stops after a fixed number of pages so one call cannot read the whole conversation.
   * A delivery Podium dropped never reached the agent, so it does not count.
   */
  private async askedWithinWindow(id: string, sessionId: string): Promise<boolean> {
    const since = this.core.host.now() - AGENT_ANSWER_WINDOW_MS;
    let before: string | null = null;
    for (let i = 0; i < AGENT_ANSWER_PAGES; i++) {
      const got = await this.store.page(id, { limit: MAX_LIMIT, before });
      if (got.messages.some((m) => m.authorKind === 'person' && m.deletedAt === null && m.createdAt >= since && m.deliveries.some((d) => d.kind === 'agent' && d.ref === sessionId && d.state !== 'dropped'))) return true;
      // The page is oldest first within itself; once its oldest message is outside the window, nothing older is inside it.
      if (got.older === null || (got.messages[0] !== undefined && got.messages[0].createdAt < since)) return false;
      before = got.older;
    }
    return false;
  }

  /** The author edits their own message, until Podium has handed it to an agent. */
  async editMessage(viewer: ChatViewer, id: string, messageId: string, body: Record<string, unknown>): Promise<{ ok: true; message: ConversationMessageView } | Fail> {
    return this.change(viewer, id, messageId, body, 'edit');
  }

  async deleteMessage(viewer: ChatViewer, id: string, messageId: string): Promise<{ ok: true; message: ConversationMessageView } | Fail> {
    return this.change(viewer, id, messageId, {}, 'delete');
  }

  private async change(viewer: ChatViewer, id: string, messageId: string, body: Record<string, unknown>, op: 'edit' | 'delete'): Promise<{ ok: true; message: ConversationMessageView } | Fail> {
    if (viewer.personId === null) return fail(403, 'The admin secret has no messages of its own to change.');
    const c = await this.store.get(id);
    const role = c ? this.roleOf(viewer, c) : null;
    if (!c || !role) return noConversation();
    if (role === 'admin') return fail(403, 'An Admin can read a conversation that has an agent in it, but cannot change its messages.');
    const now = this.core.host.now();
    let out;
    if (op === 'edit') {
      const limits = await this.core.limits();
      const t = this.text(body.text, limits);
      if (!t.ok) return t;
      // Who a message is for is fixed when it is sent (#1282): an edit that names someone else, or no one, would leave the line under it describing the old text.
      const was = await this.store.getMessage(id, messageId);
      if (was) {
        const now = resolveTargets(t.text, c.members.filter((m) => m.leftAt === null).map((m) => this.asTarget(m)), { kind: 'person', ref: String(viewer.personId) });
        const key = (x: { kind: string; ref?: string; name: string }): string => `${x.kind}:${x.name}`;
        const before = was.deliveries.filter((d) => d.named).map(key).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const after = now.ok ? (now.targets ?? []).map(key).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : null;
        if (before.length && JSON.stringify(before) !== JSON.stringify(after)) return fail(422, 'An edit cannot change who a message is for. Delete it and write it again to address someone else.');
      }
      const fast = this.core.tooFast(`convo:${nameKey(viewer.name)}`, limits, 'convo');
      if (fast) return fast;
      out = await this.store.editMessage(id, messageId, { author: viewer.personId, text: t.text, now });
    } else out = await this.store.deleteMessage(id, messageId, { author: viewer.personId, now });
    if (!out.ok) return changeRefusal(out.reason, CONVERSATION_WORDS, () => HANDED_WORDS);
    this.core.onEvent({ kind: op === 'edit' ? 'conversation_message_edited' : 'conversation_message_deleted', by: viewer.actor, conversation: id, messageId });
    for (const m of c.members) if (m.leftAt === null && m.kind === 'person' && m.ref !== String(viewer.personId)) this.core.signal('dm');
    return { ok: true, message: this.view(viewer, out.message) };
  }

  /** A member adds people or the viewer's own agents. Another person is added without being asked. */
  async addMembers(viewer: ChatViewer, id: string, body: Record<string, unknown>): Promise<{ ok: true; conversation: ConversationInfo } | Fail> {
    if (viewer.personId === null) return fail(403, 'Only a person in a conversation can add to it.');
    const c = await this.store.get(id);
    if (!c || !this.memberOf(viewer, c)) return noConversation();
    const got = await this.resolve(viewer, body.members);
    if (!got.ok) return got;
    let next;
    try {
      next = await this.store.addMembers(id, got.members, viewer.personId, this.core.host.now());
    } catch (err) {
      return fail(400, (err as Error).message);
    }
    if (!next) return noConversation();
    this.core.onEvent({ kind: 'conversation_members_added', by: viewer.actor, conversation: id, count: got.members.length });
    for (const m of next.members) if (m.leftAt === null && m.kind === 'person') this.core.signal('dm');
    return { ok: true, conversation: this.info(viewer, next, undefined, await this.endedIn([next])) };
  }

  /** The viewer leaves. A conversation with no person left in it is deleted with its messages. */
  async leave(viewer: ChatViewer, id: string): Promise<{ ok: true; deleted: boolean } | Fail> {
    if (viewer.personId === null) return fail(403, 'Only a person in a conversation can leave it.');
    const c = await this.store.get(id);
    if (!c || !this.memberOf(viewer, c)) return noConversation();
    const out = await this.store.leave(id, { kind: 'person', ref: String(viewer.personId) }, this.core.host.now());
    if (!out) return noConversation();
    if (out.deleted) await this.reads.forget(conversationThread(id));
    this.core.onEvent({ kind: 'conversation_left', by: viewer.actor, conversation: id, deleted: out.deleted });
    this.core.signal('dm');
    return { ok: true, deleted: out.deleted };
  }

  /**
   * An agent ended for good (#1283). A conversation that still has two or more people stays: the agent is marked ended (read from its session, so nothing is stored), it
   * can no longer send or be sent to, and the agents that remain are told once. A conversation with fewer than two people left is concluded: it is deleted with its
   * messages, the people in it are told in the console (`ConcludedList`), and the agents that remain are told once. Concluding twice finds nothing the second time.
   */
  async conclude(sessionId: string): Promise<void> {
    for (const c of await this.store.listFor({ kind: 'agent', ref: sessionId })) {
      const gone = c.members.find((m) => m.kind === 'agent' && m.ref === sessionId)!;
      const people = this.personIdsOf(c);
      const stays = people.length >= 2;
      const others = c.members.filter((m) => m.leftAt === null && m.kind === 'agent' && m.ref !== sessionId && this.core.host.isLive(m.ref));
      if (!stays) {
        const out = await this.store.remove(c.id);
        if (!out.removed) continue;
        await this.reads.drop(conversationThread(c.id));
        const withNames = c.members.filter((m) => m.leftAt === null && m.ref !== sessionId).map((m) => m.name);
        this.core.concluded.add(people, { thread: conversationThread(c.id), agent: gone.name, with: withNames });
        this.core.onEvent({ kind: 'dm_concluded', owner: people.map(String).join(','), a: c.id, b: sessionId, count: out.messages });
      }
      const told = endedNotice(gone.name, stays);
      // A conversation that stays is found again by a later end of the same session (finished, then deleted), so each agent is told once per conversation.
      for (const m of others) {
        const key = `${c.id}|${sessionId}|${m.ref}`;
        if (this.core.noticed.has(key)) continue;
        this.core.noticed.add(key);
        await this.core.host.peers.messages.notice(m.ref, told);
      }
      this.core.signal('dm');
    }
  }

  /** Retention: the messages older than the Admin's days go. Returns how many. */
  purge(olderThan: number): Promise<number> {
    return this.store.purge(olderThan);
  }
}
