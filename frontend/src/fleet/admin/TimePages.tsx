// Admin > Reporting > Sessions and Usage with the sections #722 adds (mockup/podium-admin-reporting-session-time.html): how long sessions ran and
// waited on a person, what they waited for, which agents they launched and how deep the chains went, who ran sessions on a day, and the busiest
// hours, for every harness. Each page is built on the report it had (ReportPage) with the new sections after it. The Harness filter narrows the
// new sections; the older report is not kept per harness, so the page says so. Names of people, groups, agent types and harnesses come from
// reporters and are drawn as text nodes.
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDur } from "../format";
import { AdminError, query } from "./adminApi";
import { Choice, PageHeader, Panel, Section } from "./Page";
import { Pager } from "./Pager";
import { ExportButtons, ReportBody, ReportChart, ReportExport, ReportFilters } from "./ReportParts";
import { resultsHeading } from "./ReportPages";
import { formatCell, harnessName, reportErrorText, saveFile, type ReportColumn, type ReportReply, type ReportRow, type ReportsClient } from "./reportsApi";
import { MixSections } from "./CostSections";
import { Waiting } from "./ToolsPage";
import { useReport, type ReportConfig, type ReportState } from "./useReport";

const COUNT: ReportColumn = { key: "n", label: "", unit: "count" };
const SECONDS: ReportColumn = { key: "s", label: "", unit: "seconds" };
const PERCENT: ReportColumn = { key: "p", label: "", unit: "percent" };
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const count = (v: unknown): string => formatCell(COUNT, v);
const dur = (v: unknown): string => formatCell(SECONDS, v);
const share = (v: unknown): string => formatCell(PERCENT, v);
/** Ids and ISO periods compared by code unit, the order the server answers in. */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const list = (v: unknown): ReportRow[] => (Array.isArray(v) ? (v as ReportRow[]) : []);
const plural = (n: number, one: string, many: string): string => `${count(n)} ${n === 1 ? one : many}`;
/** "a", "a and b", "a, b and c". */
const andList = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** The figures beside a chart of seconds, short enough for the 44 px they have: 20h, 45m. */
const hoursAxis = (v: number): string => (v >= 3600 ? `${Math.round(v / 3600)}h` : v >= 60 ? `${Math.round(v / 60)}m` : `${Math.round(v)}s`);

export interface SectionState {
  reply: ReportReply | null;
  error: string | null;
  exportAs: (format: "csv" | "json") => Promise<void>;
  exportError: string | null;
}

export interface Spec {
  report: "sessiontime" | "workload" | "costs";
  breakdown: string;
  /** The Harness filter, when the page has none of its own to send (#723). */
  harness?: string;
  /** The costs report's mix: by model or by effort. */
  mixof?: string;
  /** Whether the report is cut into days, weeks or months. */
  by?: boolean;
  /** Whether the page's Group filter is sent. */
  group?: boolean;
  /** Why nothing is asked for, when a filter the figures are not kept by is set. */
  blocked: string | null;
}

/** One more answer for the period and the Harness filter the page has, with the export of exactly that answer. */
export function useSection(client: ReportsClient, r: ReportState, spec: Spec, onLocked: () => void): SectionState {
  const [state, setState] = useState<{
    reply: ReportReply | null;
    error: string | null;
  }>({ reply: null, error: null });
  const [exportError, setExportError] = useState<string | null>(null);
  const { range, prefs, problem } = r;
  const path = useMemo(
    () =>
      problem || spec.blocked
        ? null
        : `/reports/${spec.report}${query({ from: range.from, to: range.to, by: spec.by ? prefs.by : undefined, breakdown: spec.breakdown, mixof: spec.mixof, harness: spec.harness ?? prefs.harness, group: spec.group ? prefs.group : undefined })}`,
    [problem, spec.blocked, spec.report, spec.breakdown, spec.mixof, spec.harness, spec.by, spec.group, range.from, range.to, prefs.by, prefs.harness, prefs.group],
  );
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
  const exportAs = async (format: "csv" | "json") => {
    setExportError(null);
    if (path === null || (format === "json" && !state.reply)) return;
    const name = `podium-${spec.report}-${spec.breakdown}-${range.from}-${range.to}.${format}`;
    try {
      if (format === "json") saveFile(name, "application/json", JSON.stringify(state.reply, null, 2));
      else saveFile(name, "text/csv", await client.text(`${path}&format=csv`));
    } catch (e) {
      if (e instanceof AdminError && e.status === 401) lock.current();
      else setExportError("Could not download the file. Try again.");
    }
  };
  return { ...state, exportAs, exportError };
}

