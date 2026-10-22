import { useEffect, useId, useState, type ReactNode } from "react";
import { fmtAt, pickerState, pickRows, type PickerState } from "../recording";
import type { RecordingGrant, SessionView } from "../types";
import { useRespond } from "../useRespond";
import { recordingFail } from "./RecordingLayer";
import { Modal } from "./Modal";

const OPTION_CMD = "/plugin configure podium-reporter@eengelking-marketplace";

function Para({ lead, children }: { lead?: string; children: ReactNode }) {
  return (
    <p>
      {lead && <b>{lead} </b>}
      {children}
    </p>
  );
}

/**
 * Record this session (#353, mockup/podium-recording.html): the app's modal with the Respond modal's option rows, one for the
 * orchestrator and one for each agent and fork. Recording starts when Start is pressed and keeps nothing from before. Five states:
 * the owner allows it, after Start, the owner has not allowed it (nothing to press, and the option is named), the feature is off,
 * and a viewer who is not the owner. Two more say what is missing: signed out, and a session that has ended.
 */
export function RecordPicker({ s, onClose }: { s: SessionView; onClose: () => void }) {
  const respond = useRespond();
  const id = useId();
  const rows = pickRows(s);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(rows.map((r) => r.loop)));
  const [grant, setGrant] = useState<RecordingGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Whether the owner allows recording, asked of the server on open so the picker can say so before Start. A failed ask leaves it unknown.
  const [ownerAllows, setOwnerAllows] = useState<boolean | null>(null);
  // The Admin's keep time, from the same answer; unknown until it arrives, and the wording then states no number.
  const [keepHours, setKeepHours] = useState<number | null>(null);
  const state: PickerState = pickerState({ flagOn: respond?.recordingOn === true, me: respond?.me ?? null, s, grant, ownerAllows });
  const consentApi = state === "ok" ? respond?.api.recordingConsent : undefined;
  useEffect(() => {
    if (!consentApi) return;
    let live = true;
    consentApi(s.id).then(
      (out) => {
        if (!live) return;
        setOwnerAllows(out.grant.consent.owner);
        setKeepHours(out.keepHours ?? null);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [consentApi, s.id]);
  const toggle = (loop: string, on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(loop);
      else next.delete(loop);
      return next;
    });
  const start = async () => {
    if (!respond?.api.recordingStart || picked.size === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const out = await respond.api.recordingStart(
        s.id,
        rows.map((r) => r.loop).filter((l) => picked.has(l)),
      );
      setGrant(out.grant);
    } catch (e) {
      setErr(recordingFail(e, "start the recording"));
    } finally {
      setBusy(false);
    }
  };

  const locked = state === "noown";
  const options = (
    <fieldset className="opts" aria-label="Loops to record">
      {rows.map((r) => (
        <label className="opt" key={r.loop} aria-disabled={locked || undefined}>
          <input type="checkbox" checked={!locked && picked.has(r.loop)} disabled={locked} onChange={(e) => toggle(r.loop, e.target.checked)} />
          <span className="ol">{r.label}</span>
          <span className="od">{r.detail}</span>
        </label>
      ))}
    </fieldset>
  );
  const close = (
    <div className="formacts">
      <button type="button" className="btn pri" onClick={onClose}>
        Close
      </button>
    </div>
  );
  const owner = s.owner ?? "The owner";

  let body: ReactNode;
  if (state === "adminoff") {
    body = (
      <>
        <Para lead="Session recording is off on this server.">An Admin turns it on in Admin &gt; Settings &gt; Feature flags. Until then nothing is captured, stored or sent.</Para>
        {close}
      </>
    );
  } else if (state === "signin") {
    body = (
      <>
        <Para lead="Sign in to choose what to record.">Use Sign in in the top bar. Only the session&apos;s owner, or an Admin, can start, stop or open a recording. You can see that a session is recorded and when it will be deleted.</Para>
        {close}
      </>
    );
  } else if (state === "other") {
    body = (
      <>
        <Para lead="Only the session's owner or an Admin can choose what to record.">You can see that this session is recorded and when it will be deleted. You cannot start, stop or open the recording.</Para>
        {close}
      </>
    );
  } else if (state === "ended") {
    body = (
      <>
        <Para lead="This session has ended.">A recording can be started only on a session that is running. Nothing from before it started was kept.</Para>
        {close}
      </>
    );
  } else if (state === "started") {
    const names = rows.filter((r) => grant!.loops.includes(r.loop)).map((r) => r.label);
    body = (
      <>
        <Para lead={`Recording started${grant!.startedAt !== null ? ` at ${fmtAt(grant!.startedAt)}` : ""}.`}>
          Recording {names.join(", ") || "nothing yet"}. Nothing before now was kept. The notice is on the wall card and the orchestrator page, and Podium has told the owner in their terminal.
        </Para>
        {close}
      </>
    );
  } else if (state === "noown") {
    body = (
      <>
        <Para lead="This session's reporter does not allow recording.">
          Recording needs two yes answers: the Admin&apos;s switch and the session&apos;s owner. {owner} has not turned on the sessionRecording option in podium-reporter on this machine, so nothing can be recorded. They can turn it on with <code>{OPTION_CMD}</code>.
        </Para>
        {options}
        <div className="formacts">
          <button type="button" className="btn pri" disabled>
            Start recording
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <Para>Recording starts when you press Start. Nothing before it is kept.</Para>
        <Para lead="What is kept.">Prompts, file contents, command output and tool results are kept for {keepHours === null ? "the time the Admin set" : `${keepHours} ${keepHours === 1 ? "hour" : "hours"}`}, then deleted. Either the owner or an Admin can stop it or delete it at any time.</Para>
        {options}
        {err && (
          <p className="signerr" role="alert">
            {err}
          </p>
        )}
        <div className="formacts">
          <button type="button" className="btn pri" disabled={busy || picked.size === 0} onClick={() => void start()}>
            Start recording
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </>
    );
  }
  return (
    <Modal titleId={`${id}-t`} title="Record this session" sub={[s.machine?.name, "orchestrator", s.git?.branch].filter(Boolean).join(", ")} onClose={onClose}>
      <div className="mb recmb">{body}</div>
    </Modal>
  );
}
