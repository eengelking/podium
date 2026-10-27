import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cellWords } from "../recording";
import { useRespond } from "../useRespond";
import { RecordPicker } from "./RecordPicker";
import { fmtDur, fmtTok } from "../format";
import { AGENT_TIME_HINT, AGENTS_HINT, COST_HINT_SESSION, sessionAgentSec, sessionCounts, sessionElapsedSec, sessionTokens, TOKENS_HINT } from "../logic";
import { systemKind } from "../peers";
import type { SessionView } from "../types";
import { BlowBadge, Cost } from "./Chips";
import { IconCheck, IconChevron, IconCopy, IconWarn, IconX } from "./Icons";
import { NOT_REPORTED, SYSTEM_ICON } from "./PeerRights";
import { HOOKS_NOTE, versionNote } from "./SessionCard";
import { SHORT_ID, useCopy } from "./SessionId";


/** The nearest ancestor that scrolls, or the document: what would clip a popup that opens upward. */
function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return document.documentElement;
}

/**
 * What a cell with a popup needs (Resume, Fork, Machine and System): it opens on hover and on keyboard focus, closes on Escape or when the pointer
 * or focus leaves, and opens above the cell, or below it when the scrolling page has no room above.
 */
function usePopup() {
  const [dismissed, setDismissed] = useState(false);
  const [below, setBelow] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const tipEl = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const place = () => {
    if (!wrap.current || !tipEl.current) return;
    const sp = scrollParent(wrap.current);
    // The document's own rect scrolls away with the page; its visible top is the viewport's 0.
    const limit = sp === document.documentElement ? 0 : sp.getBoundingClientRect().top;
    const room = wrap.current.getBoundingClientRect().top - limit;
    setBelow(room < tipEl.current.offsetHeight + 16);
  };
  const props = {
    ref: wrap,
    className: `pop${dismissed ? " dismissed" : ""}${below ? " below" : ""}`,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    },
    onMouseEnter: place,
    onFocus: place,
    onMouseLeave: () => {
      // Keyboard focus still inside keeps the popup open, so keep Escape's dismissal until focus leaves too.
      if (!wrap.current?.contains(document.activeElement)) setDismissed(false);
    },
    onBlur: () => setDismissed(false),
  };
  return { props, tipEl, tipId };
}

/**
 * A quiet whole-cell control that copies `text` (Resume and Fork, #352). "Copied" with a check for 1.6 s; when the clipboard refuses nothing changes.
 * `tip` is the popup that says what the command does; it holds text only, and the cell points to it with `aria-describedby`.
 */
export function CopyCell({ label, name, text, tip }: { label: string; name: string; text: string; tip: ReactNode }) {
  const { state, copy } = useCopy(text);
  const { props, tipEl, tipId } = usePopup();
  const copied = state === "copied";
  return (
    <div {...props} role="group" aria-label={label} className={`fact copy ${props.className}`}>
      <button type="button" className="cellbtn" onClick={copy} aria-label={name} aria-describedby={tipId}>
        <span className="k">{label}</span>{" "}
        <span className="v soft" aria-live="polite">
          <span>{copied ? "Copied" : "Command"}</span>
          {copied ? <IconCheck /> : <IconCopy />}
        </span>
      </button>
      <div className="tip" role="tooltip" id={tipId} ref={tipEl}>
        {tip}
      </div>
    </div>
  );
}

/** A cell that only reads: a label over a value, with the same kind of popup Resume and Fork have. Focusable, so the popup opens from the keyboard too (#427). */
function PopCell({ label, value, valueClass, tip }: { label: string; value: ReactNode; valueClass?: string; tip: ReactNode }) {
  const { props, tipEl, tipId } = usePopup();
  return (
    <div {...props} role="group" aria-label={label} tabIndex={0} aria-describedby={tipId} className={`fact start ${props.className}`} /* NOSONAR S6845: focusable so its popup opens from the keyboard (#427) */>
      <div className="k">{label}</div>
      <div className={`v${valueClass ? ` ${valueClass}` : ""}`}>{value}</div>
      <div className="tip" role="tooltip" id={tipId} ref={tipEl}>
        {tip}
      </div>
    </div>
  );
}

/** The session id's first eight characters; a click copies the whole id, with the card's feedback (#322, #352). */
function SessionCell({ id }: { id: string }) {
  const { state, copy } = useCopy(id);
  const short = id.slice(0, SHORT_ID);
  return (
    <div className="fact copy">
      <button type="button" className="cellbtn" onClick={copy} title={id} aria-label={`Session ${short}, copy the full id`}>
        <span className="k">Session</span>{" "}
        <span className="v mono" aria-live="polite">
          <span>{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : short}</span>
          {state === "copied" ? <IconCheck /> : <IconCopy />}
        </span>
      </button>
    </div>
  );
}

