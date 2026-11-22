// How many statements the adapters have sent to their database (#1309), so a contract case can state what a store call costs as a number, the same way on
// every adapter. Each adapter adds one for every statement it runs (a transaction's own BEGIN and COMMIT are not counted, and a savepoint is counted by some adapters and not by others, so measure a call made outside a transaction). A case reads it before and after
// the call it measures, with `counted`, and compares the two: a call whose cost must not grow with the number of people or conversations is run at two sizes.

/** The running total, for the adapters to add to. */
export const statementCount = { n: 0 };

/** Runs `fn` and returns its value with the number of statements it sent. Nothing else may be using the storage while it runs. */
export async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; statements: number }> {
  const before = statementCount.n;
  const value = await fn();
  return { value, statements: statementCount.n - before };
}
