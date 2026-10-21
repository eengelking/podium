// Session recording on the server (#353, SPEC 6.4 "Session recording", 7.7 "Session recording"). The most Podium keeps of a
// conversation: whole prompts, tool inputs and results of the loops someone chose, kept in the Activity history's second file
// (activity.sqlite) in their own tables, so they never touch the main database's backups, vacuum or retention.
//
// Three yes answers are needed before anything is stored: the Admin's `session-recording` flag (with the server running on a
// token), a choice by the session's owner or an Admin (`start`), and the reporter's `sessionRecording` option, which each
// report carries (`noteOption`). Every reply to a report carries `grant`, so the mod captures only while all three are true.
//
// Expiry is per part: each entry goes `keepHours` after it was stored, and the time shown to a person is the oldest part still
// held. The per-session limit and the disk budget stop a recording with a `limit` mark in its place; nothing already stored is
// cut. Removals run in short chunks with a turn for the event loop between them, one heavy operation at a time, sharing the
// Activity history's turn-taking. The text of an entry is never logged and never leaves this file except through the read route.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { scrubStored } from '../logging/redact.js';
import type { StoredActivityList, StoredFilter, StoredSessionRow } from './activityHistoryTypes.js';
import { HOUR_MS, MB } from './recordingSettings.js';
import {
  MAIN_LOOP,
  RECORDING_LIMITS,
  type RecordingAdminRow,
  type RecordingBatch,
  type RecordingEntry,
  type RecordingGrant,
  type RecordingKind,
  type RecordingLimit,
  type RecordingLoopInfo,
  type RecordingRow,
  type RecordingSettings,
  type RecordingState,
  type RecordingView,
} from './protocol.js';

const DAY_MS = 86_400_000;
const CHUNK_ROWS = 5000;
const ROW_OVERHEAD = 48;

/**
 * How far apart (ms) a prompt Podium delivered and the mod's `prompt` entry for it may be and still count as the same prompt. A
 * message sent while the session runs waits in Claude Code's queue, so the entry can come well after the delivery.
 */
export const PODIUM_PROMPT_MATCH_MS = 10 * 60_000;

/** Whitespace folded, so a prompt matches however the line breaks and spaces came through. */
const squash = (s: string): string => s.replaceAll(/\s+/g, ' ').trim();

/** A prompt Podium delivered, waiting for the mod's entry that carries it. */
interface PodiumDelivery {
  loop: string;
  at: number;
  by: string;
  text: string;
  /** The delivery's id, so it can be forgotten. */
  ref?: string;
}

/** Gives the event loop a turn: queued requests, timers and reports run before the next chunk. */
const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What the Stored activity table and the Admin's table show about a session. */
export interface RecordingMeta {
  name: string;
  project: string | null;
  owner: string | null;
}

export interface RecordingsOpts {
  now: () => number;
  /** The Admin's limits, read on every call so a change takes effect at once. */
  settings: () => RecordingSettings;
  /** Whether the `session-recording` flag is on. */
  flagOn: () => boolean;
  /** Whether the server runs with a sign-in token. Nothing is recorded without one. */
  authOn: boolean;
  /** Whether the session is on the wall (running, waiting or lingering). A recording that is not live is not capturing. */
  isLive: (sessionId: string) => boolean;
  /** Every loop of the session with the name the layer shows. */
  loopsOf: (sessionId: string) => { loop: string; name: string }[];
  /** Credentials of this server, replaced wherever they appear in a stored entry. */
  secrets?: () => readonly string[];
  /** Runs a heavy operation one at a time with the Activity history's own, and gives the file's freed space back. */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  compact?: () => Promise<number>;
  /** Rows deleted per transaction in a purge or delete. Tests lower it. */
  chunkRows?: number;
}

/** What happened to a recording that the Admin log should hear of and the routes did not cause. */
export type RecordingTrail =
  | { kind: 'limit'; sessionId: string; which: RecordingLimit; bytes: number }
  | { kind: 'stopped'; sessionId: string; by: string }
  | { kind: 'carried'; sessionId: string; from: string; by: string | null };

export interface RecordingTotals {
  recordings: number;
  bytes: number;
  running: number;
}

export interface RemoveResult {
  entries: number;
  sessions: number;
  bytes: number;
  freed: number;
  /** One per recording removed, for the Admin log. */
  each: { sessionId: string; name: string; entries: number; bytes: number }[];
}

export interface PurgeRecordingsResult {
  entries: number;
  bytes: number;
  sessions: number;
  freed: number;
}

type StoredState = Exclude<RecordingState, 'off'>;

