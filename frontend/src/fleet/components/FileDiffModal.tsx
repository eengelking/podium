import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { DiffPreloader } from "../diffPreload";
import { parseDiff, sideBySide, splitRedacted, type SideCell } from "../diffRows";
import { RespondError } from "../respondApi";
import type { ChangedFile, FileDiffReply, FilesReport } from "../types";
import { readJson, writeJson } from "../storage";
import { useHeartbeat } from "../useHeartbeat";
import { useRespond } from "../useRespond";
import { Modal } from "./Modal";

// One file's diff in the shared modal (#319, SPEC 6.4 and 8.1, mockup/podium-file-diff.html). The text comes from the
// session's machine on request, already redacted, and is drawn as text nodes only. Side by side where the modal is wide,
// one column where it is narrower than 720px (a container query in fleet.css picks which). Nothing is kept: closing
// the modal drops it, and opening it again asks again. Long lines wrap by default (#623, mockup/podium-file-diff-wrap.html):
// each line sits on the side-by-side grid by its pair number (--r), so the two halves of a row stay level, and the choice
// is kept in the browser. Previous and Next step through the report's files in the Files tab's order without closing the modal
// (#630, mockup/podium-file-diff-step.html): the Files tab's footer, with the file it opens named on each button. Only the file
// in view is asked for, and a reply for a file the person has left is dropped.

export const WRAP_KEY = "podium.diffWrap";
/** How long a step waits before it asks for the file, so holding a key down asks for the one it stops on and not for each file it passes (the server holds four a session). */
export const STEP_DELAY_MS = 120;

const LETTER: Record<ChangedFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };
const MINUS = "−";
const BASE_WORDS: Record<FilesReport["since"], string> = { start: "against the starting commit", upstream: "against the branch's upstream", worktree: "against the working tree" };

type Load = { state: "loading" } | { state: "done"; reply: FileDiffReply } | { state: "failed"; why: string };
/** A reply belongs to the file it was asked for, so a modal that has stepped on never draws the last file's diff. */
type Held = { path: string; load: Load };

/** What a refusal or a failure to ask says, in words with what to try (voice.html). */
function failure(err: unknown): string {
  if (err instanceof RespondError) {
    if (err.status === 504) return "The diff is not available. The session's machine did not answer in 15 seconds, or the file no longer differs. Close this and open the file again.";
    if (err.status === 429) return "Too many diffs are waiting for this session. Close this and open the file again in a moment.";
    if (err.status === 401) return "You are signed out. Sign in again, then open the file.";
    if (err.status === 403 && typeof err.body.owner === "string") return `Only ${err.body.owner} can open this diff.`;
    if (err.status === 403) return "The file diff is turned off for this session. Check the Admin's File diff switch and the fileDiff option of podium-reporter on the machine.";
    if (err.status === 404) return "This session has ended, so its files can't be read.";
  }
  return "The diff could not be loaded. Check that the server is reachable, then open the file again.";
}

