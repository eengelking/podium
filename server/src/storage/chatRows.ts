// The pure part of the Chat page's stores (#1034), shared by every adapter: neither adapter imports the other, so what they have in common
// lives here. Nothing in this file touches a database, and nothing here knows a direct message (`peer_messages`): a channel's text and a
// conversation's text are kept in different tables and read by different methods on purpose.
import { randomBytes } from 'node:crypto';
import { nameKey } from './rows.js';
import type { ChannelFlags, ChannelMention, ChannelMessage, ChannelPostInput, ChatAuthorKind, ChatSettings, ChatSettingsApi, MentionState, NewPublicChannel, PublicChannel, PublicChannelLinkKind, PublicChannelOutcome, PublicChannelRefusal } from './types.js';

const CHAT_AUTHOR_KINDS: readonly ChatAuthorKind[] = ['person', 'orchestrator', 'subagent', 'reporter'];
const MENTION_STATES: readonly MentionState[] = ['waiting', 'working', 'done', 'not-delivered', 'held', 'dropped', 'approval'];

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
  /** Only in the public table (#1035). */
  channel?: string;
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

/** The `LIKE` patterns that cut a channel's rows down to the ones that can hold a held mention (for `session`, when given). They are a filter and `holdsHeld` decides: a match is only a candidate. */
export function heldLikes(sessionId?: string): string[] {
  const likes = ['%"state":"held"%'];
  // An id with a character `LIKE` reads as its own would only widen the candidates, but a backslash or a quote changes the pattern's meaning: leave those to `holdsHeld`.
  if (sessionId !== undefined && /^[\w.:@-]+$/.test(sessionId)) likes.push(`%"sessionId":"${sessionId}"%`);
  return likes;
}

/** Whether the message has a mention in the `held` state (of `sessionId`, when given). */
export function holdsHeld(m: ChannelMessage, sessionId?: string): boolean {
  return m.mentions.some((x) => x.state === 'held' && (sessionId === undefined || x.sessionId === sessionId));
}

function parseMentions(json: string): ChannelMention[] {
  return JSON.parse(json) as ChannelMention[];
}

