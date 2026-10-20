// Admin > Spend today (#239): today's estimated spend by person or by group, as bars or a table, paged with Admin's pager.
// The numbers are the fleet stream's (`kpis.costTodayByOwner` and the live sessions), the same rule as "Est. cost today":
// what was spent since midnight on the server, live or ended sessions. Bars are a neutral ink, never a hue, because hues
// mean model and status in Podium. The pager only slices rows in the browser; the total and the live count cover everyone.
// A row is a button that opens what the figure is made of (#482, SpendBreakdown.tsx).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Monogram } from "../components/People";
import { fmtUsd } from "../format";
import { sharePct, spendRows, type SpendRow } from "../people";
import { readJson, writeJson } from "../storage";
import { useFleet, type UseFleetOptions } from "../useFleet";
import { Pager, PAGE_SIZES } from "./Pager";
import { Choice, Panel, Section } from "./Page";
import type { ReportsClient } from "./reportsApi";
import { SpendBreakdown, type OpenBreakdown } from "./SpendBreakdown";

export const SPEND_KEY = "podium.adminSpend";
type By = "people" | "group";
type View = "chart" | "table";
interface Prefs {
  groupBy: By;
  view: View;
  pageSize: number;
}
const DEFAULTS: Prefs = { groupBy: "people", view: "chart", pageSize: PAGE_SIZES[0]! };

/** Stored choices, with anything unreadable or unknown replaced by its default. */
export function parseSpendPrefs(v: unknown): Prefs {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    groupBy: o.groupBy === "group" ? "group" : "people",
    view: o.view === "table" ? "table" : "chart",
    pageSize: PAGE_SIZES.includes(o.pageSize as number) ? (o.pageSize as number) : DEFAULTS.pageSize,
  };
}

/** The breakdown a row opens, or null for a row that has none (the No group row holds people from several groups). */
export function breakdownFor(r: SpendRow): OpenBreakdown | null {
  switch (r.kind) {
    case "person":
    case "admin":
      return { key: r.key, owner: r.name, group: false, label: r.name };
    case "unassigned":
      return { key: r.key, owner: "-", group: false, label: "Unassigned" };
    case "group":
      return { key: r.key, owner: r.name, group: true, label: r.name };
    default:
      return null;
  }
}

