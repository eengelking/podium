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
 * How long after its last report a wait is still counted. A reporter sends every few seconds while a session waits (5 s by default), so a longer silence
 * means the session was offline (a laptop asleep, a reporter that died), and that time is not time spent waiting on a person.
 */
export const WAIT_GAP_MS = 120_000;

/**
 * The row after a report at `now` that found the session waiting for `kind` (null for nothing), or null when the stored row needs no write.
 * `lastSeenBefore` is when the session was last heard from before this report. A wait ends at the first report that no longer shows it, so its time is
 * counted to the reporting interval; when the silence before this report was longer than `WAIT_GAP_MS`, the wait is counted only to the end of that
 * allowance and a wait that still shows starts again from now. A clock that steps back counts zero.
 */
export function advanceWait(prev: SessionWaitRow | undefined, kind: WaitKind | null, id: string, now: number, lastSeenBefore: number | null = null): SessionWaitRow | null {
  const base = prev ?? fresh(id, now);
  const gapped = lastSeenBefore !== null && now - lastSeenBefore > WAIT_GAP_MS;
  if (base.open_kind === kind && !gapped) return prev ? null : base;
  const next: SessionWaitRow = { ...base };
  if (base.open_kind !== null && base.open_since !== null) {
    const endsAt = gapped && lastSeenBefore !== null ? lastSeenBefore + WAIT_GAP_MS : now;
    const ms = Math.max(0, Math.round(endsAt - base.open_since));
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
