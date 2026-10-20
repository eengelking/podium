// Admin > Settings > Session recording (#353, mockup/podium-recording.html): the limits (how long a recording is kept, the disk
// budget, the limit for one session) and the table of every recording that is running or kept, where an Admin can stop or delete
// any of them after a confirmation. Recordings are also listed by Stored activity with its Source filter set to Recordings.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { RECORDING_RANGES } from "../../../../server/src/fleet/protocol";
import { replayHash } from "../../route";
import { fmtWhen } from "../recording";
import type { RecordingAdminRow, RecordingSettings } from "../types";
import { AdminError, query, type AdminApi } from "./adminApi";
import { ACTIVITY_REFRESH_MS, fmtBytes } from "./activityFormat";
import { Pager } from "./Pager";
import { Panel, Section } from "./Page";
import { WarnIcon } from "./ReporterMessaging";
import { failText, useList } from "./useList";

/** What GET /settings carries for recording. */
export interface RecordingState {
  settings: RecordingSettings;
  totals: { recordings: number; bytes: number; running: number };
  authOn: boolean;
}

interface RecordingList {
  total: number;
  page: number;
  pageSize: number;
  rows: RecordingAdminRow[];
}

/** The warning under the feature flag: what a recording holds and who can read it. */
export function RecordingWarning() {
  return (
    <div className="warnbar" role="note">
      <WarnIcon />
      <span className="tx">
        A recording holds whole prompts, file contents, command output and tool results. Secrets are removed on the machine before it is sent, but that is best effort. A session is recorded only when its owner has allowed it in the reporter and someone has chosen it. Only the owner and an Admin can read a recording.
      </span>
    </div>
  );
}

/** Hours as the box shows them: whole days when it divides, otherwise hours. */
export function keepShown(hours: number): { n: string; unit: "hours" | "days" } {
  return hours >= 24 && hours % 24 === 0 ? { n: String(hours / 24), unit: "days" } : { n: String(hours), unit: "hours" };
}

/** A whole number in a box, or null. */
const whole = (text: string): number | null => (/^\d{1,9}$/.test(text.trim()) ? Number.parseInt(text.trim(), 10) : null);

/** The three limits as the box holds them, as the server takes them, or the sentence for the first one that is wrong. */
export function limitsOf(f: { n: string; unit: string; gb: string; mb: string }): { ok: true; value: RecordingSettings } | { ok: false; error: string } {
  const n = whole(f.n);
  const hours = n === null ? null : f.unit === "days" ? n * 24 : n;
  const { keepHours: k, budgetMb: b, sessionMb: s } = RECORDING_RANGES;
  if (hours === null || hours < k.min || hours > k.max) return { ok: false, error: `Enter a whole number of hours or days, from ${k.min} hour to 7 days.` };
  const gb = f.gb.trim() !== "" && /^\d{1,6}(\.\d{1,3})?$/.test(f.gb.trim()) ? Number(f.gb.trim()) : null;
  const budgetMb = gb === null ? null : Math.round(gb * 1024);
  if (budgetMb === null || budgetMb < b.min || budgetMb > b.max) return { ok: false, error: `The disk budget is from ${b.min} MB to ${b.max / 1024} GB.` };
  const sessionMb = whole(f.mb);
  if (sessionMb === null || sessionMb < s.min || sessionMb > s.max) return { ok: false, error: `The limit for one session is from ${s.min} MB to ${s.max / 1024} GB.` };
  return { ok: true, value: { keepHours: hours, budgetMb, sessionMb } };
}

const gbText = (mb: number) => String(Number((mb / 1024).toFixed(3)));

