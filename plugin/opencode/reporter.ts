// The OpenCode reporter's runtime (#855): one Reporter per location, many root sessions in it. `handle` folds an event
// and returns at once; only `tick` and `close` talk to the server, so the event loop never waits on the network. Each
// root has its own Transport (queue, backoff, acks), which keeps a slow server from stalling the other roots.
import { readGit, type Runner } from '../core/git.ts';
import type { MachineInfo } from '../core/protocol.ts';
import { Responder } from '../core/respond.ts';
import { Transport, type FetchLike } from '../core/transport.ts';
import { Answering, type Consent, type Host } from './answering.ts';
import { buildReport, type ReportMeta } from './report.ts';
import { apply, finish, newStore, sweep, type BusEvent, type Root, type Store } from './state.ts';

export interface ReporterOptions {
  serverUrl: string;
  token: string;
  userName: string | null;
  machine: MachineInfo | null;
  /** How long a root is quiet before it reports `done`. At or below the location's idle timeout. */
  idleMs: number;
  heartbeatMs: number;
  version: string;
  build?: string | null;
  engineVersion: string | null;
  hostSurface: string | null;
}

export interface ReporterDeps {
  fetch: FetchLike;
  now: () => number;
  /** A runner for git commands that works in `cwd` (the session's directory), not in the plugin's. */
  runIn: (cwd: string) => Runner;
  log: (line: string) => void;
  /** What answering may do in OpenCode, and what the person allowed. Absent: the reporter only watches. */
  answering?: { host: Host; consent: Consent; sleep?: (ms: number) => Promise<boolean>; answerMs?: number };
}

