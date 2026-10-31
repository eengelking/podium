import { createContext, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { useCopy } from "./SessionId";

// A Bash row of the Activity feed, and of the replay, that opens to the whole command and its output (#431,
// mockup/podium-feed-expand.html). Everything from a session is drawn as a text node, never HTML.

/** The characters a row's summary is cut at (the mod's `LIMITS.activity`), the tool's name and a space included. */
export const LINE_CUT = 300;
/** What is left of it for the command once "Bash " is taken off. */
export const ARG_CUT = LINE_CUT - "Bash ".length;

/** The Admin's `activity-output` flag as the console's state last said; null where the page does not have the state. */
export const ActivityOutputFlag = createContext<boolean | null>(null);

const CHEV = (
  <svg className="chev" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 1.5 6.5 5 3 8.5" />
  </svg>
);
const OK = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m3 8.5 3.2 3.2L13 5" />
  </svg>
);
const BAD = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);

/** The text with each `[redacted]` the mod put in marked, as text nodes. */
export function Redacted(props: { text: string }) {
  const parts = props.text.split("[redacted]");
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && <span className="rd">[redacted]</span>}
        </span>
      ))}
    </>
  );
}

/** A command or output as pre-formatted text: `[redacted]` marked, and the line that says it was cut left plain and muted. */
function Marked(props: { text: string }) {
  const lines = props.text.split("\n");
  return (
    <>
      {lines.map((l, i) => (
        <span key={i}>
          {l.startsWith("[cut off") ? <span className="mark">{l}</span> : <Redacted text={l} />}
          {i < lines.length - 1 && "\n"}
        </span>
      ))}
    </>
  );
}

/** Why a row has no output to show: a bold line and the words under it. */
export interface Missing {
  title: string;
  note: ReactNode;
}

/**
 * The words for a call with no output, in the order the mockups give: a stored-history row, the Admin's flag off, the machine's
 * option off, then the rest, which says the output was not collected. A call that is running (#598) says so after those three,
 * since a flag or option that is off means its output will never come; a finished call's status mark shows whatever the reason.
 */
export function missingOutput(why: { stored: boolean; adminOn: boolean | null; machineOn: boolean | null | undefined; running?: boolean }): Missing {
  if (why.stored) return { title: "Output is not kept in history.", note: "Only the command is stored. Output is shown while someone is watching the session and is gone after." };
  if (why.adminOn === false) return { title: "Output is turned off by the Admin.", note: "Someone with Admin access can turn it on in Admin > Settings > Feature flags." };
  if (why.machineOn !== true)
    return {
      title: "Output is turned off for this machine.",
      note: (
        <>
          Turn on the <code>activityOutput</code> option (Send a Bash command’s output) of podium-reporter, then run /reload-plugins in that session.
        </>
      ),
    };
  if (why.running) return { title: "Running.", note: "The output appears here when the command finishes." };
  return { title: "Output was not collected.", note: "Output is only collected while this panel is open." };
}

export interface BashData {
  /** The whole command, as the mod sent or the history stored it; absent from an older reporter. */
  command?: string;
  output?: string;
  /** The call returned and the mod read its result. */
  done?: boolean;
  failed?: boolean;
  exitCode?: number;
  /** No output yet because the call is still running (#598): the line says running and the output box says so. */
  running?: boolean;
  missing: Missing;
}

/** Whether the call failed: its own flag, or a code that is not 0. */
const failedOf = (d: BashData) => d.failed === true || (d.exitCode !== undefined && d.exitCode !== 0);

/** The exit status as a shape, a word and a color. A success is a bare check, named for a screen reader and by a tooltip. */
export function ExitStatus(props: { d: BashData }) {
  const { d } = props;
  if (!failedOf(d)) {
    return (
      <span className="exit ok" title="Succeeded">
        {OK}
        <span className="sr-only">Succeeded, exit 0</span>
      </span>
    );
  }
  return (
    <span className="exit bad">
      {BAD}
      {d.exitCode === undefined ? "Failed" : `Exit ${d.exitCode}, failed`}
    </span>
  );
}

/** A small Copy button. It reads Copied with a check for 1.6 s, and shows nothing at all when the clipboard refuses. */
function CopyButton(props: { label: string; text: string }) {
  const { state, copy } = useCopy(props.text);
  return (
    <button type="button" className="btn" onClick={copy}>
      {state === "copied" ? (
        <>
          {OK}
          <span aria-live="polite">Copied</span>
        </>
      ) : (
        props.label
      )}
    </button>
  );
}

const chars = (n: number) => n.toLocaleString("en-US");

/** What the page does about the list's scroll around a row opening or closing. */
export interface RowAnchor {
  before: (li: HTMLElement) => void;
  after: () => void;
}

/**
 * Opening or closing a row must not move the reader away from where they are reading (the feed has `overflow-anchor: none`, so the
 * browser does not do it). The row keeps the place it had in the list, and one whose top was above the list comes back to the top.
 * A list that follows its newest row stays at its end instead.
 */