/** A section whose title line carries the CSV and JSON of its own table, as the Spend projection's does. */
export function DataSection({ id, title, help, noun, s, children }: { id: string; title: string; help?: string; noun: string; s: SectionState; children: React.ReactNode }) {
  return (
    <section className="asec" aria-labelledby={id}>
      <div className="asec-h">
        <div>
          <h2 id={id}>{title}</h2>
          {help && <p className="hint">{help}</p>}
        </div>
        <ExportButtons print={false} noun={noun} disabled={!s.reply} onCsv={() => void s.exportAs("csv")} onJson={() => void s.exportAs("json")} error={s.exportError} />
      </div>
      <Panel>{children}</Panel>
    </section>
  );
}

export const BLOCKED = "These figures are kept for every person, group and model together, so they are not shown while a Person, Group or Model filter is set.";

// ---- Sessions ---------------------------------------------------------------------------------------

function LengthBody({ reply, harness }: { reply: ReportReply; harness: string }) {
  const total = reply.total ?? {};
  const periods = list(reply.periods);
  const byHarness = list(reply.byHarness);
  const from = reply.oldestDay && reply.oldestDay > reply.from ? reply.oldestDay : reply.from;
  const since = text(reply.waitSince);
  const late = since !== "" && since > from;
  const col = reply.columns.find((c) => c.key === "waitS") ?? {
    key: "waitS",
    label: "Time waiting on people",
    unit: "seconds" as const,
  };
  const first = reply.by === "month" ? "Month" : reply.by === "day" ? "Day" : "Week of";
  return (
    <>
      <div className="tool alone">
        <div className="sum left">
          <div>
            <span className="big mono">{count(total.sessions)}</span>
            <span className="cap">sessions</span>
          </div>
          <div>
            <span className="big mono">{dur(total.avgDurationS)}</span>
            <span className="cap">average length</span>
          </div>
          <div>
            <span className="big mono">{dur(total.waitS)}</span>
            <span className="cap">{late ? `waiting on people, since ${since}` : "waiting on people"}</span>
          </div>
          <div>
            <span className="big mono">{share(total.waitSharePct)}</span>
            <span className="cap">of session time spent waiting</span>
          </div>
        </div>
      </div>
      <ReportChart rows={reply.rows} valueKey="waitS" column={col} unit="Time waiting on people" by={reply.by ?? undefined} axis={hoursAxis} />
      <div className="tw2">
        <table className="ptab" aria-label="Length and waiting by period">
          <thead>
            <tr>
              <th scope="col">{first}</th>
              <th scope="col" className="n">
                Sessions
              </th>
              <th scope="col" className="n">
                Average length
              </th>
              <th scope="col" className="n">
                Longest
              </th>
              <th scope="col" className="n">
                Waiting on people
              </th>
              <th scope="col" className="n">
                Share of time
              </th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={text(p.period)}>
                <td className="who">{text(p.period)}</td>
                <td className="n mono">{count(p.sessions)}</td>
                <td className="n mono">{dur(p.avgDurationS)}</td>
                <td className="n mono">{dur(p.maxDurationS)}</td>
                <td className={`n mono${p.waitS === null ? " muted" : ""}`}>{dur(p.waitS)}</td>
                <td className={`n mono${p.waitSharePct === null ? " muted" : ""}`}>{share(p.waitSharePct)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{harness ? `Whole period, ${harnessName(harness)}` : "Whole period, all harnesses"}</th>
              <td className="n mono">{count(total.sessions)}</td>
              <td className="n mono">{dur(total.avgDurationS)}</td>
              <td className="n mono">{dur(total.maxDurationS)}</td>
              <td className="n mono">{dur(total.waitS)}</td>
              <td className="n mono">{share(total.waitSharePct)}</td>
            </tr>
            {harness === "" &&
              byHarness.length > 1 &&
              byHarness.map((h) => (
                <tr key={text(h.harness)}>
                  <th scope="row">{harnessName(text(h.harness))}</th>
                  <td className="n mono">{count(h.sessions)}</td>
                  <td className="n mono">{dur(h.avgDurationS)}</td>
                  <td className="n mono">{dur(h.maxDurationS)}</td>
                  <td className="n mono">{dur(h.waitS)}</td>
                  <td className="n mono">{share(h.waitSharePct)}</td>
                </tr>
              ))}
          </tfoot>
        </table>
      </div>
      {since === "" && <div className="note-line">Waiting time is recorded from the upgrade to this release on, and no session has recorded any yet.</div>}
      {late && (
        <div className="note-line">
          <b>Waiting time is recorded from {since},</b> when Podium was upgraded to this release. Earlier periods show a dash, and the totals count only the periods that have it.
        </div>
      )}
      <div className="note-line">
        Length is from a session&apos;s start to its last report. Waiting is the time a session reported that it waited on a person, so it is counted to the reporting interval, and
        a wait for background work or a timer is not counted.
      </div>
    </>
  );
}

const REASON_NAMES: Record<string, string> = {
  permission: "Permission for a tool",
  question: "An answer to a question",
  plan: "Approval of a plan",
};

function ReasonBody({ reply }: { reply: ReportReply }) {
  const total = reply.total ?? {};
  return (
    <div className="tw2">
      <table className="ptab" aria-label="Waiting by reason">
        <thead>
          <tr>
            <th scope="col">Waiting for</th>
            <th scope="col" className="n">
              Waits
            </th>
            <th scope="col" className="n">
              Time waiting
            </th>
            <th scope="col" className="n">
              Average wait
            </th>
            <th scope="col" className="n">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {list(reply.byReason).map((k) => (
            <tr key={text(k.reason)}>
              <td className="who">{REASON_NAMES[text(k.reason)] ?? text(k.reason)}</td>
              <td className="n mono">{count(k.waits)}</td>
              <td className="n mono">{dur(k.waitS)}</td>
              <td className="n mono">{dur(k.avgWaitS)}</td>
              <td className="n mono">{share(k.sharePct)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="n mono">{count(total.waits)}</td>
            <td className="n mono">{dur(total.waitS)}</td>
            <td className="n mono">{dur(total.avgWaitS)}</td>
            <td className="n mono">100%</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** The most agent types shown by name; the rest are one row, so a long tail of types does not make the table long. */
const TYPES_SHOWN = 3;

function AgentsBody({ reply, deepest }: { reply: ReportReply; deepest: number | null }) {
  const total = reply.total ?? {};
  const harnesses = [...new Set(reply.rows.map((x) => text(x.harness)))].sort(byCode);
  const types = new Map<string, { perHarness: Map<string, number>; agents: number }>();
  for (const row of reply.rows) {
    const t = types.get(text(row.type)) ?? {
      perHarness: new Map<string, number>(),
      agents: 0,
    };
    t.perHarness.set(text(row.harness), (t.perHarness.get(text(row.harness)) ?? 0) + num(row.agents));
    t.agents += num(row.agents);
    types.set(text(row.type), t);
  }
  const ordered = [...types].map(([type, t]) => ({ type, ...t }));
  const grand = num(total.agents);
  const folded = ordered.length > TYPES_SHOWN + 1;
  const shown = folded ? ordered.slice(0, TYPES_SHOWN) : ordered;
  const rest = folded ? ordered.slice(TYPES_SHOWN) : [];
  const line = (name: React.ReactNode, perHarness: (h: string) => number, agents: number, mono: boolean, key: string) => (
    <tr key={key}>
      <td className={mono ? "who mono" : "who"}>{name}</td>
      {harnesses.map((h) => (
        <td key={h} className="n mono">
          {count(perHarness(h))}
        </td>
      ))}
      <td className="n mono">{count(agents)}</td>
      <td className="n mono">{grand > 0 ? `${Math.round((agents / grand) * 100)}%` : "–"}</td>
    </tr>
  );
  return (
    <>
      <div className="tool alone">
        <div className="sum left">
          <div>
            <span className="big mono">{count(total.agents)}</span>
            <span className="cap">agents launched</span>
          </div>
          <div>
            <span className="big mono">{total.agentsPerSession === null || total.agentsPerSession === undefined ? "–" : String(total.agentsPerSession)}</span>
            <span className="cap">agents per session</span>
          </div>
          {deepest !== null && deepest > 0 && (
            <div>
              <span className="big mono">{count(deepest)}</span>
              <span className="cap">{deepest === 1 ? "level deep at most" : "levels deep at most"}</span>
            </div>
          )}
        </div>
      </div>
      <div className="tw2">
        <table className="ptab" aria-label="Agents launched by type">
          <thead>
            <tr>
              <th scope="col">Agent type</th>
              {harnesses.map((h) => (
                <th key={h} scope="col" className="n">
                  {harnessName(h)}
                </th>
              ))}
              <th scope="col" className="n">
                Launched
              </th>
              <th scope="col" className="n">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => line(t.type, (h) => t.perHarness.get(h) ?? 0, t.agents, true, t.type))}
            {rest.length > 0 &&
              line(
                `Other, ${plural(rest.length, "type", "types")}`,
                (h) => rest.reduce((n, t) => n + (t.perHarness.get(h) ?? 0), 0),
                rest.reduce((n, t) => n + t.agents, 0),
                false,
                "other",
              )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {harnesses.map((h) => (
                <td key={h} className="n mono">
                  {count(ordered.reduce((n, t) => n + (t.perHarness.get(h) ?? 0), 0))}
                </td>
              ))}
              <td className="n mono">{count(grand)}</td>
              <td className="n mono">100%</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

const DEPTH_NAMES: Record<number, string> = {
  1: "1, launched by the session itself",
  2: "2, launched by an agent",
  3: "3 or deeper",
};

function DepthBody({ reply }: { reply: ReportReply }) {
  const total = num(reply.total?.agents);
  const harnesses = [...new Set(reply.rows.map((x) => text(x.harness)))].sort(byCode);
  const depths = [...new Set(reply.rows.map((x) => num(x.depth)))].sort((a, b) => a - b);
  const at = (d: number, h: string): number => reply.rows.filter((x) => num(x.depth) === d && text(x.harness) === h).reduce((n, x) => n + num(x.agents), 0);
  return (
    <div className="tw2">
      <table className="ptab" aria-label="Agent chain depth">
        <thead>
          <tr>
            <th scope="col">Chain depth</th>
            {harnesses.map((h) => (
              <th key={h} scope="col" className="n">
                {harnessName(h)}
              </th>
            ))}
            <th scope="col" className="n">
              Agents
            </th>
            <th scope="col" className="n">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {depths.map((d) => {
            const all = harnesses.reduce((n, h) => n + at(d, h), 0);
            return (
              <tr key={d}>
                <td className="who">{DEPTH_NAMES[d] ?? String(d)}</td>
                {harnesses.map((h) => (
                  <td key={h} className="n mono">
                    {count(at(d, h))}
                  </td>
                ))}
                <td className="n mono">{count(all)}</td>
                <td className="n mono">{total > 0 ? `${Math.round((all / total) * 100)}%` : "–"}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            {harnesses.map((h) => (
              <td key={h} className="n mono">
                {count(depths.reduce((n, d) => n + at(d, h), 0))}
              </td>
            ))}
            <td className="n mono">{count(total)}</td>
            <td className="n mono">100%</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function SessionsPage({ cfg, client, onLocked }: { cfg: ReportConfig; client: ReportsClient; onLocked: () => void }) {
  const r = useReport(client, cfg, onLocked);
  const { prefs } = r;
  const blocked = prefs.person || prefs.group || prefs.model ? BLOCKED : null;
  const time = useSection(client, r, { report: "sessiontime", breakdown: "time", by: true, blocked }, onLocked);
  const reason = useSection(client, r, { report: "sessiontime", breakdown: "reason", blocked }, onLocked);
  const agents = useSection(client, r, { report: "sessiontime", breakdown: "agents", blocked }, onLocked);
  const depth = useSection(client, r, { report: "sessiontime", breakdown: "depth", blocked }, onLocked);
  const head = resultsHeading(r);
  const period = `${r.range.from} to ${r.range.to}`;
  const empty = (what: string) => `No ${what} in this period.`;
  const blockedLine = blocked && <div className="note-line">{blocked}</div>;
  return (
    <>
      <PageHeader title={cfg.title} lead={cfg.lead} actions={<ReportExport r={r} />} />
      <Section id={`rep-${cfg.report}-f`} title="Period and filters">
        <Panel>
          <ReportFilters client={client} r={r} harnesses={time.reply?.harnesses} />
        </Panel>
      </Section>
      <Section id={`rep-${cfg.report}-r`} title={head.title} help={head.help}>
        <Panel>
          <ReportBody r={r} />
          {prefs.harness && <div className="note-line">This section is not kept per harness, so it covers every harness. The sections below follow the Harness filter.</div>}
        </Panel>
      </Section>
      {!r.problem && (
        <>
          <DataSection
            id="rep-sessiontime-w"
            title={`Length and waiting by ${prefs.by}`}
            help={`How long sessions ran, and how much of that they spent waiting on a person to answer a question, approve a plan or allow a tool. ${period}.`}
            noun="length and waiting "
            s={time}
          >
            {blockedLine ?? (
              <Waiting reply={time.reply} error={time.error} problem={r.problem} empty={empty("sessions")}>
                {(rep) => <LengthBody reply={rep} harness={prefs.harness} />}
              </Waiting>
            )}
          </DataSection>
          <DataSection
            id="rep-sessiontime-r"
            title="What sessions waited for"
            help="Each wait is a question, a plan to approve, or a tool asking for permission. Together they add up to the waiting above."
            noun="waiting by reason "
            s={reason}
          >
            {blockedLine ?? (
              <Waiting reply={reason.reply} error={reason.error} problem={r.problem} empty="No waiting on a person was recorded in this period.">
                {(rep) => <ReasonBody reply={rep} />}
              </Waiting>
            )}
          </DataSection>
          <DataSection id="rep-sessiontime-a" title="Agents launched" help={`By agent type, with a column for each harness. ${period}.`} noun="agents by type " s={agents}>
            {blockedLine ?? (
              <Waiting reply={agents.reply} error={agents.error} problem={r.problem} empty={empty("agents launched")}>
                {(rep) => <AgentsBody reply={rep} deepest={depth.reply ? num(depth.reply.total?.deepest) : null} />}
              </Waiting>
            )}
          </DataSection>
          <DataSection
            id="rep-sessiontime-c"
            title="How deep agent chains go"
            help="An agent that launches another agent makes a chain. Depth 1 is an agent the session launched itself."
            noun="chain depth "
            s={depth}
          >
            {blockedLine ?? (
              <Waiting reply={depth.reply} error={depth.error} problem={r.problem} empty={empty("agents launched")}>
                {(rep) => <DepthBody reply={rep} />}
              </Waiting>
            )}
          </DataSection>
          <MixSections client={client} r={r} onLocked={onLocked} />
        </>
      )}
    </>
  );
}

// ---- Usage ------------------------------------------------------------------------------------------

function PeopleBody({ reply }: { reply: ReportReply }) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const total = reply.total ?? {};
  const rows = reply.rows;
  const last = Math.max(1, Math.ceil(rows.length / size));
  const at = Math.min(page, last);
  const shown = rows.slice((at - 1) * size, at * size);
  const busiest = (day: unknown, n: unknown): string => (typeof day === "string" ? `${day}, ${plural(num(n), "session", "sessions")}` : "–");
  return (
    <>
      <div className="tw2">
        <table className="ptab" aria-label="Sessions per person per day">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Group</th>
              <th scope="col" className="n">
                Days active
              </th>
              <th scope="col" className="n">
                Sessions
              </th>
              <th scope="col" className="n">
                Per active day
              </th>
              <th scope="col">Busiest day</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={text(p.person)}>
                <td className="who">{text(p.person) === "-" ? "No owner" : text(p.person)}</td>
                <td className={text(p.group) === "-" ? "muted" : undefined}>{text(p.group) === "-" ? "None" : text(p.group)}</td>
                <td className="n mono">{count(p.activeDays)}</td>
                <td className="n mono">{count(p.sessions)}</td>
                <td className="n mono">{p.perActiveDay === null ? "–" : String(p.perActiveDay)}</td>
                <td className="mono">{busiest(p.busiestDay, p.busiestDaySessions)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{num(total.people) === 1 ? "The one person" : `All ${count(total.people)} people`}</th>
              <td />
              <td className="n mono">{count(total.activeDays)}</td>
              <td className="n mono">{count(total.sessions)}</td>
              <td className="n mono">{total.perActiveDay === null || total.perActiveDay === undefined ? "–" : String(total.perActiveDay)}</td>
              <td className="mono">{busiest(total.busiestDay, total.busiestDaySessions)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager id="rep-workload-p" page={at} pageSize={size} total={rows.length} onPage={setPage} onSize={(n) => (setSize(n), setPage(1))} />
      <div className="note-line">
        A day counts for a person when they started at least one session on it. The Total row always counts everyone in the filter, not just this page.
      </div>
    </>
  );
}

/** The peaks of the 24 hours as bars: one ink, the axis from 0 to the busiest hour, as the other report charts are drawn. */
function HourChart({ reply }: { reply: ReportReply }) {
  const peaks = reply.rows.map((x) => num(x.peak));
  const max = Math.max(...peaks, 0);
  const slot = 600 / 24;
  const top = reply.rows.filter((x) => num(x.peak) === max && max > 0).map((x) => text(x.hour));
  const label = `Most sessions live at once by hour of day. ${max > 0 ? `Busiest at ${andList(top)} with ${count(max)}.` : "No session was live in this period."}`;
  return (
    <div className="chart">
      <div className="plot">
        <div className="yl" aria-hidden="true">
          <span style={{ top: 20 }}>{count(max)}</span>
          <span style={{ top: 70 }}>{count(Math.round(max / 2))}</span>
          <span style={{ top: 110 }}>{count(0)}</span>
        </div>
        <svg viewBox="0 0 600 120" role="img" aria-label={label} preserveAspectRatio="none">
          <line className="gl" x1="0" x2="600" y1="20" y2="20" />
          <line className="gl" x1="0" x2="600" y1="70" y2="70" />
          <line className="ax" x1="0" x2="600" y1="110" y2="110" />
          {peaks.map((v, h) => (v > 0 ? <rect key={h} className="rbar" x={h * slot + slot * 0.15} y={110 - (v / max) * 90} width={slot * 0.7} height={(v / max) * 90} /> : null))}
        </svg>
      </div>
      <div className="xl" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
      <div className="hint" aria-hidden="true">
        Most sessions live at once, by hour of day.
        {max > 0 ? ` Highest: ${count(max)}, at ${andList(top)}.` : ""}
      </div>
    </div>
  );
}

function HoursBody({ reply, groupSet }: { reply: ReportReply; groupSet: boolean }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const total = reply.total ?? {};
  return (
    <>
      <div className="tool">
        <Choice
          label="Show as"
          value={view}
          options={[
            ["chart", "Chart"],
            ["table", "Table"],
          ]}
          onChange={setView}
        />
        <div className="sum">
          <div>
            <span className="big mono">{count(total.peak)}</span>
            <span className="cap">most live at once</span>
          </div>
          <div>
            <span className="big mono">{text(total.busiestHour) || "–"}</span>
            <span className="cap">busiest hour, first reached</span>
          </div>
        </div>
      </div>
      {view === "chart" ? (
        <HourChart reply={reply} />
      ) : (
        <div className="tw2">
          <table className="ptab" aria-label="Most sessions live at once by hour of day">
            <thead>
              <tr>
                <th scope="col">Hour</th>
                <th scope="col" className="n">
                  Most live at once
                </th>
              </tr>
            </thead>
            <tbody>
              {reply.rows.map((x, i) => (
                <tr key={text(x.hour)}>
                  <td className="who mono">{`${text(x.hour)} to ${String((i + 1) % 24).padStart(2, "0")}:00`}</td>
                  <td className="n mono">{count(x.peak)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {groupSet && <div className="note-line">The busiest hours count every session, so the Group filter does not apply to them.</div>}
      <div className="note-line">
        An hour counts a session from its first report to its last. The peak is read from the per-second samples Podium keeps for 24 hours, and the daily summary keeps one peak for
        each hour of each day.
      </div>
    </>
  );
}

export function UsagePage({ cfg, client, onLocked }: { cfg: ReportConfig; client: ReportsClient; onLocked: () => void }) {
  const r = useReport(client, cfg, onLocked);
  const { prefs } = r;
  const people = useSection(client, r, { report: "workload", breakdown: "person", group: true, blocked: null }, onLocked);
  const hours = useSection(client, r, { report: "workload", breakdown: "hour", blocked: null }, onLocked);
  const head = resultsHeading(r);
  const period = `${r.range.from} to ${r.range.to}`;
  return (
    <>
      <PageHeader title={cfg.title} lead={cfg.lead} actions={<ReportExport r={r} />} />
      <Section id={`rep-${cfg.report}-f`} title="Period and filters">
        <Panel>
          <ReportFilters client={client} r={r} harnesses={people.reply?.harnesses ?? hours.reply?.harnesses} />
        </Panel>
      </Section>
      <Section id={`rep-${cfg.report}-r`} title={head.title} help={head.help}>
        <Panel>
          <ReportBody r={r} />
          {prefs.harness && <div className="note-line">This section is not kept per harness, so it covers every harness. The sections below follow the Harness filter.</div>}
        </Panel>
      </Section>
      {!r.problem && (
        <>
          <DataSection
            id="rep-workload-p-h"
            title="Sessions per person per day"
            help={`How many sessions each person ran on a day they used Podium, ${period}.`}
            noun="sessions per person "
            s={people}
          >
            <Waiting reply={people.reply} error={people.error} problem={r.problem} empty="No sessions in this period.">
              {(rep) => <PeopleBody reply={rep} />}
            </Waiting>
          </DataSection>
          <DataSection
            id="rep-workload-h"
            title="Busiest hours"
            help={`The most sessions live at once in each hour of the day, across the period. Hours are ${hours.reply?.tz ?? "server"} time.`}
            noun="busiest hours "
            s={hours}
          >
            <Waiting reply={hours.reply} error={hours.error} problem={r.problem} empty="No sessions in this period.">
              {(rep) => <HoursBody reply={rep} groupSet={prefs.group !== ""} />}
            </Waiting>
          </DataSection>
        </>
      )}
    </>
  );
}
