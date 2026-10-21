// Podium reporter: hook wiring only. Every hook observes: it calls next(e) once and returns what that
// resolved to, unchanged; its own work is wrapped so a failure is recorded and never reaches the
// session; and no hook on the tool path awaits the network (reports go out from a timer). The exceptions answer the
// mod's own tools: the messaging tools (#414) wait, at most 8 s, for a call the flush timer makes for them.
//
// The engine reads this file's use of `$` statically: `$` is only ever passed to functions declared
// at the top of the file and always spelled `$.noun.event(...)`. So every helper that touches `$` is
// a top-level function taking `$`, and the runtime lives in module variables (a hot reload re-runs
// register, which resets them, and session.start rebuilds the state from the engine).
import { modBuild } from './build.ts';
import type { EngineInterface, Register } from 'claude-code';
import { lastSegment, readChanges, readGit } from './git.ts';
import { readFileDiff } from './fileDiff.ts';
import { follow } from './place.ts';
import { shortName } from './models.ts';
import { buildReport, repoFromRemote } from './report.ts';
import {
  addEvent,
  agentRequested,
  agentSpawned,
  compaction,
  drainEvents,
  measure,
  newSession,
  notification,
  permissionRequest,
  PLAN_TOOL,
  reconcile,
  resetForNewId,
  describeBackground,
  setBackground,
  sessionEnd,
  NO_FILES,
  setAttached,
  setFiles,
  setGit,
  setExplanation,
  markTextSent,
  type SentTexts,
  setIdentity,
  addActivity,
  finishActivity,
  isWatched,
  isWatchedOutput,
  setWatched,
  setWatchedOutput,
  skillLoaded,
  step,
  toolResult,
  toolStarted,
  turnComplete,
  turnStart,
  type ListedAgent,
  type SessionState,
} from './state.ts';
import { nextCronAt } from './cron.ts';
import { isDelivery, Transport, type FetchLike } from './transport.ts';
import { activityCall, activityText, explainPrompt } from './failures.ts';
import { activityEntry, finishedCall, type BashResult } from './activityDetail.ts';
import { nameArg, pickIdentity, worthHolding, type Identity } from './identity.ts';
import { hostOf, isMachineId, MACHINE_ID_KEY, machineIdPath, machineInfo, newMachineId, platformRandom, type RandomSource, osFromOsRelease, osFromSwVers, osFromVer, parseMachineIdFile, trimTrailingSlashes } from './machine.ts';
import { MAIN_LOOP, RECORDING_LIMITS, type Ask, type Delivery, type DeliveryResult, type MachineInfo, type PeerDelivery, type PeerRequest, type PeerResult, type RecordingGrant, type RespondInfo, type RespondKind, type RespondLevel } from './protocol.ts';
import { isRecordingGrant } from './transport.ts';
import { limitLine, Recorder, refusedLine, startLine, stoppedLine, unframeSent } from './recording.ts';
import { redactText } from './diffRedact.ts';
import {
  accessAnswer,
  answerPaused,
  appliedLevel,
  deliveredLine,
  errorOf,
  findRequest,
  isAccessAnswer,
  isRequestId,
  listAnswer,
  noticePrompt,
  oneLine,
  openRequestsLine,
  parseAnswer,
  peerPrompt,
  refusalAnswer,
  requestAnsweredLine,
  requestLine,
  requestToast,
  sendAnswer,
  shortId,
  SUBAGENT_ACCESS,
  SUBAGENT_PEERS,
  SUBAGENT_SEND,
  TOOL_DESCRIPTIONS,
} from './peers.ts';
import {
  answeredLine,
  answersMap,
  decisionRecord,
  LINE_MESSAGES_ON,
  LINE_OPEN,
  planApproval,
  planAsk,
  planFeedback,
  planRejection,
  questionAsk,
  respondInfo,
  respondLevel,
  terminalAnswers,
  toolAsk,
  toolDecision,
  toolDenied,
} from './respond.ts';

export const VERSION = '1.2.2';
const GIT_POLL_MS = 10_000;
/** session.end has one ~1.5 s bound for every hook and core together; stay well inside it. */
const END_FLUSH_MS = 1000;
const ERRORS_KEPT = 20;
/** Text read from one watched step before the rest is let through unread: far more than one 300-character entry needs. */
const STEP_TEXT_MAX = 8000;

type Engine = EngineInterface;

interface Options {
  serverUrl: string;
  token: string;
  flushIntervalMs: number;
  heartbeatMs: number;
  sessionName: string;
  userName: string;
  showStatus: boolean;
  explainFailures: boolean;
  fullPrompts: boolean;
  activityFeed: boolean;
  /** A Bash call's output may go out with its entry, for a loop a viewer has the feed open on (#431). Needs `activityFeed`. */
  activityOutput: boolean;
  /** Answer requests for one file's diff (#319). */
  fileDiff: boolean;
  /** What this session accepts from Podium (#206). */
  respond: RespondLevel;
  /** Message the owner's other orchestrators through Podium (#347, #414). */
  peers: boolean;
  /** The owner's consent to a recording of this machine's sessions (#353): off by default, enforced here and never by the server. */
  sessionRecording: boolean;
}

interface HookStat {
  calls: number;
  totalMs: number;
  maxMs: number;
}

interface Runtime {
  state: SessionState;
  transport: Transport;
  timers: { cancel: () => void }[];
  /**
   * Runs a flush PEER_KICK_MS from now on the engine the timers run on (session.start's), so one a tool asks for runs as
   * the timer's does (#414). `first` runs just before it.
   */
  flushSoon: (first: () => void) => { cancel: () => void };
  /** The flush a tool asked for, waiting to run; null when none waits (`kickFlush`). */
  kick: { cancel: () => void } | null;
  storedName: string | null;
  /** Claude Code's own name for a session, from a hook's `session_title`, with the id it was taken under; null until a hook carries one (#322). It counts only while that id is the session being reported, so a /clear or resume never inherits it. The hook's own `session_id` is not used: the reporter keys everything on `$.session.id()`. */
  claudeName: { id: string; name: string } | null;
  engineVersion: string | null;
  hostSurface: string | null;
  /** The commit of a dev build of this mod, found once per load (#400); null for a release or an installed copy. */
  build: string | null;
  flushing: boolean;
  /** A tool's early run is making calls (`flushPeers`); kept apart from `flushing` so a slow report never holds it. */
  peerFlushing: boolean;
  lastStatus: string | null;
  toastedOk: boolean;
  toastedFail: boolean;
  /** Whether the plain-HTTP notice has been toasted in this session (#306). */
  toastedPlain: boolean;
  /** The refusal notice last toasted, so a later refusal is news again once a report has gone through. */
  toastedRefusal: string | null;
  /** The version notice last toasted, so each distinct one shows once. */
  toastedVersion: string | null;
  /** Skill tool calls in flight: a skill.prompt during one belongs to that call's loop. */
  skillCalls: number;
  /** This machine, read only when a userName is set; null otherwise, so nothing identifying is sent. */
  machine: MachineInfo | null;
  /** The session this one continues after a /clear (#206); sent with every report under the new id. */
  clearedFrom: string | null;
  /** Whether a person's client is on this session: false for a `claude -p` run, which never responds. */
  interactive: boolean;
  /** What `$.session.cwd()` last answered, so a move it reports is told apart from an answer that stayed put while the hooks carry the new folder (#382). */
  sessionCwd: string | null;
}

export function readOptions(o: Record<string, unknown>): Options {
  const s = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  const n = (v: unknown, d: number, min: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : d);
  return {
    serverUrl: s(o.serverUrl, 'http://127.0.0.1:4317') || 'http://127.0.0.1:4317',
    token: s(o.token, ''),
    flushIntervalMs: n(o.flushIntervalMs, 1000, 200),
    heartbeatMs: n(o.heartbeatMs, 5000, 1000),
    sessionName: s(o.sessionName, ''),
    userName: s(o.userName, ''),
    showStatus: typeof o.showStatus === 'boolean' ? o.showStatus : true,
    explainFailures: o.explainFailures === true,
    fullPrompts: o.fullPrompts === true,
    activityFeed: o.activityFeed === true,
    activityOutput: o.activityOutput === true,
    fileDiff: o.fileDiff === true,
    respond: respondLevel(o.respond),
    peers: o.peers === true,
    sessionRecording: o.sessionRecording === true,
  };
}

// ---- module state (reset by register) -----------------------------------------------------------

let opts: Options = readOptions({});
/** The name and token this session reports as: taken once at session.start and held (#226), never read live from the options. */
let who: Identity = { userName: '', token: '' };
const IDENTITY = { plugin: 'podium-reporter', key: 'identity' } as const;
let rt: Runtime | null = null;
/** Bumped by each register (a reload, or a new test): a wait for an answer started under an older one stops. */
let generation = 0;
let errors: { at: number; where: string; message: string }[] = [];
let stats: Record<string, HookStat> = {};
/** Agents whose failure was sent for an explanation: at most one call per failure, never retried. */
let explained = new Set<string>();

// ---- responding (#206, SPEC 5.3) --------------------------------------------------------------

/** One ask open in this session, and what each of its hooks knows about it. */
interface OpenAsk {
  ask: Ask;
  sessionId: string;
  /** The questions as Claude asked them, unredacted: Podium's answers by position are turned back into these. */
  questions?: { question: string; options: { label: string }[] }[];
  /** The race is over (answered, closed, or the tool call ended): every loop on it stops. */
  done: boolean;
  announced: boolean;
  /** A plan: the approval handed to the PermissionRequest hook, and whoever waits for it. */
  approval: Delivery | null;
  approvalWaiters: ((d: Delivery | null) => void)[];
  /** The approval was reported not taken: whatever the terminal does next is the terminal's. */
  notTaken: boolean;
  /** A tool: the answer the PermissionRequest hook returned. */
  answered: Delivery | null;
  /** When the PermissionRequest hook returned that answer (the recording keeps the moment it was decided). */
  answeredAt: number;
  /**
   * Something still waits on the server for this ask's answer. Once the wait gives up (responding turned off, the ask
   * closed there) the ask stops riding in reports, so the server never learns it again and takes an answer nobody collects.
   */
  listening: boolean;
}

/** A close or a result for the server, sent from the flush timer (Esc aborts a hook's own fetches). */
interface OutItem {
  path: string;
  body: Record<string, unknown>;
}

const OUTBOX_MAX = 50;
const ACTED_KEPT = 100;
const ACTED_KEY = 'respond:acted';
const HOLD_SECONDS = 20;
/** How long an approval has to take before it is reported not taken. */
const APPROVAL_CONFIRM_MS = 5000;
/** How long after tool.check says `ask` a PermissionRequest must fire before the hooks are taken as not running. */
const PERMISSION_CHECK_MS = 2000;

let asks = new Map<string, OpenAsk>();
let outbox: OutItem[] = [];
let acted: string[] = [];
/** Requests for a file's diff already answered (#319), so one listed in two replies is read once. */
const DIFFS_KEPT = 50;
let diffsDone: string[] = [];
/** null until known; false once a prompt showed with no PermissionRequest; true once one fired. */
let permissionHooks: boolean | null = null;
let lastPermissionAt = 0;
let checks = new Map<string, { cancel: () => void }>();
/** Each loop's latest tool call, so a PermissionRequest (which has no tool_use_id) can be paired with it. */
let lastCalls = new Map<string, { tool: string; input: string; id: string }>();
/** The `seq` a recorded tool call got, by its tool_use_id, so an answer or approval from Podium points at its call (#353). Dropped when the call ends. */
let callSeqs = new Map<string, number>();
/** A /clear or /compact sent from Podium and running now: the first mark of that kind is Podium's, and only while the command runs (#353). */
let ranFromPodium: { command: 'clear' | 'compact'; by: string } | null = null;
let messagesLineShown = false;
const EXPLAIN_MODEL = 'haiku';

