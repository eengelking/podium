import { describe, expect, it } from 'vitest';
import { FILE_DIFF_LIMITS, validateFileDiffReply, validateReport } from './protocol.js';
import { fixtureReport as sampleReport } from './testing.js';

const ok = { path: 'a.ts', status: 'ok', text: '@@ -1 +1 @@\n-a\n+b', truncated: false, shownLines: 3, totalLines: 3, redactions: 0, base: '7eb90e8' };

describe('validateFileDiffReply (#319)', () => {
  it('takes a good answer as sent', () => {
    const v = validateFileDiffReply(ok);
    expect(v.ok && v.reply).toEqual(ok);
  });
  it('takes every status without text but ok', () => {
    for (const status of ['binary', 'withheld', 'too-large', 'unavailable']) {
      const v = validateFileDiffReply({ ...ok, status, text: null });
      expect(v.ok).toBe(true);
    }
  });
  it('refuses ok without text, and text without ok', () => {
    expect(validateFileDiffReply({ ...ok, text: null }).ok).toBe(false);
    expect(validateFileDiffReply({ ...ok, status: 'binary' }).ok).toBe(false);
  });
  it('refuses an unknown status, a non-string text and a body that is not an object', () => {
    expect(validateFileDiffReply({ ...ok, status: 'maybe' }).ok).toBe(false);
    expect(validateFileDiffReply({ ...ok, text: 5 }).ok).toBe(false);
    expect(validateFileDiffReply(null).ok).toBe(false);
    expect(validateFileDiffReply('x').ok).toBe(false);
  });
  it('refuses a text over the limit and does not cut a text under it', () => {
    expect(validateFileDiffReply({ ...ok, text: 'x'.repeat(FILE_DIFF_LIMITS.answerBytes + 1) }).ok).toBe(false);
    const big = 'x\n'.repeat(FILE_DIFF_LIMITS.answerBytes / 2);
    const v = validateFileDiffReply({ ...ok, text: big });
    expect(v.ok && v.reply.text).toBe(big);
  });
  it('defaults the counts and refuses negative ones', () => {
    const v = validateFileDiffReply({ path: 'a', status: 'binary' });
    expect(v.ok && v.reply).toMatchObject({ truncated: false, shownLines: 0, totalLines: 0, redactions: 0, base: null, text: null });
    expect(validateFileDiffReply({ ...ok, redactions: -1 }).ok).toBe(false);
  });
});

describe('Report.session.fileDiff (#319)', () => {
  it('is kept when present and left out when absent', () => {
    const on = validateReport({ ...sampleReport(), session: { ...sampleReport().session, fileDiff: true } });
    expect(on.ok && on.report.session.fileDiff).toBe(true);
    const absent = validateReport(sampleReport());
    expect(absent.ok && 'fileDiff' in absent.report.session).toBe(false);
  });
  it('refuses a value that is not a boolean', () => {
    expect(validateReport({ ...sampleReport(), session: { ...sampleReport().session, fileDiff: 'yes' } }).ok).toBe(false);
  });
});
