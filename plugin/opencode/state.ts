// What the OpenCode reporter knows about its sessions (#855). Pure: no engine API, no clock of its own, no network.
// `apply` folds one bus event into a Store; report.ts turns a Root into a v2 report. A root session and the child
// sessions it launched are one Root and one report; a child is an agent in that report.
import { activityText, clip, whole, excerpt, cap, candidateFrom, classify, buildFailure, evidence, fullText, tailLines, LIMITS, type FailureCandidate } from '../core/failures.ts';
import { ACTIVITY_KEPT } from '../core/feed.ts';
import { emptyPlan, todoWrite, type PlanState } from '../core/plan.ts';
import type { Place } from '../core/place.ts';
import { MAIN_LOOP, type ActivityEntry, type BackgroundWait, type ActivityEvent, type Failure, type FilesReport, type GitInfo, type ModelUsage } from '../core/protocol.ts';
import { Recorder } from '../core/recording.ts';
import { canonical, entryFor, finishedEntry, toolName } from './activity.ts';

/** One event from the OpenCode bus as the plugin receives it. Only the fields this reporter reads are typed. */
export interface BusEvent {
  id?: string;
  created?: number;
  type: string;
  location?: { directory?: string };
  data?: Record<string, any>;
  /** Set by the plugin for a permission it found open when it started (`ctx.permission.list`): its session may not be known yet. */
  recovered?: boolean;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Call {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  at: number;
  done: boolean;
  /** The `seq` the recording gave the call, so its result and a decision about it point back to it; null when it was not recorded. */
  recSeq?: number | null;
}

export type SessEnd = 'running' | 'done' | 'failed' | 'aborted';

/** One OpenCode session: the root, or a child it launched. */
export interface Sess {
  id: string;
  parentId: string | null;
  startedAt: number;
  endedAt: number | null;
  lastAt: number;
  /** The title OpenCode gave it (`session.renamed`), else its slug. */
  title: string | null;
  /** OpenCode's own agent name for the session, such as `build` or `general`. */
  agent: string | null;
  model: string | null;
  provider: string | null;
  /** Cumulative for the session. The root's already includes its children: it is never summed again. */
  tokens: Tokens;
  costUsd: number;
  /** The last step's prompt size: input + cache read + cache write. */
  ctxTokens: number | null;
  executing: boolean;
  end: SessEnd;
  calls: Map<string, Call>;
  toolCalls: number;
  toolCounts: Record<string, number>;
  lastTool: string | null;
  steps: number;
  /** Automatic compactions: OpenCode compacts by itself when the context nears its limit. */
  blowouts: number;
  /** When each automatic compaction of the current run ended, newest last (kept to the last 20): the run's count for the classifier and the evidence line. */
  blowoutTimes: number[];
  prompt: string;
  answer: string;
  failure: Failure | null;
  /** The time of the failure the model was last asked to explain, so each failure is asked about once (#969). */
  explainedAt: number | null;
  /** The model variant of the last step (`model.variant`), which is OpenCode's name for effort; null when the step named none. */
  effort: string | null;
  skills: string[];
  /** Tokens per model and prompt-size tier, from each finished step. */
  usage: Record<string, ModelUsage>;
  /** The last failing or denied call: what a failure that follows is blamed on while it is fresh. */
  candidate: FailureCandidate | null;
  /** How often each failing call failed. */
  failedCalls: Record<string, number>;
  /** The last 20 activity entries, oldest first. Empty unless the loop is watched (#118). */
  activity: ActivityEntry[];
  /** The whole redacted prompt and answer, for the `fullPrompts` option; null until known. */
  promptText: string | null;
  answerText: string | null;
  promptSent: boolean;
  answerSent: boolean;
}

/** One field of a question form: what OpenCode asks, and the values it takes back. */
export interface FormField {
  key: string;
  title: string;
  description: string;
  /** OpenCode's field type; `array` takes several values. */
  type: string;
  options: { value: string; label: string; description: string }[];
  /** Whether a typed answer is allowed besides the options. */
  custom: boolean;
}

export interface Ask {
  id: string;
  kind: 'permission' | 'question';
  sessionId: string;
  openedAt: number;
  note: string;
  /** The tool call a permission is for, when OpenCode names it: a recording points its decision at that call. */
  callId?: string;
  /** A permission's action and the resources it names. */
  action?: string;
  resources?: string[];
  /** A question's fields. The form's id is the ask's id. */
  fields?: FormField[];
}

/** The fields of a form as the bus announces them; anything that is not a field with a key is dropped. */
export function formFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) return [];
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  return raw.flatMap((f: any) =>
    f && typeof f.key === 'string' && f.key
      ? [{
          key: f.key,
          title: text(f.title),
          description: text(f.description),
          type: text(f.type) || 'string',
          options: Array.isArray(f.options) ? f.options.flatMap((o: any) => (o && typeof o.value === 'string' ? [{ value: o.value, label: text(o.label) || o.value, description: text(o.description) }] : [])) : [],
          custom: f.custom === true,
        }]
      : [],
  );
}

