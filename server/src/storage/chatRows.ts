// The pure part of the Chat page's stores (#1034), shared by every adapter: neither adapter imports the other, so what they have in common
// lives here. Nothing in this file touches a database, and nothing here knows a direct message (`peer_messages`): a channel's text and a
// conversation's text are kept in different tables and read by different methods on purpose.
import { randomBytes } from 'node:crypto';
import { nameKey } from './rows.js';
import type { ChannelChange, ChannelFlags, ChannelMention, ChannelMessage, ChannelPostInput, ChatAuthorKind, ChatSettings, ChatSettingsApi, MentionState, NewPublicChannel, PublicChannel, PublicChannelLinkKind, PublicChannelOutcome, PublicChannelRefusal, ReadBump, ThreadReadState } from './types.js';

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

/**
 * What a person is called in a key column that was a name before #1284: `#<people.id>`, which an Admin's record key (`adminKeyOf`) and the older upgrade steps still write. The columns that held a person's name
 * (`chat_read_state.person`, `chat_admin_owed.person_key`) are gone (#1296), and the id beside each one is the key.
 */
export const personKey = (id: number): string => `#${id}`;

/** The group channel's key columns, in one place for both adapters. */
export interface DbChannelRow {
  id: string;
  /** The `people.id` of the group's person (#1284); null for a row whose person is not known. Only in the group table. */
  owner_id?: number | null;
  /** Only in the public table (#1035). */
  channel?: string;
  author_kind: string;
  author_ref: string;
  author_name: string;
  text: string;
  created_at: number;
  issue: string | null;
  project: string | null;
  milestone: string | null;
  reply_to: string | null;
  mentions_json: string;
  seq: number;
  /** Null for a message never edited (#1269); a database older than that has no value, which reads as null. */
  edited_at?: number | null;
  deleted_at?: number | null;
  author_id?: number | null;
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
    return { sessionId: m.sessionId, peerKey: m.peerKey, typed: m.typed, state, why: m.why ?? null, stateAt: at, ...(m.copyId ? { copyId: m.copyId } : {}) };
  });
}

/** The `LIKE` patterns that cut a channel's rows down to the ones that can hold a held mention (for `session`, when given). They are a filter and `holdsHeld` decides: a match is only a candidate. */
export function heldLikes(sessionId?: string): string[] {
  const likes = ['%"state":"held"%'];
  // An id with a character `LIKE` reads as its own would only widen the candidates, but a backslash or a quote changes the pattern's meaning: leave those to `holdsHeld`.
  if (sessionId !== undefined && /^[\w.:@-]+$/.test(sessionId)) likes.push(`%"sessionId":"${sessionId}"%`);
  return likes;
}

/** The `LIKE` pattern that cuts the rows down to the ones that can hold a mention of `sessionId`: a candidate filter, and `holdsMention` decides. An id with a backslash or a quote is left to `holdsMention`. */
export function mentionLike(sessionId: string): string {
  return /^[\w.:@-]+$/.test(sessionId) ? `%"sessionId":"${sessionId}"%` : '%"sessionId":"%';
}

/** Whether the message has a mention of `sessionId` in one of `states`. */
export function holdsMention(m: ChannelMessage, sessionId: string, states: readonly MentionState[]): boolean {
  return m.mentions.some((x) => x.sessionId === sessionId && states.includes(x.state));
}

/** Whether the message has a mention in the `held` state (of `sessionId`, when given). */
export function holdsHeld(m: ChannelMessage, sessionId?: string): boolean {
  return m.mentions.some((x) => x.state === 'held' && (sessionId === undefined || x.sessionId === sessionId));
}

function parseMentions(json: string): ChannelMention[] {
  return JSON.parse(json) as ChannelMention[];
}

/**
 * A message's `updatedAt` (#1296): the time of its newest change. A post, an edit, a delete and a mention changing state each stamp the time they happen, and nothing else changes a message, so the
 * newest of those times is what a stored `updated_at` held, and the message keeps no column for it. A time a message does not have is left out.
 */
export const newestChange = (...times: (number | null)[]): number => Math.max(...times.filter((t): t is number => t !== null && Number.isFinite(Number(t))).map(Number));

/** One stored row as the interface returns it. */
export function toChannelMessage(r: DbChannelRow): ChannelMessage {
  const mentions = parseMentions(r.mentions_json);
  const editedAt = r.edited_at == null ? null : Number(r.edited_at);
  const deletedAt = r.deleted_at == null ? null : Number(r.deleted_at);
  return {
    id: r.id,
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
    channel: r.channel ?? null,
    authorKind: r.author_kind as ChatAuthorKind,
    authorRef: r.author_ref,
    authorName: r.author_name,
    text: r.text,
    createdAt: r.created_at,
    updatedAt: newestChange(r.created_at, editedAt, deletedAt, ...mentions.map((m) => m.stateAt)),
    issue: r.issue,
    project: r.project,
    milestone: r.milestone,
    replyTo: r.reply_to,
    mentions,
    authorId: r.author_id == null ? null : Number(r.author_id),
    editedAt,
    deletedAt,
  };
}

