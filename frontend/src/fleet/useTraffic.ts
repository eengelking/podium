// Traffic's data (#417): the open read for the chosen range, asked again on an interval while the page is visible, and
// one conversation's messages, read only for a viewer the server lets read them (its owner or an Admin), so a
// signed-out browser never asks for text, let alone receives it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PeerMessage, TrafficApi, TrafficLink, TrafficRange, TrafficRead } from "./trafficData";
import { failReason } from "./useMyPeers";

/** How often Traffic reads again while it is open. */
export const TRAFFIC_MS = 10_000;

export interface TrafficData {
  data: TrafficRead | null;
  /** Why the last read failed, in the server's words; null after a good one. */
  loadError: string | null;
  /** The server's clock minus the browser's at the last read, so times are counted as the server counts them. */
  skew: number;
  reload: () => Promise<void>;
}

export function useTraffic(api: TrafficApi, on: boolean, range: TrafficRange): TrafficData {
  const [data, setData] = useState<TrafficRead | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skew, setSkew] = useState(0);
  // Each read takes a number, and only the newest one started may land: a read for a range no longer chosen, or an
  // interval read that started before a Pause link's read, must not land over a newer one.
  const gen = useRef(0);

  const reload = useCallback(async () => {
    const at = ++gen.current;
    try {
      const d = await api.read(range);
      if (gen.current !== at) return;
      setData(d);
      if (typeof d.serverTime === "number") setSkew(d.serverTime - Date.now());
      setLoadError(null);
    } catch (err) {
      if (gen.current !== at) return;
      setLoadError(failReason(err));
    }
  }, [api, range]);

  useEffect(() => {
    if (!on) return;
    void reload();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void reload();
    }, TRAFFIC_MS);
    return () => {
      clearInterval(t);
      gen.current++;
    };
  }, [on, reload]);

  return { data, loadError, skew, reload };
}

export interface Conversation {
  messages: PeerMessage[] | null;
  /** Why the read failed, or null. */
  error: string | null;
}

/**
 * The selected conversation's messages, read again whenever its summary changes (a new message, a new state) and on
 * every read of the page, so a failed read tries again by itself. Nothing is asked when `readable` is false.
 */
export function useConversation(api: TrafficApi, link: TrafficLink | null, readable: boolean, tick: unknown): Conversation {
  const [out, setOut] = useState<Conversation>({ messages: null, error: null });
  const a = link?.a.sessionId ?? null;
  const b = link?.b.sessionId ?? null;
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!readable || !a || !b) {
      shown.current = null;
      setOut({ messages: null, error: null });
      return;
    }
    const pair = `${a}|${b}`;
    // Another conversation clears the old one's messages at once, so they never show under the new heading.
    if (shown.current !== pair) setOut({ messages: null, error: null });
    shown.current = pair;
    let live = true;
    api.conversation(a, b).then(
      (r) => {
        if (live) setOut({ messages: r.messages, error: null });
      },
      (err: unknown) => {
        if (live) setOut((cur) => ({ messages: cur.messages, error: failReason(err) }));
      },
    );
    return () => {
      live = false;
    };
  }, [api, a, b, readable, tick]);
  return out;
}
