// The OpenCode reporter's runtime (#855): one Reporter per location, many root sessions in it. `handle` folds an event
// and returns at once; only `tick` and `close` talk to the server, so the event loop never waits on the network. Each
// root has its own Transport (queue, backoff, acks), which keeps a slow server from stalling the other roots.
import { excerpt, explainPrompt } from '../core/failures.ts';
import { readChanges, readGit, type Runner } from '../core/git.ts';
import { readFileDiff } from '../core/fileDiff.ts';
import type { DiffRequest, MachineInfo, RecordingGrant } from '../core/protocol.ts';
import { Responder, sessionPath } from '../core/respond.ts';
import { isRecordingGrant, Transport, type FetchLike } from '../core/transport.ts';
import { setTitle } from '../core/plan.ts';
import { Peers } from './peers.ts';
import { Answering, type Consent, type Host } from './answering.ts';
import { buildReport, type ReportMeta } from './report.ts';
import { limitLine, refusedLine, startLine, stoppedLine } from './recordingLines.ts';
import { apply, finish, newStore, setWatched, setWatchedOutput, sweep, type BusEvent, type Root, type Store } from './state.ts';

export interface ReporterOptions {
  serverUrl: string;
  token: string;
  userName: string | null;
  machine: MachineInfo | null;
  /** How long a root is quiet before it reports `done`. At or below the location's idle timeout. */
  idleMs: number;
  heartbeatMs: number;
  /** The `sessionName` option, used when OpenCode has not named the session. */
  sessionName?: string | null;
  version: string;
  build?: string | null;
  engineVersion: string | null;
  hostSurface: string | null;
  /** The file diff consent (`PODIUM_FILE_DIFF`): answer requests for one file's diff. Off when absent. */
  fileDiff?: boolean;
  /** The `fileDiffPreload` option, on unless turned off. Only meaningful with `fileDiff`. */
  fileDiffPreload?: boolean;
  /** The activity feed consent (`PODIUM_ACTIVITY_FEED`): keep and send the feed of each loop the server says is watched. Off when absent. */
  activityFeed?: boolean;
  /** The activity output consent (`PODIUM_ACTIVITY_OUTPUT`): a shell call's output may go out, for a loop a viewer has open. Needs `activityFeed`. */
  activityOutput?: boolean;
  /** The full prompts consent (`PODIUM_FULL_PROMPTS`): send each agent's whole prompt and answer, once. */
  fullPrompts?: boolean;
  /** The explain failures consent (`PODIUM_EXPLAIN_FAILURES`): a small model is asked to explain each new failure, from its redacted record only. Off when absent. */
  explainFailures?: boolean;
  /** The peers consent (`PODIUM_PEERS`): this orchestrator may message the person's other orchestrators. Off when absent. */
  peers?: boolean;
  /** The session recording consent (`PODIUM_SESSION_RECORDING`): the owner's yes to being recorded when the Admin and the session's chooser have said yes too. */
  sessionRecording?: boolean;
}