/** Resolves with `p`, or rejects after `ms`; the timer is cleared either way so nothing is left running. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

export const DEFAULTS = { answerMs: 10_000, idleMs: 60_000, flushMs: 1000, heartbeatMs: 5000, gitEveryMs: 10_000, keepDoneMs: 6 * 3_600_000, closeMs: 1500 } as const;

export class Reporter {
  readonly store: Store = newStore();
  readonly transports = new Map<string, Transport>();
  private readonly gitAt = new Map<string, number>();
  /** Branch reads in flight: a final flush waits for them (within its time limit) so a short-lived run still reports its branch. */
  private readonly gitPending = new Set<Promise<void>>();
  private closed = false;
  /** Ids of the latest events folded: a reload can leave two subscriptions open on one reporter, and each would fold every event. */
  private readonly seen = new Set<string>();
  /** The OpenCode version, read from the first `session.created` (it carries `version`). */
  private engineVersion: string | null = null;
  /** Answering from Podium (#858); null when the person has not allowed it or the host cannot do it. */
  private readonly answering: Answering | null;
  private readonly responder: Responder | null;

  constructor(
    private readonly deps: ReporterDeps,
    readonly opts: ReporterOptions,
  ) {
    const a = deps.answering;
    this.responder = a ? new Responder(deps.fetch, { serverUrl: opts.serverUrl, token: opts.token }, { now: deps.now, sleep: a.sleep ?? ((ms) => new Promise<boolean>((r) => setTimeout(() => r(true), ms))) }) : null;
    this.answering = a && this.responder ? new Answering(this.responder, a.host, a.consent) : null;
  }

  /** Folds one bus event into the store. Synchronous: nothing here waits for the network. */
  handle(ev: BusEvent): void {
    if (this.closed) return;
    if (ev.id) {
      if (this.seen.has(ev.id)) return;
      this.seen.add(ev.id);
      if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value as string);
    }
    const v = ev.type === 'session.created' ? ev.data?.version : null;
    if (typeof v === 'string' && v) this.engineVersion = v;
    const root = apply(this.store, ev, this.deps.now());
    if (root) {
      this.queue(root);
      if (!root.done) this.refreshGit(root, this.deps.now());
    }
  }

  /** The sessions this reporter knows, which `ctx.permission.list` is asked about on a reload (it lists one session's requests). */
  sessionIds(): string[] {
    return [...this.store.rootOf.keys()];
  }

  /** Permissions that were open when the plugin reloaded (`ctx.permission.list`): the bus will not announce them again. */
  recover(items: readonly unknown[]): void {
    for (const p of items as { id?: string; sessionID?: string; action?: string; resources?: string[] }[]) {
      if (p?.id && p.sessionID) this.handle({ type: 'permission.asked', recovered: true, data: { id: p.id, sessionID: p.sessionID, action: p.action, resources: p.resources } });
    }
  }

  private transportOf(root: Root): Transport {
    let t = this.transports.get(root.id);
    if (!t) {
      t = new Transport(this.deps.fetch, { serverUrl: this.opts.serverUrl, token: this.opts.token, heartbeatMs: this.opts.heartbeatMs, version: this.opts.version, build: this.opts.build }, this.deps.log);
      this.transports.set(root.id, t);
    }
    return t;
  }

  /** Moves the root's new events into its transport's queue. */
  private queue(root: Root): void {
    if (!root.events.length) return;
    this.transportOf(root).enqueue(root.events);
    root.events = [];
  }

  private meta(now: number): ReportMeta {
    const o = this.opts;
    return { now, version: o.version, engineVersion: this.engineVersion ?? o.engineVersion, hostSurface: o.hostSurface, build: o.build, userName: o.userName, machine: o.machine };
  }

  /** What a report says about answering: what the session takes, and the asks open now while the server takes answers. */
  private respondFor(root: Root, t: Transport): ReportMeta['respond'] {
    const info = this.answering?.info();
    return info ? { info, asks: this.answering!.asks(root, t) } : null;
  }

  private send(root: Root, t: Transport, now: number): Promise<void> {
    root.dirty = false;
    return t.send((events) => buildReport(root, events, { ...this.meta(now), respond: this.respondFor(root, t) }), now).then((outcome) => {
      // A report that did not get through must go again.
      if (outcome === 'failed' || outcome === 'refused' || outcome === 'rejected') root.dirty = true;
    });
  }

  /** Reads the root's branch in the background when it is stale. Never throws, and never holds up a report. */
  private refreshGit(root: Root, now: number): void {
    if (!root.cwd || now - (this.gitAt.get(root.id) ?? -Infinity) < DEFAULTS.gitEveryMs) return;
    this.gitAt.set(root.id, now);
    const cwd = root.cwd;
    const read: Promise<void> = readGit(this.deps.runIn(cwd), cwd).then(
      (g) => {
        if (JSON.stringify(g) !== JSON.stringify(root.git)) {
          root.git = g;
          root.dirty = true;
        }
      },
      () => undefined,
    );
    this.gitPending.add(read);
    void read.finally(() => this.gitPending.delete(read));
  }

  /**
   * One pass of the flush timer: finish quiet roots, then send what is due. Resolves when this pass's sends have
   * settled, which only the timer's caller waits on, never `handle`.
   */
  async tick(): Promise<void> {
    if (this.closed) return;
    const now = this.deps.now();
    sweep(this.store, now, this.opts.idleMs);
    const sends: Promise<void>[] = [];
    for (const root of [...this.store.roots.values()]) {
      this.queue(root);
      if (!root.done) this.refreshGit(root, now);
      const t = this.transportOf(root);
      if (root.done && !root.dirty && t.queue.length === 0) {
        this.forget(root, now);
        continue;
      }
      if (t.due(now, root.dirty)) sends.push(this.send(root, t, now));
    }
    await Promise.all(sends);
    // After the reports, so each root's reply has been read: start waiting for answers and act on what was handed over.
    // Bounded: a call into OpenCode that never returns must not hold up the next report or the other roots.
    if (this.answering) await Promise.all([...this.store.roots.values()].map((root) => withTimeout(this.answering!.drive(root, this.transportOf(root)), this.deps.answering?.answerMs ?? DEFAULTS.answerMs).catch(() => undefined)));
  }

  /** Drops a done root that has stayed quiet for a long while, so a busy server process does not grow without end. */
  private forget(root: Root, now: number): void {
    if (now - root.lastAt < DEFAULTS.keepDoneMs) return;
    for (const id of root.sessions.keys()) this.store.rootOf.delete(id);
    this.store.roots.delete(root.id);
    this.transports.delete(root.id);
    this.gitAt.delete(root.id);
  }

  /** The plugin is cleaning up: end every open root and send one last report each, waiting no longer than `closeMs` in all. */
  async close(closeMs: number = DEFAULTS.closeMs): Promise<void> {
    if (this.closed) return;
    const now = this.deps.now();
    for (const root of this.store.roots.values()) finish(root, now, 'shutdown');
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, closeMs);
    });
    const flush = async (): Promise<void> => {
      await Promise.all([...this.gitPending]);
      const sends: Promise<void>[] = [];
      for (const root of this.store.roots.values()) {
        this.queue(root);
        const t = this.transportOf(root);
        if (root.dirty && now >= t.nextAttemptAt) sends.push(this.send(root, t, now));
      }
      await Promise.all(sends);
    };
    try {
      await Promise.race([flush(), limit]);
    } finally {
      clearTimeout(timer);
    }
  }
}
