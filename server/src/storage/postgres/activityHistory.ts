// The Activity history on PostgreSQL (#822), in the `podium_activity` schema. The surface is `sqlite/activityHistory.ts`'s with the
// database work asynchronous. What it keeps, and what removes it, are described there. What differs: a multi-statement step runs in
// `db.tx`; the space of removed rows is PostgreSQL's autovacuum's to give back, so `compactNow` has nothing to do and `freed` is 0.
import type { ActivityEntryView } from '../../fleet/activity.js';
import {
  ACTIVITY_HISTORY_PAGE,
  ACTIVITY_HISTORY_PAGE_MAX,
  type ActivityHistoryNote,
  type ActivityHistoryPreview,
  type ActivityHistorySettings,
  type LastPurge,
  type StoredActivityList,
  type StoredDeleteBody,
  type StoredDeleteResult,
  type StoredFilter,
  type StoredSessionRow,
  type StoredTotals,
} from '../../fleet/activityHistoryTypes.js';
import { LIMITS, MAIN_LOOP, type ActivityEntry, type Report } from '../../fleet/protocol.js';
import { activityPeriodMs } from '../settings.js';
import type { PurgeResult, SessionMeta } from '../rows.js';
import type { PgDb } from './conn.js';
import type { PgHistoryOptions } from './activityTypes.js';

type Param = string | number | null;

/** Where a loop stands: the next sequence number, and the newest reporter entry's time with the entries stored at that time. */
interface Tail {
  seq: number;
  lastAt: number | null;
  same: Set<string>;
}

const DAY_MS = 86_400_000;
const CHUNK_ROWS = 5000;
const CHUNK_MS = 25;
/** The first chunk of a removal: small, because what a row costs to delete is not known until one has been. */
const FIRST_CHUNK = 500;
const SLICE_ROWS = 20_000;
/** Ids bound in one `DELETE ... WHERE id IN (?, ...)` (#808): a fixed size keeps the statement within the limit on bound parameters. */
const DELETE_BATCH = 200;

