// The fleet service: owns the live set, turns ingests and timer sweeps into SSE messages, and
// answers the read endpoints. Storage is the async `Storage` (#313); rules are in ingest.ts and derive.ts. The clock is
// injected so the lifecycle tests can move time without waiting.
import { ROLLUP_KEEP_MS, SAME_USAGE, ACTIVITY_FEED, ACTIVITY_OUTPUT, FILE_DIFF, PEER_MESSAGING, RESPOND, SESSION_RECORDING, UPDATE_CHECK, type CostOf, type RetentionPolicy, type SessionRow, type SessionMeta } from '../storage/rows.js';
import { costFn, writeRollups } from './rollups.js';
import type { ActivityHistoryApi, FleetStore, PeerStoreApi, SessionRecordingsApi, Storage } from '../storage/types.js';
import { activityView, computeKpis, family, isUnused, repriced, sessionStatus, sessionView, shortenHome, staleAfterFor, startOfDay, type DeriveConfig } from './derive.js';
import { serverBuild } from './build.js';
import { REPORTER_SUPPORT, serverVersion } from './compat.js';
import { ingestReport, type IngestResult } from './ingest.js';
import { hookSessionId, hookToReport } from './hookIngest.js';
import { validateReport } from './protocol.js';
import type { ActivityView, HistoryRow, Kpis, RemovedReason, Report, ReporterSupport, SessionStatusView, SessionView, StateBody, WallSettingsView } from './protocol.js';
import { formatSse, SseHub, type SseEventName, type SseSink } from './sse.js';
import { Serializer } from './serial.js';
import { LiveActivityHistorySettings, LiveFeatureFlags, LiveModelPrices, LiveRecordingSettings, LiveWallSettings } from './liveSettings.js';
import { ActivityStore } from './activity.js';
import { isNewer, UpdateCheck } from './updateCheck.js';
import { DiffBroker } from './fileDiffs.js';
import { RespondStore } from './respond.js';
import { MAIN_LOOP } from './protocol.js';
import { checkReporter } from './compat.js';
import { silentLogger, type Logger } from '../logging/logger.js';

export interface FleetConfig {
  staleAfterMs: number;
  /** Sessions known only from settings hooks send no heartbeat, so they get a much longer silence allowance. */
  hookStaleAfterMs: number;
  dropAfterMs: number;
  lingerMs: number;
  /** How long a session nobody is attached to stays on the wall, dimmed, before it is set aside. */
  detachedHideAfterMs: number;
  retention: RetentionPolicy;
  home: string;
  /** Minimum gap between two `session` messages for one session. */
  throttleMs: number;
  dbPath: string;
}

export const DEFAULT_CONFIG: Omit<FleetConfig, 'home' | 'dbPath'> = {
  staleAfterMs: 15_000,
  hookStaleAfterMs: 600_000,
  dropAfterMs: 60_000,
  lingerMs: 8_000,
  detachedHideAfterMs: 60_000,
  retention: { samplesMs: 24 * 3600_000, eventsMs: 30 * 24 * 3600_000, sessionsMs: 30 * 24 * 3600_000, adminLogMs: 90 * 24 * 3600_000, rollupMs: ROLLUP_KEEP_MS },
  throttleMs: 500,
};

function envMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Lifecycle and retention settings from the environment (SPEC 7.2, 7.5). */
export function configFromEnv(env: NodeJS.ProcessEnv, base: { home: string; dbPath: string }): FleetConfig {
  const d = DEFAULT_CONFIG;
  // A containerised server cannot see the host's home, so podiumctl passes it in. Anything but an absolute
  // path other than `/` is ignored: a home of `/` would turn every path into `~/...`.
  const hostHome = env.PODIUM_HOST_HOME;
  return {
    ...base,
    home: hostHome && hostHome.startsWith('/') && hostHome !== '/' ? hostHome : base.home,
    staleAfterMs: envMs(env, 'STALE_AFTER_MS', d.staleAfterMs),
    hookStaleAfterMs: envMs(env, 'HOOK_STALE_AFTER_MS', d.hookStaleAfterMs),
    dropAfterMs: envMs(env, 'DROP_AFTER_MS', d.dropAfterMs),
    lingerMs: envMs(env, 'LINGER_MS', d.lingerMs),
    detachedHideAfterMs: envMs(env, 'DETACHED_HIDE_AFTER_MS', d.detachedHideAfterMs),
    throttleMs: d.throttleMs,
    retention: {
      samplesMs: envMs(env, 'RETAIN_SAMPLES_MS', d.retention.samplesMs),
      eventsMs: envMs(env, 'RETAIN_EVENTS_MS', d.retention.eventsMs),
      sessionsMs: envMs(env, 'RETAIN_SESSIONS_MS', d.retention.sessionsMs),
      adminLogMs: envMs(env, 'RETAIN_ADMIN_LOG_MS', d.retention.adminLogMs),
      rollupMs: envMs(env, 'RETAIN_ROLLUP_MS', ROLLUP_KEEP_MS),
    },
  };
}

/** How many session ids a `sweep.removed` line names; the rest are counted in `session_ids_omitted`. */
const SWEEP_IDS_LOGGED = 10;

/** Reporters remembered for `reporter.connected`; the oldest is forgotten past this. */
const MAX_REPORTERS = 1000;

/** How many events /state returns and the UI keeps. */
export const STATE_EVENTS = 150;

interface LiveEntry {
  /** Reported since this server process started. */
  heard: boolean;
  /** The status last broadcast, to notice stale transitions. */
  status: SessionStatusView | null;
}

/** Whether the viewer asking may know that a session has a recording (its owner or an Admin, signed in). */
export type RecordingKnown = (row: SessionRow) => boolean;

const metaOfRow = (row: SessionRow | undefined): SessionMeta | undefined => (row ? { name: row.name, project: row.repo_name ?? row.project_root, owner: row.owner } : undefined);

