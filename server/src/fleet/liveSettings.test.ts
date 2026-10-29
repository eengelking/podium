import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorage, type SqliteStorage } from '../storage/sqlite/index.js';
import { LiveTlsSettings } from '../tlsLive.js';
import { SERVING_DEFAULTS } from '../tlsRenew.js';
import { LiveActivityHistorySettings, LiveFeatureFlags, LiveModelPrices, LiveRecordingSettings, LiveWallSettings } from './liveSettings.js';
import { ACTIVITY_FEED, RESPOND, UPDATE_CHECK } from '../storage/features.js';

const open: SqliteStorage[] = [];
const dirs: string[] = [];
const memory = (): SqliteStorage => {
  const s = openSqliteStorage(':memory:');
  open.push(s);
  return s;
};
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A database file, so a test can close it and open it again as a restart would. */
const fileDb = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-live-'));
  dirs.push(d);
  return path.join(d, 'podium.sqlite');
};

/**
 * The same store, but the nth call made through it first waits `delays[n % delays.length]` ms. Writes asked for together, if nothing queued
 * them, would reach storage in the order of their delays rather than the order asked for, so a missing queue shows as a different last value.
 */
function staggered<T extends object>(target: T, delays: number[]): T {
  let n = 0;
  return new Proxy(target, {
    get(t, key) {
      const v = (t as Record<string | symbol, unknown>)[key];
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        const wait = delays[n++ % delays.length]!;
        await new Promise((r) => setTimeout(r, wait));
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

const PRICE = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 };

describe('LiveFeatureFlags', () => {
  it('holds the defaults until loaded, then what is stored, and a restart reads what was persisted', async () => {
    const file = fileDb();
    const first = openSqliteStorage(file);
    const flags = new LiveFeatureFlags(first.featureFlags);
    expect(flags.featureOn(RESPOND)).toBe(false);
    expect(flags.featureOn(UPDATE_CHECK)).toBe(true);
    expect(flags.featureOn('not-a-flag')).toBe(true);
    expect(await flags.setFeature('not-a-flag', false)).toBe(false);
    expect(await flags.setFeature(RESPOND, true)).toBe(true);
    expect(flags.featureOn(RESPOND)).toBe(true);
    expect(flags.view()[RESPOND]).toBe(true);
    await first.close();

    const second = openSqliteStorage(file);
    open.push(second);
    const again = new LiveFeatureFlags(second.featureFlags);
    expect(again.featureOn(RESPOND)).toBe(false);
    await again.load();
    expect(again.featureOn(RESPOND)).toBe(true);
    expect(again.view()).toEqual(flags.view());
  });

  it('runs the callback only for a real change, with the new value already readable', async () => {
    const storage = memory();
    const seen: Array<[string, boolean, boolean]> = [];
    const flags: LiveFeatureFlags = new LiveFeatureFlags(storage.featureFlags, (id, on) => seen.push([id, on, flags.featureOn(id)]));
    await flags.setFeature(ACTIVITY_FEED, true); // the default: no change
    await flags.setFeature(ACTIVITY_FEED, false);
    await flags.setFeature(ACTIVITY_FEED, false);
    expect(await flags.turn(RESPOND, true)).toBe(true);
    expect(await flags.turn(RESPOND, true)).toBe(false);
    expect(seen).toEqual([[ACTIVITY_FEED, false, false], [RESPOND, true, true]]);
  });

  it('leaves the last write stored and held, and calls back for each change in order, when writes overlap', async () => {
    const storage = memory();
    const seen: boolean[] = [];
    const flags = new LiveFeatureFlags(storage.featureFlags, (_id, on) => seen.push(on));
    // Asked for together: on, then off, then on, then off. The flag starts off.
    await Promise.all([flags.setFeature(RESPOND, true), flags.setFeature(RESPOND, false), flags.setFeature(RESPOND, true), flags.setFeature(RESPOND, false)]);
    expect(seen).toEqual([true, false, true, false]);
    expect(flags.featureOn(RESPOND)).toBe(false);
    expect(await storage.featureFlags.featureOn(RESPOND)).toBe(false);
    await Promise.all([flags.setFeature(RESPOND, false), flags.setFeature(RESPOND, true)]);
    expect(flags.featureOn(RESPOND)).toBe(true);
    expect(await storage.featureFlags.featureOn(RESPOND)).toBe(true);
  });

  it('keeps the held value when storage fails the write', async () => {
    const storage = memory();
    const flags = new LiveFeatureFlags({ ...storage.featureFlags, setFeature: () => Promise.reject(new Error('disk full')) });
    await expect(flags.setFeature(RESPOND, true)).rejects.toThrow('disk full');
    expect(flags.featureOn(RESPOND)).toBe(false);
    // and the queue is not stuck behind it
    const ok = new LiveFeatureFlags(storage.featureFlags);
    await expect(ok.setFeature(RESPOND, true)).resolves.toBe(true);
  });
});

describe('LiveWallSettings', () => {
  it('reads defaults, then what is stored after a restart', async () => {
    const file = fileDb();
    const first = openSqliteStorage(file);
    const wall = new LiveWallSettings(first.wallSettings);
    await wall.load();
    expect(wall.view()).toEqual({ notices: { 'background-sessions': true }, showBackgroundSessions: false, cardTitleMachine: false });
    expect(wall.noticeOn('background-sessions')).toBe(true);
    expect(wall.noticeOn('made-up')).toBe(true);
    expect(wall.updateDismissed()).toBeNull();
    expect(await wall.setNotice('made-up', false)).toBe(false);
    expect(await wall.setNotice('background-sessions', false)).toBe(true);
    await wall.setShowBackgroundSessions(true);
    await wall.setCardTitleMachine(true);
    await wall.dismissUpdate('1.2.3');
    expect(wall.noticeOn('background-sessions')).toBe(false);
    expect(wall.showBackgroundSessions()).toBe(true);
    expect(wall.cardTitleMachine()).toBe(true);
    expect(wall.updateDismissed()).toBe('1.2.3');
    await first.close();

    const second = openSqliteStorage(file);
    open.push(second);
    const again = new LiveWallSettings(second.wallSettings);
    await again.load();
    expect(again.view()).toEqual(wall.view());
    expect(again.updateDismissed()).toBe('1.2.3');
  });

  it('calls back on a stored change, writing the default over nothing included, and not on a repeat', async () => {
    const storage = memory();
    let calls = 0;
    const wall = new LiveWallSettings(storage.wallSettings, () => void calls++);
    await wall.load();
    await wall.setShowBackgroundSessions(false); // the default over an unset row: stored, so a change
    expect(calls).toBe(1);
    await wall.setShowBackgroundSessions(false);
    expect(calls).toBe(1);
    await wall.setNotice('background-sessions', true);
    await wall.setNotice('background-sessions', true);
    expect(calls).toBe(2);
    await wall.setCardTitleMachine(true);
    await wall.setCardTitleMachine(true);
    expect(calls).toBe(3);
    await wall.dismissUpdate('2.0.0');
    await wall.dismissUpdate('1.0.0'); // an older release never brings a newer one back
    await wall.dismissUpdate('2.0.0');
    expect(calls).toBe(4);
    expect(wall.updateDismissed()).toBe('2.0.0');
  });

  it('holds the last of overlapping writes, in storage and in memory', async () => {
    const storage = memory();
    const seen: boolean[] = [];
    // Stored out of order (the second, then the third, then the first) unless the writes are queued: the stored value would end up true, false, false.
    const wall: LiveWallSettings = new LiveWallSettings(staggered(storage.wallSettings, [30, 0, 15]), () => seen.push(wall.showBackgroundSessions()));
    await Promise.all([wall.setShowBackgroundSessions(true), wall.setShowBackgroundSessions(false), wall.setShowBackgroundSessions(true)]);
    expect(seen).toEqual([true, false, true]);
    expect(wall.showBackgroundSessions()).toBe(true);
    expect((await storage.wallSettings.view()).showBackgroundSessions).toBe(true);
  });
});

describe('LiveModelPrices', () => {
  it('shows a saved row at once, calls back once per real change, and survives a restart', async () => {
    const file = fileDb();
    const first = openSqliteStorage(file);
    let calls = 0;
    const prices = new LiveModelPrices(first.modelPrices, first.tx, () => void calls++);
    await prices.load();
    expect(prices.overrides()).toEqual({});
    expect(await prices.set('', { std: PRICE })).toBe('a model id is required');
    expect(calls).toBe(0);
    expect(await prices.set('Custom-Model', { std: PRICE })).toBeNull();
    expect(calls).toBe(1);
    expect(prices.overrides()).toEqual({ 'custom-model': { std: PRICE } });
    expect(prices.pricing().rowOf('custom-model')?.std).toEqual(PRICE);
    expect(prices.view().models.some((m) => m.key === 'custom-model' && m.overridden)).toBe(true);
    expect(await prices.set('custom-model', { std: PRICE })).toBeNull(); // the same values: nothing changes
    await prices.reset('nobody'); // nothing to reset
    expect(calls).toBe(1);
    await first.close();

    const second = openSqliteStorage(file);
    open.push(second);
    const again = new LiveModelPrices(second.modelPrices, second.tx);
    await again.load();
    expect(again.overrides()).toEqual(prices.overrides());
    await again.reset('Custom-Model');
    expect(again.overrides()).toEqual({});
    expect(again.pricing().rowOf('custom-model')).toBeNull();
  });

  it('leaves the last of overlapping saves stored and held', async () => {
    const storage = memory();
    const seen: number[] = [];
    // The transaction is entered in a different order than asked for (the second, the third, then the first) unless the saves are queued.
    const tx = staggered({ tx: storage.tx }, [30, 0, 15]).tx;
    const prices: LiveModelPrices = new LiveModelPrices(storage.modelPrices, tx, () => seen.push(prices.pricing().rowOf('m')?.std.input ?? 0));
    const at = (n: number) => prices.set('m', { std: { ...PRICE, input: n } });
    await Promise.all([at(3), at(4), at(5)]);
    expect(seen).toEqual([3, 4, 5]);
    expect(prices.pricing().rowOf('m')!.std.input).toBe(5);
    expect((await storage.modelPrices.overrides()).m).toEqual({ std: { ...PRICE, input: 5 } });
    seen.length = 0;
    await Promise.all([at(7), prices.reset('m'), at(8)]);
    expect(seen).toEqual([7, 0, 8]);
    expect(prices.pricing().rowOf('m')!.std.input).toBe(8);
    expect((await storage.modelPrices.overrides()).m).toEqual({ std: { ...PRICE, input: 8 } });
  });
});

describe('LiveRecordingSettings and LiveActivityHistorySettings', () => {
  it('read after a write sees the new value, a rejected write changes nothing, and a restart reads what was stored', async () => {
    const file = fileDb();
    const first = openSqliteStorage(file);
    const rec = new LiveRecordingSettings(first.recordingSettings);
    const history = new LiveActivityHistorySettings(first.activityHistorySettings(true));
    await Promise.all([rec.load(), history.load()]);
    expect(rec.get().keepHours).toBe(6);
    expect(history.get().policy).toBe('default');
    expect(await rec.set({ keepHours: 0 })).toMatchObject({ ok: false });
    expect(await history.set({ policy: 'nope' })).toMatchObject({ ok: false });
    expect(rec.get().keepHours).toBe(6);
    const saved = await rec.set({ keepHours: 12 });
    expect(saved).toMatchObject({ ok: true, before: { keepHours: 6 } });
    expect(rec.get().keepHours).toBe(12);
    await history.set({ policy: 'after', n: 3, unit: 'days', capGb: 2 });
    expect(history.get()).toEqual({ policy: 'after', n: 3, unit: 'days', capGb: 2 });
    await first.close();

    const second = openSqliteStorage(file);
    open.push(second);
    const rec2 = new LiveRecordingSettings(second.recordingSettings);
    const history2 = new LiveActivityHistorySettings(second.activityHistorySettings(true));
    await Promise.all([rec2.load(), history2.load()]);
    expect(rec2.get()).toEqual(rec.get());
    expect(history2.get()).toEqual(history.get());
    // without a sign-in token the stored policy still reads as the default, as before
    const noAuth = new LiveActivityHistorySettings(second.activityHistorySettings(false));
    await noAuth.load();
    expect(noAuth.get().policy).toBe('default');
  });

  it('leaves the last of overlapping saves stored and held', async () => {
    const storage = memory();
    // (The load is the first call through each, so the delays start after it.) Each store's saves reach it in a different order than asked for (the second, the third, then the first) unless they are queued.
    const rec = new LiveRecordingSettings(staggered(storage.recordingSettings, [0, 30, 0, 15]));
    const history = new LiveActivityHistorySettings(staggered(storage.activityHistorySettings(true), [0, 20, 0]));
    await Promise.all([rec.load(), history.load()]);
    await Promise.all([rec.set({ keepHours: 2 }), rec.set({ keepHours: 3 }), rec.set({ keepHours: 4 })]);
    await Promise.all([history.set({ n: 2 }), history.set({ n: 9 })]);
    expect(rec.get().keepHours).toBe(4);
    expect((await storage.recordingSettings.get()).keepHours).toBe(4);
    expect(history.get().n).toBe(9);
    expect((await storage.activityHistorySettings(true).get()).n).toBe(9);
  });
});

describe('LiveTlsSettings', () => {
  it('holds the stored settings, says what the switch was before a save, and seeds only once', async () => {
    const file = fileDb();
    const first = openSqliteStorage(file);
    const tls = new LiveTlsSettings(first.tlsSettings, first.tx);
    expect(tls.allowReportersOverHttp()).toBe(true);
    await tls.load();
    expect(tls.get()).toEqual(SERVING_DEFAULTS);
    expect(tls.allowReportersOverHttp()).toBe(true);
    await tls.seedAllowReportersOverHttp(false);
    expect(tls.allowReportersOverHttp()).toBe(false);
    await tls.seedAllowReportersOverHttp(true); // a row that exists is left alone
    expect(tls.allowReportersOverHttp()).toBe(false);
    expect(await tls.set({ 'tls.serving.lifetimeDays': 5 })).toMatchObject({ ok: false });
    const out = await tls.set({ 'tls.serving.lifetimeDays': 90, 'tls.reporter.lifetimeDays': 60, 'tls.header.countdown': false, 'tls.allowReportersOverHttp': true });
    expect(out).toMatchObject({ ok: true, wasAllowed: false });
    expect(tls.get()).toMatchObject({ lifetimeDays: 90, headerCountdown: false });
    expect(tls.getReporter().lifetimeDays).toBe(60);
    expect(tls.allowReportersOverHttp()).toBe(true);
    await first.close();

    const second = openSqliteStorage(file);
    open.push(second);
    const again = new LiveTlsSettings(second.tlsSettings, second.tx);
    await again.load();
    expect(again.get()).toEqual(tls.get());
    expect(again.getReporter()).toEqual(tls.getReporter());
    expect(again.allowReportersOverHttp()).toBe(true);
  });

  it('leaves the last of overlapping saves stored and held, each seeing the switch as the one before it left it', async () => {
    const storage = memory();
    const tls = new LiveTlsSettings(storage.tlsSettings, storage.tx);
    await tls.load();
    const key = 'tls.allowReportersOverHttp';
    const outs = await Promise.all([tls.set({ [key]: false }), tls.set({ [key]: true }), tls.set({ [key]: false })]);
    expect(outs.map((o) => (o.ok ? o.wasAllowed : null))).toEqual([true, false, true]);
    expect(tls.allowReportersOverHttp()).toBe(false);
    expect(await storage.tlsSettings.allowReportersOverHttp()).toBe(false);
  });
});