/** A root session with its children: one record on the wall. */
export interface Root {
  id: string;
  cwd: string | null;
  startedAt: number;
  lastAt: number;
  sessions: Map<string, Sess>;
  /** Child ids in the order they were created. */
  children: string[];
  plan: PlanState;
  asks: Map<string, Ask>;
  compacting: boolean;
  compactions: number;
  /** Set when the root is done; cleared when it sees activity again (it reopens under the same id). */
  done: boolean;
  endReason: string | null;
  git: GitInfo | null;
  /** The git project root and `owner/name`, once git has been read for the folder in `cwd` (#987); null before, and the report then says the folder and its name. */
  place: Place | null;
  /** The name `/podium name` gave (#987); it wins over the title OpenCode gives and the `sessionName` option, as in Claude Code. */
  storedName: string | null;
  /** What the root is idle on, as `experimental.idle` last listed it (#987); null while it works again, and when nothing is running. */
  background: BackgroundWait | null;
  /** The folder `place` was read for, so a root that moves is read again. */
  placeFor: string | null;
  /** The files changed since the session began, once git has been read; null before, and when git cannot be read. */
  files: FilesReport | null;
  /** The commit HEAD was at on the first read; the files list and a file's diff are against it. */
  gitBase: string | null;
  /** Events for the next report. */
  events: ActivityEvent[];
  seq: number;
  /** Whether something changed since the last report went out. */
  dirty: boolean;
  /** The loops the server last said someone is watching (MAIN_LOOP for the root session, else a child's session id). Empty unless the person allowed the feed. */
  watched: string[];
  /** The loops of `watched` a viewer has the feed open on: a shell call's output is kept only for these. */
  watchedOutput: string[];
  /** What the session records (#353). It captures nothing until the server grants it and the person's option is on. */
  recorder: Recorder;
  /** Messages from Podium handed to OpenCode as a prompt and not yet seen back, so the recording keeps the text that was sent. */
  sentFromPodium: { framed: string; text: string }[];
  /** The `/compact` Podium is running, once: the mark it makes in the recording is its sender's. */
  podiumCompact: string | null;
}

export interface Store {
  roots: Map<string, Root>;
  /** Session id to the id of its root. */
  rootOf: Map<string, string>;
}

/**
 * The bus events the reducer reads. The plugin subscribes to exactly these: a subscription with no `types` is not given the
 * session events (the manual run with OpenCode 2.2.5 saw only provider and model updates), and asking for fewer events costs less.
 */
export const EVENT_TYPES = [
  'session.created', 'session.renamed', 'session.deleted', 'session.archived', 'session.unarchived',
  'session.inbox.enqueued',
  'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
  'session.step.started', 'session.step.ended', 'session.step.failed',
  'session.usage.updated', 'session.text.ended', 'session.reasoning.ended', 'session.skill.activated',
  'session.tool.input.started', 'session.tool.called', 'session.tool.success', 'session.tool.failed',
  'session.compaction.started', 'session.compaction.ended', 'session.compaction.failed',
  'permission.asked', 'permission.replied',
  'form.created', 'form.replied', 'form.cancelled',
] as const;