// ---- orchestrator messaging (#347, #414, SPEC 5.3) ---------------------------------------------
// Kept apart from responding: a peer message only ever becomes a framed `$.prompt.submit`, through its own functions
// below. It never reaches an ask's race, a plan's approval, a tool's decision or `$.command.run`.

/** A call a messaging tool waits on, made by the flush timer (Esc aborts a hook's own fetches). */
interface PeerCall {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** The timer has started the request: the hook can no longer take it back. */
  sent: boolean;
  /** The hook stopped waiting: whatever comes back is nobody's. */
  abandoned: boolean;
  resolve: (res: { status: number; text: string } | null) => void;
}

/** How long a messaging tool waits for the flush timer's answer: inside a hook's 10-second budget, which a plain wait spends. */
const PEER_CALL_WAIT_MS = 8000;
/** How soon after a tool queues a call the flush timer runs for it: at once, but from a timer (`kickFlush`). */
const PEER_KICK_MS = 50;
/** Requests remembered for `/podium allow|decline|deliver`, after they leave the reply too, so a late answer hears how it closed. */
const PEER_REQUESTS_KEPT = 50;

let peerCalls: PeerCall[] = [];
/** The three tools were registered in this load: once the reply first says the session takes part. */
let peerToolsRegistered = false;
/** Requests seen in this load, by id, oldest first: each is toasted once. */
let peerKnown = new Map<string, PeerRequest>();
/** The ids the last reply listed as open. */
let peerOpen: string[] = [];

const perf = typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();
const nowMs = () => Date.now();

/** Read-only view of the runtime, for tests and /podium. */
export function runtimeInfo(): { sessionId: string | null; errors: readonly { where: string; message: string }[]; stats: Readonly<Record<string, HookStat>> } {
  return { sessionId: rt?.state.id ?? null, errors, stats };
}

function remember(where: string, err: unknown): string {
  const message = String((err as Error)?.message ?? err).slice(0, 200);
  errors.push({ at: nowMs(), where, message });
  if (errors.length > ERRORS_KEPT) errors.shift();
  return message;
}

function record($: Engine, where: string, err: unknown): void {
  const message = remember(where, err);
  try {
    $.ui.log(`podium-reporter: ${where}: ${message}`, { to: 'debug' });
  } catch {
    // logging is best effort
  }
}

/** Runs reporter logic for a hook: any throw is remembered, never raised. Timed for /podium. */
function safe(where: string, fn: (r: Runtime) => void): void {
  const t0 = perf();
  try {
    if (rt) fn(rt);
  } catch (err) {
    remember(where, err);
  } finally {
    const ms = perf() - t0;
    const st = (stats[where] ??= { calls: 0, totalMs: 0, maxMs: 0 });
    st.calls++;
    st.totalMs += ms;
    st.maxMs = Math.max(st.maxMs, ms);
  }
}

/**
 * What the session says about responding in its reports. Sent with level `off` too: only a reporter older than 0.14.0
 * leaves it out, which Podium reads as "Reporter can't answer" (SPEC 6.2), so off has to say so.
 */
function respondNow(r: Runtime): RespondInfo {
  return respondInfo(opts.respond, opts.activityFeed, r.interactive, permissionHooks);
}

/** Whether the mod answers anything from Podium now: its own switches, and the server's last word. */
function responding(r: Runtime | null, kind: RespondKind): boolean {
  return !!r && r.transport.respond && !r.state.ended && respondNow(r).accepts.includes(kind);
}

/** Whether this session's orchestrator may say it takes part in messaging: the option on, and a person on the session. */
function peersWanted(r: Runtime): boolean {
  return opts.peers && r.interactive;
}

/** Whether the mod takes part now (SPEC 5.3 "When the mod takes part"): its own switches, and the server's last word. */
function peersOn(r: Runtime | null): r is Runtime {
  return !!r && peersWanted(r) && r.transport.peers && !r.state.ended;
}

function openAsks(r: Runtime): Ask[] {
  return [...asks.values()].filter((a) => !a.done && a.listening && a.sessionId === r.state.id).map((a) => a.ask);
}

/** Keep the name Claude Code gives the session, under the id being reported. A hook with no title leaves the last one alone. */
function takeClaudeName(r: Runtime, hook: { session_title?: string }): void {
  const name = typeof hook.session_title === 'string' ? hook.session_title.trim().slice(0, 80) : '';
  const id = r.state.id;
  if (!name || (r.claudeName?.id === id && r.claudeName.name === name)) return;
  r.claudeName = { id, name };
  r.state = { ...r.state, dirty: true };
}

function metaOf(r: Runtime, now: number) {
  return {
    version: VERSION,
    engineVersion: r.engineVersion,
    hostSurface: r.hostSurface,
    build: r.build,
    now,
    storedName: r.storedName,
    claudeName: r.claudeName?.id === r.state.id ? r.claudeName.name : null,
    optionName: opts.sessionName || null,
    userName: who.userName || null,
    machine: r.machine,
    fullText: opts.fullPrompts,
    activity: opts.activityFeed,
    activityOutput: opts.activityOutput,
    fileDiff: opts.fileDiff,
    sessionRecording: opts.sessionRecording,
    respond: respondNow(r),
    asks: r.transport.respond && opts.respond !== 'off' ? openAsks(r) : null,
    clearedFrom: r.clearedFrom,
    peers: peersWanted(r),
  };
}

/** A version with `· Dev: <commit>` after it for a dev build (#400). */
function devNote(version: string, build: string | null | undefined): string {
  return build ? `${version} · Dev: ${build}` : version;
}

function showStatus($: Engine, r: Runtime): void {
  if (!opts.showStatus) return;
  const text = r.transport.statusText();
  if (text === r.lastStatus) return;
  r.lastStatus = text;
  try {
    $.ui.status(text);
  } catch {
    // no status line on this host
  }
}

function toastOnce($: Engine, r: Runtime, ok: boolean): void {
  try {
    if (ok && !r.toastedOk) {
      r.toastedOk = true;
      $.ui.toast(`Podium: reporting to ${opts.serverUrl}`);
    } else if (!ok && !r.toastedFail) {
      r.toastedFail = true;
      $.ui.toast(`Podium: cannot reach ${opts.serverUrl}; will keep retrying`);
    }
  } catch {
    // no toasts on this host
  }
}

function toastRefusalOnce($: Engine, r: Runtime): void {
  const notice = r.transport.refusalNotice() ?? r.transport.ownerNotice();
  if (!notice || notice === r.toastedRefusal) return;
  r.toastedRefusal = notice;
  try {
    $.ui.toast(`Podium: ${notice}`);
  } catch {
    // no toasts on this host
  }
}

function toastPlainHttpOnce($: Engine, r: Runtime): void {
  const notice = r.transport.plainHttpNotice();
  if (!notice || r.toastedPlain) return;
  r.toastedPlain = true;
  try {
    $.ui.toast(`Podium: ${notice}`);
  } catch {
    // no toasts on this host
  }
}

function toastVersionOnce($: Engine, r: Runtime): void {
  const notice = r.transport.versionNotice();
  if (!notice) {
    r.toastedVersion = null; // matched again: a later mismatch is news again
    return;
  }
  if (notice === r.toastedVersion) return;
  r.toastedVersion = notice;
  try {
    $.ui.toast(`Podium: ${notice}`);
  } catch {
    // no toasts on this host
  }
}

/** Moves queued events to the transport and posts one report if one is due (or `force`). */
async function flushOnce($: Engine, r: Runtime, now: number, force: boolean): Promise<void> {
  const [st, events] = drainEvents(r.state);
  r.state = st;
  r.transport.enqueue(events);
  if (!force && !r.transport.due(now, r.state.dirty)) return;
  const snapshot = r.state;
  r.state = { ...r.state, dirty: false };
  let sentTexts: SentTexts = {};
  const outcome = await r.transport.send((evs) => {
    const report = buildReport(snapshot, evs, metaOf(r, now));
    sentTexts = Object.fromEntries(report.agents.map((a) => [a.id, { promptText: a.promptText, answerText: a.answerText }]));
    return report;
  }, now);
  if (outcome === 'failed') {
    r.state = { ...r.state, dirty: true };
    toastOnce($, r, false);
  } else if (outcome === 'refused') {
    r.state = { ...r.state, dirty: true };
    toastRefusalOnce($, r);
  } else if (outcome === 'rejected') {
    toastRefusalOnce($, r); // a 409 (this session belongs to someone else) is told once; any other rejection has no notice (#209)
  } else if (outcome === 'ok') {
    if (opts.fullPrompts) r.state = markTextSent(r.state, sentTexts);
    // The reply names the loops someone is watching; with the option off nothing is ever watched (#118).
    r.state = setWatched(r.state, opts.activityFeed ? r.transport.watch : []);
    // A loop a viewer has the feed open on gets its Bash output read, with both options on (#431). Never a loop that is only in the history's list.
    r.state = setWatchedOutput(r.state, opts.activityFeed && opts.activityOutput ? r.transport.watchOutput.filter((id) => r.state.watched.includes(id)) : []);
    r.toastedRefusal = null; // accepted again: a later refusal is news again
    toastOnce($, r, true);
    handleDeliveries($, r);
    handleDiffs($, r);
    handlePeers($, r);
    messagesLine($, r);
    takeRecording($, r.transport.recording);
  }
  else if (outcome === 'busy') r.state = { ...r.state, dirty: true };
  toastVersionOnce($, r);
  toastPlainHttpOnce($, r);
  showStatus($, r);
}

async function readUsage($: Engine, r: Runtime): Promise<void> {
  try {
    const u = await $.session.usage();
    r.state = measure(r.state, { context: u.context, cost: u.cost ?? null, rateLimits: u.rateLimits, startedAt: u.startedAt });
  } catch (err) {
    record($, 'session.usage', err);
  }
}

/** The roster of attached clients. An empty one is a background session with nobody on it; a failed read says nothing. */
async function readSurfaces($: Engine, r: Runtime): Promise<void> {
  try {
    const clients = await $.session.surfaces();
    r.state = setAttached(r.state, clients.length > 0);
  } catch (err) {
    record($, 'session.surfaces', err);
  }
}

async function readAgents($: Engine, r: Runtime, now: number): Promise<void> {
  try {
    const list = (await $.agent.list()) as ListedAgent[];
    r.state = reconcile(r.state, list, now);
  } catch (err) {
    record($, 'agent.list', err);
  }
}

/** Take the folder the session has moved to (#382; place.ts decides). Returns whether the place changed. */
async function movePlace($: Engine, r: Runtime, hookCwd?: string): Promise<boolean> {
  const m = await follow($, { sessionCwd: r.sessionCwd, cwd: r.state.cwd, projectRoot: r.state.projectRoot }, hookCwd);
  r.sessionCwd = m.sessionCwd;
  if (m.place) r.state = setIdentity(r.state, m.place);
  return !!m.place;
}

/** The commit this mod runs from when that is a dev checkout (#400); null for a release or an installed copy. */
async function findBuild($: Engine): Promise<string | null> {
  const root = await attempt<string | null>(() => Promise.resolve($.plugin.root), null);
  if (!root) return null;
  return modBuild(async (argv) => {
    const res = await $.process.run(argv, { timeoutMs: 5000 });
    return { exitCode: res.exitCode, stdout: res.stdout };
  }, root);
}

