// The channel side of Chat (#1034): General and My group. Posting, reading, `@` addressing and its delivery, and the stop buttons (Pause,
// Disconnect, Remove all). This file never reads a direct message: a channel's text and a conversation's text are kept in different tables and
// read by different code, and `chatSeparation.test.ts` holds this file to it.
import { nameKey } from '../storage/rows.js';
import { peerShortId, type LiveOrchestrator } from './peerTypes.js';
import type { ChannelFlags, ChannelMention, ChannelMessage, ChannelPage, ChannelPostInput, ChatAuthorKind, GroupScope, MentionState } from '../storage/types.js';
import { parseMentions, type ParsedMention } from './chatMentions.js';
import { ChatCore, type AcrossUpdate, type ChatLimits, type DeliveryOutcome } from './chatCore.js';
import {
  CHANNEL_NAMES, GLOBAL_SCOPE, fail, groupScope, groupThread, personScope, publicThread, type ChannelId, type ChatViewer, type Fail,
} from './chatTypes.js';

/** How far back a held mention is looked for when a channel resumes: 10 pages of 100, far more than a person pauses over. */
const HELD_PAGES = 10;
const HELD_PAGE = 100;
/** A read for an agent is cut at about this many characters; the cursor gets the rest. */
export const AGENT_READ_CHARS = 30_000;
const NOT_YET = 'Agents addressing each other in a channel arrive in a later release, so this was not delivered.';

export interface MentionView {
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
  text: string;
  createdAt: number;
  updatedAt: number;
  replyTo: string | null;
  issue: string | null;
  project: string | null;
  milestone: string | null;
  mine: boolean;
  mentions: MentionView[];
}

export function messageView(m: ChannelMessage, viewer: string | null): ChannelMessageView {
  return {
    id: m.id,
    authorKind: m.authorKind,
    authorName: m.authorName,
    authorRef: m.authorRef,
    text: m.text,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    replyTo: m.replyTo,
    issue: m.issue,
    project: m.project,
    milestone: m.milestone,
    mine: m.authorKind === 'person' && viewer !== null && nameKey(m.authorRef) === nameKey(viewer),
    mentions: m.mentions.map((x) => ({ typed: x.typed, sessionId: x.sessionId, state: x.state, why: x.why, stateAt: x.stateAt })),
  };
}

/** The flags a channel is under for the person it concerns: the group's own, or General's for everyone and for one person's agents. */
export interface ChannelState {
  paused: boolean;
  pausedForEveryone: boolean;
  disconnected: boolean;
}

type Planned = { input: NonNullable<ChannelPostInput['mentions']>[number]; bump: string | null; deliver: LiveOrchestrator | null };

export class ChannelChat {
  constructor(private readonly core: ChatCore) {}

  private get store() {
    return this.core.store;
  }

  private live(): LiveOrchestrator[] {
    return this.core.host.liveIds().flatMap((id) => {
      const o = this.core.host.peers.messages.live(id);
      return o ? [o] : [];
    });
  }

  private liveOf(sessionId: string): LiveOrchestrator | null {
    return this.core.host.isLive(sessionId) ? this.core.host.peers.messages.live(sessionId) : null;
  }

  // ---- The store behind a channel ----------------------------------------------------------------------------------

  private handle(channel: ChannelId, owner: string | null) {
    const st = this.store;
    if (channel === 'group') {
      const g: GroupScope = { owner: owner as string, groupId: nameKey(owner as string) };
      return {
        post: (i: ChannelPostInput) => st.group.post(g, i),
        page: (o: { before?: string | null; limit: number }) => st.group.page(g, o),
        setMention: (id: string, index: number, patch: { state: MentionState; why?: string | null }) => st.group.setMention(g, id, index, patch),
        clear: () => st.group.clear(g),
        count: () => st.group.count(g),
      };
    }
    return {
      post: (i: ChannelPostInput) => st.public.post(i),
      page: (o: { before?: string | null; limit: number }) => st.public.page(o),
      setMention: (id: string, index: number, patch: { state: MentionState; why?: string | null }) => st.public.setMention(id, index, patch),
      clear: () => st.public.clear(),
      count: () => st.public.count(),
    };
  }

  private threadOf(channel: ChannelId, owner: string | null): string {
    return channel === 'group' ? groupThread(owner as string) : publicThread;
  }

