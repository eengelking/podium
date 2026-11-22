// What was concluded for a person (#1283), kept in memory: an entry lasts 24 hours and a person keeps the newest 20. Pinned before a Direct Message moves to the
// conversation tables (#1296), because no route test advances the clock or adds more than one.
import { describe, it, expect } from 'vitest';
import { ConcludedList } from './chatConcluded.js';

const HOUR = 3_600_000;
const entry = (thread: string, over: { undelivered?: number } = {}) => ({ thread, agent: 'Tester', with: ['dev'], ...over });

describe('the list of concluded conversations', () => {
  it('keeps an entry for 24 hours, and not a millisecond longer', () => {
    let clock = 1_800_000_000_000;
    const list = new ConcludedList(() => clock);
    list.add([1], entry('dm:a|b'));
    clock += 24 * HOUR - 1;
    expect(list.of(1).map((x) => x.thread)).toEqual(['dm:a|b']);
    clock += 1;
    expect(list.of(1)).toEqual([]);
  });

  it('keeps the newest 20 of a person and drops the oldest, for that person only', () => {
    let clock = 1_800_000_000_000;
    const list = new ConcludedList(() => clock);
    for (let i = 0; i < 21; i++) {
      list.add([1], entry(`dm:t${i}`));
      clock += 1000;
    }
    list.add([2], entry('dm:other'));
    const mine = list.of(1).map((x) => x.thread);
    expect(mine).toHaveLength(20);
    expect(mine[0]).toBe('dm:t1');
    expect(mine.at(-1)).toBe('dm:t20');
    expect(list.of(2).map((x) => x.thread)).toEqual(['dm:other']);
  });

  it('expires one entry at a time, so a newer one outlives an older one', () => {
    let clock = 1_800_000_000_000;
    const list = new ConcludedList(() => clock);
    list.add([1], entry('dm:old'));
    clock += 12 * HOUR;
    list.add([1], entry('dm:new'));
    clock += 12 * HOUR;
    expect(list.of(1).map((x) => x.thread)).toEqual(['dm:new']);
  });

  it('records one entry for each person once, names the entry by thread and time, and carries the undelivered count', () => {
    const list = new ConcludedList(() => 1_800_000_000_000);
    list.add([1, 2, 1], entry('dm:a|b', { undelivered: 2 }));
    expect(list.of(1)).toEqual([{ id: 'dm:a|b@1800000000000', thread: 'dm:a|b', agent: 'Tester', with: ['dev'], at: 1_800_000_000_000, undelivered: 2 }]);
    expect(list.of(2)).toHaveLength(1);
    expect(list.of(3)).toEqual([]);
  });

  it('lets a person dismiss their own entry, and treats another person\'s id as none', () => {
    const list = new ConcludedList(() => 1_800_000_000_000);
    list.add([1], entry('dm:a|b'));
    const id = list.of(1)[0]!.id;
    expect(list.dismiss(2, id)).toBe(false);
    expect(list.of(1)).toHaveLength(1);
    expect(list.dismiss(1, id)).toBe(true);
    expect(list.of(1)).toEqual([]);
    expect(list.dismiss(1, id)).toBe(false);
  });
});