async function pollGit($: Engine, r: Runtime): Promise<void> {
  try {
    await movePlace($, r);
    const cwd = r.state.cwd;
    const run = async (argv: string[]) => {
      const res = await $.process.run(argv, { cwd, timeoutMs: 5000 });
      return { exitCode: res.exitCode, stdout: res.stdout };
    };
    const git = await readGit(run, cwd);
    r.state = setGit(r.state, git);
    const id = r.state.id;
    let base = r.state.gitBase ?? (await loadBase($, id));
    // Tried even when readGit gave null: a repository with no commits yet fails that (no HEAD) but has files to list.
    const changes = await readChanges(run, cwd, base);
    if (!changes) {
      if (!git) r.state = setFiles(r.state, NO_FILES, r.state.gitBase);
      return;
    }
    if (r.state.id !== id) return;
    if (changes.base !== base) await attempt(() => $.store.set(`base:${id}`, changes.base), undefined);
    base = changes.base;
    r.state = setFiles(r.state, changes.files, base);
  } catch (err) {
    record($, 'git', err);
  }
}

/** The starting commit saved by an earlier run of this session (a hot reload keeps the process, a restart does not). */
async function loadBase($: Engine, id: string): Promise<string | null> {
  try {
    const v = await $.store.get(`base:${id}`);
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

async function loadName($: Engine, id: string): Promise<string | null> {
  try {
    const v = await $.store.get(`name:${id}`);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** A /clear happened: the old id gets its final report, then reporting starts under the new id. */
async function switchSession($: Engine, r: Runtime, newId: string, now: number): Promise<void> {
  const oldId = r.state.id;
  const cleared = !r.state.ended || r.state.endReason === 'clear';
  for (const a of asks.values()) if (a.sessionId === oldId) a.done = true;
  if (!r.state.ended) {
    recorder.clear(MAIN_LOOP, nowMs(), takePodiumCommand('clear'));
    r.state = sessionEnd(r.state, 'clear', r.state.id, now);
    await r.transport.idle();
    await flushOnce($, r, now, true);
  }
  // What the old id recorded goes under the old id, then the new one starts over: it is recorded only if its own replies say so.
  recorder.close();
  await sendRecording($, now);
  recorder.begin(newId);
  r.transport.queue = [];
  let startedAt = now;
  try {
    startedAt = (await $.session.usage()).startedAt || now;
  } catch {
    // keep now
  }
  const effort = r.state.main.effort;
  r.state = addEvent(resetForNewId(r.state, newId, startedAt), 'start', null, `session.start · ${shortName(r.state.main.model)}${effort ? ` ${effort}` : ''}`, now);
  r.storedName = await loadName($, newId);
  r.clearedFrom = cleared ? oldId : null;
  messagesLineShown = false;
}

/**
 * The flush timer: notice a session id change, refresh usage and agents, post a report if due. `peersOnly` is the early
 * run a tool asks for (`kickFlush`): it makes the tools' calls and nothing else, so the report keeps its interval.
 */
async function flush($: Engine, peersOnly = false): Promise<void> {
  const r = rt;
  if (!r) return;
  if (peersOnly) return flushPeers($, r);
  if (r.flushing) return;
  r.flushing = true;
  let now: number | null = null;
  try {
    // Scheduling (heartbeat, backoff) runs on the engine's clock; hooks stamp events with Date.now().
    now = await engineNow($);
    let id: string | null = null;
    try {
      id = await $.session.id();
    } catch (err) {
      record($, 'session.id', err);
    }
    if (id && id !== r.state.id) await switchSession($, r, id, now);
    // A tool's call first: it waits seconds at most, and the outbox can hold 50 results after an outage (#414).
    await sendPeerCalls($, r, now);
    await sendOutbox($, r, now);
    if (r.state.ended) return;
    await readUsage($, r);
    await readSurfaces($, r);
    await readAgents($, r, now);
    if (opts.explainFailures) requestExplanations($, r);
    await flushOnce($, r, now, false);
    await sendRecording($, now);
  } catch (err) {
    record($, 'flush', err);
  } finally {
    r.flushing = false;
    // A tool queued a call after this flush made its calls: flush again soon rather than at the next tick.
    if (now !== null && !peerCallsHeld(r, now) && peerCalls.some((c) => !c.abandoned)) kickFlush(r);
  }
}

/**
 * A tool's early run: only the tools' calls, under its own guard, so it goes while a regular flush is still reading
 * usage or posting a slow report, which can take longer than the tool's wait. Both drain the same queue, one call at a
 * time each, and both hold back while the report backs off.
 */
async function flushPeers($: Engine, r: Runtime): Promise<void> {
  if (r.peerFlushing) return;
  r.peerFlushing = true;
  let now: number | null = null;
  try {
    now = await engineNow($);
    await sendPeerCalls($, r, now);
  } catch (err) {
    record($, 'flush', err);
  } finally {
    r.peerFlushing = false;
    if (now !== null && !peerCallsHeld(r, now) && peerCalls.some((c) => !c.abandoned)) kickFlush(r);
  }
}

/** The engine's time; Date.now() where the host has no clock noun. */
async function engineNow($: Engine): Promise<number> {
  try {
    return await $.clock.now();
  } catch {
    return nowMs();
  }
}

/** T5.2, off by default: one small-model explanation per new failure, from the redacted record only. */
function requestExplanations($: Engine, r: Runtime): void {
  for (const id of r.state.order) {
    const a = r.state.agents[id];
    // Keyed by the failure itself (its time), not just the agent: a retried agent that fails again is a new failure.
    const key = a?.failure ? `${r.state.id}:${id}:${a.failure.at}` : '';
    if (!a?.failure || a.failure.explanation || explained.has(key)) continue;
    explained.add(key);
    void explain($, r.state.id, id, explainPrompt(a.failure));
  }
}

async function explain($: Engine, sessionId: string, agentId: string, prompt: string): Promise<void> {
  try {
    const res = await $.model.complete({ model: EXPLAIN_MODEL, effort: 'low', prompt, maxTokens: 200, timeoutMs: 30_000 });
    if (!res.isAnswered || !rt || rt.state.id !== sessionId) return;
    rt.state = setExplanation(rt.state, agentId, res.text, res.usage, EXPLAIN_MODEL);
  } catch (err) {
    record($, 'model.complete', err);
  }
}

/** A random number in [0, 1): the platform's generator where the sandbox has one. */
function random(): number {
  return platformRandom((globalThis as { crypto?: RandomSource }).crypto);
}

/**
 * The machine's id, one for every load of the mod on it (#267). The shared file under the Claude config
 * directory decides; without a valid one, the id this load's store already holds is kept (so an install
 * keeps its row) and shared, else a new one is made and shared. The file is read back after a write. Two loads
 * that start in the same instant can still each keep the id they wrote for that session (the last write is
 * the file's), and agree from their next session on. Where the file cannot be used, the store alone
 * keeps the id, as before.
 */
async function machineId($: Engine): Promise<string> {
  const path = machineIdPath(
    await attempt(() => $.env.get('CLAUDE_CONFIG_DIR'), undefined),
    await attempt(() => $.env.get('HOME'), undefined),
  );
  const shared = async () => (path ? parseMachineIdFile(await attempt(async () => (await $.fs.read(path)) as string, null)) : null);
  const fromFile = await shared();
  const kept = await attempt(() => $.store.get(MACHINE_ID_KEY), undefined);
  if (fromFile) {
    // Keep this load's store in step, so the id survives the shared file being deleted.
    if (fromFile !== kept) await attempt(() => $.store.set(MACHINE_ID_KEY, fromFile), undefined);
    return fromFile;
  }
  const id = isMachineId(kept) ? kept : newMachineId(random);
  if (id !== kept) await attempt(() => $.store.set(MACHINE_ID_KEY, id), undefined);
  if (!path) return id;
  await attempt(() => $.fs.write(path, `${id}\n`), undefined);
  return (await shared()) ?? id;
}

/**
 * This machine's short host name and the random id the mod keeps for it in its own store (made on first
 * use). Read only when a userName is set: an unnamed reporter sends nothing that identifies the machine.
 */
async function readMachine($: Engine): Promise<MachineInfo | null> {
  if (!who.userName.trim()) return null;
  try {
    const id = await machineId($);
    // The host name and the OS at once: session.start waits on both, and each can take a process's timeout.
    const [host, os] = await Promise.all([
      attempt(async () => {
        const res = await $.process.run(['hostname'], { timeoutMs: 2000 });
        return res.exitCode === 0 ? hostOf(res.stdout) : null;
      }, null),
      readOs($),
    ]);
    return machineInfo(host, id, os);
  } catch (err) {
    record($, 'machine', err);
    return null;
  }
}

/**
 * The machine's OS and version (#414, SPEC 5.3 "The OS"): the first of `sw_vers` (macOS), `/etc/os-release` (Linux)
 * and `cmd /c ver` (Windows) that works. A missing executable rejects, so each is tried in turn. Null when none does.
 */
async function readOs($: Engine): Promise<string | null> {
  const run = async (argv: string[]) => {
    const res = await $.process.run(argv, { timeoutMs: 2000 });
    return res.exitCode === 0 ? res.stdout : null;
  };
  return (
    (await attempt(async () => osFromSwVers(await run(['sw_vers'])), null)) ??
    (await attempt(async () => osFromOsRelease((await $.fs.read('/etc/os-release')) as string), null)) ??
    (await attempt(async () => osFromVer(await run(['cmd', '/c', 'ver'])), null))
  );
}

async function attempt<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

// ---- responding: talking to the server (#206) -------------------------------------------------

function serverBase(): string {
  return trimTrailingSlashes(opts.serverUrl);
}

function sessionPath(sessionId: string): string {
  return `/api/fleet/sessions/${encodeURIComponent(sessionId)}`;
}

/** One request to the server with the reporter's token; null when it could not be made (offline, or aborted by Esc). */
async function podiumCall($: Engine, method: string, path: string, body?: unknown): Promise<{ status: number; text: string } | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (who.token) headers['X-Podium-Token'] = who.token;
  try {
    const res = await $.http.fetch(serverBase() + path, body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) });
    return { status: res.status, text: res.text };
  } catch {
    return null;
  }
}

/** A line in the transcript; the engine draws it as `podium-reporter: <text>`. */
function transcriptLine($: Engine, text: string): void {
  try {
    $.ui.log(text);
  } catch {
    // no transcript on this host
  }
}

function queueOut(item: OutItem): void {
  outbox.push(item);
  if (outbox.length > OUTBOX_MAX) outbox.splice(0, outbox.length - OUTBOX_MAX);
}

function queueResult(sessionId: string, deliveryId: string, result: DeliveryResult): void {
  queueOut({ path: `${sessionPath(sessionId)}/deliveries/${encodeURIComponent(deliveryId)}/result`, body: { result, at: nowMs() } });
}

function queueClose(a: OpenAsk, outcome: 'terminal' | 'closed' | 'ended', extra: { answer?: string | null; planApproved?: boolean } = {}): void {
  queueOut({ path: `${sessionPath(a.sessionId)}/asks/${encodeURIComponent(a.ask.id)}/close`, body: { outcome, at: nowMs(), ...extra } });
}

/**
 * The flush timer sends what the hooks queued. A failure keeps the rest for the next tick; a refusal drops the item.
 * A call a tool queued meanwhile goes between items, ahead of the rest (#414).
 */
async function sendOutbox($: Engine, r: Runtime, now: number): Promise<void> {
  while (outbox.length) {
    const item = outbox[0]!;
    const res = await podiumCall($, 'POST', item.path, item.body);
    if (!res) return;
    outbox.shift();
    await sendPeerCalls($, r, now);
  }
}

async function loadActed($: Engine): Promise<string[]> {
  const v = await attempt(() => $.store.get(ACTED_KEY), undefined);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-ACTED_KEPT) : [];
}

/** Notes a delivery as acted on, here and in the store, so one handed over twice (a lost reply, a reload) acts once. */
function markActed($: Engine, id: string): boolean {
  if (acted.includes(id)) return false;
  acted.push(id);
  if (acted.length > ACTED_KEPT) acted.splice(0, acted.length - ACTED_KEPT);
  void attempt(() => $.store.set(ACTED_KEY, acted), undefined);
  return true;
}

