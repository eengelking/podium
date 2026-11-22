// The channel side of Chat (#1034): General and My group. Posting, reading, `@` addressing and its delivery, and the stop buttons (Pause,
// Disconnect, Remove all). This file never reads a direct message: a channel's text and a conversation's text are kept in different tables and
// read by different code, and `chatSeparation.test.ts` holds this file to it.
import { nameKey } from '../storage/rows.js';
import type { LiveOrchestrator } from './peerTypes.js';
import type { ChannelFlags, ChannelMention, ChannelMessage, ChannelPage, ChannelPostInput, ChatAuthorKind, GroupScope, MentionState } from '../storage/types.js';
import { parseMentions, type ParsedMention } from './chatMentions.js';
import { ChatCore, changeRefusal, changeState, sentWords, type AcrossUpdate, type ChangeRefusal, type ChangeWords, type ChatLimits } from './chatCore.js';
import { groupSubject, type AdminReads, type Told } from './chatAdminReads.js';
import { CHANNEL_NAME, lockedByDelivery } from '../storage/chatRows.js';
import {
  GENERAL, GROUP, channelGlobalScope, channelName, channelPersonScope, channelThread, fail, groupScope, groupThread, isPublicChannel, scopeOf, type ChannelId, type ChatViewer, type Fail, type PersonRef,
} from './chatTypes.js';

/** How far back a held mention is looked for when a channel resumes: 10 pages of 100, far more than a person pauses over. */
const HELD_PAGES = 10;
const HELD_PAGE = 100;
/** A read for an agent is cut at about this many characters; the cursor gets the rest. */
const AGENT_READ_CHARS = 30_000;
/** The window an agent may read: fixed here, never chosen by the caller. */
const AGENT_READ_WINDOW_MS = 60 * 60 * 1000;
/** How many pages of 100 are searched for the call into a channel: far more than a channel gets in an hour. */
const CALLED_PAGES = 30;
/** The longest id a reply or a mark-read may name; a message id is far shorter. */
const MAX_ID = 64;
/** The mention states in which the agent was in fact called: it has the message, is working on it or answered it. */
const CALLED: ReadonlySet<MentionState> = new Set<MentionState>(['waiting', 'working', 'done']);
const NOT_CALLED = 'You were not called into this channel in the last hour.';
const NO_PERSON = 'This agent belongs to no person, so it has no group.';
const NOT_YET ='Agents addressing each other in a channel arrive in a later release, so this was not delivered.';

interface MentionView {
  typed: string;
  sessionId: string | null;
  state: MentionState;
  why: string | null;
  stateAt: number;
}

export interface ChannelMessageView {
  id: string;
  authorKind: ChatAuthorKind;
  authorName: string;
  /** The person's name for a person, the session id for an agent. */
  authorRef: string;
  /** '' for a message its author deleted (#1269). */
  text: string;
  createdAt: number;
  updatedAt: number;
  replyTo: string | null;
  issue: string | null;
  project: string | null;
  milestone: string | null;
  /** For an agent's message, the person who owns the agent (#1035), as the session was last stored; null for a person's message or an agent whose session is gone. */
  authorOwner: string | null;
  mine: boolean;
  mentions: MentionView[];
  /** When the author last changed the text (#1269); null for a message never edited. */
  editedAt: number | null;
  /** When the author deleted it (#1269); null for a message that stands. A deleted message has no text and no mentions. */
  deletedAt: number | null;
  /** Whether the viewer, who must be the author (by id, never by name), may edit or delete it now (#1269). */
  canChange: boolean;
  /** In words, why the author cannot change it now: it has been sent to an agent, or it waits for another person's approval. Null when they can, when it is deleted and when the viewer is not its author. */
  changeWhy: string | null;
}

/** The agents a person's message was sent to, as they were typed: the names of the mentions that lock it (`lockedByDelivery`, asked of each one). */
function sentTo(m: ChannelMessage): string[] {
  return [...new Set(m.mentions.filter((x) => lockedByDelivery([x])).map((x) => x.typed.split('@')[0] || 'the agent'))];
}

/** The refusal's words for a message an agent has: it names the agent when it is known. */
function lockedWords(m: Pick<ChannelMessage, 'mentions'>): string {
  return sentWords(sentTo(m as ChannelMessage));
}

/** The words for a message that waits for another person to approve it with no copy kept for it (stored before copies were kept): the copy cannot be reached from here (#1269). */
function approvalWords(m: Pick<ChannelMessage, 'mentions'>): string | null {
  // A mention that waits with a copy kept for it can be changed with it; one stored before copies were kept cannot (#1269).
  const waiting = m.mentions.find((x) => x.state === 'approval' && !x.copyId);
  if (!waiting) return null;
  const who = /^Waiting for (.+) to approve$/.exec(waiting.why ?? '')?.[1] ?? 'another person';
  return `This message is waiting for ${who} to approve, so it cannot be changed now.`;
}

/** Whether the viewer may change this message, and when not, why: by the author's id, never the name. The lock is the store's predicate. */
function changeOf(m: ChannelMessage, viewer: ChatViewer | null): { canChange: boolean; changeWhy: string | null } {
  const mine = m.deletedAt === null && viewer !== null && viewer.personId !== null && m.authorKind === 'person' && m.authorId !== null && m.authorId === viewer.personId;
  return changeState(mine, lockedByDelivery(m.mentions), () => lockedWords(m), approvalWords(m));
}

export function messageView(m: ChannelMessage, viewer: ChatViewer | null, owners: ReadonlyMap<string, string | null> = new Map()): ChannelMessageView {
  return {
    id: m.id,
    authorKind: m.authorKind,
    authorName: m.authorName,
    authorRef: m.authorRef,
    text: m.deletedAt === null ? m.text : '',
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    replyTo: m.replyTo,
    issue: m.issue,
    project: m.project,
    milestone: m.milestone,
    authorOwner: m.authorKind === 'person' ? null : (owners.get(m.authorRef) ?? null),
    mine: m.authorKind === 'person' && viewer !== null && viewer.personId !== null && m.authorId === viewer.personId,
    mentions: m.deletedAt === null ? m.mentions.map((x) => ({ typed: x.typed, sessionId: x.sessionId, state: x.state, why: x.why, stateAt: x.stateAt })) : [],
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    ...changeOf(m, viewer),
  };
}

/** Whether a stored mention is of this agent: its session, else the same reporter and name (as delivery resolves it). */
function mentionsAgent(m: ChannelMention, o: LiveOrchestrator): boolean {
  return m.sessionId === o.sessionId || (m.peerKey === o.reporterKey && nameKey(m.typed.split('@')[0] ?? '') === nameKey(o.name));
}

/**
 * What an agent is shown of a channel message: who wrote it, of what kind, when, and its text. No session id, no delivery state. An edited message shows its current
 * text and `editedAt`; a message its author deleted shows `deleted: true` and `deletedAt` and has no `text` field at all (#1269).
 */
export type AgentMessageView =
  | { id: string; authorKind: ChatAuthorKind; authorName: string; text: string; createdAt: number; replyTo: string | null; editedAt?: number }
  | { id: string; authorKind: ChatAuthorKind; authorName: string; createdAt: number; replyTo: string | null; deleted: true; deletedAt: number };
