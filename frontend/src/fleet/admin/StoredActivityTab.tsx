// Admin > Server > Stored activity (#432, mockup/podium-activity-history.html): the Activity history Podium has kept, by session.
// Totals first, then filters, then the sessions with a tick box. Deleting works three ways (the ticked sessions, everything the
// filter matches, everything), each asks first in a warning-bordered box, and a result line says what went. The selection and the
// confirmation follow Reporters (ReportersTab.tsx).
import { useEffect, useState } from "react";
import { AdminError, query, type AdminApi, type StoredActivityList, type StoredDeleteBody, type StoredDeleteResult, type StoredFilter, type StoredSessionRow } from "./adminApi";
import { dayOf, fmtBytes, fmtCount, sessionsText } from "./activityFormat";
import { Pager } from "./Pager";
import { Panel, Section } from "./Page";
import { WarnIcon } from "./ReporterMessaging";
import { failText, useList } from "./useList";

interface Filters {
  q: string;
  loop: "all" | "main" | "agents";
  project: string;
  owner: string;
  /** "" is any age, a number of days, or "custom" with `days` typed in. */
  age: string;
  days: string;
  from: string;
  to: string;
}
const NO_FILTERS: Filters = { q: "", loop: "all", project: "", owner: "", age: "", days: "", from: "", to: "" };
const LOOPS: [Filters["loop"], string][] = [
  ["all", "Orchestrator and agents"],
  ["main", "Orchestrator only"],
  ["agents", "Agents only"],
];
const AGES: [string, string][] = [
  ["", "Any age"],
  ["7", "7 days"],
  ["30", "30 days"],
  ["90", "90 days"],
  ["custom", "Custom…"],
];

/** A day typed as 2026-10-01, as local midnight; NaN when it is not one. */
const dayStart = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? new Date(`${v.trim()}T00:00:00`).getTime() : Number.NaN);

/** The filter as the server takes it, and the sentence for a date field that is not a day. Only what is set is sent. */
export function filterOf(f: Filters): { filter: StoredFilter; problem: string } {
  const filter: StoredFilter = {};
  let problem = "";
  if (f.q.trim()) filter.q = f.q.trim();
  if (f.loop !== "all") filter.loop = f.loop;
  if (f.project) filter.project = f.project;
  if (f.owner) filter.owner = f.owner;
  const days = f.age === "custom" ? Number.parseInt(f.days, 10) : f.age ? Number.parseInt(f.age, 10) : Number.NaN;
  if (days > 0) filter.olderThanDays = days;
  const from = dayStart(f.from);
  // "to" is a day, and that whole day counts, so the range ends at the start of the next one.
  const to = dayStart(f.to) + 86_400_000;
  if (f.from.trim() && Number.isNaN(from)) problem = "Write the dates as 2026-10-01.";
  else if (!Number.isNaN(from)) filter.from = from;
  if (f.to.trim() && Number.isNaN(to)) problem = "Write the dates as 2026-10-01.";
  else if (!Number.isNaN(to)) filter.to = to;
  return { filter, problem };
}

/** What the filter holds, in words, for the confirmation: "older than 30 days, project podium". */
function describe(f: StoredFilter): string {
  const parts = [
    f.q && `session matches "${f.q}"`,
    f.loop === "main" && "orchestrator only",
    f.loop === "agents" && "agents only",
    f.project && `project ${f.project}`,
    f.owner && `owner ${f.owner}`,
    f.olderThanDays && `older than ${f.olderThanDays} days`,
    f.from !== undefined && `entries from ${dayOf(f.from)}`,
    f.to !== undefined && `entries before ${dayOf(f.to)}`,
  ].filter(Boolean);
  return parts.join(", ") || "no filter";
}

interface Pending {
  what: string;
  sessions: number;
  entries: number;
  bytes: number;
  body: StoredDeleteBody;
  /** Everything and a filter reach sessions that may be running, which the box says. */
  live: boolean;
}

