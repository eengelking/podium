// The Activity history store (#432): the agent Activity feed kept in the second SQLite file when the Admin chooses a keep
// policy. Under the default policy nothing here runs and the feed stays in memory (activity.ts).
//
// What it keeps: every entry of every loop a report carries, with no viewer's lease needed. The mod resends a snapshot of
// its last 20 entries on every report, so the snapshots overlap; `take` stores each entry once. A Podium-sent entry (an
// answer, message or command) is written when the live feed gets it, and keeps its ref, sender and note.
//
// What removes it: the purge (policy `after`, `end`, and the optional size cap), the Admin's deletes, a session's own
// deletion, and a session's retention in the main database (the shorter wins). Each removal ends by compacting the file.
import type { DatabaseSync } from 'node:sqlite';
import type { ActivityEntryView } from './activity.js';
import { activityPeriodMs } from './activityHistorySettings.js';
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
} from './activityHistoryTypes.js';
import { LIMITS, MAIN_LOOP, type ActivityEntry, type Report } from './protocol.js';

type Param = string | number | null;

/** What the Stored activity table shows about a session. */
export interface SessionMeta {
  name: string;
  project: string | null;
  owner: string | null;
}

export interface ActivityHistoryOpts {
  now: () => number;
  /** The Admin's choice, read on every call so a change takes effect at once. */
  settings: () => ActivityHistorySettings;
  /** Whether the `activity-feed` flag is on. Off, nothing is captured. */
  featureOn?: () => boolean;
  /** Whether the session is on the wall (running or waiting). Policy `end` removes the rest. */
  isLive: (sessionId: string) => boolean;
  /** The ids of the session's running agents, for the loops the server asks the mod to send. */
  agentsOf?: (sessionId: string) => string[];
  /** Whether the server runs with a sign-in token. Nothing is kept without one. */
  authOn: boolean;
  /** Bytes in a gigabyte for the size cap; tests lower it. */
  capBytesPerGb?: number;
}

/** What one purge run removed. `bytes` is the size of the entries; `freed` is what the file gave back after compaction. */
export interface PurgeResult {
  entries: number;
  bytes: number;
  sessions: number;
  freed: number;
}

/** Where a loop stands: the next sequence number, and the newest reporter entry's time with the entries stored at that time. */
interface Tail {
  seq: number;
  lastAt: number | null;
  same: Set<string>;
}

