import { describe, it, expect, vi } from 'vitest';
import { startSweeper } from './sweeper.js';
import type { Fleet } from './fleet.js';

describe('the sweeper with an async fleet (#313)', () => {
  it('logs a timer body that rejects, as it logs one that throws, and keeps the timers going', async () => {
    vi.useFakeTimers();
    try {
      const lines: { event: string; fields: Record<string, unknown> }[] = [];
      const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: (event: string, _t: string, fields: Record<string, unknown>) => void lines.push({ event, fields }) } as never;
      let sweeps = 0;
      const fleet = {
        sweep: () => (++sweeps === 1 ? Promise.reject(new Error('read failed')) : Promise.resolve()),
        tick: () => {
          throw new Error('sync failure');
        },
        retain: () => Promise.reject(new Error('retention failed')),
      } as unknown as Fleet;
      const stop = startSweeper(fleet, { sweepMs: 1000, tickMs: 2000, retentionMs: 3_600_000, activityPurgeMs: 3_600_000 }, logger, undefined, () => {});
      await vi.advanceTimersByTimeAsync(2000);
      stop();
      expect(sweeps).toBe(2);
      expect(lines.map((l) => [l.fields.timer, l.fields.reason]).sort()).toEqual([
        ['retention', 'retention failed'],
        ['sweep', 'read failed'],
        ['tick', 'sync failure'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