interface RecRow {
  sessionId: string;
  name: string;
  project: string | null;
  owner: string | null;
  state: StoredState;
  limitKind: RecordingLimit | null;
  loops: string[];
  startedBy: string | null;
  startedAt: number | null;
  stoppedBy: string | null;
  stoppedAt: number | null;
  entries: number;
  bytes: number;
  oldestT: number | null;
  lastT: number | null;
}

const ROW_SQL =
  'SELECT session_id AS sessionId, name, project, owner, state, limit_kind AS limitKind, loops, started_by AS startedBy, started_at AS startedAt, stopped_by AS stoppedBy, stopped_at AS stoppedAt, entries, bytes, oldest_t AS oldestT, last_t AS lastT FROM rec_sessions';

type RecDbRow = Omit<RecRow, 'loops'> & { loops: string };

function rowOf(raw: unknown): RecRow {
  const r = raw as RecDbRow;
  let loops: string[] = [];
  try {
    const v: unknown = JSON.parse(r.loops);
    if (Array.isArray(v)) loops = v.filter((x): x is string => typeof x === 'string');
  } catch {
    loops = [];
  }
  return { ...r, loops };
}

/** An entry as stored: the mod's (a prompt Podium delivered carries its sender in `by`), or a mark the server wrote. */
interface Stored {
  loop: string;
  seq: number;
  at: number;
  kind: RecordingKind;
  text: string;
  name?: string | null;
  callSeq?: number | null;
  failed?: boolean;
  cut?: boolean;
  lost?: number | null;
  by?: string | null;
}

