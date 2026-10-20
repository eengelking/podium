import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIVITY_HISTORY_PAGE } from "../../../server/src/fleet/activityHistoryTypes";
import { respondApi, RespondError } from "./respondApi";
import { readJson, writeJson } from "./storage";
import type { ActivityEntryView, ActivityHistoryNote, ActivityHistoryPage, ActivityReply } from "./types";
import { usePageVisible } from "./usePageVisible";

// The agent activity feed's fetching (#118). The server keeps a loop's entries only while a viewer holds a lease on
// it, and every fetch renews that lease. So this fetches only while the panel is mounted (the modal belongs to it),
// the feed is on and the tab is visible, on the viewer's own interval. It shows only entries that arrived after its
// first answer: entries another viewer was already watching are not backfilled.
//
// The Admin can turn the feed off for the whole server (Admin > Settings > Feature flags). A reply then says
// `enabled: false`: the hook drops what it showed and reports `adminOff`, but keeps asking at the same interval, so the
// feed comes back by itself when the flag is turned on again.
//
// Stored history (#432): when the Admin keeps Activity, a reply carries `history` (counts only). A viewer who may read
// it (the owner or an Admin) gets the newest stored page from the history route and the live entries after it, and can
// ask for older pages. Under the default policy no reply carries `history` and none of this runs.

export type { ActivityReply };
export type FetchActivity = (sessionId: string, loop: string, every: number) => Promise<ActivityReply>;

/** The intervals offered, in seconds; the first is the default. The server takes the same five. */
export const EVERY_CHOICES = [5, 10, 20, 30, 60] as const;
export const EVERY_KEY = "podium.activityEvery";
/** Entries shown, as the server keeps. */
export const FEED_KEPT = 20;

const defaultFetch: FetchActivity = async (sessionId, loop, every) => {
  const res = await fetch(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(loop)}/activity?every=${every}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ActivityReply;
};

/** The viewer's interval from localStorage, 5 s when there is none or it is not one of the five. */
export function readEvery(): number {
  const v = readJson<unknown>(EVERY_KEY, EVERY_CHOICES[0]);
  return (EVERY_CHOICES as readonly unknown[]).includes(v) ? (v as number) : EVERY_CHOICES[0];
}

export function writeEvery(every: number): void {
  writeJson(EVERY_KEY, every);
}

/** Loads one page of a loop's stored entries; `before` is the previous page's `olderBefore`. */
export type FetchHistory = (sessionId: string, loop: string, before?: number | null, limit?: number) => Promise<ActivityHistoryPage>;

/** A shown entry. Stored ones carry a `key` of their own, since their `seq` counts apart from the live feed's. */
export type FeedEntry = ActivityEntryView & { key?: string };

/** What the window says about the stored history of its loop; null under the default policy. */
export interface StoredInfo {
  total: number;
  since: number | null;
  keptUntil: number | null;
  /** More, older entries are stored than are shown. */
  hasOlder: boolean;
  /** This viewer may read them; false for another viewer, or when the history route refused (401 or 403). */
  canRead: boolean;
  owner: string | null;
  policy: ActivityHistoryNote["policy"];
}

export interface FeedState {
  /** The last 20 entries since this viewer started watching, oldest first. With stored history: those stored, then the live ones. */
  entries: FeedEntry[];
  /** Stored history for this loop, or null when none is kept. */
  stored: StoredInfo | null;
  /** Prepends the next older stored page. */
  loadOlder: () => Promise<void>;
  /** How many arrived since this viewer started watching. */
  seen: number;
  /** When the last answer came, by this browser's clock; null before the first. */
  fetchedAt: number | null;
  /** The last fetch failed; the next one is still scheduled. */
  failed: boolean;
  /** False when the server says the session is not live: nothing will come. */
  live: boolean;
  /** The last reply said the Admin has turned the feed off for this server. */
  adminOff: boolean;
}

type Live = Omit<FeedState, "stored" | "loadOlder">;
const EMPTY: Live = { entries: [], seen: 0, fetchedAt: null, failed: false, live: true, adminOff: false };
const NO_OLDER = async () => {};

