// The page size a Chat read takes from its query (#1310): 1 to 100, 50 when absent, and nothing else.
import { describe, it, expect } from 'vitest';
import { limitOf } from './chatChannelRoutes.js';

describe('limitOf', () => {
  it('takes 1 to 100, with leading zeros, and 50 when there is none', () => {
    expect([limitOf(undefined), limitOf(''), limitOf('1'), limitOf('100'), limitOf('037')]).toEqual([50, 50, 1, 100, 37]);
  });

  it('refuses zero, over 100, more than four digits, a sign, text and anything that is not a string', () => {
    for (const bad of ['0', '101', '00000', '10000', '-1', '1.5', 'abc', ' 5', '5 ', 5, null, ['5'], {}]) expect(limitOf(bad), String(bad)).toBeNull();
  });
});
