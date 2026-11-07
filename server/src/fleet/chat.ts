// Chat (#1034): the service the fleet owns. It puts the channel side and the direct-message side behind one object, keeps the counts, answers the
// overview the Chat page opens with, and runs the two housekeeping jobs (a conversation hiding and returning as its agents leave and come back, and the
// retention purge). The two sides stay apart on purpose: see `chatChannels.ts` and `chatDirect.ts`.
import { nameKey } from '../storage/rows.js';
import type { AdminReadRow, ChatSettingsApi, ChatStoreApi } from '../storage/types.js';
import { ACT_PREFIX } from './adminActs.js';
import { AdminReads, LIST_PHRASE, listThread } from './chatAdminReads.js';
import type { AdminNotice } from './chatAdminNotices.js';
import { ChannelChat } from './chatChannels.js';
import { ChatCore } from './chatCore.js';
import { DirectChat, type DirectInfo } from './chatDirect.js';
import type { MessageTrail } from './peerTypes.js';
import { CHANNEL_NAMES, fail, isPersonId, personId, type AdminReading, groupThread, publicThread, type ChatEvent, type ChatHost, type ChatViewer, type Fail } from './chatTypes.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface ChannelInfo {
  id: 'general' | 'group';
  name: string;
  thread: string;
  unread: number;
  mentions: number;
  messages: number;
  paused: boolean;
  pausedByAdmin: string | null;
  pausedForEveryone: boolean;
  disconnected: boolean;
  /** The Admins reading this channel now (My group only; General is never read-recorded). Empty when no one is. */
  adminReading: AdminReading[];
  can: { pause: boolean; pauseEveryone: boolean; disconnect: boolean; removeAll: boolean };
}

export interface AgentInfo {
  sessionId: string;
  name: string;
  machine: string;
  reporterKey: string;
  address: string;
  status: 'running' | 'waiting' | 'done';
  waitReason: 'permission' | 'input' | null;
  /** Whether the agent's reporter has messaging on, which a direct message needs. */
  peers: boolean;
}

export interface Overview {
  enabled: true;
  serverTime: number;
  /** `actor` is the name the Admin is recorded under (their own, or "Admin secret"), the one a pause, a reading or a stop carries, so the page can tell which are theirs. */
  me: { name: string; actor: string; admin: boolean; person: boolean };
  settings: { maxChars: number; perMinute: number; retainDays: number; graceHours: number; everyone: boolean };
  channels: ChannelInfo[];
  directs: DirectInfo[];
  agents: AgentInfo[];
  /** `directs` is set only when an Admin browses another person (#1034): how many Direct Messages that person takes part in, for the picker. */
  people: { name: string; you: boolean; directs?: number }[];
  /** How many messages from other people wait for the viewer's approval as the owner of the agent they wrote to (#1034). Answered on My reporters. */
  approvals: number;
  /** The Admins looking at this person's list of conversations now (#1051). Empty for an Admin who browses. Names and times, never text. */
  listReading: AdminReading[];
  /** The latest records of an Admin looking at this person's list, oldest first. Empty for an Admin who browses. */
  listReads: AdminReadRow[];
  /**
   * The person's unseen Admin records of a conversation that no longer exists (#1051), newest first, at most GONE_RECORDS: there is no thread left to show them
   * on, so the overview does. `with` names the other party. Never any text; empty for an Admin who browses. Loading the overview marks them seen.
   */
  goneReads: GoneRead[];
}

/** One Admin record of a deleted conversation, as the person's overview shows it. */
export interface GoneRead {
  admin: string;
  startedAt: number;
  kind: AdminReadRow['kind'];
  with: string;
}

/** How many records of a look at the person's list the overview carries (more when the person has not seen older ones). */
const LIST_RECORDS = 20;
/** How many records of deleted conversations the overview carries (a thread is shown whole or not at all, so the first can exceed it). */
const GONE_RECORDS = 20;

/** One record of a thread, for matching an unseen record to the thread's list. */
const readKey = (r: { admin: string; startedAt: number; kind: string }): string => `${r.startedAt}|${r.admin}|${r.kind}`;

/** What `upTo` of a mark-read may be: a paging cursor or a message id. */
const CURSOR_SHAPE = /^[A-Za-z0-9._:-]{1,64}$/;

export class ChatService {
  readonly core: ChatCore;
  readonly channels: ChannelChat;
  readonly direct: DirectChat;
  readonly adminReads: AdminReads;

