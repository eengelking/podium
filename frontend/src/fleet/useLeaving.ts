// Keeps a row on screen for the wall's leave animation after it drops out of a list (#1110). The wall does this for a session that leaves
// (`useFleet`, `LEAVE_MS` in `store.ts`, `.leave` in `fleet.css`); the chat's People and agents list uses the same time and the same class, so
// the two cannot drift. Reduced motion is honored by the stylesheet, not here: the row still stays for LEAVE_MS, and the CSS shows no movement.
import { useEffect, useRef, useState } from "react";
import { LEAVE_MS } from "./store";

export interface LeavingRow<T> {
  item: T;
  leaving: boolean;
}

/** `items` as rows, with each item that just left kept at its old place, marked `leaving`, until the leave animation is over. */
export function useLeaving<T>(items: T[], keyOf: (item: T) => string): LeavingRow<T>[] {
  const [rows, setRows] = useState<LeavingRow<T>[]>(() => items.map((item) => ({ item, leaving: false })));
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;

  useEffect(() => {
    const key = keyRef.current;
    const now = new Set(items.map(key));
    setRows((prev) => {
      const next: LeavingRow<T>[] = items.map((item) => ({ item, leaving: false }));
      prev.forEach((r, i) => {
        const k = key(r.item);
        if (now.has(k)) return;
        next.splice(Math.min(i, next.length), 0, { item: r.item, leaving: true });
        if (!timers.current.has(k)) {
          timers.current.set(
            k,
            setTimeout(() => {
              timers.current.delete(k);
              setRows((cur) => cur.filter((x) => !(x.leaving && key(x.item) === k)));
            }, LEAVE_MS),
          );
        }
      });
      // An item that came back before its animation ended is a live row again, and its timer must not remove it.
      for (const k of now) {
        const t = timers.current.get(k);
        if (t) {
          clearTimeout(t);
          timers.current.delete(k);
        }
      }
      return next;
    });
  }, [items]);

  useEffect(() => {
    const held = timers.current;
    return () => {
      held.forEach(clearTimeout);
      held.clear();
    };
  }, []);

  return rows;
}
