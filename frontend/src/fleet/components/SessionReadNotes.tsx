// What an Admin's read of the person's own session tells the person (#1073, #1074, mockup/podium-admin-read-notices.html): a red notice while an Admin reads,
// and a quiet line for each read after, newest first, three at most. Each has an X that hides it on this browser; the record and the Admin log stay. Only the
// session's owner sees these: an Admin who is not the owner sees nothing, and cannot dismiss another person's. Words only, never any text of the session.
import { useEffect, useState } from "react";
import "../chat.css";
import type { AdminRead } from "../chatData";
import type { SessionReadKind } from "../respondApi";
import { nameKey } from "../respond";
import { readingKey, readingLabel, readingLine, readingRest, readRecordLine, recordLabel, useDismissed, useSessionReads } from "../sessionReads";
import { useRespond } from "../useRespond";
import { ChEye } from "./ChatIcons";

/** Where the notes sit: under the status band of the orchestrator page (`band`), or above the ask in the Respond window (`above`). */
export type SessionReadPlacement = "band" | "above";

const SHOWN = 3;

export function SessionReadNotes({ kind, session, placement = "band" }: { kind: SessionReadKind; session: { id: string; name: string; owner: string | null }; placement?: SessionReadPlacement }) {
  const respond = useRespond();
  const reads = useSessionReads();
  const dismissed = useDismissed();
  const me = respond?.me;
  const owns = !!me?.signedIn && !!me.name && !!session.owner && session.owner !== "Admin" && nameKey(session.owner) === nameKey(me.name);
  const [records, setRecords] = useState<AdminRead[]>([]);
  const rev = reads?.rev ?? 0;
  const api = respond?.api;
  useEffect(() => {
    if (!owns || !api?.sessionReadRecords) {
      setRecords([]);
      return;
    }
    let live = true;
    api.sessionReadRecords(session.id, kind).then(
      (d) => live && setRecords(d.adminReads.filter((r) => (r.kind ?? "read") === "read")),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [owns, api, session.id, kind, rev]);
  if (!owns || !reads) return null;
  const now = reads.serverNow();
  const key = (admin: string, start: number) => readingKey(kind, session.id, admin, start);
  const all = reads.readers(kind, session.id);
  const readers = all.filter((r) => !dismissed.has(key(r.admin, r.since)));
  const liveStarts = new Set(all.map((r) => key(r.admin, r.since)));
  const lines = records
    .filter((r) => !liveStarts.has(key(r.admin, r.startedAt)) && !dismissed.has(key(r.admin, r.startedAt)))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, SHOWN);
  if (!readers.length && !lines.length) return null;
  const close = (label: string, keys: string[]) => (
    <button type="button" className="x" aria-label={`Close notice: ${label}`} onClick={() => keys.forEach(dismissed.dismiss)}>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 2l8 8M10 2l-8 8" />
      </svg>
    </button>
  );
  return (
    <div className={`read-notes ${placement}`} data-testid={`read-notes-${kind}`}>
      {readers.length > 0 && (
        <div className="ch-nav ro crit" role="status" data-testid="read-notice">
          <ChEye />
          <span>
            <b>{readingLine(kind, session.name, readers)}</b> {readingRest(readers)}
          </span>
          {close(
            readingLabel(kind),
            readers.map((r) => key(r.admin, r.since)),
          )}
        </div>
      )}
      {lines.map((r) => (
        <div key={`${r.admin}|${r.startedAt}`} className="ch-nav ro" role="status" data-testid="read-record">
          <ChEye />
          <span>{readRecordLine(kind, session.name, r, now)}</span>
          {close(recordLabel(kind, session.name, r), [key(r.admin, r.startedAt)])}
        </div>
      ))}
    </div>
  );
}
