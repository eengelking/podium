// An Admin replaying a person's recorded session is told to that person (#1075, PROJECT.md "An Admin Never Reads in Silence"). This is the console's side:
// who is replaying the signed-in person's own sessions now (read when the stream's content-free `replay` counter moves, and again when the earliest
// reading ends), the words for it, and the person's own dismissal of a notice or a record line. A dismissal hides one reading on this browser only: the
// record, the Admin log and the callout in the session stay, and only the person it is told to can make it. An Admin sees these only for sessions that
// are their own.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { adminWho, stamp, type AdminRead, type AdminReading } from "./chatData";
import { RespondError } from "./respondApi";
import { readJson, writeJson } from "./storage";
import { useRespond } from "./useRespond";

/** The browser key the dismissed readings are kept under: one entry per reading, `session|admin|start`. */
const KEY = "podium.replay.dismissed";
const KEEP = 200;
/** The read is asked again this long after the earliest reading's end (the Admin's pings have extended it by then), and after a failed read. */
const AFTER_MS = 1_500;
const RETRY_MS = 5_000;

export interface ReplayReads {
  /** The Admins replaying this session now, by the server's clock; hidden once one's `until` has passed. */
  readers: (sessionId: string) => AdminReading[];
  /** The server's clock now, for the lines that say when. */
  serverNow: () => number;
  rev: number;
}

const Ctx = createContext<ReplayReads | null>(null);

/** Null outside the provider (History, tests): nothing about replays shows. */
export const useReplayReads = (): ReplayReads | null => useContext(Ctx);

export function ReplayReadsProvider({ rev, children }: { rev: number; children: ReactNode }) {
  const respond = useRespond();
  const api = respond?.api;
  const on = !!respond?.recordingOn && !!respond.me?.signedIn && !!api?.recordingReads;
  const [sessions, setSessions] = useState<Record<string, AdminReading[]>>({});
  const skew = useRef(0);
  const [tick, setTick] = useState(0);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!on || !api?.recordingReads) {
      setSessions({});
      return;
    }
    let live = true;
    api.recordingReads().then(
      (d) => {
        if (!live) return;
        skew.current = d.serverTime - Date.now();
        setSessions(d.sessions);
        setTries(0);
      },
      (err: unknown) => {
        // A sign-in that has gone ends the notices; any other failure is tried again, so a reading is never hidden on a guess.
        if (!live) return;
        if (err instanceof RespondError && (err.status === 401 || err.status === 404)) setSessions({});
        else setTries((n) => n + 1);
      },
    );
    return () => {
      live = false;
    };
  }, [on, api, rev, tick]);
  // The earliest reading's end moves the read on (its Admin's pings have extended it, or it really ended).
  useEffect(() => {
    if (!on) return;
    const ends = Object.values(sessions).flat().map((r) => r.until);
    const ahead = ends.length ? Math.min(...ends) - (Date.now() + skew.current) : null;
    const delay = tries > 0 ? RETRY_MS : ahead === null ? null : Math.max(ahead, 0) + AFTER_MS;
    if (delay === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), delay);
    return () => clearTimeout(t);
  }, [on, sessions, tries]);
  const readers = useCallback((id: string) => (sessions[id] ?? []).filter((r) => r.until > Date.now() + skew.current), [sessions]);
  const value = useMemo<ReplayReads>(() => ({ readers, serverNow: () => Date.now() + skew.current, rev }), [readers, rev]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ---- Words --------------------------------------------------------------------------------------------------------------

/** The red notice's bold line. */
export function replayersLine(l: readonly AdminReading[]): string {
  const names = l.map((r) => r.admin);
  if (names.length <= 1) return `${adminWho(names[0])} is replaying this recording.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} (Admins) are replaying this recording.`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more Admin${names.length === 3 ? "" : "s"} are replaying this recording.`;
}

/** What the red notice says after the bold line: who else can open it, and when it goes. */
export const replayersRest = (l: readonly AdminReading[]): string => `Only you and Admins can open it. The notice clears about 30 seconds after ${l.length === 1 ? `${l[0]!.admin} stops` : "the last of them stops"}.`;

/** The card's second line while an Admin replays it. */
export const replayersCard = (l: readonly AdminReading[]): string => (l.length === 1 ? `${adminWho(l[0]!.admin)} is replaying it now.` : `${l.length} Admins are replaying it now.`);

/** The quiet line a finished replay leaves: who, when and for how long. */
export function replayRecordLine(r: AdminRead, now: number): string {
  const mins = Math.round((r.lastSeenAt - r.startedAt) / 60_000);
  const span = mins < 1 ? "for under a minute" : `for ${mins} minute${mins === 1 ? "" : "s"}`;
  return `${adminWho(r.admin)} replayed this recording on ${stamp(r.startedAt, now)}, ${span}.`;
}

// ---- The person's dismissals ---------------------------------------------------------------------------------------------

export const readingKey = (sessionId: string, admin: string, start: number): string => `${sessionId}|${admin}|${start}`;

/** The readings this browser's person has dismissed, and a way to dismiss one. Nothing leaves the browser. */
export function useDismissed(): { has: (key: string) => boolean; dismiss: (key: string) => void } {
  const [keys, setKeys] = useState<string[]>(() => readJson<string[]>(KEY, []));
  const has = useCallback((key: string) => keys.includes(key), [keys]);
  const dismiss = useCallback((key: string) => {
    setKeys((old) => {
      const next = [...old.filter((k) => k !== key), key].slice(-KEEP);
      writeJson(KEY, next);
      return next;
    });
  }, []);
  return { has, dismiss };
}
