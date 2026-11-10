// Admin > Reporting > Tools (#720, mockup/podium-admin-reporting-tools.html): which tools sessions call, how many calls a session makes,
// and which harness versions are in use, for every harness. One query drives the page: the period, the grouping and the harness filter
// give the calls by tool (the report the Export downloads), and the same query asks for the calls per session and the versions.
// Names of tools, servers and harnesses come from reporters and are drawn as text nodes.
import { ToolCostSections } from "./CostSections";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AdminError } from "./adminApi";
import { PageHeader, Panel, Section } from "./Page";
import { Pager } from "./Pager";
import { ReportChart, ReportExport, ReportFilters } from "./ReportParts";
import { resultsHeading } from "./ReportPages";
import { formatCell, harnessName, reportErrorText, type ReportReply, type ReportRow, type ReportsClient } from "./reportsApi";
import { useReport, type ReportConfig, type ReportState } from "./useReport";
import { DurationSection, FailuresSection, PromptsSection, ToolSection } from "./ToolStatsSections";

/** One more answer of the same report (calls per session, versions) for the period and filters the page has. */
function useBreakdown(client: ReportsClient, r: ReportState, breakdown: "session" | "version" | "failures" | "prompts" | "duration", onLocked: () => void): { reply: ReportReply | null; error: string | null } {
  const [state, setState] = useState<{ reply: ReportReply | null; error: string | null }>({ reply: null, error: null });
  const path = r.path === null ? null : `${r.path}${r.path.includes("?") ? "&" : "?"}breakdown=${breakdown}`;
  const lock = useRef(onLocked);
  lock.current = onLocked;
  useEffect(() => {
    if (path === null) {
      setState({ reply: null, error: null });
      return;
    }
    let live = true;
    setState({ reply: null, error: null });
    client.get<ReportReply>(path).then(
      (reply) => live && setState({ reply, error: null }),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof AdminError && e.status === 401) lock.current();
        else setState({ reply: null, error: reportErrorText(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [client, path]);
  return state;
}

interface Entry {
  key: string;
  name: string;
  server: string;
  perHarness: Map<string, number>;
  total: number;
  tools: Entry[];
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
/** Ids and ISO periods compared by code unit, the order the server answers in. */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The rows of the calls-by-tool reply, added up over the whole period: each tool, and each MCP server with the tools under it. */
export function toolEntries(rows: ReportRow[]): Entry[] {
  const top = new Map<string, Entry>();
  const make = (key: string, name: string, server: string): Entry => ({ key, name, server, perHarness: new Map(), total: 0, tools: [] });
  const add = (e: Entry, harness: string, calls: number) => {
    e.perHarness.set(harness, (e.perHarness.get(harness) ?? 0) + calls);
    e.total += calls;
  };
  for (const row of rows) {
    const server = typeof row.server === "string" ? row.server : "";
    const tool = String(row.tool);
    const harness = String(row.harness);
    const calls = num(row.calls);
    if (server === "") {
      const e = top.get(`t:${tool}`) ?? make(`t:${tool}`, tool, "");
      add(e, harness, calls);
      top.set(e.key, e);
      continue;
    }
    const s = top.get(`s:${server}`) ?? make(`s:${server}`, server, server);
    add(s, harness, calls);
    top.set(s.key, s);
    let child = s.tools.find((c) => c.name === tool);
    if (!child) s.tools.push((child = make(`${s.key}/${tool}`, tool, server)));
    add(child, harness, calls);
  }
  const byCalls = (a: Entry, b: Entry) => b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const list = [...top.values()].sort(byCalls);
  for (const e of list) e.tools.sort(byCalls);
  return list;
}

const percent = (n: number, whole: number): string => (whole > 0 ? `${((n / whole) * 100).toFixed(1)}%` : "–");

function ToolTable({ r, reply }: { r: ReportState; reply: ReportReply }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const entries = useMemo(() => toolEntries(reply.rows), [reply.rows]);
  const harnesses = useMemo(() => [...new Set(reply.rows.map((x) => String(x.harness)))].sort(byCode), [reply.rows]);
  const grand = num(reply.total?.calls);
  const { page, prefs } = r;
  const shown = entries.slice((page - 1) * prefs.pageSize, page * prefs.pageSize);
  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const perHarness = (e: Entry) => harnesses.map((h) => <td key={h} className="n mono">{formatCell({ key: "calls", label: "", unit: "count" }, e.perHarness.get(h) ?? 0)}</td>);
  const figure = (n: number) => formatCell({ key: "calls", label: "", unit: "count" }, n);
  const harnessTotals = harnesses.map((h) => entries.reduce((n, e) => n + (e.perHarness.get(h) ?? 0), 0));
  return (
    <>
      <div className="tw2">
        <table className="ptab" aria-label="Calls by tool">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              {harnesses.map((h) => (
                <th key={h} scope="col" className="n">
                  {harnessName(h)}
                </th>
              ))}
              <th scope="col" className="n">
                Calls
              </th>
              <th scope="col" className="n">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) =>
              e.server === "" ? (
                <tr key={e.key}>
                  <td className="who mono">{e.name}</td>
                  {perHarness(e)}
                  <td className="n mono">{figure(e.total)}</td>
                  <td className="n mono">{percent(e.total, grand)}</td>
                </tr>
              ) : (
                <Fragment key={e.key}>
                  <tr>
                    <td className="who">
                      <button type="button" className="rowbtn" aria-expanded={open.has(e.key)} aria-controls={`tools-${e.name}`} onClick={() => toggle(e.key)}>
                        <svg className="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 2l4 4-4 4" />
                        </svg>
                        <span className="mono">{e.name}</span>
                        <span className="srvnote"> MCP server, {e.tools.length} {e.tools.length === 1 ? "tool" : "tools"}</span>
                      </button>
                    </td>
                    {perHarness(e)}
                    <td className="n mono">{figure(e.total)}</td>
                    <td className="n mono">{percent(e.total, grand)}</td>
                  </tr>
                  {open.has(e.key) &&
                    e.tools.map((t) => (
                      <tr key={t.key} id={`tools-${e.name}`} className="mtool">
                        <td className="mono">{t.name}</td>
                        {perHarness(t)}
                        <td className="n mono">{figure(t.total)}</td>
                        <td className="n mono">{percent(t.total, grand)}</td>
                      </tr>
                    ))}
                </Fragment>
              ),
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {harnessTotals.map((n, i) => (
                <td key={harnesses[i]} className="n mono">
                  {figure(n)}
                </td>
              ))}
              <td className="n mono">{figure(grand)}</td>
              <td className="n mono">100%</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager id="rep-tools" page={page} pageSize={prefs.pageSize} total={entries.length} onPage={r.setPage} onSize={(pageSize) => r.setPrefs({ pageSize })} />
    </>
  );
}

function SessionTable({ reply, harness }: { reply: ReportReply; harness: string }) {
  const total = reply.total ?? {};
  const rows = reply.rows;
  const fig = (v: unknown) => formatCell({ key: "n", label: "", unit: "count" }, v);
  return (
    <>
      <div className="tw2">
        <table className="ptab" aria-label="Calls per session">
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col" className="n">
                Sessions
              </th>
              <th scope="col" className="n">
                Median
              </th>
              <th scope="col" className="n">
                90th percentile
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={`${x.period}-${x.harness}`}>
                <td className="who">{harness === "" ? `${String(x.period)}, ${harnessName(String(x.harness))}` : String(x.period)}</td>
                <td className="n mono">{fig(x.sessions)}</td>
                <td className="n mono">{fig(x.median)}</td>
                <td className="n mono">{fig(x.p90)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Whole period{harness === "" ? ", all harnesses" : `, ${harnessName(harness)}`}</th>
              <td className="n mono">{fig(total.sessions)}</td>
              <td className="n mono">{fig(total.median)}</td>
              <td className="n mono">{fig(total.p90)}</td>
            </tr>
            {harness === "" &&
              (reply.byHarness ?? []).map((h) => (
                <tr key={h.harness}>
                  <th scope="row">{harnessName(h.harness)}</th>
                  <td className="n mono">{fig(h.sessions)}</td>
                  <td className="n mono">{fig(h.median)}</td>
                  <td className="n mono">{fig(h.p90)}</td>
                </tr>
              ))}
          </tfoot>
        </table>
      </div>
      <div className="note-line">Medians and percentiles come from sessions grouped by number of calls, so they can be a few calls off for sessions above 100 calls.</div>
    </>
  );
}

function VersionTable({ reply }: { reply: ReportReply }) {
  const periods = [...new Set(reply.rows.map((x) => String(x.period)))].sort(byCode);
  const lines = [...new Set(reply.rows.map((x) => `${x.harness}\u0000${x.version}`))].map((k) => k.split("\u0000") as [string, string]);
  const at = (h: string, v: string, p: string) => reply.rows.find((x) => x.harness === h && x.version === v && x.period === p);
  const newest = (h: string, v: string) => reply.rows.some((x) => x.harness === h && x.version === v && x.newest === "Newest seen");
  return (
    <>
      <div className="tool alone">
        <div className="sum left">
          {(reply.behind ?? []).map((b) => (
            <div key={b.harness}>
              <span className="big mono">
                {b.behind} of {b.reporters}
              </span>
              <span className="cap">
                {harnessName(b.harness)} reporters older than {b.newest}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="tw2">
        <table className="ptab" aria-label="Reporters by harness version and period">
          <thead>
            <tr>
              <th scope="col">Harness and version</th>
              {periods.map((p) => (
                <th key={p} scope="col" className="n">
                  {p}
                </th>
              ))}
              <th scope="col">Now</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(([h, v]) => (
              <tr key={`${h}-${v}`}>
                <td className="who mono">
                  {harnessName(h)} {v}
                </td>
                {periods.map((p) => (
                  <td key={p} className="n mono">
                    {num(at(h, v, p)?.reporters)}
                  </td>
                ))}
                <td>{newest(h, v) ? "Newest seen" : "Older"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="note-line">A reporter counts in the period it reported. People and groups keeps its own list of the versions in use today.</div>
    </>
  );
}

/** A section's panel while its answer is not here yet, or failed, or has nothing in it. */
export function Waiting({ reply, error, problem, empty, children }: { reply: ReportReply | null; error: string | null; problem: string | null; empty: string; children: (reply: ReportReply) => React.ReactNode }) {
  if (problem) return <div className="empty">Fix the period above to see the report.</div>;
  if (error) {
    return (
      <div className="err" role="alert">
        {error}
      </div>
    );
  }
  if (!reply) return <div className="empty">Loading…</div>;
  if (reply.rows.length === 0) return reply.partial ? null : <div className="empty">{empty}</div>;
  return <>{children(reply)}</>;
}

export function ToolsPage({ cfg, client, onLocked }: { cfg: ReportConfig; client: ReportsClient; onLocked: () => void }) {
  const r = useReport(client, cfg, onLocked);
  const sessions = useBreakdown(client, r, "session", onLocked);
  const versions = useBreakdown(client, r, "version", onLocked);
  const failures = useBreakdown(client, r, "failures", onLocked);
  const prompts = useBreakdown(client, r, "prompts", onLocked);
  const duration = useBreakdown(client, r, "duration", onLocked);
  const head = resultsHeading(r);
  const reply = r.reply;
  const calls = reply?.columns.find((c) => c.key === "calls") ?? { key: "calls", label: "Calls", unit: "count" as const };
  const total = reply?.total ?? null;
  return (
    <>
      <PageHeader title={cfg.title} lead={cfg.lead} actions={<ReportExport r={r} noun="calls by tool " />} />
      <Section id="rep-tools-f" title="Period and filters">
        <Panel>
          <ReportFilters client={client} r={r} />
        </Panel>
      </Section>
      <Section id="rep-tools-c" title={`Tool calls by ${r.prefs.by}`} help={head.help}>
        <Panel>
          <Waiting reply={reply} error={r.error} problem={r.problem} empty="Nothing was recorded in this period.">
            {(rep) => (
              <>
                <div className="tool alone">
                  <div className="sum left">
                    <div>
                      <span className="big mono">{formatCell(calls, total?.calls)}</span>
                      <span className="cap">tool calls</span>
                    </div>
                    {sessions.reply?.total && (
                      <>
                        <div>
                          <span className="big mono">{formatCell(calls, sessions.reply.total.sessions)}</span>
                          <span className="cap">sessions</span>
                        </div>
                        <div>
                          <span className="big mono">{formatCell(calls, sessions.reply.total.median)}</span>
                          <span className="cap">median calls per session</span>
                        </div>
                        <div>
                          <span className="big mono">{formatCell(calls, sessions.reply.total.p90)}</span>
                          <span className="cap">90th percentile</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <ReportChart rows={rep.rows} valueKey="calls" column={calls} unit="Tool calls" by={rep.by} />
              </>
            )}
          </Waiting>
        </Panel>
      </Section>
      <Section id="rep-tools-t" title="Calls by tool" help="An MCP server shows its total, and opens to the tools under it.">
        <Panel>
          <Waiting reply={reply} error={r.error} problem={r.problem} empty="Nothing was recorded in this period.">
            {(rep) => <ToolTable r={r} reply={rep} />}
          </Waiting>
        </Panel>
      </Section>
      <ToolCostSections client={client} r={r} onLocked={onLocked} />
      <ToolSection id="rep-tools-x" title="Tool failures" help="Failures divided by calls, per tool. The bars show the number of failures, and the figure after each is its share of that tool's calls. Only counts are kept: no error text, arguments or paths.">
        <Waiting reply={failures.reply} error={failures.error} problem={r.problem} empty="No tool was called in this period.">
          {(rep) => <FailuresSection r={r} reply={rep} />}
        </Waiting>
      </ToolSection>
      <ToolSection id="rep-tools-p" title="Permission prompts" help="How often a tool asked before it ran, and how the ask ended.">
        <Waiting reply={prompts.reply} error={prompts.error} problem={r.problem} empty="No tool asked for permission in this period.">
          {(rep) => <PromptsSection reply={rep} />}
        </Waiting>
      </ToolSection>
      <ToolSection id="rep-tools-d" title="Call duration" help="The middle call and the slower twentieth of calls, per tool, slowest first.">
        <Waiting reply={duration.reply} error={duration.error} problem={r.problem} empty={r.prefs.harness === "" ? "No harness reported call times in this period." : `${harnessName(r.prefs.harness)} reported no call times in this period.`}>
          {(rep) => <DurationSection reply={rep} />}
        </Waiting>
      </ToolSection>
      <Section id="rep-tools-s" title="Calls per session" help="The middle session and the busier tenth, so one long session does not hide the rest.">
        <Panel>
          <Waiting reply={sessions.reply} error={sessions.error} problem={r.problem} empty="No sessions in this period.">
            {(rep) => <SessionTable reply={rep} harness={r.prefs.harness} />}
          </Waiting>
        </Panel>
      </Section>
      <Section id="rep-tools-v" title="Harness versions" help="Reporters on each version, per period. Each harness is compared only with its own newest version.">
        <Panel>
          <Waiting reply={versions.reply} error={versions.error} problem={r.problem} empty="No reporter reported a version in this period.">
            {(rep) => <VersionTable reply={rep} />}
          </Waiting>
        </Panel>
      </Section>
    </>
  );
}
