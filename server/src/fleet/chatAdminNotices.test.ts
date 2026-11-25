// The notices an Admin's stop shows a person's reporter sessions (#1034): held 5 minutes, at most 8 for a session, one sentence of at most 300 characters. Pinned before a
// Direct Message moves to the conversation tables (#1296), because no other test asserts the hold or the cap by itself.
import { describe, it, expect } from 'vitest';
import { AdminNotices, NOTICE_TTL_MS } from './chatAdminNotices.js';

const T0 = 1_800_000_000_000;

describe('the notices held for a reporter session', () => {
  it('hands a notice over in every reply for 5 minutes, and not a millisecond longer', () => {
    expect(NOTICE_TTL_MS).toBe(5 * 60_000);
    let clock = T0;
    const notices = new AdminNotices(() => clock);
    notices.push('s1', 'Root paused your group.');
    clock += NOTICE_TTL_MS - 1;
    expect(notices.for('s1').map((n) => n.text)).toEqual(['Root paused your group.']);
    expect(notices.for('s1')).toHaveLength(1);
    clock += 1;
    expect(notices.for('s1')).toEqual([]);
  });

  it('keeps the newest 8 for a session, oldest first, and leaves another session\'s alone', () => {
    let clock = T0;
    const notices = new AdminNotices(() => clock);
    for (let i = 0; i < 10; i++) {
      notices.push('s1', `stop ${i}`);
      clock += 1000;
    }
    notices.push('s2', 'only one');
    expect(notices.for('s1').map((n) => n.text)).toEqual(['stop 2', 'stop 3', 'stop 4', 'stop 5', 'stop 6', 'stop 7', 'stop 8', 'stop 9']);
    expect(notices.for('s2').map((n) => n.text)).toEqual(['only one']);
  });

  it('cuts a notice to 300 characters on one line, and replaces the same words said again instead of adding a second', () => {
    let clock = T0;
    const notices = new AdminNotices(() => clock);
    notices.push('s1', `${'x'.repeat(295)}  \n  tail beyond the limit`);
    const [held] = notices.for('s1');
    expect(held!.text).toHaveLength(300);
    expect(held!.text).not.toContain('\n');
    notices.push('s1', 'Root paused your group.');
    clock += 1000;
    notices.push('s1', 'Root paused your group.');
    const again = notices.for('s1');
    expect(again.map((n) => n.text)).toEqual([held!.text, 'Root paused your group.']);
    // The repeat is a new notice with a new id, so a reporter shows it again.
    expect(new Set(again.map((n) => n.id)).size).toBe(2);
  });

  it('gives every notice an id of its own', () => {
    const notices = new AdminNotices(() => T0);
    notices.push('s1', 'one');
    notices.push('s1', 'two');
    const ids = notices.for('s1').map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
  });
});
