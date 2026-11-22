// Chat's reads (#1034). The overview and the open thread are read when the page opens and again whenever the console's `chat`
// signal (or a reconnect) moves `rev`; the signal carries no text, so message text is only ever read from the routes. There is
// no interval here: a page that waits for a signal and also polls would hide a signal that never came.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RespondError } from "./respondApi";
import { failReason } from "./useMyPeers";
import { PAGE_SIZE, mergeGone, plain, type ConversationInfo, type ConversationMessage, type GoneRead, type AdminRead, type Address, type Cross, type CrossRole, type ChatApi, type ChatOverview, type ChannelMessage, type DirectMessage, type DirectPageRead, type Party } from "./chatData";
import { ReadGate } from "./readGate";
import { Landing, LANDING_WAIT_MS } from "./landing";

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

/** The `Landing` the page's reads share (#1311). */
export function useLanding(): Landing {
  return useState(() => new Landing())[0];
}

export function useChatOverview(api: ChatApi, on: boolean, rev: number, owner: string | null, landing: Landing): OverviewRead {
  const [data, setData] = useState<ChatOverview | null>(null);
  const [dataOwner, setDataOwner] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skew, setSkew] = useState(0);
  const [readAt, setReadAt] = useState(0);
  const [tries, setTries] = useState(0);
  const [gone, setGone] = useState<GoneRead[]>([]);
  const [gate] = useState(() => new ReadGate());
  const reload = useCallback(() => {
    const at = gate.fresh();
    return landing.run(
      async () => {
        const d = await api.overview(owner);
        return () => {
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
          setTries((n) => n + 1);
        };
      },
      (err) => () => {
        if (!gate.land(at)) return;
        setLoadError(plain(failReason(err)));
        setTries((n) => n + 1);
      },
    );
  }, [api, gate, owner, landing]);
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

type ReadError = { status: number | null; text: string };
const readError = (err: unknown): ReadError => ({ status: err instanceof RespondError ? err.status : null, text: plain(failReason(err)) });

/** One page as a paging read has it: the messages as the view holds them, where the earlier ones start, and what else the read carried (`extra`). */
interface Page<T, X> {
  messages: T[];
  older: string | null;
  total: number;
  extra: X;
}

/** What a paged view shows. `pages` is how many requests the earlier messages took, so a read after a signal asks for as many. */
interface View<T, X> {
  latest: T[];
  earlier: T[];
  pages: number;
  older: string | null;
  total: number;
  extra: X | null;
  loaded: boolean;
  error: ReadError | null;
  loadingEarlier: boolean;
}

const EMPTY: View<never, never> = { latest: [], earlier: [], pages: 0, older: null, total: 0, extra: null, loaded: false, error: null, loadingEarlier: false };