export function useRowAnchor(list: RefObject<HTMLElement | null>, following: boolean): RowAnchor {
  const pending = useRef<{ li: HTMLElement; top: number } | null>(null);
  const follow = useRef(following);
  follow.current = following;
  return useMemo<RowAnchor>(
    () => ({
      before: (li) => {
        const el = list.current;
        if (el) pending.current = { li, top: li.getBoundingClientRect().top - el.getBoundingClientRect().top };
      },
      after: () => {
        const el = list.current;
        const p = pending.current;
        pending.current = null;
        if (!el || !p) return;
        if (follow.current) {
          el.scrollTop = el.scrollHeight;
          return;
        }
        el.scrollTop += p.li.getBoundingClientRect().top - el.getBoundingClientRect().top - Math.max(0, p.top);
      },
    }),
    [list],
  );
}

export interface BashRowProps {
  /** The row's classes: `tool`, and whatever the page adds (a new row, the replay's current row). */
  className: string;
  liProps?: { "data-i"?: number; "aria-current"?: "true" };
  time: string;
  timeTitle: string;
  kindLabel: string;
  icon: ReactNode;
  /** Before the line: the replay's loop name. */
  who?: ReactNode;
  /** The row's summary: the call as the line shows it, cut at 300 characters. */
  line: string;
  /** The summary was cut: the call had more than the line holds. */
  cut: boolean;
  d: BashData;
  anchor?: RowAnchor;
}

/**
 * One Bash row. It opens when the mod sent the whole command. The whole row is the click target, except the opened part and a click
 * that ends a text selection; the line stays a real button for the keyboard and for screen readers.
 */
export function BashRow(props: BashRowProps) {
  const { d } = props;
  const [open, setOpen] = useState(false);
  const id = useId();
  const li = useRef<HTMLLIElement>(null);
  const xp = useRef<HTMLDivElement>(null);
  const tgl = useRef<HTMLButtonElement>(null);
  const cut = props.cut;
  const can = d.command !== undefined;
  const anchor = props.anchor;

  const flip = (next: boolean) => {
    if (li.current) anchor?.before(li.current);
    setOpen(next);
  };
  // After the new height is in the DOM, not on the first render.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    anchor?.after();
  }, [open]);

  const onRow = (ev: MouseEvent) => {
    if (!can || xp.current?.contains(ev.target as Node)) return;
    // A selection made in this row is not a click to open it. A key press (detail 0) always counts.
    const sel = window.getSelection?.();
    if (ev.detail > 0 && sel && !sel.isCollapsed && li.current?.contains(sel.anchorNode)) return;
    flip(!open);
  };

  const line = (
    <>
      <span className="name">Bash</span>{" "}
      <span className="arg">
        <Redacted text={props.line} />
      </span>
      {cut && <span className="cut">…</span>}
    </>
  );
  let head: ReactNode;
  if (can) {
    const label = cut ? `Show whole command, ${chars(d.command!.length)} characters` : d.output === undefined ? "Show command" : "Show output";
    head = (
      <button type="button" className="tgl" ref={tgl} aria-expanded={open} aria-controls={open ? id : undefined}>
        {CHEV}
        {line}
        {d.done ? (
          <span className="state">
            <ExitStatus d={d} />
          </span>
        ) : (
          d.running && <span className="state">running</span>
        )}
        <span className="sr-only"> {label}</span>
      </button>
    );
  } else {
    head = (
      <span>
        {line}
        {cut && <span className="nofull">cut at 300 characters; this reporter sends no more</span>}
      </span>
    );
  }

  const status = d.done ? <ExitStatus d={d} /> : null;
  return (
    // The row is a click target for the pointer only; the button inside is the control for the keyboard and screen readers.
    <li ref={li} className={`${props.className}${can ? " can" : ""}${open ? " open" : ""}`} {...props.liProps} onClick={onRow} /* NOSONAR S6848 */>
      <span className="at" title={props.timeTitle}>
        {props.time}
      </span>
      <span className="k" role="img" aria-label={props.kindLabel} title={props.kindLabel}>
        {props.icon}
      </span>
      <span className="body">
        {props.who}
        {head}
        {can && open && (
          <div className="xp" id={id} ref={xp}>
            <div>
              <div className="xh">
                <span>Command{cut ? `, ${chars(d.command!.length)} characters` : ""}</span>
                <CopyButton label="Copy command" text={d.command!} />
              </div>
              <pre className="code xcmd" aria-label="Whole command">
                <Marked text={d.command!} />
              </pre>
            </div>
            <div>
              <div className="xh">
                <span>Output</span>
                {status}
                {d.output ? <CopyButton label="Copy output" text={d.output} /> : null}
              </div>
              {d.output === undefined ? (
                <div className="feedoff">
                  <b>{d.missing.title}</b>
                  <div className="ghost">{d.missing.note}</div>
                </div>
              ) : d.output === "" ? (
                <div className="feedoff">
                  <b>The command printed nothing.</b>
                </div>
              ) : (
                <pre className="code xout" aria-label="Output">
                  <Marked text={d.output} />
                </pre>
              )}
            </div>
            <div className="foot">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  flip(false);
                  tgl.current?.focus();
                }}
              >
                Collapse
              </button>
            </div>
          </div>
        )}
      </span>
    </li>
  );
}
