import { describe, test, expect } from 'claude-code/testing';
import { bumpStat, copyStats, reportStats } from './toolStats.ts';
import { timeBucket } from './protocol.ts';

describe('bumpStat', () => {
  test('adds each kind of event to its own count and leaves the rest out', () => {
    const s = {};
    bumpStat(s, 'Bash', { failed: true }, 5);
    bumpStat(s, 'Bash', { asked: true }, 5);
    bumpStat(s, 'Bash', { allowed: true, podium: true }, 5);
    bumpStat(s, 'Bash', { denied: true }, 5);
    expect(s).toEqual({ Bash: { failed: 1, asked: 1, allowed: 1, podium: 1, denied: 1 } });
  });

  test('counts call lengths in buckets and ignores a length that is not a number', () => {
    const s = {};
    bumpStat(s, 'Read', { ms: 40 }, 5);
    bumpStat(s, 'Read', { ms: 41 }, 5);
    bumpStat(s, 'Read', { ms: Number.NaN }, 5);
    bumpStat(s, 'Read', { ms: -3 }, 5);
    expect(s).toEqual({ Read: { times: { [String(timeBucket(40))]: 2 } } });
  });

  test('adds a new tool only while there is room, and keeps counting one it has', () => {
    const s = {};
    bumpStat(s, 'a', { failed: true }, 2);
    bumpStat(s, 'b', { failed: true }, 2);
    bumpStat(s, 'c', { failed: true }, 2);
    bumpStat(s, 'a', { failed: true }, 2);
    expect(s).toEqual({ a: { failed: 2 }, b: { failed: 1 } });
  });
});

describe('copyStats and reportStats', () => {
  test('copies so that a later count does not change a report already built', () => {
    const live = bumpStat({}, 'Bash', { ms: 10 }, 5);
    const sent = copyStats(live);
    bumpStat(live, 'Bash', { ms: 10, failed: true }, 5);
    expect(sent.Bash).toEqual({ times: { [String(timeBucket(10))]: 1 } });
  });

  test('clips the names and drops a tool with nothing in it', () => {
    expect(reportStats({ abcdef: { failed: 1 }, empty: {} }, (n) => n.slice(0, 3))).toEqual({ abc: { failed: 1 } });
  });
});
