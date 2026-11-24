// A session's background shells and monitors in the Claude Code reporter (#897). Pure: each function takes a SessionState and returns the next one. The
// register module finds the tasks (a Bash call with `run_in_background`, a Monitor call, the Stop and SubagentStop hooks' `background_tasks`) and reads
// their output files through `$.fs`; this file holds what it learned and turns it into the items a report carries.
import { backgroundItem, exitCodeOf, keepBackground, loopChain, outputTimes, readTail, withoutExitLine, type OutputFs, type RawBackgroundItem } from '../../core/background.ts';
import { MAIN_LOOP, type BackgroundItem } from '../../core/protocol.ts';
import { ARTIFACT_WATCHER, TASK_DONE, type BgTask, type SessionState } from './state.ts';

/** Tasks the session holds at most; a finished one is dropped first, oldest first. */
const MAX_TASKS = 200;

const loopOf = (t: BgTask): string => t.agentId ?? MAIN_LOOP;

/** The loops a task's owner sits under (#1242): the owner, each parent up to the orchestrator. */
const chainOf = (s: SessionState, owner: string): string[] => loopChain(owner, (id) => s.agents[id]?.parentId, MAX_TASKS);

const trimTasks = (bg: BgTask[]): BgTask[] => {
  if (bg.length <= MAX_TASKS) return bg;
  const drop = new Set(bg.filter((t) => t.exited).slice(0, bg.length - MAX_TASKS));
  const kept = bg.filter((t) => !drop.has(t));
  return kept.length > MAX_TASKS ? kept.slice(kept.length - MAX_TASKS) : kept;
};

/**
 * A Bash call with `run_in_background`, or a Monitor call, just returned the id Claude Code gave the task (`backgroundTaskId`, `taskId`). The task belongs to
 * the agent whose call it was (null: the orchestrator's). A task already held is left as it is.
 */
export function bgStarted(s: SessionState, i: { id: string; kind: 'shell' | 'monitor'; command: string; agentId: string | null | undefined; now: number }): SessionState {
  const existing = s.bg.find((t) => t.id === i.id);
  if (existing) {
    // The Stop hook may have listed it first as a shell, with no owner better than the hook's; the call that started it knows both.
    const agentId = i.agentId ?? null;
    if (existing.kind === i.kind && existing.agentId === agentId && (existing.command !== '' || i.command === '')) return s;
    return { ...s, bg: s.bg.map((t) => (t.id === i.id ? { ...t, kind: i.kind, agentId, command: t.command || i.command } : t)), dirty: true };
  }
  const task: BgTask = { id: i.id, kind: i.kind, agentId: i.agentId ?? null, command: i.command, startedAt: i.now, exited: false, endedAt: null, exitCode: null, lastOutputAt: null, output: null, outputCutAtStart: false, settled: false };
  return { ...s, bg: trimTasks([...s.bg, task]), dirty: true };
}

/** One entry of a Stop or SubagentStop hook's `background_tasks`. */
export interface ListedTask {
  id?: string;
  type?: string;
  status?: string;
  description?: string;
  command?: string;
}

/**
 * What a Stop (`sessionWide`, the orchestrator's: it lists every task of the session) or a SubagentStop hook says is in flight. A shell or monitor not held yet
 * (it started before the reporter loaded, or by a call the reporter did not see) is added under `owner`, the loop of the hook. A held task the list calls
 * finished is marked exited. A Stop that no longer lists a task still running means it ended and was cleared: it is marked exited, with no code.
 * Subagents and workflows are not shells; they stay in the agent list.
 */
