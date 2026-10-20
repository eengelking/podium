// Admin > Reporting (#484): the shared report page, the five reports that are one table each, and Data kept.
// Spend has its own page (SpendPage.tsx) because it adds Spend today and the projection to the same report.
import { PageHeader, Panel, Section } from "./Page";
import { ReportBody, ReportExport, ReportFilters } from "./ReportParts";
import type { RetentionReply, ReportId, ReportsClient } from "./reportsApi";
import { reportErrorText } from "./reportsApi";
import { useReport, type ReportConfig, type ReportState } from "./useReport";
import { useList } from "./useList";
import type { AdminApi } from "./adminApi";

export const SPEND_CONFIG: ReportConfig = {
  report: "spend",
  title: "Spend",
  lead: "What was spent, by person, group, model or project. Estimated from tokens, not a bill.",
  hasBy: true,
  filters: ["person", "group", "model"],
  breakdowns: [
    ["none", "Total only"],
    ["person", "Person"],
    ["group", "Group"],
    ["model", "Model"],
    ["project", "Project"],
  ],
  chart: { key: "costUsd", unit: "Estimated spend" },
  summary: [
    { key: "costUsd", caption: "spent" },
    { key: "sessions", caption: "sessions" },
  ],
  help: "A session counts on the day it was last seen. A model without a price shows a dash.",
};

export const REPORT_CONFIGS: Record<Exclude<ReportId, "spend">, ReportConfig> = {
  usage: {
    report: "usage",
    title: "Usage",
    lead: "Who used Podium, how many sessions they started, and how many ran at once. Reporters is the most heard from on any one day of a period.",
    hasBy: true,
    filters: ["group"],
    chart: { key: "sessions", unit: "Sessions started" },
    summary: [
      { key: "people", caption: "active people" },
      { key: "reporters", caption: "reporters on the busiest day" },
      { key: "sessions", caption: "sessions started" },
      { key: "peakLive", caption: "most live at once" },
    ],
    help: "Sessions started and people who reported",
  },
  people: {
    report: "people",
    title: "People and groups",
    lead: "How many people, groups and reporters there are, who reported in the period, and who has not.",
    hasBy: false,
    filters: ["group"],
    summary: [],
    help: "Who reported in the period, who has gone quiet and who has never reported",
  },
  sessions: {
    report: "sessions",
    title: "Sessions",
    lead: "How sessions ended, on which model, effort and plan, how long they ran, and how often the context window overflowed.",
    hasBy: true,
    filters: ["person", "group", "model"],
    breakdowns: [
      ["outcome", "Outcome"],
      ["model", "Model"],
      ["effort", "Effort"],
      ["plan", "Plan"],
    ],
    chart: { key: "sessions", unit: "Sessions" },
    summary: [
      { key: "sessions", caption: "sessions" },
      { key: "blowouts", caption: "context blowouts" },
    ],
    help: "Sessions by outcome, model, effort or plan",
  },
  failures: {
    report: "failures",
    title: "Failures",
    lead: "What failed, how often and for whom, to find a root cause.",
    hasBy: true,
    filters: ["person", "group"],
    breakdowns: [
      ["class", "Class"],
      ["tool", "Tool"],
      ["person", "Person"],
    ],
    chart: { key: "count", unit: "Failures" },
    summary: [
      { key: "count", caption: "failures" },
      { key: "people", caption: "people" },
    ],
    help: "Each row opens History for sessions from the last 30 days. Older ones have counts only.",
  },
  activity: {
    report: "activity",
    title: "Admin activity",
    lead: "What happened in Admin, filtered by kind of entry and period. Entries go back 90 days.",
    hasBy: false,
    filters: [],
    kinds: true,
    summary: [],
    help: "Newest first, up to 1,000 entries",
  },
};

/** The section heading and help for a report's results: "Usage by week", then the days it covers. */
export function resultsHeading(r: ReportState): { title: string; help: string } {
  const { cfg, prefs, range, problem } = r;
  return { title: cfg.hasBy ? `${cfg.title} by ${prefs.by}` : cfg.title, help: problem ? cfg.help : `${cfg.help}, ${range.from} to ${range.to}.` };
}

export function ReportPage({ cfg, client, onLocked }: { cfg: ReportConfig; client: ReportsClient; onLocked: () => void }) {
  const r = useReport(client, cfg, onLocked);
  const head = resultsHeading(r);
  return (
    <>
      <PageHeader title={cfg.title} lead={cfg.lead} actions={<ReportExport r={r} />} />
      <Section id={`rep-${cfg.report}-f`} title="Period and filters">
        <Panel>
          <ReportFilters client={client} r={r} />
        </Panel>
      </Section>
      <Section id={`rep-${cfg.report}-r`} title={head.title} help={head.help}>
        <Panel>
          <ReportBody r={r} />
        </Panel>
      </Section>
    </>
  );
}

/** "395 days", "24 hours" (one day, as the mockup says it), "1 hour". */
export function keptText(days: number): string {
  if (days <= 1) {
    const h = Math.max(1, Math.round(days * 24));
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  return `${days} days`;
}

/** Data kept: each rollup table with its rows, oldest day and retention, and how long the detail rows last. */
export function RetentionPage({ api, onLocked }: { api: AdminApi; onLocked: () => void }) {
  const list = useList<RetentionReply>(api, "/reports/retention", onLocked);
  const data = list.data;
  const failure = list.error ? reportErrorText(new Error(list.error), "what Podium keeps") : null;
  return (
    <>
      <PageHeader title="Data kept" lead="What Podium stores, and for how long. Reports read this, never the live stream alone." />
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
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </Section>
    </>
  );
}