/**
 * Whether a person can no longer change a message with these mentions (#1269): it has been sent to an agent (`sessionId` set) and the agent has it queued (`waiting`), is working on it
 * (`working`) or has finished (`done`). A mention of a person (no session) never locks, whatever its state, and neither does one that has not been sent (`held`, `approval`) or never
 * will be (`not-delivered`, `dropped`).
 */
export const lockedByDelivery = (mentions: readonly ChannelMention[]): boolean => mentions.some((x) => x.sessionId !== null && (x.state === 'waiting' || x.state === 'working' || x.state === 'done'));

/**
 * The decision of `editMessage` and `deleteMessage` on the row they found, the same in every adapter (#1269): the refusal, or null when the author may go on.
 * The checks run in this order: the author (a person's message whose `author_id` is this person's id; names are never compared), a tombstone, then the lock.
 */
export function refuseChange(row: DbChannelRow | undefined, author: number): Extract<ChannelChange, { ok: false }> | null {
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.author_kind !== 'person' || row.author_id == null || Number(row.author_id) !== author) return { ok: false, reason: 'not-yours' };
  if (row.deleted_at != null) return { ok: false, reason: 'deleted' };
  if (lockedByDelivery(parseMentions(row.mentions_json))) return { ok: false, reason: 'locked' };
  return null;
}

/** `mentions` with one entry's state changed at `at`; null when there is no entry at `index`. */
export function withMentionState(mentions: ChannelMention[], index: number, patch: { state: MentionState; why?: string | null; copyId?: string | null }, at: number): ChannelMention[] | null {
  const current = mentions[index];
  if (!Number.isInteger(index) || !current) return null;
  if (!MENTION_STATES.includes(patch.state)) throw new Error('The delivery state is not one of waiting, working, done, not-delivered, held, dropped or approval.');
  // A copy id stays across later state changes; the patch sets it when it names one (#1269).
  return mentions.map((m, i) => (i === index ? { ...m, state: patch.state, why: patch.why ?? null, stateAt: at, ...(patch.copyId ? { copyId: patch.copyId } : {}) } : m));
}

/**
 * One entry per person, in ascending person id: a person listed twice has the unread and the mentions of both, as two bumps would give. The order is fixed so that two transactions that count the same
 * people take the row locks of `chat_read_state` in the same order, and never each hold a row the other waits for (a multi-row upsert locks in the order of its VALUES, and the database would abort one).
 */
export function foldBumps(bumps: readonly ReadBump[]): { personId: number; unread: number; mentions: number }[] {
  const by = new Map<number, { personId: number; unread: number; mentions: number }>();
  for (const b of bumps) {
    const e = by.get(b.personId) ?? { personId: b.personId, unread: 0, mentions: 0 };
    e.unread++;
    if (b.mention) e.mentions++;
    by.set(b.personId, e);
  }
  return [...by.values()].sort((a, b) => a.personId - b.personId);
}

/** A read state row: one person's counts in one thread, kept by the person's id (#1284). */
export interface DbReadState {
  person_id: number;
  thread: string;
  unread: number;
  mentions: number;
}

export const toState = (r: DbReadState): ThreadReadState => ({ personId: Number(r.person_id), thread: r.thread, unread: r.unread, mentions: r.mentions });

/** The answer of `bumpMany`: the new state of each person in `folded` (what `foldBumps` returned), in that order, from the rows the adapter read back for all of them. */
export function bumpAnswers(folded: readonly { personId: number }[], rows: readonly DbReadState[]): ThreadReadState[] {
  // order-insensitive: the rows are put into a map by person, and the answer follows the order the people were given.
  const by = new Map(rows.map((r) => [Number(r.person_id), toState(r)]));
  return folded.map((b) => by.get(b.personId) as ThreadReadState);
}

/** What a thread with no row says, and so what a thread read to the end says: a row at zero is never kept (#1296). */
export const emptyReadState = (personId: number, thread: string): ThreadReadState => ({ personId, thread, unread: 0, mentions: 0 });

/** What the Admin's Chat settings are until changed, and the whole numbers each takes. */
const CHAT_DEFAULTS: ChatSettings = { retainDays: 30, graceHours: 24, maxChars: 4000, perMinute: 6 };
const CHAT_RANGES: Record<keyof ChatSettings, { min: number; max: number }> = {
  retainDays: { min: 1, max: 365 },
  graceHours: { min: 1, max: 720 },
  maxChars: { min: 1, max: 20_000 },
  perMinute: { min: 1, max: 600 },
};
const SETTING_PREFIX = 'chat.';
export const FLAG_PREFIX = 'chat.flag.';

