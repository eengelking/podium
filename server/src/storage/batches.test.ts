import { describe, expect, it } from 'vitest';
import { BATCH, chunksOf } from './batches.js';

describe('chunksOf', () => {
  it('cuts a list into parts of at most the size, in order, and gives none for none', () => {
    expect(chunksOf([])).toEqual([]);
    expect(chunksOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunksOf([1, 2], 2)).toEqual([[1, 2]]);
    expect(chunksOf(Array.from({ length: BATCH + 1 }, (_, i) => i)).map((p) => p.length)).toEqual([BATCH, 1]);
  });
});
