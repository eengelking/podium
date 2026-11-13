// The Chat page's stores on PostgreSQL (#1034): the SQLite store's logic over `PgDb`. The group channel (`group_messages`), General
// (`public_messages`) and each person's read state per thread (`chat_read_state`). Nothing here reads or writes a direct message (the
// conversation table): a channel's text and a conversation's text are in different tables, read by different methods, on purpose.
// Every call that reads then writes is one transaction, and the gate in `PgDb.tx` takes them one at a time, as the SQLite lock does.
import { nameKey } from '../rows.js';
import { decodeCursor, encodeCursor, pageSize } from '../peerText.js';
import {
  CHAT_SCOPE_KEY, channelOwner, chatSettingsOver, checkAuthorKind, emptyReadState, keyList, keyText, mentionsOf, newChannelId, newServerScope, stillOwed, toChannelMessage, withMentionState, type DbChannelRow,
} from '../chatRows.js';
import type { AdminReadKind, AdminReadRow, ChannelMessage, ChannelPage, ChannelPostInput, ChannelStoreApi, ChatAdminReadsApi, ChatReadStateApi, ChatStoreApi, ChatStoreOptions, GroupScope, MentionState, ThreadReadState } from '../types.js';
import type { PgDb } from './conn.js';

const GROUP_COLS = 'id, owner, group_id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq';
const PUBLIC_COLS = 'id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq';

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
  private where(scope: GroupScope | null): { sql: string; args: string[] } {
    return scope ? { sql: 'owner = ? AND group_id = ?', args: [channelOwner(scope.owner), scope.groupId] } : { sql: '1 = 1', args: [] };
  }

  private byId(id: string, scope: GroupScope | null): Promise<DbChannelRow | undefined> {
    const w = this.where(scope);
    return this.db.get<DbChannelRow>(`SELECT ${this.cols} FROM ${this.table} WHERE id = ? AND ${w.sql}`, [id, ...w.args]);
  }

  post(scope: GroupScope | null, input: ChannelPostInput): Promise<ChannelMessage> {
    return this.db.tx(async () => {
      const kind = checkAuthorKind(input.authorKind);
      const at = this.now();
      const mentions = mentionsOf(input, at);
      const id = newChannelId(this.grouped ? 'grp' : 'pub', await this.scope());
      const common = [id, kind, input.authorRef, input.authorName, input.text, at, at, input.issue ?? null, input.project ?? null, input.milestone ?? null, input.replyTo ?? null, JSON.stringify(mentions)] as const;
      // `seq` is the next number in the table: the gate in `PgDb.tx` lets one transaction at a time reach this insert.
      if (scope) {
        await this.db.run(
          `INSERT INTO group_messages (id, owner, group_id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM group_messages))`,
          [common[0], channelOwner(scope.owner), scope.groupId, ...common.slice(1)],
        );
      } else {
        await this.db.run(
          `INSERT INTO public_messages (id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM public_messages))`,
          [...common],
        );
      }
      return toChannelMessage((await this.byId(id, scope)) as DbChannelRow);
    });
  }

  async page(scope: GroupScope | null, opts: { before?: string | null; limit: number }): Promise<ChannelPage> {
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

  setMention(scope: GroupScope | null, id: string, index: number, patch: { state: MentionState; why?: string | null }): Promise<ChannelMessage | null> {
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

  clear(scope: GroupScope | null): Promise<number> {
    const w = this.where(scope);
    return this.db.run(`DELETE FROM ${this.table} WHERE ${w.sql}`, w.args);
  }

  async count(scope: GroupScope | null): Promise<number> {
    const w = this.where(scope);
    return ((await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.table} WHERE ${w.sql}`, w.args)) as { n: number }).n;
  }

  purge(olderThan: number): Promise<number> {
    return this.db.run(`DELETE FROM ${this.table} WHERE created_at < ?`, [olderThan]);
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

/** The records of an Admin reading a thread that is not theirs (`chat_admin_reads`): who, which thread and when. Never any text. */
class PgAdminReads {
  constructor(
    private readonly db: PgDb,
    private readonly now: () => number,
  ) {}

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
    let t = at;
    while (await this.db.get('SELECT 1 AS x FROM chat_admin_reads WHERE thread = ? AND admin_key = ? AND started_at = ?', [thread, key, t])) t++;
    await this.db.run('INSERT INTO chat_admin_reads (thread, admin_key, admin, started_at, last_seen_at, kind, people, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [thread, key, admin, t, t, kind, keyText(people), '[]']);
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
    const who = nameKey(person);
    let n = 0;
    const rows = await this.db.all<DbOwed>('SELECT admin_key, started_at, people, seen FROM chat_admin_reads WHERE thread = ? ORDER BY started_at, admin_key', [thread]);
    for (const r of rows) {
      const seen = keyList(r.seen);
      if (!keyList(r.people).includes(who) || seen.includes(who)) continue;
      await this.db.run('UPDATE chat_admin_reads SET seen = ? WHERE thread = ? AND admin_key = ? AND started_at = ?', [keyText([...seen, who]), thread, r.admin_key, r.started_at]);
      n++;
    }
    return n;
  }

  async unseenFor(person: string): Promise<(AdminReadRow & { thread: string })[]> {
    const who = nameKey(person);
    const rows = await this.db.all<DbAdminRead & { people: string; seen: string }>('SELECT thread, admin, started_at, last_seen_at, kind, people, seen FROM chat_admin_reads ORDER BY started_at DESC, thread, admin_key, kind');
    return rows.filter((r) => keyList(r.people).includes(who) && !keyList(r.seen).includes(who)).map((r) => ({ thread: r.thread, ...toRead(r) }));
  }

  /** Deletes the rows of `rows` that nobody is still owed a look at. */
  private async drop(rows: DbOwed[]): Promise<number> {
    let n = 0;
    for (const r of rows) {
      if (stillOwed(r)) continue;
      n += await this.db.run('DELETE FROM chat_admin_reads WHERE thread = ? AND admin_key = ? AND started_at = ?', [r.thread, r.admin_key, r.started_at]);
    }
    return n;
  }

  async forget(thread: string): Promise<number> {
    return this.drop(await this.db.all<DbOwed>('SELECT thread, admin_key, started_at, people, seen FROM chat_admin_reads WHERE thread = ? ORDER BY started_at, admin_key', [thread]));
  }

  async purge(olderThan: number): Promise<number> {
    return this.drop(await this.db.all<DbOwed>('SELECT thread, admin_key, started_at, people, seen FROM chat_admin_reads WHERE last_seen_at < ? ORDER BY thread, started_at, admin_key', [olderThan]));
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
    clear: (s) => group.clear(s),
    count: (s) => group.count(s),
    purge: (olderThan) => group.purge(olderThan),
  };
  const publicApi: ChannelStoreApi<[]> = {
    post: (input) => pub.post(null, input),
    page: (o) => pub.page(null, o),
    setMention: (id, index, patch) => pub.setMention(null, id, index, patch),
    clear: () => pub.clear(null),
    count: () => pub.count(null),
    purge: (olderThan) => pub.purge(olderThan),
  };
  const settings = chatSettingsOver({
    get: async (key) => (await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]))?.value,
    set: async (key, value) => void (await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])),
    del: async (key) => void (await db.run('DELETE FROM settings WHERE key = ?', [key])),
    prefixed: (prefix) => db.all<{ key: string; value: string }>('SELECT key, value FROM settings WHERE substr(key, 1, ?) = ? ORDER BY key', [prefix.length, prefix]),
  });
  return { serverScope: () => scope(), group: groupApi, public: publicApi, readState, adminReads, settings };
}