  /** The channel a request is about: the group of the person asking, or the owner an Admin names. Fails when there is none to use. */
  scopeFor(viewer: ChatViewer, channel: ChannelId, named: string | null | undefined): { owner: string | null } | Fail {
    if (channel === 'general') return { owner: null };
    if (named && nameKey(named) !== nameKey(viewer.name)) {
      if (!viewer.admin) return fail(403, 'Only its person and an Admin can use a group.');
      return { owner: nameKey(named) };
    }
    if (viewer.personId === null) return fail(viewer.admin ? 400 : 403, 'The admin secret has no group of its own. Name the person whose group you mean.');
    return { owner: nameKey(viewer.name) };
  }

  // ---- Flags ---------------------------------------------------------------------------------------------------------

  async flagsOf(channel: ChannelId, owner: string | null, person: string | null): Promise<ChannelState> {
    const f = this.store.settings;
    if (channel === 'group') {
      const g = await f.flags(groupScope(owner as string));
      return { paused: g.paused, pausedForEveryone: false, disconnected: g.disconnected };
    }
    const all = await f.flags(GLOBAL_SCOPE);
    const mine: ChannelFlags = person ? await f.flags(personScope(person)) : { paused: false, disconnected: false };
    return { paused: all.paused || mine.paused, pausedForEveryone: all.paused, disconnected: mine.disconnected };
  }

  /** The flags that bind a message to an agent of `agentOwner` in `channel`. */
  private async bindingFlags(channel: ChannelId, groupOwner: string | null, agentOwner: string): Promise<ChannelState> {
    return channel === 'group' ? this.flagsOf('group', groupOwner, null) : this.flagsOf('general', null, agentOwner);
  }

  // ---- Reading -------------------------------------------------------------------------------------------------------

  async page(viewer: ChatViewer, channel: ChannelId, owner: string | null, opts: { before?: string | null; limit: number }): Promise<{ page: ChannelPage; total: number } | Fail> {
    const h = this.handle(channel, owner);
    try {
      return { page: await h.page(opts), total: await h.count() };
    } catch (err) {
      return fail(400, (err as Error).message);
    }
  }

  async total(channel: ChannelId, owner: string | null): Promise<number> {
    return this.handle(channel, owner).count();
  }

  /** The newest messages that fit in about 30,000 characters, and the cursor for the ones before them. */
  async agentRead(o: LiveOrchestrator, channel: ChannelId, before: string | null): Promise<{ messages: ChannelMessage[]; older: string | null } | Fail> {
    const flags = await this.flagsOf(channel, nameKey(o.owner), nameKey(o.owner));
    if (flags.disconnected) return fail(403, `${CHANNEL_NAMES[channel]} is disconnected for your agents. Your person reconnects it.`);
    const h = this.handle(channel, nameKey(o.owner));
    try {
      let page = await h.page({ before, limit: 50 });
      let used = 0;
      let keep = 0;
      for (let i = page.messages.length - 1; i >= 0; i--) {
        used += page.messages[i]!.text.length;
        if (used > AGENT_READ_CHARS && keep > 0) break;
        keep++;
      }
      if (keep < page.messages.length) page = await h.page({ before, limit: keep });
      return { messages: page.messages, older: page.older };
    } catch (err) {
      return fail(400, (err as Error).message);
    }
  }

  // ---- Posting ---------------------------------------------------------------------------------------------------------

  private checkText(raw: unknown, limits: ChatLimits): { text: string } | Fail {
    if (typeof raw !== 'string' || !raw.trim()) return fail(400, 'The message is empty. Write the text to send.');
    if (raw.length > limits.maxChars) return fail(422, `The message is ${raw.length.toLocaleString('en-US')} characters, over the limit of ${limits.maxChars.toLocaleString('en-US')}. Send a shorter one.`);
    return { text: this.core.redact(raw) };
  }

  private busy(who: string, limits: ChatLimits): Fail | null {
    const wait = this.core.rate(who, limits.perMinute);
    return wait === null ? null : fail(429, `That is more than ${limits.perMinute} messages a minute, the limit here. Try again in ${wait} seconds.`);
  }