/** When a session ended: dropped, else ended, else last seen. */
const endedAtOf = (row: SessionRow): number => row.dropped_at ?? row.ended_at ?? row.last_seen_at;

export class Fleet {
  readonly hub = new SseHub();
  /** The wall's notice switches and background-session setting; a change reaches open browsers at once. */
  readonly wall: LiveWallSettings;
  /** The Admin's model prices; every cost figure follows them (issue #117). */
  readonly prices: LiveModelPrices;
  /** The agent activity feed (#118): in memory only, and only for loops a viewer is watching. */
  readonly activity: ActivityStore;
  /** The Admin's Activity history choice (#432): kept in the main database's settings table. */
  readonly activityHistorySettings: LiveActivityHistorySettings;
  /** The Activity history (#432): the feed kept in the second SQLite file under a keep policy. Idle under the default policy. */
  readonly activityHistory: ActivityHistoryApi;
  /** The Admin's session recording limits (#353): kept in the main database's settings table. */
  readonly recordingSettings: LiveRecordingSettings;
  /** Session recordings (#353): whole prompts, tool inputs and results of the loops someone chose, in the activity file. */
  readonly recordings: SessionRecordingsApi;
  /** A file's diff on demand (#319): in memory only, held just while the owner's browser waits. */
  readonly diffs = new DiffBroker();
  /** The Admin's feature flags. Turning the activity feed off drops what it held; any change reaches open browsers. */
  readonly features: LiveFeatureFlags;
  /** Responding from Podium (#206): asks, answers and messages, in memory only. */
  readonly respond: RespondStore;
  /** Orchestrator messaging (#347, #412): rights, requests and messages, in the database. */
  readonly peers: PeerStoreApi;
  /** The daily check for a newer Podium release (#499); the wall's update notice reads its answer. */
  readonly updates: UpdateCheck;
  /** Runs each read-then-write sequence on a session one at a time, and a sweep or retention alone (#313). */
  private readonly serial = new Serializer();
  /** Every SSE message goes out through this chain, in the order it was asked for, so a slow read never reorders them (#313). */
  private out: Promise<void> = Promise.resolve();
  /** The Podium-entry writes to the stored activity (an answer, a note, a take-back) go out through this chain, in the order they were asked for, so an entry's update never overtakes its add. */
  private historyTail: Promise<void> = Promise.resolve();
  /** Bumped by a price change, so a cost-per-minute read that began before it does not keep the old prices in the cache. */
  private priceEpoch = 0;
  /** Bumped when a setting that a snapshot or the wall message carries has changed, so one that began before it is made again (#313). */
  private settingsEpoch = 0;
  private initDone: Promise<void> | null = null;
  private readonly live = new Map<string, LiveEntry>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly startedAt: number;
  private readonly clockSkew = new Map<string, number>();
  private costMinuteCache: { at: number; rows: { m: number; v: number }[] } | null = null;
  /** When each reporter (owner, machine, kind) last reported, for `reporter.connected` (#140). */
  private readonly reporters = new Map<string, number>();