/** One stored row as the interface returns it. */
export function toChannelMessage(r: DbChannelRow): ChannelMessage {
  return {
    id: r.id,
    owner: r.owner ?? null,
    groupId: r.group_id ?? null,
    channel: r.channel ?? null,
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
const CHAT_DEFAULTS: ChatSettings = { retainDays: 30, graceHours: 24, maxChars: 4000, perMinute: 6 };
const CHAT_RANGES: Record<keyof ChatSettings, { min: number; max: number }> = {
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

/** A list of folded names kept in a text column (`chat_admin_reads.people`, `.seen`). Anything that is not a list of strings is an empty one. */
export function keyList(raw: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The list as the column keeps it: folded, without repeats, in order. */
export const keyText = (names: readonly string[]): string => JSON.stringify([...new Set(names.map(nameKey))]);

/**
 * What deleting the person `key` does to an Admin record (#1051): `drop` when only they were owed it (it can never be seen), `keep` with the people and the
 * seen list without them when others are owed it too, and `none` for a record that does not name them (including one that names nobody, which goes by
 * retention alone).
 */
export function withoutPerson(r: { people: string; seen: string }, key: string): 'none' | 'drop' | { people: string; seen: string } {
  const people = keyList(r.people);
  if (!people.includes(key)) return 'none';
  const rest = people.filter((p) => p !== key);
  if (!rest.length) return 'drop';
  return { people: keyText(rest), seen: keyText(keyList(r.seen).filter((p) => p !== key)) };
}

/** The people an Admin record is owed to and who have not seen it, from the two lists the record kept before `chat_admin_owed` (#1061). */
export const owedKeys = (r: { people: string; seen: string }): string[] => {
  const seen = new Set(keyList(r.seen));
  return keyList(r.people).filter((p) => !seen.has(p));
};

/** A person who never loads Chat is owed an Admin record for this long after its last read (#1061, 90 days); then the record is no longer owed to them. */
export const OWED_CAP_MS = 90 * 86_400_000;

/** The `settings` key that says the `chat_admin_owed` table has been filled from the records that were there before it (#1061). */
export const OWED_FILLED_KEY = 'chat_admin_owed_filled';

/** The key of General, the built-in public channel (#1035). Existing public messages belong to it. */
export const GENERAL_CHANNEL = 'general';
/** Words no public channel may be named: General is built in, and `group` is the thread name of a person's group. */
export const RESERVED_CHANNEL_NAMES: readonly string[] = [GENERAL_CHANNEL, 'group'];
/** A public channel's name once folded. */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** At most this many public channels besides General. */
export const MAX_PUBLIC_CHANNELS = 50;
export const MAX_CHANNEL_DESCRIPTION = 280;
export const MAX_CHANNEL_LINK_REF = 100;
export const CHANNEL_LINK_KINDS: readonly PublicChannelLinkKind[] = ['issue', 'milestone', 'project'];

/** The columns of a public channel row. */
export const CHANNEL_COLS = 'name, description, link_kind, link_ref, created_by, created_by_name, created_at, updated_at';

/** A public channel as its table keeps it. `link_key` is only for the unique key and is never read back. */
export interface DbPublicChannel {
  name: string;
  description: string;
  link_kind: string | null;
  link_ref: string | null;
  created_by: string;
  created_by_name: string;
  created_at: number;
  updated_at: number;
}

export const toPublicChannel = (r: DbPublicChannel): PublicChannel => ({
  name: r.name,
  description: r.description,
  link: r.link_kind && r.link_ref ? { kind: r.link_kind as PublicChannelLinkKind, ref: r.link_ref } : null,
  createdBy: r.created_by,
  createdByName: r.created_by_name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The folded form of a channel name as every method takes it. */
export const channelKey = (name: string): string => String(name).toLowerCase();

/** The unique key of a link: its kind and its reference folded, so `v1.7` and `V1.7` match, and `NULL` (no link) never collides. An issue's reference is stored without its one leading `#` (see `checkNewChannel`), so `#12` and `12` are one link. */
export const linkKey = (kind: string, ref: string): string => `${kind}:${ref.toLowerCase()}`;

/** A link's reference as it is stored: trimmed, and for an issue without its one leading `#` (so `#12`, `12` and ` #12 ` are one link). */
export const linkRef = (kind: string, ref: string): string => {
  const t = String(ref).trim();
  return kind === 'issue' && t.startsWith('#') ? t.slice(1).trim() : t;
};

/** A stored link in words: an issue whose reference is all digits reads `#12`, any other reference reads as it is. */
export const linkText = (kind: string, ref: string): string => (kind === 'issue' && /^\d+$/.test(ref) ? `#${ref}` : ref);

export const channelRefusal = (error: PublicChannelRefusal, message: string): Extract<PublicChannelOutcome, { ok: false }> => ({ ok: false, error, message });

/** Checks a description. Null when it is fine, else the refusal. */
export const checkDescription = (description: unknown): Extract<PublicChannelOutcome, { ok: false }> | null =>
  typeof description === 'string' && [...description].length <= MAX_CHANNEL_DESCRIPTION ? null : channelRefusal('invalid', `The description is at most ${MAX_CHANNEL_DESCRIPTION} characters.`);

/** A new channel's values after the checks that need no database (`reserved`, `invalid`); the refusal when one fails. */
export function checkNewChannel(input: NewPublicChannel): Extract<PublicChannelOutcome, { ok: false }> | { name: string; description: string; link: { kind: PublicChannelLinkKind; ref: string; key: string } | null; createdBy: string; createdByName: string } {
  const name = channelKey(typeof input.name === 'string' ? input.name : '');
  if (RESERVED_CHANNEL_NAMES.includes(name)) return channelRefusal('reserved', `"${name}" is reserved.`);
  if (!CHANNEL_NAME.test(name)) return channelRefusal('invalid', 'A channel name is 1 to 40 lowercase letters, digits or hyphens, and starts with a letter or digit.');
  const description = input.description ?? '';
  const bad = checkDescription(description);
  if (bad) return bad;
  let link: { kind: PublicChannelLinkKind; ref: string; key: string } | null = null;
  if (input.link) {
    const ref = typeof input.link.ref === 'string' ? linkRef(input.link.kind, input.link.ref) : '';
    if (!CHANNEL_LINK_KINDS.includes(input.link.kind) ||!ref || [...ref].length > MAX_CHANNEL_LINK_REF) {
      return channelRefusal('invalid', `A link is an issue, milestone or project and a reference of 1 to ${MAX_CHANNEL_LINK_REF} characters.`);
    }
    link = { kind: input.link.kind, ref, key: linkKey(input.link.kind, ref) };
  }
  const createdByName = typeof input.createdBy === 'string' ? input.createdBy.trim() : '';
  if (!createdByName) return channelRefusal('invalid', 'A channel needs the person who opens it.');
  return { name, description, link, createdBy: nameKey(createdByName), createdByName };
}
