// The pure part of the Chat page's stores (#1034), shared by every adapter: neither adapter imports the other, so what they have in common
// lives here. Nothing in this file touches a database, and nothing here knows a direct message (`peer_messages`): a channel's text and a
// conversation's text are kept in different tables and read by different methods on purpose.
import { randomBytes } from 'node:crypto';
import { nameKey } from './rows.js';
import type { ChannelFlags, ChannelMention, ChannelMessage, ChannelPostInput, ChatAuthorKind, ChatSettings, ChatSettingsApi, MentionState } from './types.js';

export const CHAT_AUTHOR_KINDS: readonly ChatAuthorKind[] = ['person', 'orchestrator', 'subagent', 'reporter'];
export const MENTION_STATES: readonly MentionState[] = ['waiting', 'working', 'done', 'not-delivered', 'held', 'dropped', 'approval'];

/** The `settings` key that holds this server's scope, minted once. */
export const CHAT_SCOPE_KEY = 'chat_scope';

/**
 * A channel message's id: `<table>_<scope>_<random>`. `<table>` is `grp` (group_messages) or `pub` (public_messages); `<scope>` is the
 * server's 8 hex digits, minted once and kept in `settings` (`chat_scope`), so ids from two servers can be told apart and a bridge can
 * carry them unchanged later; `<random>` is 24 hex digits. Example: `pub_3fa9c1d2_9e1b0c47d5a86f3e2b4a7c10`.
 */
export const newChannelId = (prefix: 'grp' | 'pub', scope: string): string => `${prefix}_${scope}_${randomBytes(12).toString('hex')}`;

/** A fresh server scope: 8 hex digits. */
export const newServerScope = (): string => randomBytes(4).toString('hex');

/** The owner of a group channel as it is stored and compared: folded the way every owner name is. */
export const channelOwner = (owner: string): string => nameKey(owner);

/** The group channel's key columns, in one place for both adapters. */
export interface DbChannelRow {
  id: string;
  owner?: string;
  group_id?: string;
  author_kind: string;
  author_ref: string;
  author_name: string;
  text: string;
  created_at: number;
  updated_at: number;
  issue: string | null;
  project: string | null;
  milestone: string | null;
  reply_to: string | null;
  mentions_json: string;
  seq: number;
}

/** Throws for an author kind that is not one of the four. */
export function checkAuthorKind(kind: string): ChatAuthorKind {
  if (!CHAT_AUTHOR_KINDS.includes(kind as ChatAuthorKind)) throw new Error('The author kind is not one of person, orchestrator, subagent or reporter.');
  return kind as ChatAuthorKind;
}

/** The mentions of a new post, each with its delivery state (waiting unless the caller says otherwise) stamped at `at`. */
export function mentionsOf(input: ChannelPostInput, at: number): ChannelMention[] {
  return (input.mentions ?? []).map((m) => {
    const state = m.state ?? 'waiting';
    if (!MENTION_STATES.includes(state)) throw new Error('The delivery state is not one of waiting, working, done, not-delivered, held, dropped or approval.');
    return { sessionId: m.sessionId, peerKey: m.peerKey, typed: m.typed, state, why: m.why ?? null, stateAt: at };
  });
}

export function parseMentions(json: string): ChannelMention[] {
  return JSON.parse(json) as ChannelMention[];
}

/** One stored row as the interface returns it. */
export function toChannelMessage(r: DbChannelRow): ChannelMessage {
  return {
    id: r.id,
    owner: r.owner ?? null,
    groupId: r.group_id ?? null,
    authorKind: r.author_kind as ChatAuthorKind,
    authorRef: r.author_ref,
    authorName: r.author_name,
    text: r.text,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    issue: r.issue,
    project: r.project,
    milestone: r.milestone,
    replyTo: r.reply_to,
    mentions: parseMentions(r.mentions_json),
  };
}

/** `mentions` with one entry's state changed at `at`; null when there is no entry at `index`. */
export function withMentionState(mentions: ChannelMention[], index: number, patch: { state: MentionState; why?: string | null }, at: number): ChannelMention[] | null {
  const current = mentions[index];
  if (!Number.isInteger(index) || !current) return null;
  if (!MENTION_STATES.includes(patch.state)) throw new Error('The delivery state is not one of waiting, working, done, not-delivered, held, dropped or approval.');
  return mentions.map((m, i) => (i === index ? { ...m, state: patch.state, why: patch.why ?? null, stateAt: at } : m));
}

