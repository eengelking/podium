// What an Admin's reading looks like in Chat (#1034, mockup/podium-chat.html): the picker an Admin chooses a person with, the red
// tags and banners the person sees while an Admin reads or after one paused, the record line a visit leaves among the messages,
// and the banner the Admin sees. Every word is a text node, and every banner is a polite status with an icon and words, never color alone.
import { adminWho, goneRecordParts, listReadersLine, listRecordLine, LIST_READING_REST, onDay, readersLine, readersStops, readersTip, recordLine, stamp, type AdminRead, type AdminReading, type GoneRead } from "../chatData";
import { ChEye, ChLock, ChPause } from "./ChatIcons";
import { Tip } from "./Tip";

/** The red "Admin reading" and "Paused by an Admin" tags of a row or a thread's header. */
export function AdminTags({ readers, pause }: { readers: AdminReading[]; pause: { name: string | null } | null }) {
  if (!readers.length && !pause) return null;
  return (
    <>
      {pause && (
        <span className="tag crit" data-testid="chat-tag-paused">
          <ChPause />
          <span>Paused by an Admin</span>
        </span>
      )}
      {readers.length > 0 && (
        <span className="tag crit" data-testid="chat-tag-reading">
          <ChEye />
          <span>Admin reading</span>
        </span>
      )}
    </>
  );
}

/** What the person (and, across owners, the other person) sees above the messages while an Admin has the thread open. */
export function ReadingBanner({ readers, also, now }: { readers: AdminReading[]; also: string | null; now: number }) {
  if (!readers.length) return null;
  return (
    <div className="ch-nav ro crit" role="status" data-testid="chat-reading-banner">
      <ChEye />
      <span>
        <b>{readersLine(readers)}</b> Only you{also ? `, ${also}` : ""} and Admins can read it. The notice clears about 30 seconds after {readersStops(readers)}.{" "}
        <Tip text={readersTip(readers, (t) => stamp(t, now))}>Who is reading</Tip>
      </span>
    </div>
  );
}

/** The full-width banner a person sees while an Admin looks at their list of conversations (#1051, mockup/podium-chat-security.html section 5). */
export function ListReadingBanner({ readers }: { readers: AdminReading[] }) {
  if (!readers.length) return null;
  const several = readers.length > 1;
  return (
    <div className="ch-nav ro crit" role="status" data-testid="chat-list-reading-banner">
      <ChEye />
      <span>
        <b>{listReadersLine(readers)}</b> {several ? "are " : "is "}
        {LIST_READING_REST}
      </span>
    </div>
  );
}

/** The quiet record of the looks an Admin took at the person's list, newest first, a few of them. */
export function ListRecordLines({ reads, max = 3 }: { reads: AdminRead[]; max?: number }) {
  const shown = reads.filter((r) => (r.kind ?? "read") === "read").slice(-max).reverse();
  if (!shown.length) return null;
  return (
    <>
      {shown.map((r) => (
        <div key={`${r.admin}|${r.startedAt}`} className="ch-nav ro" role="status" data-testid="chat-list-record">
          <ChEye />
          <span>{listRecordLine(r)}</span>
        </div>
      ))}
    </>
  );
}

/**
 * The quiet lines for the records of a conversation that has since been deleted (#1051): there is no thread left to show them on, so the top of the list does.
 * Newest first as sent. Names are text nodes inside <bdi>, so a name cannot bend the sentence.
 */
export function GoneRecordLines({ reads }: { reads: readonly GoneRead[] }) {
  return (
    <>
      {reads.map((r) => {
        const p = goneRecordParts(r);
        return (
          <div key={`${r.admin}|${r.startedAt}|${r.kind}|${r.with}`} className="ch-nav ro" role="status" data-testid="chat-gone-record">
            <ChEye />
            <span>
              <bdi>{p.admin}</bdi> {p.what} your conversation with <bdi>{p.with}</bdi> on {p.when}. That conversation has since been deleted.
            </span>
          </div>
        );
      })}
    </>
  );
}

/** A pause an Admin made, for the people it holds and for the Admin. */
export function AdminPauseBanner({ name, group, you }: { name: string | null; group: boolean; you: boolean }) {
  const what = group ? "every agent in this group" : "this link";
  return (
    <div className="ch-nav ro crit" role="status" data-testid="chat-admin-pause-banner">
      <ChPause />
      <span>
        {you ? (
          <>
            <b>You paused {what}.</b> Messages are held until you resume it from its menu.
          </>
        ) : (
          <>
            <b>
              {adminWho(name)} paused {what}.
            </b>{" "}
            Messages are held and nothing is sent. Only an Admin can resume it.
          </>
        )}
      </span>
    </div>
  );
}

/** The Admin's own banner on a person's thread. */
export function ReadOnlyBanner({ owner, also }: { owner: string; also: string | null }) {
  return (
    <div className="ch-nav ro crit" role="status" data-testid="chat-ro-banner">
      <ChLock />
      <span>
        <b>Reading {owner}&apos;s conversation as an Admin. You cannot send here.</b> {owner}
        {also ? ` and ${also} are` : " is"} told while you read, and a line stays in the conversation afterward.
      </span>
    </div>
  );
}

/** The quiet line a visit of an Admin leaves in the thread: not a message, so nothing to select and no delivery line. */
export function RecordLine({ r }: { r: AdminRead }) {
  return (
    <li className="ch-rec" data-testid="chat-record" title={onDay(r.startedAt)}>
      <ChEye />
      <span>{recordLine(r)}</span>
    </li>
  );
}

const READ_NOTE = "Pick a person to see their My group and Direct Messages. Read only. While you read, the person sees a red notice, and a line stays in the conversation afterward. Podium records in the audit log that you read it, never the text.";

/** The Admin's choice of whose conversations to read, with Stop reading while one is chosen (#1066). The long note is behind the (i). */
export function ReadPicker({ people, value, onChange }: { people: string[]; value: string | null; onChange: (name: string | null) => void }) {
  return (
    <section className="ch-sec" aria-labelledby="sec-rd">
      <h2 id="sec-rd">Read as an Admin</h2>
      <div className="ch-read">
        <div className="rd-head">
          <label htmlFor="read-as">Read a person&apos;s conversations</label>
          <Tip text={READ_NOTE} label="About reading as an Admin" className="rd-i">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5" />
              <path d="M8 7.2v4M8 4.8v.2" />
            </svg>
          </Tip>
        </div>
        <select className="field sm" id="read-as" data-testid="chat-read-as" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">{people.length ? "Choose a person…" : "No one else uses Chat yet"}</option>
          {people.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        {value && (
          <>
            <button type="button" className="btn sm" data-testid="chat-stop-reading" onClick={() => onChange(null)}>
              Stop reading
            </button>
            <p className="hint">
              Showing <bdi>{value}</bdi>&apos;s My group and Direct Messages. Read only.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