/** Whether a flag scope (`group:<id>`, `public:person:<id>`, `channel:<channel>:person:<id>`) is the person's own, which goes with the person (#1284). */
export const isFlagOfPerson = (scope: string, id: number): boolean => scope === `group:${id}` || scope === `public:person:${id}` || (scope.startsWith('channel:') && scope.endsWith(`:person:${id}`));
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

/** A list of person ids kept in a text column (`chat_admin_reads.people`, and `.seen` until the upgrade fills `chat_admin_owed` and drops it, #1284). Anything that is not a whole number in a list is dropped, so a list the older server kept as names reads as empty until the upgrade has rewritten it. */
export function idList(raw: string | null | undefined): number[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}

/** The list as the column keeps it: ids without repeats, in order. */
export const idText = (ids: readonly number[]): string => JSON.stringify([...new Set(ids)]);

/**
 * What deleting the person `id` does to an Admin record (#1051): `drop` when only they were owed it (it can never be seen), `keep` with the people without them
 * when others are owed it too, and `none` for a record that does not name them (including one that names nobody, which goes by retention alone).
 */
export function withoutPerson(r: { people: string }, id: number): 'none' | 'drop' | { people: string } {
  const people = idList(r.people);
  if (!people.includes(id)) return 'none';
  const rest = people.filter((p) => p !== id);
  if (!rest.length) return 'drop';
  return { people: idText(rest) };
}

/** The people an Admin record is owed to and who have not seen it, from the two lists the record kept before `chat_admin_owed` (#1061). Only the upgrade reads them. */
export const owedIds = (r: { people: string; seen: string }): number[] => {
  const seen = new Set(idList(r.seen));
  return idList(r.people).filter((p) => !seen.has(p));
};

/**
 * The key an Admin's record is kept under: `#<people.id>` for an Admin who signed in as a person, and the folded name for the admin secret, which has no person (#1284). A person who
 * takes a deleted Admin's name is a different Admin, so their reads do not join the earlier person's reading session.
 */
export const adminKeyOf = (name: string, adminId: number | null): string => (adminId === null ? nameKey(name) : personKey(adminId));

// ---- The upgrade to ids (#1284), shared by every adapter -------------------------------------------------------------------------------------------------------

/** `people.name_lower` to the person's id and the time the person was made, which the upgrade uses. */
export type PersonIndex = ReadonlyMap<string, { id: number; createdAt: number }>;

/**
 * The text after a thread or scope's prefix, read as a folded name; null when it holds nothing. An all-digit text is a name too (a person may be called "42"): the upgrade step that calls this runs
 * once on name-keyed data (`CHAT_IDS_DONE_KEY`), so the text it reads is always a name and never an id it wrote before, the same rule the peer step reads `person:<digits>` by.
 */
const nameAfter = (text: string, prefix: string): string | null => {
  if (!text.startsWith(prefix)) return null;
  const rest = text.slice(prefix.length);
  return rest === '' ? null : rest;
};

/**
 * A thread the older server named by a folded name (`group:<name>`, `list:<name>`, `act:<name>`) with the person's id instead. `null` when the thread is not one of those (a name-keyed thread is
 * all the step meets, since it runs once); `''` when it names a person who is not there, which the upgrade leaves alone (nobody can match it).
 */
export function threadWithId(thread: string, people: PersonIndex): string | null {
  if (thread.startsWith('dm:')) return dmThreadWithIds(thread, people);
  for (const prefix of ['group:', 'list:', 'act:']) {
    const name = nameAfter(thread, prefix);
    if (name === null) continue;
    const p = people.get(name);
    return p ? `${prefix}${p.id}` : '';
  }
  return null;
}

/**
 * A direct-message thread (`dm:<a>|<b>`) whose person end is still `person:<folded name>`, with the person's id, as the peer tables' own upgrade writes it (`person:<id>`, or `person:gone:<name>` when no
 * person has the name, which no live person's key equals). Every name is read as a name, one that begins `gone:` included (#1292): the step runs once, on name-keyed data. The ends are put in order again, as `dmThread` does. `null` when no end holds a name.
 */
function dmThreadWithIds(thread: string, people: PersonIndex): string | null {
  let changed = false;
  const ends = thread.slice('dm:'.length).split('|').map((end) => {
    const name = nameAfter(end, 'person:');
    if (name === null || name === 'admin') return end;
    changed = true;
    const p = people.get(name);
    return p ? `person:${p.id}` : `person:gone:${name}`;
  });
  if (!changed || ends.length !== 2) return null;
  const [a, b] = ends as [string, string];
  return `dm:${a <= b ? `${a}|${b}` : `${b}|${a}`}`;
}

