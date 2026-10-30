import { describe, it, expect } from 'vitest';
import { openDb } from './db.js';
import { PeerSettings } from './peerSettings.js';
import { PEER_DEFAULTS, peerSettingError } from '../settings.js';

describe('PeerSettings', () => {
  it('starts at the defaults: 10 round trips, 6 a minute, 20,000 characters, 30 days', () => {
    const s = new PeerSettings(openDb(':memory:'));
    expect(s.get()).toEqual(PEER_DEFAULTS);
    expect(s.limits()).toEqual({ roundTrips: 10, perMinute: 6, maxChars: 20_000 });
    expect(s.retainMs()).toBe(30 * 86_400_000);
  });

  it('saves a change and keeps the rest', () => {
    const s = new PeerSettings(openDb(':memory:'));
    expect(s.set({ roundTrips: 4, retainDays: 7 })).toEqual({ ok: true, settings: { ...PEER_DEFAULTS, roundTrips: 4, retainDays: 7 } });
    expect(s.get()).toEqual({ ...PEER_DEFAULTS, roundTrips: 4, retainDays: 7 });
  });

  it.each([
    [{ roundTrips: 0 }, 'Round trips must be a whole number from 1 to 100'],
    [{ roundTrips: 101 }, 'Round trips must be a whole number from 1 to 100'],
    [{ perMinute: 2.5 }, 'Messages per minute must be a whole number from 1 to 60'],
    [{ maxChars: 20_001 }, 'Longest message must be a whole number from 1 to 20000'],
    [{ retainDays: '30' }, 'Keep conversations must be a whole number from 1 to 365'],
    [{ hops: 3 }, 'unknown setting: hops'],
  ])('refuses %j and saves nothing', (patch, error) => {
    const s = new PeerSettings(openDb(':memory:'));
    expect(s.set({ perMinute: 3, ...patch })).toEqual({ ok: false, error });
    expect(s.get()).toEqual(PEER_DEFAULTS);
  });

  it('refuses an empty change', () => {
    expect(new PeerSettings(openDb(':memory:')).set({})).toEqual({ ok: false, error: 'nothing to change' });
  });

  it('ignores a stored value that is no longer valid, and unreadable JSON', () => {
    const db = openDb(':memory:');
    const s = new PeerSettings(db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('peer_settings', ?)").run(JSON.stringify({ roundTrips: 999, perMinute: 2 }));
    expect(s.get()).toEqual({ ...PEER_DEFAULTS, perMinute: 2 });
    db.prepare("UPDATE settings SET value = '{' WHERE key = 'peer_settings'").run();
    expect(s.get()).toEqual(PEER_DEFAULTS);
  });

  it('checks a value against a lower bound, for an owner who can only be stricter', () => {
    expect(peerSettingError('roundTrips', 5, 4)).toBe('Round trips must be a whole number from 1 to 4');
    expect(peerSettingError('roundTrips', 4, 4)).toBeNull();
  });
});