  /** The agents and people a typed `@` can mean in this channel, for the address list and for resolving a mention. */
  async addressBook(channel: ChannelId, owner: string | null): Promise<{ typed: string; label: string; role: 'orchestrator' | 'person' | 'group' | 'everyone'; sessionId: string | null; disabled?: boolean; why?: string }[]> {
    const out: { typed: string; label: string; role: 'orchestrator' | 'person' | 'group' | 'everyone'; sessionId: string | null; disabled?: boolean; why?: string }[] = [];
    const agents = this.live().filter((o) => channel === 'general' || nameKey(o.owner) === owner);
    for (const o of agents.sort((a, b) => `${a.name}@${a.machine}`.localeCompare(`${b.name}@${b.machine}`))) out.push({ typed: `${o.name}@${o.machine}`, label: 'Orchestrator', role: 'orchestrator', sessionId: o.sessionId });
    for (const p of await this.core.persons()) if (channel === 'general' || p.key === owner) out.push({ typed: `${p.name}@console`, label: 'Person', role: 'person', sessionId: null });
    const everyone = (await this.core.limits()).everyone;
    const off = { disabled: true, why: 'Off. An Admin turns it on in Admin > Settings.' };
    out.push({ typed: 'group', label: 'Everyone in My group', role: 'group', sessionId: null, ...(everyone ? {} : off) });
    out.push({ typed: 'everyone', label: 'Everyone signed in', role: 'everyone', sessionId: null, ...(everyone ? {} : off) });
    return out;
  }

