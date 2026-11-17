import { createContext, useContext, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { BackgroundItem, SessionView } from "../types";
import { DESKTOP_OPTIONS, OPENCODE_RESTART, OPENCODE_SETTINGS_FILE, OPTION_CMD, optionVariable } from "../pluginOptions";
import { BAD, CHEV, CopyButton, Marked, OK, Redacted, useRowAnchor } from "./BashRow";

// The Background tab of the Activity modal (#897, mockup/podium-background-items.html): the shells and monitors one loop started, in the
// feed's own rows. Everything from a session is drawn as a text node, never HTML. A command and its output are the person's own content: they
// reach this page only through the activity route, which an Admin's read of is recorded and told to the person (#1082).

/** The Admin's `background-output` flag as the console's state last said; null where the page does not have the state. */
export const BackgroundOutputFlag = createContext<boolean | null>(null);

/** No output for this long reads as quiet: the sign of a shell that is stuck. The footer says so. */
export const QUIET_MS = 5 * 60_000;

/** The reporter that sends background items: 1.7.0 and later. Older ones leave `backgroundOutput` out of every report. */
const UPDATE = "Run claude plugin update podium-reporter@eengelking-marketplace, then /reload-plugins in that session.";

const RUN = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 4.5V8l2.2 1.4" />
  </svg>
);
const END = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" />
    <path d="M5.5 8h5" />
  </svg>
);
const WARN = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 2l6.5 11.5h-13zM8 6.5v3M8 11.6v.1" />
  </svg>
);

type Phase = "run" | "ok" | "bad" | "end";

/** What an item is doing, as a shape, a word and a color. "Ended without an exit code" is never "killed": no harness says so. */
export function phaseOf(i: BackgroundItem): Phase {
  if (i.state === "running") return "run";
  if (i.exitCode === undefined) return "end";
  return i.exitCode === 0 ? "ok" : "bad";
}

export function wordOf(i: BackgroundItem): string {
  const p = phaseOf(i);
  if (p === "run") return "Running";
  if (p === "ok") return "Finished, exit 0";
  if (p === "bad") return `Failed, exit ${i.exitCode}`;
  return "Ended without an exit code";
}