/** The limits form. Saving is written to the Admin log; a shorter time removes recordings that are already older. */
export function RecordingLimits({ api, state, onSaved, onLocked }: { api: AdminApi; state: RecordingState; onSaved: () => void; onLocked: () => void }) {
  const { settings } = state;
  const initial = () => {
    const k = keepShown(settings.keepHours);
    return { n: k.n, unit: k.unit as string, gb: gbText(settings.budgetMb), mb: String(settings.sessionMb) };
  };
  const [f, setF] = useState(initial);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(initial()), [settings.keepHours, settings.budgetMb, settings.sessionMb]);
  const set = (patch: Partial<typeof f>) => {
    setDone("");
    setF((cur) => ({ ...cur, ...patch }));
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = limitsOf(f);
    if (!v.ok) return setErr(v.error);
    setErr("");
    setBusy(true);
    try {
      await api("PUT", "/settings", { recording: v.value });
      setDone("Saved. Written to the Admin log.");
      onSaved();
    } catch (x) {
      if (x instanceof AdminError && x.status === 401) onLocked();
      else setErr(x instanceof AdminError && x.status === 400 ? `${x.message.replace(/\.?$/, ".")} Change it and try again.` : `Could not save the limits: ${failText(x)}. Try again.`);
    } finally {
      setBusy(false);
    }
  };
  const budgetGb = gbText(settings.budgetMb);
  return (
    <Section id="a-rs" title="Session recording" help="How long recordings are kept and how much disk they may use.">
      <form className="panel" aria-label="Session recording limits" onSubmit={(e) => void submit(e)} onReset={() => { setErr(""); setDone(""); setF(initial()); }}>
        <div className="srow">
          <div className="setname">
            <b>Keep a recording for</b>
            <p className="hint ink2">Counted from when each part was recorded. Expiry runs every few minutes, so a short time is honored. The most you can set is 7 days.</p>
          </div>
          <span className="row2">
            <input className="field mono daysbox" id="rec-n" inputMode="numeric" value={f.n} aria-label="Number" onChange={(e) => set({ n: e.target.value })} />
            <select className="field" id="rec-u" aria-label="Unit" value={f.unit} onChange={(e) => set({ unit: e.target.value })}>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </span>
        </div>
        <div className="srow">
          <div className="setname">
            <b>Disk budget</b>
            <p className="hint ink2">At this total size every recording stops, with a note at the point where it stopped. Nothing is cut short.</p>
          </div>
          <span className="row2">
            <input className="field mono daysbox" id="rec-b" inputMode="decimal" value={f.gb} aria-label="Size in gigabytes" onChange={(e) => set({ gb: e.target.value })} />
            <span className="hint">GB</span>
          </span>
        </div>
        <div className="srow">
          <div className="setname">
            <b>Limit for one session</b>
            <p className="hint ink2">A recording stops when one session reaches this size.</p>
          </div>
          <span className="row2">
            <input className="field mono daysbox" id="rec-c" inputMode="numeric" value={f.mb} aria-label="Size in megabytes" onChange={(e) => set({ mb: e.target.value })} />
            <span className="hint">MB</span>
          </span>
        </div>
        <div className="srow">
          <span className="hint">Saving is written to the Admin log. A shorter time removes recordings that are already older.</span>
          <span className="formacts">
            <button type="reset" className="btn">
              Cancel
            </button>
            <button type="submit" className="btn pri" disabled={busy}>
              Save
            </button>
          </span>
        </div>
        {err && (
          <div className="err" role="alert">
            {err}
          </div>
        )}
        {done && (
          <div className="result" role="status">
            {done}
          </div>
        )}
        <div className="note-line">
          <b className="mono">
            {state.totals.recordings} {state.totals.recordings === 1 ? "recording" : "recordings"}, {fmtBytes(state.totals.bytes)}
          </b>{" "}
          stored now, of a {budgetGb} GB budget. Stored activity lists them with its Source filter set to Recordings.
        </div>
      </form>
    </Section>
  );
}

const STATE_BADGE = (r: RecordingAdminRow) => {
  if (r.state === "recording")
    return (
      <span className="badge recording">
        <span aria-hidden="true">●</span> Recording
      </span>
    );
  return (
    <span className="badge off">
      <span aria-hidden="true">○</span> {r.state === "limit" ? (r.limit === "budget" ? "Budget reached" : "Limit reached") : "Stopped"}
    </span>
  );
};

interface Ask {
  kind: "stop" | "delete";
  row: RecordingAdminRow;
}

