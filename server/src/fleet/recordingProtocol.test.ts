import { describe, expect, it } from 'vitest';
import {
  RECORDING_DEFAULTS,
  RECORDING_KINDS,
  RECORDING_LIMITS,
  RECORDING_RANGES,
  validateRecordingBatch,
  validateRecordingStart,
  validateReport,
} from './protocol.js';
import { fixtureReport as sampleReport } from './testing.js';

const entry = { loop: '@orchestrator', seq: 1, at: 1791647850000, kind: 'tool', text: 'Read server/src/a.ts', name: 'Read' };
const batch = (entries: unknown[]) => ({ v: 1, sentAt: 1791647851000, entries });

describe('validateRecordingBatch (#353)', () => {
  it('takes a good batch as sent', () => {
    const v = validateRecordingBatch(batch([entry, { ...entry, seq: 2, kind: 'result', callSeq: 1, failed: true, cut: true, text: 'a\nb' }]));
    expect(v.ok && v.batch.entries).toHaveLength(2);
    expect(v.ok && v.batch.entries[1]).toMatchObject({ kind: 'result', callSeq: 1, failed: true, cut: true, text: 'a\nb' });
  });
  it('keeps line breaks and drops other control characters', () => {
    const v = validateRecordingBatch(batch([{ ...entry, text: 'a\nb\u0007c' }]));
    expect(v.ok && v.batch.entries[0].text).toBe('a\nb c');
  });
  it('lets marks have no text', () => {
    for (const kind of ['thinking', 'clear', 'compact']) {
      const v = validateRecordingBatch(batch([{ loop: 'a1', seq: 3, at: 1, kind }]));
      expect(v.ok && v.batch.entries[0].text).toBe('');
    }
  });
  it('takes a decision, and the sender (`by`) on a decision, a clear and a compact only (#353, answers and approvals)', () => {
    const d = { loop: '@orchestrator', seq: 2, at: 5, kind: 'decision', name: 'permission', callSeq: 1, failed: true, text: 'Denied: no', by: 'Ed' };
    const v = validateRecordingBatch(batch([d, { ...d, seq: 3, kind: 'clear', text: '' }, { ...d, seq: 4, kind: 'compact', text: '' }, { ...entry, seq: 5, kind: 'prompt', by: 'Mallory' }]));
    expect(v.ok && v.batch.entries.map((e) => e.by)).toEqual(['Ed', 'Ed', 'Ed', undefined]);
    expect(v.ok && v.batch.entries[0]).toMatchObject({ kind: 'decision', name: 'permission', callSeq: 1, failed: true });
    expect(validateRecordingBatch(batch([{ ...d, by: 5 }])).ok).toBe(false);
  });
  it('needs the number lost on a gap', () => {
    expect(validateRecordingBatch(batch([{ loop: 'a1', seq: 4, at: 1, kind: 'gap' }])).ok).toBe(false);
    expect(validateRecordingBatch(batch([{ loop: 'a1', seq: 4, at: 1, kind: 'gap', lost: 0 }])).ok).toBe(false);
    const v = validateRecordingBatch(batch([{ loop: 'a1', seq: 4, at: 1, kind: 'gap', lost: 12 }]));
    expect(v.ok && v.batch.entries[0].lost).toBe(12);
  });
  it('refuses the kinds only the server writes, and an unknown kind', () => {
    expect(RECORDING_KINDS).toContain('limit');
    for (const kind of ['stopped', 'limit', 'maybe']) expect(validateRecordingBatch(batch([{ ...entry, kind }])).ok).toBe(false);
  });
  it('refuses a seq below 1, an empty loop and a missing field', () => {
    expect(validateRecordingBatch(batch([{ ...entry, seq: 0 }])).ok).toBe(false);
    expect(validateRecordingBatch(batch([{ ...entry, loop: '' }])).ok).toBe(false);
    expect(validateRecordingBatch(batch([{ ...entry, at: undefined }])).ok).toBe(false);
  });
  it('refuses too many entries, a wrong version and a body that is not an object', () => {
    expect(validateRecordingBatch(batch(Array.from({ length: RECORDING_LIMITS.entries }, (_, i) => ({ ...entry, seq: i + 1 })))).ok).toBe(true);
    expect(validateRecordingBatch(batch(Array.from({ length: RECORDING_LIMITS.entries + 1 }, (_, i) => ({ ...entry, seq: i + 1 })))).ok).toBe(false);
    expect(validateRecordingBatch({ ...batch([entry]), v: 2 }).ok).toBe(false);
    expect(validateRecordingBatch(null).ok).toBe(false);
  });
  it('cuts a text past the limit and its marker room, and keeps one under it', () => {
    const big = 'x'.repeat(RECORDING_LIMITS.text);
    const v = validateRecordingBatch(batch([{ ...entry, text: big }]));
    expect(v.ok && v.batch.entries[0].text).toBe(big);
    const w = validateRecordingBatch(batch([{ ...entry, text: 'y'.repeat(RECORDING_LIMITS.text + 500) }]));
    expect(w.ok && w.batch.entries[0].text.length).toBe(RECORDING_LIMITS.text + 60);
  });
});

describe('validateRecordingStart (#353)', () => {
  it('takes distinct loops', () => {
    const v = validateRecordingStart({ loops: ['@orchestrator', 'a1', 'a1'] });
    expect(v.ok && v.request.loops).toEqual(['@orchestrator', 'a1']);
  });
  it('refuses none, an empty id and a body of the wrong shape', () => {
    expect(validateRecordingStart({ loops: [] }).ok).toBe(false);
    expect(validateRecordingStart({ loops: [''] }).ok).toBe(false);
    expect(validateRecordingStart({ loops: 'a1' }).ok).toBe(false);
    expect(validateRecordingStart(undefined).ok).toBe(false);
  });
});

describe('Report.session.sessionRecording (#353)', () => {
  it('is kept when present and left out when absent', () => {
    const on = validateReport({ ...sampleReport(), session: { ...sampleReport().session, sessionRecording: true } });
    expect(on.ok && on.report.session.sessionRecording).toBe(true);
    const absent = validateReport(sampleReport());
    expect(absent.ok && 'sessionRecording' in absent.report.session).toBe(false);
  });
  it('refuses a value that is not a boolean', () => {
    expect(validateReport({ ...sampleReport(), session: { ...sampleReport().session, sessionRecording: 'yes' } }).ok).toBe(false);
  });
});

describe('recording settings constants (#353)', () => {
  it('keep the defaults inside the ranges, and the longest keep at 7 days', () => {
    expect(RECORDING_DEFAULTS).toEqual({ keepHours: 6, budgetMb: 4096, sessionMb: 512 });
    for (const k of ['keepHours', 'budgetMb', 'sessionMb'] as const) {
      expect(RECORDING_DEFAULTS[k]).toBeGreaterThanOrEqual(RECORDING_RANGES[k].min);
      expect(RECORDING_DEFAULTS[k]).toBeLessThanOrEqual(RECORDING_RANGES[k].max);
    }
    expect(RECORDING_RANGES.keepHours.max).toBe(7 * 24);
  });
  it('size a batch under the 512 KB body limit', () => {
    expect(RECORDING_LIMITS.bodyBytes).toBeLessThan(512 * 1024);
  });
});
