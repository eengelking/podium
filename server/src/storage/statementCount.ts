// How many statements the adapters have sent to their database (#1309), so a contract case can state what a store call costs as a number, the same way on
// every adapter. Each adapter's contract adapter (test code only, no production file counts) patches the call that sends a statement with `countCalls`. A transaction's own
// BEGIN and COMMIT are not counted, and a savepoint is counted by some adapters and not by others, so measure a call made outside a transaction. A case reads the count before and
// after the call it measures, with `counted`, and compares the two: a call whose cost must not grow with the number of people or conversations is run at two sizes.

/** The running total. */
export const statementCount = { n: 0 };

/** Makes every call of each of `methods` on `target` add one to the total, then run as before. For a contract adapter to patch the calls that send a statement. */
export function countCalls(target: object, methods: readonly string[]): void {
  const t = target as Record<string, (...args: unknown[]) => unknown>;
  for (const m of methods) {
    const original = t[m] as (...args: unknown[]) => unknown;
    t[m] = function (this: unknown, ...args: unknown[]) {
      statementCount.n++;
      return original.apply(this, args);
    };
  }
}

/** Runs `fn` and returns its value with the number of statements it sent. Nothing else may be using the storage while it runs. */
export async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; statements: number }> {
  const before = statementCount.n;
  const value = await fn();
  return { value, statements: statementCount.n - before };
}
