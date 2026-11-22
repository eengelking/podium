// What was concluded for the signed-in person (#1283): a Direct Message deleted because an agent in it ended. The server keeps the list in memory and moves the
// console's content-free `chat` signal when it grows, so this reads again whenever `rev` moves. It holds names and times, never text. Shared by the wall (a
// notice) and the Chat page (the line in an open thread).
import { useCallback, useEffect, useState } from "react";
import type { ChatApi, Concluded } from "./chatData";

export interface ConcludedRead {
  items: Concluded[];
  /** Dismisses one of them for good, here and on the server. Resolves with the reason it failed, or null. */
  dismiss: (id: string) => Promise<string | null>;
}

const NONE: Concluded[] = [];

export function useConcluded(api: Pick<ChatApi, "concluded" | "dismissConcluded">, on: boolean, rev: number): ConcludedRead {
  const [items, setItems] = useState<Concluded[]>(NONE);
  useEffect(() => {
    if (!on) {
      setItems(NONE);
      return;
    }
    let live = true;
    api
      .concluded()
      .then((r) => live && setItems(r.concluded))
      // A read that failed keeps what was shown: the next signal reads again.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, on, rev]);
  const dismiss = useCallback(
    async (id: string) => {
      try {
        await api.dismissConcluded(id);
        setItems((cur) => cur.filter((x) => x.id !== id));
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : "the server did not answer";
      }
    },
    [api],
  );
  return { items, dismiss };
}