/** The flag scope the older server named by a folded name, with the person's id: `group:<name>`, `public:person:<name>` and `channel:<channel>:person:<name>`. `null` when it is not one of those; `''` for a person who is not there (the flag is dropped). */
export function flagScopeWithId(scope: string, people: PersonIndex): string | null {
  const person = (prefix: string, name: string): string => {
    const p = people.get(name);
    return p ? `${prefix}${p.id}` : '';
  };
  const g = nameAfter(scope, 'group:');
  if (g !== null) return person('group:', g);
  const pub = nameAfter(scope, 'public:person:');
  if (pub !== null) return person('public:person:', pub);
  const m = /^(channel:[a-z0-9-]+:person:)(.+)$/.exec(scope);
  if (m) return person(m[1] as string, m[2] as string);
  return null;
}

/** An Admin record's `people` or `seen` list with every name in it replaced by the person's id; a name that is no person's is dropped. `null` when the list holds no name, so it is not written again. */
export function listWithIds(raw: string, people: PersonIndex): string | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || !v.some((x) => typeof x === 'string')) return null;
  const ids = v.flatMap((x) => (typeof x === 'number' ? [x] : typeof x === 'string' && people.has(x) ? [(people.get(x) as { id: number }).id] : []));
  return idText(ids);
}

/** A person who never loads Chat is owed an Admin record for this long after its last read (#1061, 90 days); then the record is no longer owed to them. */
export const OWED_CAP_MS = 90 * 86_400_000;

/** The `settings` key that says the `chat_admin_owed` table has been filled from the records that were there before it (#1061). */
export const OWED_FILLED_KEY = 'chat_admin_owed_filled';

/** The key of General, the built-in public channel (#1035). Existing public messages belong to it. */
export const GENERAL_CHANNEL = 'general';
/** Words no public channel may be named: General is built in, and `group` is the thread name of a person's group. */
const RESERVED_CHANNEL_NAMES: readonly string[] = [GENERAL_CHANNEL, 'group'];
/** A public channel's name once folded. */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** At most this many public channels besides General. */
export const MAX_PUBLIC_CHANNELS = 50;
const MAX_CHANNEL_DESCRIPTION = 280;
const MAX_CHANNEL_LINK_REF = 100;
const CHANNEL_LINK_KINDS: readonly PublicChannelLinkKind[] = ['issue', 'milestone', 'project'];

/** The columns of a public channel row. */
export const CHANNEL_COLS = 'name, description, link_kind, link_ref, created_by_id, created_by_name, created_at, updated_at';

/** A public channel as its table keeps it. `link_key` is only for the unique key and is never read back. */
export interface DbPublicChannel {
  name: string;
  description: string;
  link_kind: string | null;
  link_ref: string | null;
  /** The opener's `people.id` (#1284); null once that person is deleted, or for a channel whose opener the upgrade could not tell. */
  created_by_id: number | null;
  created_by_name: string;
  created_at: number;
  updated_at: number;
}

export const toPublicChannel = (r: DbPublicChannel): PublicChannel => ({
  name: r.name,
  description: r.description,
  link: r.link_kind && r.link_ref ? { kind: r.link_kind as PublicChannelLinkKind, ref: r.link_ref } : null,
  createdById: r.created_by_id == null ? null : Number(r.created_by_id),
  createdByName: r.created_by_name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The folded form of a channel name as every method takes it. */
export const channelKey = (name: string): string => String(name).toLowerCase();

/** The unique key of a link: its kind and its reference folded, so `v1.7` and `V1.7` match, and `NULL` (no link) never collides. An issue's reference is stored without its one leading `#` (see `checkNewChannel`), so `#12` and `12` are one link. */
const linkKey = (kind: string, ref: string): string => `${kind}:${ref.toLowerCase()}`;

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
export function checkNewChannel(input: NewPublicChannel): Extract<PublicChannelOutcome, { ok: false }> | { name: string; description: string; link: { kind: PublicChannelLinkKind; ref: string; key: string } | null; createdById: number | null; createdByName: string } {
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
  if (input.createdById !== null && (!Number.isInteger(input.createdById) || input.createdById < 1)) return channelRefusal('invalid', 'A channel needs the person who opens it.');
  return { name, description, link, createdById: input.createdById, createdByName };
}

/** The key of the person a stored direct message was written by, folded (#1269): `person:<folded name>` in `from_session` for a message to someone else's agent or to one's own, and the row's owner in a conversation between two of that person's own agents. */
export const peerPersonKey = (fromSession: string, owner: string): string => nameKey(fromSession.startsWith('person:') ? fromSession.slice('person:'.length) : owner);
