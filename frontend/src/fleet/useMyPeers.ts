// My reporters' data (#415): one read of GET /respond/peers, asked again on an interval while the page is visible, and the
// changes the page makes. The console holds it, so the top bar's "N waiting" and the page always agree. A change shows at
// once and is then read back from the server; a change that fails is undone by that read, and the error says so.
import { useCallback, useEffect, useRef, useState } from "react";
import { RespondError, type PeersApi } from "./respondApi";
import type { PeersRead } from "./peers";

/** How often the read is asked again: often on My reporters, rarely elsewhere, where only the count shows. */
export const PAGE_MS = 10_000;
export const BAR_MS = 30_000;

export interface MyPeers {
  data: PeersRead | null;
  /** Why the last read failed, in the server's words; null after a good one. */
  loadError: { status: number | null; text: string } | null;
  reload: () => Promise<void>;
  /**
   * Makes a change: `optimistic` shows it at once, `run` saves it, then the data is read again. Resolves with the reason
   * it failed, or null.
   */
  change: (run: () => Promise<unknown>, optimistic?: (d: PeersRead) => PeersRead) => Promise<string | null>;
}

/** A refusal in the server's words, or what happened when there was no answer. */
export function failReason(err: unknown): string {
  if (err instanceof RespondError) return err.message;
  return "the server did not answer";
}

export function useMyPeers(api: PeersApi, on: boolean, fast: boolean): MyPeers {
  const [data, setData] = useState<PeersRead | null>(null);
  const [loadError, setLoadError] = useState<MyPeers["loadError"]>(null);
  // A read that started before a change must not undo it when it lands after.
  const gen = useRef(0);
  const current = useRef<PeersRead | null>(null);
  current.current = data;

  const reload = useCallback(async () => {
    const at = gen.current;
    try {
      const d = await api.read();
      if (gen.current !== at) return;
      setData(d);
      setLoadError(null);
    } catch (err) {
      if (gen.current !== at) return;
      setLoadError({ status: err instanceof RespondError ? err.status : null, text: failReason(err) });
    }
  }, [api]);

  useEffect(() => {
    if (!on) {
      setData(null);
      setLoadError(null);
      return;
    }
    void reload();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void reload();
    }, fast ? PAGE_MS : BAR_MS);
    return () => {
      clearInterval(t);
      // A read still in flight belongs to the sign-in that is going: it must not land under the next one, or after it.
      gen.current++;
    };
  }, [on, fast, reload]);

  const change = useCallback(
    async (run: () => Promise<unknown>, optimistic?: (d: PeersRead) => PeersRead) => {
      gen.current++;
      const before = current.current;
      if (optimistic && before) setData(optimistic(before));
      let failed: string | null = null;
      try {
        await run();
      } catch (err) {
        failed = failReason(err);
        // Put back what was there, so nothing shows as changed even if the read below cannot reach the server either.
        setData(before);
      }
      gen.current++;
      await reload();
      return failed;
    },
    [reload],
  );

  return { data, loadError, reload, change };
}