export interface ReporterDeps {
  fetch: FetchLike;
  now: () => number;
  /** A runner for git commands that works in `cwd` (the session's directory), not in the plugin's. */
  runIn: (cwd: string) => Runner;
  log: (line: string) => void;
  /** Tells the person something once, in a place they see: what a recording of their session is doing (#353). Absent: nothing is shown. */
  notify?: (line: string) => void;
  /** What is wrong with the secure connection right now, or null (#948). Its status word leads `statusText`. */
  problem?: () => { status: string } | null;
  /** What answering may do in OpenCode, and what the person allowed. Absent: the reporter only watches. */
  /**
   * The context window of a model, or null when OpenCode does not say. Asked in the background the first time a model is seen; a report
   * carries the window once the answer is in. Never awaited by `handle`.
   */
  windowOf?: (provider: string, model: string) => Promise<number | null>;
  /**
   * Asks a model for a short text from a prompt (`ctx.experimental.generate.text`), or null when it says nothing. Absent where the host cannot generate.
   * Used only with the explain failures consent on, and only from the timer.
   */
  explain?: (prompt: string) => Promise<string | null>;
  /** How long one explanation may take. */
  explainMs?: number;
  /** How long a messaging tool waits for Podium. */
  peerCallMs?: number;
  /**
   * Submits text as a prompt in a session, queued behind the turn that runs (`ctx.session.prompt`): how a message from another orchestrator enters.
   * Absent: this reporter takes no part in messaging, whatever the person allowed.
   */
  prompt?: (sessionId: string, id: string, text: string) => Promise<void>;
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

/** Explanations being asked for at once: a run of failures never makes a burst of model calls. */
const EXPLAIN_AT_ONCE = 2;

/** How long a model whose window could not be read waits before it is asked about again. */
const WINDOW_RETRY_MS = 60_000;

/** Batches one last recording send may take: a backlog after an outage, bounded so the end of a session is not held. */
const FINAL_BATCHES = 20;

/** How many answered diff request ids are remembered. */
const DIFFS_KEPT = 200;

/** What `/podium` shows: the counts and notices of every root's transport, added up. */
export interface Summary {
  /** false when any root cannot reach the server, true when one can, null before any report. */
  online: boolean | null;
  liveSessions: number | null;
  serverVersion: string | null;
  sent: number;
  failed: number;
  rejected: number;
  queued: number;
  dropped: number;
  lastError: string | null;
  /** The distinct notices (refused, belongs to someone else, server too old, version mismatch, update available). */
  notices: string[];
  sessions: number;
}

export const DEFAULTS = { explainMs: 30_000, answerMs: 10_000, idleMs: 60_000, flushMs: 1000, heartbeatMs: 5000, gitEveryMs: 10_000, keepDoneMs: 6 * 3_600_000, closeMs: 1500 } as const;

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
  private readonly responder: Responder;
  /** Orchestrator messaging (#347); null unless the person allowed it (`PODIUM_PEERS`) and the host can submit a prompt. */
  private readonly peers: Peers | null;
  /** The window per `provider\0model`; `at` is when a missing one was last asked for. */
  private readonly windows = new Map<string, { window: number | null; at: number }>();
  private readonly windowPending = new Set<string>();
  /** Diff requests already taken, so one listed in two replies is read once (#319). */
  private readonly diffsDone: string[] = [];
  private explaining = 0;
  /** File diffs being read: a final flush waits for them, within its time limit. */
  private readonly diffPending = new Set<Promise<void>>();

  constructor(
    private readonly deps: ReporterDeps,
    readonly opts: ReporterOptions,
  ) {
    const a = deps.answering;
    // Also the way a file diff goes back to the server, so it exists with answering off.
    this.responder = new Responder(deps.fetch, { serverUrl: opts.serverUrl, token: opts.token }, { now: deps.now, sleep: a?.sleep ?? ((ms) => new Promise<boolean>((r) => setTimeout(() => r(true), ms))) });
    this.answering = a ? new Answering(this.responder, a.host, a.consent, deps.now) : null;
    this.peers = opts.peers && deps.prompt ? new Peers({ responder: this.responder, prompt: deps.prompt, notify: deps.notify, now: deps.now, owner: () => opts.userName, machine: () => opts.machine?.name ?? null, callMs: deps.peerCallMs }) : null;
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
    if (ev.type === 'session.step.started') this.wantWindow(ev.data?.model?.providerID, ev.data?.model?.id);
    if (root) {
      this.queue(root);
      if (!root.done) this.refreshGit(root, this.deps.now());
    }
  }

  /** Asks for a model's window in the background when it is not known; never throws and never holds up `handle`. */
  private wantWindow(provider: unknown, model: unknown): void {
    const lookup = this.deps.windowOf;
    if (!lookup || typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) return;
    const key = `${provider}\u0000${model}`;
    const now = this.deps.now();
    const known = this.windows.get(key);
    if (this.windowPending.has(key) || (known && (known.window !== null || now - known.at < WINDOW_RETRY_MS))) return;
    this.windowPending.add(key);
    void lookup(provider, model)
      .catch(() => null)
      .then((window) => {
        this.windowPending.delete(key);
        this.windows.set(key, { window, at: now });
        if (window !== null) for (const r of this.store.roots.values()) r.dirty = true;
      });
  }

  /** The line a status view may show: the connection's state, led by what is wrong with the secure connection when something is (#948). Null before any report. */
  statusText(): string | null {
    const t = this.transports.values().next().value as Transport | undefined;
    return t ? t.statusText(this.deps.problem?.()?.status) : null;
  }