const RESUME_TIP = (
  <>
    <b>Continues this same session in a new terminal.</b>
    <ul>
      <li>It picks up the whole conversation where it left off.</li>
      <li>Run it once the session has ended. Resuming one that is still running in another terminal writes both into the same conversation.</li>
      <li>
        It starts in this session's working directory. Flags such as <code>--mcp-config</code> are not restored; pass them again.
      </li>
      <li>To try something without changing this session, use Fork.</li>
    </ul>
  </>
);

const FORK_TIP = (
  <>
    <b>Starts a copy of this conversation in a new session.</b>
    <ul>
      <li>This session is not changed.</li>
      <li>Permissions you allowed for the session are not carried over. Approve them again in the fork.</li>
      <li>It works in the same directory, so file edits are real. Start it in a worktree to keep them apart.</li>
      <li>
        Flags such as <code>--mcp-config</code>, <code>--settings</code>, <code>--plugin-dir</code> and <code>--add-dir</code> are not restored. Pass them again if the session used them.
      </li>
      <li>It needs the session's transcript, which Claude Code keeps for 30 days by default.</li>
    </ul>
  </>
);

const NO_MACHINE_TIP = (
  <>
    <b>Not reported.</b> This session sends no machine, so its system is unknown. Podium learns the machine only from a reporter that has a user name. Install podium-reporter and set <code>userName</code> in its options to fill it in.
  </>
);

/**
 * The machine the session runs on and its system, joined in one cell (#353): `Silverbolt | macOS 26.0`. Each half says Not reported when
 * the session did not send it (no user name, an older reporter, or a failed read, #427). The popup holds the whole text, which the cell
 * cuts with an ellipsis.
 */
function MachineFact({ s }: { s: SessionView }) {
  const name = s.machine?.name;
  const os = s.machine?.os;
  const kind = systemKind(os ?? null);
  if (!name && !(os && kind)) return <PopCell label="Machine" value={NOT_REPORTED} valueClass="soft" tip={NO_MACHINE_TIP} />;
  const system = os && kind ? kind : null;
  return (
    <PopCell
      label="Machine"
      valueClass="mono"
      value={
        <>
          {name ? <span className="mname">{name}</span> : <span className="soft">{NOT_REPORTED}</span>}
          <span className="sep" aria-hidden="true">
            |
          </span>
          {system ? (
            <>
              <span className="sysi">{SYSTEM_ICON[system]}</span>
              <span className="sys-t">{os}</span>
            </>
          ) : (
            <span className="soft">{NOT_REPORTED}</span>
          )}
        </>
      }
      tip={
        <>
          <b>The machine this session runs on, and its system.</b> {name ? `Machine: ${name}.` : "The machine is not reported: Podium learns it only from a reporter that has a user name."}{" "}
          {system ? `System: ${os}.` : "The system is not reported: it is an older podium-reporter, or the command to read it failed on the machine."}
        </>
      }
    />
  );
}

/**
 * Recording (#353): the last cell. Not recorded, it is a button like Resume and Fork that opens the picker, for a session that
 * runs while the Admin's flag is on. Otherwise it states the recording's state in shape, word and color; the buttons for Stop, Open
 * replay and Delete stay in the layer above the band. The record mark is a ring with a disc: the disc is neutral when idle, absent
 * when the recording is only kept, and red and pulsing on the app's shared beat only while it records.
 */
function RecordingFact({ s, now }: { s: SessionView; now: number }) {
  const respond = useRespond();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const v = s.recording;
  const mark = (kind: "idle" | "live" | "kept") => (
    <span className={`rec-i${kind === "idle" ? "" : ` ${kind}`}`} aria-hidden="true">
      <i />
    </span>
  );
  if (v) {
    const w = cellWords(v, now);
    const live = v.state === "recording" && v.ownerAllows;
    return (
      <div className="fact rec" title={w.title}>
        <div className="k">Recording</div>
        <div className={`v${live ? " recording" : ""}`}>
          {w.text}
          {mark(live ? "live" : v.state === "recording" ? "idle" : "kept")}
        </div>
      </div>
    );
  }
  if (!respond?.recordingOn || s.status === "done") {
    return (
      <div className="fact rec" title={s.status === "done" ? "This session ended without being recorded." : "Session recording is off on this server."}>
        <div className="k">Recording</div>
        <div className="v soft">Not recorded</div>
      </div>
    );
  }
  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
  return (
    <div className="fact copy rec">
      <button type="button" className="cellbtn" ref={opener} aria-haspopup="dialog" aria-label="Record this session" onClick={() => setOpen(true)}>
        <span className="k">Recording</span>
        <span className="v">
          <span>Record</span>
          {mark("idle")}
        </span>
      </button>
      {open && <RecordPicker s={s} onClose={close} />}
    </div>
  );
}