export function bgListed(s: SessionState, tasks: readonly ListedTask[], owner: string | null, sessionWide: boolean, now: number): SessionState {
  let bg = s.bg;
  const seen = new Set<string>();
  const change = (id: string, fn: (t: BgTask) => BgTask) => {
    bg = bg.map((t) => (t.id === id ? fn(t) : t));
  };
  for (const l of tasks) {
    const type = (l.type ?? '').toLowerCase();
    if (!l.id || (type !== 'shell' && type !== 'bash' && type !== 'monitor')) continue;
    if (type === 'monitor' && ARTIFACT_WATCHER.test((l.description ?? '').trim())) continue;
    seen.add(l.id);
    const done = TASK_DONE.test(l.status || 'running');
    const held = bg.find((t) => t.id === l.id);
    if (!held) {
      const kind: BgTask['kind'] = type === 'monitor' ? 'monitor' : 'shell';
      bg = trimTasks([...bg, { id: l.id, kind, agentId: owner, command: l.command ?? '', startedAt: now, exited: done, endedAt: done ? now : null, exitCode: null, lastOutputAt: null, output: null, outputCutAtStart: false, settled: false }]);
    } else {
      if (done && !held.exited) change(l.id, (t) => ({ ...t, exited: true, endedAt: now, settled: false }));
      if (!held.command && l.command) change(l.id, (t) => ({ ...t, command: l.command ?? '' }));
    }
  }
  if (sessionWide) for (const t of s.bg) if (!t.exited && !seen.has(t.id)) change(t.id, (x) => ({ ...x, exited: true, endedAt: now, settled: false }));
  return bg === s.bg ? s : { ...s, bg, dirty: true };
}

export type BgFilePatch = Partial<Pick<BgTask, 'exited' | 'endedAt' | 'exitCode' | 'lastOutputAt' | 'output' | 'outputCutAtStart' | 'settled'>>;

/** What reading a task's output file found. Nothing changes, and the session is not dirtied, when it is what is already held. */
export function bgFile(s: SessionState, id: string, patch: BgFilePatch): SessionState {
  const t = s.bg.find((x) => x.id === id);
  if (!t) return s;
  const next = { ...t, ...patch };
  const same = (Object.keys(patch) as (keyof BgFilePatch)[]).every((k) => t[k] === next[k]);
  const visible = (Object.keys(patch) as (keyof BgFilePatch)[]).some((k) => k !== 'settled' && t[k] !== next[k]);
  if (same) return s;
  return { ...s, bg: s.bg.map((x) => (x.id === id ? next : x)), ...(visible ? { dirty: true } : {}) };
}

/** The loops a viewer has the Background tab open on. A loop that drops off the list forgets the whole command's output its tasks held. */
export function setWatchedBackground(s: SessionState, ids: readonly string[]): SessionState {
  const next = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  if (next.length === s.watchedBackground.length && next.every((id, i) => id === s.watchedBackground[i])) return s;
  // A task keeps its output while its owner, or any loop above its owner, is on the list (#1242): that loop's list carries it too.
  const bg = s.bg.map((t) => (chainOf(s, loopOf(t)).some((l) => next.includes(l)) || (t.output === null && !t.settled) ? t : { ...t, output: null, outputCutAtStart: false, settled: false }));
  return { ...s, watchedBackground: next, bg, dirty: s.bg.length > 0 ? true : s.dirty };
}

/** The folder a hook's `scratchpad_dir` names the task output files in: the `tasks` folder beside it. */
export function tasksDirOf(scratchpadDir: unknown): string | null {
  if (typeof scratchpadDir !== 'string' || scratchpadDir === '') return null;
  // A loop, not a regex, so a long run of separators at the end cannot make it slow.
  let end = scratchpadDir.length;
  while (end > 0 && (scratchpadDir[end - 1] === '/' || scratchpadDir[end - 1] === '\\')) end--;
  const trimmed = scratchpadDir.slice(0, end);
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut <= 0 ? null : `${trimmed.slice(0, cut)}${trimmed[cut]}tasks`;
}

/** Remembers the output folder; a changed one is taken, so a session that moves reads from where Claude Code writes now. */
export function setTasksDir(s: SessionState, dir: string | null): SessionState {
  if (!dir || dir === s.tasksDir) return s;
  return { ...s, tasksDir: dir };
}

/**
 * The items a loop's list makes in a report: the label, state and times always, the whole command and the output with `detail` (#897). A loop lists
 * what it started and what every agent under it started, nested ones included (#1242), so the orchestrator lists the whole session's and never another
 * orchestrator's. An item a descendant started carries its owner's id; one the loop started itself carries none. An owner that has finished keeps its items.
 */