/** Every recording that is running or kept, a page at a time. Stop and Delete ask first in the warning-bordered box. */
export function RecordingsTable({ api, onLocked, now }: { api: AdminApi; onLocked: () => void; now: number }) {
  const [paging, setPaging] = useState({ page: 1, pageSize: 25 });
  const list = useList<RecordingList>(api, `/recordings${query(paging)}`, onLocked, ACTIVITY_REFRESH_MS);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState("");
  const first = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (ask) first.current?.focus();
  }, [ask]);
  const data = list.data;
  const close = () => {
    setAsk(null);
    opener.current?.focus();
  };
  const run = async () => {
    if (!ask) return;
    setBusy(true);
    setErr("");
    try {
      const id = encodeURIComponent(ask.row.sessionId);
      if (ask.kind === "stop") await api("POST", `/recordings/${id}/stop`);
      else await api("DELETE", `/recordings/${id}`);
      setResult(ask.kind === "stop" ? `Stopped the recording of ${ask.row.name}. What was recorded is kept. Written to the Admin log.` : `Deleted the recording of ${ask.row.name}. Written to the Admin log.`);
      setAsk(null);
      list.reload();
    } catch (e) {
      if (e instanceof AdminError && e.status === 401) onLocked();
      else setErr(`Could not ${ask.kind === "stop" ? "stop" : "delete"} the recording: ${failText(e)}. Try again.`);
    } finally {
      setBusy(false);
    }
  };
  const askFor = (kind: Ask["kind"], row: RecordingAdminRow, from: HTMLElement) => {
    opener.current = from;
    setResult("");
    setErr("");
    setAsk({ kind, row });
  };
  return (
    <Section id="a-lg" title="Recordings" help="Every recording that is running or kept. An Admin can stop or delete any of them.">
      <Panel>
        {ask && (
          <div className="callout" role="alert" onKeyDown={(e) => e.key === "Escape" && close()}>
            <WarnIcon />
            <h3>{ask.kind === "stop" ? `Stop recording ${ask.row.name}?` : `Delete the recording of ${ask.row.name}?`}</h3>
            <p>
              {ask.kind === "stop"
                ? "Capture ends now. What was recorded up to now is kept until it expires, and the owner can still replay it. This is written to the Admin log."
                : "The whole recording is removed for good, and the space freed. The session, History and the live feed are not touched. This is written to the Admin log."}
            </p>
            <p className="formacts">
              <button type="button" className="btn dng" ref={first} disabled={busy} onClick={() => void run()}>
                {ask.kind === "stop" ? "Stop recording" : "Delete recording"}
              </button>
              <button type="button" className="btn" onClick={close}>
                {ask.kind === "stop" ? "Keep recording" : "Keep it"}
              </button>
            </p>
          </div>
        )}
        {result && (
          <div className="result" role="status">
            {result}
          </div>
        )}
        {err && (
          <div className="err" role="alert">
            {err}
          </div>
        )}
        {list.error && (
          <div className="err" role="alert">
            Could not load the recordings ({list.error}). It tries again by itself.
          </div>
        )}
        {!data && !list.error && <div className="empty">Loading…</div>}
        {data && data.rows.length === 0 && <div className="empty">No session is recorded. A session&apos;s owner or an Admin starts one from the Recording cell on the orchestrator page.</div>}
        {data && data.rows.length > 0 && (
          <div className="tw2">
            <table className="ptab" aria-label="Recordings">
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Started by</th>
                  <th scope="col">State</th>
                  <th scope="col" className="n">
                    Size
                  </th>
                  <th scope="col">Deleted at</th>
                  <th scope="col">
                    <span className="sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.sessionId}>
                    <td className="who">
                      {r.name}
                      <span className="hint">{r.label}</span>
                    </td>
                    <td>{r.owner ?? "–"}</td>
                    <td>{r.startedBy ?? "–"}</td>
                    <td>{STATE_BADGE(r)}</td>
                    <td className="n mono">{fmtBytes(r.bytes)}</td>
                    <td className="mono">{r.keptUntil !== null ? fmtWhen(r.keptUntil, now) : "–"}</td>
                    <td>
                      <span className="formacts">
                        {r.state === "recording" ? (
                          <button type="button" className="btn sm" onClick={(e) => askFor("stop", r, e.currentTarget)}>
                            Stop
                          </button>
                        ) : (
                          <a className="btn sm" href={replayHash(r.sessionId)}>
                            Open replay
                          </a>
                        )}
                        <button type="button" className="btn sm dng" onClick={(e) => askFor("delete", r, e.currentTarget)}>
                          Delete
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 && <Pager id="rec" page={data.page} pageSize={data.pageSize} total={data.total} onPage={(n) => setPaging((p) => ({ ...p, page: n }))} onSize={(n) => setPaging({ pageSize: n, page: 1 })} />}
      </Panel>
    </Section>
  );
}