/** Announces an ask (PUT). The first time it lands, the terminal says it is also open in Podium. */
async function announce($: Engine, a: OpenAsk): Promise<number> {
  const res = await podiumCall($, 'PUT', `${sessionPath(a.sessionId)}/asks/${encodeURIComponent(a.ask.id)}`, a.ask);
  if (res?.status === 200 && !a.announced) {
    a.announced = true;
    transcriptLine($, LINE_OPEN);
  }
  return res?.status ?? 0;
}

function openAsk(r: Runtime, ask: Ask, questions?: OpenAsk['questions']): OpenAsk {
  const a: OpenAsk = { ask, sessionId: r.state.id, questions, done: false, announced: false, approval: null, approvalWaiters: [], notTaken: false, answered: null, answeredAt: 0, listening: true };
  asks.set(ask.id, a);
  r.state = { ...r.state, dirty: true };
  return a;
}

function finish(a: OpenAsk): void {
  a.done = true;
  for (const w of a.approvalWaiters.splice(0)) w(null);
  asks.delete(a.ask.id);
  if (rt) rt.state = { ...rt.state, dirty: true };
}

/**
 * Waits on the server for the next answer to an ask that `wanted` takes, until one comes, the ask is done, or the server
 * stops taking answers. An answer of another kind is refused (or, for a plan, handed to `other`); one that `skip` names
 * is left alone for another wait on the same ask to act on.
 */
async function waitForAnswer($: Engine, a: OpenAsk, wanted: (d: Delivery) => boolean, other?: (d: Delivery) => void, skip?: (d: Delivery) => boolean): Promise<Delivery | null> {
  const d = await pollAnswer($, a, wanted, other, skip);
  if (!d && !a.done) {
    a.listening = false;
    if (rt) rt.state = { ...rt.state, dirty: true };
  }
  return d;
}

/**
 * Waits `ms` on the engine's clock. False when the sleep fails: its dispatch was aborted or let go, so the engine
 * behind this wait is gone, and a loop that went round again would never wait at all.
 */
async function pause($: Engine, ms: number): Promise<boolean> {
  try {
    await $.clock.sleep(ms);
    return true;
  } catch {
    return false;
  }
}

async function pollAnswer($: Engine, a: OpenAsk, wanted: (d: Delivery) => boolean, other?: (d: Delivery) => void, skip?: (d: Delivery) => boolean): Promise<Delivery | null> {
  // `rt` is module state, so a wait from an older register would otherwise read a newer session's switches.
  const gen = generation;
  while (!a.done && gen === generation && rt?.transport.respond) {
    const res = await podiumCall($, 'GET', `${sessionPath(a.sessionId)}/asks/${encodeURIComponent(a.ask.id)}/answer?wait=${HOLD_SECONDS}`);
    if (a.done) {
      const d = deliveryOf(res);
      if (d && markActed($, d.id)) queueResult(a.sessionId, d.id, 'closed');
      return null;
    }
    if (!res) {
      if (!(await pause($, Transport.backoff(1)))) return null;
      continue;
    }
    if (res.status === 204) continue;
    if (res.status === 404) {
      if ((await announce($, a)) !== 200 && !(await pause($, Transport.backoff(2)))) return null;
      continue;
    }
    const d = deliveryOf(res);
    if (!d) return null;
    if (d.askId === a.ask.id && skip?.(d)) {
      // Another wait on this ask acts on it (a plan's feedback is the tool.call hook's); ask again once it has.
      if (!(await pause($, 500))) return null;
      continue;
    }
    if (!markActed($, d.id)) {
      // Already acted on and waiting for its result to reach the server: ask again shortly.
      if (!(await pause($, 1000))) return null;
      continue;
    }
    if (d.askId === a.ask.id && wanted(d)) return d;
    if (d.askId === a.ask.id && other) {
      other(d);
      continue;
    }
    queueResult(a.sessionId, d.id, 'refused');
  }
  return null;
}

function deliveryOf(res: { status: number; text: string } | null): Delivery | null {
  if (!res || res.status !== 200) return null;
  try {
    const d = (JSON.parse(res.text) as { delivery?: unknown }).delivery;
    return isDelivery(d) ? d : null;
  } catch {
    return null;
  }
}

// ---- responding: the hooks' races --------------------------------------------------------------

type ToolResult = { result?: unknown; text?: string; isError?: boolean; deny?: string };
type Race = { res: ToolResult; d: null } | { res: null; d: Delivery };

/** Whichever comes first: the terminal's answer, or one from Podium. A Podium wait that ends empty leaves the terminal. */
function race(terminal: Promise<ToolResult>, podium: Promise<Delivery | null>): Promise<Race> {
  const t: Promise<Race> = terminal.then((res) => ({ res, d: null }));
  const p: Promise<Race> = podium.then((d) => (d ? { res: null, d } : t));
  return Promise.race([t, p]);
}

/** AskUserQuestion: the terminal's dialog (`next(e)`) against an answer from Podium. The first wins. */
async function questionRace($: Engine, r: Runtime, e: { tool_use_id: string; agentId?: string; questions?: unknown }, terminal: Promise<ToolResult>): Promise<ToolResult> {
  const input = e as unknown as Record<string, unknown>;
  const ask = questionAsk(e.tool_use_id, e.agentId ?? null, input, nowMs());
  if (!ask) return terminal;
  const raw = (Array.isArray(e.questions) ? e.questions : []) as OpenAsk['questions'];
  const a = openAsk(r, ask, raw);
  await announce($, a);
  const podium = waitForAnswer($, a, (d) => (d.kind === 'question' || d.kind === 'reply') && responding(rt, 'question'));
  const first = await race(terminal, podium);
  if (first.d) {
    const d = first.d;
    finish(a);
    queueResult(a.sessionId, d.id, 'took');
    transcriptLine($, answeredLine(d, nowMs()));
    recordDecision(e.agentId, e.tool_use_id, d, 'question', a.questions);
    const questions = e.questions;
    return d.kind === 'reply' ? { result: { questions, answers: {}, response: d.text ?? '' } } : { result: { questions, answers: answersMap(a.questions ?? [], d.answers ?? []) } };
  }
  const res = first.res as ToolResult;
  finish(a);
  // A rejection is Esc, an aborted turn, or the terminal's own "Chat about this": closed without an answer.
  if (res.isError || res.deny !== undefined) queueClose(a, 'closed');
  else queueClose(a, 'terminal', { answer: terminalAnswers(res) });
  return res;
}

/**
 * ExitPlanMode: one ask, two hooks. Feedback ("No, keep planning", or a message in its place) is answered here as
 * `{ deny }`; an approval is handed to the waiting PermissionRequest hook, and counts only once the call resolves as
 * approved, within APPROVAL_CONFIRM_MS.
 */
async function planRace($: Engine, r: Runtime, e: { tool_use_id: string; agentId?: string }, terminal: Promise<ToolResult>): Promise<ToolResult> {
  const a = openAsk(r, planAsk(e.tool_use_id, e.agentId ?? null, e as unknown as Record<string, unknown>, nowMs()));
  await announce($, a);
  const podium = waitForAnswer($, a, (d) => (d.kind === 'plan-feedback' || d.kind === 'reply') && responding(rt, 'plan-feedback'), (d) => takeApproval($, a, d));
  const first = await race(terminal, podium);
  if (first.d) {
    finish(a);
    queueResult(a.sessionId, first.d.id, 'took');
    transcriptLine($, answeredLine(first.d, nowMs()));
    recordDecision(e.agentId, e.tool_use_id, first.d, 'plan');
    return planFeedback(first.d);
  }
  const res = first.res as ToolResult;
  const approved = !res.isError && res.deny === undefined;
  const approval = a.notTaken ? null : a.approval;
  finish(a);
  if (approval && approved) {
    queueResult(a.sessionId, approval.id, 'took');
    // Only now, once Claude Code took it: the terminal never reads "Approved from Podium" for one that didn't.
    transcriptLine($, answeredLine(approval, nowMs()));
    recordDecision(e.agentId, e.tool_use_id, approval, 'plan');
  } else {
    if (approval) queueResult(a.sessionId, approval.id, 'closed');
    if (approved) queueClose(a, 'terminal', { planApproved: true });
    else if (planRejection(res.text) === 'feedback') queueClose(a, 'terminal', { answer: 'No, keep planning' });
    else queueClose(a, 'closed');
  }
  return res;
}

/** A plan's approval, from either wait on its ask: handed to the PermissionRequest hook, and checked that it took. */
function takeApproval($: Engine, a: OpenAsk, d: Delivery): void {
  if (d.kind !== 'plan-approve' || !responding(rt, 'plan-approve') || a.approval) {
    queueResult(a.sessionId, d.id, 'refused');
    return;
  }
  a.approval = d;
  for (const w of a.approvalWaiters.splice(0)) w(d);
  void confirmApproval($, a, d);
}

/**
 * The PermissionRequest hook's wait for a plan's approval. It polls the server itself, so a held request is in flight
 * the whole time: that stops the hook's 10-second budget (HookBudget), where waiting on a promise alone would not, and
 * an approval sent long after the dialog opened still finds the hook. An approval the tool.call hook's wait got first
 * arrives through `approvalOf`; feedback and replies are left to that wait.
 */
async function approvalFromPodium($: Engine, a: OpenAsk): Promise<Delivery | null> {
  const fromServer = waitForAnswer(
    $,
    a,
    (d) => d.kind === 'plan-approve',
    undefined,
    (d) => d.kind === 'plan-feedback' || d.kind === 'reply',
  ).then((d) => {
    if (d) takeApproval($, a, d);
    return a.approval;
  });
  return Promise.race([approvalOf(a), fromServer]);
}

/** An approval that the plan's tool call has not resolved as approved within the confirm window did not take. */
async function confirmApproval($: Engine, a: OpenAsk, d: Delivery): Promise<void> {
  await attempt(() => $.clock.sleep(APPROVAL_CONFIRM_MS), undefined);
  if (a.done) return;
  a.notTaken = true;
  queueResult(a.sessionId, d.id, 'not-taken');
}

/** The plan ask of a loop, for its PermissionRequest hook. */
function planAskOf(agentId: string | undefined): OpenAsk | undefined {
  return [...asks.values()].reverse().find((a) => !a.done && a.ask.kind === 'plan' && a.ask.agentId === (agentId ?? null));
}

/** Waits for the approval of a plan ask, or null once the ask is done. */
function approvalOf(a: OpenAsk): Promise<Delivery | null> {
  if (a.approval) return Promise.resolve(a.approval);
  if (a.done) return Promise.resolve(null);
  return new Promise((resolve) => a.approvalWaiters.push(resolve));
}

function loopKey(agentId: string | null | undefined): string {
  return agentId ?? '@main';
}

function inputKey(input: unknown): string {
  try {
    return JSON.stringify(input ?? null);
  } catch {
    return '';
  }
}

/** Any PermissionRequest shows the hooks run here: the hooks are no longer taken as missing. */
function permissionSeen(r: Runtime, id: string | null): void {
  lastPermissionAt = nowMs();
  if (id) {
    checks.get(id)?.cancel();
    checks.delete(id);
  }
  if (permissionHooks !== true) {
    permissionHooks = true;
    r.state = { ...r.state, dirty: true };
  }
}

/** tool.check said a prompt is about to show: if no PermissionRequest follows, the hooks don't run here (SPEC 5.3). */
function startPermissionCheck($: Engine, id: string): void {
  const startedAt = nowMs();
  checks.get(id)?.cancel();
  try {
    const h = $.clock.after(PERMISSION_CHECK_MS, () => {
      checks.delete(id);
      if (lastPermissionAt >= startedAt || !rt) return;
      permissionHooks = false;
      rt.state = { ...rt.state, dirty: true };
    });
    checks.set(id, h);
  } catch {
    // no clock: leave it unknown
  }
}

