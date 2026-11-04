import { describe, expect, it } from 'vitest';
import { optionsOf } from './options.ts';

describe('options: flush, heartbeat and session name (#969)', () => {
  it('defaults to a 1 s flush, a 5 s heartbeat and no name', () => {
    expect(optionsOf({}, null, {}, null)).toMatchObject({ flushMs: 1000, heartbeatMs: 5000, sessionName: null });
    expect(optionsOf(null, null, {}, null)).toMatchObject({ flushMs: 1000, heartbeatMs: 5000, sessionName: null });
  });

  it('takes flushIntervalMs, heartbeatMs and sessionName from the plugin options, as the Claude Code reporter does', () => {
    expect(optionsOf({ flushIntervalMs: 2500, heartbeatMs: 8000, sessionName: 'nightly' }, null, {}, null)).toMatchObject({ flushMs: 2500, heartbeatMs: 8000, sessionName: 'nightly' });
  });

  it('keeps the same lower bounds: 200 ms for the flush, 1000 ms for the heartbeat', () => {
    expect(optionsOf({ flushIntervalMs: 50, heartbeatMs: 10 }, null, {}, null)).toMatchObject({ flushMs: 200, heartbeatMs: 1000 });
    expect(optionsOf({ flushIntervalMs: 200, heartbeatMs: 1000 }, null, {}, null)).toMatchObject({ flushMs: 200, heartbeatMs: 1000 });
  });

  it('falls back to the default for a value that is not a finite number, and to no name for a value that is not text or is blank', () => {
    expect(optionsOf({ flushIntervalMs: '500', heartbeatMs: Number.NaN, sessionName: 7 }, null, {}, null)).toMatchObject({ flushMs: 1000, heartbeatMs: 5000, sessionName: null });
    expect(optionsOf({ flushIntervalMs: Infinity, sessionName: '   ' }, null, {}, null)).toMatchObject({ flushMs: 1000, sessionName: null });
  });

  it('trims the name', () => {
    expect(optionsOf({ sessionName: '  review  ' }, null, {}, null).sessionName).toBe('review');
  });
});
