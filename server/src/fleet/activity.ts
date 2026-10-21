// The agent activity feed (#118), the live window: held in memory only. Nothing in this file is written to a database.
//
// A viewer watching an agent's panel takes a lease by fetching GET /sessions/:id/agents/:agentId/activity, and
// renews it with every fetch. The reply to each mod report lists the loops under a live lease (`watch`); the mod
// captures and sends a loop's entries only while it is listed. This store keeps the last 20 entries of a watched
// loop and drops them when the lease lapses, when the session leaves the live set or is deleted, and on restart.
// Entries from before the lease began are never kept here, so a viewer who comes back starts empty.
//
// Under a keep policy (#432) the Admin also has the server store the feed durably, in activityHistory.ts. That store
// needs no lease: `watched()` then also lists the loops the history asks for, for a session whose reporter has the
// option on, and the history takes every entry a report carries. This live window behaves as above either way.
//
// A Bash entry may carry the call's `id`, its whole `command` and, once the call finished, its `output` with an exit status
// (#431). The command is held like the rest of the entry (and the history stores it). Output is held here and nowhere else, on
// the lease: it is taken only while the Admin's `activity-output` flag and the session's `activityOutput` option are on, goes
// with the lease, the session and a flag turned off, and is never written to a database or logged. `watchedOutput()` is the
// reply's `watchOutput`: the loops under a live lease, never a loop the history lists with no viewer.
//
// The Admin can turn the whole feature off (Admin > Settings > Feature flags, `activity-feed`). While it is off no lease
// is granted, nothing is listed as watched and nothing a mod sends is kept; the fleet calls `clear()` when it goes off.
import { LIMITS, MAIN_LOOP, type ActivityEntry, type Report } from './protocol.js';
import type { ActivityHistoryNote } from './activityHistoryTypes.js';

/** The refresh intervals the panel offers, in seconds. The first is the default. */
export const ACTIVITY_EVERY_SECONDS = [5, 10, 20, 30, 60] as const;
/**
 * How long a lease outlives the viewer's interval: one missed or slow fetch, and a report cycle or two, before the
 * server lets go. A lease taken with `every=5` lapses 20 s after the last fetch; with `every=60`, 75 s after it.
 */
export const ACTIVITY_LEASE_SLACK_MS = 15_000;

/**
 * A stored entry, numbered in the order the server took it, so a viewer can tell what is new. `podium` is an answer,
 * message or command sent from Podium (#206): the server adds it, with who sent it and an optional note.
 */
export interface ActivityEntryView {
  seq: number;
  at: number;
  kind: ActivityEntry['kind'] | 'podium';
  text: string;
  by?: string;
  note?: string | null;
  /** The tool call's id, command and output with its status (#431); see ActivityEntry in protocol.ts. `output` is never stored. */
  id?: string;
  command?: string;
  commandCut?: boolean;
  output?: string;
  outputCut?: boolean;
  done?: boolean;
  exitCode?: number;
  failed?: boolean;
}

/** The fields of an entry that hold a call's output and how it ended: held on the lease only. */
const OUTPUT_KEYS = ['output', 'outputCut', 'done', 'exitCode', 'failed'] as const;

/** An entry as the lease holds it: a Podium entry also keeps the delivery it is about, to update it later. */
interface HeldEntry extends ActivityEntryView {
  ref?: string;
}

/**
 * What the activity route answers. `since` is when the current lease began; null when the session is not live or the
 * feature is off. `enabled` is false while the Admin has the feature turned off.
 */
export interface ActivityReply {
  entries: ActivityEntryView[];
  since: number | null;
  live: boolean;
  enabled: boolean;
  serverTime: number;
  /** Counts about this loop's stored history (#432). Absent under the default policy, so the reply is as it always was. */
  history?: ActivityHistoryNote;
}

interface Lease {
  since: number;
  until: number;
  seq: number;
  entries: HeldEntry[];
}

/** The interval a request asked for, in seconds: one of ACTIVITY_EVERY_SECONDS, 5 for anything else. */
export function everyOf(v: unknown): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Number.NaN;
  return (ACTIVITY_EVERY_SECONDS as readonly number[]).includes(n) ? n : ACTIVITY_EVERY_SECONDS[0];
}

export class ActivityStore {
  /** Session id -> loop key (an agent id, or MAIN_LOOP) -> lease. */
  private readonly leases = new Map<string, Map<string, Lease>>();
  /** Session id -> whether its reporter has the activityFeed option on, from the last report that said. */
  private readonly feed = new Map<string, boolean>();
  /** Session id -> whether its reporter has the activityOutput option on, from the last report that said (#431). */
  private readonly outputOpt = new Map<string, boolean>();

