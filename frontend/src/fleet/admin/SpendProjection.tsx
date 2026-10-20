// Spend projection (#483): a straight run rate over the last 7, 14 or 30 complete days, projected to the end of the month or
// 30 days ahead. It says what the window was and what it leaves out, and with too little history it says so instead of a number.
import { useEffect, useRef, useState } from "react";
import { AdminError, query } from "./adminApi";
import { Choice, Panel } from "./Page";
import { Pager } from "./Pager";
import { ExportButtons } from "./ReportParts";
import {
  DASH,
  fmtMoney,
  readProjectionPrefs,
  reportErrorText,
  saveFile,
  writeProjectionPrefs,
  ymd,
  type ProjectionPrefs,
  type ProjectionReply,
  type ReportsClient,
} from "./reportsApi";

/** The day a projection runs to: the last day of this month, or 30 days from today. */
export function projectionEnd(horizon: ProjectionPrefs["horizon"], now = new Date()): { date: string; daysAfterToday: number } {
  if (horizon === "30d") return { date: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30)), daysAfterToday: 30 };
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { date: ymd(last), daysAfterToday: last.getDate() - now.getDate() };
}

export function SpendProjection({ client, onLocked }: { client: ReportsClient; onLocked: () => void }) {
  const [prefs, setPrefsState] = useState<ProjectionPrefs>(readProjectionPrefs);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ProjectionReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const lock = useRef(onLocked);
  lock.current = onLocked;
  const setPrefs = (p: Partial<ProjectionPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefsState(next);
    writeProjectionPrefs(next);
    setPage(1);
  };
  const path = `/reports/spend/projection${query({ horizon: prefs.horizon, window: prefs.window, by: prefs.by })}`;
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    client.get<ProjectionReply>(path).then(
      (d) => live && setData(d),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof AdminError && e.status === 401) lock.current();
        else setError(reportErrorText(e, "the projection"));
      },
    );
    return () => {
      live = false;
    };
  }, [client, path, tick]);

  const exportAs = async (format: "csv" | "json") => {
    setExportError(null);
    if (format === "json" && !data) return;
    const name = `podium-spend-projection-${ymd(new Date())}.${format}`;
    try {
      if (format === "json") saveFile(name, "application/json", JSON.stringify(data, null, 2));
      else saveFile(name, "text/csv", await client.text(`${path}&format=csv`));
    } catch (e) {
      if (e instanceof AdminError && e.status === 401) lock.current();
      else setExportError("Could not download the file. Try again.");
    }
  };

  const end = projectionEnd(prefs.horizon);
  const byGroup = prefs.by === "group";
  const rows = data?.rows ?? [];
  const shown = rows.slice((page - 1) * prefs.pageSize, page * prefs.pageSize);
  const total = data?.total ?? null;
  const known = total !== null && total.projected !== null;
  const unpriced = data?.unpricedSessions ?? 0;
  return (
    <section className="asec" aria-labelledby="spend-proj-h">
      <div className="asec-h">
        <div>
          <h2 id="spend-proj-h">Projection</h2>
          <p className="hint">A straight run rate from past spend. Not a budget and not a bill.</p>
        </div>
        <ExportButtons print={false} noun="projection " disabled={!data} onCsv={() => void exportAs("csv")} onJson={() => void exportAs("json")} error={exportError} />
      </div>
      <Panel>
        <div className="tool">
          <Choice label="Horizon" value={prefs.horizon} options={[["month", "Rest of this month"], ["30d", "Next 30 days"]]} onChange={(horizon) => setPrefs({ horizon })} />
          <Choice label="Window" value={prefs.window} options={[[7, "7 days"], [14, "14 days"], [30, "30 days"]]} onChange={(window) => setPrefs({ window })} />
          <Choice label="Group by" value={prefs.by} options={[["person", "People"], ["group", "Groups"]]} onChange={(by) => setPrefs({ by })} />
          {data && total && (
            <div className="sum">
              {known ? (
                <>
                  <div>
                    <span className="big mono">{fmtMoney(total.projected)}</span>
                    <span className="cap">projected to {end.date}</span>
                  </div>
                  <div>
                    <span className="big mono">{fmtMoney(total.runRatePerDay)}</span>
                    <span className="cap">run rate per day</span>
                  </div>
                </>
              ) : (
                <div>
                  <span className="big">Not enough history to project.</span>
                  <span className="cap">Podium has {data.historyDays} {data.historyDays === 1 ? "day" : "days"} so far.</span>
                </div>
              )}
            </div>
          )}
        </div>
        {error && (
          <div className="err" role="alert">
            {error}{" "}
            <button type="button" className="btn sm" onClick={() => setTick((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {!data && !error && <div className="empty">Loading…</div>}
        {data && (
          <>
            <div className="note-line">
              <b>
                Based on the {data.window.days} {data.window.days === 1 ? "day" : "days"} {data.window.from} to {data.window.to}.
              </b>{" "}
              Straight run rate: weekdays, trends and price changes are not allowed for. Not a budget.{" "}
              {unpriced > 0 ? `${unpriced} ${unpriced === 1 ? "session" : "sessions"} on models without a price ${unpriced === 1 ? "is" : "are"} left out.` : "Models without a price are left out."}
            </div>
            {rows.length === 0 ? (
              <div className="empty">Nothing was spent in this window yet.</div>
            ) : (
              <>
                <div className="tw2">
                  <table className="ptab" aria-label={`Projection by ${byGroup ? "group" : "person"}`}>
                    <thead>
                      <tr>
                        <th scope="col">{byGroup ? "Group" : "Person"}</th>
                        <th scope="col" className="n">
                          Run rate per day
                        </th>
                        <th scope="col" className="n">
                          So far this month
                        </th>
                        <th scope="col" className="n">
                          Projected to {end.date}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr key={r.key}>
                          <td className="who">{r.key === "-" ? (byGroup ? "No group" : "No owner") : r.key}</td>
                          <td className={`n mono${r.runRatePerDay === null ? " muted" : ""}`}>{fmtMoney(r.runRatePerDay)}</td>
                          <td className="n mono">{fmtMoney(r.spentThisMonth)}</td>
                          {r.projected === null ? (
                            <td className="n mono muted" title="Too few days of spend in the window to project from.">
                              Not enough history
                            </td>
                          ) : (
                            <td className="n mono">{fmtMoney(r.projected)}</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                    {total && (
                      <tfoot>
                        <tr>
                          <th scope="row">Total</th>
                          <td className="n mono">{fmtMoney(total.runRatePerDay)}</td>
                          <td className="n mono">{fmtMoney(total.spentThisMonth)}</td>
                          <td className="n mono">{known ? fmtMoney(total.projected) : DASH}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
                <Pager id="admin-proj" page={page} pageSize={prefs.pageSize} total={rows.length} onPage={setPage} onSize={(pageSize) => setPrefs({ pageSize })} />
              </>
            )}
          </>
        )}
      </Panel>
    </section>
  );
}