/**
 * A tool's permission prompt: announced under the tool call it pairs with, and answered from Podium if an answer comes
 * while it is up. The engine does not end this hook when the terminal answers first; the tool call ending does
 * (`settleToolAsk`).
 */
async function permissionAsk($: Engine, r: Runtime, e: { tool_name: string; tool_input: unknown; agent_id?: string }): Promise<{ decision: { behavior: 'allow' } | { behavior: 'deny'; message: string } } | null> {
  const call = lastCalls.get(loopKey(e.agent_id));
  if (!call || call.tool !== e.tool_name || call.input !== inputKey(e.tool_input) || asks.has(call.id)) return null;
  const a = openAsk(r, toolAsk(call.id, e.agent_id ?? null, e.tool_name, e.tool_input, nowMs()));
  await announce($, a);
  const d = await waitForAnswer($, a, (x) => (x.kind === 'allow-once' ? !a.ask.tool?.cut : x.kind === 'deny' || x.kind === 'reply') && responding(rt, 'permission'));
  if (!d || a.done) return null;
  a.answered = d;
  a.answeredAt = nowMs();
  transcriptLine($, answeredLine(d, a.answeredAt));
  return toolDecision(d.kind === 'reply' ? { ...d, kind: 'deny' } : d);
}

/**
 * The tool call of a permission ask ended: what happened is read from how it ended, since nothing else says (SPEC 5.3).
 * An answer from Podium that matches what happened took; otherwise the terminal answered first.
 */
function settleToolAsk(id: string, res: ToolResult | undefined): void {
  const a = asks.get(id);
  if (!a || a.ask.kind !== 'permission') return;
  const d = a.answered;
  const sent = d && d.kind !== 'allow-once' ? (toolDecision(d.kind === 'reply' ? { ...d, kind: 'deny' } : d).decision as { message?: string }).message : undefined;
  const denied = toolDenied(res, sent);
  finish(a);
  if (d && (d.kind === 'allow-once') === !denied) {
    queueResult(a.sessionId, d.id, 'took');
    // Only now, once the call ended the way the decision said: a decision the terminal beat is not recorded as Podium's.
    recordDecision(a.ask.agentId, id, d, 'permission', undefined, a.answeredAt);
  } else {
    if (d) queueResult(a.sessionId, d.id, 'closed');
    queueClose(a, 'terminal', { answer: denied ? 'denied' : 'allowed' });
  }
}

// ---- file diff on request (#319) ----------------------------------------------------------------

/** The diffs the reply lists, each read and answered once. With the option off nothing is read and the list is ignored. */
function handleDiffs($: Engine, r: Runtime): void {
  const list = r.transport.diffs;
  r.transport.diffs = [];
  if (!opts.fileDiff) return;
  for (const req of list) {
    if (diffsDone.includes(req.id)) continue;
    diffsDone.push(req.id);
    if (diffsDone.length > DIFFS_KEPT) diffsDone.splice(0, diffsDone.length - DIFFS_KEPT);
    void answerDiff($, r, r.state.id, req);
  }
}

async function answerDiff($: Engine, r: Runtime, sid: string, req: { id: string; path: string }): Promise<void> {
  try {
    const cwd = r.state.cwd;
    const run = async (argv: string[]) => {
      const res = await $.process.run(argv, { cwd, timeoutMs: 15_000 });
      return { exitCode: res.exitCode, stdout: res.stdout };
    };
    const reply = await readFileDiff(run, cwd, r.state.gitBase, req.path, r.state.files);
    if (r.state.id !== sid) return; // the session was cleared while git ran
    await podiumCall($, 'PUT', `${sessionPath(sid)}/diffs/${encodeURIComponent(req.id)}`, reply);
  } catch (err) {
    record($, 'file-diff', err);
  }
}

// ---- responding: messages and commands ---------------------------------------------------------

/** Messages and commands from the reply to a report: each acted on once, within the session's own level. */
function handleDeliveries($: Engine, r: Runtime): void {
  const list = r.transport.deliveries;
  r.transport.deliveries = [];
  for (const d of list) {
    if (!markActed($, d.id)) continue;
    const sid = r.state.id;
    const running = r.state.status === 'running';
    if (d.kind === 'message' && typeof d.text === 'string' && d.text.trim() && responding(r, 'message')) {
      if (running) queueResult(sid, d.id, 'queued');
      void submitMessage($, sid, d);
    } else if (d.kind === 'command' && (d.command === 'clear' || d.command === 'compact') && responding(r, 'command')) {
      if (running) queueResult(sid, d.id, 'queued');
      void runCommand($, sid, d, d.command);
    } else queueResult(sid, d.id, 'refused');
  }
}

/** Texts of messages from Podium this mod submitted, not yet seen back as a turn's text (#353). */
const sentFromPodium: string[] = [];

/** A message from Podium starts a turn of its own once the session is idle, under the plugin's name (not as the person). */
async function submitMessage($: Engine, sid: string, d: Delivery): Promise<void> {
  const text = d.text ?? '';
  // Remembered for the recording: the engine frames this prompt, and the turn that follows is recorded as the text sent (#353).
  sentFromPodium.push(text);
  if (sentFromPodium.length > 20) sentFromPodium.shift();
  try {
    await $.prompt.submit({ text });
    transcriptLine($, answeredLine(d, nowMs()));
    queueResult(sid, d.id, 'took');
  } catch (err) {
    record($, 'prompt.submit', err);
    queueResult(sid, d.id, 'refused');
  }
}

/** /clear or /compact, as if the person typed it, once the session is idle. Never any other command. */
async function runCommand($: Engine, sid: string, d: Delivery, command: 'clear' | 'compact'): Promise<void> {
  // While it runs, the first mark of its kind in a recording is Podium's, with the sender (#353). It ends with the command, so a
  // person's own /clear or /compact afterwards is never marked as Podium's.
  const mine = { command, by: d.by };
  ranFromPodium = mine;
  try {
    await $.command.run({ command });
    transcriptLine($, answeredLine(d, nowMs()));
    queueResult(sid, d.id, 'took');
  } catch (err) {
    record($, 'command.run', err);
    queueResult(sid, d.id, 'refused');
  } finally {
    if (ranFromPodium === mine) ranFromPodium = null;
  }
}

/** "messages from Podium are on." once, the first time the session is idle with messages allowed; again after it stopped, or after a /clear (a new, empty transcript). */
function messagesLine($: Engine, r: Runtime): void {
  const on = responding(r, 'message');
  if (!on) {
    messagesLineShown = false;
    return;
  }
  if (messagesLineShown || !r.state.mainIdle) return;
  messagesLineShown = true;
  transcriptLine($, LINE_MESSAGES_ON);
}

// ---- orchestrator messaging: the reply (#414) ------------------------------------------------------------------

function peerPath(sessionId: string, rest: string): string {
  return `${sessionPath(sessionId)}/peers${rest}`;
}

/** What became of a peer delivery: through the peer route, never responding's, from the same queue of 50. */
function queuePeerResult(sessionId: string, deliveryId: string, result: PeerResult): void {
  queueOut({ path: peerPath(sessionId, `/deliveries/${encodeURIComponent(deliveryId)}/result`), body: { result, at: nowMs() } });
}

/** The reply's messaging fields. Unless the mod takes part, nothing in them is taken, whatever the reply says. */
function handlePeers($: Engine, r: Runtime): void {
  const deliveries = r.transport.peerDeliveries;
  const requests = r.transport.peerRequests;
  r.transport.peerDeliveries = [];
  r.transport.peerRequests = [];
  if (!peersOn(r)) return;
  if (!peerToolsRegistered) {
    peerToolsRegistered = true;
    void registerPeerTools($);
  }
  for (const d of deliveries) peerDelivery($, r, d);
  showRequests($, requests);
}

/** One message or notice, acted on once (responding's dedupe). A message only ever becomes a framed prompt. */
function peerDelivery($: Engine, r: Runtime, d: PeerDelivery): void {
  if (!markActed($, d.id)) return;
  const sid = r.state.id;
  if (d.kind === 'notice') {
    // Podium's own sentence: a log line. The answer to an access request is also a turn, as the tool promised.
    transcriptLine($, oneLine(d.text, 1000));
    queuePeerResult(sid, d.id, 'took');
    if (isAccessAnswer(d.text)) void submitNotice($, d.text);
    return;
  }
  const text = peerPrompt(d);
  if (!text) {
    queuePeerResult(sid, d.id, 'refused');
    return;
  }
  if (r.state.status === 'running') queuePeerResult(sid, d.id, 'queued');
  void submitPeerMessage($, sid, d, text);
}

/** Another orchestrator's message: a turn of its own once the session is idle, under the plugin's name and Podium's frame. Never `asUser`. */
async function submitPeerMessage($: Engine, sid: string, d: PeerDelivery, text: string): Promise<void> {
  try {
    // The resolved value is the record that it entered: the mod's own prompt.submit hook never sees its own call.
    const res = await $.prompt.submit({ text });
    if (!res || (res as { drop?: unknown }).drop !== undefined) throw new Error('the message did not enter');
    if (d.from) transcriptLine($, deliveredLine(d.from));
    queuePeerResult(sid, d.id, 'took');
  } catch (err) {
    record($, 'peers.submit', err);
    queuePeerResult(sid, d.id, 'refused');
  }
}

/** The answer to this orchestrator's access request, as a turn in Podium's own words. */
async function submitNotice($: Engine, text: string): Promise<void> {
  try {
    await $.prompt.submit({ text: noticePrompt(text) });
  } catch (err) {
    record($, 'peers.notice', err);
  }
}

/** The owner's open requests: each new one is a toast and a log line with its short id (the toast alone shows a message's text). */
function showRequests($: Engine, list: PeerRequest[]): void {
  peerOpen = list.map((q) => q.id);
  for (const q of list) {
    const seen = peerKnown.has(q.id);
    peerKnown.delete(q.id);
    peerKnown.set(q.id, q);
    if (seen) continue;
    const s = shortId(q.id);
    try {
      $.ui.toast(requestToast(q, s), { timeoutMs: 30_000 });
    } catch {
      // no toasts on this host
    }
    transcriptLine($, requestLine(q, s));
  }
  for (const id of peerKnown.keys()) {
    if (peerKnown.size <= PEER_REQUESTS_KEPT) break;
    peerKnown.delete(id);
  }
}

/** The three tools, once the reply first says this session takes part (SPEC 5.3): never offered while it does not. */
async function registerPeerTools($: Engine): Promise<void> {
  try {
    await $.tool.register({ name: 'podium_peers', description: TOOL_DESCRIPTIONS.peers, inputSchema: { type: 'object', properties: {} } });
    await $.tool.register({
      name: 'podium_send',
      description: TOOL_DESCRIPTIONS.send,
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string', description: 'The orchestrator, as "name@machine", or "name@machine#id" when podium_peers shows an id' }, text: { type: 'string', description: 'The message' } },
        required: ['to', 'text'],
      },
    });
    await $.tool.register({
      name: 'podium_request_access',
      description: TOOL_DESCRIPTIONS.access,
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'A machine, or "name@machine"' },
          right: { type: 'string', enum: ['see', 'send'], description: 'The right to ask for' },
          reason: { type: 'string', description: 'Why, in a sentence' },
        },
        required: ['to', 'right', 'reason'],
      },
    });
  } catch (err) {
    peerToolsRegistered = false;
    record($, 'tool.register', err);
  }
}

// ---- orchestrator messaging: the tools (#414) ------------------------------------------------------------------

