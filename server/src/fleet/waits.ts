// Time a session spends blocked on its person (#722). A wait is a tool asking for permission, a plan waiting for approval or a question
// waiting for an answer. A session idle at the prompt is not one: every harness reports that as `waiting` too, with the reason `input`.
// The kind comes from fields every report already carries, so no reporter changes. Only the kind and the time are kept.
import type { SessionWaitRow } from '../storage/rows.js';
import { HOOKS_REPORTER_VERSION } from './hookIngest.js';

export type WaitKind = 'permission' | 'question' | 'plan';

/** What a stored session says about what it waits for. */
export interface WaitInput {
  waitReason: string | null;
  waitNote: string | null;
  reporterVersion: string | null;
}

/** The tool a permission note starts with (`Bash(npm test)` or `ExitPlanMode`), or '' when it starts with a sentence. */
function toolOf(note: string | null): string {
  return /^([A-Za-z][A-Za-z0-9_.:-]*)(?:\(|$)/.exec(note ?? '')?.[1] ?? '';
}

/**
 * What the session waits for, or null when it waits on nothing the person has to answer.
 *
 * - `permission` is a tool dialog. Claude Code asks a question and a plan approval through the same dialog, so the tool's name in the note
 *   says which: `AskUserQuestion` is a question and `ExitPlanMode` is a plan.
 * - `input` with no note is a session idle at the prompt (Claude Code and OpenCode), which is not a wait.
 * - `input` with a note is a question from OpenCode. The settings hooks also send a message with their idle prompt, so a session reported by the
 *   `hooks` pseudo-reporter never counts here.
 */
export function waitKindOf(s: WaitInput): WaitKind | null {
  if (s.waitReason === 'permission') {
    const tool = toolOf(s.waitNote);
    return tool === 'ExitPlanMode' ? 'plan' : tool === 'AskUserQuestion' ? 'question' : 'permission';
  }
  if (s.waitReason === 'input' && s.waitNote && s.reporterVersion !== HOOKS_REPORTER_VERSION) return 'question';
  return null;
}

const fresh = (id: string, now: number): SessionWaitRow => ({ session_id: id, permission_ms: 0, permission_n: 0, question_ms: 0, question_n: 0, plan_ms: 0, plan_n: 0, tracked_since: now, open_kind: null, open_since: null });

/**
 * The row after a report at `now` that found the session waiting for `kind` (null for nothing), or null when the stored row needs no write.
 * A wait ends at the first report that no longer shows it, so its time is counted to the reporting interval. A clock that steps back counts zero.
 */
export function advanceWait(prev: SessionWaitRow | undefined, kind: WaitKind | null, id: string, now: number): SessionWaitRow | null {
  const base = prev ?? fresh(id, now);
  if (base.open_kind === kind) return prev ? null : base;
  const next: SessionWaitRow = { ...base };
  if (base.open_kind !== null && base.open_since !== null) {
    const ms = Math.max(0, Math.round(now - base.open_since));
    next[`${base.open_kind}_ms`] += ms;
    next[`${base.open_kind}_n`] += 1;
  }
  next.open_kind = kind;
  next.open_since = kind === null ? null : now;
  return next;
}

/** The wait still open on a stored session, counted to the last time the session was seen and not past it, or null when none is open. */
export function waitOfOpen(w: SessionWaitRow, lastSeenAt: number): { kind: WaitKind; ms: number } | null {
  if (w.open_kind === null || w.open_since === null) return null;
  return { kind: w.open_kind, ms: Math.max(0, lastSeenAt - w.open_since) };
}