/** Waits for `p`, and no longer than a Landing waits for a read that has not answered; the timer never outlives the wait. */
async function within(p: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([p, new Promise((done) => (timer = setTimeout(done, LANDING_WAIT_MS)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** A page as the view holds it: a message already held and unchanged stays the same object, so a memoized row is not drawn again (#1311). */
function reuse<T extends { id: string }>(page: T[], held: readonly T[]): T[] {
  const was = new Map(held.map((h) => [h.id, h]));
  return page.map((next) => {
    const old = was.get(next.id);
    return old && JSON.stringify(old) === JSON.stringify(next) ? old : next;
  });
}

/**
 * The newest page of an open thread or conversation, and the earlier pages the person asked for, read through `readPage`. A read after a signal replaces the newest
 * page and reads the earlier ones again, one request for each page kept, so an edit or a delete made in a page already shown (on another
 * console) appears without a reload (#1269). The signal says that something changed and not what, so there is nothing smaller to read.
 * The earlier pages go when it now holds fewer messages than are shown (it was cleared or deleted); a delete of one message
 * leaves a row behind, so the total stays and it is not taken for a clear. `readPage` is the same function until what it reads changes.
 */
function usePaged<T extends { id: string }, X>(key: string | null, readPage: (before: string | null) => Promise<Page<T, X>>, rev: number, landing: Landing) {
  const [view, setView] = useState<View<T, X>>(EMPTY);
  // The view as of the last thing that landed, for the reads that follow a signal: state is stale inside them.
  const now = useRef<View<T, X>>(EMPTY);
  const put = useCallback((next: Partial<View<T, X>>) => {
    now.current = { ...now.current, ...next };
    setView(now.current);
  }, []);
  const [gate] = useState(() => new ReadGate());
  const shown = useRef<string | null>(null);
  // Counts the threads opened, so a page asked for in one is never put in a later one, even when the person comes back to the same thread.
  const epoch = useRef(0);
  // The read for the latest signal until it has landed, and the page Earlier messages is reading: each lands before the other starts from the view, so neither replaces the other's.
  // Each waits for the other for the Landing's bound at most, so a request that is slow or never answers holds nothing for good.
  const reading = useRef<Promise<unknown>>(Promise.resolve());
  const loading = useRef<Promise<unknown>>(Promise.resolve());

  /** Reads the newest page and the earlier pages kept; returns what to do when they land, or null when a newer read replaced this one. */
  const read = useCallback(
    async (at: number): Promise<(() => void) | null> => {
      const r = await readPage(null);
      await within(loading.current);
      if (!gate.land(at)) return null;
      const was = now.current;
      const held = [...was.latest, ...was.earlier];
      const latest = reuse(r.messages, held);
      // Fewer messages than are shown means it was cleared or deleted: the earlier pages go. They go when the read lands (below), because
      // a read that a newer one replaces while it waits in the Landing must leave the pages the view still shows as they were.
      const cleared = r.total < was.earlier.length + was.latest.length;
      // The earlier pages are read again from the new page's cursor back to the oldest message that was shown, so an edit or a delete in
      // them lands, and a message that arrived does not push the oldest one off the end. A page that cannot be read leaves them as they were.
      let again: { earlier: T[]; pages: number; older: string | null } | null = null;
      if (!cleared && was.earlier.length > 0) {
        const target = was.earlier[0]!.id;
        let before = r.older;
        const got: T[][] = [];
        try {
          for (let n = 0; n < was.pages + 2 && before; n++) {
            const pr = await readPage(before);
            if (!gate.land(at)) return null;
            const page = reuse(pr.messages, held);
            got.unshift(page);
            before = pr.older;
            if (page.some((m) => m.id === target)) break;
          }
          again = { earlier: got.flat(), pages: got.length, older: before };
        } catch {
          again = null;
        }
      }
      return () => {
        if (!gate.land(at)) return;
        const cur = now.current;
        const earlier = cleared ? [] : (again?.earlier ?? cur.earlier);
        put({
          latest,
          earlier,
          pages: cleared ? 0 : (again?.pages ?? cur.pages),
          // With no earlier pages kept, the cursor is this page's.
          older: again ? again.older : earlier.length === 0 ? r.older : cur.older,
          total: r.total,
          extra: r.extra,
          error: null,
          loaded: true,
        });
      };
    },
    [readPage, gate, put],
  );

  const reload = useCallback(async () => {
    if (key === null) return;
    const at = gate.fresh();
    const run = landing.run(
      () => read(at),
      (err) => () => {
        if (gate.land(at)) put({ error: readError(err), loaded: true });
      },
    );
    reading.current = Promise.allSettled([run]);
    await run;
  }, [key, gate, landing, read, put]);

  useEffect(() => {
    if (key !== shown.current) {
      // Another thread: nothing of the old one shows under the new heading.
      shown.current = key;
      epoch.current += 1;
      reading.current = loading.current = Promise.resolve();
      put(EMPTY);
    }
    if (key === null) return;
    void reload();
    return () => gate.drop();
    // rev moving is the signal: read again.
  }, [key, rev, reload, gate, put]);

  const loadEarlier = useCallback(async () => {
    if (key === null || !now.current.older || now.current.loadingEarlier) return;
    put({ loadingEarlier: true });
    const opened = epoch.current;
    // A read for a signal that is still out lands first, and this page is read from the cursor it leaves.
    await within(
      (async () => {
        for (let out = reading.current; ; out = reading.current) {
          await out;
          if (out === reading.current) return;
        }
      })(),
    );
    if (epoch.current !== opened) return;
    const before = now.current.older;
    // The read cleared the earlier pages: there is nothing before them to ask for.
    if (!before) return put({ loadingEarlier: false });
    const fetching = readPage(before);
    loading.current = fetching.catch(() => undefined);
    try {
      const r = await fetching;
      // Another thread opened while this page was out: it is not this one's page, and the new view is already clear.
      if (epoch.current !== opened) return;
      const cur = now.current;
      put({ earlier: [...r.messages, ...cur.earlier], pages: cur.pages + 1, older: r.older, error: null, loadingEarlier: false });
    } catch (err) {
      if (epoch.current === opened) put({ error: readError(err), loadingEarlier: false });
    }
  }, [key, readPage, put]);

  const patch = useCallback(
    (m: T) => {
      const swap = (list: T[]) => (list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : list);
      put({ latest: swap(now.current.latest), earlier: swap(now.current.earlier) });
    },
    [put],
  );

  const messages = useMemo(() => {
    const seen = new Set(view.latest.map((m) => m.id));
    return [...view.earlier.filter((m) => !seen.has(m.id)), ...view.latest];
  }, [view.earlier, view.latest]);
  return { messages, total: view.total, older: view.older, extra: view.extra, loaded: view.loaded, error: view.error, loadingEarlier: view.loadingEarlier, loadEarlier, reload, patch };
}

/** The open channel or Direct Message: its pages (see `usePaged`), and for a Direct Message its head. */
export function useThread(api: ChatApi, sel: Selection | null, rev: number, owner: string | null, landing: Landing): ThreadRead {
  const readPage = useCallback(
    async (before: string | null): Promise<Page<ThreadMessage, { head: ThreadHead | null; reads: AdminRead[] }>> => {
      // Nothing is read while there is no thread (`usePaged` has no key then).
      const open = sel!;
      const o = { before, limit: PAGE_SIZE };
      if (open.kind === "channel") {
        const r = await api.channelMessages(open.id, owner ? { ...o, owner } : o);
        return { messages: r.messages.map(fromChannel), older: r.older, total: r.total, extra: { head: null, reads: r.adminReads ?? [] } };
      }
      const r: DirectPageRead = await api.dmMessages(open.a, open.b, o);
      const head = { a: r.a, b: r.b, owner: r.owner, paused: r.paused, ended: r.ended, roundTrips: r.roundTrips, cross: r.cross ?? null, pausedBy: r.pausedBy ?? null, pausedByAdmin: r.pausedByAdmin ?? null };
      return { messages: r.messages.map(fromDirect), older: r.older, total: r.total, extra: { head, reads: r.adminReads ?? [] } };
    },
    [api, sel, owner],
  );
  const { extra, patch, ...t } = usePaged(selKey(sel) === null ? null : `${selKey(sel)}${owner ? `@${owner}` : ""}`, readPage, rev, landing);
  const patchAny = useCallback((m: ChannelMessage | DirectMessage) => patch("authorKind" in m ? fromChannel(m) : fromDirect(m)), [patch]);
  return { ...t, head: extra?.head ?? null, reads: extra?.reads ?? [], patch: patchAny };
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

export interface ConversationRead {
  info: ConversationInfo | null;
  messages: ConversationMessage[];
  total: number;
  older: string | null;
  reads: AdminRead[];
  loaded: boolean;
  error: ReadError | null;
  loadingEarlier: boolean;
  loadEarlier: () => Promise<void>;
  reload: () => Promise<void>;
  /** Puts a message as the server answered an edit or a delete in place of the one with its id. */
  patch: (m: ConversationMessage) => void;
}

/**
 * The open conversation of people and agents (#1278), read the way a thread is (see `usePaged`) whenever the console's content-free `chat` signal moves `rev`.
 * An Admin's read of one with an agent in it is recorded by the server before this lands.
 */
export function useConversation(api: ChatApi, id: string | null, rev: number, landing: Landing): ConversationRead {
  const readPage = useCallback(
    async (before: string | null): Promise<Page<ConversationMessage, { info: ConversationInfo; reads: AdminRead[] }>> => {
      // Nothing is read while there is no conversation (`usePaged` has no key then).
      const r = await api.conversationMessages(id!, { before, limit: PAGE_SIZE });
      return { messages: r.messages, older: r.older, total: r.total, extra: { info: r.conversation, reads: r.adminReads ?? [] } };
    },
    [api, id],
  );
  const { extra, ...t } = usePaged(id, readPage, rev, landing);
  return { ...t, info: extra?.info ?? null, reads: extra?.reads ?? [] };
}