/** Whether the report's backoff holds the tools' calls back: Podium did not answer the last report, and its retry is not due. */
function peerCallsHeld(r: Runtime, now: number): boolean {
  return r.transport.online === false && now < r.transport.nextAttemptAt;
}

/**
 * Has the flush timer run soon for a call a tool queued, not at its next tick, which a long `flushIntervalMs` puts past
 * the tool's wait. The call is still made by a timer, through the flush, with the report's credential and backoff, and
 * never from inside the hook. One kick waits at a time, and its run (`flushPeers`) goes even while a regular flush is
 * running, since that one can spend seconds on usage and a slow report.
 */
function kickFlush(r: Runtime): void {
  if (r.kick) return;
  try {
    r.kick = r.flushSoon(() => {
      r.kick = null;
    });
  } catch {
    // no clock: the next tick makes the call
    r.kick = null;
  }
}

/** The flush timer makes the calls the tools wait on, with the report's credential, held back while the report backs off. */
async function sendPeerCalls($: Engine, r: Runtime, now: number): Promise<void> {
  if (peerCallsHeld(r, now)) return;
  while (peerCalls.length) {
    const call = peerCalls.shift()!;
    if (call.abandoned) continue;
    call.sent = true;
    call.resolve(await podiumCall($, call.method, call.path, call.body));
  }
}

type PeerCallOutcome = { status: number; text: string } | 'unreachable' | 'unanswered';

/**
 * Queues a call for the flush timer and waits for its answer, at most PEER_CALL_WAIT_MS. One the timer never started
 * is taken back (nothing left the machine); one it started and that has not come back is `unanswered`.
 */
async function peerCall($: Engine, method: 'GET' | 'POST', path: string, body?: unknown): Promise<PeerCallOutcome> {
  let resolve: PeerCall['resolve'] = () => {};
  const answered = new Promise<{ status: number; text: string } | null>((res) => (resolve = res));
  const call: PeerCall = { method, path, body, sent: false, abandoned: false, resolve };
  peerCalls.push(call);
  if (rt) kickFlush(rt);
  const timedOut = $.clock.sleep(PEER_CALL_WAIT_MS).then(
    () => 'timeout' as const,
    () => 'timeout' as const,
  );
  const out = await Promise.race([answered, timedOut]);
  if (out === 'timeout') {
    call.abandoned = true;
    peerCalls = peerCalls.filter((c) => c !== call);
    return call.sent ? 'unanswered' : 'unreachable';
  }
  return out ?? 'unreachable';
}

const UNREACHABLE = 'Podium cannot be reached from this machine right now, so nothing left it. Try again in a minute; /podium shows the connection.';
const UNANSWERED = 'Podium did not answer in time. It may still have taken it: podium_peers and Podium > Traffic show what arrived.';

/** The person the tools name: the reporter's user name. */
function ownerName(): string {
  return who.userName.trim() || 'your person';
}

/** The mod's refusal when it does not take part now. */
function notTakingPart(prefix: string): string {
  return refusalAnswer(prefix, opts.peers ? 'orchestrator messaging is not on for this session in Podium right now' : "messaging is off on this machine: turn on podium-reporter's peers option there");
}

/** A tool call that carries an `agentId` comes from a subagent (or one of the engine's own forks): refused, whoever it is. */
function fromSubagent(e: { agentId?: unknown }): boolean {
  return e.agentId !== undefined && e.agentId !== null;
}

/** Answers what came back from a call a tool made, or the refusal in Podium's words. */
function peerOutcome(prefix: string, out: PeerCallOutcome, ok: (body: Record<string, unknown>) => string): string {
  if (out === 'unreachable') return `${prefix} ${UNREACHABLE}`;
  if (out === 'unanswered') return `${prefix} ${UNANSWERED}`;
  if (out.status >= 200 && out.status < 300) {
    try {
      return ok(JSON.parse(out.text) as Record<string, unknown>);
    } catch {
      return `${prefix} Podium's answer could not be read.`;
    }
  }
  return refusalAnswer(prefix, errorOf(out.text) ?? `Podium answered ${out.status}`);
}

async function peersTool($: Engine, e: { agentId?: unknown }): Promise<string> {
  if (fromSubagent(e)) return SUBAGENT_PEERS;
  const r = rt;
  if (!peersOn(r)) return notTakingPart('Not listed.');
  const out = await peerCall($, 'GET', peerPath(r.state.id, ''));
  return peerOutcome('Not listed.', out, (body) => listAnswer(body, ownerName()));
}

async function sendTool($: Engine, e: { agentId?: unknown; to?: unknown; text?: unknown }): Promise<string> {
  if (fromSubagent(e)) return SUBAGENT_SEND;
  const r = rt;
  if (!peersOn(r)) return notTakingPart('Not sent.');
  const to = typeof e.to === 'string' ? e.to.trim() : '';
  const raw = typeof e.text === 'string' ? e.text : '';
  if (!to) return 'Not sent. Say who it is for: to is "name@machine", as podium_peers lists it.';
  if (!raw.trim()) return 'Not sent. The message is empty. Write the text to send.';
  // Secrets go before the text leaves the machine, with the same redactor as a file's diff (SPEC 6.4).
  const red = redactText(raw);
  const out = await peerCall($, 'POST', peerPath(r.state.id, '/messages'), { to, text: red.text });
  return peerOutcome('Not sent.', out, (body) => sendAnswer(body, { owner: ownerName(), here: r.machine?.name ?? null, to, redactions: red.redactions }));
}

async function accessTool($: Engine, e: { agentId?: unknown; to?: unknown; right?: unknown; reason?: unknown }): Promise<string> {
  if (fromSubagent(e)) return SUBAGENT_ACCESS;
  const r = rt;
  if (!peersOn(r)) return notTakingPart('Not asked.');
  const to = typeof e.to === 'string' ? e.to.trim() : '';
  if (!to) return 'Not asked. Say which machine: to is a machine, or "name@machine".';
  if (e.right !== 'see' && e.right !== 'send') return 'Not asked. right must be see or send.';
  const right = e.right;
  const reason = typeof e.reason === 'string' ? redactText(e.reason).text : '';
  const out = await peerCall($, 'POST', peerPath(r.state.id, '/access'), { to, right, reason });
  return peerOutcome('Not asked.', out, (body) => accessAnswer(body, { owner: ownerName(), right, to }));
}

// ---- orchestrator messaging: answering a request in the terminal (#414) ----------------------------------------

/** `/podium allow|decline|deliver <id>`: answered through the server's route, and the answer names the id. */
async function answerRequest($: Engine, answer: 'allow' | 'decline' | 'deliver', arg: string): Promise<string> {
  const r = rt;
  if (!arg) return `Name the request: /podium ${answer} <id>. The id is in the request's toast and log line.`;
  if (!r || !peersOn(r)) return 'Orchestrator messaging is not on in this session, so nothing can be answered here. Answer in Podium > My reporters.';
  const found = findRequest([...peerKnown.values()], arg);
  if (found && 'ambiguous' in found) return `More than one request starts with ${arg}: ${found.ambiguous.map((q) => q.id).join(', ')}. Use more of the id.`;
  const q = found?.request ?? null;
  const id = q?.id ?? (isRequestId(arg) ? arg.trim() : null);
  if (!id) return `No request ${arg} has reached this session. Requests show here as they arrive, and in Podium > My reporters.`;
  const s = q ? shortId(q.id) : arg;
  const res = await podiumCall($, 'POST', peerPath(r.state.id, `/requests/${encodeURIComponent(id)}`), { answer });
  if (!res) return `Request ${s} was not answered: Podium cannot be reached. Try again, or answer in Podium > My reporters.`;
  if (res.status !== 200) return `Request ${s} was not answered: ${errorOf(res.text) ?? `Podium answered ${res.status}`}.`;
  peerOpen = peerOpen.filter((x) => x !== id);
  // Allowing never lowers a right, so the level applied can be higher than the request's: name the one Podium applied.
  return requestAnsweredLine(answer, s, q, appliedLevel(res.text), answerPaused(res.text));
}

/**
 * The identity this session reports as (#226): the one it already holds (a reload re-runs register with the
 * options as they are now, which may be someone else's), else this terminal's PODIUM_USER and PODIUM_TOKEN,
 * else the shared options. Held for the rest of the session once it has a token.
 */
async function takeIdentity($: Engine): Promise<Identity> {
  let held: Identity | undefined;
  let readable = true;
  try {
    held = (await $.state.get(IDENTITY)).value ?? undefined;
  } catch (err) {
    readable = false;
    record($, 'identity', err);
  }
  const env = { user: await attempt(() => $.env.get('PODIUM_USER'), undefined), token: await attempt(() => $.env.get('PODIUM_TOKEN'), undefined) };
  const picked = pickIdentity({ held, env, options: { userName: opts.userName, token: opts.token } });
  // When the held identity could not be read, do not overwrite what may be there.
  if (readable && worthHolding(picked) && (!held || held.userName !== picked.userName || held.token !== picked.token)) {
    await attempt(() => $.state.set(IDENTITY, picked), undefined);
  }
  return picked;
}

/** session.start (also after a hot reload): build the state, register /podium and the plan tool, start timers. */
async function start($: Engine, e: { cwd: string; surface: string | null }): Promise<void> {
  for (const t of rt?.timers ?? []) t.cancel();
  rt?.kick?.cancel();
  const now = nowMs();
  const id = await attempt(() => $.session.id(), `unknown-${now}`);
  who = await takeIdentity($);
  const model = await attempt<string | null>(() => $.session.model(), null);
  const root = await attempt(() => $.session.root(), e.cwd);
  const repo = await attempt(() => $.session.repo(), null);
  const version = await attempt(() => $.session.version(), null);
  const usage = await attempt(() => $.session.usage(), null);
  const projectRoot = repo?.root ?? root ?? e.cwd;
  const same = !!rt && rt.state.id === id;
  let state = same && rt ? rt.state : newSession({ id, cwd: e.cwd, startedAt: usage?.startedAt || now, model });
  state = setIdentity(state, { cwd: e.cwd, projectRoot, repoName: repo?.name ?? repoFromRemote(repo?.remote) ?? lastSegment(projectRoot), model });
  if (usage) state = measure(state, { context: usage.context, cost: usage.cost ?? null, rateLimits: usage.rateLimits, startedAt: usage.startedAt });
  if (!same) state = addEvent(state, 'start', null, `session.start · ${shortName(model)}`, now, { surface: e.surface });
  if (recorder.sessionId !== id) recorder.begin(id);
  const fetch: FetchLike = (url, init) => $.http.fetch(url, init);
  // Looked up once per load: the folder does not move, and a reload starts over.
  const build = rt ? rt.build : await findBuild($);
  const transport =
    rt?.transport ??
    new Transport(fetch, { serverUrl: opts.serverUrl, token: who.token, heartbeatMs: opts.heartbeatMs, version: VERSION, build }, (line) => remember('transport', line));
  rt = {
    state,
    transport,
    build,
    timers: [],
    flushSoon: (first) =>
      $.clock.after(PEER_KICK_MS, () => {
        first();
        void flush($, true);
      }),
    kick: null,
    storedName: await loadName($, id),
    claudeName: same && rt ? rt.claudeName : null,
    engineVersion: version?.version ?? null,
    hostSurface: e.surface,
    flushing: false,
    peerFlushing: false,
    lastStatus: null,
    toastedOk: rt?.toastedOk ?? false,
    toastedFail: rt?.toastedFail ?? false,
    toastedPlain: rt?.toastedPlain ?? false,
    toastedRefusal: rt?.toastedRefusal ?? null,
    toastedVersion: rt?.toastedVersion ?? null,
    skillCalls: 0,
    machine: rt?.machine ?? (await readMachine($)),
    clearedFrom: same && rt ? rt.clearedFrom : null,
    interactive: e.surface !== null,
    sessionCwd: await attempt<string | null>(() => $.session.cwd(), null),
  };
  acted = await loadActed($);
  const r = rt;
  await readAgents($, r, now);
  try {
    // immediate: an answer to a request typed during a turn runs at once, not when the turn ends (#411). The other verbs run mid-turn too.
    await $.command.register({
      name: 'podium',
      description: 'Podium fleet console: link, connection state, naming this session, and answering a messaging request',
      argumentHint: '[name <text> | allow <id> | decline <id> | deliver <id>]',
      immediate: true,
    });
  } catch (err) {
    record($, 'command.register', err);
  }
  try {
    await $.tool.register({
      name: 'plan',
      description: 'Names the plan this session is working through, for the Podium fleet console. Call once with a short title when you start a multi-step plan.',
      inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Short plan title' }, phase: { type: 'string', description: 'Optional phase name' } }, required: ['title'] },
    });
  } catch (err) {
    record($, 'tool.register', err);
  }
  r.timers.push($.clock.every(opts.flushIntervalMs, () => void flush($)));
  r.timers.push($.clock.every(GIT_POLL_MS, () => void pollGit($, r)));
  void pollGit($, r);
  showStatus($, r);
}