  /** The connection's counts and notices for `/podium`, added up over the roots. */
  summary(): Summary {
    const ts = [...this.transports.values()];
    const notices = new Set<string>();
    for (const t of ts) for (const n of [t.refusalNotice(), t.rejectNotice(), t.ownerNotice(), t.versionNotice(), t.updateNotice()]) if (n) notices.add(n);
    const sum = (f: (t: Transport) => number): number => ts.reduce((a, t) => a + f(t), 0);
    return {
      online: ts.some((t) => t.online === false) ? false : ts.some((t) => t.online === true) ? true : null,
      liveSessions: ts.find((t) => t.liveSessions !== null)?.liveSessions ?? null,
      serverVersion: ts.find((t) => t.serverVersion)?.serverVersion ?? null,
      sent: sum((t) => t.sent),
      failed: sum((t) => t.failed),
      rejected: sum((t) => t.rejected),
      queued: sum((t) => t.queue.length),
      dropped: sum((t) => t.dropped),
      lastError: ts.find((t) => t.lastError)?.lastError ?? null,
      notices: [...notices],
      sessions: this.store.roots.size,
    };
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
    return { now, version: o.version, engineVersion: this.engineVersion ?? o.engineVersion, hostSurface: o.hostSurface, build: o.build, userName: o.userName, optionName: o.sessionName, machine: o.machine, fileDiff: o.fileDiff === true, fileDiffPreload: o.fileDiffPreload, activity: o.activityFeed === true, activityOutput: o.activityFeed === true && o.activityOutput === true, fullText: o.fullPrompts === true, sessionRecording: o.sessionRecording === true, peers: o.peers === true && !!this.peers, windowOf: (p, m) => (p && m ? (this.windows.get(`${p}\u0000${m}`)?.window ?? null) : null) };
  }

  /** What a report says about answering: what the session takes, and the asks open now while the server takes answers. */
  private respondFor(root: Root, t: Transport): ReportMeta['respond'] {
    const info = this.answering?.info();
    return info ? { info, asks: this.answering!.asks(root, t) } : null;
  }

  private send(root: Root, t: Transport, now: number): Promise<void> {
    root.dirty = false;
    // The full texts this report carries, by agent, so only those are marked sent when it is accepted.
    let texts: Record<string, { promptText?: string; answerText?: string }> = {};
    const build = (events: Parameters<Parameters<Transport['send']>[0]>[0]) => {
      const report = buildReport(root, events, { ...this.meta(now), respond: this.respondFor(root, t) });
      texts = Object.fromEntries(report.agents.map((a) => [a.id, { promptText: a.promptText, answerText: a.answerText }]));
      return report;
    };
    return t.send(build, now).then((outcome) => {
      // A report that did not get through must go again.
      if (outcome === 'failed' || outcome === 'refused' || outcome === 'rejected') root.dirty = true;
      if (outcome === 'ok') this.accepted(root, t, texts);
    });
  }

  /** What a report the server took changes: the texts that went out are not sent again, and its reply names the loops watched and the recording's grant. */
  private accepted(root: Root, t: Transport, texts: Record<string, { promptText?: string; answerText?: string }>): void {
    const o = this.opts;
    for (const [id, sent] of Object.entries(texts)) {
      const s = root.sessions.get(id);
      if (!s) continue;
      // Only a text that is still the one the report carried: a newer one goes out next time.
      if (sent.promptText && sent.promptText === s.promptText) s.promptSent = true;
      if (sent.answerText && sent.answerText === s.answerText) s.answerSent = true;
    }
    // With the option off nothing is ever watched (#118). A loop is given output only while it is also watched.
    setWatched(root, o.activityFeed ? t.watch : []);
    setWatchedOutput(root, o.activityFeed && o.activityOutput ? t.watchOutput.filter((id) => root.watched.includes(id)) : []);
    this.takeRecording(root, t.recording);
  }

  /** Takes the server's grant for the recording and tells the owner what changed. Capture needs the owner's option on as well; with it off nothing is captured. */
  private takeRecording(root: Root, grant: RecordingGrant | null): void {
    const out = root.recorder.apply(grant, this.opts.sessionRecording === true);
    if (!grant) return;
    const now = this.deps.now();
    const say = this.deps.notify;
    if (!say) return;
    if (out.started) say(startLine(grant, now));
    if (out.ended === 'stopped') say(stoppedLine(grant, now));
    else if (out.ended === 'limit') say(limitLine(grant));
    if (out.refused) say(refusedLine(grant));
  }