function Line({ text }: { text: string }) {
  return (
    <>
      {splitRedacted(text).map((p, i) =>
        p.redacted ? (
          <span key={i} className="rd">
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

const MARK: Partial<Record<SideCell["kind"], string>> = { add: "+", del: MINUS };

/** The line's pair number, which places it on the shared grid while lines wrap. */
const at = (r: number) => ({ "--r": r }) as CSSProperties;

function Cell({ c, r }: { c: SideCell; r: number }) {
  if (c.kind === "hunk") return <span className="l h" style={at(r)}><span>{c.text}</span></span>;
  if (c.kind === "hunk-fill") return <span className="l h" style={at(r)}><span> </span></span>;
  if (c.kind === "note") return <span className="l nt" style={at(r)}><span>{c.text}</span></span>;
  return (
    <span className={`l${c.kind === "add" ? " a" : c.kind === "del" ? " r" : c.kind === "fill" ? " f" : ""}`} style={at(r)}>
      <span className="n">{c.no ?? ""}</span>
      <span className="m">{MARK[c.kind] ?? " "}</span>
      <span>
        <Line text={c.text} />
        {c.kind === "fill" ? " " : null}
      </span>
    </span>
  );
}

/** The diff, drawn twice: two panes for a wide modal and one column for a narrow one. CSS shows one of them. */
function DiffView({ text }: { text: string }) {
  const rows = parseDiff(text);
  const { left, right } = sideBySide(rows);
  const panes = useRef<(HTMLDivElement | null)[]>([]);
  // Each side scrolls sideways on its own and the other follows.
  const follow = (from: number) => () => {
    const a = panes.current[from];
    const b = panes.current[1 - from];
    if (a && b && b.scrollLeft !== a.scrollLeft) b.scrollLeft = a.scrollLeft;
  };
  return (
    <div className="mb diffmb">
      <div className="sbs" role="group" aria-label="Diff, old on the left and new on the right">
        {[left, right].map((cells, side) => (
          <div key={side} className="pane" ref={(el) => (panes.current[side] = el)} onScroll={follow(side)}>
            <div className="pane-h">{side === 0 ? "Before" : "After"}</div>
            <pre aria-label={side === 0 ? "Before" : "After"}>
              {cells.map((c, i) => (
                <Cell key={i} c={c} r={i + 1} />
              ))}
            </pre>
          </div>
        ))}
      </div>
      <pre className="uni" aria-label="Diff">
        {rows.map((r, i) => {
          if (r.kind === "hunk") return <span key={i} className="l h"><span>{r.text}</span></span>;
          if (r.kind === "note") return <span key={i} className="l nt"><span>{r.text}</span></span>;
          const k = r.kind;
          return (
            <span key={i} className={`l${k === "add" ? " a" : k === "del" ? " r" : ""}`}>
              <span className="n">{k === "ctx" || k === "del" ? r.old : ""}</span>
              <span className="n">{k === "ctx" || k === "add" ? r.now : ""}</span>
              <span className="m">{MARK[k] ?? " "}</span>
              <span>
                <Line text={r.text} />
              </span>
            </span>
          );
        })}
      </pre>
    </div>
  );
}

function Message({ children, tone }: { children: React.ReactNode; tone?: "quiet" | "err" }) {
  return (
    <div className="mb">
      <div className={`diffmsg${tone ? ` ${tone}` : ""}`} role={tone === "err" ? "alert" : undefined}>
        {children}
      </div>
    </div>
  );
}

/** "Loading" with three dots that fill in on the console's shared beat (no CSS animation of their own). Still under reduced motion. */
function Loading() {
  const ref = useRef<HTMLSpanElement>(null);
  useHeartbeat(ref, true);
  return (
    <span role="status" className="loading" ref={ref}>
      Loading
      <span className="dots" aria-hidden="true">
        <i>.</i>
        <i>.</i>
        <i>.</i>
      </span>
    </span>
  );
}

function Body({ path, load }: { path: string; load: Load }) {
  if (load.state === "loading")
    return (
      <Message tone="quiet">
        <p>
          <Loading />
        </p>
        <p>The diff is read from the session's machine now and is not kept. This gives up after 15 seconds.</p>
      </Message>
    );
  if (load.state === "failed") return <Message tone="err"><p>{load.why}</p></Message>;
  const r = load.reply;
  if (r.status === "binary")
    return (
      <Message>
        <p>No text diff for a binary file.</p>
        <p>Git shows no lines for it, so there is nothing to draw.</p>
      </Message>
    );
  if (r.status === "too-large")
    return (
      <Message>
        <p>This diff is over 5 MB, so it is not shown.</p>
        <p>
          Run <code>git diff -- {path}</code> in the terminal to read it.
        </p>
      </Message>
    );
  if (r.status === "withheld")
    return (
      <Message>
        <p>Not shown. Podium never reads the diff of files that usually hold secrets, such as <code>.env</code> files and keys.</p>
      </Message>
    );
  if (r.status === "unavailable")
    return (
      <Message tone="err">
        <p>The diff is not available. The session's machine did not answer, or the file no longer differs.</p>
        <p>Close this and open the file again.</p>
      </Message>
    );
  if (!r.text)
    return (
      <Message>
        <p>No line changes to show.</p>
        <p>The file's mode changed, or it was renamed without edits.</p>
      </Message>
    );
  return <DiffView text={r.text} />;
}

function footNote(reply: FileDiffReply): string {
  const bits: string[] = [];
  if (reply.truncated) bits.push(`Showing the first ${reply.shownLines.toLocaleString("en-US")} lines of ${reply.totalLines.toLocaleString("en-US")}.`);
  if (reply.redactions > 0) bits.push(`${reply.redactions} ${reply.redactions === 1 ? "value" : "values"} hidden as possible secrets. Hiding is best effort, so check the diff before you share it.`);
  return bits.join(" ");
}

type Step = { files: ChangedFile[]; index: number; onStep: (index: number) => void };

/** The Files tab's footer in the modal's bottom row: where this file sits, and Previous and Next, disabled at the ends. */
function Stepper({ files, index, onStep }: Step) {
  const prev = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const went = useRef<1 | -1 | null>(null);
  const before = files[index - 1];
  const after = files[index + 1];
  // A button that has just become disabled cannot keep focus, so the person lands on the other one and the modal never loses it.
  useEffect(() => {
    const used = went.current === 1 ? next.current : went.current === -1 ? prev.current : null;
    went.current = null;
    if (used?.disabled) (used === next.current ? prev.current : next.current)?.focus();
  }, [index]);
  const go = (by: 1 | -1) => () => {
    went.current = by;
    onStep(index + by);
  };
  return (
    <div className="pager">
      <span aria-live="polite">
        Showing file {index + 1} of {files.length}
      </span>
      <nav className="pg" aria-label="Files in this diff">
        <button type="button" ref={prev} aria-label={`Previous file${before ? `: ${before.path}` : ""}`} title={`Previous file${before ? `: ${before.path}` : ""}`} disabled={!before} onClick={go(-1)}>
          {"‹"}
        </button>
        <button type="button" ref={next} aria-label={`Next file${after ? `: ${after.path}` : ""}`} title={`Next file${after ? `: ${after.path}` : ""}`} disabled={!after} onClick={go(1)}>
          {"›"}
        </button>
      </nav>
    </div>
  );
}

/** The modal's bottom row: where the file sits in the list at the left, then the note, when there is one, and the Wrap lines switch at the right (the Admin's .sw). */
function Foot({ load, step, wrap, onWrap }: { load: Load; step: Step; wrap: boolean; onWrap: () => void }) {
  const id = useId();
  const reply = load.state === "done" ? load.reply : null;
  const note = reply ? footNote(reply) : "";
  // Kept while a diff loads, so the switch does not drop out and come back at each step.
  const drawn = load.state === "loading" || (reply?.status === "ok" && !!reply.text);
  return (
    <div className="mf">
      <Stepper {...step} />
      {note ? <div className="foot-note">{note}</div> : null}
      {drawn ? (
        <div className="sw">
          <button type="button" role="switch" aria-checked={wrap} aria-labelledby={`${id}-n ${id}-s`} onClick={onWrap} />
          <b id={`${id}-n`}>Wrap lines</b>
          <span id={`${id}-s`}>{wrap ? "On" : "Off"}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The slot the loader holds for a file, as the modal draws it (#631). While a reload is under way the old text stays; a file
 * the loader has not reached is loading, the same state the modal showed before diffs were loaded ahead.
 */
function loadFrom(preload: DiffPreloader | undefined, path: string): Load | null {
  const slot = preload?.get(path);
  if (!slot) return null;
  if (slot.state === "failed") return { state: "failed", why: failure(slot.error) };
  return slot.reply ? { state: "done", reply: slot.reply } : { state: "loading" };
}

export function FileDiffModal(props: { sessionId: string; files: ChangedFile[]; index: number; since: FilesReport["since"]; preload?: DiffPreloader; onStep: (index: number) => void; onClose: () => void }) {
  const ctx = useRespond();
  const [held, setHeld] = useState<Held | null>(null);
  const asked = useRef(false);
  const titleId = useId();
  // Wrapped unless the saved choice is exactly false, so a failed or odd read falls back to wrapped.
  const [wrap, setWrap] = useState(() => readJson<unknown>(WRAP_KEY, true) !== false);
  const flipWrap = () => {
    writeJson(WRAP_KEY, !wrap);
    setWrap(!wrap);
  };
  const { files, index, sessionId, preload } = props;
  const file = files[index]!;
  const api = ctx?.api;
  // Re-drawn whenever the loader changes a slot.
  useSyncExternalStore(
    (cb) => preload?.subscribe(cb) ?? (() => {}),
    () => preload?.snapshot() ?? 0,
  );
  const loaded = loadFrom(preload, file.path);
  const load: Load = loaded ?? (held?.path === file.path ? held.load : { state: "loading" });
  const slot = preload?.get(file.path);
  const openedAhead = slot?.state === "done" && slot.ahead;

  // The loader moves the open file to the front of its queue, and lets it go when the person steps on or closes.
  useEffect(() => {
    if (!preload) return;
    preload.want(file.path);
    return () => preload.release(file.path);
  }, [preload, file.path]);

  // A diff that arrived before anyone asked for it was not an open to the server; say so once the person is looking at it.
  // Once per file shown: a reload of the same file passes through loading and back, and is not another open.
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (!openedAhead || told.current === file.path) return;
    told.current = file.path;
    void api?.fileDiffOpened?.(sessionId, file.path).catch(() => {});
  }, [openedAhead, api, sessionId, file.path]);

  useEffect(() => {
    if (preload) return;
    let live = true;
    const path = file.path;
    const fileDiff = api?.fileDiff;
    if (!fileDiff) {
      setHeld({ path, load: { state: "failed", why: failure(null) } });
      return;
    }
    // The first file is asked for at once; a later one after a pause, which a further step cancels.
    const ask = () =>
      fileDiff(sessionId, path)
        .then((reply) => live && setHeld({ path, load: { state: "done", reply } }))
        .catch((err: unknown) => live && setHeld({ path, load: { state: "failed", why: failure(err) } }));
    const wait = asked.current ? setTimeout(() => void ask(), STEP_DELAY_MS) : null;
    if (!wait) void ask();
    asked.current = true;
    return () => {
      live = false;
      if (wait) clearTimeout(wait);
    };
  }, [api, sessionId, file.path, preload]);

  const binary = file.added === null || file.removed === null;
  const base = load.state === "done" && load.reply.base ? ` ${load.reply.base}` : "";
  const sub = (
    <>
      {LETTER[file.status]}
      {file.status === "renamed" && file.from ? ` · from ${file.from}` : ""}
      {" · "}
      {binary ? (
        "binary"
      ) : (
        <span className="cnt">
          <span className="add">+{file.added}</span>
          <span className="del">
            {MINUS}
            {file.removed}
          </span>
        </span>
      )}
      {load.state === "done" && load.reply.status === "ok" ? ` · ${BASE_WORDS[props.since]}${props.since === "worktree" ? "" : base}` : ""}
    </>
  );
  return (
    <Modal titleId={titleId} title={<bdi>{file.path}</bdi>} sub={sub} onClose={props.onClose} className={wrap ? "modal-diff wrapped" : "modal-diff"}>
      <Body key={file.path} path={file.path} load={load} />
      <Foot load={load} step={{ files, index, onStep: props.onStep }} wrap={wrap} onWrap={flipWrap} />
    </Modal>
  );
}