export const newStore = (): Store => ({ roots: new Map(), rootOf: new Map() });

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function newSess(id: string, parentId: string | null, at: number): Sess {
  return {
    id, parentId, startedAt: at, endedAt: null, lastAt: at, title: null, agent: null, model: null, provider: null,
    tokens: zero(), costUsd: 0, ctxTokens: null, executing: false, end: 'running', calls: new Map(), toolCalls: 0,
    toolCounts: {}, lastTool: null, steps: 0, blowouts: 0, blowoutTimes: [], prompt: '', answer: '', failure: null, explainedAt: null, effort: null, skills: [], usage: {}, candidate: null, failedCalls: {},
    activity: [], promptText: null, answerText: null, promptSent: false, answerSent: false,
  };
}

function newRoot(id: string, cwd: string | null, at: number): Root {
  const recorder = new Recorder();
  recorder.begin(id);
  return {
    id, cwd, startedAt: at, lastAt: at, sessions: new Map([[id, newSess(id, null, at)]]), children: [], plan: emptyPlan,
    asks: new Map(), compacting: false, compactions: 0, done: false, endReason: null, git: null, place: null, storedName: null, background: null, placeFor: null, files: null, gitBase: null, events: [], seq: 0, dirty: true,
    watched: [], watchedOutput: [], recorder, sentFromPodium: [], podiumCompact: null,
  };
}

/** The loop key of a session in the server's watch list and in a recording: the orchestrator's own, else the child's session id. */
export const loopKey = (root: Root, s: Sess): string => (s.id === root.id ? MAIN_LOOP : s.id);

/** The entries of every loop without its `output` once the loop has lost its lease; how a call ended stays (#598). */
function withoutOutput(list: ActivityEntry[]): ActivityEntry[] {
  return list.map((e) => {
    if (!('output' in e) && !('outputCut' in e)) return e;
    const { output: _o, outputCut: _c, ...rest } = e;
    return rest;
  });
}

/**
 * The loops the server's reply says are watched. A loop that drops off the list forgets its entries, so a later watch starts
 * empty, and loses its output lease with them. A loop that is listed starts keeping entries from now.
 */
export function setWatched(root: Root, ids: readonly string[]): void {
  const next = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  if (next.length === root.watched.length && next.every((id, i) => id === root.watched[i])) return;
  root.watched = next;
  for (const s of root.sessions.values()) if (!next.includes(loopKey(root, s))) s.activity = [];
  setWatchedOutput(root, root.watchedOutput.filter((id) => next.includes(id)));
}

/** The loops a viewer has the feed open on. A loop that drops off the list forgets the output its entries held; the commands stay. */
export function setWatchedOutput(root: Root, ids: readonly string[]): void {
  const next = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  if (next.length === root.watchedOutput.length && next.every((id, i) => id === root.watchedOutput[i])) return;
  root.watchedOutput = next;
  for (const s of root.sessions.values()) if (!next.includes(loopKey(root, s))) s.activity = withoutOutput(s.activity);
}

