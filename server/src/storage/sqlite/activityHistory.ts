// The Activity history store (#432): the agent Activity feed kept in the second SQLite file when the Admin chooses a keep
// policy. Under the default policy nothing here runs and the feed stays in memory (activity.ts).
//
// What it keeps: every entry of every loop a report carries, with no viewer's lease needed. The mod resends a snapshot of
// its last 20 entries on every report, so the snapshots overlap; `take` stores each entry once. A Podium-sent entry (an
// answer, message or command) is written when the live feed gets it, and keeps its ref, sender and note.
//
// What removes it: the purge (policy `after`, `end`, and the optional size cap), the Admin's deletes, a session's own
// deletion, and a session's retention in the main database (the shorter wins). Each removal ends by compacting the file.
//
// Big files: `stored_sessions` carries each session's entry count, bytes and oldest time, kept in step with every insert and
// delete, so totals and the Stored activity table never scan `entries`. Removals run in short chunks with a turn for the
// event loop between them (see "removal" below), one heavy operation at a time.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { entryBytesSql } from './activityDb.js';
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
import type { SessionMeta, ActivityHistoryOpts, PurgeResult } from '../rows.js';

type Param = string | number | null;

/** Where a loop stands: the next sequence number, and the newest reporter entry's time with the entries stored at that time. */
interface Tail {
  seq: number;
  lastAt: number | null;
  same: Set<string>;
}

const DAY_MS = 86_400_000;
const CHUNK_ROWS = 5000;
const VACUUM_PAGES = 500;
const CHUNK_MS = 25;
/** The first chunk of a removal: small, because what a row costs to delete is not known until one has been. */
const FIRST_CHUNK = 500;
const SLICE_ROWS = 20_000;
/**
 * Ids bound in one `DELETE ... WHERE id IN (?, ...)` (#808). A fixed size keeps the statement within every database's limit on bound
 * parameters. The statement cache is keyed by SQL text, so a last batch of 1 to 199 ids caches one more statement per size; that is few.
 */
const DELETE_BATCH = 200;

