// Chat's reads (#1034). The overview and the open thread are read when the page opens and again whenever the console's `chat`
// signal (or a reconnect) moves `rev`; the signal carries no text, so message text is only ever read from the routes. There is
// no interval here: a page that waits for a signal and also polls would hide a signal that never came.
import { useCallback, useEffect, useRef, useState } from "react";
import { RespondError } from "./respondApi";
import { failReason } from "./useMyPeers";
import { PAGE_SIZE, mergeGone, plain, type GoneRead, type AdminRead, type Address, type Cross, type CrossRole, type ChatApi, type ChatOverview, type ChannelMessage, type DirectMessage, type DirectPageRead, type Party } from "./chatData";
import { ReadGate } from "./readGate";

export interface OverviewRead {
  data: ChatOverview | null;
  /** Whose conversations `data` is: the person an Admin picked, or null for the viewer's own. */
  owner: string | null;
  /** Why the last read failed, in the server's words; null after a good one. */
  loadError: string | null;
  /** The server's clock minus the browser's at the last read. */
  skew: number;
  /** The server's clock at the last read that landed (epoch ms; 0 before the first). A reading is not hidden until a read at or after its end. */
  readAt: number;
  /** The records of conversations that are gone, kept while the page stays open; each came once, even in a read a newer one replaced. */
  gone: GoneRead[];
  reload: () => Promise<void>;
}

/** How long before the earliest reading ends the overview is read again, and how long after it a last read confirms it ended. */
const READ_LEAD_MS = 5000;
const READ_AFTER_MS = 500;
/** How long to wait before trying again when a read after a reading's end has not landed. */
const READ_RETRY_MS = 2000;

/** The earliest end among the Admin readings the last read has not yet seen end, or null when there is none. */
function earliestEnd(d: ChatOverview | null, readAt: number): number | null {
  if (!d) return null;
  let best: number | null = null;
  for (const r of [...d.channels.flatMap((c) => c.adminReading ?? []), ...d.directs.flatMap((x) => x.adminReading ?? []), ...(d.listReading ?? [])]) {
    if (r.until > readAt && (best === null || r.until < best)) best = r.until;
  }
  return best;
}

export function useChatOverview(api: ChatApi, on: boolean, rev: number, owner: string | null = null): OverviewRead {
  const [data, setData] = useState<ChatOverview | null>(null);
  const [dataOwner, setDataOwner] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skew, setSkew] = useState(0);
  const [readAt, setReadAt] = useState(0);
  const [tries, setTries] = useState(0);
  const [gone, setGone] = useState<GoneRead[]>([]);
  const [gate] = useState(() => new ReadGate());
  const reload = useCallback(async () => {
    const at = gate.fresh();
    try {
      const d = await api.overview(owner);
      // The server sends each record of a deleted conversation once and marks it seen, so a read that a newer one replaced must still
      // keep them (#1051). They are the viewer's own, so only a read of the viewer's own list carries them.
      if (owner === null && d.goneReads?.length) {
        const incoming = d.goneReads;
        setGone((cur) => mergeGone(cur, incoming));
      }
      if (!gate.land(at)) return;
      setData(d);
      setDataOwner(owner);
      if (typeof d.serverTime === "number") {
        setSkew(d.serverTime - Date.now());
        setReadAt(d.serverTime);
      }
      setLoadError(null);
    } catch (err) {
      if (!gate.land(at)) return;
      setLoadError(plain(failReason(err)));
    }
    setTries((n) => n + 1);
  }, [api, gate, owner]);
  useEffect(() => {
    if (!on) {
      setData(null);
      setGone([]);
      setLoadError(null);
      return;
    }
    void reload();
    return () => gate.drop();
    // rev moving is the signal: read again.
  }, [on, rev, reload, gate]);
  // An Admin's read is kept alive by pings that move `rev`, but a page cannot rely on one arriving: it reads again just before the
  // earliest reading ends (the Admin's pings have extended it by then) and once after (so an ended one is dropped on a read, not a guess).
  // A read that fails is tried again, because nothing is hidden before a read has confirmed it ended (#1051).
  useEffect(() => {
    const end = on ? earliestEnd(data, readAt) : null;
    if (end === null) return;
    const ahead = end - (Date.now() + skew);
    const delay = ahead > READ_LEAD_MS + READ_AFTER_MS ? ahead - READ_LEAD_MS : ahead > 0 ? ahead + READ_AFTER_MS : READ_RETRY_MS;
    const timer = setTimeout(() => void reload(), delay);
    return () => clearTimeout(timer);
  }, [on, data, readAt, skew, tries, reload]);
  return { data, owner: dataOwner, loadError, skew, readAt, gone, reload };
}

