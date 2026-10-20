// The pieces every Reporting page is made of (#484, mockup/podium-admin-reporting.html): Export, the Period and filters
// controls with the lines under them, and the report itself (totals, a chart in a neutral ink, the table, the pager).
// Names in a row are untrusted text and are drawn as text nodes.
import { useEffect, useId, useState } from "react";
import { query, type Paged } from "./adminApi";
import { Pager } from "./Pager";
import { Choice } from "./Page";
import {
  BYS,
  PERIODS,
  chartPoints,
  formatCell,
  isNumericColumn,
  type PeriodId,
  type ReportColumn,
  type ReportReply,
  type ReportRow,
  type ReportsClient,
} from "./reportsApi";
import type { ReportState } from "./useReport";

/** CSV and JSON download exactly the table; Print prints the page without the menu. */
export function ExportButtons({ onCsv, onJson, disabled, error, print = true, noun = "" }: { onCsv: () => void; onJson: () => void; disabled: boolean; error: string | null; print?: boolean; noun?: string }) {
  return (
    <div className="exp-wrap">
      <div className="exp" role="group" aria-label={`Export ${noun}`.trim()}>
        <button type="button" className="btn" aria-label={`Download ${noun}CSV`} disabled={disabled} onClick={onCsv}>
          CSV
        </button>
        <button type="button" className="btn" aria-label={`Download ${noun}JSON`} disabled={disabled} onClick={onJson}>
          JSON
        </button>
        {print && (
          <button type="button" className="btn" aria-label="Print this page" onClick={() => window.print()}>
            Print
          </button>
        )}
      </div>
      {error && (
        <div className="hint bad" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function ReportExport({ r, noun }: { r: ReportState; noun?: string }) {
  return <ExportButtons noun={noun} disabled={r.path === null} onCsv={() => void r.exportAs("csv")} onJson={() => void r.exportAs("json")} error={r.exportError} />;
}

/** The names a filter can choose from: people and groups once, models from the period's own break-down by model. */
function useChoices(client: ReportsClient, r: ReportState) {
  const { cfg, range, problem } = r;
  const [people, setPeople] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const wantsPeople = cfg.filters.includes("person");
  const wantsGroups = cfg.filters.includes("group");
  const wantsModels = cfg.filters.includes("model");
  useEffect(() => {
    if (!wantsPeople && !wantsGroups) return;
    let live = true;
    const load = async () => {
      const names: string[] = [];
      let groupNames: string[] = [];
      // 100 a page, a few pages at most: a person missing from the list can still be kept in the saved choice.
      for (let page = 1; page <= 10; page++) {
        const res = await client.get<Paged<{ name: string }> & { groups?: { name: string }[] }>(`/people${query({ page, pageSize: 100 })}`);
        names.push(...res.rows.map((x) => x.name));
        if (page === 1) groupNames = (res.groups ?? []).map((g) => g.name);
        if (names.length >= res.total || res.rows.length === 0) break;
      }
      return { names, groupNames };
    };
    load().then(
      (r) => {
        if (!live) return;
        setPeople(r.names);
        setGroups(r.groupNames);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, wantsPeople, wantsGroups]);
  useEffect(() => {
    if (!wantsModels || problem) return;
    let live = true;
    client
      .get<ReportReply>(`/reports/${cfg.report}${query({ from: range.from, to: range.to, by: cfg.hasBy ? "month" : undefined, breakdown: "model" })}`)
      .then((res) => live && setModels([...new Set(res.rows.map((x) => String(x.key)))].sort((a, b) => a.localeCompare(b))), () => undefined);
    return () => {
      live = false;
    };
  }, [client, wantsModels, problem, cfg.report, cfg.hasBy, range.from, range.to]);
  return { people, groups, models };
}

function NameSelect(props: { label: string; all: string; none: string; value: string; names: string[]; onChange: (v: string) => void }) {
  const id = useId();
  // A saved choice stays selectable while the list is still loading or no longer holds it.
  const names = props.value && !props.names.includes(props.value) ? [props.value, ...props.names] : props.names;
  return (
    <div className="f">
      <label className="lab" htmlFor={id}>
        {props.label}
      </label>
      <select className="field" id={id} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">{props.all}</option>
        <option value="-">{props.none}</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </div>
  );
}

const BUCKET: Record<string, string> = { day: "Days are in", week: "Weeks start Monday, in", month: "Months are in" };

/** What the figures are based on, and how far back the data goes. */
export function basisLine(reply: ReportReply): { zone: string; basis: string } {
  const zone = `${reply.by ? BUCKET[reply.by] : "Times are in"} ${reply.tz} time.`;
  // basedOn is 'rollups', 'rollups and live' or 'admin log'.
  const based = typeof reply.basedOn === "string" ? reply.basedOn : "rollups and live";
  const since = reply.oldestDay ? ` since ${reply.oldestDay}` : "";
  if (based === "admin log") return { zone, basis: `Based on the Admin log${since}.` };
  return { zone, basis: `Based on daily rollups${since}${based === "rollups and live" ? "; today is read live" : ""}.` };
}

/** The partial-history sentence, when the period reaches before the first day Podium has. */
export function partialText(reply: ReportReply): string | null {
  if (!reply.partial) return null;
  if (!reply.oldestDay) return "Podium has no history for this period yet.";
  if (reply.to < reply.oldestDay) return `Podium has no history before ${reply.oldestDay}. This period ends before it, so there is nothing to show.`;
  return `Podium has no history before ${reply.oldestDay}. The figures below cover ${reply.oldestDay > reply.from ? reply.oldestDay : reply.from} to ${reply.to}.`;
}

/** Period and filters: the controls, the partial-history message and the time-zone line. No panel of its own. */
export function ReportFilters({ client, r }: { client: ReportsClient; r: ReportState }) {
  const { cfg, prefs, setPrefs, problem, reply } = r;
  const periodId = useId();
  const fromId = useId();
  const toId = useId();
  const breakId = useId();
  const kindId = useId();
  const choices = useChoices(client, r);
  const partial = reply ? partialText(reply) : null;
  const basis = reply ? basisLine(reply) : null;
  return (
    <>
      <div className="tool">
        <div className="f">
          <label className="lab" htmlFor={periodId}>
            Period
          </label>
          <select className="field" id={periodId} value={prefs.period} onChange={(e) => setPrefs({ period: e.target.value as PeriodId })}>
            {PERIODS.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {prefs.period === "custom" && (
          <>
            <div className="f">
              <label className="lab" htmlFor={fromId}>
                From
              </label>
              <input className="field" id={fromId} type="date" value={prefs.from} onChange={(e) => setPrefs({ from: e.target.value })} />
            </div>
            <div className="f">
              <label className="lab" htmlFor={toId}>
                To
              </label>
              <input className="field" id={toId} type="date" value={prefs.to} onChange={(e) => setPrefs({ to: e.target.value })} />
            </div>
          </>
        )}
        {cfg.hasBy && <Choice label="By" value={prefs.by} options={BYS} onChange={(by) => setPrefs({ by })} />}
        {cfg.breakdowns && (
          <div className="f">
            <label className="lab" htmlFor={breakId}>
              Break down by
            </label>
            <select className="field" id={breakId} value={prefs.breakdown} onChange={(e) => setPrefs({ breakdown: e.target.value })}>
              {cfg.breakdowns.map(([v, name]) => (
                <option key={v} value={v}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        )}
        {cfg.filters.includes("person") && <NameSelect label="Person" all="Everyone" none="No owner" value={prefs.person} names={choices.people} onChange={(person) => setPrefs({ person })} />}
        {cfg.filters.includes("group") && <NameSelect label="Group" all="All groups" none="No group" value={prefs.group} names={choices.groups} onChange={(group) => setPrefs({ group })} />}
        {cfg.filters.includes("model") && <NameSelect label="Model" all="All models" none="Unknown model" value={prefs.model} names={choices.models} onChange={(model) => setPrefs({ model })} />}
        {cfg.kinds && (
          <div className="f">
            <label className="lab" htmlFor={kindId}>
              Kind of entry
            </label>
            <select className="field" id={kindId} value={prefs.kind} onChange={(e) => setPrefs({ kind: e.target.value })}>
              <option value="">All kinds</option>
              {(prefs.kind && !r.kinds.includes(prefs.kind) ? [prefs.kind, ...r.kinds] : r.kinds).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {problem && (
        <div className="err" role="alert">
          {problem}
        </div>
      )}
      {partial && (
        <div className="partial" role="status">
          {partial}
        </div>
      )}
      {reply?.truncated && (
        <div className="partial" role="status">
          Showing the newest 1,000 entries. Narrow the period or filter by kind to see the rest.
        </div>
      )}
      {basis && (
        <div className="note-line">
          <b>{basis.zone}</b> {basis.basis}
        </div>
      )}
    </>
  );
}

/** The bars: one per period, in a neutral ink (hues mean model and status). An unknown period is a gap, not a zero. */
export function ReportChart({ rows, valueKey, column, unit, by }: { rows: ReportRow[]; valueKey: string; column: ReportColumn; unit: string; by?: string }) {
  const points = chartPoints(rows, valueKey);
  if (points.length === 0) return null;
  const known = points.filter((p) => p.value !== null) as { period: string; value: number }[];
  if (known.length === 0) return null;
  const max = Math.max(...known.map((p) => p.value));
  const top = known.find((p) => p.value === max)!;
  const sum = known.reduce((n, p) => n + p.value, 0);
  const fmt = (v: number) => formatCell(column, v);
  const label = `${unit}${by ? ` per ${by}` : ""}: ${points.length} ${points.length === 1 ? "period" : "periods"} from ${points[0]!.period} to ${points[points.length - 1]!.period}, highest ${fmt(max)} on ${top.period}, ${fmt(sum)} in all.`;
  const W = 600;
  const slot = W / points.length;
  const bar = Math.max(1, slot * 0.7);
  const first = points[0]!.period;
  const last = points[points.length - 1]!.period;
  return (
    <div className="chart">
      <div className="plot">
        <div className="yl" aria-hidden="true">
          <span style={{ top: 20 }}>{fmt(max)}</span>
          <span style={{ top: 70 }}>{fmt(max / 2)}</span>
          <span style={{ top: 110 }}>{fmt(0)}</span>
        </div>
        <svg viewBox="0 0 600 120" role="img" aria-label={label} preserveAspectRatio="none">
          <line className="gl" x1="0" x2={W} y1="20" y2="20" />
          <line className="gl" x1="0" x2={W} y1="70" y2="70" />
          <line className="ax" x1="0" x2={W} y1="110" y2="110" />
          {points.map((p, i) =>
            p.value === null ? null : (
              <rect key={p.period} className="rbar" x={i * slot + (slot - bar) / 2} y={110 - (max > 0 ? (p.value / max) * 90 : 0)} width={bar} height={max > 0 ? (p.value / max) * 90 : 0} />
            ),
          )}
        </svg>
      </div>
      <div className="xl" aria-hidden="true">
        <span>{first}</span>
        {last !== first && <span>{last}</span>}
      </div>
      <div className="hint" aria-hidden="true">
        {first} to {last}. Highest: {fmt(max)}.
      </div>
    </div>
  );
}

const OLDER = "Older than 30 days";

/** A failure row's links to History for the sessions it counts, while those sessions are still stored. */
function historyHref(period: unknown, id: string): string {
  const p = typeof period === "string" ? period : "";
  const day = /^\d{4}-\d{2}$/.test(p) ? `${p}-01` : p;
  return `#/history?day=${encodeURIComponent(day)}&page=1&size=50&open=${encodeURIComponent(id)}`;
}
function HistoryLinks({ row }: { row: ReportRow }) {
  const ids = Array.isArray(row.sessionIds) ? row.sessionIds : [];
  if (ids.length === 0) return <span className="muted">{OLDER}</span>;
  return (
    <span className="hlinks">
      {ids.map((id, i) => (
        <a key={id} className="klink" href={historyHref(row.period, id)} aria-label={ids.length === 1 ? "Open in History" : `Open session ${i + 1} of ${ids.length} in History`}>
          {ids.length === 1 ? "Open" : i + 1}
        </a>
      ))}
    </span>
  );
}

/** An empty owner, group, model or project is "-" in a key; it reads as what it is. */
export const NONE_LABEL: Record<string, string> = { person: "No owner", group: "No group", model: "Unknown model", project: "No project" };
export function keyText(v: unknown, breakdown: string): unknown {
  return v === "-" ? (NONE_LABEL[breakdown] ?? "None") : v;
}

const STATE_WORD: Record<string, [string, string]> = { active: ["Active", "reporting"], quiet: ["Quiet", "silent"], never: ["Never reported", "restart"] };

function Cell({ col, row, sample, breakdown }: { col: ReportColumn; row: ReportRow; sample: unknown; breakdown: string }) {
  const v = col.key === "key" ? keyText(row[col.key], breakdown) : row[col.key];
  if (col.key === "state" && typeof v === "string" && STATE_WORD[v]) {
    const [word, cls] = STATE_WORD[v]!;
    return (
      <td>
        <span className={`rstate ${cls}`}>
          <span className={`rdot ${cls}`} aria-hidden="true" />
          {word}
        </span>
      </td>
    );
  }
  if (isNumericColumn(col, sample)) return <td className={`n mono${v === null || v === undefined ? " muted" : ""}`}>{formatCell(col, v)}</td>;
  if (col.key === "period" || col.key === "key" || col.key === "person") return <td className="who">{formatCell(col, v)}</td>;
  const time = col.key === "t" || /At$/.test(col.key);
  return <td className={time ? "mono muted nowrap" : v === null || v === undefined ? "muted" : undefined}>{formatCell(col, v)}</td>;
}

export function ReportTable({ reply, label, page, pageSize, history, breakdown = "" }: { reply: ReportReply; label: string; page: number; pageSize: number; history: boolean; breakdown?: string }) {
  const cols = reply.columns;
  const shown = reply.rows.slice((page - 1) * pageSize, page * pageSize);
  const sample = (key: string) => reply.rows.find((x) => x[key] !== null && x[key] !== undefined)?.[key];
  const total = reply.total && typeof reply.total === "object" ? reply.total : null;
  return (
    <div className="tw2">
      <table className="ptab" aria-label={label}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} scope="col" className={isNumericColumn(c, sample(c.key)) ? "n" : undefined}>
                {c.label}
              </th>
            ))}
            {history && <th scope="col">History</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={`${(page - 1) * pageSize + i}`}>
              {cols.map((c) => (
                <Cell key={c.key} col={c} row={row} sample={sample(c.key)} breakdown={breakdown} />
              ))}
              {history && (
                <td>
                  <HistoryLinks row={row} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot>
            <tr>
              <th scope="row">{cols[0]?.key === "period" ? "Whole period" : "Total"}</th>
              {cols.slice(1).map((c) => (
                <td key={c.key} className={isNumericColumn(c, sample(c.key)) ? "n mono" : undefined}>
                  {total[c.key] === undefined ? "" : formatCell(c, total[c.key])}
                </td>
              ))}
              {history && <td />}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function Versions({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="f cut">
      <span className="lab">{title}</span>
      <div className="mono">
        {entries.length === 0 ? (
          <span className="muted">None</span>
        ) : (
          entries.map(([v, n]) => (
            <div key={v}>
              {v} <b>{n}</b>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** The panel's contents for a loaded report. */
export function ReportBody({ r }: { r: ReportState }) {
  const { cfg, reply, page, prefs } = r;
  if (r.problem) return <div className="empty">Fix the period above to see the report.</div>;
  if (r.error) {
    return (
      <div className="err" role="alert">
        {r.error}{" "}
        <button type="button" className="btn sm" onClick={r.reload}>
          Try again
        </button>
      </div>
    );
  }
  if (!reply) return <div className="empty">Loading…</div>;
  const col = (key: string): ReportColumn => reply.columns.find((c) => c.key === key) ?? { key, label: key };
  const total = reply.total && typeof reply.total === "object" ? reply.total : null;
  const summary = reply.summary
    ? [
        { key: "people", caption: "people", value: reply.summary.people },
        { key: "groups", caption: "groups", value: reply.summary.groups },
        { key: "reporters", caption: "reporters", value: reply.summary.reporters },
      ]
    : total
      ? cfg.summary.filter((s) => total[s.key] !== undefined).map((s) => ({ ...s, value: total[s.key] }))
      : [];
  const empty = reply.rows.length === 0;
  return (
    <>
      {summary.length > 0 && !empty && (
        <div className="tool alone">
          <div className="sum left">
            {summary.map((s) => (
              <div key={s.key}>
                <span className="big mono">{formatCell(col(s.key), s.value)}</span>
                <span className="cap">{s.caption}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {reply.summary && (
        <div className="tool alone cuts">
          <Versions title="Reporter versions" counts={reply.summary.reporterVersions} />
          <Versions title="Engine versions" counts={reply.summary.engineVersions} />
        </div>
      )}
      {cfg.chart && !empty && <ReportChart rows={reply.rows} valueKey={cfg.chart.key} column={col(cfg.chart.key)} unit={cfg.chart.unit} by={reply.by} />}
      {empty ? (
        // A partial period already said why above; the empty line is for a period Podium covers and found nothing in.
        !reply.partial && <div className="empty">Nothing was recorded in this period.</div>
      ) : (
        <ReportTable reply={reply} label={cfg.title} page={page} pageSize={prefs.pageSize} history={cfg.report === "failures"} breakdown={prefs.breakdown} />
      )}
      {!empty && <Pager id={`rep-${cfg.report}`} page={page} pageSize={prefs.pageSize} total={reply.rows.length} onPage={r.setPage} onSize={(pageSize) => r.setPrefs({ pageSize })} />}
    </>
  );
}
