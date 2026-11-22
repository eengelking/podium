// Keeps a row on screen for the wall's leave animation after it drops out of a list (#1110). The wall does this for a session that leaves
// (`useFleet`, `LEAVE_MS` in `store.ts`, `.leave` in `fleet.css`); the chat's People and agents list uses the same time and the same class, so
// the two cannot drift. Reduced motion is honored by the stylesheet, not here: the row still stays for LEAVE_MS, and the CSS shows no movement.
import { useEffect, useRef, useState } from "react";
import { LEAVE_MS } from "./store";

export interface LeavingRow<T> {
  item: T;
  leaving: boolean;
}

/** The rows for `items`, with each item of `prev` that is not in them kept at its old place, marked `leaving`. */
function rowsFor<T>(prev: LeavingRow<T>[], items: T[], key: (item: T) => string): LeavingRow<T>[] {
  const now = new Set(items.map(key));
  const next: LeavingRow<T>[] = items.map((item) => ({ item, leaving: false }));
  prev.forEach((r, i) => {
    if (!now.has(key(r.item))) next.splice(Math.min(i, next.length), 0, { item: r.item, leaving: true });
  });
  return next;
}

/** `items` as rows, with each item that just left kept at its old place, marked `leaving`, until the leave animation is over. */
export function useLeaving<T>(items: T[], keyOf: (item: T) => string): LeavingRow<T>[] {
  const [rows, setRows] = useState<LeavingRow<T>[]>(() => items.map((item) => ({ item, leaving: false })));
  const [seen, setSeen] = useState(items);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;

  // A new list is turned into rows while it is drawn, so the list is drawn once for the read and not again after an effect puts the rows in state (#1311).
  if (seen !== items) {
    setSeen(items);
    setRows(rowsFor(rows, items, keyOf));
  }

  // The timers follow the rows: a row that is leaving is removed when its animation is over, and one that came back before then must not be.
  useEffect(() => {
    const key = keyRef.current;
    for (const r of rows) {
      const k = key(r.item);
      if (!r.leaving) {
        const t = timers.current.get(k);
        if (t) {
          clearTimeout(t);
          timers.current.delete(k);
        }
      } else if (!timers.current.has(k)) {
        timers.current.set(
          k,
          setTimeout(() => {
            timers.current.delete(k);
            setRows((cur) => cur.filter((x) => !(x.leaving && key(x.item) === k)));
          }, LEAVE_MS),
        );
      }
    }
  }, [rows]);

  useEffect(() => {
    const held = timers.current;
    return () => {
      held.forEach(clearTimeout);
      held.clear();
    };
  }, []);

  return rows;
}