/** The size of one stored entry as the Stored activity table counts it: its text and labels, plus 48 bytes of row overhead. */
const bytesOf = (a: string) => `(length(${a}text) + length(${a}kind) + length(${a}loop) + COALESCE(length(${a}"by"), 0) + COALESCE(length(${a}note), 0) + COALESCE(length(${a}ref), 0) + 48)`;
const ENTRY_BYTES = bytesOf('');
const ENTRY_BYTES_E = bytesOf('e.');
const DAY_MS = 86_400_000;
const CHUNK = 500;
const VACUUM_PAGES = 1000;

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');
const like = (q: string) => `%${q.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;

interface EntryRow {
  seq: number;
  at: number;
  kind: string;
  text: string;
  by: string | null;
  note: string | null;
}

const viewOf = (r: EntryRow): ActivityEntryView =>
  r.kind === 'podium'
    ? { seq: r.seq, at: r.at, kind: 'podium', text: r.text, by: r.by ?? undefined, note: r.note }
    : { seq: r.seq, at: r.at, kind: r.kind as ActivityEntry['kind'], text: r.text };

export class ActivityHistory {
  private readonly tails = new Map<string, Tail>();
  private last: LastPurge | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: ActivityHistoryOpts,
  ) {}

  /** The Admin's settings as they stand now. */
  current(): ActivityHistorySettings {
    return this.opts.settings();
  }

  /** Whether entries are being captured: a keep policy, a server with a token, and the `activity-feed` flag on. */
  enabled(): boolean {
    return this.opts.authOn && this.opts.settings().policy !== 'default' && (this.opts.featureOn?.() ?? true);
  }

  /** The loops the server asks the mod to send for a session: the orchestrator and every running agent. */
  loopsToWatch(sessionId: string): string[] {
    return [MAIN_LOOP, ...(this.opts.agentsOf?.(sessionId) ?? [])];
  }

  /** The last run of the purge that removed something, or null if none has since the server started. */
  get lastPurge(): LastPurge | null {
    return this.last;
  }

  close(): void {
    this.db.close();
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
    let firstT = Infinity;
    let lastT = -Infinity;
    this.tx(sid, () => {
      for (const [loop, list] of lists) {
        for (const e of list ?? []) {
          if (!this.take(sid, loop, e, skewMs)) continue;
          const t = e.at - skewMs;
          firstT = Math.min(firstT, t);
          lastT = Math.max(lastT, t);
          stored++;
        }
      }
      if (stored) this.touchSession(sid, meta, firstT, lastT);
    });
    return stored;
  }

  /** Stores one reporter entry unless it repeats one already stored. */
  private take(sid: string, loop: string, e: ActivityEntry, skewMs: number): boolean {
    const tail = this.tail(sid, loop);
    const key = `${e.kind} ${e.text}`;
    if (tail.lastAt !== null) {
      if (e.at < tail.lastAt) return false;
      if (e.at === tail.lastAt && tail.same.has(key)) return false;
    }
    if (tail.lastAt !== e.at) {
      tail.lastAt = e.at;
      tail.same = new Set();
    }
    tail.same.add(key);
    this.insert(sid, loop, ++tail.seq, e.at, e.at - skewMs, e.kind, e.text.slice(0, LIMITS.activityText), null, null, null);
    return true;
  }

  /**
   * An answer, message or command sent from Podium, as an entry of the loop it is about. Podium's own time is the server's,
   * so `at` and `t` agree. It keeps its ref (to update the note later), who sent it and the note.
   */
  addPodium(sessionId: string, loop: string, ref: string, e: { at: number; text: string; by: string; note: string | null }, meta: SessionMeta): void {
    if (!this.enabled()) return;
    this.tx(sessionId, () => {
      const tail = this.tail(sessionId, loop);
      this.insert(sessionId, loop, ++tail.seq, e.at, e.at, 'podium', e.text.slice(0, LIMITS.activityText), e.by, e.note, ref);
      this.touchSession(sessionId, meta, e.at, e.at);
    });
  }

  /** A Podium entry's note changed (queued, then taken). */
  updatePodium(sessionId: string, ref: string, note: string | null): void {
    this.db.prepare('UPDATE entries SET note = ? WHERE session_id = ? AND ref = ?').run(note, sessionId, ref);
  }

  /** A Podium entry for something the session never took (discarded, refused, or the ask closed first). */
  removePodium(sessionId: string, ref: string): void {
    const n = Number(this.db.prepare('DELETE FROM entries WHERE session_id = ? AND ref = ?').run(sessionId, ref).changes);
    if (n) this.db.prepare('DELETE FROM stored_sessions WHERE session_id = ? AND NOT EXISTS (SELECT 1 FROM entries WHERE session_id = ?)').run(sessionId, sessionId);
  }

  /** The session left the live set: its in-memory loop positions go. Its rows stay, and the positions reload when it reports again. */
  forgetSession(sessionId: string): void {
    for (const key of [...this.tails.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.tails.delete(key);
  }

  private insert(sid: string, loop: string, seq: number, at: number, t: number, kind: string, text: string, by: string | null, note: string | null, ref: string | null): void {
    this.db
      .prepare('INSERT INTO entries (session_id, loop, seq, at, t, kind, text, "by", note, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sid, loop, seq, at, t, kind, text, by, note, ref);
  }

  private touchSession(sid: string, meta: SessionMeta, firstT: number, lastT: number): void {
    this.db
      .prepare(
        `INSERT INTO stored_sessions (session_id, name, project, owner, first_t, last_t) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET name = excluded.name, project = excluded.project, owner = excluded.owner,
           first_t = MIN(first_t, excluded.first_t), last_t = MAX(last_t, excluded.last_t)`,
      )
      .run(sid, meta.name, meta.project, meta.owner, firstT, lastT);
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
    const top = this.db.prepare('SELECT MAX(seq) AS seq FROM entries WHERE session_id = ? AND loop = ?').get(sid, loop) as { seq: number | null };
    const newest = this.db.prepare("SELECT MAX(at) AS at FROM entries WHERE session_id = ? AND loop = ? AND kind != 'podium'").get(sid, loop) as { at: number | null };
    const same = new Set<string>();
    if (newest.at !== null) {
      const rows = this.db.prepare("SELECT kind, text FROM entries WHERE session_id = ? AND loop = ? AND kind != 'podium' AND at = ?").all(sid, loop, newest.at) as { kind: string; text: string }[];
      for (const r of rows) same.add(`${r.kind} ${r.text}`);
    }
    tail = { seq: top.seq ?? 0, lastAt: newest.at, same };
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
      .prepare('SELECT seq, at, kind, text, "by" AS by, note FROM entries WHERE session_id = ? AND loop = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
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
    const r = this.db.prepare('SELECT COUNT(*) AS n, MIN(at) AS since, MAX(t) AS newest FROM entries WHERE session_id = ? AND loop = ?').get(sessionId, loop) as { n: number; since: number | null; newest: number | null };
    if (!r.n) return null;
    return { policy: s.policy, total: r.n, since: r.since, keptUntil: s.policy === 'after' && r.newest !== null ? r.newest + activityPeriodMs(s) : null };
  }

  /** Everything stored: entries, sessions, and the bytes of the file's pages in use. */
  totals(): StoredTotals {
    const r = this.db.prepare('SELECT COUNT(*) AS entries, COUNT(DISTINCT session_id) AS sessions FROM entries').get() as { entries: number; sessions: number };
    return { entries: r.entries, sessions: r.sessions, bytes: this.usedBytes() };
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

  /** The WHERE of a filter over `entries e JOIN stored_sessions s`, and its parameters. */
  private where(f: StoredFilter): { sql: string; params: Param[] } {
    const parts: string[] = [];
    const params: Param[] = [];
    if (f.q?.trim()) {
      parts.push("(LOWER(s.name) LIKE ? ESCAPE '\\' OR LOWER(e.session_id) LIKE ? ESCAPE '\\')");
      params.push(like(f.q.trim()), like(f.q.trim()));
    }
    if (f.loop === 'main') {
      parts.push('e.loop = ?');
      params.push(MAIN_LOOP);
    } else if (f.loop === 'agents') {
      parts.push('e.loop != ?');
      params.push(MAIN_LOOP);
    }
    if (f.project) {
      parts.push('s.project = ?');
      params.push(f.project);
    }
    if (f.owner) {
      parts.push('s.owner = ?');
      params.push(f.owner);
    }
    if (typeof f.olderThanDays === 'number') {
      parts.push('e.t < ?');
      params.push(this.opts.now() - f.olderThanDays * DAY_MS);
    }
    if (typeof f.from === 'number') {
      parts.push('e.t >= ?');
      params.push(f.from);
    }
    if (typeof f.to === 'number') {
      parts.push('e.t < ?');
      params.push(f.to);
    }
    return { sql: parts.length ? parts.join(' AND ') : '1 = 1', params };
  }

  /** The stored sessions the filter matches, a page at a time, newest first, with what is stored for each. */
  list(filter: StoredFilter, page = 1, pageSize = 25): StoredActivityList {
    const size = Math.min(Math.max(Math.floor(pageSize) || 25, 1), 200);
    const pg = Math.max(Math.floor(page) || 1, 1);
    const w = this.where(filter);
    const from = 'FROM entries e JOIN stored_sessions s ON s.session_id = e.session_id';
    const total = (this.db.prepare(`SELECT COUNT(DISTINCT e.session_id) AS n ${from} WHERE ${w.sql}`).get(...w.params) as { n: number }).n;
    const rows = this.db
      .prepare(
        `SELECT e.session_id AS sessionId, s.name AS name, s.project AS project, s.owner AS owner, COUNT(*) AS entries,
                SUM(${ENTRY_BYTES_E}) AS bytes, MIN(e.at) AS oldestAt
         ${from} WHERE ${w.sql} GROUP BY e.session_id ORDER BY MAX(e.t) DESC, e.session_id LIMIT ? OFFSET ?`,
      )
      .all(...w.params, size, (pg - 1) * size) as unknown as Omit<StoredSessionRow, 'live'>[];
    const m = this.db.prepare(`SELECT COUNT(*) AS entries, COUNT(DISTINCT e.session_id) AS sessions, COALESCE(SUM(${ENTRY_BYTES_E}), 0) AS bytes ${from} WHERE ${w.sql}`).get(...w.params) as unknown as StoredTotals;
    const distinct = (col: 'project' | 'owner') => (this.db.prepare(`SELECT DISTINCT ${col} AS v FROM stored_sessions WHERE ${col} IS NOT NULL ORDER BY ${col}`).all() as { v: string }[]).map((r) => r.v);
    return {
      total,
      page: pg,
      pageSize: size,
      rows: rows.map((r) => ({ ...r, live: this.opts.isLive(r.sessionId) })),
      totals: this.totals(),
      match: { entries: m.entries, sessions: m.sessions, bytes: m.bytes },
      projects: distinct('project'),
      owners: distinct('owner'),
    };
  }

  // ---- removal --------------------------------------------------------------------------------

  /**
   * What saving these settings would do now, without doing it. For a keep policy: the entries, bytes and sessions the purge
   * would remove, and `stopsCapturing` false. For the default policy nothing is removed, so it returns what is stored now
   * (the totals), with `stopsCapturing` true when anything is stored.
   */
  preview(settings: ActivityHistorySettings): ActivityHistoryPreview {
    if (settings.policy === 'default') {
      const t = this.totals();
      return { entries: t.entries, bytes: t.bytes, sessions: t.sessions, stopsCapturing: t.entries > 0 };
    }
    const r = this.apply(settings, this.opts.now(), false);
    return { entries: r.entries, bytes: r.bytes, sessions: r.sessions, stopsCapturing: false };
  }

  /**
   * Removes what the policy no longer keeps: under `after`, entries older than the period; under `end`, the sessions that
   * are not live; and under either or `all`, the oldest entries while the total is over the cap. Does nothing under the
   * default policy. Compacts the file when it removed something.
   */
  purge(now: number = this.opts.now()): PurgeResult {
    const s = this.opts.settings();
    if (s.policy === 'default') return { entries: 0, bytes: 0, sessions: 0, freed: 0 };
    const r = this.apply(s, now, true);
    if (!r.entries && !r.sessions) return { ...r, freed: 0 };
    const freed = this.compact();
    this.last = { at: now, entries: r.entries, bytes: r.bytes };
    return { ...r, freed };
  }

  /** Applies a policy inside a transaction. With `commit` false it rolls back, so the counts are what a purge would remove. */
  private apply(s: ActivityHistorySettings, now: number, commit: boolean): { entries: number; bytes: number; sessions: number } {
    let entries = 0;
    let bytes = 0;
    let sessions = 0;
    const remove = (where: string, params: Param[]) => {
      const r = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${ENTRY_BYTES}), 0) AS b FROM entries WHERE ${where}`).get(...params) as { n: number; b: number };
      if (!r.n) return;
      this.db.prepare(`DELETE FROM entries WHERE ${where}`).run(...params);
      entries += r.n;
      bytes += r.b;
    };
    this.db.exec('BEGIN');
    try {
      if (s.policy === 'after') remove('t < ?', [now - activityPeriodMs(s)]);
      if (s.policy === 'end') {
        const ids = (this.db.prepare('SELECT session_id AS id FROM stored_sessions').all() as { id: string }[]).map((r) => r.id).filter((id) => !this.opts.isLive(id));
        for (let i = 0; i < ids.length; i += CHUNK) {
          const part = ids.slice(i, i + CHUNK);
          remove(`session_id IN (${placeholders(part.length)})`, part);
        }
      }
      if (s.capGb !== null) {
        const cap = s.capGb * (this.opts.capBytesPerGb ?? 1024 ** 3);
        let total = (this.db.prepare(`SELECT COALESCE(SUM(${ENTRY_BYTES}), 0) AS b FROM entries`).get() as { b: number }).b;
        while (total > cap) {
          const oldest = this.db.prepare(`SELECT id, ${ENTRY_BYTES} AS b FROM entries ORDER BY t, id LIMIT ?`).all(CHUNK) as { id: number; b: number }[];
          if (!oldest.length) break;
          const ids: number[] = [];
          for (const r of oldest) {
            ids.push(r.id);
            total -= r.b;
            if (total <= cap) break;
          }
          remove(`id IN (${placeholders(ids.length)})`, ids);
        }
      }
      sessions = this.dropEmptySessions();
      this.db.exec(commit ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { entries, bytes, sessions };
  }

  /** Removes the stored_sessions rows that have no entry left. Returns how many. */
  private dropEmptySessions(): number {
    return Number(this.db.prepare('DELETE FROM stored_sessions WHERE session_id NOT IN (SELECT DISTINCT session_id FROM entries)').run().changes);
  }

  /** The Admin's delete: the ticked sessions, everything the filter matches, or everything. */
  deleteBy(body: StoredDeleteBody): StoredDeleteResult {
    let entries = 0;
    let bytes = 0;
    let sessions = 0;
    const remove = (where: string, params: Param[]) => {
      const r = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${ENTRY_BYTES}), 0) AS b FROM entries WHERE ${where}`).get(...params) as { n: number; b: number };
      if (r.n) this.db.prepare(`DELETE FROM entries WHERE ${where}`).run(...params);
      entries += r.n;
      bytes += r.b;
    };
    this.db.exec('BEGIN');
    try {
      if ('all' in body) remove('1 = 1', []);
      else if ('ids' in body) {
        for (let i = 0; i < body.ids.length; i += CHUNK) {
          const part = body.ids.slice(i, i + CHUNK);
          remove(`session_id IN (${placeholders(part.length)})`, part);
        }
      } else {
        const w = this.where(body.match);
        remove(`id IN (SELECT e.id FROM entries e JOIN stored_sessions s ON s.session_id = e.session_id WHERE ${w.sql})`, w.params);
      }
      sessions = this.dropEmptySessions();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { entries, sessions, bytes, freed: entries ? this.compact() : 0 };
  }

  /** A session was deleted: its rows and its loop positions go. */
  deleteSession(sessionId: string): StoredDeleteResult {
    this.forgetSession(sessionId);
    return this.deleteBy({ ids: [sessionId] });
  }

  /** Removes the rows of sessions the main database no longer holds (their own retention ran out). Returns the entries removed. */
  dropMissingSessions(exists: (sessionId: string) => boolean): number {
    const ids = (this.db.prepare('SELECT session_id AS id FROM stored_sessions').all() as { id: string }[]).map((r) => r.id).filter((id) => !exists(id));
    if (!ids.length) return 0;
    for (const id of ids) this.forgetSession(id);
    return this.deleteBy({ ids }).entries;
  }

  /**
   * Gives the space of removed rows back to the system: incremental vacuum in bounded steps, then a WAL checkpoint that
   * truncates the log. Returns the bytes the file gave back.
   */
  private compact(): number {
    const before = this.fileBytes();
    for (let pages = this.pragma('freelist_count'); pages > 0; pages -= VACUUM_PAGES) this.db.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return Math.max(0, before - this.fileBytes());
  }
}
