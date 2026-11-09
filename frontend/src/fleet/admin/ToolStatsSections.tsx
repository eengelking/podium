// The three sections of Admin > Reporting > Tools that say what tools did beyond being called (#721, mockup/podium-admin-reporting-tool-failures.html):
// their failure rate, the permission prompts they raised and how long they took, for every harness. Counts and names only. Tool, server and harness
// names come from reporters and are drawn as text nodes.
import { Fragment, useMemo, useState } from "react";
import { Panel, Section } from "./Page";
import { Pager } from "./Pager";
import { historyHref, OLDER } from "./ReportParts";
import { formatCell, harnessName, type ReportReply, type ReportRow } from "./reportsApi";
import type { ReportState } from "./useReport";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const COUNT = { key: "n", label: "", unit: "count" } as const;
const fig = (n: number): string => formatCell(COUNT, n);
/** A share in percent to one decimal place, or a dash when there is nothing to divide by. */
const rate = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "–");
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** How long a call took, as a person reads it: 40 ms, 1.8 s, 4 min 12 s. */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${Number(s.toFixed(1))} s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/** A tool, or an MCP server with the tools under it, with each figure of a breakdown added up over the whole period and every harness. */
export interface ToolSum {
  key: string;
  name: string;
  server: string;
  n: Record<string, number>;
  /** The stored sessions a failure of this tool was recorded in, to open in History, and how many there are in all. */
  links: { period: string; id: string }[];
  stored: number;
  tools: ToolSum[];
}

/** The rows of a breakdown added up by tool, an MCP server's tools under it; the most of `order` first, then the most calls, then by name. */
export function sumByTool(rows: ReportRow[], fields: string[], order: string): ToolSum[] {
  const top = new Map<string, ToolSum>();
  const make = (key: string, name: string, server: string): ToolSum => ({ key, name, server, n: Object.fromEntries(fields.map((f) => [f, 0])), links: [], stored: 0, tools: [] });
  const add = (e: ToolSum, row: ReportRow): void => {
    for (const f of fields) e.n[f] = (e.n[f] ?? 0) + num(row[f]);
    e.stored += num(row.stored);
    for (const id of Array.isArray(row.sessionIds) ? row.sessionIds : []) if (e.links.length < 10 && typeof id === "string") e.links.push({ period: text(row.period), id });
  };
  for (const row of rows) {
    const server = text(row.server);
    const tool = text(row.tool);
    if (server === "") {
      const e = top.get(`t:${tool}`) ?? make(`t:${tool}`, tool, "");
      add(e, row);
      top.set(e.key, e);
      continue;
    }
    const s = top.get(`s:${server}`) ?? make(`s:${server}`, server, server);
    for (const f of fields) s.n[f] = (s.n[f] ?? 0) + num(row[f]);
    top.set(s.key, s);
    let child = s.tools.find((c) => c.name === tool);
    if (!child) s.tools.push((child = make(`${s.key}/${tool}`, tool, server)));
    add(child, row);
  }
  const order2 = (a: ToolSum, b: ToolSum) => (b.n[order] ?? 0) - (a.n[order] ?? 0) || (b.n.calls ?? 0) - (a.n.calls ?? 0) || byName(a.name, b.name);
  const list = [...top.values()].sort(order2);
  for (const e of list) e.tools.sort(order2);
  return list;
}

function Chevron() {
  return (
    <svg className="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 2l4 4-4 4" />
    </svg>
  );
}

const ServerNote = ({ tools }: { tools?: number }) => <span className="srvnote"> {tools === undefined ? "MCP server" : `MCP server, ${tools} ${tools === 1 ? "tool" : "tools"}`}</span>;

/** The cell that opens a failure's sessions in History while they are stored, and otherwise says why it cannot. */
function HistoryCell({ e, failed, older }: { e: ToolSum; failed: number; older: boolean }) {
  if (failed === 0) return <td className="muted">–</td>;
  if (e.links.length > 0) {
    return (
      <td>
        <span className="hlinks">
          {e.links.map((l, i) => (
            <a key={`${l.period}/${l.id}`} className="klink" href={historyHref(l.period, l.id)} aria-label={e.links.length === 1 ? "Open in History" : `Open session ${i + 1} of ${e.links.length} in History`}>
              {e.links.length === 1 ? "Open" : i + 1}
            </a>
          ))}
        </span>
      </td>
    );
  }
  // Failures were recorded, but the viewer may open none of the sessions: the counts are all there is.
  if (e.stored > 0) return <td className="muted">Counts only</td>;
  return <td className="muted">{older ? OLDER : "None in History"}</td>;
}

