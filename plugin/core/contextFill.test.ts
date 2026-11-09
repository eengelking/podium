import { describe, expect, test } from 'claude-code/testing';
import { pct } from './contextFill.ts';

describe('pct', () => {
  test('rounds to one decimal', () => expect(pct(1, 3)).toBe(33.3));
  test('never goes over 100', () => expect(pct(300, 200)).toBe(100));
  test('is null when the tokens or the window are unknown, or the window is 0', () => {
    expect(pct(null, 200)).toBeNull();
    expect(pct(10, null)).toBeNull();
    expect(pct(10, 0)).toBeNull();
  });
  test('0 tokens is 0, not null', () => expect(pct(0, 200)).toBe(0));
});
