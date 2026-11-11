// My usage (#726, mockup/podium-my-usage.html): a signed-in person's own spend, sessions, failures and tool calls. It is built from the Admin Reporting parts (the
// period and filters, the chart, the table, the pager and the CSV and JSON), pointed at /respond/usage/<report>. Whose figures these are is decided by the server from the
// sign-in; nothing here sends a person, a group or an id, and no Admin control (person, group, model) is offered.
import { useEffect, useState } from "react";
import { AdminError } from "./admin/adminApi";
import { PageHeader, Panel, Section } from "./admin/Page";
import { Pager } from "./admin/Pager";
import { partialText, ReportBody, ReportExport, ReportFilters, ReportTable } from "./admin/ReportParts";
import { type ReportsClient } from "./admin/reportsApi";
import { Waiting } from "./admin/ToolsPage";
import { DataSection, useSection, type SectionState, type Spec } from "./admin/TimePages";
import { useReport, type ReportConfig } from "./admin/useReport";
import { Blank } from "./components/Blank";
import type { RespondMe } from "./types";

const BASE = "/api/fleet/respond/usage";

/** The reports client for the person's own routes. The reports ask for `/reports/<name>`; here that is `/<name>` under the respond routes. */
export function myUsageClient(base: string = BASE): ReportsClient {
  const url = (path: string) => `${base}${path.replace(/^\/reports/, "")}`;
  const fetchOk = async (path: string) => {
    const res = await fetch(url(path), { credentials: "same-origin", headers: { "X-Podium-Respond": "1" } });
    if (!res.ok) throw new AdminError(res.status, `HTTP ${res.status}`);
    return res;
  };
  return {
    get: async <T,>(path: string) => (await (await fetchOk(path)).json()) as T,
    text: async (path: string) => (await fetchOk(path)).text(),
  };
}

const LIVE = myUsageClient();

const MY_SPEND: ReportConfig = {
  report: "spend",
  prefsKey: "my-spend",
  title: "Spend",
  lead: "What your own sessions cost, how they ended and what failed. Only you can see this page.",
  hasBy: true,
  // The Harness filter narrows the tool calls: spend is not kept per harness, and the page says so.
  filters: ["harness"],
  extraHarness: true,
  breakdowns: [
    ["model", "Model"],
    ["none", "Total only"],
    ["project", "Project"],
  ],
  chart: { key: "costUsd", unit: "Estimated spend" },
  summary: [
    { key: "costUsd", caption: "spent in this period" },
    { key: "sessions", caption: "sessions started" },
  ],
  help: "Estimated from tokens, not a bill. A model without a price shows a dash",
};

const noop = (): void => undefined;

/** A section whose table is one more report for the period, with the pager and the CSV and JSON of exactly that table. */
function Own(props: { id: string; title: string; help: string; noun: string; label: string; s: SectionState; problem: string | null; empty: string; history?: boolean; breakdown: string; note?: string }) {
  const { s } = props;
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  // A new period, grouping or harness is a new table: start it on its first page, as the Admin pages do.
  useEffect(() => setPage(1), [s.reply]);
  return (
    <DataSection id={props.id} title={props.title} help={props.help} noun={props.noun} s={s}>
      {s.reply?.partial && (
        <div className="partial" role="status">
          {partialText(s.reply)}
        </div>
      )}
      <Waiting reply={s.reply} error={s.error} problem={props.problem} empty={props.empty}>
        {(reply) => (
          <>
            <ReportTable reply={reply} label={props.label} page={page} pageSize={pageSize} history={props.history === true} breakdown={props.breakdown} />
            <Pager
              id={props.id}
              page={page}
              pageSize={pageSize}
              total={reply.rows.length}
              onPage={setPage}
              onSize={(n) => {
                setPageSize(n);
                setPage(1);
              }}
            />
          </>
        )}
      </Waiting>
      {props.note && <div className="note-line">{props.note}</div>}
    </DataSection>
  );
}