/** Gives the event loop a turn: queued requests, timers and reports run before the next chunk. */
const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** ASCII-only lowercase, the SQLite `lower()` and the main schema's `podium_lower`, inline because that function lives in the main schema and this pool sees only its own. */
const lowerSql = (col: string): string => `translate(${col}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;

const like = (q: string) => `%${q.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;

/**
 * A time bound as a whole millisecond. The columns are integers and PostgreSQL refuses a fraction for them; for a whole `t`, `t < x`
 * and `t >= x` mean the same with `x` rounded up.
 */
const whole = (ms: number): number => Math.ceil(ms);

/** The size of one stored entry as the Stored activity table counts it: its text, a Bash command (#431) and labels, plus 48 bytes of row overhead. `a` is a table alias with its dot, or ''. */
export const entryBytesSql = (a = ''): string =>
  `(length(${a}text) + length(${a}kind) + length(${a}loop) + COALESCE(length(${a}"by"), 0) + COALESCE(length(${a}note), 0) + COALESCE(length(${a}ref), 0) + COALESCE(length(${a}command), 0) + 48)`;

/** A row chosen for removal, with its size. */
interface VictimRow {
  id: number;
  sid: string;
  loop: string;
  b: number;
}

/** What a removal touched, so its aggregates can be settled at the end: the sessions, and the (session, loop) pairs. */
interface Touched {
  sessions: Set<string>;
  loops: Map<string, { sid: string; loop: string }>;
}
const newTouched = (): Touched => ({ sessions: new Set(), loops: new Map() });

/** A stored session as the list works with it. `lastT` is the newest time ever stored for it, an upper bound. */
type CandidateRow = Omit<StoredSessionRow, 'live'> & { lastT: number };

interface EntryRow {
  seq: number;
  at: number;
  kind: string;
  text: string;
  by: string | null;
  note: string | null;
  command: string | null;
  command_cut: number | null;
}

const viewOf = (r: EntryRow): ActivityEntryView =>
  r.kind === 'podium'
    ? { seq: r.seq, at: r.at, kind: 'podium', text: r.text, by: r.by ?? undefined, note: r.note }
    : {
        seq: r.seq,
        at: r.at,
        kind: r.kind as ActivityEntry['kind'],
        text: r.text,
        // Only the command is stored (#431); a stored row never has output, an exit status or a call id.
        ...(r.command === null ? {} : { command: r.command }),
        ...(r.command_cut ? { commandCut: true } : {}),
      };

export class PgActivityHistory {
  private readonly tails = new Map<string, Tail>();
  private last: LastPurge | null = null;
  private readonly chunk: number;
  private readonly chunkMs: number;
  private readonly sliceRows: number;
  private chain: Promise<void> = Promise.resolve();
  private running = 0;
  private closed = false;

  constructor(
    protected readonly db: PgDb,
    protected readonly opts: PgHistoryOptions,
  ) {
    this.chunk = Math.max(opts.chunkRows ?? CHUNK_ROWS, 1);
    this.chunkMs = opts.chunkMs ?? CHUNK_MS;
    this.sliceRows = Math.max(opts.sliceRows ?? SLICE_ROWS, 1);
  }

  /** The Admin's settings as they stand now. */
  current(): ActivityHistorySettings {
    return this.opts.settings();
  }

  /** Whether entries are being captured: a keep policy, a server with a token, and the `activity-feed` flag on. */
  enabled(): boolean {
    return this.opts.authOn && this.opts.settings().policy !== 'default' && (this.opts.featureOn?.() ?? true);
  }

  /** The loops the server asks the mod to send for a session: the orchestrator and every running agent. */
  loopsToWatch(sessionId: string, agents: string[] | undefined = this.opts.agentsOf?.(sessionId)): string[] {
    return [MAIN_LOOP, ...(agents ?? [])];
  }

  /** The last run of the purge that removed something, or null if none has since the server started. */
  get lastPurge(): LastPurge | null {
    return this.last;
  }

  /** A purge or delete still running stops at its next chunk. */
  stop(): void {
    this.closed = true;
  }

  get stopped(): boolean {
    return this.closed;
  }

  /** One step of a chunked operation: under the adapter's lock when there is one, otherwise at once. */
  private step<T>(fn: () => Promise<T>): Promise<T> {
    return this.opts.step ? this.opts.step(fn) : fn();
  }

  // ---- capture --------------------------------------------------------------------------------

  /**
   * Stores what is new in a report's snapshots, for the orchestrator and every agent, whether or not anyone watches. An
   * entry already stored (same time, kind and text) or older than the loop's newest stored entry is skipped, so the
   * overlapping 20-entry snapshots add each entry once. `skewMs` is the report's `sentAt` minus the server's time.
   * Returns how many entries were stored.
   */
  async ingest(report: Report, skewMs: number, meta: SessionMeta): Promise<number> {
    if (!this.enabled()) return 0;
    const sid = report.session.id;
    const lists: [string, ActivityEntry[] | undefined][] = [[MAIN_LOOP, report.session.activity], ...report.agents.map((a): [string, ActivityEntry[] | undefined] => [a.id, a.activity])];
    if (!lists.some(([, l]) => l?.length)) return 0;
    let stored = 0;
    let bytes = 0;
    let firstT = Infinity;
    let lastT = -Infinity;
    await this.tx(sid, async () => {
      for (const [loop, list] of lists) {
        let n = 0;
        let firstAt = 0;
        let newestT = 0;
        for (const e of list ?? []) {
          const b = await this.take(sid, loop, e, skewMs);
          if (b === null) continue;
          const t = e.at - skewMs;
          firstT = Math.min(firstT, t);
          lastT = Math.max(lastT, t);
          if (!n) firstAt = e.at;
          newestT = t;
          bytes += b;
          stored++;
          n++;
        }
        if (n) await this.touchLoop(sid, loop, n, firstAt, newestT);
      }
      if (stored) await this.touchSession(sid, meta, firstT, lastT, stored, bytes);
    });
    return stored;
  }

  /** Stores one reporter entry unless it repeats one already stored. Returns its size, or null when it was skipped. */
  private async take(sid: string, loop: string, e: ActivityEntry, skewMs: number): Promise<number | null> {
    const tail = await this.tail(sid, loop);
    const text = e.text.slice(0, LIMITS.activityText);
    const key = `${e.kind} ${text}`;
    if (tail.lastAt !== null) {
      if (e.at < tail.lastAt) return null;
      if (e.at === tail.lastAt && tail.same.has(key)) return null;
    }
    if (tail.lastAt !== e.at) {
      tail.lastAt = e.at;
      tail.same = new Set();
    }
    tail.same.add(key);
    const command = e.kind === 'tool' && typeof e.command === 'string' ? e.command.slice(0, LIMITS.activityDetail) : null;
    return this.insert(sid, loop, ++tail.seq, e.at, e.at - skewMs, e.kind, text, null, null, null, command, command !== null && e.commandCut === true);
  }

  /**
   * An answer, message or command sent from Podium, as an entry of the loop it is about. Podium's own time is the server's,
   * so `at` and `t` agree. It keeps its ref (to update the note later), who sent it and the note.
   */
  async addPodium(sessionId: string, loop: string, ref: string, e: { at: number; text: string; by: string; note: string | null }, meta: SessionMeta): Promise<void> {
    if (!this.enabled()) return;
    await this.tx(sessionId, async () => {
      const tail = await this.tail(sessionId, loop);
      const b = await this.insert(sessionId, loop, ++tail.seq, e.at, e.at, 'podium', e.text.slice(0, LIMITS.activityText), e.by, e.note, ref);
      await this.touchSession(sessionId, meta, e.at, e.at, 1, b);
      await this.touchLoop(sessionId, loop, 1, e.at, e.at);
    });
  }

  /** A Podium entry's note changed (queued, then taken). The session's byte count follows the note's length. */
  async updatePodium(sessionId: string, ref: string, note: string | null): Promise<void> {
    const size = async () => (await this.db.get<{ b: number }>(`SELECT COALESCE(SUM(${entryBytesSql()}), 0) AS b FROM entries WHERE session_id = ? AND ref = ?`, [sessionId, ref]))!.b;
    await this.db.tx(async () => {
      const before = await size();
      await this.db.run('UPDATE entries SET note = ? WHERE session_id = ? AND ref = ?', [note, sessionId, ref]);
      const delta = (await size()) - before;
      if (delta) await this.db.run('UPDATE stored_sessions SET bytes = bytes + ? WHERE session_id = ?', [delta, sessionId]);
    });
  }

  /** A Podium entry for something the session never took (discarded, refused, or the ask closed first). */
  async removePodium(sessionId: string, ref: string): Promise<void> {
    await this.db.tx(async () => {
      const gone = await this.db.all<{ loop: string; b: number }>(`DELETE FROM entries WHERE session_id = ? AND ref = ? RETURNING loop, ${entryBytesSql()} AS b`, [sessionId, ref]);
      if (!gone.length) return;
      const touched = newTouched();
      await this.db.run('UPDATE stored_sessions SET entries = entries - ?, bytes = bytes - ? WHERE session_id = ?', [gone.length, gone.reduce((a, r) => a + r.b, 0), sessionId]);
      for (const r of gone) {
        await this.db.run('UPDATE loops SET entries = entries - 1 WHERE session_id = ? AND loop = ?', [sessionId, r.loop]);
        touched.loops.set(`${sessionId}\u0000${r.loop}`, { sid: sessionId, loop: r.loop });
      }
      touched.sessions.add(sessionId);
      await this.finish(touched);
    });
  }

  /** The session left the live set: its in-memory loop positions go. Its rows stay, and the positions reload when it reports again. */
  forgetSession(sessionId: string): void {
    for (const key of [...this.tails.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.tails.delete(key);
  }

  /** Inserts one entry and returns its size as the aggregates count it. */
  private async insert(sid: string, loop: string, seq: number, at: number, t: number, kind: string, text: string, by: string | null, note: string | null, ref: string | null, command: string | null = null, commandCut = false): Promise<number> {
    const row = await this.db.get<{ b: number }>(`INSERT INTO entries (session_id, loop, seq, at, t, kind, text, "by", note, ref, command, command_cut) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${entryBytesSql()} AS b`, [sid, loop, seq, at, t, kind, text, by, note, ref, command, commandCut ? 1 : null]);
    return row!.b;
  }

  private async touchSession(sid: string, meta: SessionMeta, firstT: number, lastT: number, entries: number, bytes: number): Promise<void> {
    await this.db.run(
      `INSERT INTO stored_sessions (session_id, name, project, owner, first_t, last_t, entries, bytes, oldest_t) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET name = excluded.name, project = excluded.project, owner = excluded.owner,
         first_t = LEAST(stored_sessions.first_t, excluded.first_t), last_t = GREATEST(stored_sessions.last_t, excluded.last_t),
         entries = stored_sessions.entries + excluded.entries, bytes = stored_sessions.bytes + excluded.bytes,
         oldest_t = LEAST(COALESCE(stored_sessions.oldest_t, excluded.oldest_t), excluded.oldest_t)`,
      [sid, meta.name, meta.project, meta.owner, firstT, lastT, entries, bytes, firstT],
    );
  }

  /** Adds `n` entries to a loop's aggregates: its count, the `at` of its first entry (kept once set) and the `t` of its newest. */
  private async touchLoop(sid: string, loop: string, n: number, firstAt: number, newestT: number): Promise<void> {
    await this.db.run(
      `INSERT INTO loops (session_id, loop, entries, first_at, last_t) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, loop) DO UPDATE SET entries = loops.entries + excluded.entries, last_t = excluded.last_t,
         first_at = COALESCE(loops.first_at, excluded.first_at)`,
      [sid, loop, n, firstAt, newestT],
    );
  }

  /** Runs `fn` in one transaction. On a failure the session's loop positions are dropped, since they may be ahead of the database. */
  private async tx(sid: string, fn: () => Promise<void>): Promise<void> {
    try {
      await this.db.tx(fn);
    } catch (err) {
      this.forgetSession(sid);
      throw err;
    }
  }

  /** A loop's position, loaded from the database the first time it is needed (after a restart, or after the session left). */
  private async tail(sid: string, loop: string): Promise<Tail> {
    const key = `${sid}\u0000${loop}`;
    let tail = this.tails.get(key);
    if (tail) return tail;
    const top = (await this.db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM entries WHERE session_id = ? AND loop = ?', [sid, loop]))!;
    // Reporter entries are stored in time order, so the newest is the last one by sequence, and the ones stored at that same
    // time are the run just before it: walked back from the end a few at a time, never scanning the loop.
    const same = new Set<string>();
    let newest: number | null = null;
    for (let cursor = Number.MAX_SAFE_INTEGER; ; ) {
      const rows = await this.db.all<{ seq: number; at: number; kind: string; text: string }>("SELECT seq, at, kind, text FROM entries WHERE session_id = ? AND loop = ? AND kind != 'podium' AND seq < ? ORDER BY seq DESC LIMIT 50", [sid, loop, cursor]);
      newest ??= rows[0]?.at ?? null;
      const run = rows.filter((r) => r.at === newest);
      for (const r of run) same.add(`${r.kind} ${r.text}`);
      if (run.length < 50 || rows.length < 50) break;
      cursor = rows[rows.length - 1]!.seq;
    }
    tail = { seq: top.seq ?? 0, lastAt: newest, same };
    this.tails.set(key, tail);
    return tail;
  }

  // ---- reads ----------------------------------------------------------------------------------

  /**
   * One page of a loop's stored entries, oldest first. `before` is a `seq` (or null for the newest page); `olderBefore` is
   * the `seq` to pass for the next older page, or null when none is older.
   */
  async page(sessionId: string, loop: string, before: number | null, limit: number = ACTIVITY_HISTORY_PAGE): Promise<{ entries: ActivityEntryView[]; olderBefore: number | null; total: number; since: number | null; keptUntil: number | null }> {
    const size = Math.min(Math.max(Math.floor(limit) || ACTIVITY_HISTORY_PAGE, 1), ACTIVITY_HISTORY_PAGE_MAX);
    const rows = await this.db.all<EntryRow>('SELECT seq, at, kind, text, "by" AS "by", note, command, command_cut FROM entries WHERE session_id = ? AND loop = ? AND seq < ? ORDER BY seq DESC LIMIT ?', [sessionId, loop, before ?? Number.MAX_SAFE_INTEGER, size]);
    rows.reverse();
    const oldest = rows[0]?.seq;
    let olderBefore: number | null = null;
    if (oldest !== undefined) {
      const older = await this.db.get('SELECT 1 AS x FROM entries WHERE session_id = ? AND loop = ? AND seq < ? LIMIT 1', [sessionId, loop, oldest]);
      olderBefore = older ? oldest : null;
    }
    const n = await this.note(sessionId, loop);
    return { entries: rows.map(viewOf), olderBefore, total: n?.total ?? 0, since: n?.since ?? null, keptUntil: n?.keptUntil ?? null };
  }

  /**
   * The counts the live feed's reply carries for a loop: null under the default policy or when nothing is stored for it.
   * The route fills `canRead` and `owner`.
   */
  async note(sessionId: string, loop: string): Promise<Pick<ActivityHistoryNote, 'policy' | 'total' | 'since' | 'keptUntil'> | null> {
    const s = this.opts.settings();
    if (s.policy === 'default') return null;
    // One row of the per-loop aggregates, kept in step with every insert and removal: no counting, however long the loop.
    const r = await this.db.get<{ n: number; since: number | null; newest: number | null }>('SELECT entries AS n, first_at AS since, last_t AS newest FROM loops WHERE session_id = ? AND loop = ?', [sessionId, loop]);
    if (!r || r.n <= 0) return null;
    return { policy: s.policy, total: r.n, since: r.since, keptUntil: s.policy === 'after' && r.newest !== null ? r.newest + activityPeriodMs(s) : null };
  }

  /**
   * Everything stored, from the per-session aggregates: entries, sessions, and `bytes`, the estimate of the entries' size that
   * every preview, list row and delete result also uses. `fileBytes` is the size of the schema's tables with their indexes.
   */
  async totals(): Promise<StoredTotals> {
    const r = (await this.db.get<{ entries: number; bytes: number; sessions: number }>('SELECT COALESCE(SUM(entries), 0) AS entries, COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS sessions FROM stored_sessions WHERE entries > 0'))!;
    const f = (await this.db.get<{ n: number }>("SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = current_schema() AND c.relkind = 'r'"))!;
    return { entries: r.entries, sessions: r.sessions, bytes: Math.max(0, r.bytes), fileBytes: f.n };
  }

  /** The part of a filter that names sessions: name or id, project, owner. Over `stored_sessions s`, never `entries`. */
  private sessionWhere(f: StoredFilter): { sql: string; params: Param[] } {
    const parts = ['s.entries > 0'];
    const params: Param[] = [];
    if (f.q?.trim()) {
      parts.push(`(${lowerSql('s.name')} LIKE ? ESCAPE '\\' OR ${lowerSql('s.session_id')} LIKE ? ESCAPE '\\')`);
      params.push(like(f.q.trim()), like(f.q.trim()));
    }
    if (f.project) {
      parts.push('s.project = ?');
      params.push(f.project);
    }
    if (f.owner) {
      parts.push('s.owner = ?');
      params.push(f.owner);
    }
    return { sql: parts.join(' AND '), params };
  }

  /** The part of a filter that changes which entries count: loop, older than n days, from, to. Over `entries`, one session at a time. */
  private windowWhere(f: StoredFilter): { sql: string; params: Param[]; lo: number; hi: number } {
    const parts: string[] = [];
    const params: Param[] = [];
    let lo = -Infinity;
    let hi = Infinity;
    if (f.loop === 'main') {
      parts.push('loop = ?');
      params.push(MAIN_LOOP);
    } else if (f.loop === 'agents') {
      parts.push('loop != ?');
      params.push(MAIN_LOOP);
    }
    if (typeof f.olderThanDays === 'number') {
      const cut = whole(this.opts.now() - f.olderThanDays * DAY_MS);
      parts.push('t < ?');
      params.push(cut);
      hi = Math.min(hi, cut);
    }
    if (typeof f.from === 'number') {
      parts.push('t >= ?');
      params.push(whole(f.from));
      lo = Math.max(lo, whole(f.from));
    }
    if (typeof f.to === 'number') {
      parts.push('t < ?');
      params.push(whole(f.to));
      hi = Math.min(hi, whole(f.to));
    }
    return { sql: parts.join(' AND '), params, lo, hi };
  }

  /**
   * The sessions a filter can match, newest first, with their aggregates. A filter that changes which entries count is
   * pruned first by the session's oldest and newest time, so most sessions are never looked into.
   */
  private async candidates(f: StoredFilter): Promise<CandidateRow[]> {
    const sw = this.sessionWhere(f);
    const parts = [sw.sql];
    const params = [...sw.params];
    if (typeof f.olderThanDays === 'number') {
      parts.push('s.oldest_t < ?');
      params.push(whole(this.opts.now() - f.olderThanDays * DAY_MS));
    }
    if (typeof f.to === 'number') {
      parts.push('s.oldest_t < ?');
      params.push(whole(f.to));
    }
    if (typeof f.from === 'number') {
      parts.push('s.last_t >= ?');
      params.push(whole(f.from));
    }
    return this.db.all<CandidateRow>(
      `SELECT s.session_id AS "sessionId", s.name AS name, s.project AS project, s.owner AS owner, s.entries AS entries, s.bytes AS bytes, s.oldest_t AS "oldestAt", s.last_t AS "lastT" FROM stored_sessions s WHERE ${parts.join(' AND ')} ORDER BY s.last_t DESC, s.session_id`,
      params,
    );
  }

  /**
   * Counts a session's entries that match `where` (on `entries`, may be empty) and finds the oldest, through the (session,
   * time) index, inside the time range [lo, hi). Each statement is bounded by rows, not by time: a boundary query finds the
   * time `sliceRows` index entries ahead, the count covers only up to it, and the event loop gets a turn between statements.
   * Entries that all share one instant are counted in one statement, however many (a time cannot be cut), which a reporter's
   * clock in milliseconds makes rare.
   */
  private async countIn(c: { sessionId: string; entries: number; oldestAt: number; lastT: number }, where: string, params: Param[], lo = -Infinity, hi = Infinity): Promise<{ n: number; oldest: number | null }> {
    const end = Math.min(c.lastT + 1, hi);
    let from = Math.max(c.oldestAt, lo);
    let n = 0;
    let oldest: number | null = null;
    while (from < end) {
      const at = from;
      const slice = await this.step(async () => {
        const edge = await this.db.get<{ t: number }>('SELECT t FROM entries WHERE session_id = ? AND t >= ? ORDER BY t LIMIT 1 OFFSET ?', [c.sessionId, at, this.sliceRows]);
        let to = edge ? Math.min(edge.t, end) : end;
        if (to <= at) to = at + 1;
        const r = await this.db.get<{ n: number; oldest: number | null }>(`SELECT COUNT(*) AS n, MIN(t) AS oldest FROM entries WHERE session_id = ? AND t >= ? AND t < ?${where ? ` AND ${where}` : ''}`, [c.sessionId, at, to, ...params]);
        return { to, r: r! };
      });
      n += slice.r.n;
      if (oldest === null && slice.r.oldest !== null) oldest = slice.r.oldest;
      from = slice.to;
      if (from < end) await yieldNow();
    }
    return { n, oldest };
  }

  /**
   * The stored sessions the filter matches, a page at a time, newest first, with what is stored for each. Name, project and
   * owner come from `stored_sessions` alone. A filter on the loop or the time of the entries is worked out one session at a
   * time through the (session, time) index, giving the event loop a turn between sessions; then `bytes` is the session's
   * average entry size times its matching entries, an estimate. Times are on the server's clock.
   */
  async list(filter: StoredFilter, page = 1, pageSize = 25): Promise<StoredActivityList> {
    const size = Math.min(Math.max(Math.floor(pageSize) || 25, 1), 200);
    const pg = Math.max(Math.floor(page) || 1, 1);
    const ww = this.windowWhere(filter);
    // Without a filter on the entries the whole page is read in one step; with one, the sessions are counted one at a time with
    // a turn between them, and the page is put together in a last step.
    if (!ww.sql) return this.step(async () => this.listPage(await this.candidates(filter), pg, size));
    const counted: CandidateRow[] = [];
    for (const c of await this.step(() => this.candidates(filter))) {
      const r = await this.countIn(c, ww.sql, ww.params, ww.lo, ww.hi);
      if (r.n > 0) counted.push({ ...c, entries: r.n, bytes: Math.round((r.n * c.bytes) / Math.max(c.entries, 1)), oldestAt: r.oldest ?? c.oldestAt });
      await yieldNow();
    }
    return this.step(() => this.listPage(counted, pg, size));
  }

  /** The page of `list` over the sessions already chosen and counted. */
  private async listPage(all: CandidateRow[], pg: number, size: number): Promise<StoredActivityList> {
    const match: StoredActivityList['match'] = { entries: 0, sessions: all.length, bytes: 0 };
    for (const c of all) {
      match.entries += c.entries;
      match.bytes += c.bytes;
    }
    const distinct = async (col: 'project' | 'owner') => (await this.db.all<{ v: string }>(`SELECT DISTINCT ${col} AS v FROM stored_sessions WHERE entries > 0 AND ${col} IS NOT NULL ORDER BY ${col}`)).map((r) => r.v);
    return {
      total: all.length,
      page: pg,
      pageSize: size,
      rows: all.slice((pg - 1) * size, pg * size).map(({ lastT: _lastT, ...c }): StoredSessionRow => ({ ...c, live: this.opts.isLive(c.sessionId) })),
      totals: await this.totals(),
      match,
      projects: await distinct('project'),
      owners: await distinct('owner'),
    };
  }

  // ---- removal --------------------------------------------------------------------------------
  //
  // Every removal works in chunks of about `chunkRows` rows. Each chunk is its own short transaction that deletes the rows and
  // takes them off their sessions' aggregates, and the event loop gets a turn between chunks, so a report, a request or the
  // console never waits for a whole purge. Heavy operations run one at a time (`serial`); capture runs between chunks.

  /** Runs one heavy operation after the ones before it, never alongside them. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Resolves when every heavy operation started so far has finished. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Whether a heavy operation (purge, delete, preview, retention) is running or waiting. */
  get busy(): boolean {
    return this.running > 0;
  }

  /** Runs `fn` as a heavy operation: counted while it runs or waits, and one at a time. */
  private heavy<T>(fn: () => Promise<T>): Promise<T> {
    this.running++;
    return this.serial(fn).finally(() => {
      this.running--;
    });
  }

  /** Runs `fn` as a heavy operation, one at a time with the purge and the deletes. Session recordings (#353) share this turn-taking. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.heavy(fn);
  }

  /** Gives removed rows' space back. PostgreSQL's autovacuum owns that; resolves with 0 bytes freed. */
  compactNow(): Promise<number> {
    return Promise.resolve(0);
  }

  /**
   * An estimate of what saving these settings would do now, without doing it. For a keep policy: the entries and bytes the
   * purge would remove and the sessions that would lose at least one entry, counted by index range one session at a time (bytes are the session's average entry
   * size times its entries, and the size cap's part is by bytes alone). `stopsCapturing` is false. For the default policy
   * nothing is removed, so it returns what is stored now (the totals), with `stopsCapturing` true when anything is stored.
   */
  async preview(settings: ActivityHistorySettings): Promise<ActivityHistoryPreview> {
    if (settings.policy === 'default') {
      const t = await this.step(() => this.totals());
      return { entries: t.entries, bytes: t.bytes, sessions: t.sessions, stopsCapturing: t.entries > 0 };
    }
    return this.heavy(async () => {
      let entries = 0;
      let bytes = 0;
      const losing = new Set<string>();
      const rows = await this.step(() => this.db.all<{ sessionId: string; entries: number; bytes: number; oldestAt: number; lastT: number }>('SELECT session_id AS "sessionId", entries, bytes, oldest_t AS "oldestAt", last_t AS "lastT" FROM stored_sessions WHERE entries > 0'));
      if (settings.policy === 'after') {
        const cutoff = whole(this.opts.now() - activityPeriodMs(settings));
        for (const r of rows) {
          const { n } = await this.countIn(r, 't < ?', [cutoff], -Infinity, cutoff);
          entries += n;
          bytes += Math.round((n * r.bytes) / r.entries);
          if (n > 0) losing.add(r.sessionId);
          await yieldNow();
        }
      } else if (settings.policy === 'end') {
        for (const r of rows) {
          if (this.opts.isLive(r.sessionId)) continue;
          entries += r.entries;
          bytes += r.bytes;
          losing.add(r.sessionId);
        }
      }
      if (settings.capGb !== null) {
        const stored = rows.reduce((a, r) => ({ entries: a.entries + r.entries, bytes: a.bytes + r.bytes }), { entries: 0, bytes: 0 });
        const excess = stored.bytes - bytes - settings.capGb * (this.opts.capBytesPerGb ?? 1024 ** 3);
        if (excess > 0) {
          entries += Math.min(stored.entries - entries, Math.ceil(excess / Math.max(stored.bytes / Math.max(stored.entries, 1), 1)));
          bytes += excess;
          // The oldest entries go first, so a session loses some if it has anything older than the time that share of the
          // bytes reaches (entries assumed spread evenly in time): an estimate.
          const share = Math.min(1, excess / Math.max(stored.bytes - bytes + excess, 1));
          const from = Math.min(...rows.map((r) => r.oldestAt));
          const to = Math.max(...rows.map((r) => r.lastT));
          const reach = from + share * (to - from);
          for (const r of rows) if (r.oldestAt <= reach) losing.add(r.sessionId);
        }
      }
      return { entries, bytes, sessions: losing.size, stopsCapturing: false };
    });
  }

  /**
   * Removes what the policy no longer keeps: under `after`, entries older than the period; under `end`, the sessions that
   * are not live; and under either or `all`, the oldest entries while the total is over the cap. Does nothing under the
   * default policy. Works in chunks. `freed` is always 0: PostgreSQL gives the space back by itself.
   */
  purge(now: number = this.opts.now()): Promise<PurgeResult> {
    return this.heavy(async () => {
      const s = this.opts.settings();
      if (s.policy === 'default' || this.closed) return { entries: 0, bytes: 0, sessions: 0, freed: 0 };
      const touched = newTouched();
      let entries = 0;
      let bytes = 0;
      const add = (r: { entries: number; bytes: number }) => {
        entries += r.entries;
        bytes += r.bytes;
      };
      if (s.policy === 'after') add(await this.removeWhere('t < ?', [whole(now - activityPeriodMs(s))], touched));
      if (s.policy === 'end') {
        const ids = await this.step(async () => (await this.db.all<{ id: string }>('SELECT session_id AS id FROM stored_sessions')).map((r) => r.id).filter((id) => !this.opts.isLive(id)));
        for (const id of ids) {
          add(await this.removeWhere('session_id = ?', [id], touched));
          await yieldNow();
        }
      }
      if (s.capGb !== null) {
        const capBytes = s.capGb * (this.opts.capBytesPerGb ?? 1024 ** 3);
        // The excess is worked out in the step of the first chunk, so it is the one that chunk removes against.
        add(await this.removeOldest(async () => (await this.db.get<{ b: number }>('SELECT COALESCE(SUM(bytes), 0) AS b FROM stored_sessions'))!.b - capBytes, touched));
      }
      // Stopped while a chunk waited its turn: there is nothing left to settle.
      // `sessions` is the sessions that lost at least one entry; those left with nothing are dropped inside `finish`.
      const sessions = touched.sessions.size;
      if (this.closed) return { entries, bytes, sessions, freed: 0 };
      const dropped = await this.step(() => this.finish(touched));
      if (!entries && !dropped) return { entries, bytes, sessions, freed: 0 };
      this.last = { at: now, entries, bytes };
      return { entries, bytes, sessions, freed: 0 };
    });
  }

  /** Deletes the rows `where` matches (on `entries`), `chunkRows` at a time, giving the event loop a turn between chunks. */
  private async removeWhere(where: string, params: Param[], touched: Touched): Promise<{ entries: number; bytes: number }> {
    let entries = 0;
    let bytes = 0;
    let limit = Math.min(this.chunk, FIRST_CHUNK);
    while (!this.closed) {
      const size = limit;
      // The chunk is chosen and removed in one step, so what was chosen is what goes however the steps of others fall.
      const chunk = await this.step(() =>
        this.db.tx(async () => {
          const started = performance.now();
          const rows = await this.db.all<VictimRow>(`SELECT id, session_id AS sid, loop, ${entryBytesSql()} AS b FROM entries WHERE ${where} LIMIT ?`, [...params, size]);
          if (!rows.length) return null;
          await this.dropRows(rows, touched);
          return { n: rows.length, b: rows.reduce((a, r) => a + r.b, 0), tookMs: performance.now() - started };
        }),
      );
      if (!chunk) break;
      entries += chunk.n;
      bytes += chunk.b;
      if (chunk.n < limit) break;
      limit = this.nextChunk(limit, chunk.tookMs);
      await yieldNow();
    }
    return { entries, bytes };
  }

  /** Deletes the oldest entries (by server time) until `excess` bytes are gone. */
  private async removeOldest(over: () => Promise<number>, touched: Touched): Promise<{ entries: number; bytes: number }> {
    let entries = 0;
    let bytes = 0;
    let excess: number | null = null;
    let limit = Math.min(this.chunk, FIRST_CHUNK);
    while (!this.closed) {
      const size = limit;
      const chunk = await this.step(() =>
        this.db.tx(async () => {
          const started = performance.now();
          excess ??= await over();
          if (excess <= 0) return null;
          const rows = await this.db.all<VictimRow>(`SELECT id, session_id AS sid, loop, ${entryBytesSql()} AS b FROM entries ORDER BY t, id LIMIT ?`, [size]);
          if (!rows.length) return null;
          const take: VictimRow[] = [];
          let b = 0;
          for (const r of rows) {
            take.push(r);
            excess -= r.b;
            b += r.b;
            if (excess <= 0) break;
          }
          await this.dropRows(take, touched);
          return { n: take.length, b, tookMs: performance.now() - started };
        }),
      );
      if (!chunk) break;
      entries += chunk.n;
      bytes += chunk.b;
      limit = this.nextChunk(limit, chunk.tookMs);
      await yieldNow();
    }
    return { entries, bytes };
  }

  /**
   * The size of the next chunk: the last one's size scaled so it would have taken `chunkMs`, at most half as many again, at most
   * `chunkRows`, and not below a hundred rows. Deleting rows scattered through a big table costs more per row than rows that
   * sit together, so the chunk shrinks there and the console still never waits.
   */
  private nextChunk(limit: number, tookMs: number): number {
    const want = Math.round((limit * this.chunkMs) / Math.max(tookMs, 0.01));
    return Math.max(Math.min(100, this.chunk), Math.min(this.chunk, Math.ceil(limit * 1.5), want));
  }

  /** One chunk: deletes the rows and takes them off their sessions' aggregates in one transaction. */
  private async dropRows(rows: VictimRow[], touched: Touched): Promise<void> {
    const perSession = new Map<string, { n: number; b: number }>();
    const perLoop = new Map<string, { sid: string; loop: string; n: number }>();
    for (const r of rows) {
      const p = perSession.get(r.sid) ?? { n: 0, b: 0 };
      p.n++;
      p.b += r.b;
      perSession.set(r.sid, p);
      const key = `${r.sid}\u0000${r.loop}`;
      const l = perLoop.get(key) ?? { sid: r.sid, loop: r.loop, n: 0 };
      l.n++;
      perLoop.set(key, l);
    }
    await this.db.tx(async () => {
      for (let i = 0; i < rows.length; i += DELETE_BATCH) {
        const ids = rows.slice(i, i + DELETE_BATCH).map((r) => r.id);
        await this.db.run(`DELETE FROM entries WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
      }
      for (const [sid, p] of perSession) {
        await this.db.run('UPDATE stored_sessions SET entries = entries - ?, bytes = bytes - ? WHERE session_id = ?', [p.n, p.b, sid]);
        touched.sessions.add(sid);
      }
      for (const [key, l] of perLoop) {
        await this.db.run('UPDATE loops SET entries = entries - ? WHERE session_id = ? AND loop = ?', [l.n, l.sid, l.loop]);
        touched.loops.set(key, { sid: l.sid, loop: l.loop });
      }
    });
  }

  /**
   * After a removal: settles the loops and sessions it touched. A loop or session left with no entry is dropped; for the rest
   * the first and last times are read again from the ends of their indexes. Returns how many sessions were dropped.
   */
  private async finish(touched: Touched): Promise<number> {
    return this.db.tx(async () => {
      for (const { sid, loop } of touched.loops.values()) {
        const row = await this.db.get<{ entries: number }>('SELECT entries FROM loops WHERE session_id = ? AND loop = ?', [sid, loop]);
        if (!row) continue;
        if (row.entries <= 0) await this.db.run('DELETE FROM loops WHERE session_id = ? AND loop = ?', [sid, loop]);
        else {
          await this.db.run(
            `UPDATE loops SET first_at = (SELECT at FROM entries WHERE session_id = ? AND loop = ? ORDER BY seq LIMIT 1),
               last_t = (SELECT t FROM entries WHERE session_id = ? AND loop = ? ORDER BY seq DESC LIMIT 1) WHERE session_id = ? AND loop = ?`,
            [sid, loop, sid, loop, sid, loop],
          );
        }
      }
      let dropped = 0;
      for (const sid of touched.sessions) {
        const row = await this.db.get<{ entries: number }>('SELECT entries FROM stored_sessions WHERE session_id = ?', [sid]);
        if (!row) continue;
        if (row.entries <= 0) {
          await this.db.run('DELETE FROM stored_sessions WHERE session_id = ?', [sid]);
          dropped++;
        } else {
          await this.db.run('UPDATE stored_sessions SET oldest_t = (SELECT t FROM entries WHERE session_id = ? ORDER BY t LIMIT 1) WHERE session_id = ?', [sid, sid]);
        }
      }
      return dropped;
    });
  }

  /**
   * The Admin's delete: the ticked sessions, everything the filter matches, or everything. Works in chunks, session by
   * session. `sessions` counts the sessions that lost at least one entry, `bytes` the size of what went; `freed` is 0.
   */
  deleteBy(body: StoredDeleteBody, stillWanted?: (sessionId: string) => Promise<boolean>): Promise<StoredDeleteResult> {
    return this.heavy(async () => {
      if (this.closed) return { entries: 0, sessions: 0, bytes: 0, freed: 0 };
      const touched = newTouched();
      let entries = 0;
      let bytes = 0;
      const each = async (ids: string[], extra = '', params: Param[] = []) => {
        for (const id of ids) {
          // Asked just before this session's rows go, so a session that came back since the list was made keeps them.
          if (stillWanted && !(await stillWanted(id))) continue;
          const r = await this.removeWhere(`session_id = ?${extra}`, [id, ...params], touched);
          entries += r.entries;
          bytes += r.bytes;
          await yieldNow();
        }
      };
      if ('all' in body) await each(await this.step(async () => (await this.db.all<{ id: string }>('SELECT session_id AS id FROM stored_sessions')).map((r) => r.id)));
      else if ('ids' in body) await each(body.ids);
      else {
        const ww = this.windowWhere(body.match);
        await each(await this.step(async () => (await this.candidates(body.match)).map((c) => c.sessionId)), ww.sql ? ` AND ${ww.sql}` : '', ww.params);
      }
      // Stopped while it ran: there is nothing to settle.
      const sessions = touched.sessions.size;
      if (this.closed) return { entries, sessions, bytes, freed: 0 };
      await this.step(() => this.finish(touched));
      return { entries, sessions, bytes, freed: 0 };
    });
  }

  /** A session was deleted: its rows and its loop positions go. */
  async deleteSession(sessionId: string): Promise<StoredDeleteResult> {
    this.forgetSession(sessionId);
    if (!(await this.step(() => this.db.get('SELECT 1 AS x FROM stored_sessions WHERE session_id = ?', [sessionId])))) return { entries: 0, sessions: 0, bytes: 0, freed: 0 };
    return this.deleteBy({ ids: [sessionId] });
  }

  /**
   * Removes the rows of sessions the main database no longer holds (their own retention ran out). Returns the entries removed.
   * `exists` is asked once to pick the sessions and again just before each one's rows go, so a session that reported again in
   * between keeps them.
   */
  async dropMissingSessions(exists: (sessionId: string) => boolean | Promise<boolean>): Promise<number> {
    const stored = await this.step(async () => (await this.db.all<{ id: string }>('SELECT session_id AS id FROM stored_sessions')).map((r) => r.id));
    const ids: string[] = [];
    for (const id of stored) if (!(await exists(id))) ids.push(id);
    if (!ids.length) return 0;
    for (const id of ids) this.forgetSession(id);
    return (await this.deleteBy({ ids }, async (id) => !(await exists(id)))).entries;
  }
}
