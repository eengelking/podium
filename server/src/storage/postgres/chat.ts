// The Chat page's stores on PostgreSQL (#1034): the SQLite store's logic over `PgDb`. The group channel (`group_messages`), General
// (`public_messages`) and each person's read state per thread (`chat_read_state`). Nothing here reads or writes a direct message (the
// conversation table): a channel's text and a conversation's text are in different tables, read by different methods, on purpose.
// Every call that reads then writes is one transaction, and the gate in `PgDb.tx` takes them one at a time, as the SQLite lock does.
import { nameKey } from '../rows.js';
import { decodeCursor, encodeCursor, pageSize } from '../peerText.js';
import {
  CHANNEL_COLS, CHAT_SCOPE_KEY, GENERAL_CHANNEL, MAX_PUBLIC_CHANNELS, channelKey, channelOwner, channelRefusal, chatSettingsOver, checkAuthorKind, checkDescription, checkNewChannel, emptyReadState, heldLikes, holdsHeld, keyList, keyText, mentionsOf, newChannelId, newServerScope, OWED_CAP_MS, OWED_FILLED_KEY, owedKeys, toChannelMessage, toPublicChannel, withMentionState, type DbChannelRow, type DbPublicChannel,
} from '../chatRows.js';
import type { AdminReadKind, AdminReadRow, ChannelMessage, ChannelPage, ChannelPostInput, ChannelStoreApi, ChatAdminReadsApi, ChatReadStateApi, ChatStoreApi, ChatStoreOptions, GroupScope, MentionState, NewPublicChannel, PublicChannel, PublicChannelOutcome, PublicChannelsApi, ThreadReadState } from '../types.js';
import type { PgDb } from './conn.js';

const GROUP_COLS = 'id, owner, group_id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq';
const PUBLIC_COLS = 'id, channel, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq';

/** Which messages of a table: one person's group, or one public channel (#1035). */
type Scope = GroupScope | { channel: string };

/** One channel table. The group table's every statement is scoped to an owner and a group. */
class PgChannel {
  constructor(
    private readonly db: PgDb,
    private readonly table: 'group_messages' | 'public_messages',
    private readonly now: () => number,
    private readonly scope: () => Promise<string>,
  ) {}

  private get grouped(): boolean {
    return this.table === 'group_messages';
  }

  private get cols(): string {
    return this.grouped ? GROUP_COLS : PUBLIC_COLS;
  }

  /** The `WHERE` for the channel and the values that fill it. */
  private where(scope: Scope): { sql: string; args: string[] } {
    return 'channel' in scope ? { sql: 'channel = ?', args: [scope.channel] } : { sql: 'owner = ? AND group_id = ?', args: [channelOwner(scope.owner), scope.groupId] };
  }

  private byId(id: string, scope: Scope): Promise<DbChannelRow | undefined> {
    const w = this.where(scope);
    return this.db.get<DbChannelRow>(`SELECT ${this.cols} FROM ${this.table} WHERE id = ? AND ${w.sql}`, [id, ...w.args]);
  }

  post(scope: Scope, input: ChannelPostInput): Promise<ChannelMessage> {
    return this.db.tx(async () => {
      const kind = checkAuthorKind(input.authorKind);
      const at = this.now();
      const mentions = mentionsOf(input, at);
      const id = newChannelId(this.grouped ? 'grp' : 'pub', await this.scope());
      const common = [id, kind, input.authorRef, input.authorName, input.text, at, at, input.issue ?? null, input.project ?? null, input.milestone ?? null, input.replyTo ?? null, JSON.stringify(mentions)] as const;
      // `seq` is the next number in the table: the gate in `PgDb.tx` lets one transaction at a time reach this insert.
      if (!('channel' in scope)) {
        await this.db.run(
          `INSERT INTO group_messages (id, owner, group_id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM group_messages))`,
          [common[0], channelOwner(scope.owner), scope.groupId, ...common.slice(1)],
        );
      } else {
        // A channel that is not General must exist, so a post can never fill a channel an Admin has just removed.
        if (scope.channel !== GENERAL_CHANNEL && !(await this.db.get('SELECT 1 AS x FROM public_channels WHERE name = ?', [scope.channel]))) throw new Error('There is no such public channel.');
        await this.db.run(
          `INSERT INTO public_messages (id, channel, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM public_messages))`,
          [common[0], scope.channel, ...common.slice(1)],
        );
      }
      return toChannelMessage((await this.byId(id, scope)) as DbChannelRow);
    });
  }