export const agentMessageView = (m: ChannelMessage): AgentMessageView =>
  m.deletedAt !== null
    ? { id: m.id, authorKind: m.authorKind, authorName: m.authorName, createdAt: m.createdAt, replyTo: m.replyTo, deleted: true, deletedAt: m.deletedAt }
    : { id: m.id, authorKind: m.authorKind, authorName: m.authorName, text: m.text, createdAt: m.createdAt, replyTo: m.replyTo, ...(m.editedAt === null ? {} : { editedAt: m.editedAt }) };

/** Whether two texts name the same @mentions, by what was typed, folded as the stored `typed` is: an edit may not add or remove one (#1269). */
function sameMentions(before: string, after: string): boolean {
  const names = (t: string): string[] => parseMentions(t).map((m) => m.typed.toLowerCase()).sort((x, y) => x.localeCompare(y));
  const a = names(before);
  const b = names(after);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The flags a channel is under for the person it concerns: the group's own, or General's for everyone and for one person's agents. */
export interface ChannelState {
  paused: boolean;
  /** The Admin's name while an Admin paused it (the group of another person, or General for everyone); only an Admin can then resume it. Null otherwise. */
  pausedByAdmin: string | null;
  pausedForEveryone: boolean;
  disconnected: boolean;
}

/** The folded name the Admin log and the console's signals carry for a person (#1284). It is text for people to read and is never what a group, a count or a notice is found by. */
const oname = (owner: PersonRef | null): string | null => (owner === null ? null : nameKey(owner.name));

/** A mention worked out: what to store, the person it gives a mention badge (`people.id`, #1284), and the agent to hand it to. */
type Planned = { input: NonNullable<ChannelPostInput['mentions']>[number]; bump: number | null; deliver: LiveOrchestrator | null };

/** The refusal when an Admin tries to write in a group that is not their own. */
const ADMIN_NO_WRITE = 'An Admin can read and stop a person\'s group but cannot write in it.';

/** What a channel says when the store refuses to change a message. */
const CHANNEL_WORDS: ChangeWords = { notFound: 'There is no such message in this channel.', notYours: 'Only the person who wrote a message can change it.', deleted: 'This message has already been deleted.' };

export class ChannelChat {
  constructor(
    private readonly core: ChatCore,
    private readonly reads: AdminReads,
  ) {}

  private get store() {
    return this.core.store;
  }

  private live(): LiveOrchestrator[] {
    return this.core.host.liveIds().flatMap((id) => {
      const o = this.core.host.peers.messages.live(id);
      return o ? [o] : [];
    });
  }

  /** The person an agent belongs to, by the owner id its session carries (#1284). Null for an agent with no person: the admin secret's, or one whose person was deleted. */
  private ownerOf(o: LiveOrchestrator): PersonRef | null {
    return o.ownerId === null ? null : { id: o.ownerId, name: o.owner };
  }

  private liveOf(sessionId: string): LiveOrchestrator | null {
    return this.core.host.isLive(sessionId) ? this.core.host.peers.messages.live(sessionId) : null;
  }

  // ---- The store behind a channel ----------------------------------------------------------------------------------

  private handle(channel: ChannelId, owner: PersonRef | null) {
    const st = this.store;
    if (channel === 'group') {
      const g: GroupScope = { ownerId: (owner as PersonRef).id };
      return {
        post: (i: ChannelPostInput) => st.group.post(g, i),
        page: (o: { before?: string | null; limit: number }) => st.group.page(g, o),
        setMention: (id: string, index: number, patch: { state: MentionState; why?: string | null; copyId?: string | null }) => st.group.setMention(g, id, index, patch),
        heldMentions: (f: { sessionId?: string }) => st.group.heldMentions(g, f),
        getMessage: (id: string) => st.group.getMessage(g, id),
        editMessage: (id: string, x: { author: number; text: string; now: number }) => st.group.editMessage(g, id, x),
        deleteMessage: (id: string, x: { author: number; now: number }) => st.group.deleteMessage(g, id, x),
        clear: () => st.group.clear(g),
        count: () => st.group.count(g),
      };
    }
    return {
      post: (i: ChannelPostInput) => st.public.post(channel, i),
      page: (o: { before?: string | null; limit: number }) => st.public.page(channel, o),
      setMention: (id: string, index: number, patch: { state: MentionState; why?: string | null; copyId?: string | null }) => st.public.setMention(channel, id, index, patch),
      heldMentions: (f: { sessionId?: string }) => st.public.heldMentions(channel, f),
      getMessage: (id: string) => st.public.getMessage(channel, id),
      editMessage: (id: string, x: { author: number; text: string; now: number }) => st.public.editMessage(channel, id, x),
      deleteMessage: (id: string, x: { author: number; now: number }) => st.public.deleteMessage(channel, id, x),
      clear: () => st.public.clear(channel),
      count: () => st.public.count(channel),
    };
  }

  private threadOf(channel: ChannelId, owner: PersonRef | null): string {
    return channel === GROUP ? groupThread((owner as PersonRef).id) : channelThread(channel);
  }

  /**
   * The channel a request names (#1035): `general`, `group`, or a public channel that exists (its name in any case is the same channel). Null for anything else,
   * so a name that is not a channel can never reach a store: it is checked against the name rule before it is looked up, and `general` and `group` are
   * matched exactly (the store holds neither as a channel).
   */
  async resolve(raw: unknown): Promise<ChannelId | null> {
    if (raw === GENERAL || raw === GROUP) return raw;
    if (typeof raw !== 'string' || !CHANNEL_NAME.test(raw.toLowerCase())) return null;
    return (await this.store.channels.get(raw))?.name ?? null;
  }

  /** The owners' names of the agents that wrote these messages, as their sessions were last stored (display text, #1284); a session that is gone has none (#1035). One lookup per agent, all at once. */
  async ownersOf(messages: ChannelMessage[]): Promise<Map<string, string | null>> {
    const refs = [...new Set(messages.filter((m) => m.authorKind !== 'person').map((m) => m.authorRef))];
    const owners = await Promise.all(refs.map(async (ref) => [ref, (await this.core.host.sessionOf(ref))?.owner ?? null] as const));
    return new Map(owners);
  }

  /** General and every public channel that exists, by key: the places a mention or a held message of the public audience can be. */
  private async publicIds(): Promise<string[]> {
    return [GENERAL, ...(await this.store.channels.list()).map((c) => c.name)];
  }

  /** The channel a request is about: the group of the person asking, or the owner an Admin names. Fails when there is none to use. */
  async scopeFor(viewer: ChatViewer, channel: ChannelId, named: string | null | undefined): Promise<{ owner: PersonRef | null } | Fail> {
    if (isPublicChannel(channel)) return { owner: null };
    if (named) {
      // A typed name becomes a person here, once, and from then on the group is the person's id (#1284). The viewer naming themselves is the viewer's own group; a name that is no person's is no group.
      const p = await this.core.personNamed(named);
      if (!p) return fail(404, `There is no person named ${named.slice(0, 80)}.`);
      if (p.id !== viewer.personId) {
        if (!viewer.admin) return fail(403, 'Only its person and an Admin can use a group.');
        return { owner: { id: p.id, name: p.name } };
      }
    }
    if (viewer.personId === null) return fail(viewer.admin ? 400 : 403, 'The admin secret has no group of its own. Name the person whose group you mean.');
    return { owner: { id: viewer.personId, name: viewer.name } };
  }

  // ---- Flags ---------------------------------------------------------------------------------------------------------

  async flagsOf(channel: ChannelId, owner: PersonRef | null, personId: number | null, known?: Record<string, ChannelFlags>): Promise<ChannelState> {
    const f = this.store.settings;
    // `known` is every flag that is on, read once by a caller that asks about many channels (the overview); a scope not in it is off.
    const flags = async (scope: string): Promise<ChannelFlags> => (known ? (known[scope] ?? { paused: false, disconnected: false }) : f.flags(scope));
    if (channel === GROUP) {
      const g = await flags(groupScope((owner as PersonRef).id));
      return { paused: g.paused, pausedByAdmin: g.paused ? (g.pausedByAdmin ?? null) : null, pausedForEveryone: false, disconnected: g.disconnected };
    }
    const all = await flags(channelGlobalScope(channel));
    const mine: ChannelFlags = personId !== null ? await flags(channelPersonScope(channel, personId)) : { paused: false, disconnected: false };
    return { paused: all.paused || mine.paused, pausedByAdmin: all.paused ? (all.pausedByAdmin ?? null) : null, pausedForEveryone: all.paused, disconnected: mine.disconnected };
  }

  /** The flags that bind a message to an agent of `agentOwner` in `channel`. */
  private async bindingFlags(channel: ChannelId, groupOwner: PersonRef | null, agentOwnerId: number | null): Promise<ChannelState> {
    return channel === GROUP ? this.flagsOf(GROUP, groupOwner, null) : this.flagsOf(channel, null, agentOwnerId);
  }

  // ---- Reading -------------------------------------------------------------------------------------------------------

  async page(viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null, opts: { before?: string | null; limit: number }): Promise<{ page: ChannelPage; total: number } | Fail> {
    const h = this.handle(channel, owner);
    try {
      return { page: await h.page(opts), total: await h.count() };
    } catch (err) {
      return fail(400, (err as Error).message);
    }
  }

  /**
   * An Admin read a person's group: recorded (and the person told) before it is answered. Returns the thread's records, which its person and an Admin may read:
   * for the group, the readings and the Admin's stops; for General and every other public channel, which are public and never read-recorded, only the Admin's stops
   * (#1034, #1035): what an Admin reads there is what every signed-in person reads, so it raises no notice and writes no record.
   */
  async readRecord(viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null) {
    if (isPublicChannel(channel)) return this.reads.list(channelThread(channel));
    if (owner === null) return [];
    if (viewer.admin && owner.id !== viewer.personId) await this.reads.note(viewer, groupSubject(owner.id, owner.name));
    const records = await this.reads.list(groupThread(owner.id));
    // The records go to the person's own console here, so what is owed to them is seen (#1051).
    if (viewer.personId !== null && owner.id === viewer.personId) await this.reads.seen(groupThread(owner.id), viewer.personId);
    return records;
  }

  /** An Admin's open group says it is still being read. Content-free. */
  async reading(viewer: ChatViewer, owner: PersonRef | null): Promise<{ ok: true } | Fail> {
    if (!viewer.admin) return fail(403, 'Only an Admin reads a group that is not their own.');
    if (owner === null || owner.id === viewer.personId) return fail(400, 'That group is yours, so reading it is not recorded.');
    await this.reads.note(viewer, groupSubject(owner.id, owner.name), true);
    return { ok: true };
  }

  async total(channel: ChannelId, owner: PersonRef | null): Promise<number> {
    return this.handle(channel, owner).count();
  }

  /**
   * What an agent may read of a channel (#1034): the last hour of it, and only when the agent was called into it (a stored mention of this agent that was
   * delivered, in that hour). The newest messages that fit in about 30,000 characters, oldest first, and the cursor for the ones before them that are
   * still inside the hour. Reading changes no mention.
   */
  async agentRead(o: LiveOrchestrator, channel: ChannelId, before: string | null): Promise<{ messages: ChannelMessage[]; older: string | null } | Fail> {
    const owner = this.ownerOf(o);
    if (channel === GROUP && owner === null) return fail(403, NO_PERSON);
    const flags = await this.flagsOf(channel, owner, o.ownerId);
    if (flags.disconnected) return fail(403, `${channelName(channel)} is disconnected for your agents. Your person reconnects it.`);
    const h = this.handle(channel, owner);
    const since = this.core.host.now() - AGENT_READ_WINDOW_MS;
    try {
      if (!(await this.calledInto(h, o, since))) return fail(403, NOT_CALLED);
      const inHour = async (cursor: string | null, limit: number): Promise<ChannelPage> => {
        const page = await h.page({ before: cursor, limit });
        const messages = page.messages.filter((m) => m.createdAt >= since);
        let older = messages.length < page.messages.length ? null : page.older;
        if (older) {
          const next = (await h.page({ before: older, limit: 1 })).messages[0];
          if (!next || next.createdAt < since) older = null;
        }
        return { messages, older };
      };
      const page = await inHour(before, 50);
      let used = 0;
      let keep = 0;
      for (let i = page.messages.length - 1; i >= 0; i--) {
        used += page.messages[i]!.text.length;
        if (used > AGENT_READ_CHARS && keep > 0) break;
        keep++;
      }
      return keep < page.messages.length ? await inHour(before, keep) : page;
    } catch (err) {
      return fail(400, (err as Error).message);
    }
  }

  /** Whether a delivered mention of this agent is in the channel's messages since `since`. Pages back from the newest and stops at the hour's edge. */
  private async calledInto(h: { page: (o: { before?: string | null; limit: number }) => Promise<ChannelPage> }, o: LiveOrchestrator, since: number): Promise<boolean> {
    let cursor: string | null = null;
    for (let i = 0; i < CALLED_PAGES; i++) {
      const page: ChannelPage = await h.page({ before: cursor, limit: HELD_PAGE });
      // A mention in the agent's own message is its own word and calls no one in (#1051).
      const own = (m: ChannelMessage): boolean => m.authorKind === 'orchestrator' && m.authorRef === o.sessionId;
      if (page.messages.some((m) => m.deletedAt === null && !own(m) && m.createdAt >= since && m.mentions.some((x) => CALLED.has(x.state) && mentionsAgent(x, o)))) return true;
      if (!page.older || (page.messages[0]?.createdAt ?? 0) < since) return false;
      cursor = page.older;
    }
    return false;
  }

  // ---- Posting ---------------------------------------------------------------------------------------------------------

  /** The checks that cost nothing: a text, and within Chat's length. The rate limit follows, then `this.core.redact`, which reads every character (#1051). */
  private checkText(raw: unknown, limits: ChatLimits): { raw: string } | Fail {
    if (typeof raw !== 'string' || !raw.trim()) return fail(400, 'The message is empty. Write the text to send.');
    return this.core.tooLong(raw.length, limits) ?? { raw };
  }

  /** The agents and people a typed `@` can mean in this channel, for the address list and for resolving a mention. */
  async addressBook(channel: ChannelId, owner: PersonRef | null): Promise<{ typed: string; label: string; role: 'orchestrator' | 'person' | 'group' | 'everyone'; sessionId: string | null; disabled?: boolean; why?: string }[]> {
    const out: { typed: string; label: string; role: 'orchestrator' | 'person' | 'group' | 'everyone'; sessionId: string | null; disabled?: boolean; why?: string }[] = [];
    const agents = this.live().filter((o) => isPublicChannel(channel) || (owner !== null && o.ownerId === owner.id));
    for (const o of agents.sort((a, b) => `${a.name}@${a.machine}`.localeCompare(`${b.name}@${b.machine}`))) out.push({ typed: `${o.name}@${o.machine}`, label: 'Orchestrator', role: 'orchestrator', sessionId: o.sessionId });
    for (const p of await this.core.persons()) if (isPublicChannel(channel) || (owner !== null && p.id === owner.id)) out.push({ typed: `${p.name}@console`, label: 'Person', role: 'person', sessionId: null });
    const everyone = (await this.core.limits()).everyone;
    const off = { disabled: true, why: 'Off. An Admin turns it on in Admin > Settings.' };
    out.push({ typed: 'group', label: 'Everyone in My group', role: 'group', sessionId: null, ...(everyone ? {} : off) });
    out.push({ typed: 'everyone', label: 'Everyone signed in', role: 'everyone', sessionId: null, ...(everyone ? {} : off) });
    return out;
  }

  /** Works out each typed mention. Fails (nothing stored) for an `@group` or `@everyone` that is off, and for a name two agents share. */
  private async plan(parsed: ParsedMention[], channel: ChannelId, owner: PersonRef | null, author: ChatViewer | null, limits: ChatLimits): Promise<Planned[] | Fail> {
    const people = await this.core.persons();
    const agents = this.live().filter((o) => isPublicChannel(channel) || (owner !== null && o.ownerId === owner.id));
    const out: Planned[] = [];
    const add = (p: Planned): void => void out.push(p);
    const personOf = (name: string) => people.find((p) => p.key === nameKey(name));
    if (!limits.everyone && parsed.some((m) => m.kind === 'group' || m.kind === 'everyone')) {
      return fail(422, '@group and @everyone are off, so nothing was sent. An Admin turns them on in Admin > Settings. Address one agent as name@location instead.');
    }
    for (const m of parsed) {
      if (m.kind === 'group' || m.kind === 'everyone') {
        // Both reach the sender's own orchestrators; @everyone also gives every person a mention badge.
        const mine = this.live().filter((o) => !author || (o.ownerId !== null && o.ownerId === author.personId));
        for (const o of mine) add({ input: { sessionId: o.sessionId, peerKey: o.reporterKey, typed: m.typed }, bump: null, deliver: o });
        if (m.kind === 'everyone') for (const n of people) add({ input: { sessionId: null, peerKey: null, typed: `${n.key}@console`, state: 'done', why: 'notified' }, bump: n.id, deliver: null });
        continue;
      }
      const wantName = nameKey(m.name);
      const here = m.kind === 'address' ? agents.filter((o) => nameKey(o.name) === wantName && nameKey(o.machine) === nameKey(m.location)) : agents.filter((o) => nameKey(o.name) === wantName);
      // A numeric `#id` is an agent id and nothing else (#1284), as `podium_send` reads it: it must not also match a session id that happens to start with those digits.
      const matches = m.kind === 'address' && m.id ? here.filter((o) => (/^\d+$/.test(m.id as string) ? String(o.agentId) === m.id : o.sessionId.toLowerCase().startsWith((m.id as string).toLowerCase()))) : here;
      if (m.kind === 'address' && nameKey(m.location) === 'console') {
        const there = personOf(m.name);
        if (there && (isPublicChannel(channel) || there.id === owner?.id)) add({ input: { sessionId: null, peerKey: null, typed: m.typed, state: 'done', why: 'notified' }, bump: there.id, deliver: null });
        else add({ input: { sessionId: null, peerKey: null, typed: m.typed, state: 'not-delivered', why: channel === 'group' ? `${m.name} is not in this group` : `there is no person called ${m.name}` }, bump: null, deliver: null });
        continue;
      }
      const hit = m.kind === 'plain' ? personOf(m.name) : undefined;
      const personHit = hit !== undefined && (isPublicChannel(channel) || hit.id === owner?.id);
      const total = matches.length + (personHit ? 1 : 0);
      if (m.kind === 'plain' && total === 0) continue; // an @ with a word after it that names nobody is only text
      if (total > 1) {
        const list = [...matches.map((o) => `${o.name}@${o.machine}${here.length > 1 ? `#${o.agentId}` : ''}`), ...(personHit ? [`${m.name}@console`] : [])];
        return fail(409, `More than one agent or person is called ${m.kind === 'address' ? `${m.name}@${m.location}` : m.name}, so Podium cannot tell which you mean. Address one as ${list.join(', ')}.`);
      }
      const o = matches[0];
      if (o) add({ input: { sessionId: o.sessionId, peerKey: o.reporterKey, typed: m.typed }, bump: null, deliver: o });
      else if (personHit) add({ input: { sessionId: null, peerKey: null, typed: `${m.name}@console`, state: 'done', why: 'notified' }, bump: hit.id, deliver: null });
      else add({ input: { sessionId: null, peerKey: null, typed: m.typed, state: 'not-delivered', why: `no live agent called ${m.name} on ${m.kind === 'address' ? m.location : 'any machine'}` }, bump: null, deliver: null });
    }
    return out;
  }

  /** A person posts. Returns the stored message and anything the person should hear about (a mention that could not be delivered). */
  async post(viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null, body: Record<string, unknown>): Promise<{ ok: true; message: ChannelMessage; warnings: string[] } | Fail> {
    // An Admin reads and stops a person's group and never writes in it (#1034); only its person writes there.
    if (channel === 'group' && (owner === null || owner.id !== viewer.personId)) return fail(403, ADMIN_NO_WRITE);
    const limits = await this.core.limits();
    const checked = this.checkText(body.text, limits);
    if ('ok' in checked) return checked;
    const limited = this.core.tooFast(`person:${nameKey(viewer.name)}`, limits);
    if (limited) return limited;
    // A reply to a message that is not in this channel is refused, as an agent's is, so a post never points at an id nothing holds (#1051).
    const replyTo = typeof body.replyTo === 'string' && body.replyTo ? body.replyTo : null;
    if (replyTo && (replyTo.length > MAX_ID || !(await this.find(channel, owner, replyTo)))) return fail(404, 'There is no such message to reply to in this channel.');
    const text = this.core.redact(checked.raw);
    const parsed = parseMentions(text);
    const planned = await this.plan(parsed, channel, owner, viewer, limits);
    if ('ok' in planned) return planned;
    const warnings: string[] = [];
    const framed = `From Podium Chat, ${channelName(channel)}, ${viewer.name} wrote:\n${text}`;
    const inputs: NonNullable<ChannelPostInput['mentions']> = [];
    const sentTo = new Map<number, { sessionId: string; deliveryId: string }>();
    // An @ of another person's agent (#1034) is a request for that agent's owner. It is made after the message is stored, so a message that fails to store leaves no request behind.
    const across: { index: number; o: LiveOrchestrator }[] = [];
    for (const p of planned) {
      let input = p.input;
      const o = p.deliver;
      if (o) {
        const flags = await this.bindingFlags(channel, owner, o.ownerId);
        // Another person's agent needs that person's say-so from everyone, an Administrator included (#1034). An Admin keeps read and stop powers only.
        if (o.ownerId === null || o.ownerId !== viewer.personId) {
          if (viewer.personId === null) {
            input = { ...input, state: 'not-delivered', why: `The admin secret has no person name, so Podium cannot ask ${o.owner} for you. Sign in with your own name to message ${o.name}.` };
            warnings.push(`${o.name}: ${input.why}`);
          } else if (flags.disconnected) input = { ...input, state: 'not-delivered', why: `${channelName(channel)} is disconnected for ${o.name}'s person` };
          else if (flags.paused) input = { ...input, state: 'not-delivered', why: `${channelName(channel)} is paused for ${o.name}'s person, so Podium did not ask them` };
          else {
            across.push({ index: inputs.length, o });
            input = { ...input, state: 'approval', why: `Waiting for ${o.owner} to approve` };
          }
        } else if (flags.disconnected) input = { ...input, state: 'not-delivered', why: `${channelName(channel)} is disconnected for ${o.name}'s person` };
        else if (flags.paused) input = { ...input, state: 'held', why: `${channelName(channel)} is paused` };
        else {
          const sent = this.core.deliver(o.sessionId, viewer.name, o.name, framed, 'channel', false, o.peers === true ? channelName(channel) : null, viewer.personId);
          if (sent.ok) {
            sentTo.set(inputs.length, { sessionId: o.sessionId, deliveryId: sent.delivery.id });
            input = { ...input, state: 'waiting' };
          } else {
            input = { ...input, state: 'not-delivered', why: sent.error };
            warnings.push(`${o.name}: ${sent.error}`);
          }
        }
      }
      inputs.push(input);
    }
    let message: ChannelMessage;
    try {
      message = await this.handle(channel, owner).post({
        authorKind: 'person',
        authorRef: viewer.name,
        authorName: viewer.name,
        authorId: viewer.personId,
        text,
        replyTo,
        issue: this.core.label(body.issue),
        project: this.core.label(body.project),
        milestone: this.core.label(body.milestone),
        mentions: inputs,
      });
    } catch (err) {
      for (const sent of sentTo.values()) this.core.host.respond.discard(sent.deliveryId, viewer.name, true);
      return fail(400, (err as Error).message);
    }
    for (const [index, sent] of sentTo) this.follow(channel, owner, message.id, index, sent.deliveryId, sent.sessionId);
    for (const x of across) await this.askAcross(viewer, channel, owner, message, x, text, warnings);
    await this.afterPost(channel, owner, viewer.personId, planned);
    this.core.onEvent({ kind: 'sent', channel, owner: oname(owner), by: viewer.actor, messageId: message.id, sessionId: null });
    return { ok: true, message, warnings };
  }

  /** Asks the agent's owner, through the direct-message side, and moves the mention the person wrote to what came of it. */
  private async askAcross(viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null, message: ChannelMessage, x: { index: number; o: LiveOrchestrator }, text: string, warnings: string[]): Promise<void> {
    const asked = this.core.across ? await this.core.across(viewer, x.o.sessionId, text, { rate: false }) : null;
    const patch: { state: MentionState; why: string | null } = asked?.ok
      ? asked.state === 'approval'
        ? { state: 'approval', why: `Waiting for ${asked.owner} to approve` }
        : { state: 'waiting', why: null }
      : { state: 'not-delivered', why: asked ? asked.error : "Podium cannot hand this agent a message from another person" };
    if (!asked?.ok) warnings.push(`${x.o.name}: ${patch.why}`);
    if (patch.state !== 'approval') {
      await this.handle(channel, owner).setMention(message.id, x.index, patch);
      const m = message.mentions[x.index];
      if (m) message.mentions[x.index] = { ...m, ...patch, stateAt: this.core.host.now() };
    } else if (asked?.ok) {
      // The mention keeps the id of the copy the owner is asked about, so an edit or a delete of this message reaches it (#1269). It is set only while the mention still waits: an owner who
      // answered in the meantime has moved it on, and that is not undone.
      const h = this.handle(channel, owner);
      const now = await h.getMessage(message.id);
      if (now?.mentions[x.index]?.state === 'approval' && (await h.setMention(message.id, x.index, { state: 'approval', why: patch.why, copyId: asked.messageId }))) {
        const m = message.mentions[x.index];
        if (m) message.mentions[x.index] = { ...m, copyId: asked.messageId };
      }
    }
  }

  /** What became of a person's message to another person's agent (#1034): the oldest mention of that agent in General by that person, in one of the states it may move from, moves. */
  async acrossUpdate(u: AcrossUpdate): Promise<void> {
    // The person may have written it in General or in any public channel (#1035): the oldest such mention of that agent, in any of them, is the one that moves.
    // One read for all of them: the person's messages that mention that agent in one of the states it may move from, oldest first, each carrying its channel (#1213).
    let hit: { channel: ChannelId; message: ChannelMessage; index: number } | null = null;
    for (const message of await this.store.public.mentionsAcross({ sessionId: u.sessionId, states: u.from })) {
      if (message.authorKind !== 'person' || message.authorId !== u.personId) continue;
      const index = message.mentions.findIndex((m) => m.sessionId === u.sessionId && u.from.includes(m.state));
      if (index >= 0) {
        hit = { channel: message.channel as ChannelId, message, index };
        break;
      }
    }
    if (!hit) return;
    await this.handle(hit.channel, null).setMention(hit.message.id, hit.index, { state: u.state, why: u.why });
    this.core.signal('public');
  }

  /** What becomes of a delivered mention moves its state: taken is working, refused is not delivered, a drop is dropped. */
  private follow(channel: ChannelId, owner: PersonRef | null, messageId: string, index: number, deliveryId: string, sessionId: string): void {
    this.core.watch(deliveryId, (o) => {
      const patch = o.kind === 'took' ? { state: 'working' as const } : o.kind === 'queued' ? null : o.kind === 'dropped' ? { state: 'dropped' as const, why: o.why } : { state: 'not-delivered' as const, why: o.why };
      if (!patch) return;
      void this.handle(channel, owner)
        .setMention(messageId, index, patch)
        .then(() => {
          this.core.onEvent({ kind: o.kind === 'took' ? 'delivered' : 'dropped', channel, owner: oname(owner), by: 'server', messageId, sessionId, ...(o.kind === 'took' ? {} : { why: 'why' in o ? o.why : undefined }) });
          this.core.signal(scopeOf(channel));
        })
        .catch((err: unknown) => this.core.host.warn('a mention in Chat could not be updated', err));
    });
  }

  /** The counts a post changes, and the stream signal. A person's own post never counts against them. */
  private async afterPost(channel: ChannelId, owner: PersonRef | null, authorId: number | null, planned: Planned[]): Promise<void> {
    const thread = this.threadOf(channel, owner);
    const audience: PersonRef[] = channel === 'group' ? (owner ? [owner] : []) : await this.core.persons();
    const mentioned = new Set(planned.flatMap((p) => (p.bump !== null ? [p.bump] : [])));
    for (const who of audience) {
      if (who.id === authorId) continue;
      await this.store.readState.bump(who.id, thread, mentioned.has(who.id));
      if (mentioned.has(who.id)) this.core.signal(scopeOf(channel));
    }
    this.core.signal(scopeOf(channel));
  }

  /** An agent posts (its main loop, with its person's token). The channel's flags bind it; a mention of another agent waits for a later release. */
  async agentPost(o: LiveOrchestrator, channel: ChannelId, body: Record<string, unknown>): Promise<{ ok: true; message: ChannelMessage } | Fail> {
    const owner = this.ownerOf(o);
    if (channel === GROUP && owner === null) return fail(403, NO_PERSON);
    const flags = await this.flagsOf(channel, owner, o.ownerId);
    if (flags.disconnected) return fail(403, `${channelName(channel)} is disconnected for your agents. Your person reconnects it.`);
    if (flags.paused) return fail(409, `${channelName(channel)} is paused${flags.pausedForEveryone ? ' for everyone' : ' for your agents'}, so nothing can be posted until it is resumed.`);
    const limits = await this.core.limits();
    const checked = this.checkText(body.text, limits);
    if ('ok' in checked) return checked;
    const h = this.handle(channel, owner);
    // The rate limit comes first, so an agent that was not called in cannot make the paged lookup below as often as it likes (#1065).
    const limited = this.core.tooFast(`agent:${o.sessionId}`, limits);
    if (limited) return limited;
    // An agent answers a channel that called it in the last hour, the window it reads (#1065). It does not start a conversation nobody asked it to join.
    try {
      if (!(await this.calledInto(h, o, this.core.host.now() - AGENT_READ_WINDOW_MS))) return fail(403, NOT_CALLED);
    } catch (err) {
      return fail(400, (err as Error).message);
    }
    const text = this.core.redact(checked.raw);
    const replyTo = typeof body.replyTo === 'string' && body.replyTo ? body.replyTo : null;
    let parent: ChannelMessage | null = null;
    if (replyTo) {
      parent = await this.find(channel, owner, replyTo);
      if (!parent) return fail(404, 'There is no such message to reply to in this channel.');
    }
    const planned = await this.plan(parseMentions(text), channel, channel === 'group' ? owner : null, null, { ...limits, everyone: false }).catch(() => [] as Planned[]);
    const mentions = (Array.isArray(planned) ? planned : []).map((p) => (p.deliver ? { ...p.input, state: 'not-delivered' as const, why: NOT_YET } : p.input));
    const message = await h.post({ authorKind: 'orchestrator', authorRef: o.sessionId, authorName: o.name, text, replyTo, mentions });
    if (parent) {
      const state: MentionState = body.state === 'working' ? 'working' : 'done';
      for (const [i, m] of parent.mentions.entries()) {
        // Only a call the agent is working on moves: a reply never turns a mention that was not delivered (an agent's own @ of itself) into a call (#1051).
        if (mentionsAgent(m, o) && (m.state === 'waiting' || m.state === 'working')) await h.setMention(parent.id, i, { state });
      }
    }
    await this.afterPost(channel, channel === 'group' ? owner : null, null, Array.isArray(planned) ? planned : []);
    this.core.onEvent({ kind: 'sent', channel, owner: channel === 'group' ? oname(owner) : null, by: o.name, messageId: message.id, sessionId: o.sessionId });
    return { ok: true, message };
  }

  /** One message of a channel by id, looking back through the newest pages; null when it is not there (or is older than that). */
  private async find(channel: ChannelId, owner: PersonRef | null, id: string): Promise<ChannelMessage | null> {
    const h = this.handle(channel, owner);
    let before: string | null = null;
    for (let i = 0; i < HELD_PAGES; i++) {
      const page: ChannelPage = await h.page({ before, limit: HELD_PAGE });
      const hit = page.messages.find((m) => m.id === id);
      if (hit) return hit;
      if (!page.older) return null;
      before = page.older;
    }
    return null;
  }

  // ---- A person changes their own message (#1269) -------------------------------------------------------------------------

  /** The refusal for each reason the store gives; `locked` names the agent the message went to. */
  private refusal(why: ChangeRefusal, message: ChannelMessage | null): Promise<Fail> {
    return changeRefusal(why, CHANNEL_WORDS, () => (message ? lockedWords(message) : 'Podium has already sent this message to an agent, so it can no longer be changed.'));
  }

  /** Tells the consoles that a message changed, as a post does for its scope, and the Admin log: ids and where, never the text. */
  private changed(kind: 'message_edited' | 'message_deleted', viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null, messageId: string): void {
    this.core.onEvent({ kind, scope: 'channel', channel, owner: channel === GROUP ? oname(owner) : null, by: viewer.actor, messageId });
    this.core.signal(scopeOf(channel));
  }

  /** The copies of a message that waits for another person's approval, with the id each kept; `null` when one has none (stored before copies were kept), which cannot be reached. */
  private copiesOf(m: ChannelMessage): string[] | null {
    const waiting = m.mentions.filter((x) => x.state === 'approval');
    return waiting.every((x) => x.copyId) ? waiting.map((x) => x.copyId as string) : null;
  }

  /**
   * Changes every copy the message has for another person's owner, in the order of its mentions, BEFORE the channel's own row. The channel row is changed last because the
   * copies are what another person can still act on (approve), and they are the only part that can refuse for a reason the channel store cannot see: the owner approved, and the
   * agent was handed the text. If a copy refuses, the copies already changed are put back as far as an edit can be (an edit is written again with the old text); a delete cannot be
   * undone, so those copies stay withdrawn, and the mention of each moves to `dropped` through the answer the direct-message side already gives for a dropped copy. Nothing in the
   * channel row is changed in either case. Returns the refusal, or the copies changed (for `undo`).
   */
  private async changeCopies(viewer: ChatViewer, copies: string[], op: { kind: 'edit'; text: string; old: string } | { kind: 'delete' }): Promise<{ ok: true; done: string[] } | Fail> {
    const done: string[] = [];
    for (const copyId of copies) {
      const out = this.core.changeAcross ? await this.core.changeAcross(viewer, copyId, op.kind === 'edit' ? { kind: 'edit', text: op.text } : op) : fail(503, "Podium cannot reach the other person's copy of this message now.");
      if (!out.ok) {
        if (op.kind === 'edit') await this.restoreCopies(viewer, done, op.old);
        return out;
      }
      done.push(copyId);
    }
    return { ok: true, done };
  }

  /** Writes the old text back to copies that were edited, when the channel row then refused. Best effort: a copy that cannot be put back is reported to the server log. */
  private async restoreCopies(viewer: ChatViewer, copies: string[], text: string): Promise<void> {
    for (const copyId of copies) {
      const back = this.core.changeAcross ? await this.core.changeAcross(viewer, copyId, { kind: 'edit', text }) : null;
      if (!back?.ok) this.core.host.warn('the copy of an edited channel message could not be put back', new Error(back ? back.error : 'no bridge'));
    }
  }

  /** The author edits their own message: the new text goes through the checks of a new message, and it never delivers anything, so it may not add or remove an @mention. */
  editMessage(viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null, id: string, body: Record<string, unknown>): Promise<{ ok: true; message: ChannelMessage } | Fail> {
    return this.change(viewer, channel, owner, id, body);
  }

  /** The author deletes their own message: a tombstone stays, and a copy for another person's approval goes with it. */
  deleteMessage(viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null, id: string): Promise<{ ok: true; message: ChannelMessage } | Fail> {
    return this.change(viewer, channel, owner, id, null);
  }

  /**
   * An edit (`edit` is the request's body) or a delete (null) of the author's own message. The store decides who may and whether it is locked. A mention that waits for another
   * person's approval has a copy of the text for them: it is changed first (`changeCopies`), under that person's own length limit, and put back if the row then refuses an edit.
   */
  private async change(viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null, id: string, edit: Record<string, unknown> | null): Promise<{ ok: true; message: ChannelMessage } | Fail> {
    const gate = this.mayChange(viewer, channel, owner);
    if (gate) return gate;
    let text = '';
    if (edit) {
      const limits = await this.core.limits();
      const checked = this.checkText(edit.text, limits);
      if ('ok' in checked) return checked;
      const limited = this.core.tooFast(`person:${nameKey(viewer.name)}`, limits);
      if (limited) return limited;
      text = this.core.redact(checked.raw);
      // The text a post stores is what is left after cleaning, so a text of nothing but characters that draw nothing is as empty as a blank one.
      if (!text.trim()) return fail(400, 'The message is empty. Write the text to send.');
    }
    const h = this.handle(channel, owner);
    const found = id.length <= MAX_ID ? await h.getMessage(id) : null;
    if (!found) return this.refusal('not-found', null);
    let copies: string[] = [];
    // Only the author's own live, unlocked message gets these checks; for any other the store gives its refusal below.
    if (found.authorKind === 'person' && found.authorId === viewer.personId && found.deletedAt === null && !lockedByDelivery(found.mentions)) {
      const reachable = this.copiesOf(found);
      if (reachable === null) return fail(409, approvalWords(found) as string, 'approval');
      if (edit && !sameMentions(found.text, text)) return fail(422, 'To change who is mentioned, delete this message and send a new one.');
      copies = reachable;
    }
    const changed = await this.changeCopies(viewer, copies, edit ? { kind: 'edit', text, old: found.text } : { kind: 'delete' });
    if (!changed.ok) return changed;
    const by = { author: viewer.personId as number, now: this.core.host.now() };
    const out = edit ? await h.editMessage(id, { ...by, text }) : await h.deleteMessage(id, by);
    if (!out.ok) {
      // Only a race gets here (the checks above passed a moment ago). An edited copy is put back; a deleted one cannot be, so it stays withdrawn and its mention reads `dropped`, which is true of it.
      if (edit) await this.restoreCopies(viewer, changed.done, found.text);
      return this.refusal(out.reason, out.reason === 'locked' ? await h.getMessage(id) : null);
    }
    this.changed(edit ? 'message_edited' : 'message_deleted', viewer, channel, owner, id);
    return { ok: true, message: out.message };
  }

  /** The checks before a message is looked up: a signed-in person (the admin secret has no messages), and only in their own group. */
  private mayChange(viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null): Fail | null {
    if (viewer.personId === null) return fail(403, 'The admin secret has no messages of its own to change. Sign in with your own name.');
    if (channel === GROUP && (owner === null || owner.id !== viewer.personId)) return fail(403, 'Only the person who wrote a message can change it.');
    return null;
  }

  // ---- The stop buttons ------------------------------------------------------------------------------------------------

  /** Every held mention of a channel, oldest first; with `sessionId`, only those of that session. One query for the held ones, not a read of the channel's pages (#1046). */
  private async held(channel: ChannelId, owner: PersonRef | null, sessionId?: string): Promise<{ message: ChannelMessage; index: number }[]> {
    const messages = await this.handle(channel, owner).heldMentions(sessionId === undefined ? {} : { sessionId });
    return messages.flatMap((message) => message.mentions.flatMap((m, index) => (m.state === 'held' && (sessionId === undefined || m.sessionId === sessionId) ? [{ message, index }] : [])));
  }

  /** The live session a stored mention reaches: the one it named, else the one live session with the same peer key and name. */
  private retarget(m: ChannelMention): LiveOrchestrator | null {
    if (m.sessionId) {
      const o = this.liveOf(m.sessionId);
      if (o) return o;
    }
    const name = nameKey(m.typed.split('@')[0] ?? '');
    const same = this.live().filter((o) => o.reporterKey === m.peerKey && nameKey(o.name) === name);
    return same.length === 1 ? same[0]! : null;
  }

  /** Delivers what was held for a channel, in order. `only` limits it to the agents of one person. Returns how many reached an agent. */
  private async release(channel: ChannelId, owner: PersonRef | null, only: number | null): Promise<number> {
    let delivered = 0;
    const h = this.handle(channel, owner);
    const everyoneOn = (await this.core.limits()).everyone;
    for (const { message, index } of await this.held(channel, owner)) {
      const m = message.mentions[index]!;
      const target = this.retarget(m);
      if (!target) {
        await h.setMention(message.id, index, { state: 'dropped', why: 'the agent ended while the message was held' });
        continue;
      }
      if (only !== null && target.ownerId !== only) continue;
      if ((m.typed === 'group' || m.typed === 'everyone') && !everyoneOn) {
        await h.setMention(message.id, index, { state: 'not-delivered', why: `@${m.typed} was turned off by an Admin while the message was held` });
        continue;
      }
      const flags = await this.bindingFlags(channel, owner, target.ownerId);
      if (flags.paused) continue;
      if (flags.disconnected) {
        await h.setMention(message.id, index, { state: 'not-delivered', why: `${channelName(channel)} is disconnected for ${target.name}'s person` });
        continue;
      }
      // The state change comes first, so a message its author deleted since it was read is never handed over: the store answers null for a tombstone (#1269). It answers the message
      // as it is now, so the text handed over is the edited one. Once it is `waiting` the author can no longer change it.
      const claimed = await h.setMention(message.id, index, { state: 'waiting' });
      if (!claimed) continue;
      // The message goes out as its author's, not as the one who resumed the channel (an Admin resuming for everyone sent nothing, #1051).
      const sent = this.core.deliver(target.sessionId, claimed.authorName, target.name, `From Podium Chat, ${channelName(channel)}, ${claimed.authorName} wrote:\n${claimed.text}`, 'channel', false, target.peers === true ? channelName(channel) : null, claimed.authorId ?? null);
      if (sent.ok) {
        this.follow(channel, owner, message.id, index, sent.delivery.id, target.sessionId);
        delivered++;
      } else await h.setMention(message.id, index, { state: 'not-delivered', why: sent.error });
    }
    return delivered;
  }

  /** A target left the live set: the mentions held for it are dropped, unless another live session can take its place. */
  async sessionLeft(sessionId: string, owner: PersonRef | null): Promise<void> {
    // An agent with no person has no group, so only the public channels can hold a message held for it (#1284).
    for (const channel of [GROUP, ...(await this.publicIds())]) {
      if (channel === GROUP && owner === null) continue;
      const scope = channel === GROUP ? owner : null;
      const h = this.handle(channel, scope);
      for (const { message, index } of await this.held(channel, scope, sessionId)) {
        const m = message.mentions[index]!;
        if (this.retarget(m)) continue;
        await h.setMention(message.id, index, { state: 'dropped', why: 'the agent ended while the message was held' });
        this.core.signal(scopeOf(channel));
      }
    }
  }

  /** Pause or resume. `everyone` is General for all agents (an Admin); otherwise it is the person's own agents, or the group. */
  async setPaused(viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null, paused: boolean, everyone: boolean): Promise<(ChannelState & { ok: true; delivered: number }) | Fail> {
    if (everyone && (channel === GROUP || !viewer.admin)) return fail(403, `Only an Admin can pause ${channel === GROUP ? 'General' : channelName(channel)} for everyone.`);
    const scope = this.scopeKey(viewer, channel, owner, everyone);
    if ('ok' in scope) return scope;
    const before = await this.store.settings.flags(scope.key);
    // An Admin's pause is named and stays theirs: the person it binds cannot lift it, and pausing again does not take it over.
    const mine = scope.owner !== null && scope.owner.id === viewer.personId;
    if (before.pausedByAdmin && !viewer.admin) return paused ? { ok: true, delivered: 0, ...(await this.flagsOf(channel, owner, viewer.personId)) } : fail(403, `${before.pausedByAdmin}, an Administrator, paused this, so only an Administrator can resume it.`);
    const byAdmin = paused && viewer.admin && (everyone || !mine) ? viewer.actor : undefined;
    // The record and the Admin log come first, then the stop (#1051): a stop that could not be recorded is not done, and one that fails midway is already on both.
    // An Admin's stop on what is not theirs stays on the record, and the people it stops are told (#1034).
    if (viewer.admin && before.paused !== paused && (everyone || (channel === 'group' && !mine))) await this.reads.stopped(viewer, this.threadOf(channel, owner), paused ? 'paused' : 'resumed', this.stopTells(channel, owner, everyone ? `${channelName(channel)} for everyone` : 'your Podium group'), this.peopleOf(channel, owner));
    this.core.onEvent({ kind: paused ? 'paused' : 'resumed', channel, owner: oname(scope.owner), by: viewer.actor, everyone, count: 0 });
    await this.store.settings.setFlags(scope.key, { paused, ...(byAdmin ? { pausedByAdmin: byAdmin } : {}) });
    let delivered = 0;
    if (!paused && before.paused) delivered = await this.release(channel, owner, everyone || channel === 'group' ? null : viewer.personId);
    this.core.signal(scopeOf(channel));
    const state = await this.flagsOf(channel, owner, viewer.personId);
    return { ok: true, delivered, ...state };
  }

  async setDisconnected(viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null, disconnected: boolean): Promise<(ChannelState & { ok: true }) | Fail> {
    const scope = this.scopeKey(viewer, channel, owner, false);
    if ('ok' in scope) return scope;
    // An Admin's disconnect of a group that is not theirs stays on the record, and the group's person is told (#1034). Recorded and logged before it is done (#1051).
    const aboutGroup = channel === 'group' && scope.owner !== null && scope.owner.id !== viewer.personId;
    if (viewer.admin && aboutGroup) await this.reads.stopped(viewer, this.threadOf(channel, owner), disconnected ? 'disconnected' : 'reconnected', this.stopTells(channel, owner, 'your Podium group'), this.peopleOf(channel, owner));
    this.core.onEvent({ kind: disconnected ? 'disconnected' : 'reconnected', channel, owner: oname(scope.owner), by: viewer.actor, everyone: false, count: 0 });
    await this.store.settings.setFlags(scope.key, { disconnected });
    this.core.signal(scopeOf(channel));
    return { ok: true, ...(await this.flagsOf(channel, owner, viewer.personId)) };
  }

  private scopeKey(viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null, everyone: boolean): { key: string; owner: PersonRef | null } | Fail {
    if (channel === GROUP) return { key: groupScope((owner as PersonRef).id), owner };
    if (everyone) return { key: channelGlobalScope(channel), owner: null };
    if (viewer.personId === null) return fail(400, `The admin secret has no agents of its own to pause or disconnect. Pause ${channelName(channel)} for everyone instead.`);
    return { key: channelPersonScope(channel, viewer.personId), owner: { id: viewer.personId, name: viewer.name } };
  }

  /** Who is owed a look at an Admin's stop: the group's person. General's stop is for everyone and is shown on General, so it is owed to no one in particular. */
  private peopleOf(channel: ChannelId, owner: PersonRef | null): number[] {
    return channel === 'group' && owner !== null ? [owner.id] : [];
  }

  /** Who is told of an Admin's stop: the group's person's sessions, or every session for General. */
  private stopTells(channel: ChannelId, owner: PersonRef | null, about: string): Told[] {
    return this.reads.sessionsOf(channel === 'group' ? (owner?.id ?? null) : null).map((sessionId) => ({ sessionId, about }));
  }

  /**
   * Remove all messages: a group's person or an Admin, General's Admin. The messages go; the record of who read the thread does not, and an Admin's removal
   * of what is not theirs is added to it (#1034).
   */
  async clear(viewer: ChatViewer, channel: ChannelId, owner: PersonRef | null): Promise<{ ok: true; removed: number } | Fail> {
    if (isPublicChannel(channel) && !viewer.admin) return fail(403, `Only an Admin can remove the messages of ${channelName(channel)}.`);
    const h = this.handle(channel, owner);
    // Recorded and logged first (#1051): an Admin's removal that could not be recorded is not done. The count is what is there to remove.
    if (viewer.admin && (isPublicChannel(channel) || (owner as PersonRef).id !== viewer.personId)) await this.reads.stopped(viewer, this.threadOf(channel, owner), 'cleared', this.stopTells(channel, owner, channel === GROUP ? 'your Podium group' : channelName(channel)), this.peopleOf(channel, owner));
    this.core.onEvent({ kind: 'cleared', channel, owner: oname(owner), by: viewer.actor, everyone: false, count: await h.count() });
    const removed = await h.clear();
    await this.store.readState.forget(this.threadOf(channel, owner));
    this.core.signal(scopeOf(channel));
    return { ok: true, removed };
  }

  /** Retention: the group channel and the public audience (General and every public channel) lose what is older than the Admin's days. */
  async purge(olderThan: number): Promise<number> {
    return (await this.store.group.purge(olderThan)) + (await this.store.public.purge(olderThan));
  }
}
