// Chat's reads (#1034). The overview and the open thread are read when the page opens and again whenever the console's `chat`
// signal (or a reconnect) moves `rev`; the signal carries no text, so message text is only ever read from the routes. There is
// no interval here: a page that waits for a signal and also polls would hide a signal that never came.
import { useCallback, useEffect, useRef, useState } from "react";
import { RespondError } from "./respondApi";
import { failReason } from "./useMyPeers";
import { PAGE_SIZE, plain, type AdminRead, type Address, type Cross, type CrossRole, type ChatApi, type ChatOverview, type ChannelMessage, type DirectMessage, type DirectPageRead, type Party } from "./chatData";
import { ReadGate } from "./readGate";

export interface OverviewRead {
  data: ChatOverview | null;
  /** Whose conversations `data` is: the person an Admin picked, or null for the viewer's own. */
  owner: string | null;
  /** Why the last read failed, in the server's words; null after a good one. */
  loadError: string | null;
  /** The server's clock minus the browser's at the last read. */
  skew: number;
  reload: () => Promise<void>;
}

export function useChatOverview(api: ChatApi, on: boolean, rev: number, owner: string | null = null): OverviewRead {
  const [data, setData] = useState<ChatOverview | null>(null);
  const [dataOwner, setDataOwner] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skew, setSkew] = useState(0);
  const [gate] = useState(() => new ReadGate());
  const reload = useCallback(async () => {
    const at = gate.fresh();
    try {
      const d = await api.overview(owner);
      if (!gate.land(at)) return;
      setData(d);
      setDataOwner(owner);
      if (typeof d.serverTime === "number") setSkew(d.serverTime - Date.now());
      setLoadError(null);
    } catch (err) {
      if (!gate.land(at)) return;
      setLoadError(plain(failReason(err)));
    }
  }, [api, gate, owner]);
  useEffect(() => {
    if (!on) {
      setData(null);
      setLoadError(null);
      return;
    }
    void reload();
    return () => gate.drop();
    // rev moving is the signal: read again.
  }, [on, rev, reload, gate]);
  return { data, owner: dataOwner, loadError, skew, reload };
}

/** What the open thread is, whichever store it comes from: the channel's id, or a Direct Message's two ids. */
export type Selection = { kind: "channel"; id: "general" | "group" } | { kind: "dm"; a: string; b: string; key: string };

export const selKey = (s: Selection | null): string | null => (s === null ? null : s.kind === "channel" ? `c:${s.id}` : `d:${s.key}`);

export interface ThreadMessage {
  id: string;
  at: number;
  /** Set for a channel message; null for a Direct Message. */
  channel: ChannelMessage | null;
  direct: DirectMessage | null;
}

export interface ThreadHead {
  a?: Party;
  b?: Party;
  owner?: string;
  paused?: boolean;
  ended?: string[];
  roundTrips?: { used: number; cap: number };
  cross?: Cross | null;
  pausedBy?: CrossRole | null;
  pausedByAdmin?: string | null;
}

export interface ThreadRead {
  messages: ThreadMessage[];
  total: number;
  older: string | null;
  head: ThreadHead | null;
  /** The Admins who read the thread, oldest first (My group and Direct Messages). */
  reads: AdminRead[];
  loaded: boolean;
  /** Why the read failed, with the server's status, or null. */
  error: { status: number | null; text: string } | null;
  loadingEarlier: boolean;
  loadEarlier: () => Promise<void>;
  reload: () => Promise<void>;
}

const fromChannel = (m: ChannelMessage): ThreadMessage => ({ id: m.id, at: m.createdAt, channel: m, direct: null });
const fromDirect = (m: DirectMessage): ThreadMessage => ({ id: m.id, at: m.sentAt, channel: null, direct: m });

/**
 * The newest page of the open thread, and the earlier pages the person asked for. A read after a signal replaces the newest
 * page and keeps the earlier ones, unless the thread now holds fewer messages than are shown (it was cleared or deleted).
 */
