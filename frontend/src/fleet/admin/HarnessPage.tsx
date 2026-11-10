// Admin > Reporting > Harness updates (#724, mockup/podium-admin-reporting-compat.html): what a newer version of Claude Code or OpenCode stopped sending, and how many
// reporters were behind the newest version of their harness. One query drives the page (the period, the grouping and the harness filter); the second section asks the
// same report for its `behind` cut. The names of hooks, fields, tools and harnesses come from reporters and are drawn as text nodes.
import { useState } from "react";
import { Tip } from "../components/Tip";
import { PageHeader, Panel, Section } from "./Page";
import { Pager } from "./Pager";
import { ReportChart, ReportExport, ReportFilters } from "./ReportParts";
import { harnessName, type ReportReply, type ReportRow, type ReportsClient } from "./reportsApi";
import { useBreakdown, Waiting } from "./ToolsPage";
import { useReport, type ReportConfig } from "./useReport";

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `hook:tool.check` is drawn as `tool.check`, with its kind beside it. */
const nameOf = (feature: string): string => feature.replace(/^(hook|field|tool):/, "");
const KIND: Record<string, string> = { hook: "hook", field: "field", tool: "tool name" };

const PAGE_DEFAULT = 25;

function StoppedTable({ reply }: { reply: ReportReply }) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_DEFAULT);
  const shown = reply.rows.slice((page - 1) * size, page * size);
  return (
    <>
      <div className="tw2">
        <table className="ptab" aria-label="Features that stopped after a harness update">
          <thead>
            <tr>
              <th scope="col">Harness and version</th>
              <th scope="col">What stopped</th>
              <th scope="col" className="n">
                <Tip className="tt" text="The share of sessions on the previous version of this harness that sent it.">
                  Seen before
                </Tip>
              </th>
              <th scope="col" className="n">
                <Tip className="tt" text="The share of sessions on the version in this row that send it.">
                  Seen now
                </Tip>
              </th>
              <th scope="col" className="n">
                <Tip className="tt" text="Reporters that run the version in this row, on the last day of the period.">
                  Reporters on it
                </Tip>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((x) => (
              <tr key={`${x.harness}-${x.version}-${x.feature}`}>
                <td className="who mono">
                  {harnessName(String(x.harness))} {String(x.version)}
                </td>
                <td>
                  <span className="mono">{nameOf(String(x.feature))}</span> <span className="muted">({KIND[String(x.kind)] ?? String(x.kind)})</span>
                  {typeof x.effect === "string" && x.effect !== "" && <div className="hint">{x.effect}</div>}
                </td>
                <td className="n mono">{num(x.before)}%</td>
                <td className="n mono">{num(x.now)}%</td>
                <td className="n mono">{num(x.reporters)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="note-line">
        <b>Seen before and seen now are the share of sessions that sent it</b>, on the previous version of the same harness and on the version in the row. A feature is listed when at least 25% of sessions sent it before, under a tenth of that share send it now, and at least 20 sessions and 2 reporters are on the new version. A tool name that stops may only mean people stopped using it. Counts are kept as names and numbers, never as values.
      </div>
      <Pager id="harness-stopped" page={page} pageSize={size} total={reply.rows.length} onPage={setPage} onSize={(n) => { setSize(n); setPage(1); }} />
    </>
  );
}

interface Week {
  period: string;
  reporters: number;
  onNewest: number;
  behind: number;
}

/** The rows of the `behind` reply added up over harnesses, one per period, oldest first. */
export function behindWeeks(rows: ReportRow[]): Week[] {
  const by = new Map<string, Week>();
  for (const x of rows) {
    const period = String(x.period);
    const w = by.get(period) ?? { period, reporters: 0, onNewest: 0, behind: 0 };
    w.reporters += num(x.reporters);
    w.onNewest += num(x.onNewest);
    w.behind += num(x.behind);
    by.set(period, w);
  }
  return [...by.values()].sort((a, b) => byCode(a.period, b.period));
}

const share = (w: { reporters: number; behind: number }): string => (w.reporters ? `${Math.round((w.behind / w.reporters) * 100)}%` : "0%");

export function HarnessPage({ cfg, client, onLocked }: { cfg: ReportConfig; client: ReportsClient; onLocked: () => void }) {
  const r = useReport(client, cfg, onLocked);
  const behind = useBreakdown(client, r, "behind", onLocked);
  const reply = r.reply;
  const ready = !r.problem && !r.error;
  const total = reply?.total ?? null;
  return (
    <>
      <PageHeader title={cfg.title} lead={cfg.lead} actions={<ReportExport r={r} noun="features that stopped " />} />
      <Section id="rep-harness-f" title="Period and filters">
        <Panel>
          <ReportFilters client={client} r={r} />
        </Panel>
      </Section>
      <Section id="rep-harness-s" title="Features that stopped" help={`Something Podium or the reporter relied on that a newer version of a harness no longer sends${r.problem ? "" : `, ${r.range.from} to ${r.range.to}`}.`}>
        {ready && reply ? (
          reply.rows.length === 0 ? (
            <Panel>
              <div className="note-line">
                <b>Nothing has stopped.</b> No harness version in this period sends less than the version before it. A version that changed nothing is not listed.
              </div>
            </Panel>
          ) : (
            <>
              <Panel>
                <div className="tool alone">
                  <div className="sum left">
                    <div>
                      <span className="big mono">{num(total?.features)}</span>
                      <span className="cap">
                        <Tip className="tt" text="Something an earlier version of the same harness sent and this version does not: a hook, an event field or a tool name.">
                          features stopped
                        </Tip>
                      </span>
                    </div>
                    <div>
                      <span className="big mono">{num(total?.versions)}</span>
                      <span className="cap">
                        <Tip className="tt" text="Harness versions, such as Claude Code 2.1.319, that stopped sending at least one thing the version before them sent.">
                          versions affected
                        </Tip>
                      </span>
                    </div>
                    <div>
                      <span className="big mono">{num(total?.reporters)}</span>
                      <span className="cap">
                        <Tip className="tt" text="Reporters that run one of the affected versions on the last day of the period. Their people may already notice what is listed below.">
                          reporters affected
                        </Tip>
                      </span>
                    </div>
                  </div>
                </div>
              </Panel>
              <Panel>
                <StoppedTable reply={reply} />
              </Panel>
            </>
          )
        ) : (
          <Panel>
            <Waiting reply={reply} error={r.error} problem={r.problem} empty="">
              {() => null}
            </Waiting>
          </Panel>
        )}
      </Section>
      <Section id="rep-harness-b" title="Reporters behind the newest version" help={`Reporters on a version older than the newest Podium had seen for that harness that week${r.problem ? "" : `, ${r.range.from} to ${r.range.to}`}.`}>
        {!r.problem && behind.reply && behind.reply.rows.length > 0 ? (
          <BehindSections reply={behind.reply} />
        ) : (
          <Panel>
            <Waiting reply={behind.reply} error={behind.error} problem={r.problem} empty="No reporter reported a version in this period.">
              {() => null}
            </Waiting>
          </Panel>
        )}
      </Section>
    </>
  );
}

function BehindSections({ reply }: { reply: ReportReply }) {
  const weeks = behindWeeks(reply.rows);
  const last = weeks[weeks.length - 1]!;
  const worst = weeks.reduce((a, b) => (b.behind > a.behind ? b : a), weeks[0]!);
  const column = reply.columns.find((c) => c.key === "behind") ?? { key: "behind", label: "Behind", unit: "count" };
  const thisWeek = reply.rows.filter((x) => x.period === last.period);
  return (
    <>
      <Panel>
        <div className="tool">
          <div className="sum left">
            <div>
              <span className="big mono">
                {last.behind} of {last.reporters}
              </span>
              <span className="cap">reporters behind in the latest period</span>
            </div>
            <div>
              <span className="big mono">
                {worst.behind} of {worst.reporters}
              </span>
              <span className="cap">most behind, {worst.period}</span>
            </div>
          </div>
        </div>
        <ReportChart rows={reply.rows} valueKey="behind" column={column} unit="Reporters behind" by={reply.by} />
      </Panel>
      <Panel>
        <div className="tw2">
          <table className="ptab" aria-label="Reporters behind the newest version, by period">
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col" className="n">
                  Reporters
                </th>
                <th scope="col" className="n">
                  On the newest
                </th>
                <th scope="col" className="n">
                  Behind
                </th>
                <th scope="col" className="n">
                  Share behind
                </th>
              </tr>
            </thead>
            <tbody>
              {[...weeks].reverse().map((w) => (
                <tr key={w.period}>
                  <td className="who">{w.period}</td>
                  <td className="n mono">{w.reporters}</td>
                  <td className="n mono">{w.onNewest}</td>
                  <td className="n mono">{w.behind}</td>
                  <td className="n mono">{share(w)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {thisWeek.map((x) => (
                <tr key={String(x.harness)}>
                  <th scope="row">{harnessName(String(x.harness))}, latest period</th>
                  <td className="n mono">{num(x.reporters)}</td>
                  <td className="n mono">{num(x.onNewest)}</td>
                  <td className="n mono">{num(x.behind)}</td>
                  <td className="n mono">{share({ reporters: num(x.reporters), behind: num(x.behind) })}</td>
                </tr>
              ))}
            </tfoot>
          </table>
        </div>
        <div className="note-line">The Harness versions table on Tools shows reporters per version; this adds how many were behind in each period. A reporter counts in the period it reported.</div>
      </Panel>
    </>
  );
}