  /** Works out each typed mention. Fails (nothing stored) for an `@group` or `@everyone` that is off, and for a name two agents share. */
  private async plan(parsed: ParsedMention[], channel: ChannelId, owner: string | null, author: ChatViewer | null, limits: ChatLimits): Promise<Planned[] | Fail> {
    const people = await this.core.everyone();
    const agents = this.live().filter((o) => channel === 'general' || nameKey(o.owner) === owner);
    const out: Planned[] = [];
    const add = (p: Planned): void => void out.push(p);
    const person = (name: string): boolean => people.includes(nameKey(name));
    if (!limits.everyone && parsed.some((m) => m.kind === 'group' || m.kind === 'everyone')) {
      return fail(422, '@group and @everyone are off, so nothing was sent. An Admin turns them on in Admin > Settings. Address one agent as name@location instead.');
    }
    for (const m of parsed) {
      if (m.kind === 'group' || m.kind === 'everyone') {
        // Both reach the sender's own orchestrators; @everyone also gives every person a mention badge.
        const mine = this.live().filter((o) => !author || nameKey(o.owner) === nameKey(author.name));
        for (const o of mine) add({ input: { sessionId: o.sessionId, peerKey: o.reporterKey, typed: m.typed }, bump: null, deliver: o });
        if (m.kind === 'everyone') for (const n of people) add({ input: { sessionId: null, peerKey: null, typed: `${n}@console`, state: 'done', why: 'notified' }, bump: n, deliver: null });
        continue;
      }
      const wantName = nameKey(m.name);
      const here = m.kind === 'address' ? agents.filter((o) => nameKey(o.name) === wantName && nameKey(o.machine) === nameKey(m.location)) : agents.filter((o) => nameKey(o.name) === wantName);
      const matches = m.kind === 'address' && m.id ? here.filter((o) => o.sessionId.toLowerCase().startsWith((m.id as string).toLowerCase())) : here;
      if (m.kind === 'address' && nameKey(m.location) === 'console') {
        if (person(m.name) && (channel === 'general' || nameKey(m.name) === owner)) add({ input: { sessionId: null, peerKey: null, typed: m.typed, state: 'done', why: 'notified' }, bump: wantName, deliver: null });
        else add({ input: { sessionId: null, peerKey: null, typed: m.typed, state: 'not-delivered', why: channel === 'group' ? `${m.name} is not in this group` : `there is no person called ${m.name}` }, bump: null, deliver: null });
        continue;
      }
      const personHit = m.kind === 'plain' && person(m.name) && (channel === 'general' || wantName === owner);
      const total = matches.length + (personHit ? 1 : 0);
      if (m.kind === 'plain' && total === 0) continue; // an @ with a word after it that names nobody is only text
      if (total > 1) {
        const list = [...matches.map((o) => `${o.name}@${o.machine}${here.length > 1 ? `#${peerShortId(o.sessionId)}` : ''}`), ...(personHit ? [`${m.name}@console`] : [])];
        return fail(409, `More than one agent or person is called ${m.kind === 'address' ? `${m.name}@${m.location}` : m.name}, so Podium cannot tell which you mean. Address one as ${list.join(', ')}.`);
      }
      const o = matches[0];
      if (o) add({ input: { sessionId: o.sessionId, peerKey: o.reporterKey, typed: m.typed }, bump: null, deliver: o });
      else if (personHit) add({ input: { sessionId: null, peerKey: null, typed: `${m.name}@console`, state: 'done', why: 'notified' }, bump: wantName, deliver: null });
      else add({ input: { sessionId: null, peerKey: null, typed: m.typed, state: 'not-delivered', why: `no live agent called ${m.name} on ${m.kind === 'address' ? m.location : 'any machine'}` }, bump: null, deliver: null });
    }
    return out;
  }

  /** A person posts. Returns the stored message and anything the person should hear about (a mention that could not be delivered). */
  async post(viewer: ChatViewer, channel: ChannelId, owner: string | null, body: Record<string, unknown>): Promise<{ ok: true; message: ChannelMessage; warnings: string[] } | Fail> {
    const limits = await this.core.limits();
    const checked = this.checkText(body.text, limits);
    if ('ok' in checked) return checked;
    const limited = this.busy(`person:${nameKey(viewer.name)}`, limits);
    if (limited) return limited;
    const parsed = parseMentions(checked.text);
    const planned = await this.plan(parsed, channel, owner, viewer, limits);
    if ('ok' in planned) return planned;
    const warnings: string[] = [];
    const framed = `From Podium Chat, ${CHANNEL_NAMES[channel]}, ${viewer.name} wrote:\n${checked.text}`;
    const inputs: NonNullable<ChannelPostInput['mentions']> = [];
    const sentTo = new Map<number, { sessionId: string; deliveryId: string }>();
    // An @ of another person's agent (#1034) is a request for that agent's owner. It is made after the message is stored, so a message that fails to store leaves no request behind.
    const across: { index: number; o: LiveOrchestrator }[] = [];
    for (const p of planned) {
      let input = p.input;
      const o = p.deliver;
      if (o) {
        const flags = await this.bindingFlags(channel, owner, o.owner);
        // Another person's agent needs that person's say-so from everyone, an Administrator included (#1034). An Admin keeps read and stop powers only.
        if (nameKey(o.owner) !== nameKey(viewer.name)) {
          if (viewer.personId === null) {
            input = { ...input, state: 'not-delivered', why: `The admin secret has no person name, so Podium cannot ask ${o.owner} for you. Sign in with your own name to message ${o.name}.` };
            warnings.push(`${o.name}: ${input.why}`);
          } else if (flags.disconnected) input = { ...input, state: 'not-delivered', why: `${CHANNEL_NAMES[channel]} is disconnected for ${o.name}'s person` };
          else if (flags.paused) input = { ...input, state: 'not-delivered', why: `${CHANNEL_NAMES[channel]} is paused for ${o.name}'s person, so Podium did not ask them` };
          else {
            across.push({ index: inputs.length, o });
            input = { ...input, state: 'approval', why: `Waiting for ${o.owner} to approve` };
          }
        } else if (flags.disconnected) input = { ...input, state: 'not-delivered', why: `${CHANNEL_NAMES[channel]} is disconnected for ${o.name}'s person` };
        else if (flags.paused) input = { ...input, state: 'held', why: `${CHANNEL_NAMES[channel]} is paused` };
        else {
          const sent = this.core.deliver(o.sessionId, viewer.name, o.name, framed);
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
        text: checked.text,
        replyTo: typeof body.replyTo === 'string' ? body.replyTo : null,
        issue: typeof body.issue === 'string' ? body.issue : null,
        project: typeof body.project === 'string' ? body.project : null,
        milestone: typeof body.milestone === 'string' ? body.milestone : null,
        mentions: inputs,
      });
    } catch (err) {
      for (const sent of sentTo.values()) this.core.host.respond.discard(sent.deliveryId, viewer.name, true);
      return fail(400, (err as Error).message);
    }
    for (const [index, sent] of sentTo) this.follow(channel, owner, message.id, index, sent.deliveryId, sent.sessionId);
    for (const x of across) await this.askAcross(viewer, channel, owner, message, x, checked.text, warnings);
    await this.afterPost(channel, owner, viewer.name, planned);
    this.core.onEvent({ kind: 'sent', channel, owner, by: viewer.actor, messageId: message.id, sessionId: null });
    return { ok: true, message, warnings };
  }

  /** Asks the agent's owner, through the direct-message side, and moves the mention the person wrote to what came of it. */
  private async askAcross(viewer: ChatViewer, channel: ChannelId, owner: string | null, message: ChannelMessage, x: { index: number; o: LiveOrchestrator }, text: string, warnings: string[]): Promise<void> {
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
    }
  }

  /** What became of a person's message to another person's agent (#1034): the oldest mention of that agent in General by that person, in one of the states it may move from, moves. */
  async acrossUpdate(u: AcrossUpdate): Promise<void> {
    const h = this.handle('general', null);
    let before: string | null = null;
    const found: { message: ChannelMessage; index: number }[] = [];
    for (let i = 0; i < HELD_PAGES; i++) {
      const page: ChannelPage = await h.page({ before, limit: HELD_PAGE });
      found.unshift(...page.messages.flatMap((message) => (message.authorKind === 'person' && nameKey(message.authorRef) === u.person ? message.mentions.flatMap((m, index) => (m.sessionId === u.sessionId && u.from.includes(m.state) ? [{ message, index }] : [])) : [])));
      if (!page.older) break;
      before = page.older;
    }
    const hit = found[0];
    if (!hit) return;
    await h.setMention(hit.message.id, hit.index, { state: u.state, why: u.why });
    this.core.signal({ scope: 'public', owner: null });
  }

  /** What becomes of a delivered mention moves its state: taken is working, refused is not delivered, a drop is dropped. */
  private follow(channel: ChannelId, owner: string | null, messageId: string, index: number, deliveryId: string, sessionId: string): void {
    this.core.watch(deliveryId, (o) => {
      const patch = o.kind === 'took' ? { state: 'working' as const } : o.kind === 'queued' ? null : o.kind === 'dropped' ? { state: 'dropped' as const, why: o.why } : { state: 'not-delivered' as const, why: o.why };
      if (!patch) return;
      void this.handle(channel, owner)
        .setMention(messageId, index, patch)
        .then(() => {
          this.core.onEvent({ kind: o.kind === 'took' ? 'delivered' : 'dropped', channel, owner, by: 'server', messageId, sessionId, ...(o.kind === 'took' ? {} : { why: 'why' in o ? o.why : undefined }) });
          this.core.signal({ scope: channel === 'group' ? 'group' : 'public', owner: channel === 'group' ? owner : null });
        })
        .catch((err: unknown) => this.core.host.warn('a mention in Chat could not be updated', err));
    });
  }

  /** The counts a post changes, and the stream signal. A person's own post never counts against them. */
  private async afterPost(channel: ChannelId, owner: string | null, authorName: string | null, planned: Planned[]): Promise<void> {
    const thread = this.threadOf(channel, owner);
    const author = authorName === null ? null : nameKey(authorName);
    const audience = channel === 'group' ? (owner ? [owner] : []) : await this.core.everyone();
    const mentioned = new Set(planned.flatMap((p) => (p.bump ? [p.bump] : [])));
    for (const who of audience) {
      if (who === author) continue;
      const row = await this.store.readState.bump(who, thread, mentioned.has(who));
      if (mentioned.has(who)) this.core.signal({ scope: channel === 'group' ? 'group' : 'public', owner: who, unread: row.unread, mentions: row.mentions });
    }
    this.core.signal({ scope: channel === 'group' ? 'group' : 'public', owner: channel === 'group' ? owner : null });
  }

  /** An agent posts (its main loop, with its person's token). The channel's flags bind it; a mention of another agent waits for a later release. */
  async agentPost(o: LiveOrchestrator, channel: ChannelId, body: Record<string, unknown>): Promise<{ ok: true; message: ChannelMessage } | Fail> {
    const owner = nameKey(o.owner);
    const flags = await this.flagsOf(channel, owner, owner);
    if (flags.disconnected) return fail(403, `${CHANNEL_NAMES[channel]} is disconnected for your agents. Your person reconnects it.`);
    if (flags.paused) return fail(409, `${CHANNEL_NAMES[channel]} is paused${flags.pausedForEveryone ? ' for everyone' : ' for your agents'}, so nothing can be posted until it is resumed.`);
    const limits = await this.core.limits();
    const checked = this.checkText(body.text, limits);
    if ('ok' in checked) return checked;
    const limited = this.busy(`agent:${o.sessionId}`, limits);
    if (limited) return limited;
    const h = this.handle(channel, owner);
    const replyTo = typeof body.replyTo === 'string' && body.replyTo ? body.replyTo : null;
    let parent: ChannelMessage | null = null;
    if (replyTo) {
      parent = await this.find(channel, owner, replyTo);
      if (!parent) return fail(404, 'There is no such message to reply to in this channel.');
    }
    const planned = await this.plan(parseMentions(checked.text), channel, channel === 'group' ? owner : null, null, { ...limits, everyone: false }).catch(() => [] as Planned[]);
    const mentions = (Array.isArray(planned) ? planned : []).map((p) => (p.deliver ? { ...p.input, state: 'not-delivered' as const, why: NOT_YET } : p.input));
    const message = await h.post({ authorKind: 'orchestrator', authorRef: o.sessionId, authorName: o.name, text: checked.text, replyTo, mentions });
    if (parent) {
      const state: MentionState = body.state === 'working' ? 'working' : 'done';
      for (const [i, m] of parent.mentions.entries()) {
        if (m.sessionId === o.sessionId || (m.peerKey === o.reporterKey && nameKey(m.typed.split('@')[0] ?? '') === nameKey(o.name))) await h.setMention(parent.id, i, { state });
      }
    }
    await this.afterPost(channel, channel === 'group' ? owner : null, null, Array.isArray(planned) ? planned : []);
    this.core.onEvent({ kind: 'sent', channel, owner: channel === 'group' ? owner : null, by: o.name, messageId: message.id, sessionId: o.sessionId });
    return { ok: true, message };
  }

  /** One message of a channel by id, looking back through the newest pages; null when it is not there (or is older than that). */
  private async find(channel: ChannelId, owner: string | null, id: string): Promise<ChannelMessage | null> {
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

  // ---- The stop buttons ------------------------------------------------------------------------------------------------

  /** Every held mention of a channel, oldest first. */
  private async held(channel: ChannelId, owner: string | null): Promise<{ message: ChannelMessage; index: number }[]> {
    const h = this.handle(channel, owner);
    const found: { message: ChannelMessage; index: number }[] = [];
    let before: string | null = null;
    for (let i = 0; i < HELD_PAGES; i++) {
      const page: ChannelPage = await h.page({ before, limit: HELD_PAGE });
      // Pages come newest first and each page is oldest first, so an older page goes in front.
      found.unshift(...page.messages.flatMap((message) => message.mentions.flatMap((m, index) => (m.state === 'held' ? [{ message, index }] : []))));
      if (!page.older) break;
      before = page.older;
    }
    return found;
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
  private async release(channel: ChannelId, owner: string | null, only: string | null, byName: string): Promise<number> {
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
      if (only !== null && nameKey(target.owner) !== only) continue;
      if ((m.typed === 'group' || m.typed === 'everyone') && !everyoneOn) {
        await h.setMention(message.id, index, { state: 'not-delivered', why: `@${m.typed} was turned off by an Admin while the message was held` });
        continue;
      }
      const flags = await this.bindingFlags(channel, owner, target.owner);
      if (flags.paused) continue;
      if (flags.disconnected) {
        await h.setMention(message.id, index, { state: 'not-delivered', why: `${CHANNEL_NAMES[channel]} is disconnected for ${target.name}'s person` });
        continue;
      }
      const sent = this.core.deliver(target.sessionId, byName, target.name, `From Podium Chat, ${CHANNEL_NAMES[channel]}, ${message.authorName} wrote:\n${message.text}`);
      if (sent.ok) {
        await h.setMention(message.id, index, { state: 'waiting' });
        this.follow(channel, owner, message.id, index, sent.delivery.id, target.sessionId);
        delivered++;
      } else await h.setMention(message.id, index, { state: 'not-delivered', why: sent.error });
    }
    return delivered;
  }

  /** A target left the live set: the mentions held for it are dropped, unless another live session can take its place. */
  async sessionLeft(sessionId: string, owner: string): Promise<void> {
    const key = nameKey(owner);
    for (const channel of ['group', 'general'] as const) {
      const scope = channel === 'group' ? key : null;
      const h = this.handle(channel, scope);
      for (const { message, index } of await this.held(channel, scope)) {
        const m = message.mentions[index]!;
        if (m.sessionId !== sessionId || this.retarget(m)) continue;
        await h.setMention(message.id, index, { state: 'dropped', why: 'the agent ended while the message was held' });
        this.core.signal({ scope: channel === 'group' ? 'group' : 'public', owner: scope });
      }
    }
  }

  /** Pause or resume. `everyone` is General for all agents (an Admin); otherwise it is the person's own agents, or the group. */
  async setPaused(viewer: ChatViewer, channel: ChannelId, owner: string | null, paused: boolean, everyone: boolean): Promise<(ChannelState & { ok: true; delivered: number }) | Fail> {
    if (everyone && (channel !== 'general' || !viewer.admin)) return fail(403, 'Only an Admin can pause General for everyone.');
    const scope = this.scopeKey(viewer, channel, owner, everyone);
    if ('ok' in scope) return scope;
    const before = await this.store.settings.flags(scope.key);
    await this.store.settings.setFlags(scope.key, { paused });
    let delivered = 0;
    if (!paused && before.paused) delivered = await this.release(channel, owner, everyone || channel === 'group' ? null : nameKey(viewer.name), viewer.name);
    this.core.onEvent({ kind: paused ? 'paused' : 'resumed', channel, owner: scope.owner, by: viewer.actor, everyone, count: delivered });
    this.core.signal({ scope: channel === 'group' ? 'group' : 'public', owner: channel === 'group' ? owner : null });
    const state = await this.flagsOf(channel, owner, viewer.personId === null ? null : nameKey(viewer.name));
    return { ok: true, delivered, ...state };
  }

  async setDisconnected(viewer: ChatViewer, channel: ChannelId, owner: string | null, disconnected: boolean): Promise<(ChannelState & { ok: true }) | Fail> {
    const scope = this.scopeKey(viewer, channel, owner, false);
    if ('ok' in scope) return scope;
    await this.store.settings.setFlags(scope.key, { disconnected });
    this.core.onEvent({ kind: disconnected ? 'disconnected' : 'reconnected', channel, owner: scope.owner, by: viewer.actor, everyone: false, count: 0 });
    this.core.signal({ scope: channel === 'group' ? 'group' : 'public', owner: channel === 'group' ? owner : null });
    return { ok: true, ...(await this.flagsOf(channel, owner, viewer.personId === null ? null : nameKey(viewer.name))) };
  }

  private scopeKey(viewer: ChatViewer, channel: ChannelId, owner: string | null, everyone: boolean): { key: string; owner: string | null } | Fail {
    if (channel === 'group') return { key: groupScope(owner as string), owner };
    if (everyone) return { key: GLOBAL_SCOPE, owner: null };
    if (viewer.personId === null) return fail(400, 'The admin secret has no agents of its own to pause or disconnect. Pause General for everyone instead.');
    return { key: personScope(viewer.name), owner: nameKey(viewer.name) };
  }

  /** Remove all messages: a group's person or an Admin, General's Admin. */
  async clear(viewer: ChatViewer, channel: ChannelId, owner: string | null): Promise<{ ok: true; removed: number } | Fail> {
    if (channel === 'general' && !viewer.admin) return fail(403, 'Only an Admin can remove the messages of General.');
    const removed = await this.handle(channel, owner).clear();
    await this.store.readState.forget(this.threadOf(channel, owner));
    this.core.onEvent({ kind: 'cleared', channel, owner, by: viewer.actor, everyone: false, count: removed });
    this.core.signal({ scope: channel === 'group' ? 'group' : 'public', owner: channel === 'group' ? owner : null });
    return { ok: true, removed };
  }

  /** Retention: both channels lose what is older than the Admin's days. */
  async purge(olderThan: number): Promise<number> {
    return (await this.store.group.purge(olderThan)) + (await this.store.public.purge(olderThan));
  }
}