function Reports({ client }: { client: ReportsClient }) {
  const r = useReport(client, MY_SPEND, noop);
  /** Every section follows the page's By (day, week or month) and its period. */
  const spec = (report: Spec["report"], breakdown: string): Spec => ({ report, breakdown, by: true, blocked: null });
  const project = useSection(client, r, spec("spend", "project"), noop);
  const sessions = useSection(client, r, spec("sessions", "outcome"), noop);
  const failures = useSection(client, r, spec("failures", "class"), noop);
  const tools = useSection(client, r, spec("tools", "tool"), noop);
  const { prefs, range, problem } = r;
  const period = `${range.from} to ${range.to}`;
  return (
    <>
      <PageHeader title="My usage" lead={MY_SPEND.lead} actions={<ReportExport r={r} noun="spend " />} />
      <Section id="my-f" title="Period and filters">
        <Panel>
          <ReportFilters client={client} r={r} harnesses={tools.reply?.harnesses} />
          <div className="note-line">
            <b>Only your own sessions.</b> The Harness filter narrows Tool calls; spend, sessions and failures cover every harness.
          </div>
        </Panel>
      </Section>
      <Section id="my-spend" title={`Spend by ${prefs.by}`} help={problem ? MY_SPEND.help : `${MY_SPEND.help}, ${period}.`}>
        <Panel>
          <ReportBody r={r} />
          <div className="note-line">Shares are of your own total. No other person's or group's figure is shown.</div>
        </Panel>
      </Section>
      {!problem && (
        <>
          <Own id="my-project" title="Spend by project" help={`Each project your sessions ran in. ${period}.`} noun="spend by project " label="Spend by project" s={project} problem={problem} empty="No spend was recorded in this period." breakdown="project" />
          <Own
            id="my-sessions"
            title="Sessions by outcome"
            help={`How your sessions ended, how long they ran and how full their context got. ${period}.`}
            noun="sessions by outcome "
            label="Sessions by outcome"
            s={sessions}
            problem={problem}
            empty="No sessions of yours in this period."
            breakdown="outcome"
            note="Built from your stored sessions, which are kept for about a month."
          />
          <Own id="my-failures" title="Failures" help={`Each row opens History for your sessions from the last 30 days. Older ones have counts only. ${period}.`} noun="failures " label="Failures" s={failures} problem={problem} empty="No failures were recorded in this period." history breakdown="class" />
          <Own
            id="my-tools"
            title="Tool calls"
            help={`Names and counts only. No arguments, paths or text are kept. ${period}.`}
            noun="tool calls "
            label="Tool calls"
            s={tools}
            problem={problem}
            empty="No tool calls were recorded in this period."
            breakdown="tool"
            note="Built from your stored sessions, which are kept for about a month."
          />
        </>
      )}
    </>
  );
}

/** `on` is the Admin's My usage setting from the console's stream, null until the stream has said; `me` is the sign-in. With the setting off the page does not exist, as the server answers. */
export function MyUsagePage({ me, on, client = LIVE }: { me: RespondMe | null; on: boolean | null; client?: ReportsClient }) {
  const gone = on === false || me?.enabled === false;
  let body: React.ReactNode;
  if (on === null) {
    body = <div className="hint">Loading…</div>;
  } else if (gone) {
    body = <Blank title="Page not found">There is nothing at this address. Go back to the wall.</Blank>;
  } else if (!me) {
    body = <div className="hint">Loading…</div>;
  } else if (!me.signedIn) {
    body = (
      <Blank title="Sign in to see your usage">
        My usage shows only your own figures, so Podium needs to know who you are. Use Sign in at the top right, with your name and your token, then open My usage again.
      </Blank>
    );
  } else {
    body = <Reports client={client} />;
  }
  const full = on === true && !gone && me?.signedIn === true;
  return (
    <main className="adminv" aria-label="My usage">
      <div className="apage">
        <div className="apage-in">
          {full ? (
            body
          ) : (
            <>
              <PageHeader title={gone ? "Page not found" : "My usage"} lead={gone ? "" : MY_SPEND.lead} />
              {body}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
