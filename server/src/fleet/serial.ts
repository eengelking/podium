// Runs async work in order (#313). Reads and writes of the stores used to be synchronous, so a read-then-write sequence on one session
// (get the stored row, decide, write) could not be interleaved with another. Over an async store it can, so each such sequence runs
// here: one at a time per key (a session id), and a sweep or retention, which spans sessions, runs alone, after the work already
// queued and before the work queued later.

const noop = (): void => undefined;

export class Serializer {
  private readonly keys = new Map<string, Promise<void>>();
  private barrier: Promise<void> = Promise.resolve();

  /** Runs `fn` after everything queued earlier for `key` and after any `exclusive` queued earlier; other keys run alongside. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const after = Promise.all([this.keys.get(key), this.barrier]);
    const result = after.then(fn);
    const settled = result.then(noop, noop);
    this.keys.set(key, settled);
    void settled.then(() => {
      if (this.keys.get(key) === settled) this.keys.delete(key); // promise-ok: compares the identity of the key's tail with this turn's own promise, so a later turn's tail is not deleted
    });
    return result;
  }

  /** Runs `fn` alone: after everything queued earlier for any key, and before anything queued later. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const after = Promise.all([this.barrier, ...this.keys.values()]);
    const result = after.then(fn);
    this.barrier = result.then(noop, noop);
    return result;
  }
}
