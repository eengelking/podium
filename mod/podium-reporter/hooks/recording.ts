// Session recording on the machine (#353, SPEC 5.3 "Session recording from the reporter", 6.4 "Session recording"). Pure: no `$` here.
//
// The `Recorder` holds what a recording needs between hooks: whether capture is on (the server's grant, the owner's option), the
// per-loop numbering of entries, a bounded queue of redacted entries and the batching of them. Nothing is captured, stored or
// queued while capture is off. register.ts feeds it from the hooks and sends its batches from the flush timer.
import { clockTime } from './respond.ts';
import { redactText, withheldPath, type Redacted } from './diffRedact.ts';
import { BACKOFF_MS } from './transport.ts';
import { RECORDING_LIMITS, type RecordingBatch, type RecordingEntry, type RecordingGrant, type RecordingKind } from './protocol.ts';

/**
 * How soon after a batch the next one may go. PROVISIONAL: chosen from the write-load measurement of #353's checklist, not yet
 * measured. The spec's ceiling is one request a second.
 */
export const RECORDING_BATCH_INTERVAL_MS = 1000;
/** Entries in one request (the server's limit). */
export const RECORDING_BATCH_ENTRIES = RECORDING_LIMITS.entries;
/** Serialized bytes of one request (the server's limit, under its 512 KB body limit). */
export const RECORDING_BATCH_BYTES = RECORDING_LIMITS.bodyBytes;
/** Bytes the queue holds while the server cannot be reached. PROVISIONAL (8 MB), see SPEC 6.4. */
export const RECORDING_QUEUE_BYTES = RECORDING_LIMITS.queueBytes;
/** Room in a request for its envelope (`v`, `sentAt`, the array) beyond the entries. */
const ENVELOPE_BYTES = 200;

/** The result recorded for a file on the never-send list. */
export const WITHHELD = '[withheld: this file is on the never-send list]';

/** The visible marker at the end of a text cut at `n` characters. */
export function cutMark(n: number): string {
  return `[cut off at ${String(n).replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',')} characters]`;
}
export const CUT_MARK = cutMark(RECORDING_LIMITS.text);

/** Tools whose input names a file; one on the never-send list is recorded as its path alone. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** The event's own fields beside a tool's arguments: not part of the call. */
const EVENT_FIELDS = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta']);
const MAX_DEPTH = 32;

/** How many bytes a string takes in UTF-8, as the request body counts them. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Capture needs the grant to say recording, all three yes answers, and the owner's option here. */
function allowed(g: RecordingGrant, optionOn: boolean): boolean {
  return optionOn && g.state === 'recording' && g.consent.admin && g.consent.chosen && g.consent.owner;
}

/** Longest stretch redacted in one piece. The redactor's cost grows with the square of a line, so a minified file or a base64 blob is read in pieces. */
const REDACT_PIECE = 1000;

/**
 * `redactText` for a text of any size. A line longer than REDACT_PIECE is redacted in pieces (cut at a space when it has one)
 * and put back together, so a 100,000 character line costs milliseconds, not seconds. A secret that straddles a cut is not
 * seen, like one split across two entries (SPEC 6.4, what redaction does not cover).
 */
export function redactBounded(text: string): Redacted {
  if (text.length <= REDACT_PIECE) return redactText(text);
  const counts: number[] = [];
  const pieces: string[] = [];
  for (const line of text.split('\n')) {
    let n = 0;
    let at = 0;
    do {
      let end = Math.min(at + REDACT_PIECE, line.length);
      const space = end < line.length ? line.lastIndexOf(' ', end) : -1;
      if (space > at) end = space + 1;
      pieces.push(line.slice(at, end));
      n++;
      at = end;
    } while (at < line.length);
    counts.push(n);
  }
  const r = redactText(pieces.join('\n'));
  const out = r.text.split('\n');
  let i = 0;
  const lines = counts.map((n) => out.slice(i, (i += n)).join(''));
  return { text: lines.join('\n'), redactions: r.redactions };
}

/** The path a file tool's input names, and the key it sits under. */
function pathOf(tool: string, input: Record<string, unknown>): { key: string; path: string } | null {
  if (!FILE_TOOLS.has(tool)) return null;
  for (const key of ['file_path', 'notebook_path']) if (typeof input[key] === 'string') return { key, path: input[key] };
  return null;
}

/** Whether a tool call names a file on the never-send list. */
export function withheldCall(tool: string, input: Record<string, unknown>): boolean {
  const p = pathOf(tool, input);
  return !!p && withheldPath(p.path);
}