export function StoredActivityTab(props: { api: AdminApi; onGo: (tab: "kept") => void; onCount: (n: number) => void; onLocked: () => void }) {
  const { api, onCount } = props;
  const [paging, setPaging] = useState({ page: 1, pageSize: 25 });
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [search, setSearch] = useState("");
  // The rows ticked, kept by id so a tick survives a change of page, and a delete waiting for its confirmation.
  const [sel, setSel] = useState<Record<string, StoredSessionRow>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [err, setErr] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const { filter, problem } = filterOf(f);
  const list = useList<StoredActivityList>(api, `/stored-activity${query({ page: paging.page, pageSize: paging.pageSize, ...filter })}`, props.onLocked);
  const policy = useList<{ activityHistory?: { settings: { policy: string; n: number; unit: string } } }>(api, "/settings", props.onLocked).data?.activityHistory?.settings;
  const data = list.data;
  const total = data?.totals.sessions;
  useEffect(() => {
    if (total !== undefined) onCount(total);
  }, [total, onCount]);
  useEffect(() => {
    if (search === f.q) return;
    const t = setTimeout(() => (setF((cur) => ({ ...cur, q: search })), setPaging((p) => ({ ...p, page: 1 }))), 250);
    return () => clearTimeout(t);
  }, [search, f.q]);

  const change = (patch: Partial<Filters>) => {
    setPending(null);
    setPaging((p) => ({ ...p, page: 1 }));
    setF((cur) => ({ ...cur, ...patch }));
  };
  const rows = data?.rows ?? [];
  const picked = Object.values(sel);
  const pageAllSelected = rows.length > 0 && rows.every((r) => sel[r.sessionId]);
  const askFor = (p: Pending) => {
    setResult("");
    setErr("");
    setPending(p);
  };
  const toggle = (r: StoredSessionRow, on: boolean) => {
    setPending(null);
    setSel((cur) => {
      const next = { ...cur };
      if (on) next[r.sessionId] = r;
      else delete next[r.sessionId];
      return next;
    });
  };
  const sum = (list: StoredSessionRow[]) => list.reduce((a, r) => ({ entries: a.entries + r.entries, bytes: a.bytes + r.bytes }), { entries: 0, bytes: 0 });
  const removePending = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await api<StoredDeleteResult>("POST", "/stored-activity/delete", pending.body);
      setSel({});
      setPending(null);
      setErr("");
      setPaging((p) => ({ ...p, page: 1 }));
      setResult(`Deleted ${fmtCount(r.entries)} entries (${fmtBytes(r.bytes)}) from ${sessionsText(r.sessions)}. ${fmtBytes(r.freed)} freed and the file compacted. Written to the Admin log.`);
      list.reload();
    } catch (e) {
      if (e instanceof AdminError && e.status === 401) props.onLocked();
      else setErr(failText(e));
    } finally {
      setBusy(false);
    }
  };

  const nSel = picked.length;
  const t = sum(picked);
  return (
    <Section
      id="stored-h"
      title="What is stored"
      help={
        <>
          Policy: {policy ? policyWords(policy) : "not loaded"}.{" "}
          <button type="button" className="klink" onClick={() => props.onGo("kept")}>
            Change it
          </button>
        </>
      }
    >
      <Panel>
        <div className="tool">
          <div className="f">
            <label className="lab" htmlFor="stored-q">
              Session
            </label>
            <input className="field" id="stored-q" placeholder="Name or id" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="f">
            <label className="lab" htmlFor="stored-loop">
              Loop
            </label>
            <select className="field" id="stored-loop" value={f.loop} onChange={(e) => change({ loop: e.target.value as Filters["loop"] })}>
              {LOOPS.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="f">
            <label className="lab" htmlFor="stored-project">
              Project
            </label>
            <select className="field" id="stored-project" value={f.project} onChange={(e) => change({ project: e.target.value })}>
              <option value="">All projects</option>
              {(data?.projects ?? []).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="f">
            <label className="lab" htmlFor="stored-owner">
              Owner
            </label>
            <select className="field" id="stored-owner" value={f.owner} onChange={(e) => change({ owner: e.target.value })}>
              <option value="">Everyone</option>
              {(data?.owners ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          <div className="f">
            <label className="lab" htmlFor="stored-age">
              Older than
            </label>
            <select className="field" id="stored-age" value={f.age} onChange={(e) => change({ age: e.target.value })}>
              {AGES.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          {f.age === "custom" && (
            <div className="f">
              <label className="lab" htmlFor="stored-days">
                Days
              </label>
              <input className="field mono daysbox" id="stored-days" inputMode="numeric" value={f.days} onChange={(e) => change({ days: e.target.value })} />
            </div>
          )}
          <div className="f">
            <label className="lab" htmlFor="stored-from">
              Entries from
            </label>
            <input className="field" id="stored-from" placeholder="2026-10-01" value={f.from} onChange={(e) => change({ from: e.target.value })} />
          </div>
          <div className="f">
            <label className="lab" htmlFor="stored-to">
              to
            </label>
            <input className="field" id="stored-to" placeholder="2026-10-08" value={f.to} onChange={(e) => change({ to: e.target.value })} />
          </div>
          <div className="f">
            <label className="lab" htmlFor="stored-src">
              Source
            </label>
            <select className="field" id="stored-src" defaultValue="activity">
              <option value="activity">Activity</option>
            </select>
          </div>
        </div>
        <div className="tool alone">
          <div className="sum left">
            <div>
              <span className="big mono">{data ? fmtCount(data.totals.entries) : "–"}</span>
              <span className="cap">entries stored</span>
            </div>
            <div>
              <span className="big mono">{data ? fmtBytes(data.totals.bytes) : "–"}</span>
              <span className="cap">on disk</span>
            </div>
            <div>
              <span className="big mono">{data ? fmtCount(data.totals.sessions) : "–"}</span>
              <span className="cap">sessions</span>
            </div>
            <div>
              <span className="big mono">{data ? fmtCount(data.match.sessions) : "–"}</span>
              <span className="cap">match the filter</span>
            </div>
          </div>
        </div>
        {problem && (
          <div className="err" role="alert">
            {problem}
          </div>
        )}
        {result && (
          <div className="result" role="status">
            {result}
          </div>
        )}
        {pending && (
          <div className="callout" role="alert">
            <WarnIcon />
            <h3>Delete {pending.what}?</h3>
            <p>
              <b>
                {fmtCount(pending.entries)} entries, {fmtBytes(pending.bytes)}
              </b>{" "}
              will be removed for good and the space freed. The sessions, History and the live feed are not touched. This is written to the Admin log.
              {pending.live && " A session that is still running keeps being captured while the policy keeps history."}
            </p>
            <p className="formacts">
              <button type="button" className="btn dng" disabled={busy} onClick={() => void removePending()}>
                Delete {fmtCount(pending.entries)} entries
              </button>
              <button type="button" className="btn" onClick={() => setPending(null)}>
                Keep them
              </button>
            </p>
          </div>
        )}
        <div className="selbar" role="group" aria-label="Delete stored activity">
          <span className="count">{nSel ? `${nSel} selected, ${fmtCount(t.entries)} entries, ${fmtBytes(t.bytes)}` : "None selected"}</span>
          <span className="grow" />
          <button
            type="button"
            className="btn sm dng"
            disabled={!nSel}
            onClick={() =>
              askFor({
                what: `the stored activity of ${sessionsText(nSel)}`,
                sessions: nSel,
                ...t,
                body: { ids: Object.keys(sel) },
                live: picked.some((r) => r.live),
              })
            }
          >
            {nSel ? `Delete ${nSel}…` : "Delete selected…"}
          </button>
          <button
            type="button"
            className="btn sm dng"
            disabled={!data || data.match.sessions === 0 || Object.keys(filter).length === 0}
            onClick={() =>
              data &&
              askFor({
                what: `the stored activity of the ${sessionsText(data.match.sessions)} that ${data.match.sessions === 1 ? "matches" : "match"}: ${describe(filter)}`,
                sessions: data.match.sessions,
                entries: data.match.entries,
                bytes: data.match.bytes,
                body: { match: filter },
                live: true,
              })
            }
          >
            Delete all {data ? fmtCount(data.match.sessions) : 0} that match…
          </button>
          <button
            type="button"
            className="btn sm dng"
            disabled={!data || data.totals.sessions === 0}
            onClick={() =>
              data &&
              askFor({
                what: `all stored activity, for all ${sessionsText(data.totals.sessions)}`,
                sessions: data.totals.sessions,
                entries: data.totals.entries,
                bytes: data.totals.bytes,
                body: { all: true },
                live: true,
              })
            }
          >
            Delete everything…
          </button>
        </div>
        {err && (
          <div className="err" role="alert">
            {err}
          </div>
        )}
        {list.error && (
          <div className="err" role="alert">
            Could not load the stored activity ({list.error}).
          </div>
        )}
        {data && rows.length === 0 && <div className="empty">{data.totals.sessions ? "No stored session matches. Clear a filter or widen the dates." : "Nothing is stored. Choose a keep policy on Data and Podium starts keeping activity."}</div>}
        {data && rows.length > 0 && (
          <div className="tw2">
            <table className="ptab" aria-label="Stored activity by session">
              <thead>
                <tr>
                  <th scope="col" className="chk">
                    <input
                      type="checkbox"
                      aria-label={`Select all ${rows.length} on this page`}
                      checked={pageAllSelected}
                      onChange={(e) => {
                        setPending(null);
                        setSel((cur) => {
                          const next = { ...cur };
                          for (const r of rows) {
                            if (e.target.checked) next[r.sessionId] = r;
                            else delete next[r.sessionId];
                          }
                          return next;
                        });
                      }}
                    />
                  </th>
                  <th scope="col">Session</th>
                  <th scope="col">Owner</th>
                  <th scope="col">State</th>
                  <th scope="col" className="n">
                    Entries
                  </th>
                  <th scope="col" className="n">
                    Size
                  </th>
                  <th scope="col">Oldest entry</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sessionId} className={`rw${sel[r.sessionId] ? " sel" : ""}`}>
                    <td className="chk">
                      <input type="checkbox" aria-label={`Select ${r.name}`} checked={!!sel[r.sessionId]} onChange={(e) => toggle(r, e.target.checked)} />
                    </td>
                    <td className="who">
                      {r.name}
                      {r.project && <span className="hint">{r.project}</span>}
                    </td>
                    <td>{r.owner ?? "–"}</td>
                    <td>
                      {r.live ? (
                        <span className="badge ok">
                          <span aria-hidden="true">●</span> Live
                        </span>
                      ) : (
                        <span className="badge off">
                          <span aria-hidden="true">○</span> Ended
                        </span>
                      )}
                    </td>
                    <td className="n mono">{fmtCount(r.entries)}</td>
                    <td className="n mono">{fmtBytes(r.bytes)}</td>
                    <td className="mono">{dayOf(r.oldestAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 && <Pager id="stored" page={data.page} pageSize={data.pageSize} total={data.total} onPage={(n) => setPaging((p) => ({ ...p, page: n }))} onSize={(n) => setPaging({ pageSize: n, page: 1 })} />}
        <div className="note-line">
          Deleting removes stored entries only. Sessions, History and the live feed are not touched. The space comes back: the file is compacted after a delete, which can take a few seconds. Each delete is written to the Admin log with who did it and how much went. Copies of the database in backups you made are not changed.
        </div>
      </Panel>
    </Section>
  );
}

/** "not stored", "purge after 30 days": the policy in a phrase for the line under the heading. */
function policyWords(s: { policy: string; n: number; unit: string }): string {
  if (s.policy === "after") return `purge after ${s.n} ${s.unit}`;
  if (s.policy === "end") return "purge when the session ends";
  if (s.policy === "all") return "keep everything";
  return "not stored";
}
