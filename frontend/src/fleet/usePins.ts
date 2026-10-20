// The viewer's pinned wall cards (#496), remembered in this browser like the people-view choices.
import { useCallback, useState } from "react";
import { readJson, writeJson } from "./storage";
import { addPin, parsePins, prunePins, removePin, type Pin } from "./pins";

export const PINS_KEY = "podium.pins";

export function usePins(): {
  pins: Pin[];
  /** Pin a card at a slot, or unpin it when it is already pinned. */
  toggle: (id: string, slot: number) => void;
  /** Forget pins for sessions that are not in `known`. */
  prune: (known: ReadonlySet<string>) => void;
} {
  const [pins, setPins] = useState<Pin[]>(() => parsePins(readJson<unknown>(PINS_KEY, null)));
  const set = useCallback((update: (cur: Pin[]) => Pin[]) => {
    setPins((cur) => {
      const next = update(cur);
      if (next !== cur) writeJson(PINS_KEY, next);
      return next;
    });
  }, []);
  const toggle = useCallback((id: string, slot: number) => set((cur) => (cur.some((p) => p.id === id) ? removePin(cur, id) : addPin(cur, id, slot))), [set]);
  const prune = useCallback((known: ReadonlySet<string>) => set((cur) => prunePins(cur, known)), [set]);
  return { pins, toggle, prune };
}
