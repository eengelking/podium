// The HTTPS listener and the first-run decision about reporters on HTTP, held together (#313). The listener is serving the
// moment it listens, so it is adopted in the same turn `startTls` resolves: a valid client certificate is trusted from the
// first connection. The seeding of "may reporters use HTTP" needs the stores, which are asynchronous, so the HTTP gate waits
// for it instead: it refuses nothing until the answer is stored, which is what a fresh install did before the listener existed.
import type { TlsListener } from './tlsServer.js';

export class TlsBoot {
  private current: TlsListener | null = null;
  private seeded = false;

  /** The running listener, or null while it is off, failed to start, or has not started. */
  get listener(): TlsListener | null {
    return this.current;
  }

  /** True once there is a listener and the decision about reporters on HTTP is stored; only then may the gate refuse. */
  get gateActive(): boolean {
    return this.current !== null && this.seeded;
  }

  /** Takes the listener at once (synchronously), then runs `seed`; a seed that fails leaves the gate off and rejects. */
  async adopt(listener: TlsListener | null, seed: () => Promise<void>): Promise<void> {
    this.current = listener;
    if (listener === null) return;
    await seed();
    this.seeded = true;
  }
}