  constructor(host: ChatHost, store: ChatStoreApi) {
    this.core = new ChatCore(host, store);
    this.adminReads = new AdminReads(this.core);
    this.channels = new ChannelChat(this.core, this.adminReads);
    this.direct = new DirectChat(this.core, this.adminReads);
    this.adminReads.resolve = (thread) => this.direct.subjectOf(thread);
    // A person's @ of another person's agent (#1034): the channel asks the direct-message side, and hears back what came of it.
    this.core.across = (v, sessionId, text, opts) => this.direct.across(v, sessionId, text, opts);
    this.core.hearAcross((u) => void this.channels.acrossUpdate(u).catch((err: unknown) => host.warn('a mention in Chat could not be updated', err)));
  }

  /** What became of a message between people, from the peer store's own trail: the mention the person wrote moves, and both sides' consoles are told. */
  peerTrail(t: MessageTrail): void {
    this.direct.peerTrail(t);
  }

  /** The Admin's Chat limits and the channels' flags. */
  get settings(): ChatSettingsApi {
    return this.core.store.settings;
  }

  /**
   * The callouts a session's next report reply carries for its person: every Admin who has read their group or a conversation, or looked at their list, in the
   * last few minutes (derived from the record, so it survives a restart and reaches a session that began late), and the Admin's stops. Empty for most. Content-free.
   */
  adminNoticesFor(sessionId: string): Promise<AdminNotice[]> {
    return this.adminReads.noticesFor(sessionId);
  }

  /** An Admin paused, resumed or removed links of a person's reporters: the person's live sessions are told (#1077). Returns how many sessions were. */
  toldLinkStop(admin: string, owner: string, what: string): number {
    return this.adminReads.toldLinkStop(admin, owner, what);
  }

  /** Replaced by the routes, so a Chat event reaches the Admin log and the server log. */
  set onEvent(fn: (e: ChatEvent) => void) {
    this.core.onEvent = fn;
  }

  set people(p: ChatCoreList | null) {
    this.core.people = p;
  }

  /**
   * The overview of one person's Chat for an Admin who browses it (#1034): the same shape as `overview`, but about `subject`. `me` stays the Admin. It holds
   * names and counts only, never a message's text, so it records no Admin read; the Admin log gets `chat_admin_browse` (once per Admin and person per
   * reading gap). The person's unread and mention counts are not the Admin's to see or clear, so they are 0. 404 when no such person.
   */
  async browse(viewer: ChatViewer, raw: string): Promise<Overview | Fail> {
    if (!viewer.admin) return fail(403, 'Only an Admin can browse another person\'s Chat.');
    const key = nameKey(raw);
    const subject = (await this.core.persons()).find((p) => p.key === key);
    if (!subject) return fail(404, `There is no person named ${raw.slice(0, 80)}.`);
    if (viewer.personId !== null && nameKey(viewer.name) === key) return this.overview(viewer);
    // The person's list is theirs: an Admin looking at it is recorded and the person is told, in the console and in podium-reporter (#1051). It names
    // who they talk to and how many messages, never what they say. Recorded before it is answered; the Admin log gets `chat_admin_browse` once a session.
    await this.adminReads.note(viewer, { scope: 'list', thread: listThread(key), owners: [key], phrase: LIST_PHRASE, person: subject.name });
    return this.overview(viewer, subject.name);
  }