/** The first day History still holds sessions for: 30 days back, with a day over for the one in progress. */
function historyFloor(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 31);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function FailuresSection({ r, reply }: { r: ReportState; reply: ReportReply }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const entries = useMemo(() => sumByTool(reply.rows, ["calls", "failed"], "failed"), [reply.rows]);
  const calls = num(reply.total?.calls);
  const failed = num(reply.total?.failed);
  const top = entries[0];
  const older = reply.to < historyFloor();
  const { page, prefs } = r;
  const shown = entries.slice((page - 1) * prefs.pageSize, page * prefs.pageSize);
  const max = Math.max(1, ...entries.map((e) => e.n.failed ?? 0));
  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const label = (e: ToolSum) => (
    <>
      <span className="mono">{e.name}</span>
      {e.server !== "" && <ServerNote />}
    </>
  );
  return (
    <>
      <div className="tool alone">
        <div className="sum left">
          <div>
            <span className="big mono">{fig(failed)}</span>
            <span className="cap">failed calls</span>
          </div>
          <div>
            <span className="big mono">{rate(failed, calls)}</span>
            <span className="cap">of {fig(calls)} calls</span>
          </div>
          {top && (top.n.failed ?? 0) > 0 && (
            <div>
              <span className="big mono">{rate(top.n.failed ?? 0, top.n.calls ?? 0)}</span>
              <span className="cap">
                {top.name}, the most failures: {fig(top.n.failed ?? 0)} of {fig(top.n.calls ?? 0)}
              </span>
            </div>
          )}
        </div>
      </div>
      {failed > 0 && (
        <ul className="hb" aria-label="Failed calls by tool, most first">
          {entries
            .filter((e) => (e.n.failed ?? 0) > 0)
            .slice(0, 5)
            .map((e) => (
              <li key={e.key} aria-label={`${e.name}, ${fig(e.n.failed ?? 0)} failed of ${fig(e.n.calls ?? 0)} calls, ${rate(e.n.failed ?? 0, e.n.calls ?? 0)}`}>
                <span className="lbl">{label(e)}</span>
                <span className="trk" aria-hidden="true">
                  <i style={{ width: `${Math.max(1.5, ((e.n.failed ?? 0) / max) * 100)}%` }} />
                </span>
                <span className="val mono" aria-hidden="true">
                  {fig(e.n.failed ?? 0)}
                </span>
                <span className="shr mono" aria-hidden="true">
                  {rate(e.n.failed ?? 0, e.n.calls ?? 0)}
                </span>
              </li>
            ))}
        </ul>
      )}
      <div className="tw2">
        <table className="ptab" aria-label="Failures by tool">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col" className="n">
                Calls
              </th>
              <th scope="col" className="n">
                Failures
              </th>
              <th scope="col" className="n">
                Failure rate
              </th>
              <th scope="col">History</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => {
              const figures = (x: ToolSum) => (
                <>
                  <td className="n mono">{fig(x.n.calls ?? 0)}</td>
                  <td className="n mono">{fig(x.n.failed ?? 0)}</td>
                  <td className="n mono">{rate(x.n.failed ?? 0, x.n.calls ?? 0)}</td>
                </>
              );
              if (e.server === "") {
                return (
                  <tr key={e.key}>
                    <td className="who mono">{e.name}</td>
                    {figures(e)}
                    <HistoryCell e={e} failed={e.n.failed ?? 0} older={older} />
                  </tr>
                );
              }
              return (
                <Fragment key={e.key}>
                  <tr>
                    <td className="who">
                      <button type="button" className="rowbtn" aria-expanded={open.has(e.key)} aria-controls={`fail-${e.name}`} onClick={() => toggle(e.key)}>
                        <Chevron />
                        <span className="mono">{e.name}</span>
                        <ServerNote tools={e.tools.length} />
                      </button>
                    </td>
                    {figures(e)}
                    <td />
                  </tr>
                  {open.has(e.key) &&
                    e.tools.map((t) => (
                      <tr key={t.key} id={`fail-${e.name}`} className="mtool">
                        <td className="mono">{t.name}</td>
                        {figures(t)}
                        <HistoryCell e={t} failed={t.n.failed ?? 0} older={older} />
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="n mono">{fig(calls)}</td>
              <td className="n mono">{fig(failed)}</td>
              <td className="n mono">{rate(failed, calls)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="note-line">
        Sorted by failures. <b>Open</b> lists the failures in History, which keeps sessions for 30 days; an older one has counts only. A person without access to a session sees counts and no link. Failures by class, person and cause stay on the Failures page.
      </div>
      <Pager id="rep-tools-fail" page={page} pageSize={prefs.pageSize} total={entries.length} onPage={r.setPage} onSize={(pageSize) => r.setPrefs({ pageSize })} />
    </>
  );
}

export function PromptsSection({ reply }: { reply: ReportReply }) {
  const entries = useMemo(() => sumByTool(reply.rows.map((x) => ({ ...x, server: text(x.server) })), ["calls", "asked", "allowed", "denied", "noAnswer", "podium"], "asked"), [reply.rows]);
  const t = reply.total ?? {};
  const asked = num(t.asked);
  return (
    <>
      <div className="tool alone">
        <div className="sum left">
          <div>
            <span className="big mono">{fig(asked)}</span>
            <span className="cap">asks, {rate(asked, num(t.calls))} of calls</span>
          </div>
          <div>
            <span className="big mono">{fig(num(t.allowed))}</span>
            <span className="cap">allowed</span>
          </div>
          <div>
            <span className="big mono">{fig(num(t.denied))}</span>
            <span className="cap">denied</span>
          </div>
          <div>
            <span className="big mono">{fig(num(t.podium))}</span>
            <span className="cap">answered in Podium</span>
          </div>
        </div>
      </div>
      <div className="tw2">
        <table className="ptab" aria-label="Permission prompts by tool">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              {["Asked", "Of its calls", "Allowed", "Denied", "No answer", "Answered in Podium"].map((h) => (
                <th key={h} scope="col" className="n">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.key}>
                <td className="who">
                  <span className="mono">{e.name}</span>
                  {e.server !== "" && <ServerNote />}
                </td>
                <td className="n mono">{fig(e.n.asked ?? 0)}</td>
                <td className="n mono">{rate(e.n.asked ?? 0, e.n.calls ?? 0)}</td>
                <td className="n mono">{fig(e.n.allowed ?? 0)}</td>
                <td className="n mono">{fig(e.n.denied ?? 0)}</td>
                <td className="n mono">{fig(e.n.noAnswer ?? 0)}</td>
                <td className="n mono">{fig(e.n.podium ?? 0)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="n mono">{fig(asked)}</td>
              <td className="n mono">{rate(asked, num(t.calls))}</td>
              <td className="n mono">{fig(num(t.allowed))}</td>
              <td className="n mono">{fig(num(t.denied))}</td>
              <td className="n mono">{fig(num(t.noAnswer))}</td>
              <td className="n mono">{fig(num(t.podium))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="note-line">
        Allowed, Denied and No answer add up to Asked. <b>Answered in Podium</b> counts the asks answered from the console, whether allowed or denied; the rest were answered in the terminal. No answer means the session ended or the ask was withdrawn first. A tool a person has already allowed does not ask, so it is not counted.
      </div>
    </>
  );
}

export function DurationSection({ reply }: { reply: ReportReply }) {
  const rows: ReportRow[] = reply.byTool ?? [];
  const t = reply.total ?? {};
  const timedBy = reply.timedHarnesses ?? [];
  const every = reply.harnesses ?? [];
  const left = every.filter((h) => !timedBy.includes(h));
  const note =
    left.length === 0 ? null : (
      <div className="note-line">
        <b>{timedBy.map(harnessName).join(" and ")} only.</b> Times come from {timedBy.map(harnessName).join(" and ")}. {left.map(harnessName).join(" and ")} {left.length === 1 ? "does" : "do"} not report call times, so {left.length === 1 ? "its" : "their"} calls are left out and Calls timed is lower than Calls. A Task call lasts as long as the agent it launches.
      </div>
    );
  return (
    <>
      {note}
      <div className="tw2">
        <table className="ptab" aria-label="Call duration by tool">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col" className="n">
                Calls timed
              </th>
              <th scope="col" className="n">
                Median
              </th>
              <th scope="col" className="n">
                95th percentile
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={`${text(x.server)}/${text(x.tool)}`}>
                <td className="who">
                  <span className="mono">{text(x.tool) || text(x.server)}</span>
                  {text(x.tool) === "" && <ServerNote />}
                  {text(x.tool) !== "" && text(x.server) !== "" && <span className="srvnote"> {text(x.server)}</span>}
                </td>
                <td className="n mono">{fig(num(x.timed))}</td>
                <td className="n mono">{fmtMs(num(x.p50Ms))}</td>
                <td className="n mono">{fmtMs(num(x.p95Ms))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">All timed calls</th>
              <td className="n mono">{fig(num(t.timed))}</td>
              <td className="n mono">{fmtMs(num(t.p50Ms))}</td>
              <td className="n mono">{fmtMs(num(t.p95Ms))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="note-line">Medians and percentiles come from calls grouped by length, so they can be a little off for long calls.</div>
    </>
  );
}

/** A section of the Tools page with the same heading, help and panel as the others. */
export function ToolSection({ id, title, help, children }: { id: string; title: string; help: string; children: React.ReactNode }) {
  return (
    <Section id={id} title={title} help={help}>
      <Panel>{children}</Panel>
    </Section>
  );
}