  /**
   * The constructor builds the in-memory parts. `init()` reads what the database holds (the sessions that were live when the
   * server last stopped) and must finish before the server listens.
   */
  constructor(
    readonly storage: Storage,
    readonly cfg: FleetConfig,
    readonly now: () => number = Date.now,
    /** Lifecycle events (#140): session.started/ended, reporter.connected/silent, sweep.removed. Silent by default. */
    readonly logger: Logger = silentLogger,
    /** Whether the server has a sign-in token; a keep policy needs one. `secret` is that token, replaced wherever a recording would store it. */
    history: { authOn?: boolean; secret?: string | null } = {},
  ) {
    this.startedAt = now();
    this.features = new LiveFeatureFlags(storage.featureFlags, (id, on) => {
      this.settingsEpoch++;
      if (id === ACTIVITY_FEED && !on) this.activity.clear();
      if (id === FILE_DIFF && !on) this.diffs.clear();
      // Output going off drops every output held on a lease (#431). The commands, the leases and the history are untouched.
      if (id === ACTIVITY_OUTPUT && !on) this.activity.dropOutput();
      // Responding needs both flags: either going off drops every ask and answer the server holds.
      if ((id === ACTIVITY_FEED || id === RESPOND) && !on) this.respond.clear();
      // Messaging going off drops every message still waiting; the rights stay.
      if (id === PEER_MESSAGING && !on) this.peers.dropAll().catch((err: Error) => this.logger.error('peers.drop_failed', `podium: could not drop the held messages: ${err.message}`, { reason: err.message }));
      // Recording going off stops every recording and keeps what it holds until it expires (#353).
      // The flag is already off in memory, so nothing more is accepted from this moment; the stop marks are written in the step this asks for.
      if (id === SESSION_RECORDING && !on) {
        this.recordings.stopAll('Admin').then(
          (ids) => ids.forEach((sid) => this.recordingChanged(sid)),
          (err: Error) => this.logger.error('recording.stop_failed', `podium: could not stop the recordings: ${err.message}`, { reason: err.message }),
        );
      }
      // The release check going on looks straight away instead of waiting for the next daily run.
      if (id === UPDATE_CHECK && on) void this.updates.check();
      this.broadcastSnapshot();
    });
    const authOn = history.authOn ?? true;
    this.activityHistorySettings = new LiveActivityHistorySettings(storage.activityHistorySettings(authOn));
    this.recordingSettings = new LiveRecordingSettings(storage.recordingSettings);
    // The settings, the flags and the live set the two services read are memory (the live settings are write-through caches and
    // `live` is updated before anything can ask), so those callbacks stay synchronous. What lives in the main database, a session's
    // agents, is read from the fleet store before the service takes its step.
    const stored = storage.activity({
      history: {
        now,
        settings: () => this.activityHistorySettings.get(),
        featureOn: () => this.features.featureOn(ACTIVITY_FEED),
        isLive: (sid) => this.live.has(sid),
        agentsOf: async (sid) => (await this.db.getAgents(sid)).filter((a) => a.status === 'running').map((a) => a.id),
        authOn,
      },
      recordings: {
        now,
        settings: () => this.recordingSettings.get(),
        flagOn: () => this.features.featureOn(SESSION_RECORDING),
        authOn,
        isLive: (sid) => this.live.has(sid),
        loopsOf: async (sid) => [{ loop: MAIN_LOOP, name: 'Orchestrator' }, ...(await this.db.getAgents(sid)).map((a) => ({ loop: a.id, name: a.name ?? a.type }))],
        secrets: () => (history.secret ? [history.secret] : []),
      },
    });
    this.activityHistory = stored.history;
    this.recordings = stored.recordings;
    // The loops the stored history wants are added to the report reply by `watchedLoops`, which can wait for the agents.
    this.activity = new ActivityStore(
      now,
      () => this.features.featureOn(ACTIVITY_FEED),
      () => [],
      () => this.features.featureOn(ACTIVITY_OUTPUT),
    );
    this.respond = new RespondStore(
      now,
      (sid) => {
        if (this.live.has(sid)) this.scheduleSession(sid);
      },
      {
        // The live feed is updated first and cannot fail. The history write is best effort: a full disk or a locked file is
        // logged and never reaches the answer, ask or message that caused it.
        add: (sid, loop, ref, e, delivery) => {
          this.activity.addPodium(sid, loop ?? MAIN_LOOP, ref, e);
          this.historySafely('add', sid, async () => {
            const meta = await this.historyMeta(sid);
            if (meta) await this.activityHistory.addPodium(sid, loop ?? MAIN_LOOP, ref, e, meta);
          });
          // A message's prompt entry, when it arrives from the mod, gets the sender as its marker (#353), when its text matches exactly. An answer, an
          // approval, a permission decision and /clear and /compact are recorded by the mod itself, where it takes them.
          if (delivery.kind === 'message') this.historySafely('add', sid, () => this.recordings.notePodiumPrompt(sid, loop ?? MAIN_LOOP, e, ref));
        },
        update: (sid, ref, note) => {
          this.activity.updatePodium(sid, ref, note);
          this.historySafely('update', sid, () => this.activityHistory.updatePodium(sid, ref, note));
        },
        remove: (sid, ref) => {
          this.activity.removePodium(sid, ref);
          this.historySafely('remove', sid, () => this.activityHistory.removePodium(sid, ref));
          this.historySafely('remove', sid, () => this.recordings.forgetPodiumPrompt(sid, ref));
        },
      },
    );
    this.peers = storage.peers({ now, flagOn: () => this.features.featureOn(PEER_MESSAGING), startedAt: this.startedAt });
    this.wall = new LiveWallSettings(storage.wallSettings, () => {
      this.settingsEpoch++;
      void this.broadcastWall();
    });
    this.updates = new UpdateCheck({
      current: serverVersion(),
      enabled: () => this.features.featureOn(UPDATE_CHECK),
      onChange: () => this.broadcastWall(),
      logger,
    });
    // A price change moves every cost on the wall, so open browsers get a fresh snapshot.
    this.prices = new LiveModelPrices(storage.modelPrices, storage.tx, () => {
      this.settingsEpoch++;
      this.costMinuteCache = null; // the sparkline follows the prices too (#270)
      this.priceEpoch++;
      this.broadcastSnapshot();
    });
  }

  /** The sessions, agents, events and spend. */
  get db(): FleetStore {
    return this.storage.fleet;
  }

  /**
   * On start every stored session that has not ended is treated as stale until it reports again;
   * a done session still inside its linger window stays until the window closes. Safe to call twice.
   */
  init(): Promise<void> {
    this.initDone ??= Promise.all([
      this.db.liveCandidates(this.startedAt - this.cfg.lingerMs),
      this.features.load(),
      this.wall.load(),
      this.prices.load(),
      this.activityHistorySettings.load(),
      this.recordingSettings.load(),
    ]).then(([rows]) => {
      for (const row of rows) this.live.set(row.id, { heard: false, status: null });
    });
    return this.initDone;
  }

  // ---- messages -------------------------------------------------------------------------------

  /**
   * Runs `job` after every earlier job, so messages leave in the order they were asked for however long each one's reads take.
   * A job that fails is logged and never stalls the ones after it. Resolves with the job's result, or undefined when it failed.
   */
  private enqueue<T>(job: () => Promise<T>): Promise<T | undefined> {
    const run = this.out.then(job);
    this.out = run.then(
      () => undefined,
      (err: Error) => this.logger.error('broadcast.failed', `podium: could not send a message to the consoles: ${err.message}`, { reason: err.message }),
    );
    return run.then((v) => v, () => undefined);
  }

  /** Runs `make` again until no setting changed while it ran, so a message never leaves carrying a value that has already been replaced. */
  private async settled<T>(make: () => Promise<T> | T): Promise<T> {
    for (;;) {
      const at = this.settingsEpoch;
      const made = await make();
      if (at === this.settingsEpoch) return made;
    }
  }

  /** Sends one message to every client once `make` has read what it carries. `make` returns null to send nothing. */
  private emit(make: () => Promise<[SseEventName, unknown] | null> | [SseEventName, unknown] | null): Promise<void> {
    return this.enqueue(async () => {
      const m = await this.settled(make);
      if (m) this.hub.broadcast(m[0], m[1]);
    }).then(() => undefined);
  }

  private broadcastSnapshot(): Promise<void> {
    return this.emit(async () => ['snapshot', await this.state()]);
  }

  private broadcastWall(): Promise<void> {
    return this.emit(() => ['wall', this.wallView()]);
  }

  /** Adds an SSE client with a snapshot as its first message. Messages asked for after this call reach it after the snapshot. Resolves with its id, or null when the client is gone or the hub is full. */
  attach(sink: SseSink): Promise<number | null> {
    return this.enqueue(async () => this.hub.add(sink, [await this.settled(() => this.snapshotMessage())])).then((id) => id ?? null);
  }

