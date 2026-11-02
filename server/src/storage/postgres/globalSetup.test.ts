// vitest runs globalSetup.ts once, before the workers, so no test can observe that run. The function is an ordinary export, so it is
// called here with the gate replaced (#891).
import { afterEach, describe, expect, it, vi } from 'vitest';

const pgGate = vi.fn<() => Promise<void>>();
vi.mock('./gate.js', () => ({ pgGate: () => pgGate() }));

import setup from './globalSetup.js';

afterEach(() => { vi.restoreAllMocks(); pgGate.mockReset(); });

describe('the vitest global setup (#891)', () => {
  it('passes when the gate passes', async () => {
    pgGate.mockResolvedValue(undefined);
    await expect(setup()).resolves.toBeUndefined();
  });

  it('prints the gate\'s message and rethrows it with no stack for vitest to map', async () => {
    const err = new Error('PODIUM_TEST_PG is set but the server at h:1/postgres is unreachable');
    pgGate.mockRejectedValue(err);
    const print = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(setup()).rejects.toBe(err);
    expect(err.stack).toBe(err.message);
    expect(print).toHaveBeenCalledWith(expect.stringContaining('unreachable'));
  });

  it('wraps a thrown value that is not an Error', async () => {
    pgGate.mockRejectedValue('boom');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(setup()).rejects.toThrow('boom');
  });
});