/** What the open thread is, whichever store it comes from: the channel's id, or a Direct Message's two ids. */
export type Selection = { kind: "channel"; id: string } | { kind: "dm"; a: string; b: string; key: string };

export const selKey = (s: Selection | null): string | null => (s === null ? null : s.kind === "channel" ? `c:${s.id}` : `d:${s.key}`);

export interface ThreadMessage {
  id: string;
  at: number;
  /** Set for a channel message; null for a Direct Message. */
  channel: ChannelMessage | null;
  direct: DirectMessage | null;
}

interface ThreadHead {
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
  /** Puts a message as the server answered an edit or a delete in place of the one with its id, in whichever page holds it (#1269). A message not loaded is not added. */
  patch: (m: ChannelMessage | DirectMessage) => void;
}

const fromChannel = (m: ChannelMessage): ThreadMessage => ({ id: m.id, at: m.createdAt, channel: m, direct: null });
const fromDirect = (m: DirectMessage): ThreadMessage => ({ id: m.id, at: m.sentAt, channel: null, direct: m });
const fromAny = (m: ChannelMessage | DirectMessage): ThreadMessage => ("authorKind" in m ? fromChannel(m) : fromDirect(m));

/**
 * The newest page of the open thread, and the earlier pages the person asked for. A read after a signal replaces the newest
 * page and reads the earlier ones again, one request for each page kept, so an edit or a delete made in a page already shown (on another
 * console) appears without a reload (#1269). The signal says that something changed and not what, so there is nothing smaller to read.
 * The earlier pages go when the thread now holds fewer messages than are shown (it was cleared or deleted); a delete of one message
 * leaves a row behind, so the total stays and it is not taken for a clear.
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
  // The earlier pages, for the read that follows a signal (state is stale inside it), and how many requests they took.
  const earlierNow = useRef<ThreadMessage[]>([]);
  const pagesKept = useRef(0);

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
        earlierNow.current = [];
        kept.current = 0;
        pagesKept.current = 0;
      }
      // The earlier pages are read again from the new page's cursor back to the oldest message that was shown, so an edit or a delete in
      // them lands, and a message that arrived does not push the oldest one off the end. A page that cannot be read leaves them as they were.
      let again: { msgs: ThreadMessage[]; pages: number; cursor: string | null } | null = null;
      if (kept.current > 0) {
        const target = earlierNow.current[0]?.id;
        let before = r.older;
        const got: ThreadMessage[][] = [];
        try {
          for (let n = 0; n < pagesKept.current + 2 && before; n++) {
            const pr = await readPage(before);
            if (!gate.land(at)) return;
            const page = pr.messages.map(fromAny);
            got.unshift(page);
            before = pr.older;
            if (page.some((m) => m.id === target)) break;
          }
          again = { msgs: got.flat(), pages: got.length, cursor: before };
        } catch {
          again = null;
        }
      }
      if (!gate.land(at)) return;
      if (again) {
        setEarlier(again.msgs);
        earlierNow.current = again.msgs;
        kept.current = again.msgs.length;
        pagesKept.current = again.pages;
        cursor.current = again.cursor;
        setOlder(again.cursor);
      }
      latestLen.current = msgs.length;
      setLatest(msgs);
      setTotal(r.total);
      // With no earlier pages kept, the cursor is this page's.
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
      earlierNow.current = [];
      pagesKept.current = 0;
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
      pagesKept.current += 1;
      earlierNow.current = [...msgs, ...earlierNow.current];
      setEarlier(earlierNow.current);
      setError(null);
    } catch (err) {
      setError({ status: err instanceof RespondError ? err.status : null, text: plain(failReason(err)) });
    }
    setLoadingEarlier(false);
  }, [sel, readPage]);

  const patch = useCallback((m: ChannelMessage | DirectMessage) => {
    const next = fromAny(m);
    const swap = (list: ThreadMessage[]) => (list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? next : x)) : list);
    setLatest(swap);
    earlierNow.current = swap(earlierNow.current);
    setEarlier(earlierNow.current);
  }, []);

  const seen = new Set(latest.map((m) => m.id));
  const messages = [...earlier.filter((m) => !seen.has(m.id)), ...latest];
  return { messages, total, older, head, reads, loaded, error, loadingEarlier, loadEarlier, reload, patch };
}

/** What `@` can mean in a channel, read when the box first needs it and again each time it opens, so a new agent shows. */
export function useAddresses(api: ChatApi, channel: string | null) {
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
