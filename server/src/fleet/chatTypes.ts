// The Chat page's shared types and small helpers (#1034). Nothing here touches a database.
import type { PeerStoreApi } from '../storage/types.js';
import type { RespondStore } from './respond.js';
import { nameKey } from '../storage/rows.js';
import { personKeyOf } from './peerTypes.js';

/**
 * The channels: General (everyone signed in), My group (a person and their own agents), and a public channel someone opened (#1035), which is named by its own
 * name. A name is never `general` or `group` (the store refuses both), so the three kinds cannot be mistaken for one another. Whether a name is a channel that exists
 * is the channel service's to say (`ChannelChat.resolve`); a value of this type has already been through it.
 */
export type ChannelId = string;
export const GENERAL = 'general';
export const GROUP = 'group';
/** General and every public channel are the public audience: everything in them is readable by every signed-in person, every reporter and every Admin. */
export const isPublicChannel = (c: ChannelId): boolean => c !== GROUP;
/** What a channel is called to a person: General, My group, or the public channel's own name. */
export const channelName = (c: ChannelId): string => (c === GENERAL ? 'General' : c === GROUP ? 'My group' : c);

/** Who is signed in to the browser: a person (`personId` set) or the admin secret (null). */
export interface ChatViewer {
  name: string;
  /** As the Admin log names the actor. */
  actor: string;
  admin: boolean;
  personId: number | null;
}

export interface Fail {
  ok: false;
  status: number;
  error: string;
  /** For a form that must say which field is wrong (#1035): the store's reason, such as `name-taken`. Not in every refusal. */
  reason?: string;
}
export const fail = (status: number, error: string, reason?: string): Fail => ({ ok: false, status, error, ...(reason ? { reason } : {}) });

/** The thread names the read state keeps counts under. General's is `public`; another public channel's is `public:<name>`. */
export const publicThread = 'public';
export const channelThread = (c: ChannelId): string => (c === GENERAL ? publicThread : `${publicThread}:${c}`);
/** The channel a thread names, when it is a public channel other than General (`public:<name>`). */
export const channelOfThread = (thread: string): string | null => (thread.startsWith(`${publicThread}:`) ? thread.slice(publicThread.length + 1) : null);
export const groupThread = (owner: string): string => `group:${nameKey(owner)}`;

/** An Admin who is reading a thread now (#1034): since when, and until when it counts as live if the Admin reads no more. Epoch milliseconds. */
export interface AdminReading {
  admin: string;
  since: number;
  until: number;
}
/** A direct message's thread: `dm:` and its two session ids, the smaller first. */
export const dmThread = (a: string, b: string): string => `dm:${a <= b ? `${a}|${b}` : `${b}|${a}`}`;
/** The id a person has in a direct message of their own with one agent: `person:<people.id>` (#1284), never the name, so a newcomer who takes a deleted person's name is not that person. */
export const personId = (id: number): string => personKeyOf(id);
export const isPersonId = (id: string): boolean => id.startsWith('person:');

/** The scope keys of a channel's flags in `settings`: General for everyone, General for one person's agents, and a group. */
const GLOBAL_SCOPE = 'public:global';
const personScope = (owner: string): string => `public:person:${nameKey(owner)}`;
export const groupScope = (owner: string): string => `group:${nameKey(owner)}`;
/** The same two flags of a public channel other than General (#1035): its own keys, so pausing one never touches General or another. General keeps its keys. */
export const channelGlobalScope = (c: ChannelId): string => (c === GENERAL ? GLOBAL_SCOPE : `channel:${c}:global`);
export const channelPersonScope = (c: ChannelId, owner: string): string => (c === GENERAL ? personScope(owner) : `channel:${c}:person:${nameKey(owner)}`);
/** The prefix every flag scope of one public channel starts with, to forget them when it is removed. */
export const channelScopePrefix = (c: ChannelId): string => `channel:${c}:`;

/** Something that happened in Chat that the Admin log records: ids and who, never text. */
export type ChatEvent =
  | { kind: 'sent' | 'delivered' | 'dropped'; channel: ChannelId; owner: string | null; by: string; messageId: string; sessionId: string | null; why?: string }
  | { kind: 'paused' | 'resumed' | 'disconnected' | 'reconnected' | 'cleared'; channel: ChannelId; owner: string | null; by: string; everyone: boolean; count: number }
  | { kind: 'dm_sent'; owner: string; by: string; messageId: string; sessionId: string }
  | { kind: 'across'; owner: string; person: string; by: string; messageId: string; sessionId: string; approval: boolean }
  | { kind: 'message_edited' | 'message_deleted'; scope: 'channel' | 'dm'; channel: ChannelId | null; owner: string | null; by: string; messageId: string }
  | { kind: 'dm_deleted'; owner: string; by: string; a: string; b: string; count: number }
  | { kind: 'admin_read'; by: string; scope: 'group' | 'dm'; thread: string; owners: string[] }
  | { kind: 'admin_browse'; by: string; person: string }
  | { kind: 'conversation_opened'; by: string; conversation: string; members: number }
  | { kind: 'conversation_sent'; by: string; conversation: string; messageId: string }
  | { kind: 'conversation_message_edited' | 'conversation_message_deleted'; by: string; conversation: string; messageId: string }
  | { kind: 'conversation_members_added'; by: string; conversation: string; count: number }
  | { kind: 'conversation_left'; by: string; conversation: string; deleted: boolean }
  | { kind: 'purged'; channelMessages: number; directMessages: number }
  | { kind: 'channel_opened' | 'channel_edited' | 'channel_removed'; channel: ChannelId; by: string; messages?: number };

/** What Chat tells the host changed. The stream sends only `rev` and `scope` of it; the rest is for the host and is never broadcast. */
export interface ChatSignal {
  scope: 'public' | 'group' | 'dm';
  /** The person whose counts changed, folded; null for a change everyone sees. */
  owner: string | null;
  unread?: number;
  mentions?: number;
  /** For the owner of an agent another person wrote to (#1034): how many such messages wait for the owner's approval. A count only. */
  approvals?: number;
}

/** What the Chat service needs of the fleet. The fleet implements it. */
export interface ChatHost {
  readonly now: () => number;
  readonly peers: PeerStoreApi;
  readonly respond: RespondStore;
  respondFlagsOn(): boolean;
  featureOn(id: string): boolean;
  isLive(sessionId: string): boolean;
  /** A session's name and owner as last stored (a session that has ended is still known), or null when it is not. */
  /** A stored session's name and owner: `owner` is display text, and who owns it is `ownerId` (#1284), null for the admin secret's session or one whose person was deleted. */
  sessionOf(sessionId: string): Promise<{ name: string; owner: string | null; ownerId: number | null } | null>;
  liveIds(): string[];
  /** The admin secret and anything else that must never be stored or sent on. */
  secrets(): string[];
  /** Tells open consoles that Chat changed (content-free). */
  signal(s: ChatSignal & { rev: number }): void;
  warn(what: string, err: unknown): void;
}