  async overview(viewer: ChatViewer, browsing?: string): Promise<Overview> {
    const person = viewer.personId !== null;
    const host = this.core.host;
    const who = browsing ?? viewer.name;
    const key = nameKey(who);
    const limits = await this.core.limits();
    const counts = new Map((person && !browsing ? await this.core.store.readState.list(viewer.name) : []).map((r) => [r.thread, r]));
    const channel = async (id: 'general' | 'group'): Promise<ChannelInfo> => {
      const thread = id === 'general' ? publicThread : groupThread(who);
      const flags = await this.channels.flagsOf(id, id === 'group' ? key : null, person || browsing ? key : null);
      const c = counts.get(thread);
      return {
        id,
        name: CHANNEL_NAMES[id],
        thread,
        unread: c?.unread ?? 0,
        mentions: c?.mentions ?? 0,
        messages: await this.channels.total(id, id === 'group' ? key : null),
        ...flags,
        adminReading: [],
        can: id === 'group' ? { pause: true, pauseEveryone: false, disconnect: true, removeAll: true } : { pause: person, pauseEveryone: viewer.admin, disconnect: person, removeAll: viewer.admin },
      };
    };
    const agents: AgentInfo[] = person || browsing
      ? host.liveIds().flatMap((id) => {
          const o = host.peers.messages.live(id);
          return o && nameKey(o.owner) === key
            ? [{ sessionId: o.sessionId, name: o.name, machine: o.machine, reporterKey: o.reporterKey, address: `${o.name}@${o.machine}`, status: o.status, waitReason: o.waitReason, peers: o.peers === true }]
            : [];
        })
      : [];
    const channels = [await channel('general'), ...(person || browsing ? [await channel('group')] : [])];
    const directs = browsing ? await this.direct.listAbout(viewer, who) : await this.direct.list(viewer);
    // The Admins reading right now, named, for the people in the thread. A reading whose time has passed is never reported.
    const list = person || browsing ? listThread(who) : null;
    const hidden = person || browsing ? await this.direct.hiddenOf(viewer, who, browsing !== undefined) : [];
    const live = await this.adminReads.liveFor([...(person || browsing ? [groupThread(who)] : []), ...(list ? [list] : []), ...directs.map((d) => d.thread), ...hidden.map((d) => d.thread)]);
    for (const c of channels) if (c.id === 'group') c.adminReading = live.get(c.thread) ?? [];
    for (const d of directs) d.adminReading = live.get(d.thread) ?? [];
    // A conversation that left the list (every agent in it has ended) is still read by an Admin who opened it, so it comes back while that is live (#1051).
    for (const d of hidden) {
      d.adminReading = live.get(d.thread) ?? [];
      if (d.adminReading.length) directs.push(d);
    }
    // Who looked at the person's own list, and who is looking now. An Admin browsing sees neither: it is the person's to see. Loading it is seeing it.
    const listReading = list && !browsing ? (live.get(list) ?? []) : [];
    const listReads = list && !browsing ? await this.listReadsOf(list, viewer.name) : [];
    if (list && !browsing && viewer.personId !== null) await this.adminReads.seen(list, viewer.name);
    const goneReads = list && !browsing && viewer.personId !== null ? await this.goneReadsOf(viewer.name) : [];
    return {
      enabled: true,
      serverTime: host.now(),
      me: { name: viewer.name, actor: viewer.actor, admin: viewer.admin, person },
      settings: { maxChars: limits.maxChars, perMinute: limits.perMinute, retainDays: limits.retainDays, graceHours: limits.graceHours, everyone: limits.everyone },
      channels,
      directs,
      agents: agents.sort((a, b) => a.address.localeCompare(b.address)),
      people: browsing
        ? await Promise.all((await this.core.persons()).map(async (p) => ({ name: p.name, you: false, directs: await this.direct.countOf(p.name) })))
        : (await this.core.persons()).map((p) => ({ name: p.name, you: p.key === nameKey(viewer.name) })),
      approvals: person && !browsing ? await this.direct.approvalsFor(viewer.name) : 0,
      listReading,
      listReads,
      goneReads,
    };
  }

  /** The person's unseen records of conversations that are gone, named and marked seen: loading the overview with them on it is seeing them. */
  private async goneReadsOf(name: string): Promise<GoneRead[]> {
    const exist = await this.direct.threads();
    const unseen = (await this.adminReads.unseenFor(name)).filter((r) => r.thread.startsWith(ACT_PREFIX) || (r.thread.startsWith('dm:') && !exist.has(r.thread)));
    // "Seen" is marked per thread, so a thread is shown whole or not at all: whole threads, newest first, while they fit in GONE_RECORDS (the
    // first is always whole, however long). A thread left for the next load stays unseen, so a record the person was not shown is never lost.
    const byThread = new Map<string, typeof unseen>();
    for (const r of unseen) byThread.set(r.thread, [...(byThread.get(r.thread) ?? []), r]);
    const shown: typeof unseen = [];
    const marked: string[] = [];
    for (const [thread, records] of byThread) {
      if (shown.length > 0 && shown.length + records.length > GONE_RECORDS) continue;
      shown.push(...records);
      marked.push(thread);
    }
    const out: GoneRead[] = [];
    // An Admin's stop or delete of the person's own things (#1078) has no other party; the console words it from the kind.
    for (const r of shown) out.push({ admin: r.admin, startedAt: r.startedAt, kind: r.kind, with: r.thread.startsWith(ACT_PREFIX) ? '' : await this.partyNames(r.thread, name) });
    for (const thread of marked) await this.adminReads.seen(thread, name);
    return out;
  }

  /**
   * The records of a look at the person's list to show, oldest first: the newest LIST_RECORDS, and from the oldest unseen one when that is older. "Seen" is
   * marked for the whole list thread, so a record the person was not shown must never be cut off while the thread is marked (#1051).
   */
  private async listReadsOf(list: string, name: string): Promise<AdminReadRow[]> {
    const records = await this.adminReads.list(list);
    const unseen = new Set((await this.adminReads.unseenFor(name)).filter((r) => r.thread === list).map(readKey));
    const first = records.findIndex((r) => unseen.has(readKey(r)));
    return records.slice(Math.max(0, first < 0 ? records.length - LIST_RECORDS : Math.min(first, records.length - LIST_RECORDS)));
  }

