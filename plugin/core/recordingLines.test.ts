import { describe, expect, test } from 'claude-code/testing';
import type { RecordingGrant } from './protocol.ts';
import { clockOn, clockTime, limitLine, stoppedLine, timeWithDay } from './recordingLines.ts';

const now = new Date(2026, 9, 20, 12, 0).getTime();
const at = new Date(2026, 9, 20, 11, 42).getTime();
const later = new Date(2026, 9, 20, 17, 42).getTime();
const grant = (o: Partial<RecordingGrant>): RecordingGrant => o as RecordingGrant;

describe('times', () => {
  test('clockTime pads', () => expect(clockTime(new Date(2026, 9, 20, 9, 5).getTime())).toBe('09:05'));
  test('clockOn: the time today, the day too on another day', () => {
    expect(clockOn(at, now)).toBe('11:42');
    expect(clockOn(new Date(2026, 9, 19, 23, 59).getTime(), now)).toBe('23:59 on 2026-10-19');
  });
  test('timeWithDay: today, or the day', () => {
    expect(timeWithDay(later, now)).toBe('17:42 today');
    expect(timeWithDay(new Date(2026, 9, 21, 9, 5).getTime(), now)).toBe('09:05 on 2026-10-21');
  });
});

describe('stoppedLine', () => {
  test('names who, when and until when', () => {
    expect(stoppedLine(grant({ stoppedBy: 'Ana', stoppedAt: at, keptUntil: later }), now)).toBe(
      'Recording stopped by Ana at 11:42. What was recorded until then is kept until 17:42 today.',
    );
  });
  test('falls back when who, when or retention is unknown', () => {
    expect(stoppedLine(grant({ stoppedBy: null, stoppedAt: null, keptUntil: null }), now)).toBe(
      'Recording stopped by Podium at an unknown time. What was recorded until then is kept until its retention runs out.',
    );
    expect(stoppedLine(grant({}), now)).toContain('by Podium at an unknown time');
  });
});

describe('limitLine', () => {
  test('the size limit in MB', () => expect(limitLine(grant({ limit: 'session', bytes: 52_428_800 }))).toBe('Recording stopped: this session reached its 50 MB limit. Nothing after this point is kept.'));
  test('the disk budget', () => expect(limitLine(grant({ limit: 'budget', bytes: 0 }))).toContain("the server's disk budget"));
});