  /** Resolves when every message asked for so far has been sent. */
  async flush(): Promise<void> {
    await this.historyTail;
    let seen: Promise<void>;
    do {
      seen = this.out;
      await seen;
    } while (seen !== this.out);
  }

  private get derive(): DeriveConfig {
    return { staleAfterMs: this.cfg.staleAfterMs, hookStaleAfterMs: this.cfg.hookStaleAfterMs, home: this.cfg.home };
  }

  /** Whether the Admin's switches let anyone respond: the respond and activity-feed flags. Authentication is the routes' check. */
  respondFlagsOn(): boolean {
    return this.features.featureOn(RESPOND) && this.features.featureOn(ACTIVITY_FEED);
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  liveIds(): string[] {
    return [...this.live.keys()];
  }

  /** How many live sessions are on the wall: what the reporter's status line and /health report. */
  async visibleCount(): Promise<number> {
    let n = 0;
    for (const id of [...this.live.keys()]) if (!(await this.unused(await this.db.getSession(id)))) n++;
    return n;
  }

  /** A session that has done nothing yet is kept off the wall and out of every feed (see `isUnused`). */
  private async unused(row: SessionRow | undefined): Promise<boolean> {
    // With 0 as the agent count `isUnused` runs every other test; the agents are read only for a row that passes them.
    return !!row && isUnused(row, 0) && (await this.db.getAgents(row.id)).length === 0;
  }

  // ---- ingest ---------------------------------------------------------------------------------

  /** Stores one report and brings the live set, the feeds and the consoles up to date. Reports for one session are handled one at a time. */
  ingest(report: Report, owner: string | null = null): Promise<IngestResult> {
    return this.serial.run(report.session.id, () => this.ingestNow(report, owner));
  }

  /** `ingest` for a caller that already holds the session's turn. */
  private async ingestNow(report: Report, owner: string | null): Promise<IngestResult> {
    const res = await ingestReport(this.storage, report, this.now(), owner);
    this.clockSkew.set(res.sessionId, res.clockSkewMs);
    this.activity.ingest(report, res.clockSkewMs);
    // The report is already saved: a failure of the second file (a full disk, say) is logged and must not refuse the report.
    try {
      if (this.activityHistory.enabled()) await this.activityHistory.ingest(report, res.clockSkewMs, (await this.historyMeta(res.sessionId)) ?? { name: report.session.name, project: null, owner });
    } catch (err) {
      this.logger.error('activity.ingest_failed', `podium: could not store the activity of session ${res.sessionId}: ${(err as Error).message}`, { session_id: res.sessionId, reason: (err as Error).message });
    }
    if (typeof report.session.fileDiff === 'boolean') this.diffs.noteOption(res.sessionId, report.session.fileDiff);
    if (typeof report.session.fileDiffPreload === 'boolean') this.diffs.notePreload(res.sessionId, report.session.fileDiffPreload);
    // The owner's consent to be recorded, from this report (#353). After a /clear the new session inherits a running recording.
    this.recordings.noteOption(res.sessionId, report.session.sessionRecording);
    if (res.created && report.session.clearedFrom) {
      const meta = await this.historyMeta(res.sessionId);
      try {
        if (meta) await this.recordings.carryOver(report.session.clearedFrom, res.sessionId, meta);
      } catch (err) {
        this.logger.error('recording.carry_failed', `podium: could not carry a recording over to session ${res.sessionId}: ${(err as Error).message}`, { session_id: res.sessionId, reason: (err as Error).message });
      }
    }
    this.respond.noteReport(report, this.respondFlagsOn());
    this.noteReporter(report, owner);
    const entry = this.live.get(res.sessionId);
    const row = await this.db.getSession(res.sessionId);
    if (entry) {
      entry.heard = true;
    } else if (!(res.ended && res.wasDone)) {
      // New, revived, or back after leaving the live set. A repeated final report for a session that
      // already left is stored but does not bring it back.
      this.live.set(res.sessionId, { heard: true, status: null });
      this.logger.info('session.started', `podium: session ${res.sessionId} ${res.created ? 'started' : 'is reporting again'}`, {
        session_id: res.sessionId,
        owner,
        created: res.created,
        revived: res.revived,
        model: row?.model ?? null,
        reporter: report.reporter.hostSurface === 'settings-hooks' ? 'hooks' : 'mod',
      });
    }
    if (res.ended && !res.wasDone) {
      this.logger.info('session.ended', `podium: session ${res.sessionId} ended${row?.end_reason ? ` (${row.end_reason})` : ''}`, {
        session_id: res.sessionId,
        owner,
        reason: 'done',
        end_reason: row?.end_reason ?? null,
      });
    }
    if (!(await this.unused(row))) {
      for (const e of res.newEvents.slice().sort((x, y) => x.t - y.t)) {
        await this.emit(() => ['activity', activityView(e, row)]);
      }
    }
    if (this.live.has(res.sessionId)) this.scheduleSession(res.sessionId);
    return res;
  }

  /** What the Stored activity table shows about a session; undefined when the main database does not hold it. */
  async historyMeta(sessionId: string): Promise<SessionMeta | undefined> {
    return metaOfRow(await this.db.getSession(sessionId));
  }

  /**
   * Runs a write to the Activity history or the recordings for a Podium entry; a failure is logged as `activity.podium_failed` and
   * never thrown. The respond store cannot wait, so the writes queue and run one after the other in the order they were asked for.
   */
  private historySafely(what: 'add' | 'update' | 'remove', sessionId: string, fn: () => unknown): void {
    this.historyTail = this.historyTail.then(async () => {
      try {
        await fn();
      } catch (err) {
        this.logger.error('activity.podium_failed', `podium: could not ${what} a Podium entry in the activity history of session ${sessionId}: ${(err as Error).message}`, { session_id: sessionId, op: what, reason: (err as Error).message });
      }
    });
  }

  /** The report reply's `watch`: the loops under a viewer's lease, and those the stored history wants for a session whose reporter sends the feed. */
  async watchedLoops(sessionId: string): Promise<string[]> {
    const stored = this.activityHistory.enabled() && this.activity.feedOn(sessionId) === true ? await this.activityHistory.loopsToWatch(sessionId) : [];
    return this.activity.watched(sessionId, stored);
  }

  /** `reporter.connected` the first time a reporter is heard, and again when it comes back after going quiet. */
  private noteReporter(report: Report, owner: string | null): void {
    const kind = report.reporter.hostSurface === 'settings-hooks' ? 'hooks' : 'mod';
    const key = `${owner ?? ''}\u0000${report.machine?.id ?? ''}\u0000${kind}`;
    const now = this.now();
    const last = this.reporters.get(key);
    this.reporters.delete(key); // re-insert so the oldest entry is the one forgotten at the cap
    this.reporters.set(key, now);
    if (this.reporters.size > MAX_REPORTERS) this.reporters.delete(this.reporters.keys().next().value as string);
    if (last !== undefined && now - last <= this.cfg.staleAfterMs) return;
    const who = [owner, report.machine?.name].filter(Boolean).join(' on ') || 'an unnamed reporter';
    this.logger.info('reporter.connected', `podium: ${kind === 'hooks' ? 'settings hooks' : 'reporter'} ${report.reporter.version} connected (${who})`, {
      owner,
      machine: report.machine?.name ?? null,
      machine_id: report.machine?.id ?? null,
      reporter: kind,
      reporter_version: report.reporter.version,
      reporter_compat: checkReporter(report.reporter.version),
      returning: last !== undefined,
    });
  }

  /** A classic settings-hook payload (T5.1): merged with what is stored, then ingested as a report. */
  ingestHook(payload: unknown, owner: string | null = null): Promise<{ ok: true; sessionId: string } | { ok: false; error: string; path: string }> {
    // What a hook is merged with is read and the report written under the session's one turn, so two hooks cannot both start from the same stored state.
    const sid = hookSessionId(payload);
    return sid ? this.serial.run(sid, () => this.ingestHookNow(payload, owner, sid)) : this.ingestHookNow(payload, owner, '');
  }

  private async ingestHookNow(payload: unknown, owner: string | null, sid: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: string; path: string }> {
    const stored = sid ? { session: await this.db.getSession(sid), agents: await this.db.getAgents(sid) } : { agents: [] };
    const res = hookToReport(payload, stored, this.now());
    if (!res.ok) return res;
    if ('ignored' in res) return { ok: true, sessionId: res.sessionId };
    const v = validateReport(res.report);
    if (!v.ok) return v;
    await this.ingestNow(v.report, owner);
    return { ok: true, sessionId: v.report.session.id };
  }

  /** Coalesces `session` messages: at most one per session per throttle window, carrying the latest state. */
  private scheduleSession(id: string): void {
    if (this.pending.has(id)) return;
    const timer = setTimeout(() => {
      this.pending.delete(id);
      void this.emit(async () => {
        const view = await this.view(id);
        if (view && this.live.has(id) && !(await this.unused(await this.db.getSession(id)))) {
          const entry = this.live.get(id);
          if (entry) entry.status = view.status;
          return ['session', view];
        }
        return null;
      });
    }, this.cfg.throttleMs);
    timer.unref?.();
    this.pending.set(id, timer);
  }

  // ---- reads ----------------------------------------------------------------------------------

  /** One session's view, live or historical. */
  view(id: string): Promise<SessionView | undefined> {
    // One transaction, so the session, its agents and its samples are read as of one moment even while a report is being stored.
    return this.storage.tx(async () => {
      const row = await this.db.getSession(id);
      return row ? this.viewOf(row) : undefined;
    });
  }

  private async viewOf(row: SessionRow): Promise<SessionView> {
    const now = this.now();
    const agents = await this.db.getAgents(row.id);
    const blowouts = await this.db.getBlowouts(row.id);
    const samples = await this.db.samplesSince(row.id, Math.floor(now / 1000) - 61);
    const ownerGroup = await this.db.groupOfOwner(row.owner);
    const entry = this.live.get(row.id);
    return sessionView(
      {
        row,
        agents,
        blowouts,
        samples,
        heard: entry ? entry.heard : true,
        dropAt: entry ? this.dropAtFor(row, entry.heard, now) : null,
        hideAt: row.attached === 0 && row.detached_at !== null ? row.detached_at + this.cfg.detachedHideAfterMs : null,
        ownerGroup,
        pricing: this.prices.pricing(),
        activityFeed: this.activity.feedOn(row.id),
        activityOutput: this.activity.outputOptionOn(row.id),
        fileDiff: this.diffs.optionOn(row.id),
        fileDiffPreload: this.diffs.preloadOn(row.id),
        respond: this.respond.info(row.id),
        asks: this.respond.summaries(row.id),
        recording: await this.recordings.view(row.id),
      },
      now,
      this.derive,
    );
  }

  /**
   * When a stale live session leaves the wall by itself, or null if it is not stale. The drop clock starts
   * when the session went stale, but for one not heard since this server started it starts no earlier than
   * the server's start (SPEC 7.5). `sweep` and the view both use this, so the card says what will happen.
   */
  private dropAtFor(row: SessionRow, heard: boolean, now: number = this.now()): number | null {
    const staleAfterMs = staleAfterFor(row, this.derive);
    if (sessionStatus(row, heard, now, staleAfterMs) !== 'stale') return null;
    const base = row.last_seen_at + staleAfterMs;
    return (heard ? base : Math.max(base, this.startedAt)) + this.cfg.dropAfterMs;
  }

  liveViews(): Promise<SessionView[]> {
    // The sessions are read in one transaction, so the wall is one moment's state, as it was when the reads were synchronous.
    return this.storage.tx(async () => {
      const out: SessionView[] = [];
      for (const id of [...this.live.keys()]) {
        const row = await this.db.getSession(id);
        if (row && !(await this.unused(row))) out.push(await this.viewOf(row));
      }
      return out;
    });
  }

  async kpis(views?: readonly SessionView[]): Promise<Kpis> {
    const live = views ?? (await this.liveViews());
    const now = this.now();
    const nowSec = Math.floor(now / 1000);
    const pricing = this.prices.pricing();
    const cost: CostOf = (r) => repriced(pricing, r.usage_json, r.cost_usd);
    let cache = this.costMinuteCache;
    if (!cache || now - cache.at > 5000) {
      const epoch = this.priceEpoch;
      cache = { at: now, rows: await this.db.fleetCostPerMinute((Math.floor(nowSec / 60) - 59) * 60, cost) };
      // A price change while this was reading cleared the cache; these rows used the old prices, so they serve this call only.
      if (epoch === this.priceEpoch) this.costMinuteCache = cache;
    }
    const spend = await this.db.spendTotals(startOfDay(now), cost);
    return computeKpis(
      {
        views: live,
        costToday: spend.total,
        costTodayByOwner: spend.byOwner,
        tokensPerSecond: await this.db.fleetTokensPerSecond(nowSec - 61),
        costPerMinute: cache.rows,
      },
      now,
    );
  }

  async clearedToday(): Promise<number> {
    const now = this.now();
    let n = 0;
    for (const s of await this.db.endedBetween(startOfDay(now), now + 1)) if (!this.live.has(s.id) && !(await this.unused(s))) n++;
    return n;
  }

  async events(opts: { sessionId?: string | null; before?: number | null; limit: number }): Promise<ActivityView[]> {
    const rows = await this.db.listEvents(opts);
    const sessions = new Map<string, SessionRow | undefined>();
    const out: ActivityView[] = [];
    for (const e of rows) {
      if (!sessions.has(e.session_id)) sessions.set(e.session_id, await this.db.getSession(e.session_id));
      if (!(await this.unused(sessions.get(e.session_id)))) out.push(activityView(e, sessions.get(e.session_id)));
    }
    return out;
  }

  /** Sessions that ended or were dropped in [from, to), as summary rows, newest first. */
  async history(from: number, to: number, mayKnow?: RecordingKnown): Promise<HistoryRow[]> {
    const out: HistoryRow[] = [];
    for (const row of await this.historyRows(from, to)) out.push(await this.historyRow(row, mayKnow));
    return out;
  }

  /**
   * One page of `history`, with the day's total. The filter and the sort use the session rows alone; the agents
   * query and the repricing run for the rows on the page only. A page past the end is the last page.
   */
  async historyPage(from: number, to: number, page: number, pageSize: number, mayKnow?: RecordingKnown): Promise<{ rows: HistoryRow[]; total: number; page: number }> {
    const all = await this.historyRows(from, to);
    const at = Math.min(page, Math.max(1, Math.ceil(all.length / pageSize)));
    const rows: HistoryRow[] = [];
    for (const row of all.slice((at - 1) * pageSize, at * pageSize)) rows.push(await this.historyRow(row, mayKnow));
    return { rows, total: all.length, page: at };
  }

  /** The day's sessions that did something, newest end first, with the id breaking ties so a row never moves between pages. */
  private async historyRows(from: number, to: number): Promise<SessionRow[]> {
    const kept: SessionRow[] = [];
    for (const row of await this.db.endedBetween(from, to)) if (!(await this.unused(row))) kept.push(row);
    return kept.sort((a, b) => endedAtOf(b) - endedAtOf(a) || (a.id < b.id ? -1 : 1));
  }

  private async historyRow(row: SessionRow, mayKnow?: RecordingKnown): Promise<HistoryRow> {
    const agents = await this.db.getAgents(row.id);
    const clearedInto = await this.db.clearedInto(row.id);
    const end = endedAtOf(row);
    const kept = await this.keptMark(row, mayKnow);
    return {
      id: row.id,
      name: row.name,
      project: shortenHome(row.project_root ?? row.cwd, this.cfg.home),
      model: row.model,
      modelFamily: family(row.model),
      startedAt: row.started_at,
      endedAt: end,
      durationSec: Math.max(0, Math.round((end - row.started_at) / 1000)),
      costUsd: repriced(this.prices.pricing(), row.usage_json, row.cost_usd),
      blowouts: row.blowouts + agents.reduce((n, a) => n + a.blowouts, 0),
      agents: agents.length,
      endReason: row.dropped_at !== null ? 'heartbeat lost' : row.end_reason,
      clearedFrom: row.cleared_from ?? null,
      clearedInto,
      ...kept,
    };
  }

  /** The History row's recording marker (#353): only for a viewer `mayKnow` says may know of the session's recording, and only while one is held. */
  private async keptMark(row: SessionRow, mayKnow?: RecordingKnown): Promise<Pick<HistoryRow, 'recording'>> {
    // With the Admin's flag off the replay routes answer 404, so the marker would point at nothing.
    if (!this.recordings.enabled() || !mayKnow?.(row)) return {};
    const keptUntil = await this.recordings.keptUntilOf(row.id);
    return keptUntil === null ? {} : { recording: { keptUntil } };
  }

  /** The wall's settings plus the update notice: a release newer than this server that nobody has closed the notice for (#499). */
  private wallView(): WallSettingsView {
    const found = this.updates.latest();
    const dismissed = this.wall.updateDismissed();
    const update = found && (dismissed === null || isNewer(found.latest, dismissed)) ? found : null;
    return { ...this.wall.view(), update };
  }

  async state(): Promise<StateBody> {
    const sessions = await this.liveViews();
    const serverTime = this.now();
    const kpis = await this.kpis(sessions);
    const clearedToday = await this.clearedToday();
    const events = await this.events({ limit: STATE_EVENTS });
    return {
      serverTime,
      config: { staleAfterMs: this.cfg.staleAfterMs, dropAfterMs: this.cfg.dropAfterMs, lingerMs: this.cfg.lingerMs, detachedHideAfterMs: this.cfg.detachedHideAfterMs },
      sessions,
      kpis,
      clearedToday,
      events,
      server: { version: serverVersion(), build: serverBuild(), reporterSupport: REPORTER_SUPPORT },
      wall: this.wallView(),
      // `activity-history` is derived, not an Admin flag: the console reads it to offer the sign-in that stored history needs.
      features: { ...this.features.view(), 'activity-history': this.activityHistory.enabled() },
    };
  }

  /** A recording was started, stopped, deleted or changed: the session's card and page learn of it at the next broadcast. */
  recordingChanged(sessionId: string): void {
    if (this.live.has(sessionId)) this.scheduleSession(sessionId);
  }

  /** The Admin changed the Activity history setting: open consoles learn whether a sign-in is now offered. */
  activityHistoryChanged(): Promise<void> {
    this.settingsEpoch++;
    return this.broadcastSnapshot();
  }

  /** The first message a new SSE client gets. */
  async snapshotMessage(): Promise<string> {
    return formatSse('snapshot', await this.state());
  }

  async health(): Promise<{ ok: true; dbPath: string; liveSessions: number; uptimeSec: number; reporterVersionsSeen: string[]; serverVersion: string; serverBuild: string | null; reporterSupport: ReporterSupport; sseClients: number; maxClockSkewMs: number }> {
    let skew = 0;
    for (const id of this.live.keys()) skew = Math.max(skew, Math.abs(this.clockSkew.get(id) ?? 0));
    return {
      ok: true,
      dbPath: this.cfg.dbPath,
      liveSessions: await this.visibleCount(),
      uptimeSec: Math.floor((this.now() - this.startedAt) / 1000),
      reporterVersionsSeen: await this.db.distinctReporterVersions(),
      serverVersion: serverVersion(),
      serverBuild: serverBuild(),
      reporterSupport: REPORTER_SUPPORT,
      sseClients: this.hub.size,
      maxClockSkewMs: skew,
    };
  }

  // ---- writes ---------------------------------------------------------------------------------

  /**
   * Puts the reporting orchestrator in the peer directory, in the session's own turn and only if the session is still there: a delete or an end
   * that ran after this report was stored, or a done report that followed it, is not undone by a note that arrives late (#313).
   */
  noteOrchestrator(sessionId: string, reporterKey: string, owner: string, report: Report): Promise<void> {
    return this.serial.run(sessionId, async () => {
      if (!this.live.has(sessionId)) return;
      const row = await this.db.getSession(sessionId);
      if (!row || (row.status === 'done' && report.session.status !== 'done')) return;
      await this.peers.note(sessionId, reporterKey, owner, report);
    });
  }

  /** Deletes a session after any report for it that was already taken in; a report taken in later stores it again, as ever. */
  deleteSession(id: string): Promise<boolean> {
    return this.serial.run(id, () => this.deleteNow(id));
  }

  private async deleteNow(id: string): Promise<boolean> {
    const wasLive = this.live.delete(id);
    this.clockSkew.delete(id);
    this.activity.dropSession(id);
    // The rows go in chunks, after this returns; a failure is logged, and the session is gone from the main database regardless.
    this.activityHistory.deleteSession(id).catch((err: Error) => this.logger.error('activity.delete_failed', `podium: could not remove the activity history of session ${id}: ${err.message}`, { session_id: id, reason: err.message }));
    this.recordings.forgetSession(id);
    // Its recording goes with it, in chunks after this returns; a failure is logged.
    this.recordings.removeSession(id).catch((err: Error) => this.logger.error('recording.delete_failed', `podium: could not remove the recording of session ${id}: ${err.message}`, { session_id: id, reason: err.message }));
    this.diffs.drop(id);
    this.respond.dropSession(id);
    await this.peers.deleted([id]);
    const t = this.pending.get(id);
    if (t) clearTimeout(t);
    this.pending.delete(id);
    const existed = await this.db.deleteSession(id);
    if (wasLive) await this.emit(() => ['removed', { sessionId: id, reason: 'deleted' satisfies RemovedReason }]);
    if (existed) this.logger.info('session.deleted', `podium: session ${id} deleted`, { session_id: id, live: wasLive });
    return existed;
  }

  /**
   * The Remove button on a heartbeat-lost card: the same exit as the automatic drop, run now. The session
   * stays in History, and comes back live if it reports again.
   */
  dropSession(id: string): Promise<'dropped' | 'unknown' | 'not-stale'> {
    return this.serial.run(id, async () => {
      const entry = this.live.get(id);
      const row = entry ? await this.db.getSession(id) : undefined;
      if (!entry || !row) return 'unknown';
      if (sessionStatus(row, entry.heard, this.now(), staleAfterFor(row, this.derive)) !== 'stale') return 'not-stale';
      await this.leave(row, 'dropped', 'heartbeat lost', 'remove');
      return 'dropped';
    });
  }

  /** The exit of a session from the wall. The caller holds the session's turn (or the sweep's), so the row it read is still the stored one. */
  private async leave(row: SessionRow, reason: 'done' | 'dropped', text: string, by: 'sweep' | 'remove' = 'sweep'): Promise<void> {
    const now = this.now();
    if (reason === 'dropped') {
      this.logger.info('session.ended', `podium: session ${row.id} ended: heartbeat lost${by === 'remove' ? ' (removed from the wall)' : ''}`, {
        session_id: row.id,
        owner: row.owner,
        reason: 'heartbeat lost',
        by,
        silent_s: Math.round((now - row.last_seen_at) / 1000),
      });
    }
    this.live.delete(row.id);
    this.clockSkew.delete(row.id);
    this.activity.dropSession(row.id);
    this.activityHistory.forgetSession(row.id);
    this.recordings.forgetSession(row.id);
    this.diffs.drop(row.id);
    this.respond.endSession(row.id);
    this.respond.dropSession(row.id);
    await this.peers.ended(row.id);
    const t = this.pending.get(row.id);
    if (t) clearTimeout(t);
    this.pending.delete(row.id);
    if (reason === 'dropped') await this.db.setDropped(row.id, now);
    const marker = reason === 'done' ? row.ended_at ?? now : row.last_seen_at;
    const ev = {
      id: `${row.id}:server:end:${reason}:${marker}`,
      session_id: row.id,
      agent_id: null,
      t: now,
      kind: 'end',
      text,
      data_json: JSON.stringify({ reason }),
    };
    const inserted = await this.db.insertEvent(ev);
    // A session that never reached the wall gets no activity line on its way out. 'removed' is always sent:
    // a card shown while the session was running must still go when it ends with no usage.
    if (inserted && !(await this.unused(row))) await this.emit(() => ['activity', activityView(ev, row)]);
    await this.emit(() => ['removed', { sessionId: row.id, reason }]);
  }

  // ---- timers (driven by sweeper.ts) ------------------------------------------------------------

  /** Once a second: stale transitions, drops, lingering done sessions, carry-forward samples. */
  sweep(): Promise<void> {
    return this.serial.exclusive(() => this.sweepNow());
  }

  private async sweepNow(): Promise<void> {
    const now = this.now();
    this.activity.expire();
    this.respond.expire();
    const nowSec = Math.floor(now / 1000);
    const removed = { done: [] as string[], dropped: [] as string[] };
    for (const [id, entry] of [...this.live]) {
      const row = await this.db.getSession(id);
      if (!row) {
        this.live.delete(id);
        continue;
      }
      if (row.status === 'done') {
        if (now - (row.ended_at ?? now) >= this.cfg.lingerMs) {
          await this.leave(row, 'done', 'session ended');
          removed.done.push(id);
        }
        continue;
      }
      const status = sessionStatus(row, entry.heard, now, staleAfterFor(row, this.derive));
      if (status === 'stale') {
        if (now >= (this.dropAtFor(row, entry.heard, now) ?? Infinity)) {
          await this.leave(row, 'dropped', 'heartbeat lost');
          removed.dropped.push(id);
          continue;
        }
      } else {
        // A live session that reports less often than once a second still gets one sample per
        // second, so its charts do not fall to zero between heartbeats.
        const last = await this.db.latestSample(id);
        if (last && last.t < nowSec) {
          // The copy repeats the usage as "same as before", except at the start of a minute, which needs it in full (#270).
          const usage = last.usage_json == null ? null : Math.floor(last.t / 60) === Math.floor(nowSec / 60) ? SAME_USAGE : row.usage_json;
          await this.db.insertSampleIfAbsent({ ...last, t: nowSec, tokens_delta: 0, usage_json: usage });
        }
      }
      if (entry.status !== null && entry.status !== status) {
        if (status === 'stale') {
          this.logger.warn('reporter.silent', `podium: session ${id} went quiet (no report for ${Math.round((now - row.last_seen_at) / 1000)} s)`, {
            session_id: id,
            owner: row.owner,
            silent_s: Math.round((now - row.last_seen_at) / 1000),
            was: entry.status,
          });
        }
        entry.status = status;
        if (!(await this.unused(row))) {
          const view = await this.viewOf(row);
          await this.emit(() => ['session', view]);
        }
      } else if (entry.status === null) {
        entry.status = status;
      }
    }
    const n = removed.done.length + removed.dropped.length;
    if (n > 0) {
      // A sweep after a long outage can remove hundreds; the line names the first few and the count it left out.
      const ids = [...removed.done, ...removed.dropped];
      this.logger.info('sweep.removed', `podium: sweep removed ${n} session${n === 1 ? '' : 's'} from the wall (${removed.done.length} ended, ${removed.dropped.length} heartbeat lost)`, {
        removed: n,
        done: removed.done.length,
        dropped: removed.dropped.length,
        session_ids: ids.slice(0, SWEEP_IDS_LOGGED).join(','),
        ...(ids.length > SWEEP_IDS_LOGGED ? { session_ids_omitted: ids.length - SWEEP_IDS_LOGGED } : {}),
      });
    }
  }

  /** Every 2 s: KPIs to every client; doubles as the keepalive. */
  tick(): Promise<void> {
    return this.emit(async () => ['tick', { serverTime: this.now(), kpis: await this.kpis() }]);
  }

  /** Hourly: retention. It runs alone, so no report is half stored while the old rows go. */
  retain(): Promise<{ samples: number; events: number; sessions: number; adminLog: number; peerMessages: number; peerRequests: number }> {
    return this.serial.exclusive(() => this.retainNow());
  }

  private async retainNow(): Promise<{ samples: number; events: number; sessions: number; adminLog: number; peerMessages: number; peerRequests: number }> {
    // The daily rollups first (#484), so what retention is about to delete is counted before it goes.
    // A failure here must not stop the pruning below, or every table would grow without limit.
    try {
      await writeRollups(this.storage, this.now(), costFn(this.prices.pricing()), this.cfg.retention);
    } catch (err) {
      this.logger.error('retention.rollups_failed', `podium: could not write the daily rollups: ${(err as Error).message}`, { reason: (err as Error).message });
    }
    const out = await this.db.retain(this.now(), this.cfg.retention);
    // A session's retention ends its activity history too, whatever the policy: the shorter wins (#432). The rows go in
    // chunks in the background, so the hourly retention never waits for them; a failure is logged.
    // Each asks the fleet store whether a session is still there, again just before it removes that session's rows.
    const exists = async (id: string) => (await this.db.getSession(id)) !== undefined;
    this.activityHistory.dropMissingSessions(exists).catch((err: Error) => {
      this.logger.error('retention.activity_failed', `podium: could not remove the activity history of expired sessions: ${err.message}`, { reason: err.message });
    });
    this.recordings.dropMissingSessions(exists).catch((err: Error) => {
      this.logger.error('retention.recording_failed', `podium: could not remove the recordings of expired sessions: ${err.message}`, { reason: err.message });
    });
    const peers = await this.peers.retain();
    return { ...out, peerMessages: peers.messages, peerRequests: peers.requests };
  }

  close(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.hub.closeAll();
  }
}
