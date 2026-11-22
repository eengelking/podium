import { describe, expect, it } from 'vitest';
import { BATCH, chunksOf } from './batches.js';
import { foldBumps } from './chatRows.js';

describe('chunksOf', () => {
  it('cuts a list into parts of at most the size, in order, and gives none for none', () => {
    expect(chunksOf([])).toEqual([]);
    expect(chunksOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunksOf([1, 2], 2)).toEqual([[1, 2]]);
    expect(chunksOf(Array.from({ length: BATCH + 1 }, (_, i) => i)).map((p) => p.length)).toEqual([BATCH, 1]);
  });
});

describe('foldBumps', () => {
  it('has one entry for each person in the order first listed, counting a person listed twice twice', () => {
    expect(foldBumps([])).toEqual([]);
    expect(foldBumps([{ personId: 2, mention: false }, { personId: 1, mention: true }, { personId: 2, mention: true }, { personId: 2, mention: false }])).toEqual([
      { personId: 2, unread: 3, mentions: 1 },
      { personId: 1, unread: 1, mentions: 1 },
    ]);
  });
});
