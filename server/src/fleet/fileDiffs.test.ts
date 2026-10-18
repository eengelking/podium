import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffBroker } from './fileDiffs.js';
import { FILE_DIFF_LIMITS, type FileDiffReply } from './protocol.js';

const reply = (path: string): FileDiffReply => ({ path, status: 'ok', text: '@@ -1 +1 @@\n-a\n+b', truncated: false, shownLines: 3, totalLines: 3, redactions: 0, base: 'abc1234' });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('DiffBroker (#319)', () => {
  it('hands a request to the mod and the mod\'s answer to the one waiting browser', async () => {
    const b = new DiffBroker();
    const p = b.ask('s1', 'a.ts');
    const listed = b.listFor('s1');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.path).toBe('a.ts');
    expect(b.answer('s1', listed[0]!.id, reply('a.ts'))).toBe(true);
    expect(await p).toEqual(reply('a.ts'));
  });
  it('keeps listing a request until it is answered, and stops after', async () => {
    const b = new DiffBroker();
    const p = b.ask('s1', 'a.ts');
    expect(b.listFor('s1')).toHaveLength(1);
    expect(b.listFor('s1')).toHaveLength(1);
    b.answer('s1', b.listFor('s1')[0]!.id, reply('a.ts'));
    await p;
    expect(b.listFor('s1')).toEqual([]);
  });
  it('gives up after the hold time and lists nothing then', async () => {
    const b = new DiffBroker();
    const p = b.ask('s1', 'a.ts');
    vi.advanceTimersByTime(FILE_DIFF_LIMITS.holdSeconds * 1000 + 1);
    expect(await p).toBeNull();
    expect(b.listFor('s1')).toEqual([]);
  });
  it('lists at most four, and refuses a fifth', async () => {
    const b = new DiffBroker();
    const ps = [1, 2, 3, 4].map((n) => b.ask('s1', `f${n}.ts`));
    expect(b.listFor('s1')).toHaveLength(FILE_DIFF_LIMITS.pending);
    expect(await b.ask('s1', 'f5.ts')).toBe('busy');
    b.drop('s1');
    await Promise.all(ps);
  });
  it('ignores an answer for a request it does not hold, or one from another session', async () => {
    const b = new DiffBroker();
    const p = b.ask('s1', 'a.ts');
    const id = b.listFor('s1')[0]!.id;
    expect(b.answer('s2', id, reply('a.ts'))).toBe(false);
    expect(b.answer('s1', 'nope', reply('a.ts'))).toBe(false);
    expect(b.answer('s1', id, reply('a.ts'))).toBe(true);
    expect(b.answer('s1', id, reply('a.ts'))).toBe(false);
    await p;
  });
  it('drop answers a session\'s waiting browsers with nothing and forgets the requests', async () => {
    const b = new DiffBroker();
    const p = b.ask('s1', 'a.ts');
    const q = b.ask('s2', 'b.ts');
    b.drop('s1');
    expect(await p).toBeNull();
    expect(b.listFor('s1')).toEqual([]);
    expect(b.listFor('s2')).toHaveLength(1);
    b.clear();
    expect(await q).toBeNull();
    expect(b.size).toBe(0);
  });
  it('keeps no text after the answer is handed over', async () => {
    const b = new DiffBroker();
    const p = b.ask('s1', 'a.ts');
    b.answer('s1', b.listFor('s1')[0]!.id, reply('a.ts'));
    await p;
    expect(JSON.stringify([...Object.values(b)])).not.toContain('@@ -1');
    expect(b.size).toBe(0);
  });
  it('remembers whether a session\'s reporter has the option on, until the session is dropped', () => {
    const b = new DiffBroker();
    expect(b.optionOn('s1')).toBeNull();
    b.noteOption('s1', true);
    expect(b.optionOn('s1')).toBe(true);
    b.drop('s1');
    expect(b.optionOn('s1')).toBeNull();
  });
});
