import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { RespondError } from "../respondApi";
import { fmtAt, fmtWhen, joinWords, loopNames, mayRecord, openReplay, sizeWords, stoppedWords } from "../recording";
import type { SessionView } from "../types";
import { useRespond } from "../useRespond";

/**
 * The Respond modal's confirmation box (`.confirm`): a bold question, Cancel and the critical-colored action. Escape cancels it, and
 * the action takes focus when it opens, as the clear confirmation in the message box does.
 */
export function ConfirmBox(props: { title: string; children: ReactNode; doLabel: string; busy?: boolean; onDo: () => void; onCancel: () => void }) {
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => ok.current?.focus(), []);
  const keys = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    props.onCancel();
  };
  return (
    <div className="confirm" role="alertdialog" aria-label={props.title} onKeyDown={keys}>
      <span>
        <b>{props.title}</b> {props.children}
      </span>
      <span className="acts">
        <button className="btn" type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="btn bad" type="button" ref={ok} disabled={props.busy} onClick={props.onDo}>
          {props.doLabel}
        </button>
      </span>
    </div>
  );
}

/** What went wrong with a change, in words that say what to try. */
export function recordingFail(e: unknown, what: string): string {
  if (e instanceof RespondError) {
    if (e.status === 401) return `Could not ${what}: you are signed out. Sign in and try again.`;
    if (e.status === 403) return `Could not ${what}: only the session's owner or an Admin can.`;
    if (e.status === 404 && typeof e.body.error === "string") return `Could not ${what}: ${e.body.error}.`;
    return `Could not ${what}: ${e.message}. Try again.`;
  }
  return `Could not ${what}. Try again.`;
}

/**
 * The orchestrator page's recording layer (#353, mockup/podium-recording.html): above the status band, with no X and no switch,
 * because consent cannot be dismissed. While it records it names what is kept, who started it, which loops are recorded and when it
 * goes; once capture has ended (`.kept`) it keeps Open replay and Delete recording. Stop, Delete and Delete recording ask first.
 */
export function RecordingLayer({ s, now: shownAt }: { s: SessionView; now: number }) {
  // History opens an ended session at the time it ended; the times in the layer are still read against today.
  const now = s.status === "done" ? Date.now() : shownAt;
  const respond = useRespond();
  const v = s.recording;
  const [confirm, setConfirm] = useState<"stop" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setConfirm(null);
    setErr(null);
  }, [s.id]);
  if (!v || gone === s.id) return null;

  const can = !!respond && mayRecord(s, respond.me);
  const kept = v.state !== "recording";
  const names = loopNames(v.loops);
  const size = sizeWords(v.bytes);
  const ask = (kind: "stop" | "delete", from: HTMLElement) => {
    opener.current = from;
    setErr(null);
    setConfirm(kind);
  };
  const cancel = () => {
    setConfirm(null);
    opener.current?.focus();
  };
  const run = async (what: string, call: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setErr(null);
    try {
      await call();
      setConfirm(null);
      after?.();
    } catch (e) {
      setErr(recordingFail(e, what));
    } finally {
      setBusy(false);
    }
  };
  const stop = () => void run("stop the recording", () => respond!.api.recordingStop!(s.id));
  const remove = () => void run("delete the recording", () => respond!.api.recordingDelete!(s.id), () => setGone(s.id));

  const until = v.keptUntil !== null ? fmtWhen(v.keptUntil, now) : null;
  let text: ReactNode;
  if (kept) {
    text = (
      <>
        <b>This session was recorded. </b>
        {stoppedWords(v, s.status === "done")} What was recorded, {size}, is kept for troubleshooting{until ? ` until ${until}` : ""}, then deleted. Only the owner and an Admin can open it.
      </>
    );
  } else if (!v.ownerAllows) {
    text = (
      <>
        <b>Recording is chosen, but nothing is captured. </b>
        {s.owner ?? "The owner"} has not turned on the sessionRecording option in podium-reporter, so nothing leaves the machine. {v.startedBy ?? "Someone"} chose it{v.startedAt !== null ? ` at ${fmtAt(v.startedAt)}` : ""}.
      </>
    );
  } else {
    text = (
      <>
        <b>This session is being recorded. </b>
        Everything the recorded loops do is kept for troubleshooting: prompts, file contents, command output and results. Recording: {joinWords(names.recorded)}.
        {names.not.length > 0 ? ` Not recorded: ${joinWords(names.not)}.` : ""} {v.startedBy ?? "Someone"} started it{v.startedAt !== null ? ` at ${fmtAt(v.startedAt)}` : ""}.
        {until ? ` The oldest part is deleted at ${until}.` : ""}
      </>
    );
  }
  return (
    <div className={`rec-bar${kept ? " kept" : ""}`} role="status">
      <span className="dot" aria-hidden="true" />
      <div className="tx">
        {text}
        {err && (
          <p className="signerr" role="alert">
            {err}
          </p>
        )}
      </div>
      {can && (
        <div className="acts">
          {!kept && (
            <button type="button" className="btn sm" onClick={(e) => ask("stop", e.currentTarget)}>
              Stop recording
            </button>
          )}
          <button type="button" className="btn sm" onClick={() => openReplay(s.id)}>
            Open replay
          </button>
          <button type="button" className="btn sm bad" onClick={(e) => ask("delete", e.currentTarget)}>
            Delete recording
          </button>
        </div>
      )}
      {can && confirm === "stop" && (
        <ConfirmBox title="Stop recording this session?" doLabel="Stop recording" busy={busy} onDo={stop} onCancel={cancel}>
          Capture ends now for the orchestrator and every agent and fork. What was recorded until now is kept{until ? ` until ${until}` : ""}, and can be replayed or deleted.
        </ConfirmBox>
      )}
      {can && confirm === "delete" && (
        <ConfirmBox title="Delete this recording?" doLabel="Delete recording" busy={busy} onDo={remove} onCancel={cancel}>
          The whole recording, {size}, is removed for good.{kept ? "" : " Capture stops if it is still running."} The session, History and the live feed are not touched. This is written to the Admin log.
        </ConfirmBox>
      )}
    </div>
  );
}