/** A hook carries Claude Code's current `cwd`: take it when the session has moved there, and read git in the new folder at once (#382). */
async function movedBy($: Engine, cwd: string | undefined): Promise<void> {
  // The hook's own .catch passes the event on if this ever throws; `follow` answers a failing $.session call itself.
  if (rt && typeof cwd === 'string' && (await movePlace($, rt, cwd))) void pollGit($, rt);
}

/** session.end: the final report, awaited, inside a deadline on the engine's clock. */
async function end($: Engine, e: { reason: string; sessionId: string; resume?: { id: string } }, signal: AbortSignal | undefined): Promise<void> {
  const r = rt;
  if (!r) return;
  // The server closes a finished session's asks itself; the races here just stop.
  for (const a of [...asks.values()]) if (a.sessionId === (e.sessionId || r.state.id)) finish(a);
  const now = await engineNow($);
  if (e.sessionId === r.state.id || !e.sessionId) {
    if (e.reason === 'clear') recorder.clear(MAIN_LOOP, nowMs(), takePodiumCommand('clear'));
    recorder.close();
    r.state = sessionEnd(r.state, e.reason, e.resume?.id ?? e.sessionId ?? r.state.id, now);
    // The hooks sandbox has no setTimeout: the deadline is the engine's clock. A sleep the dispatch
    // abandons rejects; either way the race is over.
    const deadline = $.clock.sleep(END_FLUSH_MS, signal ? { signal } : undefined).catch(() => undefined);
    await Promise.race([
      (async () => {
        await r.transport.idle();
        await flushOnce($, r, now, true);
        await sendRecording($, now);
      })(),
      deadline,
    ]);
  }
  // After /clear the process goes on under a new id (the flusher picks it up); otherwise it is ending.
  if (e.reason !== 'clear') {
    for (const t of r.timers) t.cancel();
    r.timers = [];
    r.kick?.cancel();
    r.kick = null;
  }
}

