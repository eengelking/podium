import { describe, it, expect } from 'vitest';
import { TlsBoot } from './tlsBoot.js';
import type { TlsListener } from './tlsServer.js';

const listener = { port: 4318 } as TlsListener;

describe('adopting the TLS listener', () => {
  it('holds nothing before TLS has started, and when it did not start', async () => {
    const boot = new TlsBoot();
    expect(boot.listener).toBeNull();
    expect(boot.gateActive).toBe(false);
    let seeded = false;
    await boot.adopt(null, async () => void (seeded = true));
    expect(boot.listener).toBeNull();
    expect(boot.gateActive).toBe(false);
    expect(seeded).toBe(false);
  });

  it('has the listener from the first turn, but opens the gate only after the seed is stored', async () => {
    const boot = new TlsBoot();
    let finish!: () => void;
    const seed = () => new Promise<void>((r) => (finish = r));
    const adopting = boot.adopt(listener, seed);
    // Synchronously after the call: certificates can be checked against it, and nothing is refused yet.
    expect(boot.listener).toBe(listener);
    expect(boot.gateActive).toBe(false);
    await Promise.resolve();
    expect(boot.gateActive).toBe(false);
    finish();
    await adopting;
    expect(boot.gateActive).toBe(true);
  });

  it('keeps the listener but not the gate when the seed fails', async () => {
    const boot = new TlsBoot();
    await expect(boot.adopt(listener, () => Promise.reject(new Error('disk full')))).rejects.toThrow('disk full');
    expect(boot.listener).toBe(listener);
    expect(boot.gateActive).toBe(false);
  });
});
