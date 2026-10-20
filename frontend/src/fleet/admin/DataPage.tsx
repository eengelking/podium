// Admin > Server > Data (#432, mockup/podium-activity-history.html): what Podium stores and for how long. It keeps the two tables
// the old Data kept page had (rollups, detail rows) and adds the Activity history section: a policy for keeping the agent
// Activity feed after a viewer leaves, saved with Save, which asks first when it would remove stored entries or stop capturing.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ACTIVITY_HISTORY_DEFAULTS, ACTIVITY_HISTORY_RANGES, ACTIVITY_HISTORY_UNITS } from "../../../../server/src/fleet/activityHistoryTypes";
import { AdminError, type ActivityHistoryPolicy, type ActivityHistoryPreview, type ActivityHistorySettings, type ActivityHistoryState, type ActivityHistoryUnit, type AdminApi, type StoredDeleteResult } from "./adminApi";
import { fmtBytes, fmtCount, sessionsText } from "./activityFormat";
import { Panel, Section } from "./Page";
import { keptText } from "./ReportPages";
import { WarnIcon } from "./ReporterMessaging";
import type { RetentionReply } from "./reportsApi";
import { reportErrorText } from "./reportsApi";
import { failText, useList } from "./useList";

const POLICIES: { id: ActivityHistoryPolicy; name: string; help: string }[] = [
  { id: "default", name: "Not stored (default)", help: "Not stored: a window shows the last 20 entries while someone watches, and drops them when they leave." },
  { id: "after", name: "Purge after a set time", help: "Kept for the time set below, then purged." },
  { id: "end", name: "Purge when the session ends", help: "Kept while the session runs and removed when it ends." },
  { id: "all", name: "Keep everything", help: "No automatic purge. A session's own 30-day retention still removes its entries, and the shorter of the two wins." },
];

interface Draft {
  policy: ActivityHistoryPolicy;
  n: string;
  unit: ActivityHistoryUnit;
  capOn: boolean;
  capN: string;
}
const toDraft = (s: ActivityHistorySettings): Draft => ({ policy: s.policy, n: String(s.n), unit: s.unit, capOn: s.capGb !== null, capN: String(s.capGb ?? 2) });
const whole = (v: string) => (/^\d+$/.test(v.trim()) ? Number.parseInt(v, 10) : Number.NaN);
const inRange = (v: number, r: { min: number; max: number }) => v >= r.min && v <= r.max;

/** The settings a draft stands for, or the sentence that says what is wrong with it. */
export function parseDraft(d: Draft): { settings: ActivityHistorySettings } | { error: string } {
  const { n: rn, capGb: rc } = ACTIVITY_HISTORY_RANGES;
  const n = whole(d.n);
  const cap = whole(d.capN);
  if (d.policy === "after" && !inRange(n, rn)) return { error: `Enter a whole number from ${rn.min} to ${rn.max} for the time.` };
  const capped = d.policy !== "default" && d.capOn;
  if (capped && !inRange(cap, rc)) return { error: `Enter a whole number from ${rc.min} to ${rc.max} for the size cap.` };
  return { settings: { policy: d.policy, n: inRange(n, rn) ? n : ACTIVITY_HISTORY_DEFAULTS.n, unit: d.unit, capGb: capped ? cap : null } };
}

/** Two settings that behave the same: the time matters only for "after". */
const sameSettings = (a: ActivityHistorySettings, b: ActivityHistorySettings) => a.policy === b.policy && a.capGb === b.capGb && (a.policy !== "after" || (a.n === b.n && a.unit === b.unit));

