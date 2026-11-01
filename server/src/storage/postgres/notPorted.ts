// A store the PostgreSQL adapter has not ported yet (#822): every method rejects, so a missing port fails loudly where it is called.

/** An object typed as `T` whose every method call rejects with "postgres adapter: <name> is not ported yet". */
export function notPorted<T>(name: string): T {
  return new Proxy({}, {
    get(_target, prop) {
      // A store handed back from an async function must not look like a thenable.
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return () => Promise.reject(new Error(`postgres adapter: ${name} is not ported yet`));
    },
  }) as T;
}