export function bgItems(s: SessionState, loop: string, detail: boolean): BackgroundItem[] {
  const items = s.bg
    .filter((t) => chainOf(s, loopOf(t)).includes(loop))
    .map((t) => {
      const raw: RawBackgroundItem = {
        id: t.id,
        kind: t.kind,
        state: t.exited ? 'exited' : 'running',
        startedAt: t.startedAt,
        startedKnown: false,
        command: t.command,
      };
      if (t.exited && t.exitCode !== null) raw.exitCode = t.exitCode;
      if (t.exited && t.endedAt !== null) raw.endedAt = t.endedAt;
      if (t.lastOutputAt !== null) raw.lastOutputAt = t.lastOutputAt;
      if (detail && t.output !== null) {
        raw.output = t.output;
        raw.outputCutAtStart = t.outputCutAtStart;
      }
      const item = backgroundItem(raw, detail);
      if (loopOf(t) !== loop) item.ownerId = loopOf(t);
      return item;
    });
  return keepBackground(items);
}

/** A background task's id as Claude Code names it: a short token, never a path. */
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The task a Bash call with `run_in_background` or a Monitor call started, from what its result carries; null for any other call. */
export function backgroundStartOf(tool: string, input: Record<string, unknown>, call: Record<string, unknown>): { id: string; kind: 'shell' | 'monitor'; command: string } | null {
  // The tool's own result record is under `result`, as the Bash output is for `finishedCall`.
  const res = typeof call.result === 'object' && call.result !== null ? (call.result as Record<string, unknown>) : call;
  if (tool === 'Bash' && input.run_in_background === true && typeof res.backgroundTaskId === 'string' && TASK_ID.test(res.backgroundTaskId)) {
    return { id: res.backgroundTaskId, kind: 'shell', command: typeof input.command === 'string' ? input.command : '' };
  }
  if (tool === 'Monitor' && typeof res.taskId === 'string' && TASK_ID.test(res.taskId)) {
    return { id: res.taskId, kind: 'monitor', command: typeof input.command === 'string' ? input.command : '' };
  }
  return null;
}

/**
 * For each background task of a watched loop, reads the output file Claude Code writes in the folder a hook named (#897): when it last printed, the exit code
 * its last line states and, with the option and a viewer on the Background tab, its newest output. It returns what it found and changes nothing: the caller
 * keeps it. Locally only: what is read stays in this process until a report carries it, and a report carries output only for a loop in `watchBackground`. No
 * folder known, no file, a link or a refusal is no output. A file that has not changed since it was read is not read again.
 */
export async function readBackground(fs: OutputFs, s: SessionState, backgroundOutput: boolean, now: number): Promise<{ id: string; patch: BgFilePatch }[]> {
  const out: { id: string; patch: BgFilePatch }[] = [];
  const dir = s.tasksDir;
  if (!dir) return out;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  for (const t of s.bg) {
    // A task is read for any loop above its owner that is watched: its output shows in that loop's list too (#1242).
    const chain = chainOf(s, loopOf(t));
    if (!TASK_ID.test(t.id) || !chain.some((l) => s.watched.includes(l))) continue;
    const detail = backgroundOutput && chain.some((l) => s.watchedBackground.includes(l));
    if (t.settled && (!detail || t.output !== null)) continue;
    const file = `${dir}${sep}${t.id}.output`;
    const seen = await outputTimes(fs, file, dir);
    if (seen.ok && t.lastOutputAt !== null && Math.round(seen.mtimeMs) === t.lastOutputAt && (!detail || t.output !== null)) {
      if (t.exited && !t.settled) out.push({ id: t.id, patch: { settled: true } });
      continue;
    }
    const got = await readTail(fs, file, dir);
    if (!got.ok) {
      if (t.exited) out.push({ id: t.id, patch: { settled: true } });
      continue;
    }
    const code = exitCodeOf(got.text);
    const patch: BgFilePatch = { lastOutputAt: got.size > 0 ? Math.round(got.mtimeMs) : null, settled: t.exited || code !== null };
    if (code !== null) Object.assign(patch, { exited: true, exitCode: code, ...(t.exited ? {} : { endedAt: now }) });
    if (detail) Object.assign(patch, { output: withoutExitLine(got.text), outputCutAtStart: got.cutAtStart });
    out.push({ id: t.id, patch });
  }
  return out;
}
