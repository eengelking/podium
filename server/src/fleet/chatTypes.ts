// The Chat page's shared types and small helpers (#1034). Nothing here touches a database.
import type { PeerStoreApi } from '../storage/types.js';
import type { RespondStore } from './respond.js';
import { nameKey } from '../storage/rows.js';

/** The two channels: General (everyone signed in) and My group (a person and their own agents). */
export type ChannelId = 'general' | 'group';
export const channelOf = (raw: string): ChannelId | null => (raw === 'general' || raw === 'group' ? raw : null);
export const CHANNEL_NAMES: Record<ChannelId, string> = { general: 'General', group: 'My group' };

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
}
export const fail = (status: number, error: string): Fail => ({ ok: false, status, error });

/** The thread names the read state keeps counts under. */
export const publicThread = 'public';
export const groupThread = (owner: string): string => `group:${nameKey(owner)}`;

/** An Admin who is reading a thread now (#1034): since when, and until when it counts as live if the Admin reads no more. Epoch milliseconds. */
export interface AdminReading {
  admin: string;
  since: number;
  until: number;
}
/** A direct message's thread: `dm:` and its two session ids, the smaller first. */
export const dmThread = (a: string, b: string): string => `dm:${a <= b ? `${a}|${b}` : `${b}|${a}`}`;
/** The id a person has in a direct message of their own with one agent. */
export const personId = (owner: string): string => `person:${nameKey(owner)}`;
export const isPersonId = (id: string): boolean => id.startsWith('person:');

/** The scope keys of a channel's flags in `settings`: General for everyone, General for one person's agents, and a group. */
export const GLOBAL_SCOPE = 'public:global';
export const personScope = (owner: string): string => `public:person:${nameKey(owner)}`;
export const groupScope = (owner: string): string => `group:${nameKey(owner)}`;

/** Something that happened in Chat that the Admin log records: ids and who, never text. */
export type ChatEvent =
  | { kind: 'sent' | 'delivered' | 'dropped'; channel: ChannelId; owner: string | null; by: string; messageId: string; sessionId: string | null; why?: string }
  | { kind: 'paused' | 'resumed' | 'disconnected' | 'reconnected' | 'cleared'; channel: ChannelId; owner: string | null; by: string; everyone: boolean; count: number }
  | { kind: 'dm_sent'; owner: string; by: string; messageId: string; sessionId: string }
  | { kind: 'across'; owner: string; person: string; by: string; messageId: string; sessionId: string; approval: boolean }
  | { kind: 'dm_deleted'; owner: string; by: string; a: string; b: string; count: number }
  | { kind: 'admin_read'; by: string; scope: 'group' | 'dm'; thread: string; owners: string[] }
  | { kind: 'admin_browse'; by: string; person: string }
  | { kind: 'purged'; channelMessages: number; directMessages: number };

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
  liveIds(): string[];
  /** The admin secret and anything else that must never be stored or sent on. */
  secrets(): string[];
  /** Tells open consoles that Chat changed (content-free). */
  signal(s: ChatSignal & { rev: number }): void;
  warn(what: string, err: unknown): void;
}