/** Adds an entry to the feed of a loop that is watched, keeping the last 20. A loop nobody watches keeps nothing. */
function addActivity(root: Root, s: Sess, entry: ActivityEntry): void {
  if (!root.watched.includes(loopKey(root, s))) return;
  s.activity = [...s.activity, entry].slice(-ACTIVITY_KEPT);
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** A token count the host sent, as the whole number the server requires (#1007). */
const count = (v: unknown): number => whole(num(v));
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** `session.usage.updated` and `session.step.ended` carry tokens as `{input, output, reasoning, cache: {read, write}}`. */
export function tokensOf(t: any): Tokens {
  return {
    input: count(t?.input),
    // Reasoning tokens are billed as output.
    output: count(t?.output) + count(t?.reasoning),
    cacheRead: count(t?.cache?.read),
    cacheWrite: count(t?.cache?.write),
  };
}

function emit(root: Root, t: number, kind: ActivityEvent['kind'], agentId: string | null, text: string, data: Record<string, unknown> | null = null): void {
  root.seq++;
  root.events.push({ id: `${root.id}:${agentId ?? 'main'}:${kind}:${t}:${root.seq}`, t, kind, agentId, text: clip(text, LIMITS.text), data });
}

/** The root and session an event is about, creating them the first time they are seen. A session with no `parentID` is a root. */
function locate(store: Store, id: string, parentId: string | null, at: number, cwd: string | null): { root: Root; sess: Sess } {
  let rid = store.rootOf.get(id);
  if (!rid && parentId) rid = store.rootOf.get(parentId);
  let root = rid ? store.roots.get(rid) : undefined;
  if (!root) {
    root = newRoot(id, cwd, at);
    store.roots.set(id, root);
    store.rootOf.set(id, id);
    emit(root, at, 'start', null, 'session started');
  }
  store.rootOf.set(id, root.id);
  let sess = root.sessions.get(id);
  if (!sess) {
    sess = newSess(id, parentId, at);
    root.sessions.set(id, sess);
    root.children.push(id);
    emit(root, at, 'spawn', id, 'launched a subagent');
  }
  if (cwd && !root.cwd) root.cwd = cwd;
  return { root, sess };
}

function reopen(root: Root, at: number): void {
  if (!root.done) return;
  root.done = false;
  root.endReason = null;
  emit(root, at, 'start', null, 'session reopened');
}

function errorText(e: any): string {
  if (typeof e === 'string') return e;
  if (e && typeof e.message === 'string') return e.message;
  return '';
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
}

/** A request whose prompt (input + cache reads + cache writes) is over this is priced at a model's long-prompt tier. */
const LONG_PROMPT_TOKENS = 100_000;

/** Adds one finished step's tokens to the session's per-model, per-tier totals. A step that names no model counts nowhere. */
function addUsage(s: Sess, k: Tokens): void {
  if (!s.model) return;
  const tier = k.input + k.cacheRead + k.cacheWrite > LONG_PROMPT_TOKENS ? 'long' : 'std';
  const key = `${s.model}\u0000${tier}`;
  const was = s.usage[key]?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  s.usage[key] = { model: s.model, tier, tokens: { input: was.input + k.input, output: was.output + k.output, cacheRead: was.cacheRead + k.cacheRead, cacheWrite: was.cacheWrite + k.cacheWrite, cacheWrite1h: 0 } };
}

/** The candidate for a failure at `at`: the last failing or denied call, if it is recent enough to be the cause. */
const freshCandidate = (s: Sess, at: number): FailureCandidate | null => (s.candidate && at - s.candidate.at <= LIMITS.candidateMaxAgeMs ? s.candidate : null);

/**
 * Records why a session's run ended badly, as the Claude Code reporter does for an agent: the class, the failing call
 * it blames, the lines the engine gave, and the facts observed (a denial, a call that kept failing). `errText` is the engine's own
 * error and is kept when no failing call explains the end.
 */
function recordFailure(s: Sess, reason: 'error' | 'aborted', at: number, errText: string): Failure {
  const cand = freshCandidate(s, at);
  const cls = classify({ reason, candidate: cand, stopReason: null, blowouts: s.blowoutTimes.length, now: at }) ?? 'Unknown';
  const ev = evidence({ blowoutTimes: s.blowoutTimes, failedCalls: s.failedCalls, reads: {}, denyText: cand?.denied ? cand.denyText : null });
  const request = cls === 'Model API error' ? { tool: 'model request', call: s.model ? `model request (${s.model}${s.effort ? `, effort ${s.effort}` : ''})` : 'model request' } : {};
  const f = buildFailure(cls, cand, ev, at, request);
  if (!cand && errText) f.outputTail = tailLines(errText);
  s.failure = f;
  return f;
}

/** A skill the session loaded: kept once, with an event. OpenCode 2.2.5 sends no `session.skill.activated` for its skill tool, so the tool's own result calls this too. */
function skillLoaded(root: Root, s: Sess, name: string | null, at: number): void {
  if (!name || s.skills.includes(name)) return;
  s.skills = [...s.skills, cap(name, 120)].slice(-50);
  emit(root, at, 'skill', s.id === root.id ? null : s.id, `${name} loaded into ${s.id === root.id ? 'orchestrator' : (s.agent ?? 'agent')}`, { skill: name });
}

/** The exit code of a finished shell call, from its metadata (OpenCode 2.2.5 sets `metadata.exit`); null for another tool or none. */
const shellExit = (tool: string, d: Record<string, any>): number | null => (tool === 'Bash' && typeof d.metadata?.exit === 'number' && Number.isFinite(d.metadata.exit) ? d.metadata.exit : null);

function finishCall(root: Root, s: Sess, d: Record<string, any>, at: number, failedEvent: boolean): void {
  const id = str(d.id);
  if (!id) return;
  const call = s.calls.get(id) ?? { id, tool: 'tool', input: {}, at, done: false };
  // OpenCode 2.2.5 reports a shell call that exits non-zero as a success, with the code in its metadata; for Claude Code that is a failed call.
  const exit = shellExit(call.tool, d);
  const failed = failedEvent || (exit !== null && exit !== 0);
  call.done = true;
  s.calls.delete(id);
  const loop = loopKey(root, s);
  const result = failed ? errorText(d.error) || contentText(d.content) : contentText(d.content);
  // What the call produced goes to its feed entry and to the recording; neither exists unless the person allowed it.
  if (root.watched.includes(loop)) {
    const patch = finishedEntry(failed, result || null, root.watchedOutput.includes(loop));
    s.activity = s.activity.map((e) => (e.id === id ? { ...e, ...patch } : e));
  }
  root.recorder.outcome(loop, call.tool, call.input, call.recSeq ?? null, result ? { isError: failed, text: result } : undefined, at);
  s.toolCalls++;
  s.lastTool = call.tool;
  s.toolCounts[call.tool] = (s.toolCounts[call.tool] ?? 0) + 1;
  if (!failed) {
    if (call.tool === 'Skill') skillLoaded(root, s, str(d.metadata?.name) ?? str(call.input.skill), at);
    return;
  }
  const cand = candidateFrom(call.tool, call.input, { isError: true, text: result }, at);
  if (!cand) return;
  if (exit !== null) cand.exitCode = exit;
  s.failedCalls[cand.call] = (s.failedCalls[cand.call] ?? 0) + 1;
  // The call a person just refused fails as a result; the refusal stays the cause.
  const denied = freshCandidate(s, at)?.denied ? s.candidate : null;
  if (!denied) s.candidate = cand;
  const cls = classify({ reason: 'error', candidate: denied ?? cand, stopReason: null, blowouts: s.blowoutTimes.length, now: at });
  s.failure = buildFailure(cls ?? 'Tool error', denied ?? cand, evidence({ blowoutTimes: s.blowoutTimes, failedCalls: s.failedCalls, reads: {}, denyText: denied?.denyText ?? null }), at);
  // No `fail` event here: Claude Code raises one when the turn or the agent ends in failure, and so does `session.execution.failed` below (#1012).
}

function ask(root: Root, a: Ask): void {
  root.asks.set(a.id, a);
  emit(root, a.openedAt, 'wait', a.sessionId === root.id ? null : a.sessionId, `waiting: ${a.note}`);
}

/**
 * Folds one event into the store and returns the root it changed, or null when it changes nothing a report shows.
 * `at` is the time to use when the event carries none.
 */
export function apply(store: Store, ev: BusEvent, at: number): Root | null {
  const d = ev.data ?? {};
  const t = whole(typeof ev.created === 'number' && Number.isFinite(ev.created) ? ev.created : at);
  const sid = str(d.sessionID) ?? str(d.form?.sessionID);
  const type = ev.type;
  if (!sid) return null;
  const cwd = str(d.location?.directory) ?? str(ev.location?.directory);
  const parent = type === 'session.created' ? str(d.parentID) : null;
  // A permission or form event for an unknown session must not invent a root out of nothing.
  const known = store.rootOf.has(sid);
  if (!known && !ev.recovered && !type.startsWith('session.')) return null;
  const { root, sess: s } = locate(store, sid, parent, t, cwd);
  // A delete or archive of a root that is already done ends nothing new: it must not reopen it just to end it again (#984).
  const ending = type === 'session.deleted' || type === 'session.archived';
  if (ending && root.done) return root;
  root.lastAt = t;
  s.lastAt = t;
  if (!ending) reopen(root, t);
  root.dirty = true;
  switch (type) {
    case 'session.created':
      s.agent = str(d.agent) ?? s.agent;
      s.title = str(d.title) ?? str(d.slug) ?? s.title;
      break;
    case 'session.renamed':
      s.title = str(d.title) ?? s.title;
      break;
    case 'session.inbox.enqueued': {
      const text = d.item?.payload?.text;
      if (typeof text !== 'string') break;
      if (!s.prompt) {
        s.prompt = text;
        s.promptText = fullText(text) || null;
      }
      // A message from Podium comes back framed; the recording keeps the text that was sent, which is how the server knows it is Podium's.
      const sent = root.sentFromPodium.findIndex((x) => x.framed === text);
      root.recorder.prompt(loopKey(root, s), sent >= 0 ? root.sentFromPodium.splice(sent, 1)[0]!.text : text, t);
      break;
    }
    case 'session.execution.started':
      s.executing = true;
      // The list was true when the session went idle; a new run makes it stale.
      if (root.background) {
        root.background = null;
        root.dirty = true;
      }
      s.end = 'running';
      s.endedAt = null;
      // A new run starts its own count: compactions of an earlier run do not make this run's failure a spent window.
      s.blowoutTimes = [];
      break;
    case 'session.execution.succeeded':
      s.executing = false;
      if (s.id !== root.id) {
        s.end = 'done';
        s.endedAt = t;
        emit(root, t, 'done', s.id, 'finished');
      }
      break;
    case 'session.execution.failed':
    case 'session.execution.interrupted': {
      s.executing = false;
      const aborted = type.endsWith('interrupted');
      s.end = aborted ? 'aborted' : 'failed';
      s.endedAt = t;
      const f = recordFailure(s, aborted ? 'aborted' : 'error', t, errorText(d.error));
      emit(root, t, aborted ? 'end' : 'fail', s.id === root.id ? null : s.id, aborted ? 'interrupted' : 'failed', { class: f.class });
      break;
    }
    case 'session.step.started':
      s.steps++;
      s.model = str(d.model?.id) ?? s.model;
      s.provider = str(d.model?.providerID) ?? s.provider;
      s.agent = str(d.agent) ?? s.agent;
      // The model's variant is the closest thing OpenCode has to an effort level. No variant means the model's default, which is not known.
      if (d.model) s.effort = str(d.model.variant);
      break;
    case 'session.step.ended': {
      const k = tokensOf(d.tokens);
      s.ctxTokens = k.input + k.cacheRead + k.cacheWrite;
      addUsage(s, k);
      break;
    }
    case 'session.step.failed': {
      const f = recordFailure(s, 'error', t, errorText(d.error));
      emit(root, t, 'fail', s.id === root.id ? null : s.id, `step failed: ${errorText(d.error) || 'error'}`, { class: f.class });
      break;
    }
    case 'session.skill.activated':
      skillLoaded(root, s, str(d.name), t);
      break;
    case 'session.usage.updated':
      s.tokens = tokensOf(d.tokens);
      s.costUsd = num(d.cost);
      break;
    case 'session.text.ended': {
      if (typeof d.text !== 'string') break;
      s.answer = d.text;
      const whole = fullText(d.text) || null;
      if (whole !== s.answerText) {
        s.answerText = whole;
        s.answerSent = false;
      }
      const said = activityText(d.text);
      if (said) addActivity(root, s, { at: t, kind: 'text', text: said });
      root.recorder.said(loopKey(root, s), d.text, t);
      break;
    }
    case 'session.reasoning.ended':
      root.recorder.thinking(loopKey(root, s), t);
      break;
    case 'session.tool.input.started': {
      const id = str(d.id);
      if (id) s.calls.set(id, { id, tool: toolName(str(d.name) ?? 'tool'), input: {}, at: t, done: false });
      break;
    }
    case 'session.tool.called': {
      const id = str(d.id);
      if (!id) break;
      const call = s.calls.get(id) ?? { id, tool: toolName(str(d.name) ?? 'tool'), input: {}, at: t, done: false };
      // The name and arguments the Claude Code reporter's wording, feed and recording read: `shell` is Bash, a path is `file_path`.
      const c = canonical(call.tool, d.input && typeof d.input === 'object' ? d.input : {});
      call.tool = c.tool;
      call.input = c.input;
      s.calls.set(id, call);
      if (call.recSeq === undefined) {
        addActivity(root, s, entryFor(call.tool, call.input, id, t));
        call.recSeq = root.recorder.call(loopKey(root, s), call.tool, call.input, t);
      }
      s.lastTool = call.tool;
      if (call.tool === 'TodoWrite' && s.id === root.id) {
        root.plan = todoWrite(root.plan, d.input);
        emit(root, t, 'plan', null, 'plan updated');
      }
      break;
    }
    case 'session.tool.success':
      finishCall(root, s, d, t, false);
      break;
    case 'session.tool.failed':
      finishCall(root, s, d, t, true);
      break;
    case 'permission.asked': {
      const id = str(d.id);
      // Only the string resources: a structured one would read as "[object Object]" in the note (#1012).
      const resources: string[] = Array.isArray(d.resources) ? d.resources.filter((r: unknown): r is string => typeof r === 'string') : [];
      if (id) ask(root, { id, kind: 'permission', sessionId: sid, openedAt: t, ...(str(d.source?.id) ? { callId: str(d.source.id)! } : {}), note: clip([str(d.action), ...resources.slice(0, 2)].filter(Boolean).join(' '), 160), action: str(d.action) ?? 'permission', resources });
      break;
    }
    case 'permission.replied': {
      const open = root.asks.get(String(d.requestID ?? ''));
      // A refused permission is the likeliest cause of what fails next in that session.
      if (open && d.reply === 'reject') {
        const owner = root.sessions.get(open.sessionId) ?? s;
        owner.candidate = candidateFrom(open.action ?? 'permission', { resources: (open.resources ?? []).join(' ') }, { deny: 'permission rejected' }, t);
      }
      root.asks.delete(String(d.requestID ?? ''));
      break;
    }
    case 'form.created': {
      const id = str(d.form?.id);
      if (id) ask(root, { id, kind: 'question', sessionId: sid, openedAt: t, note: clip(str(d.form?.fields?.[0]?.title) ?? str(d.form?.title) ?? 'question', 160), fields: formFields(d.form?.fields) });
      break;
    }
    case 'form.replied':
    case 'form.cancelled':
      root.asks.delete(String(d.id ?? d.form?.id ?? ''));
      break;
    case 'session.compaction.started':
      root.compacting = true;
      // The mark belongs to the loop that compacts; the /compact Podium sent is the orchestrator's.
      root.recorder.compact(loopKey(root, s), t, s.id === root.id ? (root.podiumCompact ?? undefined) : undefined);
      if (s.id === root.id) root.podiumCompact = null;
      break;
    case 'session.compaction.ended':
    case 'session.compaction.failed': {
      root.compacting = false;
      root.compactions++;
      const failed = type.endsWith('failed');
      const auto = d.reason === 'auto';
      // The compaction's own usage is the summary it wrote: that is about what the context holds now. The next step ends with the real size.
      const before = s.ctxTokens;
      const after = failed || !count(d.tokens?.output) ? before : count(d.tokens?.output);
      if (!failed) s.ctxTokens = after;
      if (auto && !failed) {
        s.blowouts++;
        s.blowoutTimes = [...s.blowoutTimes, t].slice(-20);
      }
      const label = failed ? 'compaction failed' : auto ? 'auto-compacted' : 'compacted';
      emit(root, t, 'compact', s.id === root.id ? null : s.id, label, { trigger: auto ? 'auto' : 'manual', tokensBefore: before, tokensAfter: after });
      break;
    }
    case 'session.deleted':
    case 'session.archived':
      if (s.id === root.id) finish(root, t, type.endsWith('deleted') ? 'deleted' : 'archived');
      break;
    case 'session.unarchived':
      break;
    default:
      break;
  }
  return root;
}

/** Marks a root done. Everything it launched that still runs is finished with it. */
export function finish(root: Root, at: number, reason: string): void {
  if (root.done) return;
  root.done = true;
  root.endReason = reason;
  root.dirty = true;
  root.asks.clear();
  for (const s of root.sessions.values()) {
    s.executing = false;
    if (s.end === 'running' && s.id !== root.id) s.end = 'aborted';
  }
  emit(root, at, 'end', null, `session ended (${reason})`);
}

/** Whether a root is quiet: nothing runs, nothing is open, and nothing happened for `idleMs`. */
export function idleFor(root: Root, now: number, idleMs: number): boolean {
  if (root.done || root.asks.size > 0 || root.compacting) return false;
  for (const s of root.sessions.values()) if (s.executing) return false;
  return now - root.lastAt >= idleMs;
}

/**
 * Finishes every root that has been quiet for `idleMs`. Returns the roots it finished. While `hold` is set (a TUI is attached,
 * so the session is open and can be messaged) nothing is finished for being quiet (#984).
 */
export function sweep(store: Store, now: number, idleMs: number, hold = false): Root[] {
  const out: Root[] = [];
  if (hold) return out;
  for (const r of store.roots.values()) {
    if (idleFor(r, now, idleMs)) {
      finish(r, now, 'idle');
      out.push(r);
    }
  }
  return out;
}

/** One job `experimental.idle` lists: a shell has a `command`, a subagent a `description`. */
export interface IdleJob {
  kind: string;
  command?: string;
  description?: string;
}

/** The most background tasks a report may carry (SPEC 6.2, and the server's limit: more is a rejected report). */
const MAX_BACKGROUND_TASKS = 20;

/** The first word of a shell command that is not a `NAME=value` assignment, without its folder: all of the command that is ever sent. */
function firstWord(command: string | undefined): string {
  const word = (command ?? '').trim().split(/\s+/).find((w) => w !== '' && !w.includes('='));
  return word?.split('/').pop() || 'shell';
}

/** The work an idle root still runs, as a background wait: a shell by its first word, never its command. */
export function setBackground(root: Root, jobs: readonly IdleJob[]): void {
  const tasks: BackgroundWait['tasks'] = jobs.slice(0, MAX_BACKGROUND_TASKS).map((j) => {
    if (j.kind === 'shell') return { type: 'shell', description: clip(firstWord(j.command), 60), status: 'running' };
    if (j.kind === 'subagent') return { type: 'agent', description: excerpt(j.description, 120) || 'subagent', status: 'running' };
    return { type: 'other', description: j.kind === 'image' ? 'image' : 'background work', status: 'running' };
  });
  const next = tasks.length ? { tasks, wakeAt: null } : null;
  if (JSON.stringify(next) === JSON.stringify(root.background)) return;
  root.background = next;
  root.dirty = true;
}
