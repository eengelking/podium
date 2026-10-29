import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One queue per SQLite connection. The three stores share the connection, so a call from another task must never run
 * inside someone's open transaction: every adapter call takes this lock, and `tx` holds it for its whole callback.
 * A call made inside a `tx` callback sees this lock in its async context, so it runs directly instead of queueing
 * behind the transaction that is waiting on it.
 */
export class AsyncLock {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly held = new AsyncLocalStorage<AsyncLock>();

  /** Whether the caller is inside a `run` of this lock. */
  inside(): boolean {
    return this.held.getStore() === this;
  }

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.inside()) return Promise.resolve().then(fn);
    const result = this.tail.then(() => this.held.run(this, fn));
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Resolves when everything queued so far has finished. */
  drain(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