/** Gives the event loop a turn: queued requests, timers and reports run before the next chunk. */
const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const like = (q: string) => `%${q.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;

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

/** The neutral options plus what only this adapter honors. */
export type SqliteActivityHistoryOpts = ActivityHistoryOpts & {
  /** Pages given back per step of the incremental vacuum. Tests lower it. */
  vacuumPages?: number;
};

export class ActivityHistory {
  private readonly tails = new Map<string, Tail>();
  private last: LastPurge | null = null;
  private readonly stmts = new Map<string, StatementSync>();
  private readonly chunk: number;
  private readonly vacuumPages: number;
  private readonly chunkMs: number;
  private readonly sliceRows: number;
  private chain: Promise<void> = Promise.resolve();
  private running = 0;
  private closed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: SqliteActivityHistoryOpts,
  ) {
    this.chunk = Math.max(opts.chunkRows ?? CHUNK_ROWS, 1);
    this.vacuumPages = Math.max(opts.vacuumPages ?? VACUUM_PAGES, 1);
    this.chunkMs = opts.chunkMs ?? CHUNK_MS;
    this.sliceRows = Math.max(opts.sliceRows ?? SLICE_ROWS, 1);
  }

  /** A prepared statement, kept for the next call. */
  private st(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
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

  /** A purge or delete still running stops at its next chunk. The file stays open until `close`. */
  stop(): void {
    this.closed = true;
  }

  /** Closes the file. A purge or delete still running stops at its next chunk. */
  close(): void {
    this.closed = true;
    this.stmts.clear();
    this.db.close();
  }

  /** One step of a chunked operation: under the adapter's lock when there is one, otherwise at once. */
  private step<T>(fn: () => T): Promise<T> {
    return this.opts.step ? this.opts.step(fn) : new Promise<T>((resolve) => resolve(fn()));
  }

  // ---- capture --------------------------------------------------------------------------------

  /**
   * Stores what is new in a report's snapshots, for the orchestrator and every agent, whether or not anyone watches. An
   * entry already stored (same time, kind and text) or older than the loop's newest stored entry is skipped, so the
   * overlapping 20-entry snapshots add each entry once. `skewMs` is the report's `sentAt` minus the server's time.
   * Returns how many entries were stored.
   */
  ingest(report: Report, skewMs: number, meta: SessionMeta): number {
    if (!this.enabled()) return 0;
    const sid = report.session.id;
    const lists: [string, ActivityEntry[] | undefined][] = [[MAIN_LOOP, report.session.activity], ...report.agents.map((a): [string, ActivityEntry[] | undefined] => [a.id, a.activity])];
    if (!lists.some(([, l]) => l?.length)) return 0;
    let stored = 0;
    let bytes = 0;
    let firstT = Infinity;
    let lastT = -Infinity;
    this.tx(sid, () => {
      for (const [loop, list] of lists) {
        let n = 0;
        let firstAt = 0;
        let newestT = 0;
        for (const e of list ?? []) {
          const b = this.take(sid, loop, e, skewMs);
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
        if (n) this.touchLoop(sid, loop, n, firstAt, newestT);
      }
      if (stored) this.touchSession(sid, meta, firstT, lastT, stored, bytes);
    });
    return stored;
  }

  /** Stores one reporter entry unless it repeats one already stored. Returns its size, or null when it was skipped. */
  private take(sid: string, loop: string, e: ActivityEntry, skewMs: number): number | null {
    const tail = this.tail(sid, loop);
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
  addPodium(sessionId: string, loop: string, ref: string, e: { at: number; text: string; by: string; note: string | null }, meta: SessionMeta): void {
    if (!this.enabled()) return;
    this.tx(sessionId, () => {
      const tail = this.tail(sessionId, loop);
      const b = this.insert(sessionId, loop, ++tail.seq, e.at, e.at, 'podium', e.text.slice(0, LIMITS.activityText), e.by, e.note, ref);
      this.touchSession(sessionId, meta, e.at, e.at, 1, b);
      this.touchLoop(sessionId, loop, 1, e.at, e.at);
    });
  }

  /** A Podium entry's note changed (queued, then taken). The session's byte count follows the note's length. */
  updatePodium(sessionId: string, ref: string, note: string | null): void {
    const size = () => (this.st(`SELECT COALESCE(SUM(${entryBytesSql()}), 0) AS b FROM entries WHERE session_id = ? AND ref = ?`).get(sessionId, ref) as { b: number }).b;
    this.db.exec('BEGIN');
    try {
      const before = size();
      this.st('UPDATE entries SET note = ? WHERE session_id = ? AND ref = ?').run(note, sessionId, ref);
      const delta = size() - before;
      if (delta) this.st('UPDATE stored_sessions SET bytes = bytes + ? WHERE session_id = ?').run(delta, sessionId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** A Podium entry for something the session never took (discarded, refused, or the ask closed first). */
  removePodium(sessionId: string, ref: string): void {
    this.db.exec('BEGIN');
    try {
      const gone = this.st(`DELETE FROM entries WHERE session_id = ? AND ref = ? RETURNING loop, ${entryBytesSql()} AS b`).all(sessionId, ref) as { loop: string; b: number }[];
      if (gone.length) {
        const touched = newTouched();
        this.st('UPDATE stored_sessions SET entries = entries - ?, bytes = bytes - ? WHERE session_id = ?').run(gone.length, gone.reduce((a, r) => a + r.b, 0), sessionId);
        for (const r of gone) {
          this.st('UPDATE loops SET entries = entries - 1 WHERE session_id = ? AND loop = ?').run(sessionId, r.loop);
          touched.loops.set(`${sessionId}\u0000${r.loop}`, { sid: sessionId, loop: r.loop });
        }
        touched.sessions.add(sessionId);
        this.finish(touched);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The session left the live set: its in-memory loop positions go. Its rows stay, and the positions reload when it reports again. */
  forgetSession(sessionId: string): void {
    for (const key of [...this.tails.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.tails.delete(key);
  }

  /** Inserts one entry and returns its size as the aggregates count it. */
  private insert(sid: string, loop: string, seq: number, at: number, t: number, kind: string, text: string, by: string | null, note: string | null, ref: string | null, command: string | null = null, commandCut = false): number {
    const row = this.st(`INSERT INTO entries (session_id, loop, seq, at, t, kind, text, "by", note, ref, command, command_cut) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${entryBytesSql()} AS b`).get(sid, loop, seq, at, t, kind, text, by, note, ref, command, commandCut ? 1 : null) as { b: number };
    return row.b;
  }

  private touchSession(sid: string, meta: SessionMeta, firstT: number, lastT: number, entries: number, bytes: number): void {
    this.st(
      `INSERT INTO stored_sessions (session_id, name, project, owner, first_t, last_t, entries, bytes, oldest_t) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET name = excluded.name, project = excluded.project, owner = excluded.owner,
         first_t = MIN(first_t, excluded.first_t), last_t = MAX(last_t, excluded.last_t),
         entries = entries + excluded.entries, bytes = bytes + excluded.bytes,
         oldest_t = MIN(COALESCE(oldest_t, excluded.oldest_t), excluded.oldest_t)`,
    ).run(sid, meta.name, meta.project, meta.owner, firstT, lastT, entries, bytes, firstT);
  }

  /** Adds `n` entries to a loop's aggregates: its count, the `at` of its first entry (kept once set) and the `t` of its newest. */
  private touchLoop(sid: string, loop: string, n: number, firstAt: number, newestT: number): void {
    this.st(
      `INSERT INTO loops (session_id, loop, entries, first_at, last_t) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, loop) DO UPDATE SET entries = entries + excluded.entries, last_t = excluded.last_t,
         first_at = COALESCE(first_at, excluded.first_at)`,
    ).run(sid, loop, n, firstAt, newestT);
  }

  /** Runs `fn` in one transaction. On a failure the session's loop positions are dropped, since they may be ahead of the file. */
  private tx(sid: string, fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.forgetSession(sid);
      throw err;
    }
  }

  /** A loop's position, loaded from the file the first time it is needed (after a restart, or after the session left). */
  private tail(sid: string, loop: string): Tail {
    const key = `${sid}\u0000${loop}`;
    let tail = this.tails.get(key);
    if (tail) return tail;
    const top = this.st('SELECT MAX(seq) AS seq FROM entries WHERE session_id = ? AND loop = ?').get(sid, loop) as { seq: number | null };
    // Reporter entries are stored in time order, so the newest is the last one by sequence, and the ones stored at that same
    // time are the run just before it: walked back from the end a few at a time, never scanning the loop.
    const back = this.st("SELECT seq, at, kind, text FROM entries WHERE session_id = ? AND loop = ? AND kind != 'podium' AND seq < ? ORDER BY seq DESC LIMIT 50");
    const same = new Set<string>();
    let newest: number | null = null;
    for (let cursor = Number.MAX_SAFE_INTEGER; ; ) {
      const rows = back.all(sid, loop, cursor) as { seq: number; at: number; kind: string; text: string }[];
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
  page(sessionId: string, loop: string, before: number | null, limit: number = ACTIVITY_HISTORY_PAGE): { entries: ActivityEntryView[]; olderBefore: number | null; total: number; since: number | null; keptUntil: number | null } {
    const size = Math.min(Math.max(Math.floor(limit) || ACTIVITY_HISTORY_PAGE, 1), ACTIVITY_HISTORY_PAGE_MAX);
    const rows = this.db
      .prepare('SELECT seq, at, kind, text, "by" AS by, note, command, command_cut FROM entries WHERE session_id = ? AND loop = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
      .all(sessionId, loop, before ?? Number.MAX_SAFE_INTEGER, size) as unknown as EntryRow[];
    rows.reverse();
    const oldest = rows[0]?.seq;
    let olderBefore: number | null = null;
    if (oldest !== undefined) {
      const older = this.db.prepare('SELECT 1 AS x FROM entries WHERE session_id = ? AND loop = ? AND seq < ? LIMIT 1').get(sessionId, loop, oldest);
      olderBefore = older ? oldest : null;
    }
    const n = this.note(sessionId, loop);
    return { entries: rows.map(viewOf), olderBefore, total: n?.total ?? 0, since: n?.since ?? null, keptUntil: n?.keptUntil ?? null };
  }

  /**
   * The counts the live feed's reply carries for a loop: null under the default policy or when nothing is stored for it.
   * The route fills `canRead` and `owner`.
   */
  note(sessionId: string, loop: string): Pick<ActivityHistoryNote, 'policy' | 'total' | 'since' | 'keptUntil'> | null {
    const s = this.opts.settings();
    if (s.policy === 'default') return null;
    // One row of the per-loop aggregates, kept in step with every insert and removal: no counting, however long the loop.
    const r = this.st('SELECT entries AS n, first_at AS since, last_t AS newest FROM loops WHERE session_id = ? AND loop = ?').get(sessionId, loop) as { n: number; since: number | null; newest: number | null } | undefined;
    if (!r || r.n <= 0) return null;
    return { policy: s.policy, total: r.n, since: r.since, keptUntil: s.policy === 'after' && r.newest !== null ? r.newest + activityPeriodMs(s) : null };
  }

  /**
   * Everything stored, from the per-session aggregates: entries, sessions, and `bytes`, the estimate of the entries' size that
   * every preview, list row and delete result also uses. `fileBytes` is the file's pages in use, for "on disk".
   */
  totals(): StoredTotals {
    const r = this.st('SELECT COALESCE(SUM(entries), 0) AS entries, COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS sessions FROM stored_sessions WHERE entries > 0').get() as { entries: number; bytes: number; sessions: number };
    return { entries: r.entries, sessions: r.sessions, bytes: Math.max(0, r.bytes), fileBytes: this.usedBytes() };
  }

  private pragma(name: string): number {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
    return Number(Object.values(row)[0]);
  }

  private usedBytes(): number {
    return (this.pragma('page_count') - this.pragma('freelist_count')) * this.pragma('page_size');
  }

  private fileBytes(): number {
    return this.pragma('page_count') * this.pragma('page_size');
  }

  /** The part of a filter that names sessions: name or id, project, owner. Over `stored_sessions s`, never `entries`. */
  private sessionWhere(f: StoredFilter): { sql: string; params: Param[] } {
    const parts = ['s.entries > 0'];
    const params: Param[] = [];
    if (f.q?.trim()) {
      parts.push("(LOWER(s.name) LIKE ? ESCAPE '\\' OR LOWER(s.session_id) LIKE ? ESCAPE '\\')");
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
      parts.push('t < ?');
      params.push(this.opts.now() - f.olderThanDays * DAY_MS);
      hi = Math.min(hi, this.opts.now() - f.olderThanDays * DAY_MS);
    }
    if (typeof f.from === 'number') {
      parts.push('t >= ?');
      params.push(f.from);
      lo = Math.max(lo, f.from);
    }
    if (typeof f.to === 'number') {
      parts.push('t < ?');
      params.push(f.to);
      hi = Math.min(hi, f.to);
    }
    return { sql: parts.join(' AND '), params, lo, hi };
  }

  /**
   * The sessions a filter can match, newest first, with their aggregates. A filter that changes which entries count is
   * pruned first by the session's oldest and newest time, so most sessions are never looked into.
   */
  private candidates(f: StoredFilter): CandidateRow[] {
    const sw = this.sessionWhere(f);
    const parts = [sw.sql];
    const params = [...sw.params];
    if (typeof f.olderThanDays === 'number') {
      parts.push('s.oldest_t < ?');
      params.push(this.opts.now() - f.olderThanDays * DAY_MS);
    }
    if (typeof f.to === 'number') {
      parts.push('s.oldest_t < ?');
      params.push(f.to);
    }
    if (typeof f.from === 'number') {
      parts.push('s.last_t >= ?');
      params.push(f.from);
    }
    return this.db
      .prepare(
        `SELECT s.session_id AS sessionId, s.name AS name, s.project AS project, s.owner AS owner, s.entries AS entries, s.bytes AS bytes, s.oldest_t AS oldestAt, s.last_t AS lastT FROM stored_sessions s WHERE ${parts.join(' AND ')} ORDER BY s.last_t DESC, s.session_id`,
      )
      .all(...params) as unknown as CandidateRow[];
  }

  /**
   * Counts a session's entries that match `where` (on `entries`, may be empty) and finds the oldest, through the (session,
   * time) index, inside the time range [lo, hi). Each statement is bounded by rows, not by time: a boundary query finds the
   * time `sliceRows` index entries ahead, the count covers only up to it, and the event loop gets a turn between statements.
   * Entries that all share one instant are counted in one statement, however many (a time cannot be cut), which a reporter's
   * clock in milliseconds makes rare.
   */
  private async countIn(c: { sessionId: string; entries: number; oldestAt: number; lastT: number }, where: string, params: Param[], lo = -Infinity, hi = Infinity): Promise<{ n: number; oldest: number | null }> {
    const boundary = this.st('SELECT t FROM entries WHERE session_id = ? AND t >= ? ORDER BY t LIMIT 1 OFFSET ?');
    const count = this.st(`SELECT COUNT(*) AS n, MIN(t) AS oldest FROM entries WHERE session_id = ? AND t >= ? AND t < ?${where ? ` AND ${where}` : ''}`);
    const end = Math.min(c.lastT + 1, hi);
    let from = Math.max(c.oldestAt, lo);
    let n = 0;
    let oldest: number | null = null;
    while (from < end) {
      const at = from;
      const slice = await this.step(() => {
        const edge = boundary.get(c.sessionId, at, this.sliceRows) as { t: number } | undefined;
        let to = edge ? Math.min(edge.t, end) : end;
        if (to <= at) to = at + 1;
        return { to, r: count.get(c.sessionId, at, to, ...params) as { n: number; oldest: number | null } };
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
    // Without a filter on the entries the whole page is read in one step, as it always was; with one, the sessions are counted
    // one at a time with a turn between them, and the page is put together in a last step.
    if (!ww.sql) return this.step(() => this.listPage(this.candidates(filter), pg, size));
    const counted: CandidateRow[] = [];
    for (const c of await this.step(() => this.candidates(filter))) {
      const r = await this.countIn(c, ww.sql, ww.params, ww.lo, ww.hi);
      if (r.n > 0) counted.push({ ...c, entries: r.n, bytes: Math.round((r.n * c.bytes) / Math.max(c.entries, 1)), oldestAt: r.oldest ?? c.oldestAt });
      await yieldNow();
    }
    return this.step(() => this.listPage(counted, pg, size));
  }

  /** The page of `list` over the sessions already chosen and counted. */
  private listPage(all: CandidateRow[], pg: number, size: number): StoredActivityList {
    const match: StoredActivityList['match'] = { entries: 0, sessions: all.length, bytes: 0 };
    for (const c of all) {
      match.entries += c.entries;
      match.bytes += c.bytes;
    }
    const distinct = (col: 'project' | 'owner') => (this.st(`SELECT DISTINCT ${col} AS v FROM stored_sessions WHERE entries > 0 AND ${col} IS NOT NULL ORDER BY ${col}`).all() as { v: string }[]).map((r) => r.v);
    return {
      total: all.length,
      page: pg,
      pageSize: size,
      rows: all.slice((pg - 1) * size, pg * size).map(({ lastT: _lastT, ...c }): StoredSessionRow => ({ ...c, live: this.opts.isLive(c.sessionId) })),
      totals: this.totals(),
      match,
      projects: distinct('project'),
      owners: distinct('owner'),
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

  /** Runs `fn` as a heavy operation, one at a time with the purge and the deletes. Session recordings (#353) share this file and this turn-taking. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.heavy(fn);
  }

  /** Gives removed rows' space back to the system. Call it inside `runExclusive`; it is not itself serialized. */
  compactNow(): Promise<number> {
    return this.compact();
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
      const rows = await this.step(() => this.st('SELECT session_id AS sessionId, entries, bytes, oldest_t AS oldestAt, last_t AS lastT FROM stored_sessions WHERE entries > 0').all() as { sessionId: string; entries: number; bytes: number; oldestAt: number; lastT: number }[]);
      if (settings.policy === 'after') {
        const cutoff = this.opts.now() - activityPeriodMs(settings);
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
   * default policy. Works in chunks and compacts the file when it removed something. `freed` is the bytes the file gave back.
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
      if (s.policy === 'after') add(await this.removeWhere('t < ?', [now - activityPeriodMs(s)], touched));
      if (s.policy === 'end') {
        const ids = await this.step(() => (this.st('SELECT session_id AS id FROM stored_sessions').all() as { id: string }[]).map((r) => r.id).filter((id) => !this.opts.isLive(id)));
        for (const id of ids) {
          add(await this.removeWhere('session_id = ?', [id], touched));
          await yieldNow();
        }
      }
      if (s.capGb !== null) {
        const capBytes = s.capGb * (this.opts.capBytesPerGb ?? 1024 ** 3);
        // The excess is worked out in the step of the first chunk, so it is the one that chunk removes against.
        add(await this.removeOldest(() => (this.st('SELECT COALESCE(SUM(bytes), 0) AS b FROM stored_sessions').get() as { b: number }).b - capBytes, touched));
      }
      // Closed while a chunk waited its turn: the file is gone, so there is nothing left to tidy or compact.
      // `sessions` is the sessions that lost at least one entry; those left with nothing are dropped inside `finish`.
      const sessions = touched.sessions.size;
      if (this.closed) return { entries, bytes, sessions, freed: 0 };
      const dropped = await this.step(() => this.finish(touched));
      if (!entries && !dropped) return { entries, bytes, sessions, freed: 0 };
      const freed = await this.compact();
      this.last = { at: now, entries, bytes };
      return { entries, bytes, sessions, freed };
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
      const chunk = await this.step(() => {
        const started = performance.now();
        const rows = this.st(`SELECT id, session_id AS sid, loop, ${entryBytesSql()} AS b FROM entries WHERE ${where} LIMIT ?`).all(...params, size) as unknown as VictimRow[];
        if (!rows.length) return null;
        this.dropRows(rows, touched);
        return { n: rows.length, b: rows.reduce((a, r) => a + r.b, 0), tookMs: performance.now() - started };
      });
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
  private async removeOldest(over: () => number, touched: Touched): Promise<{ entries: number; bytes: number }> {
    let entries = 0;
    let bytes = 0;
    let excess: number | null = null;
    let limit = Math.min(this.chunk, FIRST_CHUNK);
    while (!this.closed) {
      const size = limit;
      const chunk = await this.step(() => {
        const started = performance.now();
        excess ??= over();
        if (excess <= 0) return null;
        const rows = this.st(`SELECT id, session_id AS sid, loop, ${entryBytesSql()} AS b FROM entries ORDER BY t, id LIMIT ?`).all(size) as unknown as VictimRow[];
        if (!rows.length) return null;
        const take: VictimRow[] = [];
        let b = 0;
        for (const r of rows) {
          take.push(r);
          excess -= r.b;
          b += r.b;
          if (excess <= 0) break;
        }
        this.dropRows(take, touched);
        return { n: take.length, b, tookMs: performance.now() - started };
      });
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
   * `chunkRows`, and not below a hundred rows. Deleting rows scattered through a big file costs more per row than rows that
   * sit together, so the chunk shrinks there and the console still never waits.
   */
  private nextChunk(limit: number, tookMs: number): number {
    const want = Math.round((limit * this.chunkMs) / Math.max(tookMs, 0.01));
    return Math.max(Math.min(100, this.chunk), Math.min(this.chunk, Math.ceil(limit * 1.5), want));
  }

  /** One chunk: deletes the rows and takes them off their sessions' aggregates in one transaction. */
  private dropRows(rows: VictimRow[], touched: Touched): void {
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
    this.db.exec('BEGIN');
    try {
      for (let i = 0; i < rows.length; i += DELETE_BATCH) {
        const ids = rows.slice(i, i + DELETE_BATCH).map((r) => r.id);
        this.st(`DELETE FROM entries WHERE id IN (${ids.map(() => '?').join(', ')})`).run(...ids);
      }
      for (const [sid, p] of perSession) {
        this.st('UPDATE stored_sessions SET entries = entries - ?, bytes = bytes - ? WHERE session_id = ?').run(p.n, p.b, sid);
        touched.sessions.add(sid);
      }
      for (const [key, l] of perLoop) {
        this.st('UPDATE loops SET entries = entries - ? WHERE session_id = ? AND loop = ?').run(l.n, l.sid, l.loop);
        touched.loops.set(key, { sid: l.sid, loop: l.loop });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * After a removal: settles the loops and sessions it touched. A loop or session left with no entry is dropped; for the rest
   * the first and last times are read again from the ends of their indexes. Returns how many sessions were dropped.
   */
  private finish(touched: Touched): number {
    for (const { sid, loop } of touched.loops.values()) {
      const row = this.st('SELECT entries FROM loops WHERE session_id = ? AND loop = ?').get(sid, loop) as { entries: number } | undefined;
      if (!row) continue;
      if (row.entries <= 0) this.st('DELETE FROM loops WHERE session_id = ? AND loop = ?').run(sid, loop);
      else {
        this.st(
          `UPDATE loops SET first_at = (SELECT at FROM entries WHERE session_id = ? AND loop = ? ORDER BY seq LIMIT 1),
             last_t = (SELECT t FROM entries WHERE session_id = ? AND loop = ? ORDER BY seq DESC LIMIT 1) WHERE session_id = ? AND loop = ?`,
        ).run(sid, loop, sid, loop, sid, loop);
      }
    }
    let dropped = 0;
    for (const sid of touched.sessions) {
      const row = this.st('SELECT entries FROM stored_sessions WHERE session_id = ?').get(sid) as { entries: number } | undefined;
      if (!row) continue;
      if (row.entries <= 0) {
        this.st('DELETE FROM stored_sessions WHERE session_id = ?').run(sid);
        dropped++;
      } else {
        this.st('UPDATE stored_sessions SET oldest_t = (SELECT t FROM entries WHERE session_id = ? ORDER BY t LIMIT 1) WHERE session_id = ?').run(sid, sid);
      }
    }
    return dropped;
  }

  /**
   * The Admin's delete: the ticked sessions, everything the filter matches, or everything. Works in chunks, session by
   * session. `sessions` counts the sessions that lost at least one entry, `bytes` the size of what went, `freed` what the file gave back.
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
      if ('all' in body) await each(await this.step(() => (this.st('SELECT session_id AS id FROM stored_sessions').all() as { id: string }[]).map((r) => r.id)));
      else if ('ids' in body) await each(body.ids);
      else {
        const ww = this.windowWhere(body.match);
        await each(await this.step(() => this.candidates(body.match).map((c) => c.sessionId)), ww.sql ? ` AND ${ww.sql}` : '', ww.params);
      }
      // Closed while it ran: the file is gone, so there is nothing to settle or compact.
      const sessions = touched.sessions.size;
      if (this.closed) return { entries, sessions, bytes, freed: 0 };
      await this.step(() => this.finish(touched));
      return { entries, sessions, bytes, freed: entries ? await this.compact() : 0 };
    });
  }

  /** A session was deleted: its rows and its loop positions go. */
  async deleteSession(sessionId: string): Promise<StoredDeleteResult> {
    this.forgetSession(sessionId);
    if (!(await this.step(() => this.st('SELECT 1 AS x FROM stored_sessions WHERE session_id = ?').get(sessionId)))) return { entries: 0, sessions: 0, bytes: 0, freed: 0 };
    return this.deleteBy({ ids: [sessionId] });
  }

  /**
   * Removes the rows of sessions the main database no longer holds (their own retention ran out). Returns the entries removed.
   * `exists` is asked once to pick the sessions and again just before each one's rows go, so a session that reported again in
   * between keeps them.
   */
  async dropMissingSessions(exists: (sessionId: string) => boolean | Promise<boolean>): Promise<number> {
    const stored = await this.step(() => (this.st('SELECT session_id AS id FROM stored_sessions').all() as { id: string }[]).map((r) => r.id));
    const ids: string[] = [];
    for (const id of stored) if (!(await exists(id))) ids.push(id);
    if (!ids.length) return 0;
    for (const id of ids) this.forgetSession(id);
    return (await this.deleteBy({ ids }, async (id) => !(await exists(id)))).entries;
  }

  /**
   * Gives the space of removed rows back to the system: incremental vacuum in bounded steps with a turn for the event loop
   * between them, then a WAL checkpoint that truncates the log. Returns the bytes the file gave back.
   */
  private async compact(): Promise<number> {
    const start = await this.step(() => ({ before: this.fileBytes(), free: this.pragma('freelist_count') }));
    let free = start.free;
    while (free > 0 && !this.closed) {
      const now = await this.step(() => {
        this.db.exec(`PRAGMA incremental_vacuum(${this.vacuumPages})`);
        return this.pragma('freelist_count');
      });
      if (now >= free) break;
      free = now;
      await yieldNow();
    }
    if (this.closed) return 0;
    return this.step(() => {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return Math.max(0, start.before - this.fileBytes());
    });
  }
}
