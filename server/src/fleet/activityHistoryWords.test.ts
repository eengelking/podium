import { describe, expect, it } from 'vitest';
import { capWords, countWords, groupedCount, policyWords } from './activityHistoryWords.js';
import { ACTIVITY_HISTORY_DEFAULTS, type ActivityHistorySettings } from './activityHistoryTypes.js';

const s = (over: Partial<ActivityHistorySettings>): ActivityHistorySettings => ({ ...ACTIVITY_HISTORY_DEFAULTS, ...over });

describe('the Admin log words for the Activity history', () => {
  it('groups digits and counts one and many', () => {
    expect(groupedCount(72000)).toBe('72,000');
    expect(groupedCount(1_300_000)).toBe('1,300,000');
    expect(groupedCount(12)).toBe('12');
    expect(countWords(1, 'entry', 'entries')).toBe('1 entry');
    expect(countWords(72000, 'entry', 'entries')).toBe('72,000 entries');
    expect(countWords(0, 'session', 'sessions')).toBe('0 sessions');
  });

  it('says a period in the singular for one and the plural otherwise, for every unit', () => {
    expect(policyWords(s({ policy: 'after', n: 1, unit: 'hours' }))).toBe('purge after 1 hour');
    expect(policyWords(s({ policy: 'after', n: 2, unit: 'hours' }))).toBe('purge after 2 hours');
    expect(policyWords(s({ policy: 'after', n: 1, unit: 'days' }))).toBe('purge after 1 day');
    expect(policyWords(s({ policy: 'after', n: 1, unit: 'weeks' }))).toBe('purge after 1 week');
    expect(policyWords(s({ policy: 'after', n: 1, unit: 'months' }))).toBe('purge after 1 month');
    expect(policyWords(s({ policy: 'after', n: 30, unit: 'days' }))).toBe('purge after 30 days');
  });

  it('has words for the other three choices and for the cap', () => {
    expect(policyWords(s({ policy: 'default' }))).toBe('not kept (the default)');
    expect(policyWords(s({ policy: 'end' }))).toBe('purge when the session ends');
    expect(policyWords(s({ policy: 'all' }))).toBe('keep everything, no automatic purge');
    expect(capWords(s({}))).toBe('no size cap');
    expect(capWords(s({ capGb: 5 }))).toBe('size cap 5 GB');
  });
});