/** The reporter mod's version; "Settings hooks" when there is no mod; the card chip's wording, a warning shape and the note as its tooltip when the server places it out of range. */
function ReporterFact({ s }: { s: SessionView }) {
  const note = versionNote(s);
  if (!note && (s.reporterVersion === null || s.reporter === "hooks")) {
    return (
      <div className="fact" title={`${HOOKS_NOTE} Install podium-reporter from eengelking-marketplace for the full view.`}>
        <div className="k">Reporter</div>
        <div className="v soft">Settings hooks</div>
      </div>
    );
  }
  return (
    <div className={`fact${note ? " warn" : ""}`} title={note ? (s.reporter === "hooks" ? `${note.text} ${HOOKS_NOTE}` : note.text) : "The podium-reporter mod's version in this session"}>
      <div className="k">Reporter</div>
      <div className="v mono">
        {note && <IconWarn />}
        {note ? note.label : s.reporterVersion}
        {s.reporterBuild ? ` · Dev: ${s.reporterBuild}` : ""}
      </div>
    </div>
  );
}

/** Always present. "none" when clear; with blowouts it is the button that opens the detail between the header and these cells. */
function BlowoutsFact({ s, blow }: { s: SessionView; blow?: BlowControl }) {
  const b = s.blowouts;
  if (!b.total) {
    return (
      <div className="fact" title="Times a context window ran over">
        <div className="k">Blowouts</div>
        <div className="v soft">none</div>
      </div>
    );
  }
  // Without a toggle there is nothing to open, so the cell is plain text rather than a dead control.
  if (!blow) {
    return (
      <div className="fact" title="Times a context window ran over">
        <div className="k">Blowouts</div>
        <div className="v">
          <BlowBadge n={b.total} level={b.level} />
        </div>
      </div>
    );
  }
  return (
    <button type="button" className="fact blowcell" aria-expanded={blow.open} aria-controls={blow.open ? blow.controls : undefined} onClick={blow.onToggle} title="Times a context window ran over. Click for which loops.">
      <span className="k">
        Blowouts
        <IconChevron className="chev" />
      </span>
      <span className="v">
        <BlowBadge n={b.total} level={b.level} />
      </span>
    </button>
  );
}

/** What the Blowouts cell needs from the page: whether the detail is open, how to toggle it, and the detail's id. */
export interface BlowControl {
  open: boolean;
  onToggle: () => void;
  controls: string;
}

/**
 * Twelve cells in fixed places, six to a row (#165, #352, #427). Row one: Agents, Est. cost, Tokens, Running for, Agent time, Blowouts.
 * Row two: Machine and System (joined in one cell, #353), Reporter, Session, Resume, Fork, Recording. A cell never moves because another has nothing to say.
 */
export function FactsBar({ s, now, onAgent, blow }: { s: SessionView; now: number; onAgent: (id: string) => void; blow?: BlowControl }) {
  const c = sessionCounts(s);
  const firstFail = s.agents.find((a) => a.status === "failed");
  return (
    <div className="facts six">
      <div className="fact agents" title={AGENTS_HINT}>
        <div className="k">Agents</div>
        <div className="v mono">
          <span className="n-running">{c.running} running</span>
          <span className="n-done">{` / ${c.done} done`}</span>
          {firstFail && (
            <button type="button" className="blow l2" onClick={() => onAgent(firstFail.id)} title="Show the first failure">
              <IconX />
              {c.failed} failed
            </button>
          )}
        </div>
      </div>
      <div className="fact cost" title={COST_HINT_SESSION}>
        <div className="k">Est. cost</div>
        <div className="v mono"><Cost usd={s.costUsd} family={s.modelFamily} /></div>
      </div>
      <div className="fact">
        <div className="k" title={TOKENS_HINT}>Tokens</div>
        <div className="v mono" title={TOKENS_HINT}>{fmtTok(sessionTokens(s))}</div>
      </div>
      <div className="fact">
        <div className="k">Running for</div>
        <div className="v mono">{fmtDur(sessionElapsedSec(s, now))}</div>
      </div>
      <div className="fact" title={AGENT_TIME_HINT}>
        <div className="k">Agent time</div>
        <div className="v mono">{fmtDur(sessionAgentSec(s, now))}</div>
      </div>
      <BlowoutsFact s={s} blow={blow} />
      <MachineFact s={s} />
      <ReporterFact s={s} />
      <SessionCell id={s.id} />
      <CopyCell label="Resume" name="Copy resume command" text={s.resumeCommand} tip={RESUME_TIP} />
      <CopyCell label="Fork" name="Copy fork command" text={s.forkCommand} tip={FORK_TIP} />
      <RecordingFact s={s} now={now} />
    </div>
  );
}