function redactLeaves(v: unknown, depth: number, count: { n: number }): unknown {
  if (typeof v === 'string') {
    const r = redactBounded(v);
    count.n += r.redactions;
    return r.text;
  }
  if (depth >= MAX_DEPTH || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactLeaves(x, depth + 1, count));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactLeaves(x, depth + 1, count)]));
}

/**
 * A tool call's whole input as JSON text, redacted. A call that names a file on the never-send list keeps its path and nothing
 * else (no old or new text). Strings are redacted one by one, so a key block keeps its line breaks, and the JSON again, so a
 * value under a key that names a secret goes too.
 */
export function inputText(tool: string, input: Record<string, unknown>): { text: string; redactions: number; withheld: boolean } {
  const p = pathOf(tool, input);
  const withheld = !!p && withheldPath(p.path);
  const args = withheld ? { [p.key]: p.path } : Object.fromEntries(Object.entries(input).filter(([k, v]) => !EVENT_FIELDS.has(k) && v !== undefined));
  const count = { n: 0 };
  const whole = redactBounded(JSON.stringify(redactLeaves(args, 0, count)));
  return { text: whole.text, redactions: count.n + whole.redactions, withheld };
}

/** What `next(e)` of a `tool.call` resolves to, as far as a recording reads it. */
export interface CallOutcome {
  deny?: unknown;
  isError?: unknown;
  text?: unknown;
  result?: unknown;
}

interface Item {
  entry: RecordingEntry;
  bytes: number;
}

export interface Applied {
  /** Capture began with this reply. */
  started: boolean;
  /** Capture ended with this reply, and why. */
  ended: 'stopped' | 'limit' | 'consent' | null;
  /** Someone chose this session but the option is off here: the owner is told, once. */
  refused: boolean;
}

export class Recorder {
  /** The session the queue belongs to; batches go to its route. */
  sessionId: string | null = null;
  capturing = false;
  /** Capture ended and the queue has one last send coming. */
  closing = false;
  /** The session this recorder belongs to is over (or cleared): a later reply cannot start capture again. */
  over = false;
  grant: RecordingGrant | null = null;
  /** Values the log line counts; never the text. */
  redactions = 0;
  failures = 0;
  nextAttemptAt = 0;
  lastSentAt = Number.NEGATIVE_INFINITY;
  inFlight = false;
  queuedBytes = 0;
  private loops = new Set<string>();
  private seqs = new Map<string, number>();
  private items: Item[] = [];
  /** The head items a request holds: never dropped, so a retry sends the same entries. */
  private held = 0;
  private lastPrompt = new Map<string, { seq: number; text: string }>();
  private refusedShown = false;

  get queued(): number {
    return this.items.length;
  }

  /** Starts over for a session (a new one, or after /clear). Nothing is carried. */
  begin(sessionId: string): void {
    this.sessionId = sessionId;
    this.capturing = false;
    this.closing = false;
    this.over = false;
    this.grant = null;
    this.loops = new Set();
    this.seqs = new Map();
    this.items = [];
    this.held = 0;
    this.queuedBytes = 0;
    this.lastPrompt = new Map();
    this.refusedShown = false;
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.lastSentAt = Number.NEGATIVE_INFINITY;
    this.inFlight = false;
  }

  /** Takes the server's grant from a reply (or null when it sent none). */
  apply(grant: RecordingGrant | null, optionOn: boolean): Applied {
    this.grant = grant;
    const out: Applied = { started: false, ended: null, refused: false };
    if (this.over) return out;
    if (grant && allowed(grant, optionOn)) {
      this.loops = new Set(grant.loops);
      if (!this.capturing) {
        this.capturing = true;
        this.closing = false;
        out.started = true;
      }
      return out;
    }
    if (this.capturing) {
      this.capturing = false;
      this.closing = true;
      out.ended = grant?.state === 'stopped' ? 'stopped' : grant?.state === 'limit' ? 'limit' : 'consent';
    }
    const chosenButOff = !!grant && grant.consent.chosen && !optionOn;
    out.refused = chosenButOff && !this.refusedShown;
    this.refusedShown = chosenButOff;
    return out;
  }

  /** Whether this loop is being captured now. */
  want(loop: string): boolean {
    return this.capturing && this.loops.has(loop);
  }

  prompt(loop: string, text: string, at: number): void {
    if (!text || !this.want(loop)) return;
    const last = this.lastPrompt.get(loop);
    // The same prompt arrives from agent.spawn and from the agent's first turn.start: one entry.
    if (last && last.text === text && last.seq === this.seqs.get(loop)) return;
    const seq = this.add(loop, 'prompt', text, at);
    this.lastPrompt.set(loop, { seq, text });
  }