  constructor(
    private readonly now: () => number,
    /** Whether the Admin has the feature on (the `activity-feed` flag). */
    private readonly isOn: () => boolean = () => true,
    /**
     * Loops the Activity history wants captured for a session (#432): empty under the default policy. Listed in `watched()`
     * only for a session whose reporter has the `activityFeed` option on.
     */
    private readonly historyLoops: (sessionId: string) => string[] = () => [],
    /** Whether the Admin has `activity-output` on (#431). Off, no output is taken, held or served. */
    private readonly outputFlag: () => boolean = () => false,
  ) {}

  /** Whether output may be taken and served now: the Admin's `activity-feed` and `activity-output` flags are both on. */
  private get outputOn(): boolean {
    return this.isOn() && this.outputFlag();
  }

  /** Whether the feature is on for this server. The route grants no lease while it is off. */
  get on(): boolean {
    return this.isOn();
  }

  /** Live leases across every session, for tests and the health of the store. */
  get size(): number {
    let n = 0;
    for (const loops of this.leases.values()) n += loops.size;
    return n;
  }

  /** Takes or renews a viewer's lease on one loop and returns what it holds. */
  watch(sessionId: string, loop: string, everySeconds: number): { entries: ActivityEntryView[]; since: number } {
    const now = this.now();
    this.expireSession(sessionId, now);
    let loops = this.leases.get(sessionId);
    if (!loops) {
      loops = new Map();
      this.leases.set(sessionId, loops);
    }
    let lease = loops.get(loop);
    if (!lease) {
      lease = { since: now, until: now, seq: 0, entries: [] };
      loops.set(loop, lease);
    }
    lease.until = Math.max(lease.until, now + everySeconds * 1000 + ACTIVITY_LEASE_SLACK_MS);
    // Output is served only while the flag is on, whatever the lease still holds.
    const showOutput = this.outputOn;
    return { entries: lease.entries.map(({ ref: _ref, ...e }) => (showOutput ? e : withoutOutput(e))), since: lease.since };
  }

  /** The loops of a session someone is watching: the report reply's `watch`. */
  watched(sessionId: string): string[] {
    if (!this.isOn()) return [];
    this.expireSession(sessionId, this.now());
    const loops = [...(this.leases.get(sessionId)?.keys() ?? [])];
    if (this.feed.get(sessionId) !== true) return loops;
    for (const loop of this.historyLoops(sessionId)) if (!loops.includes(loop)) loops.push(loop);
    return loops;
  }

  /**
   * The loops of `watched()` that a viewer has open right now (a live lease): the report reply's `watchOutput` (#431). A loop
   * listed only because the Activity history keeps it is not here. Empty while either flag is off.
   */
  watchedOutput(sessionId: string): string[] {
    if (!this.outputOn) return [];
    this.expireSession(sessionId, this.now());
    return [...(this.leases.get(sessionId)?.keys() ?? [])];
  }

  /** Whether the session's reporter has the option on; null when no report has said (an older reporter, or since a restart). */
  feedOn(sessionId: string): boolean | null {
    return this.feed.get(sessionId) ?? null;
  }

  /** Whether the session's reporter has the `activityOutput` option on (#431); null when no report has said. */
  outputOptionOn(sessionId: string): boolean | null {
    return this.outputOpt.get(sessionId) ?? null;
  }

  /**
   * Takes the entries of a validated report for the loops under a live lease; the rest are ignored. `skewMs` is the
   * report's `sentAt` minus the server's time, so an entry's time can be compared with when the lease began.
   */
  ingest(report: Report, skewMs: number): void {
    const sid = report.session.id;
    if (typeof report.session.activityFeed === 'boolean') this.feed.set(sid, report.session.activityFeed);
    if (typeof report.session.activityOutput === 'boolean') {
      this.outputOpt.set(sid, report.session.activityOutput);
      if (!report.session.activityOutput) this.dropSessionOutput(sid);
    }
    if (!this.isOn()) return;
    const keepOutput = this.outputOn && report.session.activityOutput === true;
    const loops = this.leases.get(sid);
    if (!loops) return;
    this.expireSession(sid, this.now());
    const take = (loop: string, list: ActivityEntry[] | undefined) => {
      const lease = loops.get(loop);
      if (lease && list?.length) this.merge(lease, list, skewMs, keepOutput);
    };
    take(MAIN_LOOP, report.session.activity);
    for (const a of report.agents) take(a.id, a.activity);
  }

  /**
   * An answer, message or command sent from Podium (#206), as an entry of the loop it is about, so the modal's feed shows
   * it. Kept only while someone watches that loop, like every entry.
   */
  addPodium(sessionId: string, loop: string, ref: string, e: { at: number; text: string; by: string; note: string | null }): void {
    if (!this.isOn()) return;
    const lease = this.leases.get(sessionId)?.get(loop);
    if (!lease) return;
    lease.entries.push({ seq: ++lease.seq, at: e.at, kind: 'podium', text: e.text.slice(0, LIMITS.activityText), by: e.by, note: e.note, ref });
    if (lease.entries.length > LIMITS.activityEntries) lease.entries.splice(0, lease.entries.length - LIMITS.activityEntries);
  }