const sizeOf = (e: Stored): number => Buffer.byteLength(e.text) + e.kind.length + e.loop.length + (e.name?.length ?? 0) + (e.by?.length ?? 0) + ROW_OVERHEAD;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export class SessionRecordings {
  /** Set by the routes: where the Admin log hears of what the server did on its own. */
  trail: ((t: RecordingTrail) => void) | null = null;
  /** Per session: whether the last report said the reporter's `sessionRecording` option is on. In memory; a report restores it. */
  private readonly options = new Map<string, boolean>();
  /** Per session: prompts Podium delivered that the mod's matching entry has not yet claimed. In memory only; nothing is stored for them. */
  private readonly deliveries = new Map<string, PodiumDelivery[]>();
  /** Sessions whose recording was deleted and whose rows are still going, so a new recording waits for them. */
  private readonly deleting = new Set<string>();
  private readonly stmts = new Map<string, StatementSync>();
  private readonly chunk: number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: RecordingsOpts,
  ) {
    this.chunk = Math.max(opts.chunkRows ?? CHUNK_ROWS, 1);
  }

  private st(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.opts.exclusive ? this.opts.exclusive(fn) : fn();
  }

  private compact(): Promise<number> {
    return this.opts.compact ? this.opts.compact() : Promise.resolve(0);
  }

  // ---- consent --------------------------------------------------------------------------------

  /** The Admin's flag is on and the server has a token. */
  enabled(): boolean {
    return this.opts.authOn && this.opts.flagOn();
  }

  /** Takes the reporter's `sessionRecording` option from a report. A reporter that does not send it is read as off. */
  noteOption(sessionId: string, on: boolean | undefined): void {
    this.options.set(sessionId, on === true);
  }

  optionOn(sessionId: string): boolean {
    return this.options.get(sessionId) === true;
  }

  /** The session left the server's live set: what is remembered about its option goes. */
  forgetSession(sessionId: string): void {
    this.options.delete(sessionId);
    this.deliveries.delete(sessionId);
  }

  private row(sessionId: string): RecRow | undefined {
    const r = this.st(`${ROW_SQL} WHERE session_id = ?`).get(sessionId);
    return r ? rowOf(r) : undefined;
  }

  /** Whether a recording is held for the session, whatever its state. */
  has(sessionId: string): boolean {
    return this.row(sessionId) !== undefined;
  }

  /** `recording` only while the flag is on and the session is live; a recording whose session ended, or whose flag went off, is `stopped`. */
  private stateOf(r: RecRow): StoredState {
    return r.state === 'recording' && !(this.enabled() && this.opts.isLive(r.sessionId)) ? 'stopped' : r.state;
  }

  /** Whether the session may send entries now: all three yes answers, and the batch's loops chosen. */
  capturing(sessionId: string): boolean {
    const r = this.enabled() ? this.row(sessionId) : undefined;
    return !!r && this.stateOf(r) === 'recording' && this.optionOn(sessionId);
  }

  /**
   * Up to which `at` the mod's route takes entries: no end while capturing, the stop's time for a recording a person (or the
   * session's /clear) stopped, so the last interval before the stop is not lost; null for everything else (a limit, nothing chosen,
   * deleted, the flag or the owner's option off).
   */
  acceptsUntil(sessionId: string): number | null {
    if (this.capturing(sessionId)) return Number.POSITIVE_INFINITY;
    const r = this.enabled() && this.optionOn(sessionId) ? this.row(sessionId) : undefined;
    return r?.state === 'stopped' ? r.stoppedAt! : null;
  }

  private keptUntil(r: RecRow): number {
    // The oldest part still held goes first. With nothing stored yet there is no part, so the time is counted from now.
    return (r.oldestT ?? this.opts.now()) + this.opts.settings().keepHours * HOUR_MS;
  }

  /** When the oldest part of the session's recording goes, or null when none is held (or the server has no token, as for `view`). */
  keptUntilOf(sessionId: string): number | null {
    if (!this.opts.authOn) return null;
    const r = this.row(sessionId);
    return r ? this.keptUntil(r) : null;
  }

  /** The consent state a report's reply and a batch's reply carry (SPEC 6.1). */
  grant(sessionId: string): RecordingGrant {
    const enabled = this.enabled();
    const owner = this.optionOn(sessionId);
    const r = enabled ? this.row(sessionId) : undefined;
    if (!r) {
      return { state: 'off', consent: { admin: enabled, chosen: false, owner }, loops: [], limit: null, startedBy: null, startedAt: null, stoppedBy: null, stoppedAt: null, keptUntil: null, bytes: 0 };
    }
    const state = this.stateOf(r);
    return {
      state,
      consent: { admin: true, chosen: state === 'recording', owner },
      loops: state === 'recording' ? r.loops : [],
      limit: state === 'limit' ? r.limitKind : null,
      startedBy: r.startedBy,
      startedAt: r.startedAt,
      stoppedBy: r.stoppedBy,
      stoppedAt: r.stoppedAt,
      keptUntil: this.keptUntil(r),
      bytes: r.bytes,
    };
  }

  /** What everyone sees of a recording: state, who started it, which loops and when it goes. Never any text. */
  view(sessionId: string): RecordingView | null {
    if (!this.opts.authOn) return null;
    const r = this.row(sessionId);
    if (!r) return null;
    const chosen = new Set(r.loops);
    const loops: RecordingLoopInfo[] = this.opts.loopsOf(sessionId).map((l) => ({ loop: l.loop, name: l.name, recorded: chosen.has(l.loop) }));
    return {
      state: this.stateOf(r),
      limit: r.state === 'limit' ? r.limitKind : null,
      startedBy: r.startedBy,
      startedAt: r.startedAt,
      stoppedBy: r.stoppedBy,
      stoppedAt: r.stoppedAt,
      keptUntil: this.keptUntil(r),
      bytes: r.bytes,
      loops,
      ownerAllows: this.optionOn(sessionId),
    };
  }

  /** Every loop of a session with whether it is recorded, for the replay's loop filter. */
  loopInfo(sessionId: string): RecordingLoopInfo[] {
    const chosen = new Set(this.row(sessionId)?.loops ?? []);
    return this.opts.loopsOf(sessionId).map((l) => ({ loop: l.loop, name: l.name, recorded: chosen.has(l.loop) }));
  }

  // ---- choosing, stopping --------------------------------------------------------------------

  totalBytes(): number {
    return (this.st('SELECT COALESCE(SUM(bytes), 0) AS b FROM rec_sessions').get() as { b: number }).b;
  }

  /**
   * Someone with the right chose to record the session's loops from now on. Nothing before this moment is kept. Starts a new
   * recording, changes the loops of a running one, or starts a stopped one again. `limit` when its own limit stopped it (delete
   * it first), `budget` while the stored total is at the Admin's budget, `busy` while a delete of it is still going.
   */
  start(sessionId: string, loops: string[], by: string, meta: RecordingMeta): 'ok' | 'limit' | 'budget' | 'busy' {
    if (this.deleting.has(sessionId)) return 'busy';
    const r = this.row(sessionId);
    if (r?.state === 'limit') return 'limit';
    if (this.totalBytes() >= this.opts.settings().budgetMb * MB) return 'budget';
    const now = this.opts.now();
    // A recording that is running keeps who started it and when; one that was stopped starts again from now.
    const keep = r?.state === 'recording' ? r : undefined;
    this.st(
      `INSERT INTO rec_sessions (session_id, name, project, owner, state, loops, started_by, started_at) VALUES (?, ?, ?, ?, 'recording', ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET name = excluded.name, project = excluded.project, owner = excluded.owner, state = 'recording',
         loops = excluded.loops, started_by = ?, started_at = ?, stopped_by = NULL, stopped_at = NULL`,
    ).run(sessionId, meta.name, meta.project, meta.owner, JSON.stringify(loops), by, now, keep ? keep.startedBy : by, keep ? keep.startedAt : now);
    return 'ok';
  }

  /** The recording's state as the Admin's table shows it, or undefined when there is none. */
  stateFor(sessionId: string): StoredState | undefined {
    const r = this.row(sessionId);
    return r ? this.stateOf(r) : undefined;
  }

  /**
   * Stop capture and keep what was recorded. Null when there is no recording. A recording already stopped is left as it is
   * (`changed` false), so it is neither marked again nor logged again.
   */
  stop(sessionId: string, by: string): { grant: RecordingGrant; changed: boolean } | null {
    const r = this.row(sessionId);
    if (!r) return null;
    const changed = r.state === 'recording';
    if (changed) {
      const now = this.opts.now();
      this.tx(() => {
        this.st("UPDATE rec_sessions SET state = 'stopped', stopped_by = ?, stopped_at = ? WHERE session_id = ?").run(by, now, sessionId);
        this.mark(sessionId, 'stopped', '', by);
      });
    }
    return { grant: this.grant(sessionId), changed };
  }

  /** The Admin turned the flag off: every running recording stops and keeps what it has. Returns the sessions stopped. */
  stopAll(by: string): string[] {
    const ids = (this.st("SELECT session_id AS id FROM rec_sessions WHERE state = 'recording'").all() as { id: string }[]).map((x) => x.id);
    const now = this.opts.now();
    this.tx(() => {
      for (const id of ids) {
        this.st("UPDATE rec_sessions SET state = 'stopped', stopped_by = ?, stopped_at = ? WHERE session_id = ?").run(by, now, id);
        this.mark(id, 'stopped', '', by);
      }
    });
    for (const id of ids) this.emit({ kind: 'stopped', sessionId: id, by });
    return ids;
  }

  /**
   * A /clear gave the session a new id. When the old one was being recorded, the new one is recorded from its first report with the
   * same starter and the orchestrator's loop; the owner's option is the new session's own, as its report says. PROVISIONAL (#353).
   */
  carryOver(oldId: string, newId: string, meta: RecordingMeta): boolean {
    if (!this.enabled() || this.deleting.has(newId)) return false;
    const old = this.row(oldId);
    if (old?.state !== 'recording' || !old.loops.includes(MAIN_LOOP) || this.row(newId)) return false;
    const now = this.opts.now();
    this.tx(() => {
      this.st("UPDATE rec_sessions SET state = 'stopped', stopped_by = NULL, stopped_at = ? WHERE session_id = ?").run(now, oldId);
      this.st("INSERT INTO rec_sessions (session_id, name, project, owner, state, loops, started_by, started_at) VALUES (?, ?, ?, ?, 'recording', ?, ?, ?)").run(newId, meta.name, meta.project, meta.owner, JSON.stringify([MAIN_LOOP]), old.startedBy, old.startedAt ?? now);
    });
    this.emit({ kind: 'carried', sessionId: newId, from: oldId, by: old.startedBy });
    return true;
  }

  private emit(t: RecordingTrail): void {
    try {
      this.trail?.(t);
    } catch {
      // the Admin log is best effort here: a failing write must not undo a stop
    }
  }

  // ---- capture --------------------------------------------------------------------------------

  private bump(sessionId: string, entries: number, bytes: number, t: number): void {
    this.st(
      'UPDATE rec_sessions SET entries = entries + ?, bytes = bytes + ?, oldest_t = MIN(COALESCE(oldest_t, ?), ?), last_t = MAX(COALESCE(last_t, ?), ?) WHERE session_id = ?',
    ).run(entries, bytes, t, t, t, t, sessionId);
  }

  private insert(sessionId: string, e: Stored, t: number): number {
    const b = sizeOf(e);
    this.st(
      'INSERT INTO rec_entries (session_id, loop, seq, at, t, kind, text, name, call_seq, failed, cut, lost, "by", b) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(sessionId, e.loop, e.seq, e.at, t, e.kind, e.text, e.name ?? null, e.callSeq ?? null, e.failed ? 1 : null, e.cut ? 1 : null, e.lost ?? null, e.by ?? null, b);
    return b;
  }

  /** The next sequence number for an entry the server writes in a loop: 0, -1, -2 ..., never in the mod's range from 1. */
  private serverSeq(sessionId: string, loop: string): number {
    const r = this.st('SELECT COALESCE(MIN(seq), 1) - 1 AS s FROM rec_entries WHERE session_id = ? AND loop = ? AND seq <= 0').get(sessionId, loop) as { s: number };
    return r.s;
  }

  /** An entry the server writes (a mark), in the orchestrator's loop unless told otherwise. */
  private mark(sessionId: string, kind: RecordingKind, text: string, by: string | null, loop: string = MAIN_LOOP, at: number = this.opts.now()): void {
    const now = this.opts.now();
    const b = this.insert(sessionId, { loop, seq: this.serverSeq(sessionId, loop), at, kind, text, by }, now);
    this.bump(sessionId, 1, b, now);
  }

  private setLimit(sessionId: string, which: RecordingLimit): void {
    this.st("UPDATE rec_sessions SET state = 'limit', limit_kind = ?, stopped_at = ? WHERE session_id = ?").run(which, this.opts.now(), sessionId);
    this.mark(sessionId, 'limit', which === 'budget' ? 'The recording stopped: the disk budget was reached.' : 'The recording stopped: this session reached its size limit.', null);
  }

  /**
   * Stores a batch the mod sent for a session that may send (see `capturing`). An entry already held, by (loop, seq), is dropped;
   * so is one of a loop nobody chose. The entry that would pass the session's limit or the disk budget, and everything after it,
   * is not stored; the recording stops with a `limit` mark instead. Returns how many entries were new.
   */
  ingest(sessionId: string, batch: RecordingBatch, meta?: RecordingMeta): number {
    const r = this.row(sessionId);
    if (!r) return 0;
    // A stopped recording takes the entries captured before the stop (the mod's last interval) and none after it.
    const until = r.state === 'stopped' ? r.stoppedAt! : Number.POSITIVE_INFINITY;
    const s = this.opts.settings();
    const cap = s.sessionMb * MB;
    const budget = s.budgetMb * MB;
    const chosen = new Set(r.loops);
    const secrets = this.opts.secrets?.() ?? [];
    const now = this.opts.now();
    let total = this.totalBytes();
    let size = r.bytes;
    let stored = 0;
    let added = 0;
    const hit: { sessionId: string; which: RecordingLimit; bytes: number }[] = [];
    this.tx(() => {
      for (const e of batch.entries) {
        if (!chosen.has(e.loop) || e.at > until) continue;
        if (this.st('SELECT 1 AS x FROM rec_entries WHERE session_id = ? AND loop = ? AND seq = ?').get(sessionId, e.loop, e.seq)) continue;
        const entry = this.clean(e, secrets);
        const by = this.takeDelivery(sessionId, e);
        if (by !== null) entry.by = by;
        const b = sizeOf(entry);
        const which: RecordingLimit | null = size + b > cap ? 'session' : total + b > budget ? 'budget' : null;
        if (which && r.state === 'stopped') break; // a late entry never turns a stop into a limit
        if (which) {
          this.setLimit(sessionId, which);
          hit.push({ sessionId, which, bytes: size });
          if (which === 'budget') {
            for (const other of this.st("SELECT session_id AS id FROM rec_sessions WHERE state = 'recording' AND session_id != ?").all(sessionId) as { id: string }[]) {
              this.setLimit(other.id, 'budget');
              hit.push({ sessionId: other.id, which: 'budget', bytes: 0 });
            }
          }
          break;
        }
        this.insert(sessionId, entry, now);
        size += b;
        total += b;
        added += b;
        stored++;
      }
      if (stored) this.bump(sessionId, stored, added, now);
      if (meta) this.st('UPDATE rec_sessions SET name = ?, project = ?, owner = ? WHERE session_id = ?').run(meta.name, meta.project, meta.owner, sessionId);
    });
    for (const h of hit) this.emit({ kind: 'limit', ...h });
    return stored;
  }

  /** The mod's entry as stored: Podium's own credentials replaced, the rest as the mod redacted it (SPEC 6.4). */
  private clean(e: RecordingEntry, secrets: readonly string[]): Stored {
    return {
      loop: e.loop,
      seq: e.seq,
      at: e.at,
      kind: e.kind,
      text: scrubStored(e.text, secrets, false),
      name: e.name,
      callSeq: e.callSeq,
      failed: e.failed,
      cut: e.cut,
      lost: e.lost,
      // The mod names the sender of what it took from Podium (a decision, a /clear, a /compact); a prompt's is added by `takeDelivery`.
      by: e.kind === 'decision' || e.kind === 'clear' || e.kind === 'compact' ? (e.by ?? null) : null,
    };
  }

  /**
   * A message delivered from Podium to a recorded loop is remembered (loop, time, sender, text as redacted here), not stored. The
   * mod records every prompt of the loop and cannot tell where one came from, so when its matching `prompt` entry arrives in
   * `ingest` the server adds the sender to that entry. A delivery no entry ever matches stores nothing. PROVISIONAL (#353).
   * Only a message becomes a prompt: an answer, an approval, a permission decision and /clear and /compact are recorded by the
   * mod where it takes them (`decision`, `clear`, `compact`), so none of them is remembered here. `ref` names the delivery, so
   * one taken back before the mod got it can be forgotten.
   */
  notePodiumPrompt(sessionId: string, loop: string, e: { at: number; text: string; by: string }, ref?: string): void {
    if (!this.capturing(sessionId)) return;
    const r = this.row(sessionId);
    if (!r?.loops.includes(loop)) return;
    const now = this.opts.now();
    const kept = (this.deliveries.get(sessionId) ?? []).filter((d) => now - d.at <= PODIUM_PROMPT_MATCH_MS);
    kept.push({ loop, at: e.at, by: e.by, ref, text: squash(scrubStored(e.text.slice(0, RECORDING_LIMITS.text), this.opts.secrets?.() ?? [], true)) });
    this.deliveries.set(sessionId, kept);
  }

  /** A message that will never reach the mod (discarded, refused, closed) is no longer waiting for its prompt entry. */
  forgetPodiumPrompt(sessionId: string, ref: string): void {
    const list = this.deliveries.get(sessionId);
    if (list) this.deliveries.set(sessionId, list.filter((d) => d.ref !== ref));
  }

  /** Takes the oldest remembered delivery that this mod `prompt` entry is: same loop, close in time, its text the delivered one (or holding it). */
  private takeDelivery(sessionId: string, e: RecordingEntry): string | null {
    const list = this.deliveries.get(sessionId);
    if (e.kind !== 'prompt' || !list) return null;
    const text = squash(e.text); // the mod redacted it already; a second pass is not idempotent
    if (text === '') return null;
    const i = list.findIndex((d) => d.loop === e.loop && Math.abs(e.at - d.at) <= PODIUM_PROMPT_MATCH_MS && d.text !== '' && (text.includes(d.text) || d.text.includes(text)));
    return i < 0 ? null : list.splice(i, 1)[0]!.by;
  }

  // ---- reads ----------------------------------------------------------------------------------

  /**
   * One page of a replay, oldest first: the newest `limit` rows older than `before` (an `n`), of one loop when given. `olderBefore`
   * is the `n` to pass for the next older page, or null. `total` counts the rows the loop filter matches.
   */
  page(sessionId: string, before: number | null, limit: number, loop: string | null): { entries: RecordingRow[]; olderBefore: number | null; total: number } {
    const size = Math.min(Math.max(Math.floor(limit) || RECORDING_LIMITS.page, 1), RECORDING_LIMITS.page);
    const at = before ?? Number.MAX_SAFE_INTEGER;
    const rows = (
      loop === null
        ? this.st('SELECT n, seq, loop, at, kind, text, name, call_seq AS callSeq, failed, cut, lost, "by" AS by FROM rec_entries WHERE session_id = ? AND n < ? ORDER BY n DESC LIMIT ?').all(sessionId, at, size)
        : this.st('SELECT n, seq, loop, at, kind, text, name, call_seq AS callSeq, failed, cut, lost, "by" AS by FROM rec_entries WHERE session_id = ? AND loop = ? AND n < ? ORDER BY n DESC LIMIT ?').all(sessionId, loop, at, size)
    ) as unknown as PageRow[];
    rows.reverse();
    const oldest = rows[0]?.n;
    let olderBefore: number | null = null;
    if (oldest !== undefined) {
      const older = loop === null ? this.st('SELECT 1 AS x FROM rec_entries WHERE session_id = ? AND n < ? LIMIT 1').get(sessionId, oldest) : this.st('SELECT 1 AS x FROM rec_entries WHERE session_id = ? AND loop = ? AND n < ? LIMIT 1').get(sessionId, loop, oldest);
      olderBefore = older ? oldest : null;
    }
    const total = loop === null ? (this.row(sessionId)?.entries ?? 0) : (this.st('SELECT COUNT(*) AS c FROM rec_entries WHERE session_id = ? AND loop = ?').get(sessionId, loop) as { c: number }).c;
    return { entries: rows.map(viewOf), olderBefore, total };
  }

  totals(): RecordingTotals {
    const rows = this.all();
    return { recordings: rows.length, bytes: rows.reduce((a, r) => a + r.bytes, 0), running: rows.filter((r) => this.stateOf(r) === 'recording').length };
  }

  private all(): RecRow[] {
    return this.st(`${ROW_SQL} ORDER BY COALESCE(last_t, started_at, 0) DESC, session_id`).all().map(rowOf);
  }

  /** The Admin's Recordings table: running or kept, a page at a time. `state` and `q` (name, id or owner) narrow it. */
  adminList(opts: { page: number; pageSize: number; state?: StoredState; q?: string }): { total: number; page: number; pageSize: number; rows: RecordingAdminRow[]; totals: RecordingTotals } {
    const q = opts.q?.trim().toLowerCase();
    const rows = this.all()
      .map((r): RecordingAdminRow => {
        const agents = r.loops.filter((l) => l !== MAIN_LOOP).length;
        const main = r.loops.includes(MAIN_LOOP);
        const label = main ? (agents ? `orchestrator and ${plural(agents, 'agent', 'agents')}` : 'orchestrator') : plural(agents, 'agent', 'agents');
        return { sessionId: r.sessionId, name: r.name, owner: r.owner, startedBy: r.startedBy, state: this.stateOf(r), limit: r.state === 'limit' ? r.limitKind : null, loops: r.loops.length, label, bytes: r.bytes, keptUntil: this.keptUntil(r) };
      })
      .filter((r) => (!opts.state || r.state === opts.state) && (!q || r.name.toLowerCase().includes(q) || r.sessionId.toLowerCase().includes(q) || (r.owner ?? '').toLowerCase().includes(q)));
    const size = Math.min(Math.max(Math.floor(opts.pageSize) || 25, 1), 200);
    const page = Math.max(Math.floor(opts.page) || 1, 1);
    return { total: rows.length, page, pageSize: size, rows: rows.slice((page - 1) * size, page * size), totals: this.totals() };
  }

  /** The recordings a Stored activity filter matches (Source = Recordings). The loop filter does not apply to a whole recording. */
  private matching(f: StoredFilter): RecRow[] {
    const q = f.q?.trim().toLowerCase();
    const now = this.opts.now();
    return this.all().filter(
      (r) =>
        r.entries > 0 &&
        (!q || r.name.toLowerCase().includes(q) || r.sessionId.toLowerCase().includes(q)) &&
        (!f.project || r.project === f.project) &&
        (!f.owner || r.owner === f.owner) &&
        (typeof f.olderThanDays !== 'number' || (r.oldestT ?? Infinity) < now - f.olderThanDays * DAY_MS) &&
        (typeof f.from !== 'number' || (r.lastT ?? -Infinity) >= f.from) &&
        (typeof f.to !== 'number' || (r.oldestT ?? Infinity) < f.to),
    );
  }

  /** The Stored activity page for Source = Recordings: the same shape as the Activity history's list. `fileBytes` is the caller's to fill. */
  listStored(f: StoredFilter, page: number, pageSize: number): StoredActivityList {
    const size = Math.min(Math.max(Math.floor(pageSize) || 25, 1), 200);
    const pg = Math.max(Math.floor(page) || 1, 1);
    const hits = this.matching(f);
    const stored = this.all().filter((r) => r.entries > 0);
    const sum = (rs: RecRow[]) => ({ entries: rs.reduce((a, r) => a + r.entries, 0), sessions: rs.length, bytes: rs.reduce((a, r) => a + r.bytes, 0) });
    const distinct = (pick: (r: RecRow) => string | null) => [...new Set(stored.map(pick).filter((v): v is string => v !== null))].sort();
    return {
      total: hits.length,
      page: pg,
      pageSize: size,
      rows: hits.slice((pg - 1) * size, pg * size).map((r): StoredSessionRow => ({ sessionId: r.sessionId, name: r.name, project: r.project, owner: r.owner, live: this.opts.isLive(r.sessionId), entries: r.entries, bytes: r.bytes, oldestAt: r.oldestT ?? 0 })),
      totals: { ...sum(stored), fileBytes: 0 },
      match: sum(hits),
      projects: distinct((r) => r.project),
      owners: distinct((r) => r.owner),
    };
  }

  /** The session ids a Stored activity delete means for Source = Recordings. */
  idsFor(body: { ids: string[] } | { match: StoredFilter } | { all: true }): string[] {
    if ('ids' in body) return body.ids;
    if ('match' in body) return this.matching(body.match).map((r) => r.sessionId);
    return this.all().map((r) => r.sessionId);
  }

  // ---- removal --------------------------------------------------------------------------------

  /**
   * Deletes whole recordings for good and stops their capture at once (the rows that carry the state go before this returns a
   * promise); the entries then go in chunks with a turn for the event loop between them, and the file is compacted once.
   */
  async removeMany(ids: string[]): Promise<RemoveResult> {
    const each: RemoveResult['each'] = [];
    for (const id of ids) {
      const r = this.row(id);
      if (!r) continue;
      this.st('DELETE FROM rec_sessions WHERE session_id = ?').run(id);
      this.deleting.add(id);
      each.push({ sessionId: id, name: r.name, entries: r.entries, bytes: r.bytes });
    }
    if (!each.length) return { entries: 0, sessions: 0, bytes: 0, freed: 0, each };
    try {
      const freed = await this.exclusive(async () => {
        for (const g of each) await this.deleteEntriesOf(g.sessionId);
        return this.compact();
      });
      return { entries: each.reduce((a, g) => a + g.entries, 0), sessions: each.length, bytes: each.reduce((a, g) => a + g.bytes, 0), freed, each };
    } finally {
      for (const g of each) this.deleting.delete(g.sessionId);
    }
  }

  private async deleteEntriesOf(sessionId: string): Promise<void> {
    for (;;) {
      const done = this.st('DELETE FROM rec_entries WHERE n IN (SELECT n FROM rec_entries WHERE session_id = ? LIMIT ?)').run(sessionId, this.chunk).changes;
      if (Number(done) < this.chunk) return;
      await yieldNow();
    }
  }

  /** The session is gone from the main database: its recording goes with it. */
  removeSession(sessionId: string): Promise<RemoveResult> {
    return this.removeMany([sessionId]);
  }

  /** Removes the recordings of sessions the main database no longer holds (their own retention ran out). Returns the entries removed. */
  async dropMissingSessions(exists: (sessionId: string) => boolean): Promise<number> {
    const ids = (this.st('SELECT session_id AS id FROM rec_sessions').all() as { id: string }[]).map((r) => r.id).filter((id) => !exists(id));
    return (await this.removeMany(ids)).entries;
  }

  /**
   * Removes every part older than `keepHours`, counted from when it was stored, in chunks. A recording left with nothing is dropped
   * unless it is still running. Compacts the file when it removed something. Frequent (every 5 minutes), so a short time is honored.
   */
  purge(now: number = this.opts.now()): Promise<PurgeRecordingsResult> {
    return this.exclusive(async () => {
      const cutoff = now - this.opts.settings().keepHours * HOUR_MS;
      const touched = new Set<string>();
      let entries = 0;
      let bytes = 0;
      for (;;) {
        const rows = this.tx(() => {
          const gone = this.st('DELETE FROM rec_entries WHERE n IN (SELECT n FROM rec_entries WHERE t < ? LIMIT ?) RETURNING session_id AS sid, b').all(cutoff, this.chunk) as { sid: string; b: number }[];
          const per = new Map<string, { n: number; b: number }>();
          for (const g of gone) {
            const p = per.get(g.sid) ?? { n: 0, b: 0 };
            p.n++;
            p.b += g.b;
            per.set(g.sid, p);
          }
          for (const [sid, p] of per) this.st('UPDATE rec_sessions SET entries = entries - ?, bytes = bytes - ? WHERE session_id = ?').run(p.n, p.b, sid);
          return gone;
        });
        for (const g of rows) {
          touched.add(g.sid);
          entries++;
          bytes += g.b;
        }
        if (rows.length < this.chunk) break;
        await yieldNow();
      }
      for (const sid of touched) this.st('UPDATE rec_sessions SET oldest_t = (SELECT MIN(t) FROM rec_entries WHERE session_id = ?) WHERE session_id = ?').run(sid, sid);
      let dropped = 0;
      for (const r of this.st('SELECT session_id AS id FROM rec_sessions WHERE entries <= 0').all() as { id: string }[]) {
        const row = this.row(r.id);
        if (row && row.state === 'recording' && this.enabled() && this.opts.isLive(r.id)) continue;
        this.st('DELETE FROM rec_sessions WHERE session_id = ?').run(r.id);
        dropped++;
      }
      const freed = entries || dropped ? await this.compact() : 0;
      return { entries, bytes, sessions: touched.size, freed };
    });
  }
}

interface PageRow {
  n: number;
  seq: number;
  loop: string;
  at: number;
  kind: RecordingKind;
  text: string;
  name: string | null;
  callSeq: number | null;
  failed: number | null;
  cut: number | null;
  lost: number | null;
  by: string | null;
}

const viewOf = (r: PageRow): RecordingRow => ({
  n: r.n,
  seq: r.seq,
  loop: r.loop,
  at: r.at,
  kind: r.kind,
  text: r.text,
  ...(r.name === null ? {} : { name: r.name }),
  ...(r.callSeq === null ? {} : { callSeq: r.callSeq }),
  ...(r.failed ? { failed: true } : {}),
  ...(r.cut ? { cut: true } : {}),
  ...(r.lost === null ? {} : { lost: r.lost }),
  ...(r.by === null ? {} : { by: r.by }),
});
