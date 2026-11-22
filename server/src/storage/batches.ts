// A store call that takes a set (people, session ids, conversations) sends it to the database in batches, so a statement binds a bounded number of values whatever the
// size of the set (#1309). One batch holds as many as this, far below the number of values any adapter allows in one statement.

/** The most values of one set a statement binds. */
export const BATCH = 500;

/** `list` cut into parts of at most `size`, in order. An empty list has none. */
export function chunksOf<T>(list: readonly T[], size: number = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