  /** A Podium entry's note changed (queued, then taken). */
  updatePodium(sessionId: string, ref: string, note: string | null): void {
    for (const lease of this.leases.get(sessionId)?.values() ?? []) for (const e of lease.entries) if (e.ref === ref) e.note = note;
  }

  /** A Podium entry for something the session never took (discarded, refused, or the ask closed first). */
  removePodium(sessionId: string, ref: string): void {
    for (const lease of this.leases.get(sessionId)?.values() ?? []) {
      const i = lease.entries.findIndex((e) => e.ref === ref);
      if (i >= 0) lease.entries.splice(i, 1);
    }
  }

  /** Adds what is new in a reporter's snapshot (its last 20, oldest first) and keeps the last 20. */
  private merge(lease: Lease, list: ActivityEntry[], skewMs: number, keepOutput: boolean): void {
    for (const e of list) {
      // A call already held gets what arrived since (its output, status, a command first sent without): it is the same entry, so
      // it keeps its place and number, and the repeat is not read as a new one. A call from before the lease began is not held.
      const held = e.id === undefined ? undefined : lease.entries.find((x) => x.kind === e.kind && x.id === e.id);
      if (held) {
        Object.assign(held, held.command === undefined ? commandOf(e) : {}, keepOutput ? outputOf(e) : {});
        continue;
      }
      if (e.at - skewMs < lease.since) continue;
      // Compared with the reporter's own entries only: a Podium entry carries the server's time, not the reporter's.
      const own = lease.entries.filter((x) => x.kind !== 'podium');
      const last = own[own.length - 1];
      if (last && e.at < last.at) continue;
      if (last && e.at === last.at && lease.entries.some((x) => x.kind !== 'podium' && x.at === e.at && x.kind === e.kind && x.text === e.text)) continue;
      lease.entries.push({ seq: ++lease.seq, at: e.at, kind: e.kind, text: e.text, ...(e.id === undefined ? {} : { id: e.id }), ...commandOf(e), ...(keepOutput ? outputOf(e) : {}) });
    }
    if (lease.entries.length > LIMITS.activityEntries) lease.entries.splice(0, lease.entries.length - LIMITS.activityEntries);
  }

  /** Drops every lease that has lapsed. The sweeper calls it once a second. */
  expire(): void {
    const now = this.now();
    for (const sid of [...this.leases.keys()]) this.expireSession(sid, now);
  }

  /** The Admin turned `activity-output` off: every held output goes, in every session. The leases and commands stay. */
  dropOutput(): void {
    for (const loops of this.leases.values()) for (const lease of loops.values()) lease.entries = lease.entries.map(withoutOutput);
  }

  private dropSessionOutput(sessionId: string): void {
    for (const lease of this.leases.get(sessionId)?.values() ?? []) lease.entries = lease.entries.map(withoutOutput);
  }

  /** The Admin turned the feature off: every lease and every entry goes, in every session. */
  clear(): void {
    this.leases.clear();
  }

  /** The session left the live set or was deleted: its leases and entries go, and what it said about the option. */
  dropSession(sessionId: string): void {
    this.leases.delete(sessionId);
    this.feed.delete(sessionId);
    this.outputOpt.delete(sessionId);
  }

  private expireSession(sessionId: string, now: number): void {
    const loops = this.leases.get(sessionId);
    if (!loops) return;
    for (const [loop, lease] of loops) if (now > lease.until) loops.delete(loop);
    if (!loops.size) this.leases.delete(sessionId);
  }
}

/** A tool entry's command and its cut flag, within the protocol's limit. Nothing on any other kind of entry. */
function commandOf(e: ActivityEntry): Pick<ActivityEntryView, 'command' | 'commandCut'> {
  if (e.kind !== 'tool' || typeof e.command !== 'string') return {};
  return { command: e.command.slice(0, LIMITS.activityDetail), ...(e.commandCut === true ? { commandCut: true } : {}) };
}

/** A tool entry's output and how the call ended, within the protocol's limit. */
function outputOf(e: ActivityEntry): Partial<ActivityEntryView> {
  if (e.kind !== 'tool') return {};
  const out: Partial<ActivityEntryView> = {};
  if (typeof e.output === 'string') out.output = e.output.slice(0, LIMITS.activityDetail);
  if (e.outputCut === true) out.outputCut = true;
  if (e.done === true) out.done = true;
  if (typeof e.exitCode === 'number') out.exitCode = e.exitCode;
  if (e.failed === true) out.failed = true;
  return out;
}

function withoutOutput<T extends HeldEntry>(e: T): T {
  const out = { ...e };
  for (const k of OUTPUT_KEYS) delete out[k];
  return out;
}