/** What a stored page holds, keyed apart from the live feed. */
const keyed = (list: ActivityEntryView[]): FeedEntry[] => list.map((e) => ({ ...e, key: `h${e.seq}` }));
const sig = (e: ActivityEntryView) => `${e.at}|${e.kind}|${e.text}`;

interface Store {
  note: ActivityHistoryNote;
  /** Stored entries shown, oldest first. */
  entries: FeedEntry[];
  olderBefore: number | null;
  /** The viewer's history route refused. */
  denied: boolean;
}

export function useActivityFeed(opts: {
  sessionId: string;
  loop: string;
  /** The reporter can send a feed: the option is on (or not known to be off) and the mod is new enough. */
  enabled: boolean;
  /** The loop is still working. A finished one is fetched once more, for its last entries, and then left alone. */
  active: boolean;
  every: number;
  /**
   * The Admin's flag as the console's state last said (true when not known). It only matters when it changes: the hook
   * asks again at once, so the panel follows a flip without waiting out the interval.
   */
  adminOn?: boolean;
  /** Changed by the caller to ask again at once: after sending from Podium, so its entry shows without waiting (#206). */
  nudge?: number;
  fetchActivity?: FetchActivity;
  /** Loads stored pages; the console's own route when left out. */
  fetchHistory?: FetchHistory;
}): FeedState {
  const { sessionId, loop, enabled, active, every } = opts;
  const adminOn = opts.adminOn ?? true;
  const visible = usePageVisible();
  const [state, setState] = useState<Live>(EMPTY);
  const [store, setStore] = useState<Store | null>(null);
  const fetchRef = useRef(opts.fetchActivity ?? defaultFetch);
  fetchRef.current = opts.fetchActivity ?? defaultFetch;
  const historyRef = useRef<FetchHistory>(opts.fetchHistory ?? respondApi.activityHistory);
  historyRef.current = opts.fetchHistory ?? respondApi.activityHistory;
  // Whether the newest stored page is loaded for this loop, and the cursor for the next older one.
  const loaded = useRef<"none" | "loading" | "done">("none");
  const olderRef = useRef<number | null>(null);
  const olderBusy = useRef(false);
  // Bumped when the loop changes, so a page that was still loading is dropped.
  const epoch = useRef(0);
  // The highest `seq` already taken, and the lease it belongs to. Null until the first answer for this loop.
  const cursor = useRef<{ since: number | null; seq: number } | null>(null);

  useEffect(() => {
    cursor.current = null;
    loaded.current = "none";
    olderRef.current = null;
    olderBusy.current = false;
    epoch.current += 1;
    setState(EMPTY);
    setStore(null);
  }, [sessionId, loop]);

  useEffect(() => {
    if (!enabled || !visible) return;
    let cancelled = false;
    // The counts of the reply, and the newest stored page the first time the viewer may read it.
    const takeHistory = async (h: ActivityHistoryNote | undefined) => {
      if (!h) {
        loaded.current = "none";
        setStore(null);
        return;
      }
      if (!h.canRead) {
        loaded.current = "none";
        setStore({ note: h, entries: [], olderBefore: null, denied: false });
        return;
      }
      if (loaded.current === "done") {
        setStore((st) => (st ? { ...st, note: h } : st));
        return;
      }
      if (loaded.current === "loading") return;
      loaded.current = "loading";
      const mine = epoch.current;
      try {
        const page = await historyRef.current(sessionId, loop, null, ACTIVITY_HISTORY_PAGE);
        if (cancelled || mine !== epoch.current) {
          if (mine === epoch.current) loaded.current = "none";
          return;
        }
        loaded.current = "done";
        olderRef.current = page.olderBefore;
        setStore({ note: h, entries: keyed(page.entries), olderBefore: page.olderBefore, denied: false });
      } catch (err) {
        if (mine !== epoch.current) return;
        if (err instanceof RespondError && (err.status === 401 || err.status === 403)) {
          // Not allowed after all (a sign-in that ended): show the other-viewer state, and do not ask again.
          loaded.current = "done";
          setStore({ note: h, entries: [], olderBefore: null, denied: true });
          return;
        }
        loaded.current = "none";
        throw err;
      }
    };
    const tick = async () => {
      try {
        const r = await fetchRef.current(sessionId, loop, every);
        if (cancelled) return;
        // Turned off by the Admin: the server holds nothing for us now, so neither do we. The next lease starts afresh.
        if (r.enabled === false) {
          cursor.current = null;
          loaded.current = "none";
          setStore(null);
          setState({ ...EMPTY, fetchedAt: Date.now(), live: r.live, adminOff: true });
          return;
        }
        await takeHistory(r.history);
        if (cancelled) return;
        const top = r.entries.reduce((n, e) => Math.max(n, e.seq), 0);
        const c = cursor.current;
        // A first answer, or a lease the server started afresh (seq counts from 1 again): what it holds already
        // happened before this viewer was watching, so it is skipped rather than backfilled.
        if (!c || c.since !== r.since) {
          cursor.current = { since: r.since, seq: top };
          setState((st) => ({ ...st, fetchedAt: Date.now(), failed: false, live: r.live, adminOff: false }));
          return;
        }
        const fresh = r.entries.filter((e) => e.seq > c.seq);
        cursor.current = { since: r.since, seq: Math.max(c.seq, top) };
        // An entry sent from Podium can change after it arrives (its note) or go (discarded, or never taken): follow
        // the server for those still in its window.
        const bySeq = new Map(r.entries.map((e) => [e.seq, e]));
        const low = r.entries.length ? r.entries[0]!.seq : Infinity;
        const synced = (list: ActivityEntryView[]) => list.filter((e) => e.kind !== "podium" || e.seq < low || bySeq.has(e.seq)).map((e) => (e.kind === "podium" ? (bySeq.get(e.seq) ?? e) : e));
        setState((st) => ({
          // Stored history lifts the cap: everything shown is also stored.
          entries: loaded.current === "done" ? [...synced(st.entries), ...fresh] : [...synced(st.entries), ...fresh].slice(-FEED_KEPT),
          seen: st.seen + fresh.length,
          fetchedAt: Date.now(),
          failed: false,
          live: r.live,
          adminOff: false,
        }));
      } catch {
        if (!cancelled) setState((st) => ({ ...st, failed: true }));
      }
    };
    void tick();
    const timer = active ? setInterval(() => void tick(), every * 1000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, loop, enabled, visible, active, every, adminOn, opts.nudge]);

  const loadOlder = useCallback(async () => {
    const before = olderRef.current;
    if (before === null || olderBusy.current) return;
    olderBusy.current = true;
    const mine = epoch.current;
    try {
      const page = await historyRef.current(sessionId, loop, before, ACTIVITY_HISTORY_PAGE);
      if (mine !== epoch.current) return;
      olderRef.current = page.olderBefore;
      setStore((st) => {
        if (!st) return st;
        const have = new Set(st.entries.map((e) => e.key));
        return { ...st, entries: [...keyed(page.entries).filter((e) => !have.has(e.key)), ...st.entries], olderBefore: page.olderBefore };
      });
    } catch (err) {
      if (mine !== epoch.current) return;
      if (err instanceof RespondError && (err.status === 401 || err.status === 403)) setStore((st) => (st ? { ...st, denied: true, entries: [], olderBefore: null } : st));
      else setState((st) => ({ ...st, failed: true }));
    } finally {
      if (mine === epoch.current) olderBusy.current = false;
    }
  }, [sessionId, loop]);

  return useMemo<FeedState>(() => {
    if (!store) return { ...state, stored: null, loadOlder: NO_OLDER };
    const canRead = store.note.canRead && !store.denied;
    const stored: StoredInfo = {
      total: store.note.total,
      since: store.note.since,
      keptUntil: store.note.keptUntil,
      hasOlder: canRead && store.olderBefore !== null,
      canRead,
      owner: store.note.owner,
      policy: store.note.policy,
    };
    if (!canRead) return { ...state, entries: [], stored, loadOlder: NO_OLDER };
    // A live entry the page already holds (it arrived while the page was loading) is shown once.
    const have = new Set(store.entries.map(sig));
    return { ...state, entries: [...store.entries, ...state.entries.filter((e) => !have.has(sig(e)))], stored, loadOlder };
  }, [state, store, loadOlder]);
}
