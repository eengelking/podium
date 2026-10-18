import { useEffect, useId, useRef, useState } from "react";
import { parseDiff, sideBySide, splitRedacted, type SideCell } from "../diffRows";
import { RespondError } from "../respondApi";
import type { ChangedFile, FileDiffReply, FilesReport } from "../types";
import { useHeartbeat } from "../useHeartbeat";
import { useRespond } from "../useRespond";
import { Modal } from "./Modal";

// One file's diff in the shared modal (#319, SPEC 6.4 and 8.1, mockup/podium-file-diff.html). The text comes from the
// session's machine on request, already redacted, and is drawn as text nodes only. Side by side where the modal is wide,
// one column where it is narrower than 720px (a container query in fleet.css picks which). Nothing is kept: closing
// the modal drops it, and opening it again asks again.

const LETTER: Record<ChangedFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };
const MINUS = "−";
const BASE_WORDS: Record<FilesReport["since"], string> = { start: "against the starting commit", upstream: "against the branch's upstream", worktree: "against the working tree" };

type Load = { state: "loading" } | { state: "done"; reply: FileDiffReply } | { state: "failed"; why: string };

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

function Cell({ c }: { c: SideCell }) {
  if (c.kind === "hunk") return <span className="l h"><span>{c.text}</span></span>;
  if (c.kind === "hunk-fill") return <span className="l h"><span> </span></span>;
  if (c.kind === "note") return <span className="l nt"><span>{c.text}</span></span>;
  return (
    <span className={`l${c.kind === "add" ? " a" : c.kind === "del" ? " r" : c.kind === "fill" ? " f" : ""}`}>
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
            <pre tabIndex={0} aria-label={side === 0 ? "Before" : "After"}>
              {cells.map((c, i) => (
                <Cell key={i} c={c} />
              ))}
            </pre>
          </div>
        ))}
      </div>
      <pre className="uni" tabIndex={0} aria-label="Diff">
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

function Foot({ reply }: { reply: FileDiffReply }) {
  const bits: string[] = [];
  if (reply.truncated) bits.push(`Showing the first ${reply.shownLines.toLocaleString("en-US")} lines of ${reply.totalLines.toLocaleString("en-US")}.`);
  if (reply.redactions > 0) bits.push(`${reply.redactions} ${reply.redactions === 1 ? "value" : "values"} hidden as possible secrets. Hiding is best effort, so check the diff before you share it.`);
  return bits.length ? <div className="foot-note">{bits.join(" ")}</div> : null;
}

export function FileDiffModal(props: { sessionId: string; file: ChangedFile; since: FilesReport["since"]; onClose: () => void }) {
  const ctx = useRespond();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const titleId = useId();
  const { file, sessionId } = props;
  const api = ctx?.api;

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    if (!api) {
      setLoad({ state: "failed", why: failure(null) });
      return;
    }
    api
      .fileDiff(sessionId, file.path)
      .then((reply) => live && setLoad({ state: "done", reply }))
      .catch((err: unknown) => live && setLoad({ state: "failed", why: failure(err) }));
    return () => {
      live = false;
    };
  }, [api, sessionId, file.path]);

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
    <Modal titleId={titleId} title={<bdi>{file.path}</bdi>} sub={sub} onClose={props.onClose} className="modal-diff">
      <Body path={file.path} load={load} />
      {load.state === "done" && <Foot reply={load.reply} />}
    </Modal>
  );
}
