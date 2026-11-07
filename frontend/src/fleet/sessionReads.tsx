// An Admin reading the content of a person's session is told to that person (#1073 a waiting ask, #1074 stored Activity; PROJECT.md "An Admin Never Reads in
// Silence"). This is the console's side, one mechanism for every kind of read: who is reading the signed-in person's own sessions now (read when the stream's
// content-free `reads` counter moves, and again when the earliest reading ends), the words for each kind, the person's own dismissal of a notice or a record
// line, and the ping an Admin's open read sends. A dismissal hides one reading on this browser only: the record, the Admin log and the callout in the
// session stay, and only the person it is told to can make it. An Admin sees these only for sessions that are their own. A new kind is one entry in WORDS.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { adminWho, readersStops, stamp, type AdminRead, type AdminReading } from "./chatData";
import { RespondError, type SessionReadKind } from "./respondApi";
import { readJson, writeJson } from "./storage";
import { useRespond } from "./useRespond";

/** The browser key the dismissed readings are kept under: one entry per reading, `kind|session|admin|start`. */
const KEY = "podium.sessionreads.dismissed";
const KEEP = 200;
/** The read is asked again this long after the earliest reading's end (the Admin's pings have extended it by then), and after a failed read. */
const AFTER_MS = 1_500;
const RETRY_MS = 5_000;
/** An Admin's open read pings this often; the server counts a reading live for twice that. */
export const PING_MS = 15_000;

export interface SessionReads {
  /** The Admins reading this session now (by the server's clock), hidden once one's `until` has passed. */
  readers: (kind: SessionReadKind, sessionId: string) => AdminReading[];
  /** The server's clock now, for the lines that say when. */
  serverNow: () => number;
  /** Counts the stream's `reads` signals; the record lines read again when it moves. */
  rev: number;
}

const Ctx = createContext<SessionReads | null>(null);

/** Null outside the provider (History, tests): nothing about reads shows. */
export const useSessionReads = (): SessionReads | null => useContext(Ctx);

export function SessionReadsProvider({ rev, children }: { rev: number; children: ReactNode }) {
  const respond = useRespond();
  const api = respond?.api;
  const on = !!respond?.me?.signedIn && !!api?.sessionReads;
  const [readers, setReaders] = useState<Record<string, Record<string, AdminReading[]>>>({});
  const skew = useRef(0);
  const [tick, setTick] = useState(0);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!on || !api?.sessionReads) {
      setReaders({});
      return;
    }
    let live = true;
    api.sessionReads().then(
      (d) => {
        if (!live) return;
        skew.current = d.serverTime - Date.now();
        setReaders(d.readers);
        setTries(0);
      },
      (err: unknown) => {
        // A sign-in that has gone ends the notices; any other failure is tried again, so a reading is never hidden on a guess.
        if (!live) return;
        if (err instanceof RespondError && (err.status === 401 || err.status === 404)) setReaders({});
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
    const ends = Object.values(readers).flatMap((bySession) => Object.values(bySession).flat().map((r) => r.until));
    const ahead = ends.length ? Math.min(...ends) - (Date.now() + skew.current) : null;
    const delay = tries > 0 ? RETRY_MS : ahead === null ? null : Math.max(ahead, 0) + AFTER_MS;
    if (delay === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), delay);
    return () => clearTimeout(t);
  }, [on, readers, tries]);
  const value = useMemo<SessionReads>(
    () => ({
      readers: (kind, id) => (readers[kind]?.[id] ?? []).filter((r) => r.until > Date.now() + skew.current),
      serverNow: () => Date.now() + skew.current,
      rev,
    }),
    [readers, rev],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * An Admin's open read of someone else's session keeps its owner's notice alive: pings every 15 seconds while `on`. Nothing is sent for a person's own
 * session (the server tells no one then), and a failed ping is tried again at the next one.
 */
export function useReadingPing(kind: SessionReadKind, sessionId: string | null, loop: string | undefined, on: boolean): void {
  const api = useRespond()?.api;
  useEffect(() => {
    if (!on || !sessionId || !api?.sessionReading) return;
    const ping = () => void api.sessionReading?.(sessionId, kind, loop).catch(() => undefined);
    const t = setInterval(ping, PING_MS);
    return () => clearInterval(t);
  }, [on, sessionId, api, kind, loop]);
}

// ---- Words --------------------------------------------------------------------------------------------------------------

interface Words {
  /** What the Admin is doing now, after the Admin's name: "is reading your waiting plan". Several Admins: "are" in place of "is". */
  doing: (session: string) => string;
  /** What the Admin did, after the Admin's name: "opened your waiting plan". */
  did: (session: string) => string;
  /** What the notice's close button names. */
  label: string;
}

const WORDS: Record<SessionReadKind, Words> = {
  ask: { doing: () => "reading your waiting plan", did: () => "opened your waiting plan", label: "your waiting plan" },
  activity: { doing: (s) => `paging through the stored Activity of ${s}`, did: (s) => `read the stored Activity of ${s}`, label: "your stored Activity" },
};

const more = (n: number) => `${n} more Admin${n === 1 ? "" : "s"}`;

/** The red notice's bold line: the first two Admins by name, the rest counted. */
export function readingLine(kind: SessionReadKind, session: string, l: readonly AdminReading[]): string {
  const what = WORDS[kind].doing(session);
  const names = l.map((r) => r.admin);
  if (names.length <= 1) return `${adminWho(names[0])} is ${what}.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} (Admins) are ${what}.`;
  return `${names[0]}, ${names[1]} and ${more(names.length - 2)} are ${what}.`;
}

/** What the red notice says after the bold line: who else can open it, and when it goes. */
export const readingRest = (l: readonly AdminReading[]): string => `Only you and Admins can open it. The notice clears about 30 seconds after ${readersStops(l)}.`;

/** The quiet line a finished read leaves: who, what and when. Never any text. */
export const readRecordLine = (kind: SessionReadKind, session: string, r: AdminRead, now: number): string => `${adminWho(r.admin)} ${WORDS[kind].did(session)} on ${stamp(r.startedAt, now)}.`;

/** The close button's name for the red notice, and for a record line. */
export const readingLabel = (kind: SessionReadKind): string => `Admin reading ${WORDS[kind].label}`;
export const recordLabel = (kind: SessionReadKind, session: string, r: AdminRead): string => `${adminWho(r.admin)} ${WORDS[kind].did(session)}`;

// ---- The person's dismissals ---------------------------------------------------------------------------------------------

export const readingKey = (kind: SessionReadKind, sessionId: string, admin: string, start: number): string => `${kind}|${sessionId}|${admin}|${start}`;

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
