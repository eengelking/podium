// What the OpenCode reporter knows about its sessions (#855). Pure: no engine API, no clock of its own, no network.
// `apply` folds one bus event into a Store; report.ts turns a Root into a v2 report. A root session and the child
// sessions it launched are one Root and one report; a child is an agent in that report.
import { clip, candidateFrom, classify, buildFailure, LIMITS } from '../core/failures.ts';
import { emptyPlan, todoWrite, type PlanState } from '../core/plan.ts';
import type { ActivityEvent, Failure, GitInfo } from '../core/protocol.ts';

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
  prompt: string;
  answer: string;
  failure: Failure | null;
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
  /** Events for the next report. */
  events: ActivityEvent[];
  seq: number;
  /** Whether something changed since the last report went out. */
  dirty: boolean;
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
  'session.usage.updated', 'session.text.ended',
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
    toolCounts: {}, lastTool: null, steps: 0, prompt: '', answer: '', failure: null,
  };
}

function newRoot(id: string, cwd: string | null, at: number): Root {
  return {
    id, cwd, startedAt: at, lastAt: at, sessions: new Map([[id, newSess(id, null, at)]]), children: [], plan: emptyPlan,
    asks: new Map(), compacting: false, compactions: 0, done: false, endReason: null, git: null, events: [], seq: 0, dirty: true,
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** `session.usage.updated` and `session.step.ended` carry tokens as `{input, output, reasoning, cache: {read, write}}`. */
export function tokensOf(t: any): Tokens {
  return {
    input: num(t?.input),
    // Reasoning tokens are billed as output.
    output: num(t?.output) + num(t?.reasoning),
    cacheRead: num(t?.cache?.read),
    cacheWrite: num(t?.cache?.write),
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

function finishCall(root: Root, s: Sess, d: Record<string, any>, at: number, failed: boolean): void {
  const id = str(d.id);
  if (!id) return;
  const call = s.calls.get(id) ?? { id, tool: 'tool', input: {}, at, done: false };
  call.done = true;
  s.calls.delete(id);
  s.toolCalls++;
  s.lastTool = call.tool;
  s.toolCounts[call.tool] = (s.toolCounts[call.tool] ?? 0) + 1;
  if (!failed) return;
  const text = errorText(d.error) || contentText(d.content);
  const cand = candidateFrom(call.tool, call.input, { isError: true, text }, at);
  if (!cand) return;
  const cls = classify({ reason: 'error', candidate: cand, stopReason: null, blowouts: 0, now: at });
  s.failure = buildFailure(cls ?? 'Tool error', cand, [], at);
  emit(root, at, 'fail', s.id === root.id ? null : s.id, `${call.tool} failed`, { class: s.failure.class });
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
  const t = typeof ev.created === 'number' ? ev.created : at;
  const sid = str(d.sessionID) ?? str(d.form?.sessionID);
  const type = ev.type;
  if (!sid) return null;
  const cwd = str(d.location?.directory) ?? str(ev.location?.directory);
  const parent = type === 'session.created' ? str(d.parentID) : null;
  // A permission or form event for an unknown session must not invent a root out of nothing.
  const known = store.rootOf.has(sid);
  if (!known && !ev.recovered && !type.startsWith('session.')) return null;
  const { root, sess: s } = locate(store, sid, parent, t, cwd);
  root.lastAt = t;
  s.lastAt = t;
  reopen(root, t);
  root.dirty = true;
  switch (type) {
    case 'session.created':
      s.agent = str(d.agent) ?? s.agent;
      s.title = str(d.title) ?? str(d.slug) ?? s.title;
      break;
    case 'session.renamed':
      s.title = str(d.title) ?? s.title;
      break;
    case 'session.inbox.enqueued':
      if (!s.prompt && typeof d.item?.payload?.text === 'string') s.prompt = d.item.payload.text;
      break;
    case 'session.execution.started':
      s.executing = true;
      s.end = 'running';
      s.endedAt = null;
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
      const cls = classify({ reason: aborted ? 'aborted' : 'error', candidate: null, stopReason: null, blowouts: 0, now: t });
      if (cls) s.failure = buildFailure(cls, null, [], t);
      emit(root, t, aborted ? 'end' : 'fail', s.id === root.id ? null : s.id, aborted ? 'interrupted' : 'failed', cls ? { class: cls } : null);
      break;
    }
    case 'session.step.started':
      s.steps++;
      s.model = str(d.model?.id) ?? s.model;
      s.provider = str(d.model?.providerID) ?? s.provider;
      s.agent = str(d.agent) ?? s.agent;
      break;
    case 'session.step.ended': {
      const k = tokensOf(d.tokens);
      s.ctxTokens = k.input + k.cacheRead + k.cacheWrite;
      break;
    }
    case 'session.step.failed': {
      const cls = classify({ reason: 'error', candidate: null, stopReason: null, blowouts: 0, now: t });
      if (cls) s.failure = buildFailure(cls, null, [], t);
      emit(root, t, 'fail', s.id === root.id ? null : s.id, `step failed: ${errorText(d.error) || 'error'}`, cls ? { class: cls } : null);
      break;
    }
    case 'session.usage.updated':
      s.tokens = tokensOf(d.tokens);
      s.costUsd = num(d.cost);
      break;
    case 'session.text.ended':
      if (typeof d.text === 'string') s.answer = d.text;
      break;
    case 'session.tool.input.started': {
      const id = str(d.id);
      if (id) s.calls.set(id, { id, tool: str(d.name) ?? 'tool', input: {}, at: t, done: false });
      break;
    }
    case 'session.tool.called': {
      const id = str(d.id);
      if (!id) break;
      const call = s.calls.get(id) ?? { id, tool: str(d.name) ?? 'tool', input: {}, at: t, done: false };
      call.input = d.input && typeof d.input === 'object' ? d.input : {};
      s.calls.set(id, call);
      s.lastTool = call.tool;
      if (call.tool === 'todowrite' && s.id === root.id) {
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
      if (id) ask(root, { id, kind: 'permission', sessionId: sid, openedAt: t, note: clip([str(d.action), ...(Array.isArray(d.resources) ? d.resources.slice(0, 2) : [])].filter(Boolean).join(' '), 160), action: str(d.action) ?? 'permission', resources: Array.isArray(d.resources) ? d.resources.filter((r: unknown): r is string => typeof r === 'string') : [] });
      break;
    }
    case 'permission.replied':
      root.asks.delete(String(d.requestID ?? ''));
      break;
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
      break;
    case 'session.compaction.ended':
    case 'session.compaction.failed':
      root.compacting = false;
      root.compactions++;
      emit(root, t, 'compact', null, type.endsWith('failed') ? 'compaction failed' : 'compacted');
      break;
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

/** Finishes every root that has been quiet for `idleMs`. Returns the roots it finished. */
export function sweep(store: Store, now: number, idleMs: number): Root[] {
  const out: Root[] = [];
  for (const r of store.roots.values()) {
    if (idleFor(r, now, idleMs)) {
      finish(r, now, 'idle');
      out.push(r);
    }
  }
  return out;
}
