import { describe, expect, test } from 'claude-code/testing';
import { podiumSays, SERVER_FLAG_OFF } from './messagingStatus.ts';

describe('podiumSays', () => {
  test('nothing yet until a report has been answered', () => {
    expect(podiumSays(false, true)).toBe('nothing yet');
    expect(podiumSays(false, false)).toBe('nothing yet');
  });
  test('takes part or does not, once reported', () => {
    expect(podiumSays(true, true)).toBe('takes part');
    expect(podiumSays(true, false)).toBe('does not take part');
  });
});

test('the server-flag reason names the flag and the admin secret', () => {
  expect(SERVER_FLAG_OFF).toContain('Admin > Settings');
  expect(SERVER_FLAG_OFF).toContain('admin secret');
});