  said(loop: string, text: string, at: number): void {
    if (text && this.want(loop)) this.add(loop, 'text', text, at);
  }

  thinking(loop: string, at: number): void {
    if (this.want(loop)) this.add(loop, 'thinking', '', at);
  }

  clear(loop: string, at: number): void {
    if (this.want(loop)) this.add(loop, 'clear', '', at);
  }

  compact(loop: string, at: number): void {
    if (this.want(loop)) this.add(loop, 'compact', '', at);
  }

  /** A tool call and its whole input; the `seq` its result points back to, or null when nothing is captured. */
  call(loop: string, tool: string, input: Record<string, unknown>, at: number): number | null {
    if (!this.want(loop)) return null;
    const t = inputText(tool, input);
    this.redactions += t.redactions;
    return this.add(loop, 'tool', t.text, at, { name: tool }, false);
  }

  /** The call's whole result. A result the mod cannot read as text is left out, and the replay shows the call without one. */
  outcome(loop: string, tool: string, input: Record<string, unknown>, callSeq: number | null, res: CallOutcome | undefined, at: number): void {
    if (callSeq === null || !res || !this.want(loop)) return;
    let text: string | null = null;
    if (typeof res.deny === 'string') text = res.deny;
    else if (typeof res.text === 'string') text = res.text;
    else if (typeof res.result === 'string') text = res.result;
    if (text === null) return;
    const failed = typeof res.deny === 'string' || res.isError === true;
    const extra: Partial<RecordingEntry> = { name: tool, callSeq, ...(failed ? { failed: true } : {}) };
    if (withheldCall(tool, input)) this.add(loop, 'result', WITHHELD, at, extra, false);
    else this.add(loop, 'result', text, at, extra);
  }

  private redact(text: string): string {
    const r = redactBounded(text);
    this.redactions += r.redactions;
    return r.text;
  }

  /** One entry: redacted, cut at the limit (and further if a request could not carry it), numbered and queued. */
  private add(loop: string, kind: RecordingKind, text: string, at: number, extra: Partial<RecordingEntry> = {}, redact = true): number {
    const seq = (this.seqs.get(loop) ?? 0) + 1;
    this.seqs.set(loop, seq);
    let body = redact ? this.redact(text) : text;
    let cut = false;
    if (body.length > RECORDING_LIMITS.text) {
      body = body.slice(0, RECORDING_LIMITS.text);
      cut = true;
    }
    let entry: RecordingEntry = { loop, seq, at, kind, text: cut ? `${body}\n${CUT_MARK}` : body, ...extra, ...(cut ? { cut: true } : {}) };
    let bytes = utf8Bytes(JSON.stringify(entry));
    while (bytes + ENVELOPE_BYTES > RECORDING_BATCH_BYTES && body.length > 1) {
      body = body.slice(0, Math.floor(body.length * 0.7));
      entry = { ...entry, text: `${body}\n${cutMark(body.length)}`, cut: true };
      bytes = utf8Bytes(JSON.stringify(entry));
    }
    this.items.push({ entry, bytes });
    this.queuedBytes += bytes;
    while (this.queuedBytes > RECORDING_QUEUE_BYTES && this.dropOne()) {
      // dropping oldest first until the queue fits
    }
    return seq;
  }

  /**
   * Drops the oldest entry no request holds. The first loss in a loop leaves a `gap` entry in its place (same `seq`, so the order
   * holds); later ones add to that gap. Returns false when nothing can be dropped.
   */
  private dropOne(): boolean {
    const i = this.items.findIndex((it, idx) => idx >= this.held && it.entry.kind !== 'gap');
    if (i < 0) return false;
    const victim = this.items[i]!;
    const loop = victim.entry.loop;
    const gap = this.items.find((it, idx) => idx >= this.held && it.entry.kind === 'gap' && it.entry.loop === loop);
    if (gap) {
      gap.entry = { ...gap.entry, lost: (gap.entry.lost ?? 0) + 1 };
      this.items.splice(i, 1);
      this.queuedBytes -= victim.bytes;
      return true;
    }
    const entry: RecordingEntry = { loop, seq: victim.entry.seq, at: victim.entry.at, kind: 'gap', text: '', lost: 1 };
    const bytes = utf8Bytes(JSON.stringify(entry));
    this.items[i] = { entry, bytes };
    this.queuedBytes += bytes - victim.bytes;
    return true;
  }

  /** Whether a request should go now. */
  due(now: number): boolean {
    if (this.inFlight || this.items.length === 0 || now < this.nextAttemptAt) return false;
    return this.closing || now - this.lastSentAt >= RECORDING_BATCH_INTERVAL_MS;
  }