const ICON: Record<Phase, ReactNode> = { run: RUN, ok: OK, bad: BAD, end: END };

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (at: number) => {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const clockFull = (at: number) => `${clock(at)}:${pad(new Date(at).getSeconds())}`;

/** A length of time as m:ss, or h:mm:ss from an hour. */
export function lengthOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** How long ago, in the unit that reads shortest: "4 s ago", "6 min ago", "2 h ago". */
export function agoOf(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** The time a running item has run, or a finished one ran (when its end is known); null when it is not known. */
export function ranOf(i: BackgroundItem, now: number): number | null {
  if (i.state === "running") return now - i.startedAt;
  return i.endedAt === undefined ? null : i.endedAt - i.startedAt;
}

/** Whether a running item has printed nothing for QUIET_MS. Needs a time of last output: a reporter that cannot read the file says none. */
export function isQuiet(i: BackgroundItem, now: number): boolean {
  return i.state === "running" && i.lastOutputAt !== undefined && now - i.lastOutputAt >= QUIET_MS;
}

/** Why an opened item has no output, and where to change it. */
function whyNoOutput(why: { flagOn: boolean | null; optionOn: boolean | null | undefined; harness: string | undefined }): { title: string; note: ReactNode } {
  if (why.flagOn === false) {
    return { title: "Output is off.", note: "An Admin has not turned on Background shell output in Admin > Settings. Until then this tab lists each item's state and times only." };
  }
  if (why.optionOn !== true) {
    return {
      title: "Output is off.",
      note: (
        <>
          Turn on the <code>backgroundOutput</code> option (Send a background shell’s command and output) of podium-reporter:{" "}
          {why.harness === "opencode" ? (
            <>
              add <code>{optionVariable("backgroundOutput")}=true</code> to <code>{OPENCODE_SETTINGS_FILE}</code>, then run <code>{OPENCODE_RESTART}</code>.
            </>
          ) : (
            <>
              in Claude Code, run <code>{OPTION_CMD}</code>, or in the Claude desktop app, open {DESKTOP_OPTIONS}.
            </>
          )}
        </>
      ),
    };
  }
  return { title: "Output was not collected.", note: "It is read only while this tab is open, from the file the harness writes it to. It may not be readable, or it may not have printed yet." };
}

function Row(props: {
  item: BackgroundItem;
  now: number;
  open: boolean;
  onFlip: (open: boolean, li: HTMLElement | null) => void;
  why: { flagOn: boolean | null; optionOn: boolean | null | undefined; harness: string | undefined };
}) {
  const { item: i, now, open } = props;
  const li = useRef<HTMLLIElement>(null);
  const tgl = useRef<HTMLButtonElement>(null);
  const xp = useRef<HTMLDivElement>(null);
  const phase = phaseOf(i);
  const ran = ranOf(i, now);
  const quiet = isQuiet(i, now);
  const hasCommand = i.command !== undefined;
  const shown = hasCommand ? i.command! : `${i.label} …`;
  const seenNote = i.startedKnown ? "" : `, first seen ${clockFull(i.startedAt)} (the harness does not report a start time)`;

  const onRow = (ev: MouseEvent) => {
    if (xp.current?.contains(ev.target as Node)) return;
    // A selection made in this row is not a click to open it; a key press (detail 0) always counts.
    const sel = window.getSelection?.();
    if (ev.detail > 0 && sel && !sel.isCollapsed && li.current?.contains(sel.anchorNode)) return;
    props.onFlip(!open, li.current);
  };

  let outBox: ReactNode;
  if (i.output === undefined) {
    const w = whyNoOutput(props.why);
    outBox = (
      <div className="feedoff">
        <b>{w.title}</b>
        <div className="ghost">{w.note}</div>
      </div>
    );
  } else if (i.output === "") {
    outBox = (
      <div className="feedoff">
        <b>{i.state === "running" ? "Nothing printed yet." : "The command printed nothing."}</b>
      </div>
    );
  } else {
    outBox = (
      <pre className="code xout" aria-label="Output">
        <Marked text={i.output} />
      </pre>
    );
  }

  return (
    // The row is a click target for the pointer only; the button inside is the control for the keyboard and screen readers.
    <li ref={li} className={`tool can${open ? " open" : ""}`} data-testid="bg-row" onClick={onRow} /* NOSONAR S6848 */>
      <span className="at" title={i.startedKnown ? `Started ${clockFull(i.startedAt)}` : `First seen ${clockFull(i.startedAt)}: the harness does not report a start time`}>
        {clock(i.startedAt)}
      </span>
      <span className={`k ${phase}`} role="img" aria-label={wordOf(i)} title={wordOf(i)}>
        {ICON[phase]}
      </span>
      <span className="body">
        <button
          type="button"
          className="tgl"
          ref={tgl}
          aria-expanded={open}
          onClick={(e) => {
            // The row's own handler flips it; a keyboard click arrives here with detail 0 and is handled there too.
            e.stopPropagation();
            props.onFlip(!open, li.current);
          }}
        >
          {CHEV}
          <span className="name">{i.kind === "monitor" ? "Monitor" : "Shell"}</span>{" "}
          <span className="arg">
            <Redacted text={shown} />
          </span>
          <span className="bgline">
            <span className={`bgs ${phase}`}>{wordOf(i)}</span>
            {ran !== null && (
              <>
                {" · "}
                <span className="mono">{lengthOf(ran)}</span>
              </>
            )}
          </span>
          {quiet && (
            <span className="bgq" title="No output for 5 minutes or more">
              {WARN}Quiet for {Math.floor((now - i.lastOutputAt!) / 60_000)} min
            </span>
          )}
          {!quiet && phase === "run" && i.lastOutputAt !== undefined && <span className="bgline">last output {agoOf(now - i.lastOutputAt)}</span>}
        </button>
        {open && (
          <div className="xp" ref={xp}>
            <div>
              <div className="xh">
                <span>Command{seenNote}</span>
                {hasCommand && <CopyButton label="Copy command" text={i.command!} />}
              </div>
              {hasCommand ? (
                <pre className="code xcmd" aria-label="Whole command">
                  <Marked text={i.command!} />
                </pre>
              ) : (
                <div className="feedoff">
                  <b>Only the first word is shown.</b>
                  <div className="ghost">The whole command goes with the output, under the same switches.</div>
                </div>
              )}
            </div>
            <div>
              <div className="xh">
                <span>Output</span>
                {phase === "ok" && (
                  <span className="exit ok" title="Succeeded">
                    {OK}
                    <span className="sr-only">Succeeded, exit 0</span>
                  </span>
                )}
                {phase === "bad" && (
                  <span className="exit bad">
                    {BAD}Exit {i.exitCode}, failed
                  </span>
                )}
                {i.output ? <CopyButton label="Copy output" text={i.output} /> : null}
              </div>
              {outBox}
            </div>
            <div className="foot">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  props.onFlip(false, li.current);
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

/** The items of a loop, as the feed's own rows (#897). Oldest first, newest last; it follows the newest item and offers "Jump to latest" when scrolled up. */
export function BackgroundList(props: {
  items: BackgroundItem[];
  now: number;
  harness: string | undefined;
  /** The Admin's `background-output` flag as the console's state last said; null where the page does not have it. */
  flagOn: boolean | null;
  /** The reporter's `backgroundOutput` option, as the session says. */
  optionOn: boolean | null | undefined;
}) {
  const list = useRef<HTMLOListElement>(null);
  const [following, setFollowing] = useState(true);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRowAnchor(list, following);
  const last = props.items.length ? props.items[props.items.length - 1]!.id : "";

  // A new newest item, or one that grew, keeps a list that follows at its end.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [last, props.items.length, following, openIds]);

  const onScroll = () => {
    const el = list.current;
    if (el) setFollowing(el.scrollTop + el.clientHeight >= el.scrollHeight - 6);
  };
  const why = { flagOn: props.flagOn, optionOn: props.optionOn, harness: props.harness };

  return (
    <div className="feedwrap">
      <ol className="feed" ref={list} aria-label="Background items, newest last" tabIndex={0} onScroll={onScroll} /* NOSONAR S6845: a focusable scroll region, by design */>
        {props.items.map((i) => (
          <Row
            key={i.id}
            item={i}
            now={props.now}
            open={openIds.has(i.id)}
            why={why}
            onFlip={(next, li) => {
              if (li) anchor.before(li);
              setOpenIds((cur) => {
                const n = new Set(cur);
                if (next) n.add(i.id);
                else n.delete(i.id);
                return n;
              });
            }}
          />
        ))}
      </ol>
      {!following && (
        <button
          type="button"
          className="jump"
          onClick={() => {
            setFollowing(true);
            list.current?.focus();
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

/**
 * The whole Background tab: the list, or the sentence that says why there is none (an older reporter, the feed off, nothing running), and under it the
 * feed's own footer lines. `when` is the feed's "Updated Ns ago".
 */
export function BackgroundPane(props: { s: SessionView; items: BackgroundItem[]; now: number; when: string; adminOff: boolean; refused: string | null }) {
  const { s } = props;
  const flagOn = useContext(BackgroundOutputFlag);
  const note = "Kept only while someone is watching. Closing this clears it. Secrets are removed before they leave the session.";
  if (props.adminOff || props.refused) {
    return <div className="feedoff"><b>{props.refused ?? "The activity feed is off."}</b></div>;
  }
  if (s.backgroundOutput === null || s.backgroundOutput === undefined) {
    return (
      <div className="feedoff">
        <b>This reporter does not send background items.</b>
        <div className="ghost">Update podium-reporter to 1.7.0 or later to see shells and monitors here. The Output tab works as before. {UPDATE}</div>
      </div>
    );
  }
  const n = props.items.length;
  return (
    <>
      {s.harness === "opencode" && <p className="bgnote">OpenCode has no monitors, so none are listed.</p>}
      {n === 0 ? (
        <div className="feedoff">
          <b>No background shells or monitors</b>
          <div className="ghost">When {s.name} or one of its agents starts a shell in the background{s.harness === "opencode" ? "" : ", or a monitor,"} it is listed here with its output.</div>
        </div>
      ) : (
        <BackgroundList items={props.items} now={props.now} harness={s.harness} flagOn={flagOn} optionOn={s.backgroundOutput} />
      )}
      {n > 0 && (
        <div className="feedfoot stat">
          <span className="count">{`Showing the newest ${n} of ${n}`}</span>
          <span className="when">{props.when}</span>
        </div>
      )}
      <div className="feedfoot">
        <span>{note}</span>
      </div>
      {n > 0 && (
        <div className="feedfoot">
          <span>Only the running items and the 20 latest finished ones are kept. Quiet means no output for 5 minutes.</span>
        </div>
      )}
    </>
  );
}
