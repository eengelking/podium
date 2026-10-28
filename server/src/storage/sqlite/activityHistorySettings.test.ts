import { describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import { activityHistoryFieldError, activityPeriodMs, ActivityHistorySettingsStore } from './activityHistorySettings.js';
import { ACTIVITY_HISTORY_DEFAULTS, ACTIVITY_UNIT_MS } from '../../fleet/activityHistoryTypes.js';

const store = (authOn = true) => {
  const db = openDb(':memory:');
  return { db, s: new ActivityHistorySettingsStore(db, authOn) };
};

describe('ActivityHistorySettingsStore', () => {
  it('starts at the default policy', () => {
    expect(store().s.get()).toEqual(ACTIVITY_HISTORY_DEFAULTS);
  });

  it('saves a valid choice, keeps the other fields, and returns the whole settings', () => {
    const { s } = store();
    expect(s.set({ policy: 'after', n: 14, unit: 'days' })).toEqual({ ok: true, settings: { policy: 'after', n: 14, unit: 'days', capGb: null } });
    expect(s.set({ capGb: 5 })).toEqual({ ok: true, settings: { policy: 'after', n: 14, unit: 'days', capGb: 5 } });
    expect(s.set({ capGb: null })).toMatchObject({ ok: true, settings: { capGb: null } });
    expect(s.get()).toEqual({ policy: 'after', n: 14, unit: 'days', capGb: null });
  });

  it('refuses nothing to change, an unknown setting, and every out-of-range value, saving nothing', () => {
    const { s } = store();
    expect(s.set({})).toEqual({ ok: false, error: 'nothing to change' });
    expect(s.set({ nope: 1 })).toEqual({ ok: false, error: 'unknown setting: nope' });
    for (const patch of [{ policy: 'forever' }, { unit: 'years' }, { n: 0 }, { n: 3651 }, { n: 1.5 }, { n: '5' }, { capGb: 0 }, { capGb: 1001 }, { capGb: 'x' }]) {
      expect(s.set(patch)).toMatchObject({ ok: false });
    }
    expect(s.set({ policy: 'all', n: 0 })).toMatchObject({ ok: false });
    expect(s.get()).toEqual(ACTIVITY_HISTORY_DEFAULTS);
  });

  it('takes the edges of every range', () => {
    const { s } = store();
    expect(s.set({ n: 1, capGb: 1 })).toMatchObject({ ok: true });
    expect(s.set({ n: 3650, capGb: 1000 })).toMatchObject({ ok: true });
  });

  it('refuses a keep policy when the server has no token, and still takes the default', () => {
    const { s } = store(false);
    const r = s.set({ policy: 'all' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('sign-in token');
    expect(s.set({ policy: 'default', n: 7 })).toMatchObject({ ok: true });
  });

  it('reads the default policy when a keep policy was saved before the token was removed', () => {
    const { db } = store();
    new ActivityHistorySettingsStore(db, true).set({ policy: 'all' });
    expect(new ActivityHistorySettingsStore(db, false).get().policy).toBe('default');
    expect(new ActivityHistorySettingsStore(db, true).get().policy).toBe('all');
  });

  it('falls back to the defaults for a damaged row or damaged fields', () => {
    const { db, s } = store();
    const put = (v: string) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('activity_history', v);
    put('not json');
    expect(s.get()).toEqual(ACTIVITY_HISTORY_DEFAULTS);
    put('7');
    expect(s.get()).toEqual(ACTIVITY_HISTORY_DEFAULTS);
    put(JSON.stringify({ policy: 'x', n: -1, unit: 'y', capGb: 0 }));
    expect(s.get()).toEqual(ACTIVITY_HISTORY_DEFAULTS);
    put(JSON.stringify({ policy: 'end', capGb: 3 }));
    expect(s.get()).toEqual({ ...ACTIVITY_HISTORY_DEFAULTS, policy: 'end', capGb: 3 });
  });
});

describe('helpers', () => {
  it('turns n and a unit into milliseconds', () => {
    expect(activityPeriodMs({ ...ACTIVITY_HISTORY_DEFAULTS, n: 2, unit: 'weeks' })).toBe(2 * ACTIVITY_UNIT_MS.weeks);
    expect(activityPeriodMs({ ...ACTIVITY_HISTORY_DEFAULTS, n: 1, unit: 'months' })).toBe(30 * 86_400_000);
  });

  it('names the field in an error', () => {
    expect(activityHistoryFieldError('n', 0)).toContain('1 to 3650');
    expect(activityHistoryFieldError('capGb', 'x')).toContain('1 to 1000');
    expect(activityHistoryFieldError('policy', 'x')).toContain('default, after, end, all');
    expect(activityHistoryFieldError('unit', 'x')).toContain('hours');
  });
});