  /** The other end of a conversation that is gone, for `name`: the ends that are not theirs, or both when both are (two of their own agents). */
  private async partyNames(thread: string, name: string): Promise<string> {
    const key = nameKey(name);
    const persons = await this.core.persons();
    const ends = await Promise.all(
      thread.slice('dm:'.length).split('|').map(async (id) => {
        if (isPersonId(id)) return { mine: id === personId(name), name: persons.find((p) => p.key === id.slice('person:'.length))?.name ?? id.slice('person:'.length) };
        const s = await this.core.host.sessionOf(id);
        return { mine: !!s?.owner && nameKey(s.owner) === key, name: s?.name ?? 'an agent' };
      }),
    );
    const others = ends.filter((e) => !e.mine);
    return (others.length ? others : ends).map((e) => e.name).join(' and ');
  }

  /** The person read up to `upTo` in a thread of theirs. */
  async markRead(viewer: ChatViewer, thread: unknown, upTo: unknown): Promise<{ ok: true; unread: number; mentions: number } | Fail> {
    if (viewer.personId === null) return fail(403, 'The admin secret has no unread counts of its own.');
    if (typeof thread !== 'string' || (upTo !== null && upTo !== undefined && typeof upTo !== 'string')) return fail(400, 'thread must be a string and upTo a string or null.');
    // What was read up to is a cursor (`<ms>.<seq>`) or a message id: short, and made of letters, digits and . : _ - only (#1051).
    if (typeof upTo === 'string' && !CURSOR_SHAPE.test(upTo)) return fail(400, 'upTo must be the cursor or id of a message, at most 64 characters.');
    const mine = thread === publicThread || thread === groupThread(viewer.name) || (thread.startsWith('dm:') && (await this.direct.owns(viewer, thread)));
    if (!mine) return fail(403, 'That is not one of your threads.');
    const row = await this.core.store.readState.markRead(viewer.name, thread, upTo ?? null);
    this.core.signal({ scope: thread === publicThread ? 'public' : thread.startsWith('dm:') ? 'dm' : 'group', owner: nameKey(viewer.name), unread: row.unread, mentions: row.mentions });
    return { ok: true, unread: row.unread, mentions: row.mentions };
  }

  // ---- The fleet tells Chat when a session leaves or returns --------------------------------------------------------

  /** A session left the live set (ended, dropped or deleted). */
  async sessionLeft(sessionId: string, owner: string | null): Promise<void> {
    this.seen.delete(sessionId);
    if (!owner) return;
    await this.channels.sessionLeft(sessionId, owner);
    await this.direct.sessionChanged(sessionId, owner);
  }

  /** The live sessions whose hidden conversations were already shown again, so a report (every few seconds) costs a lookup and not a scan of the conversations. */
  private readonly seen = new Set<string>();

  /**
   * A session reported: the first time since it went live (or since the server started), its hidden conversations are shown again. Only a change signals
   * the consoles, so a routine report never wakes them.
   */
  async sessionSeen(sessionId: string, owner: string): Promise<void> {
    if (this.seen.has(sessionId)) return;
    await this.direct.sessionSeen(sessionId, owner);
    this.seen.add(sessionId);
  }

  /** The hourly housekeeping: conversations against the live set, then retention for both channels and the hidden conversations. */
  async maintain(): Promise<void> {
    const limits = await this.core.store.settings.get();
    await this.direct.reconcile();
    const now = this.core.host.now();
    const channelMessages = await this.channels.purge(now - limits.retainDays * DAY_MS);
    const directMessages = await this.direct.purge(limits.graceHours * HOUR_MS);
    // A reading's record goes with its conversation, and by the channels' retention days.
    const threads = await this.direct.threads();
    await this.adminReads.maintain(now - limits.retainDays * DAY_MS, threads);
    // The counts of a conversation that is gone (its hidden grace period ended, or its session was deleted) go with it (#1051).
    for (const thread of await this.core.store.readState.threads('dm:')) if (!threads.has(thread)) await this.core.store.readState.forget(thread);
    this.core.forgetIdle();
    if (channelMessages || directMessages) {
      this.core.onEvent({ kind: 'purged', channelMessages, directMessages });
      this.core.signal({ scope: 'public', owner: null });
    }
  }
}

type ChatCoreList = NonNullable<ChatCore['people']>;
