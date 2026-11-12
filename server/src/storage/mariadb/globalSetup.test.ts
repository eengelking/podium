// vitest runs globalSetup.ts once, before the workers, so no test can observe that run. The function is an ordinary export, so it is
// called here with the gate replaced (#891, #823).
import { afterEach, describe, expect, it, vi } from 'vitest';

const mariaGate = vi.fn<() => Promise<void>>();
vi.mock('./gate.js', () => ({ mariaGate: () => mariaGate() }));

import setup from './globalSetup.js';

afterEach(() => { vi.restoreAllMocks(); mariaGate.mockReset(); });

describe('the MariaDB vitest global setup', () => {
  it('passes when the gate passes', async () => {
    mariaGate.mockResolvedValue(undefined);
    await expect(setup()).resolves.toBeUndefined();
  });

  it('prints the gate\'s message and rethrows it with no stack for vitest to map', async () => {
    const err = new Error('PODIUM_TEST_MARIADB is set but the server at h:1/podium is unreachable');
    mariaGate.mockRejectedValue(err);
    const print = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(setup()).rejects.toBe(err);
    expect(err.stack).toBe(err.message);
    expect(print).toHaveBeenCalledWith(expect.stringContaining('unreachable'));
  });

  it('wraps a thrown value that is not an Error', async () => {
    mariaGate.mockRejectedValue('boom');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(setup()).rejects.toThrow('boom');
  });
});
