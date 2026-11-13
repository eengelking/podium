// Time a session spends blocked on its person (#722): what counts as a wait, and how the time adds up across reports.
import { describe, it, expect } from 'vitest';
import { advanceWait, waitKindOf, waitOfOpen, WAIT_GAP_MS, type WaitInput } from './waits.js';

const w = (o: Partial<WaitInput>): WaitInput => ({ waitReason: null, waitNote: null, reporterVersion: '1.2.2', ...o });

describe('waitKindOf', () => {
  it('counts a tool permission as a permission, and names the plan and question tools', () => {
    expect(waitKindOf(w({ waitReason: 'permission', waitNote: 'Bash(npm test)' }))).toBe('permission');
    expect(waitKindOf(w({ waitReason: 'permission', waitNote: 'ExitPlanMode(plan: ...)' }))).toBe('plan');
    expect(waitKindOf(w({ waitReason: 'permission', waitNote: 'ExitPlanMode' }))).toBe('plan');
    expect(waitKindOf(w({ waitReason: 'permission', waitNote: 'AskUserQuestion(Which one?)' }))).toBe('question');
    // a notification's sentence is not a tool name
    expect(waitKindOf(w({ waitReason: 'permission', waitNote: 'Claude needs your permission to use Bash' }))).toBe('permission');
    expect(waitKindOf(w({ waitReason: 'permission', waitNote: null }))).toBe('permission');
  });

  it('does not count a session sitting idle at the prompt, which every harness reports as input with no note', () => {
    expect(waitKindOf(w({ waitReason: 'input', waitNote: null }))).toBeNull();
  });

  it('counts input with a note as a question when a reporter sent it, as OpenCode does', () => {
    expect(waitKindOf(w({ waitReason: 'input', waitNote: 'Which database?' }))).toBe('question');
  });

  it('does not count input from the settings hooks, where the idle prompt carries a message', () => {
    expect(waitKindOf(w({ waitReason: 'input', waitNote: 'Claude is waiting for your input', reporterVersion: 'hooks' }))).toBeNull();
  });

  it('counts nothing for a session that is not waiting', () => {
    expect(waitKindOf(w({}))).toBeNull();
  });
});

describe('advanceWait', () => {
  const T = 1_000_000;

  it('starts tracking at the first report and opens a wait when the session is already blocked', () => {
    const idle = advanceWait(undefined, null, 's', T)!;
    expect(idle).toMatchObject({ session_id: 's', tracked_since: T, open_kind: null, open_since: null, permission_ms: 0 });
    const blocked = advanceWait(undefined, 'permission', 's', T)!;
    expect(blocked).toMatchObject({ tracked_since: T, open_kind: 'permission', open_since: T });
  });

  it('writes nothing when the state has not changed', () => {
    const open = advanceWait(undefined, 'question', 's', T)!;
    expect(advanceWait(open, 'question', 's', T + 5000)).toBeNull();
    const idle = advanceWait(undefined, null, 's', T)!;
    expect(advanceWait(idle, null, 's', T + 5000)).toBeNull();
  });

  it('adds the time of a closed wait to its kind and counts the wait', () => {
    const open = advanceWait(undefined, 'permission', 's', T)!;
    const closed = advanceWait(open, null, 's', T + 12_500)!;
    expect(closed).toMatchObject({ permission_ms: 12_500, permission_n: 1, open_kind: null, open_since: null });
    const again = advanceWait(advanceWait(closed, 'permission', 's', T + 20_000)!, null, 's', T + 21_000)!;
    expect(again).toMatchObject({ permission_ms: 13_500, permission_n: 2 });
  });

  it('closes one kind and opens the next when the wait changes kind', () => {
    const q = advanceWait(undefined, 'question', 's', T)!;
    const p = advanceWait(q, 'plan', 's', T + 3000)!;
    expect(p).toMatchObject({ question_ms: 3000, question_n: 1, open_kind: 'plan', open_since: T + 3000 });
  });

  it('never counts a negative time when the clock steps back', () => {
    const open = advanceWait(undefined, 'plan', 's', T)!;
    expect(advanceWait(open, null, 's', T - 9000)).toMatchObject({ plan_ms: 0, plan_n: 1 });
  });
});

describe('advanceWait across a gap in the reports', () => {
  const T = 1_000_000;
  const HOUR = 3_600_000;

  it('does not count the time a session was offline as waiting, when a report shows the wait over', () => {
    const open = advanceWait(undefined, 'permission', 's', T)!;
    // the last report that showed the wait came at T + 4 s, then nothing for six hours
    const closed = advanceWait(open, null, 's', T + 6 * HOUR, T + 4000)!;
    expect(closed).toMatchObject({ permission_ms: 4000 + WAIT_GAP_MS, permission_n: 1, open_kind: null });
  });

  it('closes the wait before the gap and opens a new one when the session is still waiting after it', () => {
    const open = advanceWait(undefined, 'question', 's', T)!;
    const again = advanceWait(open, 'question', 's', T + 6 * HOUR, T + 4000)!;
    expect(again).toMatchObject({ question_ms: 4000 + WAIT_GAP_MS, question_n: 1, open_kind: 'question', open_since: T + 6 * HOUR });
  });

  it('counts a long wait whose reports keep coming as one wait', () => {
    const open = advanceWait(undefined, 'plan', 's', T)!;
    expect(advanceWait(open, 'plan', 's', T + 20 * 60_000, T + 20 * 60_000 - 5000)).toBeNull();
    expect(advanceWait(open, null, 's', T + 20 * 60_000, T + 20 * 60_000 - 5000)).toMatchObject({ plan_ms: 20 * 60_000, plan_n: 1 });
  });
});

describe('waitOfOpen', () => {
  it('counts a wait still open to the last time the session was seen, and not past it', () => {
    const open = advanceWait(undefined, 'question', 's', 1000)!;
    expect(waitOfOpen(open, 9000)).toEqual({ kind: 'question', ms: 8000 });
    expect(waitOfOpen(open, 500)).toEqual({ kind: 'question', ms: 0 });
    expect(waitOfOpen(advanceWait(undefined, null, 's', 1000)!, 9000)).toBeNull();
  });
});