  async page(scope: Scope, opts: { before?: string | null; limit: number }): Promise<ChannelPage> {
    const before = opts.before === undefined || opts.before === null ? null : decodeCursor(opts.before);
    const limit = pageSize(opts.limit);
    const w = this.where(scope);
    const rows = before
      ? await this.db.all<DbChannelRow>(`SELECT ${this.cols} FROM ${this.table} WHERE ${w.sql} AND (created_at < ? OR (created_at = ? AND seq < ?)) ORDER BY created_at DESC, seq DESC LIMIT ?`, [...w.args, before.at, before.at, before.seq, limit + 1])
      : await this.db.all<DbChannelRow>(`SELECT ${this.cols} FROM ${this.table} WHERE ${w.sql} ORDER BY created_at DESC, seq DESC LIMIT ?`, [...w.args, limit + 1]);
    // The extra row only says there is an older page; the cursor names the oldest row kept.
    const kept = rows.slice(0, limit).reverse();
    const oldest = kept[0];
    return { messages: kept.map(toChannelMessage), older: rows.length > limit && oldest ? encodeCursor(oldest.created_at, oldest.seq) : null };
  }

  setMention(scope: Scope, id: string, index: number, patch: { state: MentionState; why?: string | null }): Promise<ChannelMessage | null> {
    return this.db.tx(async () => {
      const row = await this.byId(id, scope);
      if (!row) return null;
      const at = this.now();
      const next = withMentionState(toChannelMessage(row).mentions, index, patch, at);
      if (!next) return null;
      await this.db.run(`UPDATE ${this.table} SET mentions_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(next), at, id]);
      return toChannelMessage((await this.byId(id, scope)) as DbChannelRow);
    });
  }

  async heldMentions(scope: Scope, filter: { sessionId?: string }): Promise<ChannelMessage[]> {
    const w = this.where(scope);
    const likes = heldLikes(filter.sessionId);
    const rows = await this.db.all<DbChannelRow>(
      `SELECT ${this.cols} FROM ${this.table} WHERE ${w.sql} AND ${likes.map(() => 'mentions_json LIKE ?').join(' AND ')} ORDER BY created_at, seq`,
      [...w.args, ...likes],
    );
    return rows.map(toChannelMessage).filter((m) => holdsHeld(m, filter.sessionId));
  }

  clear(scope: Scope): Promise<number> {
    const w = this.where(scope);
    return this.db.run(`DELETE FROM ${this.table} WHERE ${w.sql}`, w.args);
  }

  async count(scope: Scope): Promise<number> {
    const w = this.where(scope);
    return ((await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.table} WHERE ${w.sql}`, w.args)) as { n: number }).n;
  }

  purge(olderThan: number): Promise<number> {
    return this.db.run(`DELETE FROM ${this.table} WHERE created_at < ?`, [olderThan]);
  }
}

/** The public channels beside General (#1035): the rows of `public_channels`. Their messages are `public_messages` rows keyed by the channel. Each call that reads then writes is one transaction, and the gate in `PgDb.tx` takes them one at a time, so the limit and the keys are checked and written with no other insert between. */
class PgPublicChannels {
  constructor(private readonly db: PgDb) {}

  private row(name: string): Promise<DbPublicChannel | undefined> {
    return this.db.get<DbPublicChannel>(`SELECT ${CHANNEL_COLS} FROM public_channels WHERE name = ?`, [name]);
  }

