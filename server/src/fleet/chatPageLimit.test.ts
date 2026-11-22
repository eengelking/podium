// The page size of every Chat read, Direct Messages included (#1034): 50 when absent, 1 to 100, and a 400 for anything else. Pinned before a Direct Message moves to the
// conversation tables (#1296), because only `limit=0` is tested at the routes.
import { describe, it, expect } from 'vitest';
import { limitOf } from './chatChannelRoutes.js';

describe('a Chat page size from the query', () => {
  it('is 50 when absent or empty', () => {
    expect(limitOf(undefined)).toBe(50);
    expect(limitOf('')).toBe(50);
  });

  it('takes 1 to 100 as it is', () => {
    expect(limitOf('1')).toBe(1);
    expect(limitOf('100')).toBe(100);
    expect(limitOf('037')).toBe(37);
  });

  it('refuses 0, 101, five digits, a sign, a fraction, text and anything that is not one string', () => {
    for (const bad of ['0', '101', '10000', '00000', '-1', '+5', '1.5', '1e1', 'abc', ' 5', ['5'], 5, null, {}]) expect(limitOf(bad), String(bad)).toBeNull();
  });
});