export function useThread(api: ChatApi, sel: Selection | null, rev: number, owner: string | null = null): ThreadRead {
  const [latest, setLatest] = useState<ThreadMessage[]>([]);
  const [earlier, setEarlier] = useState<ThreadMessage[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [head, setHead] = useState<ThreadHead | null>(null);
  const [reads, setReads] = useState<AdminRead[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ThreadRead["error"]>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [gate] = useState(() => new ReadGate());
  const key = selKey(sel) === null ? null : `${selKey(sel)}${owner ? `@${owner}` : ""}`;
  const shown = useRef<string | null>(null);
  const cursor = useRef<string | null>(null);
  const kept = useRef(0);
  const latestLen = useRef(0);

  const readPage = useCallback(
    (before: string | null) => {
      if (!sel) return Promise.reject(new Error("no thread"));
      const o = { before, limit: PAGE_SIZE };
      return sel.kind === "channel" ? api.channelMessages(sel.id, owner ? { ...o, owner } : o) : api.dmMessages(sel.a, sel.b, o);
    },
    [api, sel, owner],
  );

  const reload = useCallback(async () => {
    if (!sel) return;
    const at = gate.fresh();
    try {
      const r = await readPage(null);
      if (!gate.land(at)) return;
      const msgs = r.messages.map((m) => ("authorKind" in m ? fromChannel(m as ChannelMessage) : fromDirect(m as DirectMessage)));
      // Fewer messages than are shown means it was cleared or deleted: the earlier pages go.
      if (r.total < kept.current + latestLen.current) {
        setEarlier([]);
        kept.current = 0;
      }
      latestLen.current = msgs.length;
      setLatest(msgs);
      setTotal(r.total);
      // With earlier pages kept, the cursor stays the oldest of them; otherwise it is this page's.
      if (kept.current === 0) {
        cursor.current = r.older;
        setOlder(r.older);
      }
      if ("a" in r) {
        const d = r as DirectPageRead;
        setHead({ a: d.a, b: d.b, owner: d.owner, paused: d.paused, ended: d.ended, roundTrips: d.roundTrips, cross: d.cross ?? null, pausedBy: d.pausedBy ?? null, pausedByAdmin: d.pausedByAdmin ?? null });
      } else setHead(null);
      setReads((r as { adminReads?: AdminRead[] }).adminReads ?? []);
      setError(null);
      setLoaded(true);
    } catch (err) {
      if (!gate.land(at)) return;
      setError({ status: err instanceof RespondError ? err.status : null, text: plain(failReason(err)) });
      setLoaded(true);
    }
  }, [sel, readPage, gate]);

  useEffect(() => {
    if (key !== shown.current) {
      // Another thread: nothing of the old one shows under the new heading.
      shown.current = key;
      setLatest([]);
      setEarlier([]);
      setOlder(null);
      setTotal(0);
      setHead(null);
      setReads([]);
      setLoaded(false);
      setError(null);
      cursor.current = null;
      kept.current = 0;
      latestLen.current = 0;
    }
    if (key === null) return;
    void reload();
    return () => gate.drop();
    // rev moving is the signal: read again.
  }, [key, rev, reload, gate]);

  const loadEarlier = useCallback(async () => {
    const before = cursor.current;
    if (!sel || !before) return;
    setLoadingEarlier(true);
    try {
      const r = await readPage(before);
      const msgs = r.messages.map((m) => ("authorKind" in m ? fromChannel(m as ChannelMessage) : fromDirect(m as DirectMessage)));
      cursor.current = r.older;
      setOlder(r.older);
      kept.current += msgs.length;
      setEarlier((cur) => [...msgs, ...cur]);
      setError(null);
    } catch (err) {
      setError({ status: err instanceof RespondError ? err.status : null, text: plain(failReason(err)) });
    }
    setLoadingEarlier(false);
  }, [sel, readPage]);

  const seen = new Set(latest.map((m) => m.id));
  const messages = [...earlier.filter((m) => !seen.has(m.id)), ...latest];
  return { messages, total, older, head, reads, loaded, error, loadingEarlier, loadEarlier, reload };
}

/** What `@` can mean in a channel, read when the box first needs it and again each time it opens, so a new agent shows. */
export function useAddresses(api: ChatApi, channel: "general" | "group" | null) {
  const [list, setList] = useState<Address[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!channel) return;
    try {
      const r = await api.addresses(channel);
      setList(r.addresses);
      setError(null);
    } catch (err) {
      setError(plain(failReason(err)));
    }
  }, [api, channel]);
  useEffect(() => {
    setList([]);
    setError(null);
  }, [channel]);
  return { list, error, load };
}