  /** Posts the recording's next batch. A recorder that is closing sends what it has, a bounded number of requests, and then lets go of the queue. */
  private async sendRecording(root: Root, now: number): Promise<void> {
    const rec = root.recorder;
    const rounds = rec.closing ? FINAL_BATCHES : 1;
    for (let i = 0; i < rounds && rec.due(now); i++) {
      const out = rec.nextBatch(now);
      if (!out) break;
      const res = await this.responder.call('POST', `${sessionPath(root.id)}/recording`, out.batch);
      if (res?.status === 200) {
        rec.done(out.count, now);
        let grant: RecordingGrant | null = null;
        try {
          const g = (JSON.parse(res.text) as { recording?: unknown }).recording;
          grant = isRecordingGrant(g) ? g : null;
        } catch {
          // a reply that is not JSON still took the batch
        }
        this.takeRecording(root, grant);
      } else if (res?.status === 403) {
        rec.stop(); // the three yes answers are not all true any more: nothing is stored, nothing is captured
        return;
      } else if (res?.status === 400 || res?.status === 413) {
        rec.drop(out.count, now); // it would never be accepted
        break;
      } else {
        rec.failed(now);
        break;
      }
    }
    if (rec.closing) rec.finish();
  }

  /** Reads the root's branch and changed files in the background when they are stale. Never throws, and never holds up a report. */
  private refreshGit(root: Root, now: number): void {
    if (!root.cwd || now - (this.gitAt.get(root.id) ?? -Infinity) < DEFAULTS.gitEveryMs) return;
    this.gitAt.set(root.id, now);
    const cwd = root.cwd;
    const run = this.deps.runIn(cwd);
    const branch: Promise<void> = readGit(run, cwd).then(
      (g) => {
        if (JSON.stringify(g) !== JSON.stringify(root.git)) {
          root.git = g;
          root.dirty = true;
        }
      },
      () => undefined,
    );
    // Tried even when the branch read gave null: a repository with no commits yet fails that but has files to list. A failed read keeps the last list.
    const files: Promise<void> = readChanges(run, cwd, root.gitBase).then(
      (c) => {
        if (!c) return;
        root.gitBase = c.base;
        if (JSON.stringify(c.files) !== JSON.stringify(root.files)) {
          root.files = c.files;
          root.dirty = true;
        }
      },
      () => undefined,
    );
    for (const read of [branch, files]) {
      this.gitPending.add(read);
      void read.finally(() => this.gitPending.delete(read));
    }
  }

  /** The diffs a reply asked for, each read and answered once. With the option off nothing is read and the list is ignored. */
  private handleDiffs(root: Root, t: Transport): void {
    const list: DiffRequest[] = t.diffs;
    t.diffs = [];
    if (!this.opts.fileDiff) return;
    for (const req of list) {
      if (this.diffsDone.includes(req.id)) continue;
      this.diffsDone.push(req.id);
      if (this.diffsDone.length > DIFFS_KEPT) this.diffsDone.splice(0, this.diffsDone.length - DIFFS_KEPT);
      const answer = this.answerDiff(root, req);
      this.diffPending.add(answer);
      void answer.finally(() => this.diffPending.delete(answer));
    }
  }

  private async answerDiff(root: Root, req: DiffRequest): Promise<void> {
    try {
      const cwd = root.cwd ?? '';
      const reply = await readFileDiff(this.deps.runIn(cwd), cwd, root.gitBase, req.path, root.files);
      await this.responder.call('PUT', `${sessionPath(root.id)}/diffs/${encodeURIComponent(req.id)}`, reply);
    } catch {
      // The console keeps asking while the owner waits; nothing to undo here.
    }
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
    await Promise.all([...this.store.roots.values()].map((root) => this.sendRecording(root, now)));
    if (this.peers) {
      for (const root of this.store.roots.values()) this.peers.take(root, this.transportOf(root));
      await this.responder.flush();
    }
    for (const root of this.store.roots.values()) this.handleDiffs(root, this.transportOf(root));
    this.explainNew();
    // After the reports, so each root's reply has been read: start waiting for answers and act on what was handed over.
    // Bounded: a call into OpenCode that never returns must not hold up the next report or the other roots.
    if (this.answering) await Promise.all([...this.store.roots.values()].map((root) => withTimeout(this.answering!.drive(root, this.transportOf(root)), this.deps.answering?.answerMs ?? DEFAULTS.answerMs).catch(() => undefined)));
  }