export function SpendTab(props: { fleetOptions?: UseFleetOptions; onCount: (n: number) => void; client: ReportsClient; onLocked: () => void }) {
  const { onCount } = props;
  const fleet = useFleet(props.fleetOptions);
  const [open, setOpen] = useState<OpenBreakdown | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const toggle = (r: SpendRow) => {
    const next = breakdownFor(r);
    if (next) setOpen(open?.key === r.key ? null : next);
  };
  const close = () => {
    const back = open ? buttons.current.get(open.key) : undefined;
    setOpen(null);
    back?.focus();
  };
  /** A row's name as a button when it has a breakdown, else plain text. */
  const rowButton = (r: SpendRow, children: ReactNode) =>
    breakdownFor(r) ? (
      <button
        type="button"
        className="lbl rowbtn"
        aria-expanded={open?.key === r.key}
        aria-controls={open?.key === r.key ? "spend-bd" : undefined}
        ref={(el) => {
          if (el) buttons.current.set(r.key, el);
          else buttons.current.delete(r.key);
        }}
        onClick={() => toggle(r)}
      >
        {children}
      </button>
    ) : (
      <span className="lbl">{children}</span>
    );
  const [prefs, setPrefsState] = useState<Prefs>(() => parseSpendPrefs(readJson<unknown>(SPEND_KEY, null)));
  const [page, setPage] = useState(1);
  const setPrefs = (p: Partial<Prefs>) => {
    const next = { ...prefs, ...p };
    setPrefsState(next);
    writeJson(SPEND_KEY, next);
    // Chart or Table shows the same rows, so it keeps the page; a new grouping or page size starts over.
    if (!("view" in p)) setPage(1);
    // A breakdown belongs to a row of the grouping it was opened in.
    if ("groupBy" in p) setOpen(null);
  };
  const byGroup = prefs.groupBy === "group";
  const live = useMemo(() => Object.values(fleet.sessions).filter((s) => !fleet.leaving[s.id]), [fleet.sessions, fleet.leaving]);
  const rows = useMemo(() => spendRows(fleet.kpis?.costTodayByOwner ?? [], live, prefs.groupBy), [fleet.kpis, live, prefs.groupBy]);
  useEffect(() => onCount(rows.length), [onCount, rows.length]);

  const total = rows.reduce((n, r) => n + r.spend, 0);
  const liveCount = rows.reduce((n, r) => n + r.sessions, 0);
  const pages = Math.max(1, Math.ceil(rows.length / prefs.pageSize));
  const at = Math.min(page, pages);
  const shown = rows.slice((at - 1) * prefs.pageSize, at * prefs.pageSize);
  const max = rows.reduce((m, r) => Math.max(m, r.spend), 0);
  const unit = byGroup ? "group" : "person";
  const title = `Spend today, by ${unit}`;
  const detail = (r: SpendRow) => `${r.name}: ${fmtUsd(r.spend)}, ${sharePct(r.spend, total)}% of ${fmtUsd(total)}`;

  const section = (
    <Section id="admin-spend-h" title={title}>
      <Panel>
        <div className="tool">
          <Choice label="Group by" value={prefs.groupBy} options={[["people", "People"], ["group", "Groups"]]} onChange={(groupBy) => setPrefs({ groupBy })} />
          <Choice label="Show as" value={prefs.view} options={[["chart", "Chart"], ["table", "Table"]]} onChange={(view) => setPrefs({ view })} />
          <div className="sum">
            <div>
              <span className="big mono">{fmtUsd(total)}</span>
              <span className="cap">
                spent today, all {rows.length} {byGroup ? "groups" : "people"}
              </span>
            </div>
            <div>
              <span className="big mono">{liveCount}</span>
              <span className="cap">live sessions</span>
            </div>
          </div>
        </div>
        {!rows.length ? (
          <div className="empty">{fleet.kpis ? "Nothing spent yet today." : "Waiting for the first update from the server."}</div>
        ) : prefs.view === "table" ? (
          <div className="tw2">
            <table className="ptab" aria-label={title}>
              <thead>
                <tr>
                  <th scope="col">{byGroup ? "Group" : "Person"}</th>
                  {!byGroup && <th scope="col">Group</th>}
                  <th scope="col" className="n">
                    Live
                  </th>
                  <th scope="col" className="n">
                    Spend
                  </th>
                  <th scope="col" className="n">
                    Share
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.key}>
                    <td className="who">{rowButton(r, r.name)}</td>
                    {!byGroup && <td className={r.group ? undefined : "muted"}>{r.group ?? "No group"}</td>}
                    <td className="n mono">{r.sessions}</td>
                    <td className="n mono">{fmtUsd(r.spend)}</td>
                    <td className="n mono">{sharePct(r.spend, total)}%</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  {!byGroup && <td />}
                  <td className="n mono">{liveCount}</td>
                  <td className="n mono">{fmtUsd(total)}</td>
                  <td className="n mono">{total > 0 ? "100%" : "0%"}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <ul className="hb" aria-label={title}>
            {shown.map((r) => (
              <li key={r.key} aria-label={detail(r)}>
                {rowButton(
                  r,
                  <>
                    <Monogram name={r.name} kind={r.kind} />
                    <span>
                      {r.name}
                      {r.group && <span className="gp"> {r.group}</span>}
                    </span>
                  </>,
                )}
                <span className="trk" aria-hidden="true">
                  <i style={{ width: `${max > 0 ? Math.max(1.5, (r.spend / max) * 100) : 0}%` }} />
                </span>
                <span className="val mono" aria-hidden="true">
                  {fmtUsd(r.spend)}
                </span>
                <span className="shr mono" aria-hidden="true">
                  {sharePct(r.spend, total)}%
                </span>
              </li>
            ))}
          </ul>
        )}
        <Pager id="admin-spend" page={at} pageSize={prefs.pageSize} total={rows.length} onPage={setPage} onSize={(pageSize) => setPrefs({ pageSize })} />
      </Panel>
    </Section>
  );
  return (
    <>
      {section}
      {open && (
        <SpendBreakdown
          client={props.client}
          open={open}
          onClose={close}
          onOpenPerson={(owner) => setOpen({ key: `p:${owner}`, owner, group: false, label: owner === "-" ? "Unassigned" : owner })}
          onLocked={props.onLocked}
        />
      )}
    </>
  );
}