/** What a read state row says before anything was counted for the thread. */
export const emptyReadState = (person: string, thread: string): { person: string; thread: string; lastRead: null; unread: 0; mentions: 0; updatedAt: 0 } => ({
  person: nameKey(person),
  thread,
  lastRead: null,
  unread: 0,
  mentions: 0,
  updatedAt: 0,
});

/** What the Admin's Chat settings are until changed, and the whole numbers each takes. */
export const CHAT_DEFAULTS: ChatSettings = { retainDays: 30, graceHours: 24, maxChars: 4000, perMinute: 6 };
export const CHAT_RANGES: Record<keyof ChatSettings, { min: number; max: number }> = {
  retainDays: { min: 1, max: 365 },
  graceHours: { min: 1, max: 720 },
  maxChars: { min: 1, max: 20_000 },
  perMinute: { min: 1, max: 600 },
};
const SETTING_PREFIX = 'chat.';
const FLAG_PREFIX = 'chat.flag.';
const SCOPE_MAX = 200;

/** The `settings` table as the Chat settings need it: one text value per key, read and written whole. */
export interface ChatKv {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  /** Every key that starts with `prefix`, with its value. */
  prefixed(prefix: string): Promise<{ key: string; value: string }[]>;
}

// A flag value is its letters (`p` paused, `d` disconnected), then `|` and the name of the Admin who paused it, when one did.
const flagText = (f: ChannelFlags): string => `${f.paused ? 'p' : ''}${f.disconnected ? 'd' : ''}${f.paused && f.pausedByAdmin ? `|${f.pausedByAdmin}` : ''}`;
const flagsOf = (v: string | undefined): ChannelFlags => {
  const bar = v?.indexOf('|') ?? -1;
  const letters = bar < 0 ? (v ?? '') : (v as string).slice(0, bar);
  const by = bar < 0 ? '' : (v as string).slice(bar + 1);
  const paused = letters.includes('p');
  return { paused, disconnected: letters.includes('d'), ...(paused && by ? { pausedByAdmin: by } : {}) };
};

/** The Chat settings over a key-value view of `settings`, the same for every adapter; each adapter lends only the reads and writes. */
export function chatSettingsOver(kv: ChatKv): ChatSettingsApi {
  const keys = Object.keys(CHAT_DEFAULTS) as (keyof ChatSettings)[];
  const read = async (): Promise<ChatSettings> => {
    const out = { ...CHAT_DEFAULTS };
    for (const k of keys) {
      const n = Number(await kv.get(SETTING_PREFIX + k));
      const { min, max } = CHAT_RANGES[k];
      if (Number.isInteger(n) && n >= min && n <= max) out[k] = n;
    }
    return out;
  };
  const checkScope = (scope: string): void => {
    if (!scope || scope.length > SCOPE_MAX) throw new Error('The channel scope is empty or too long.');
  };
  return {
    get: read,
    async set(patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (!keys.includes(k as keyof ChatSettings)) return { ok: false, error: `${k} is not a Chat setting` };
        const { min, max } = CHAT_RANGES[k as keyof ChatSettings];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return { ok: false, error: `${k} must be a whole number from ${min} to ${max}` };
      }
      for (const [k, v] of Object.entries(patch)) await kv.set(SETTING_PREFIX + k, String(v));
      return { ok: true, settings: await read() };
    },
    async flags(scope) {
      checkScope(scope);
      return flagsOf(await kv.get(FLAG_PREFIX + scope));
    },
    async setFlags(scope, patch) {
      checkScope(scope);
      const had = flagsOf(await kv.get(FLAG_PREFIX + scope));
      const paused = patch.paused ?? had.paused;
      const by = patch.paused === undefined ? had.pausedByAdmin : patch.pausedByAdmin;
      const next: ChannelFlags = { paused, disconnected: patch.disconnected ?? had.disconnected, ...(paused && by ? { pausedByAdmin: by } : {}) };
      if (flagText(next)) await kv.set(FLAG_PREFIX + scope, flagText(next));
      else await kv.del(FLAG_PREFIX + scope);
      return next;
    },
    async allFlags() {
      const rows = await kv.prefixed(FLAG_PREFIX);
      return Object.fromEntries(rows.map((r) => [r.key.slice(FLAG_PREFIX.length), flagsOf(r.value)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    },
  };
}