  create(input: NewPublicChannel, at: number): Promise<PublicChannelOutcome> {
    const c = checkNewChannel(input);
    if ('ok' in c) return Promise.resolve(c);
    return this.db.tx(async () => {
      if (await this.row(c.name)) return channelRefusal('name-taken', `There is already a channel named ${c.name}.`);
      if (c.link && (await this.db.get('SELECT 1 AS x FROM public_channels WHERE link_key = ?', [c.link.key]))) return channelRefusal('link-taken', 'That link already has a channel.');
      const have = ((await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM public_channels')) as { n: number }).n;
      if (Number(have) >= MAX_PUBLIC_CHANNELS) return channelRefusal('limit-reached', `There are already ${MAX_PUBLIC_CHANNELS} channels besides General.`);
      await this.db.run(
        `INSERT INTO public_channels (name, description, link_kind, link_ref, link_key, created_by, created_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.name, c.description, c.link?.kind ?? null, c.link?.ref ?? null, c.link?.key ?? null, c.createdBy, c.createdByName, at, at],
      );
      return { ok: true as const, channel: toPublicChannel((await this.row(c.name)) as DbPublicChannel) };
    });
  }

  async list(): Promise<PublicChannel[]> {
    return (await this.db.all<DbPublicChannel>(`SELECT ${CHANNEL_COLS} FROM public_channels ORDER BY name`)).map(toPublicChannel);
  }

  async get(name: string): Promise<PublicChannel | null> {
    const r = await this.row(channelKey(name));
    return r ? toPublicChannel(r) : null;
  }

  updateDescription(name: string, description: string, at: number): Promise<PublicChannelOutcome> {
    const key = channelKey(name);
    return this.db.tx(async () => {
      if (!(await this.row(key))) return channelRefusal('not-found', 'There is no such public channel.');
      const bad = checkDescription(description);
      if (bad) return bad;
      await this.db.run('UPDATE public_channels SET description = ?, updated_at = ? WHERE name = ?', [description, at, key]);
      return { ok: true as const, channel: toPublicChannel((await this.row(key)) as DbPublicChannel) };
    });
  }

  remove(name: string): Promise<{ removed: boolean; messages: number }> {
    const key = channelKey(name);
    return this.db.tx(async () => {
      if (!(await this.row(key))) return { removed: false, messages: 0 };
      const messages = await this.db.run('DELETE FROM public_messages WHERE channel = ?', [key]);
      await this.db.run('DELETE FROM public_channels WHERE name = ?', [key]);
      return { removed: true, messages };
    });
  }

  async count(): Promise<number> {
    return Number(((await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM public_channels')) as { n: number }).n);
  }
}

interface DbReadState {
  person: string;
  thread: string;
  last_read: string | null;
  unread: number;
  mentions: number;
  updated_at: number;
}

const toState = (r: DbReadState): ThreadReadState => ({ person: r.person, thread: r.thread, lastRead: r.last_read, unread: r.unread, mentions: r.mentions, updatedAt: r.updated_at });

class PgReadState {
  constructor(
    private readonly db: PgDb,
    private readonly now: () => number,
  ) {}

  async get(person: string, thread: string): Promise<ThreadReadState> {
    const r = await this.db.get<DbReadState>('SELECT person, thread, last_read, unread, mentions, updated_at FROM chat_read_state WHERE person = ? AND thread = ?', [nameKey(person), thread]);
    return r ? toState(r) : emptyReadState(person, thread);
  }

  async list(person: string): Promise<ThreadReadState[]> {
    return (await this.db.all<DbReadState>('SELECT person, thread, last_read, unread, mentions, updated_at FROM chat_read_state WHERE person = ? ORDER BY thread', [nameKey(person)])).map(toState);
  }

  async bump(person: string, thread: string, mention: boolean): Promise<ThreadReadState> {
    await this.db.run(
      `INSERT INTO chat_read_state (person, thread, last_read, unread, mentions, updated_at) VALUES (?, ?, NULL, 1, ?, ?)
       ON CONFLICT(person, thread) DO UPDATE SET unread = chat_read_state.unread + 1, mentions = chat_read_state.mentions + excluded.mentions, updated_at = excluded.updated_at`,
      [nameKey(person), thread, mention ? 1 : 0, this.now()],
    );
    return this.get(person, thread);
  }

  async markRead(person: string, thread: string, upTo: string | null): Promise<ThreadReadState> {
    await this.db.run(
      `INSERT INTO chat_read_state (person, thread, last_read, unread, mentions, updated_at) VALUES (?, ?, ?, 0, 0, ?)
       ON CONFLICT(person, thread) DO UPDATE SET last_read = excluded.last_read, unread = 0, mentions = 0, updated_at = excluded.updated_at`,
      [nameKey(person), thread, upTo, this.now()],
    );
    return this.get(person, thread);
  }

  forget(thread: string): Promise<number> {
    return this.db.run('DELETE FROM chat_read_state WHERE thread = ?', [thread]);
  }

  async threads(prefix: string): Promise<string[]> {
    return (await this.db.all<{ thread: string }>('SELECT DISTINCT thread FROM chat_read_state WHERE substr(thread, 1, ?) = ? ORDER BY thread', [prefix.length, prefix])).map((r) => r.thread);
  }
}

interface DbAdminRead {
  thread: string;
  admin: string;
  started_at: number;
  last_seen_at: number;
  kind: AdminReadKind;
}

interface DbOwed {
  thread: string;
  admin_key: string;
  started_at: number;
  people: string;
  seen: string;
}

const toRead = (r: DbAdminRead): AdminReadRow => ({ admin: r.admin, startedAt: r.started_at, lastSeenAt: r.last_seen_at, kind: r.kind });

/** One person owed one Admin record (#1061). */
const owe = async (db: PgDb, thread: string, adminKey: string, startedAt: number, people: string[]): Promise<void> => {
  for (const p of people) await db.run('INSERT INTO chat_admin_owed (person_key, thread, admin_key, started_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [p, thread, adminKey, startedAt]);
};

/** Once per database, fills `chat_admin_owed` from the lists of the records made before it (#1061); the key is set last, so an interrupted fill runs again and adds nothing twice. */
export async function fillOwed(db: PgDb): Promise<void> {
  if (await db.get('SELECT 1 AS x FROM settings WHERE key = ?', [OWED_FILLED_KEY])) return;
  const rows = await db.all<DbOwed>("SELECT thread, admin_key, started_at, people, seen FROM chat_admin_reads WHERE people <> '[]' ORDER BY thread, started_at, admin_key");
  for (const r of rows) await owe(db, r.thread, r.admin_key, r.started_at, owedKeys(r));
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', [OWED_FILLED_KEY, '1']);
}

/** The records of an Admin reading a thread that is not theirs (`chat_admin_reads`): who, which thread and when. Never any text. */
class PgAdminReads {
  private filled: Promise<void> | null = null;

  constructor(
    private readonly db: PgDb,
    private readonly now: () => number,
  ) {}

  private ready(): Promise<void> {
    return (this.filled ??= fillOwed(this.db).catch((e: unknown) => {
      this.filled = null;
      throw e;
    }));
  }

  async touch(thread: string, admin: string, gapMs: number, people: string[] = []): Promise<{ record: AdminReadRow; started: boolean; previousSeenAt: number | null }> {
    const now = this.now();
    const key = nameKey(admin);
    const last = await this.db.get<DbAdminRead>("SELECT thread, admin, started_at, last_seen_at, kind FROM chat_admin_reads WHERE thread = ? AND admin_key = ? AND kind = 'read' ORDER BY last_seen_at DESC, started_at DESC LIMIT 1", [thread, key]);
    if (last && now - last.last_seen_at <= gapMs) {
      const seen = Math.max(now, last.last_seen_at);
      await this.db.run("UPDATE chat_admin_reads SET last_seen_at = ? WHERE thread = ? AND admin_key = ? AND started_at = ? AND kind = 'read'", [seen, thread, key, last.started_at]);
      return { record: { admin: last.admin, startedAt: last.started_at, lastSeenAt: seen, kind: 'read' }, started: false, previousSeenAt: last.last_seen_at };
    }
    const row = await this.insert(thread, key, admin, now, 'read', people);
    return { record: row, started: true, previousSeenAt: null };
  }

  mark(thread: string, admin: string, kind: Exclude<AdminReadKind, 'read'>, people: string[] = []): Promise<AdminReadRow> {
    return this.insert(thread, nameKey(admin), admin, this.now(), kind, people);
  }

  /** One record at `at`, or the first free millisecond after it, since (thread, admin, time) is the key. */
  private async insert(thread: string, key: string, admin: string, at: number, kind: AdminReadKind, people: string[]): Promise<AdminReadRow> {
    await this.ready();
    let t = at;
    while (await this.db.get('SELECT 1 AS x FROM chat_admin_reads WHERE thread = ? AND admin_key = ? AND started_at = ?', [thread, key, t])) t++;
    await this.db.run('INSERT INTO chat_admin_reads (thread, admin_key, admin, started_at, last_seen_at, kind, people, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [thread, key, admin, t, t, kind, keyText(people), '[]']);
    await owe(this.db, thread, key, t, keyList(keyText(people)));
    return { admin, startedAt: t, lastSeenAt: t, kind };
  }

  async list(thread: string): Promise<AdminReadRow[]> {
    return (await this.db.all<DbAdminRead>('SELECT thread, admin, started_at, last_seen_at, kind FROM chat_admin_reads WHERE thread = ? ORDER BY started_at, admin_key, kind', [thread])).map(toRead);
  }

  async live(threads: string[], since: number): Promise<(AdminReadRow & { thread: string })[]> {
    if (!threads.length) return [];
    const marks = threads.map(() => '?').join(', ');
    const rows = await this.db.all<DbAdminRead>(
      `SELECT thread, admin, started_at, last_seen_at, kind FROM chat_admin_reads WHERE thread IN (${marks}) AND kind = 'read' AND last_seen_at > ? ORDER BY thread, started_at, admin_key`,
      [...threads, since],
    );
    return rows.map((r) => ({ thread: r.thread, ...toRead(r) }));
  }

  async recent(since: number): Promise<(AdminReadRow & { thread: string })[]> {
    const rows = await this.db.all<DbAdminRead>("SELECT thread, admin, started_at, last_seen_at, kind FROM chat_admin_reads WHERE kind = 'read' AND last_seen_at > ? ORDER BY thread, started_at, admin_key", [since]);
    return rows.map((r) => ({ thread: r.thread, ...toRead(r) }));
  }

  async threads(prefix: string): Promise<string[]> {
    return (await this.db.all<{ thread: string }>('SELECT DISTINCT thread FROM chat_admin_reads WHERE substr(thread, 1, ?) = ? ORDER BY thread', [prefix.length, prefix])).map((r) => r.thread);
  }

  async seen(thread: string, person: string): Promise<number> {
    await this.ready();
    return this.db.run('DELETE FROM chat_admin_owed WHERE person_key = ? AND thread = ?', [nameKey(person), thread]);
  }

  async unseenFor(person: string): Promise<(AdminReadRow & { thread: string })[]> {
    await this.ready();
    const rows = await this.db.all<DbAdminRead>(
      `SELECT r.thread, r.admin, r.started_at, r.last_seen_at, r.kind FROM chat_admin_owed o
       JOIN chat_admin_reads r ON r.thread = o.thread AND r.admin_key = o.admin_key AND r.started_at = o.started_at
       WHERE o.person_key = ? ORDER BY r.started_at DESC, r.thread, r.admin_key, r.kind`,
      [nameKey(person)],
    );
    return rows.map((r) => ({ thread: r.thread, ...toRead(r) }));
  }

  /** Deletes the records matched by `where` that nobody is still owed a look at. */
  private async drop(where: string, values: (string | number)[]): Promise<number> {
    await this.ready();
    return this.db.run(`DELETE FROM chat_admin_reads WHERE ${where} AND NOT EXISTS (SELECT 1 FROM chat_admin_owed o WHERE o.thread = chat_admin_reads.thread AND o.admin_key = chat_admin_reads.admin_key AND o.started_at = chat_admin_reads.started_at)`, values);
  }

  forget(thread: string): Promise<number> {
    return this.drop('thread = ?', [thread]);
  }

  /** A record last read 90 days ago or more stops being owed to the people who have not seen it, then goes with the rest that are past `olderThan`. */
  async purge(olderThan: number): Promise<number> {
    await this.ready();
    const capped = await this.db.all<DbOwed>('SELECT thread, admin_key, started_at FROM chat_admin_reads WHERE last_seen_at < ? ORDER BY thread, started_at, admin_key', [this.now() - OWED_CAP_MS]);
    for (const r of capped) await this.db.run('DELETE FROM chat_admin_owed WHERE thread = ? AND admin_key = ? AND started_at = ?', [r.thread, r.admin_key, r.started_at]);
    return this.drop('last_seen_at < ?', [olderThan]);
  }
}

/** This server's scope, minted on first use and kept in `settings`. */
function scopeOf(db: PgDb): () => Promise<string> {
  let known: string | null = null;
  return async () => {
    if (known) return known;
    const read = async (): Promise<string | undefined> => (await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [CHAT_SCOPE_KEY]))?.value;
    let v = await read();
    if (!v) {
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', [CHAT_SCOPE_KEY, newServerScope()]);
      v = (await read()) as string;
    }
    known = v;
    return v;
  };
}

/** The Chat stores over the pool. */
export function pgChat(db: PgDb, opts: ChatStoreOptions): ChatStoreApi {
  const scope = scopeOf(db);
  const group = new PgChannel(db, 'group_messages', opts.now, scope);
  const pub = new PgChannel(db, 'public_messages', opts.now, scope);
  const state = new PgReadState(db, opts.now);
  const reads = new PgAdminReads(db, opts.now);
  const readState: ChatReadStateApi = {
    get: (person, thread) => state.get(person, thread),
    list: (person) => state.list(person),
    bump: (person, thread, mention) => db.tx(() => state.bump(person, thread, mention)),
    markRead: (person, thread, upTo) => db.tx(() => state.markRead(person, thread, upTo)),
    forget: (thread) => state.forget(thread),
    threads: (prefix) => state.threads(prefix),
  };
  const adminReads: ChatAdminReadsApi = {
    touch: (thread, admin, gapMs, people) => db.tx(() => reads.touch(thread, admin, gapMs, people)),
    mark: (thread, admin, kind, people) => db.tx(() => reads.mark(thread, admin, kind, people)),
    list: (thread) => reads.list(thread),
    live: (threads, since) => reads.live(threads, since),
    recent: (since) => reads.recent(since),
    threads: (prefix) => reads.threads(prefix),
    unseenFor: (person) => reads.unseenFor(person),
    seen: (thread, person) => db.tx(() => reads.seen(thread, person)),
    forget: (thread) => db.tx(() => reads.forget(thread)),
    purge: (olderThan) => db.tx(() => reads.purge(olderThan)),
  };
  const groupApi: ChannelStoreApi<[GroupScope]> = {
    post: (s, input) => group.post(s, input),
    page: (s, o) => group.page(s, o),
    setMention: (s, id, index, patch) => group.setMention(s, id, index, patch),
    heldMentions: (s, filter) => group.heldMentions(s, filter),
    clear: (s) => group.clear(s),
    count: (s) => group.count(s),
    purge: (olderThan) => group.purge(olderThan),
  };
  const inChannel = (c: string): { channel: string } => ({ channel: channelKey(c) });
  const publicApi: ChannelStoreApi<[string]> = {
    post: (c, input) => pub.post(inChannel(c), input),
    page: (c, o) => pub.page(inChannel(c), o),
    setMention: (c, id, index, patch) => pub.setMention(inChannel(c), id, index, patch),
    heldMentions: (c, filter) => pub.heldMentions(inChannel(c), filter),
    clear: (c) => pub.clear(inChannel(c)),
    count: (c) => pub.count(inChannel(c)),
    purge: (olderThan) => pub.purge(olderThan),
  };
  const channels = new PgPublicChannels(db);
  const channelsApi: PublicChannelsApi = {
    create: (input, at) => channels.create(input, at),
    list: () => channels.list(),
    get: (name) => channels.get(name),
    updateDescription: (name, description, at) => channels.updateDescription(name, description, at),
    remove: (name) => channels.remove(name),
    count: () => channels.count(),
  };
  const settings = chatSettingsOver({
    get: async (key) => (await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]))?.value,
    set: async (key, value) => void (await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])),
    del: async (key) => void (await db.run('DELETE FROM settings WHERE key = ?', [key])),
    prefixed: (prefix) => db.all<{ key: string; value: string }>('SELECT key, value FROM settings WHERE substr(key, 1, ?) = ? ORDER BY key', [prefix.length, prefix]),
  });
  return { serverScope: () => scope(), group: groupApi, public: publicApi, channels: channelsApi, readState, adminReads, settings };
}