/** /podium, /podium name <text>, and /podium allow|decline|deliver <id> (#414). */
async function podiumCommand($: Engine, args: string): Promise<string> {
  const r = rt;
  const verb = parseAnswer(args);
  if (verb) return answerRequest($, verb.answer, verb.id);
  const name = nameArg(args);
  if (name !== null && r) {
    try {
      await $.store.set(`name:${r.state.id}`, name);
    } catch (err) {
      record($, 'store.set', err);
    }
    r.storedName = name;
    r.state = { ...r.state, dirty: true };
    return `Podium: this session is now named "${name}".`;
  }
  if (!r) return 'Podium reporter is loaded but the session has not started yet.';
  const t = r.transport;
  const hooks = Object.entries(stats)
    .filter(([, s]) => s.calls)
    .map(([k, s]) => `${k} ${(s.totalMs / s.calls).toFixed(2)} ms avg, ${s.maxMs.toFixed(2)} max`)
    .slice(0, 8);
  return [
    `Podium fleet console: ${trimTrailingSlashes(opts.serverUrl)}/#/`,
    `Connection: ${t.online === null ? 'not tried yet' : t.online ? 'online' : 'offline, retrying'}${t.liveSessions !== null ? ` (${t.liveSessions} live sessions)` : ''}`,
    `Versions: reporter ${devNote(VERSION, r.build)}${t.serverVersion ? `, server ${devNote(t.serverVersion, t.serverBuild)}` : ''}`,
    t.ownerNotice() ?? t.versionNotice() ?? t.updateNotice() ?? '',
    `Reports sent: ${t.sent}, failed: ${t.failed}, rejected: ${t.rejected}; events queued: ${t.queue.length}${t.dropped ? `, dropped: ${t.dropped}` : ''}`,
    `Last error: ${t.lastError ?? errors[errors.length - 1]?.message ?? 'none'}`,
    `Session: ${r.state.id}${r.storedName ? ` (named "${r.storedName}")` : ''}`,
    describeBackground(r.state),
    peersOn(r) ? openRequestsLine(peerOpen.map((id) => peerKnown.get(id)).filter((q): q is PeerRequest => !!q)) : '',
    hooks.length ? `Reporter time per hook: ${hooks.join('; ')}` : '',
    'Name this session: /podium name <text>',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---- session recording (#353, SPEC 5.3 "Session recording from the reporter") ----------------------
// Off unless the `sessionRecording` option is on AND the last reply's grant says this session is chosen and consented. With it off
// the recorder is never fed a thing: nothing is captured, queued or sent, and the owner is told when someone chose the session.

/** Batches one last send may take: a backlog after an outage, bounded so the session's end is not held. */
const RECORDING_FINAL_BATCHES = 20;
/** Step text read per request: one entry holds RECORDING_LIMITS.text, one more character shows it was cut. */
const RECORDING_STEP_TEXT_MAX = RECORDING_LIMITS.text + 1;

let recorder = new Recorder();

/** The loop a hook's `agentId` names; the orchestrator when it names none. */
function recLoop(agentId: string | undefined): string {
  return agentId ?? MAIN_LOOP;
}

/**
 * An answer or approval from Podium that Claude Code took, kept in a recording where the mod takes it (#353): once, marked with who
 * sent it, in order after the call it answers. The server writes nothing for it.
 */
function recordDecision(agentId: string | null | undefined, toolUseId: string, d: Delivery, askKind: Ask['kind'], questions?: OpenAsk['questions'], at: number = nowMs()): void {
  safe('decision.record', () => recorder.decided(recLoop(agentId ?? undefined), callSeqs.get(toolUseId) ?? null, decisionRecord(d, askKind, questions), at));
}

/** Who sent the /clear or /compact that is running now from Podium, once: the mark it makes is theirs. Nobody for a person's own. */
function takePodiumCommand(command: 'clear' | 'compact'): string | undefined {
  if (ranFromPodium?.command !== command) return undefined;
  const by = ranFromPodium.by;
  ranFromPodium = null;
  return by;
}

/** The grant a batch's reply carries, or null. */
function grantOf(text: string): RecordingGrant | null {
  try {
    const g = (JSON.parse(text) as { recording?: unknown }).recording;
    return isRecordingGrant(g) ? g : null;
  } catch {
    return null;
  }
}

/** Takes the server's grant and tells the owner, in the terminal, what changed. */
function takeRecording($: Engine, grant: RecordingGrant | null): void {
  const out = recorder.apply(grant, opts.sessionRecording);
  if (!grant) return;
  const now = nowMs();
  if (out.started) transcriptLine($, startLine(grant, now));
  if (out.ended === 'stopped') transcriptLine($, stoppedLine(grant, now));
  else if (out.ended === 'limit') transcriptLine($, limitLine(grant));
  if (out.refused) transcriptLine($, refusedLine(grant));
}

/**
 * Posts the recording's next batch from the flush timer (never from a hook). A closing recorder sends what it has, up to
 * RECORDING_FINAL_BATCHES requests, and then lets go of the queue.
 */
async function sendRecording($: Engine, now: number): Promise<void> {
  const rec = recorder;
  const sid = rec.sessionId;
  const rounds = rec.closing ? RECORDING_FINAL_BATCHES : 1;
  for (let i = 0; sid && i < rounds && rec.due(now); i++) {
    const out = rec.nextBatch(now);
    if (!out) break;
    const res = await podiumCall($, 'POST', `${sessionPath(sid)}/recording`, out.batch);
    if (recorder !== rec || rec.sessionId !== sid) return; // the session moved on while the request was out
    if (res?.status === 200) {
      rec.done(out.count, now);
      try {
        $.ui.log(`podium-reporter: recording: sent ${out.count} entries, ${rec.redactions} redactions`, { to: 'debug' });
      } catch {
        // logging is best effort
      }
      rec.redactions = 0;
      takeRecording($, grantOf(res.text));
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

// ---- registration -------------------------------------------------------------------------------

export const register: Register = (on, rawOptions) => {
  opts = readOptions(rawOptions as Record<string, unknown>);
  who = { userName: '', token: '' };
  rt = null;
  generation++;
  errors = [];
  stats = {};
  explained = new Set();
  recorder = new Recorder();
  asks = new Map();
  outbox = [];
  acted = [];
  permissionHooks = null;
  lastPermissionAt = 0;
  for (const c of checks.values()) c.cancel();
  checks = new Map();
  lastCalls = new Map();
  callSeqs = new Map();
  ranFromPodium = null;
  messagesLineShown = false;
  for (const c of peerCalls) c.resolve(null);
  peerCalls = [];
  peerToolsRegistered = false;
  peerKnown = new Map();
  peerOpen = [];

  on('session.start', async ($, e, next) => {
    const res = await next(e);
    try {
      await start($, e);
    } catch (err) {
      record($, 'session.start', err);
    }
    return res;
  }).catch(($, e, next) => next(e));

  on('session.end', async ($, e, next) => {
    const res = await next(e);
    try {
      await end($, e, next.signal);
    } catch (err) {
      record($, 'session.end', err);
    }
    return res;
  }).catch(($, e, next) => next(e));

  on('turn.start', async ($, e, next) => {
    safe('turn.start', (r) => {
      r.state = turnStart(r.state);
      recorder.prompt(recLoop(e.agentId), e.agentId ? e.text : unframeSent(e.text, sentFromPodium), nowMs());
    });
    return next(e);
  }).catch(($, e, next) => next(e));

  on('turn.step', async function* ($, e, next) {
    // A loop someone is watching, with the activityFeed option on (#118): read the text chunks as they pass and keep
    // the step's text as one entry. Every chunk is yielded on as it came, the same object, in order. Any other step
    // takes the plain path. `for await` drops a stream's return value, so the result is `stream.result`.
    let watching = false;
    // A loop being recorded (#353): the same chunks are read for the text the model wrote and the places it thought.
    let recording = false;
    safe('turn.step.watch', (r) => {
      watching = opts.activityFeed && isWatched(r.state, e.agentId);
      recording = recorder.want(recLoop(e.agentId));
    });
    let res: Awaited<ReturnType<typeof next>['result']>;
    let text = '';
    let wrote = '';
    const thought = new Set<number>();
    if (!watching && !recording) res = yield* next(e);
    else {
      const stream = next(e);
      for await (const chunk of stream) {
        if (watching && text.length < STEP_TEXT_MAX) {
          safe('turn.step.chunk', () => {
            if (chunk.kind === 'text' && typeof chunk.text === 'string') text += chunk.text;
          });
        }
        if (recording) {
          safe('turn.step.record', () => {
            if (chunk.kind === 'text' && typeof chunk.text === 'string') {
              if (wrote.length < RECORDING_STEP_TEXT_MAX) wrote += chunk.text;
            } else if (chunk.kind === 'thinking' && !thought.has(chunk.index)) {
              // One mark for each thinking block, in order with the text around it. Its text is not recorded (SPEC 6.4).
              thought.add(chunk.index);
              recorder.said(recLoop(e.agentId), wrote, nowMs());
              wrote = '';
              recorder.thinking(recLoop(e.agentId), nowMs());
            }
          });
        }
        yield chunk;
      }
      res = await stream.result;
    }
    safe('turn.step', (r) => {
      r.state = step(r.state, { agentId: e.agentId, model: e.model, effort: e.effort, usage: res?.usage ?? null, stopReason: res?.stopReason ?? null }, nowMs());
      const said = text ? activityText(text) : '';
      if (said) r.state = addActivity(r.state, e.agentId, { at: nowMs(), kind: 'text', text: said });
      recorder.said(recLoop(e.agentId), wrote, nowMs());
    });
    return res;
  }).catch(async function* ($, e, next) {
    return yield* next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const res = await next(e);
    safe('turn.complete', (r) => {
      r.state = turnComplete(r.state, { agentId: e.agentId, reason: e.reason, answer: e.answer }, nowMs());
    });
    return res;
  }).catch(($, e, next) => next(e));

  on('session.compact', async ($, e, next) => {
    const res = await next(e);
    safe('session.compact', (r) => {
      if (e.trigger === 'precompute' || !res || res.skip !== undefined || !res.messages) return;
      r.state = compaction(r.state, { agentId: e.agentId, trigger: e.trigger, tokensBefore: res.tokensBefore, tokensAfter: res.tokensAfter }, nowMs());
      recorder.compact(recLoop(e.agentId), nowMs(), e.agentId ? undefined : takePodiumCommand('compact'));
    });
    // The transcript was emptied: the owner is told again that this session is being recorded.
    if (recorder.capturing && recorder.grant && e.trigger !== 'precompute' && res && res.skip === undefined && res.messages) transcriptLine($, startLine(recorder.grant, nowMs()));
    return res;
  }).catch(($, e, next) => next(e));

  // A client joining or leaving is a prompt to look at the roster now; the flush timer reads it too.
  on('session.attach', async ($, e, next) => {
    const res = await next(e);
    if (rt) await readSurfaces($, rt);
    return res;
  }).catch(($, e, next) => next(e));

  on('session.detach', async ($, e, next) => {
    const res = await next(e);
    if (rt) await readSurfaces($, rt);
    return res;
  }).catch(($, e, next) => next(e));

  on('session.measure', async ($, e, next) => {
    safe('session.measure', (r) => {
      r.state = measure(r.state, { context: e.context, cost: e.cost ?? null, rateLimits: e.rateLimits });
    });
    return next(e);
  }).catch(($, e, next) => next(e));

  on('agent.spawn', async ($, e, next) => {
    const res = await next(e);
    safe('agent.spawn', (r) => {
      if (!res || res.deny !== undefined || !res.agentId) return;
      r.state = agentSpawned(
        r.state,
        {
          toolUseId: e.tool_use_id,
          agentId: res.agentId,
          model: res.model ?? e.model ?? null,
          subagentType: e.subagentType,
          description: e.description,
          prompt: e.prompt,
          parentAgentId: e.parentAgentId,
          fork: e.fork,
          isTeammate: e.isTeammate === true,
          name: e.name ?? res.teammateId,
        },
        nowMs(),
      );
      recorder.prompt(res.agentId, e.prompt, nowMs());
    });
    return res;
  }).catch(($, e, next) => next(e));

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool);
    const input = e as unknown as Record<string, unknown>;
    safe('tool.call', (r) => {
      r.state = toolStarted(r.state, e.agentId, tool);
      if (opts.activityFeed && isWatched(r.state, e.agentId)) r.state = addActivity(r.state, e.agentId, activityEntry(tool, input, e.tool_use_id, nowMs()));
      if (tool === 'Agent' && e.tool_use_id) r.state = agentRequested(r.state, e.tool_use_id, input, nowMs());
      if (tool === 'Skill') r.skillCalls++;
      // The arguments as a PermissionRequest will carry them: the call's own, without the event's fields.
      if (e.tool_use_id && opts.respond !== 'off') {
        const { tool: _t, tool_use_id: _id, agentId: _a, ...args } = input;
        lastCalls.set(loopKey(e.agentId), { tool, input: inputKey(args), id: e.tool_use_id });
      }
    });
    // What a recording keeps of the call: its whole input now, its whole result when it ends (#353).
    let callSeq: number | null = null;
    safe('tool.call.record', () => {
      callSeq = recorder.call(recLoop(e.agentId), tool, input, nowMs());
      if (callSeq !== null && e.tool_use_id) callSeqs.set(e.tool_use_id, callSeq);
    });
    let res: Awaited<ReturnType<typeof next>>;
    try {
      // While the mod responds, a question or a plan races the terminal's dialog against an answer from Podium (#206).
      const r = rt;
      if (r && tool === 'AskUserQuestion' && e.tool_use_id && responding(r, 'question')) res = (await questionRace($, r, e as never, next(e) as Promise<ToolResult>)) as typeof res;
      else if (r && tool === 'ExitPlanMode' && e.tool_use_id && (responding(r, 'plan-feedback') || responding(r, 'plan-approve'))) res = (await planRace($, r, e as never, next(e) as Promise<ToolResult>)) as typeof res;
      else res = await next(e);
    } catch (err) {
      // A call that ends in an error has no result to settle: its number is not kept for good.
      if (e.tool_use_id) callSeqs.delete(e.tool_use_id);
      throw err;
    } finally {
      safe('tool.call.done', (r) => {
        if (tool === 'Skill') r.skillCalls = Math.max(0, r.skillCalls - 1);
      });
    }
    safe('tool.call.result', (r) => {
      r.state = toolResult(r.state, { agentId: e.agentId, tool, input, result: (res ?? {}) as { deny?: string; isError?: boolean; text?: string } }, nowMs());
      if (e.tool_use_id) settleToolAsk(e.tool_use_id, res as ToolResult | undefined);
      if (tool === 'Bash' && e.tool_use_id && opts.activityFeed && opts.activityOutput && isWatchedOutput(r.state, e.agentId)) {
        r.state = finishActivity(r.state, e.agentId, e.tool_use_id, finishedCall((res ?? {}) as BashResult));
      }
      recorder.outcome(recLoop(e.agentId), tool, input, callSeq, res, nowMs());
      if (e.tool_use_id) callSeqs.delete(e.tool_use_id);
    });
    return res;
  }).catch(($, e, next) => next(e));

  // Where a prompt is about to show, a PermissionRequest should follow: if none does, the hooks don't run here (#206).
  on('tool.check', async ($, e, next) => {
    const res = await next(e);
    safe('tool.check', () => {
      const id = (e as { tool_use_id?: string }).tool_use_id;
      if (opts.respond !== 'off' && id && (res as { decision?: string } | undefined)?.decision === 'ask') startPermissionCheck($, id);
    });
    return res;
  }).catch(($, e, next) => next(e));

  // The reporter's own tool names the plan: answered here, recorded by the hook above.
  // The matcher is a literal (PLAN_TOOL) so the engine sees which tool this hook answers.
  // The result is text: Claude Code rejects any other shape as an error, and an errored call sets no title.
  const planRecorded = { result: 'Plan title recorded for the Podium fleet console.' };
  on('tool.call', { tool: 'mcp__podium-reporter__plan' }, () => planRecorded).catch(() => planRecorded);

  // Orchestrator messaging (#414): each tool answered here in plain words, recorded by the hook above. A call with an
  // agentId is a subagent's and is refused. With the option off they are never registered; one left from before a
  // reload that turned it off is refused.
  // Reached on the hook's timeout and on any error in the tool, so it claims neither: it says what to check.
  const peerFallback = { result: 'podium-reporter could not finish this call, so it may not have gone. podium_peers and Podium > Traffic show what arrived; /podium shows the connection.' };
  on('tool.call', { tool: 'mcp__podium-reporter__podium_peers' }, async ($, e) => ({ result: await peersTool($, e as never) })).catch(() => peerFallback);
  on('tool.call', { tool: 'mcp__podium-reporter__podium_send' }, async ($, e) => ({ result: await sendTool($, e as never) })).catch(() => peerFallback);
  on('tool.call', { tool: 'mcp__podium-reporter__podium_request_access' }, async ($, e) => ({ result: await accessTool($, e as never) })).catch(() => peerFallback);

  on('skill.prompt', async ($, e, next) => {
    safe('skill.prompt', (r) => {
      // A Skill tool call records its own loop; an agent may be preloading it: skip when ambiguous.
      const agentsRunning = Object.values(r.state.agents).some((a) => a.status === 'running');
      if (r.skillCalls === 0 && !agentsRunning) r.state = skillLoaded(r.state, undefined, e.skill, nowMs());
    });
    return next(e);
  }).catch(($, e, next) => next(e));

  on('classic.PermissionRequest', async ($, e, next) => {
    const agentId = (e as { agent_id?: string }).agent_id;
    safe('classic.PermissionRequest', (r) => {
      r.state = permissionRequest(r.state, e.tool_name, e.tool_input, nowMs());
      const call = lastCalls.get(loopKey(agentId));
      permissionSeen(r, call && call.tool === e.tool_name ? call.id : null);
    });
    const r = rt;
    if (!r || e.tool_name === 'AskUserQuestion') return next(e);
    // A plan's approval from Podium (#206): `updatedInput` is the event's own tool_input, unchanged (SPEC 5.3).
    if (e.tool_name === 'ExitPlanMode') {
      const a = responding(r, 'plan-approve') ? planAskOf(agentId) : undefined;
      const d = a ? await approvalFromPodium($, a) : null;
      if (!d || !d.mode) return next(e);
      // The transcript line waits for the call to resolve approved (planRace), so it never claims one that didn't take.
      return planApproval(e.tool_input, d.mode);
    }
    if (!responding(r, 'permission')) return next(e);
    const decision = await permissionAsk($, r, { tool_name: e.tool_name, tool_input: e.tool_input, agent_id: agentId });
    return decision ?? next(e);
  }).catch(($, e, next) => next(e));

  on('classic.Notification', async ($, e, next) => {
    safe('classic.Notification', (r) => {
      r.state = notification(r.state, e.notification_type, e.message, nowMs());
    });
    return next(e);
  }).catch(($, e, next) => next(e));

  // Claude Code's own session name (#322): the title rides on these two hooks, so a rename shows from the next prompt.
  on('classic.SessionStart', async ($, e, next) => {
    safe('classic.SessionStart', (r) => takeClaudeName(r, e));
    await movedBy($, e.cwd);
    return next(e);
  }).catch(($, e, next) => next(e));

  on('classic.UserPromptSubmit', async ($, e, next) => {
    safe('classic.UserPromptSubmit', (r) => takeClaudeName(r, e));
    await movedBy($, e.cwd);
    return next(e);
  }).catch(($, e, next) => next(e));

  // The Stop hook lists the background work and scheduled wake-ups still in flight (#119): a session idle on
  // them is not waiting on the person.
  on('classic.Stop', async ($, e, next) => {
    safe('classic.Stop', (r) => {
      const now = nowMs();
      const crons = (e.session_crons ?? []).map((c) => ({ ...c, nextAt: nextCronAt(c.schedule, now) }));
      r.state = setBackground(r.state, { tasks: e.background_tasks ?? [], crons }, now);
    });
    return next(e);
  }).catch(($, e, next) => next(e));

  on('command.run', { command: 'podium' }, async ($, e) => ({ text: await podiumCommand($, e.args ?? '') }));
};