  /**
   * Asks the model to explain each failure that has no explanation, when the person allowed it. Called from the timer, never from `handle`, and
   * never awaited: the call is bounded by a time limit and its failure is swallowed. The prompt is built from the redacted failure record only.
   */
  private explainNew(): void {
    const ask = this.deps.explain;
    if (!this.opts.explainFailures || !ask) return;
    for (const root of this.store.roots.values()) {
      for (const s of root.sessions.values()) {
        const f = s.failure;
        if (!f || f.explanation || s.explainedAt === f.at) continue;
        if (this.explaining >= EXPLAIN_AT_ONCE) return;
        s.explainedAt = f.at;
        this.explaining++;
        void withTimeout(ask(explainPrompt(f, 'OpenCode')), this.deps.explainMs ?? DEFAULTS.explainMs)
          .then((text) => {
            const explanation = excerpt(text, 400);
            // Only if it is still the failure that was asked about.
            if (explanation && s.failure?.at === f.at) {
              s.failure = { ...s.failure, explanation };
              root.dirty = true;
            }
          })
          .catch(() => undefined)
          .finally(() => this.explaining--);
      }
    }
  }

  /** Whether the messaging tools are offered: the person allowed it, and the host can submit a prompt. */
  get messaging(): boolean {
    return this.peers !== null;
  }

  /**
   * A messaging tool's call (`podium_peers`, `podium_send`, `podium_request_access`) from the session it ran in. A call from a subagent's
   * session is refused: only an orchestrator takes part. The answer is the tool's text, never a thrown error.
   */
  async peerTool(name: 'podium_peers' | 'podium_send' | 'podium_request_access', sessionId: string, input: unknown): Promise<string> {
    const peers = this.peers;
    if (!peers) return 'Not taking part. Orchestrator messaging is off on this machine.';
    const rootId = this.store.rootOf.get(sessionId);
    const root = rootId ? this.store.roots.get(rootId) : undefined;
    const t = root ? this.transportOf(root) : undefined;
    const sub = !!root && root.id !== sessionId;
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (name === 'podium_peers') return peers.list(root, t, sub);
    if (name === 'podium_send') return peers.send(root, t, sub, args);
    return peers.access(root, t, sub, args);
  }

  /** `/podium allow|decline|deliver <id>` typed in a session, and the waiting requests `/podium` lists. */
  async answerRequest(sessionId: string, answer: 'allow' | 'decline' | 'deliver', arg: string): Promise<string> {
    const rootId = this.store.rootOf.get(sessionId);
    const root = rootId ? this.store.roots.get(rootId) : undefined;
    if (!this.peers) return 'Orchestrator messaging is not on in this session, so nothing can be answered here. Answer in Podium > My reporters.';
    return this.peers.answer(root, root ? this.transportOf(root) : undefined, answer, arg);
  }

  /** The requests waiting for the person, one line each; empty when none or messaging is off. */
  waitingRequests(): string {
    return this.peers?.openLine() ?? '';
  }

  /** The `plan` tool: names the plan of the orchestrator that called it. A subagent's call changes nothing. */
  namePlan(sessionId: string, input: unknown): string {
    const root = this.store.roots.get(sessionId);
    if (!root) return 'Not named. Only the orchestrator names the plan.';
    const plan = setTitle(root.plan, input);
    if (plan === root.plan) return 'Not named. Give a short title.';
    root.plan = plan;
    root.dirty = true;
    return `Named the plan: ${plan.toolTitle}.`;
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
    for (const root of this.store.roots.values()) {
      finish(root, now, 'shutdown');
      root.recorder.close();
    }
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, closeMs);
    });
    const flush = async (): Promise<void> => {
      await Promise.all([...this.gitPending, ...this.diffPending]);
      const sends: Promise<void>[] = [];
      for (const root of this.store.roots.values()) {
        this.queue(root);
        const t = this.transportOf(root);
        if (root.dirty && now >= t.nextAttemptAt) sends.push(this.send(root, t, now));
      }
      await Promise.all(sends);
      await Promise.all([...this.store.roots.values()].map((root) => this.sendRecording(root, now)));
    };
    try {
      await Promise.race([flush(), limit]);
    } finally {
      clearTimeout(timer);
    }
  }
}
