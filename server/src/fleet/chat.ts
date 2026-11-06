// Chat (#1034): the service the fleet owns. It puts the channel side and the direct-message side behind one object, keeps the counts, answers the
// overview the Chat page opens with, and runs the two housekeeping jobs (a conversation hiding and returning as its agents leave and come back, and the
// retention purge). The two sides stay apart on purpose: see `chatChannels.ts` and `chatDirect.ts`.
import { nameKey } from '../storage/rows.js';
import type { ChatSettingsApi, ChatStoreApi } from '../storage/types.js';
import { ChannelChat } from './chatChannels.js';
import { ChatCore } from './chatCore.js';
import { DirectChat, type DirectInfo } from './chatDirect.js';
import type { MessageTrail } from './peerTypes.js';
import { CHANNEL_NAMES, fail, groupThread, publicThread, type ChatEvent, type ChatHost, type ChatViewer, type Fail } from './chatTypes.js';

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
  pausedForEveryone: boolean;
  disconnected: boolean;
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
  me: { name: string; admin: boolean; person: boolean };
  settings: { maxChars: number; perMinute: number; retainDays: number; graceHours: number; everyone: boolean };
  channels: ChannelInfo[];
  directs: DirectInfo[];
  agents: AgentInfo[];
  people: { name: string; you: boolean }[];
  /** How many messages from other people wait for the viewer's approval as the owner of the agent they wrote to (#1034). Answered on My reporters. */
  approvals: number;
}

export class ChatService {
  readonly core: ChatCore;
  readonly channels: ChannelChat;
  readonly direct: DirectChat;

  constructor(host: ChatHost, store: ChatStoreApi) {
    this.core = new ChatCore(host, store);
    this.channels = new ChannelChat(this.core);
    this.direct = new DirectChat(this.core);
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

  /** Replaced by the routes, so a Chat event reaches the Admin log and the server log. */
  set onEvent(fn: (e: ChatEvent) => void) {
    this.core.onEvent = fn;
  }

  set people(p: ChatCoreList | null) {
    this.core.people = p;
  }

  async overview(viewer: ChatViewer): Promise<Overview> {
    const person = viewer.personId !== null;
    const host = this.core.host;
    const key = nameKey(viewer.name);
    const limits = await this.core.limits();
    const counts = new Map((person ? await this.core.store.readState.list(viewer.name) : []).map((r) => [r.thread, r]));
    const channel = async (id: 'general' | 'group'): Promise<ChannelInfo> => {
      const thread = id === 'general' ? publicThread : groupThread(viewer.name);
      const flags = await this.channels.flagsOf(id, id === 'group' ? key : null, person ? key : null);
      const c = counts.get(thread);
      return {
        id,
        name: CHANNEL_NAMES[id],
        thread,
        unread: c?.unread ?? 0,
        mentions: c?.mentions ?? 0,
        messages: await this.channels.total(id, id === 'group' ? key : null),
        ...flags,
        can: id === 'group' ? { pause: true, pauseEveryone: false, disconnect: true, removeAll: true } : { pause: person, pauseEveryone: viewer.admin, disconnect: person, removeAll: viewer.admin },
      };
    };
    const agents: AgentInfo[] = person
      ? host.liveIds().flatMap((id) => {
          const o = host.peers.messages.live(id);
          return o && nameKey(o.owner) === key
            ? [{ sessionId: o.sessionId, name: o.name, machine: o.machine, reporterKey: o.reporterKey, address: `${o.name}@${o.machine}`, status: o.status, waitReason: o.waitReason, peers: o.peers === true }]
            : [];
        })
      : [];
    return {
      enabled: true,
      serverTime: host.now(),
      me: { name: viewer.name, admin: viewer.admin, person },
      settings: { maxChars: limits.maxChars, perMinute: limits.perMinute, retainDays: limits.retainDays, graceHours: limits.graceHours, everyone: limits.everyone },
      channels: [await channel('general'), ...(person ? [await channel('group')] : [])],
      directs: await this.direct.list(viewer),
      agents: agents.sort((a, b) => a.address.localeCompare(b.address)),
      people: (await this.core.persons()).map((p) => ({ name: p.name, you: p.key === key })),
      approvals: person ? await this.direct.approvalsFor(viewer.name) : 0,
    };
  }

  /** The person read up to `upTo` in a thread of theirs. */
  async markRead(viewer: ChatViewer, thread: unknown, upTo: unknown): Promise<{ ok: true; unread: number; mentions: number } | Fail> {
    if (viewer.personId === null) return fail(403, 'The admin secret has no unread counts of its own.');
    if (typeof thread !== 'string' || (upTo !== null && upTo !== undefined && typeof upTo !== 'string')) return fail(400, 'thread must be a string and upTo a string or null.');
    const mine = thread === publicThread || thread === groupThread(viewer.name) || (thread.startsWith('dm:') && (await this.direct.owns(viewer, thread)));
    if (!mine) return fail(403, 'That is not one of your threads.');
    const row = await this.core.store.readState.markRead(viewer.name, thread, upTo ?? null);
    this.core.signal({ scope: thread === publicThread ? 'public' : thread.startsWith('dm:') ? 'dm' : 'group', owner: nameKey(viewer.name), unread: row.unread, mentions: row.mentions });
    return { ok: true, unread: row.unread, mentions: row.mentions };
  }

  // ---- The fleet tells Chat when a session leaves or returns --------------------------------------------------------

  /** A session left the live set (ended, dropped or deleted). */
  async sessionLeft(sessionId: string, owner: string | null): Promise<void> {
    if (!owner) return;
    await this.channels.sessionLeft(sessionId, owner);
    await this.direct.sessionChanged(sessionId, owner);
  }

  /** A session reported: if it is back, its hidden conversations are shown again. */
  async sessionSeen(sessionId: string, owner: string): Promise<void> {
    await this.direct.sessionChanged(sessionId, owner);
  }

  /** The hourly housekeeping: conversations against the live set, then retention for both channels and the hidden conversations. */
  async maintain(): Promise<void> {
    const limits = await this.core.store.settings.get();
    await this.direct.reconcile();
    const now = this.core.host.now();
    const channelMessages = await this.channels.purge(now - limits.retainDays * DAY_MS);
    const directMessages = await this.direct.purge(limits.graceHours * HOUR_MS);
    if (channelMessages || directMessages) {
      this.core.onEvent({ kind: 'purged', channelMessages, directMessages });
      this.core.signal({ scope: 'public', owner: null });
    }
  }
}

type ChatCoreList = NonNullable<ChatCore['people']>;