/** The Detail rows table's line for Activity history. */
export function policyText(s: ActivityHistorySettings): string {
  const base = { default: "Not stored (default)", after: `Purge after ${s.n} ${s.unit}`, end: "Purge when the session ends", all: "Keep everything, no automatic purge" }[s.policy];
  return s.policy !== "default" && s.capGb !== null ? `${base}, capped at ${s.capGb} GB` : base;
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function DataPage({ api, onLocked, onGo, onCountStored }: { api: AdminApi; onLocked: () => void; onGo: (tab: "stored") => void; onCountStored: (n: number) => void }) {
  const list = useList<RetentionReply>(api, "/reports/retention", onLocked);
  const settings = useList<{ activityHistory?: ActivityHistoryState }>(api, "/settings", onLocked);
  const data = list.data;
  const history = settings.data?.activityHistory;
  const failure = list.error ? reportErrorText(new Error(list.error), "what Podium keeps") : null;
  const sessions = history?.totals.sessions;
  useEffect(() => {
    if (sessions !== undefined) onCountStored(sessions);
  }, [sessions, onCountStored]);
  return (
    <>
      <Section id="rep-kept-r" title="Daily rollups" help="A rollup holds counts, tokens, cost and names. It holds no prompts, answers, tool input or paths.">
        <Panel>
          {failure && (
            <div className="err" role="alert">
              {failure}
            </div>
          )}
          {!data && !failure && <div className="empty">Loading…</div>}
          {data && data.tables.length === 0 && <div className="empty">No daily rollups have been written yet.</div>}
          {data && data.tables.length > 0 && (
            <div className="tw2">
              <table className="ptab" aria-label="Daily rollups">
                <thead>
                  <tr>
                    <th scope="col">Table</th>
                    <th scope="col" className="n">
                      Rows
                    </th>
                    <th scope="col">Oldest day</th>
                    <th scope="col">Kept</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tables.map((t) => (
                    <tr key={t.name}>
                      <td className="who">{t.name}</td>
                      <td className="n mono">{t.rows.toLocaleString("en-US")}</td>
                      <td className={t.oldestDay ? "mono" : "mono muted"}>{t.oldestDay ?? "–"}</td>
                      <td>{keptText(t.keptDays)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </Section>
      <Section id="rep-kept-d" title="Detail rows" help="The rows the rollups are built from, and how long each lasts.">
        <Panel>
          {!data && !failure && <div className="empty">Loading…</div>}
          {data && (
            <>
              <div className="tw2">
                <table className="ptab" aria-label="Detail rows">
                  <thead>
                    <tr>
                      <th scope="col">Data</th>
                      <th scope="col">Kept</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.detail.map((d) => (
                      <tr key={d.name}>
                        <td className="who">{d.name}</td>
                        <td>{keptText(d.keptDays)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="who">Activity history</td>
                      <td>{history ? policyText(history.settings) : "Loading…"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="note-line">
                The first three periods are set with environment variables on the server (<span className="mono">RETAIN_SAMPLES_MS</span>, <span className="mono">RETAIN_EVENTS_MS</span>, <span className="mono">RETAIN_ADMIN_LOG_MS</span>) and cannot be changed here. Activity history is set below.
              </div>
            </>
          )}
        </Panel>
      </Section>
      <Section id="rep-kept-a" title="Activity history" help="How long an Activity window's entries are kept after a viewer leaves. Off by default.">
        {history ? (
          <HistoryForm api={api} state={history} onSaved={settings.reload} onLocked={onLocked} onGo={onGo} />
        ) : (
          <Panel>{settings.error ? <div className="err" role="alert">Could not load the Activity history setting ({settings.error}).</div> : <div className="empty">Loading…</div>}</Panel>
        )}
      </Section>
    </>
  );
}

/** What a confirmation waits on: the settings to save and what the server says saving would do. */
interface Ask {
  settings: ActivityHistorySettings;
  pv: ActivityHistoryPreview;
}

function HistoryForm({ api, state, onSaved, onLocked, onGo }: { api: AdminApi; state: ActivityHistoryState; onSaved: () => void; onLocked: () => void; onGo: (tab: "stored") => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(state.settings));
  const [ask, setAsk] = useState<Ask | null>(null);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const saved = JSON.stringify(state.settings);
  useEffect(() => {
    setDraft(toDraft(JSON.parse(saved) as ActivityHistorySettings));
  }, [saved]);
  useEffect(() => {
    if (ask) first.current?.focus();
  }, [ask]);

  const set = (patch: Partial<Draft>) => {
    setAsk(null);
    setDone("");
    setDraft((d) => ({ ...d, ...patch }));
  };
  const fail = (e: unknown) => {
    if (e instanceof AdminError && e.status === 401) onLocked();
    else setErr(failText(e));
  };
  const keeps = draft.policy !== "default";
  const entries = state.totals.entries;

  const save = (settings: ActivityHistorySettings) => api("PUT", "/settings", { activityHistory: settings });
  const run = async (job: () => Promise<string>) => {
    setBusy(true);
    setErr("");
    try {
      const text = await job();
      setAsk(null);
      setDone(`${text} Written to the Admin log.`);
      onSaved();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setDone("");
    setErr("");
    const p = parseDraft(draft);
    if ("error" in p) return setErr(p.error);
    if (sameSettings(p.settings, state.settings)) return setDone("Nothing changed.");
    if (entries === 0) return void run(async () => (await save(p.settings), "Saved."));
    setBusy(true);
    try {
      const pv = await api<ActivityHistoryPreview>("POST", "/activity-history/preview", { settings: p.settings });
      if (pv.stopsCapturing || pv.entries > 0) setAsk({ settings: p.settings, pv });
      else await run(async () => (await save(p.settings), "Saved."));
    } catch (e2) {
      fail(e2);
    } finally {
      setBusy(false);
    }
  };

  const removed = (n: number, bytes: number) => `${fmtCount(n)} entries (${fmtBytes(bytes)})`;
  const confirmBox = (a: Ask) => {
    const stop = a.pv.stopsCapturing;
    const title = stop ? "Stop keeping Activity history?" : "Saving removes entries that are already stored";
    const lead = stop ? (
      <>
        Podium stops capturing now. <b>{removed(a.pv.entries, a.pv.bytes)}</b> are still stored.
      </>
    ) : (
      <>
        What the new setting no longer keeps goes at the next purge: <b>{removed(a.pv.entries, a.pv.bytes)}</b> from {sessionsText(a.pv.sessions)}.
      </>
    );
    return (
      <div className="callout" role="alert">
        <WarnIcon />
        <h3>{title}</h3>
        <p>{lead} The file is compacted afterward, so the space comes back. This is written to the Admin log.</p>
        <p className="formacts">
          {stop ? (
            <>
              <button
                type="button"
                className="btn dng"
                ref={first}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await save(a.settings);
                    const r = await api<StoredDeleteResult>("POST", "/stored-activity/delete", { all: true });
                    return `Saved. Stopped capturing and removed ${removed(r.entries, r.bytes)}.`;
                  })
                }
              >
                Stop and delete {fmtCount(a.pv.entries)} entries
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => (await save(a.settings), `Saved. Stopped capturing. ${fmtCount(a.pv.entries)} entries are still stored, and Stored activity can delete them.`))}>
                Stop, keep what is stored
              </button>
            </>
          ) : (
            <button type="button" className="btn dng" ref={first} disabled={busy} onClick={() => void run(async () => (await save(a.settings), `Saved. Removed ${removed(a.pv.entries, a.pv.bytes)}.`))}>
              Save and remove {fmtCount(a.pv.entries)} entries
            </button>
          )}
          <button type="button" className="btn" onClick={() => setAsk(null)}>
            Cancel
          </button>
        </p>
      </div>
    );
  };

  return (
    <form
      className="panel"
      aria-label="Activity history retention"
      onSubmit={(e) => void submit(e)}
      onReset={(e) => {
        e.preventDefault();
        setDraft(toDraft(state.settings));
        setAsk(null);
        setErr("");
        setDone("");
      }}
    >
      <div className="srow">
        <div className="setname">
          <b id="ah-policy-n">Keep activity history</b>
          <p className="hint ink2">{POLICIES.find((p) => p.id === draft.policy)?.help}</p>
          {!state.authOn && <p className="hint ink2">A token is needed to keep history: only the session's owner and the Admin may read it, and with no token nobody can be told apart. Set a token on the server, then choose a keep policy.</p>}
        </div>
        <select className="field" aria-labelledby="ah-policy-n" value={draft.policy} onChange={(e) => set({ policy: e.target.value as ActivityHistoryPolicy })}>
          {POLICIES.map((p) => (
            <option key={p.id} value={p.id} disabled={!state.authOn && p.id !== "default"}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {draft.policy === "after" && (
        <div className="srow">
          <div className="setname">
            <b>Purge after</b>
            <p className="hint ink2">Entries older than this are removed at the next purge, which runs every few minutes. A shorter time removes older entries that are already stored.</p>
          </div>
          <span className="row2">
            <input className="field mono daysbox" inputMode="numeric" aria-label="Number" value={draft.n} onChange={(e) => set({ n: e.target.value })} />
            <select className="field" aria-label="Unit" value={draft.unit} onChange={(e) => set({ unit: e.target.value as ActivityHistoryUnit })}>
              {ACTIVITY_HISTORY_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </span>
        </div>
      )}
      {keeps && (
        <div className="srow">
          <div className="setname">
            <b>Size cap</b>
            <p className="hint ink2">Stop at a total size and remove the oldest entries first.</p>
          </div>
          <span className="row2">
            <input type="checkbox" aria-label="Use a size cap" checked={draft.capOn} onChange={(e) => set({ capOn: e.target.checked })} />
            <input className="field mono daysbox" inputMode="numeric" aria-label="Size in gigabytes" value={draft.capN} disabled={!draft.capOn} onChange={(e) => set({ capN: e.target.value })} />
            <span className="hint">GB</span>
          </span>
        </div>
      )}
      {keeps && (
        <div className="warnbar" role="note">
          <WarnIcon />
          <span className="tx">
            Podium will ask every reporter to send the activity of each running loop, not only the loops someone is watching. Expect more reporter traffic and more disk and server load. A reporter whose owner has turned off <span className="mono">activityFeed</span> still sends nothing. Only the session's owner and the Admin can read what is stored.
          </span>
        </div>
      )}
      {ask && confirmBox(ask)}
      {err && (
        <div className="err" role="alert">
          {err}
        </div>
      )}
      <div className="srow">
        <span className="hint" role="status">
          {done || "Saving is written to the Admin log."}
        </span>
        <span className="formacts">
          <button type="reset" className="btn">
            Cancel
          </button>
          <button type="submit" className="btn pri" disabled={busy}>
            Save
          </button>
        </span>
      </div>
      <div className="note-line">
        <b>Last purge</b>{" "}
        {state.lastPurge
          ? `${when(state.lastPurge.at)} removed ${removed(state.lastPurge.entries, state.lastPurge.bytes)}. It runs every few minutes, and each run that removes something is written to the Admin log as one entry with the count, the size and the policy.`
          : "None since the server started. It runs every few minutes, and each run that removes something is written to the Admin log as one entry with the count, the size and the policy."}
      </div>
      <div className="note-line">
        <b className="mono">
          {fmtCount(state.totals.entries)} entries, {fmtBytes(state.totals.bytes)}
        </b>{" "}
        stored now, in {sessionsText(state.totals.sessions)}. Totals per session, filters and delete are on{" "}
        <button type="button" className="klink" onClick={() => onGo("stored")}>
          Stored activity
        </button>
        .
      </div>
    </form>
  );
}