  /** The oldest entries that fit one request, held until `done`, `drop` or `failed`. Null when nothing waits or a request is out. */
  nextBatch(sentAt: number = Date.now()): { batch: RecordingBatch; count: number } | null {
    if (this.inFlight || this.items.length === 0) return null;
    let count = 0;
    let bytes = ENVELOPE_BYTES;
    for (const it of this.items) {
      if (count >= RECORDING_BATCH_ENTRIES || (count > 0 && bytes + it.bytes + 1 > RECORDING_BATCH_BYTES)) break;
      bytes += it.bytes + 1;
      count++;
    }
    this.held = count;
    this.inFlight = true;
    return { batch: { v: 1, sentAt, entries: this.items.slice(0, count).map((it) => it.entry) }, count };
  }

  private release(count: number): void {
    for (const it of this.items.splice(0, count)) this.queuedBytes -= it.bytes;
    this.held = 0;
    this.inFlight = false;
  }

  /** The server took the request. */
  done(count: number, now: number): void {
    this.release(count);
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.lastSentAt = now;
  }

  /** The server will never take this request (it is malformed or too large): it goes, and the next waits a little. */
  drop(count: number, now: number): void {
    this.release(count);
    this.nextAttemptAt = now + BACKOFF_MS[0];
    this.lastSentAt = now;
  }

  /** The request did not get through: the same entries stay for a retry after the backoff. */
  failed(now: number): void {
    this.held = 0;
    this.inFlight = false;
    this.failures++;
    this.nextAttemptAt = now + BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length) - 1]!;
  }

  /** The session is ending: capture stops, what is queued gets one last send, and no reply starts it again. */
  close(): void {
    this.capturing = false;
    this.closing = true;
    this.over = true;
  }

  /** The one last send after capture ended is over: the queue goes. */
  finish(): void {
    this.closing = false;
    this.items = [];
    this.queuedBytes = 0;
    this.held = 0;
    this.inFlight = false;
  }

  /** Capture ends at once and the queue goes (the session ended, or the server refused the recording). */
  stop(): void {
    this.capturing = false;
    this.finish();
  }
}

// ---- the owner's terminal (SPEC 5.3) -------------------------------------------------------------

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function dayOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A moment in local time: `11:42` today, `11:42 on 2026-10-21` on another day. */
export function clockOn(at: number, now: number): string {
  return sameDay(at, now) ? clockTime(at) : `${clockTime(at)} on ${dayOf(at)}`;
}

/** A time something is kept until or deleted at: `17:42 today`, or the day when it is not today. */
export function timeWithDay(at: number, now: number): string {
  return sameDay(at, now) ? `${clockTime(at)} today` : `${clockTime(at)} on ${dayOf(at)}`;
}

/** Recording starts (and again after /clear and a compaction). */
export function startLine(g: RecordingGrant, now: number): string {
  const by = g.startedBy ?? 'Podium';
  const from = g.startedAt === null || g.startedAt === undefined ? 'now' : clockOn(g.startedAt, now);
  const until = g.keptUntil === null || g.keptUntil === undefined ? 'when its retention runs out' : `at ${timeWithDay(g.keptUntil, now)}`;
  return `This session is being recorded by ${by}, from ${from}. The whole history of this orchestrator and every agent and fork under it is kept in Podium for troubleshooting, and is deleted ${until}. Either of you can stop it from Podium. To refuse recording on this machine, set sessionRecording to off in /plugin configure.`;
}

/** Someone stopped the recording. */
export function stoppedLine(g: RecordingGrant, now: number): string {
  const by = g.stoppedBy ?? 'Podium';
  const when = g.stoppedAt === null || g.stoppedAt === undefined ? 'an unknown time' : clockOn(g.stoppedAt, now);
  const until = g.keptUntil === null || g.keptUntil === undefined ? 'its retention runs out' : timeWithDay(g.keptUntil, now);
  return `Recording stopped by ${by} at ${when}. What was recorded until then is kept until ${until}.`;
}

/** The session's size limit or the server's disk budget stopped it. */
export function limitLine(g: RecordingGrant): string {
  const what = g.limit === 'budget' ? "the server's disk budget" : `its ${Math.round(g.bytes / 1_048_576)} MB limit`;
  return `Recording stopped: this session reached ${what}. Nothing after this point is kept.`;
}

/** Someone chose to record this session and the option is off here. */
export function refusedLine(g: RecordingGrant): string {
  return `${g.startedBy ?? 'Someone'} chose to record this session, but sessionRecording is off here, so nothing is recorded.`;
}
