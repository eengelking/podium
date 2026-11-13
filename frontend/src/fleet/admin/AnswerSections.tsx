// The sections #725 adds to Admin > Reporting > Sessions (mockup/podium-admin-reporting-answers.html): how often sessions were answered from Podium, by kind, and how
// long they had waited when the answer was sent. Both read the sessiontime report for the period the page has and the Harness filter, and each exports exactly its
// own table. Only a kind, a day, a harness and a wait are kept: never what was said. Harness names come from reporters and are drawn as text nodes.
import { useState } from "react";
import { Pager } from "./Pager";
import { ReportChart } from "./ReportParts";
import { formatCell, harnessName, type ReportColumn, type ReportReply, type ReportRow, type ReportsClient } from "./reportsApi";
import { BLOCKED, DataSection, useSection } from "./TimePages";
import type { ReportState } from "./useReport";

const COUNT: ReportColumn = { key: "n", label: "", unit: "count" };
const SECONDS: ReportColumn = { key: "s", label: "", unit: "seconds" };
const count = (v: unknown): string => formatCell(COUNT, v);
const dur = (v: unknown): string => formatCell(SECONDS, v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const list = (v: unknown): ReportRow[] => (Array.isArray(v) ? (v as ReportRow[]) : []);
/** A figure with nothing behind it is a dash in the muted ink, never a zero. */
const cellClass = (v: unknown): string => (v === null || v === undefined ? "n mono muted" : "n mono");
const periodHead = (by: string | null | undefined): string => (by === "month" ? "Month" : by === "day" ? "Day" : "Week of");
/** The wait a message has none of: it goes to a session that is not waiting. */
const NO_WAIT = "A message is sent to a session that is not waiting, so it has no wait";

const KIND_NAMES: Record<string, string> = { permission: "Permission for a tool", question: "A question", plan: "A plan", message: "A message" };

/**
 * Loading, an error and a bad period as `Waiting` says them, but the body is drawn whenever the reply is there and `empty` is false: a period that only has messages, or that starts
 * before counting began, has no rows with a wait but still has figures and a note to show.
 */
function Loaded({ reply, error, problem, empty, none, children }: { reply: ReportReply | null; error: string | null; problem: string | null; empty: (r: ReportReply) => boolean; none: string; children: (r: ReportReply) => React.ReactNode }) {
  if (problem) return <div className="empty">Fix the period above to see the report.</div>;
  if (error) {
    return (
      <div className="err" role="alert">
        {error}
      </div>
    );
  }
  if (!reply) return <div className="empty">Loading…</div>;
  return empty(reply) ? <div className="empty">{none}</div> : <>{children(reply)}</>;
}

/** When counting began, if that is after the period starts: the periods before it show a dash. */
function since(reply: ReportReply): string {
  const day = text(reply.answersSince);
  return day !== "" && day > reply.from ? day : "";
}

function SinceNote({ reply }: { reply: ReportReply }) {
  const day = since(reply);
  if (day === "") return null;
  return (
    <div className="note-line">
      <b>Answers are recorded from {day},</b> when Podium was upgraded to this release. Earlier periods show a dash, and the totals count only the periods that have them.
    </div>
  );
}

/** Newest first, a page at a time, as the other period tables are. */
function usePaged(rows: ReportRow[]) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const newest = [...rows].reverse();
  const at = Math.min(page, Math.max(1, Math.ceil(newest.length / size)));
  return { shown: newest.slice((at - 1) * size, at * size), page: at, size, total: newest.length, setPage, setSize: (n: number) => (setSize(n), setPage(1)) };
}

function AnswersBody({ reply, harness }: { reply: ReportReply; harness: string }) {
  const total = reply.total ?? {};
  const byHarness = list(reply.byHarness);
  const periods = list(reply.periods);
  const paged = usePaged(periods);
  const late = since(reply) !== "";
  const kinds = ["permission", "question", "plan", "message", "all"] as const;
  const row = (r: ReportRow) => kinds.map((k) => (
    <td key={k} className={cellClass(r[k])}>
      {count(r[k])}
    </td>
  ));
  return (
    <>
      <div className="tool alone">
        <div className="sum left">
          <div>
            <span className="big mono">{count(total.all)}</span>
            <span className="cap">{late ? `answers sent, since ${since(reply)}` : "answers sent"}</span>
          </div>
          <div>
            <span className="big mono">{count(total.permission)}</span>
            <span className="cap">tool permissions</span>
          </div>
          <div>
            <span className="big mono">{count(total.question)}</span>
            <span className="cap">questions answered</span>
          </div>
          <div>
            <span className="big mono">{count(total.plan)}</span>
            <span className="cap">plans answered</span>
          </div>
        </div>
      </div>
      <ReportChart rows={periods} valueKey="all" column={{ key: "all", label: "Answers", unit: "count" }} unit="Answers sent through Podium" by={reply.by ?? undefined} />
      <div className="tw2">
        <table className="ptab" aria-label={`Answers sent through Podium by ${reply.by ?? "week"}`}>
          <thead>
            <tr>
              <th scope="col">{periodHead(reply.by)}</th>
              <th scope="col" className="n">
                Permission
              </th>
              <th scope="col" className="n">
                Question
              </th>
              <th scope="col" className="n">
                Plan
              </th>
              <th scope="col" className="n">
                Message
              </th>
              <th scope="col" className="n">
                All
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.shown.map((p) => (
              <tr key={text(p.period)}>
                <td className="who">{text(p.period)}</td>
                {row(p)}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{harness ? `Whole period, ${harnessName(harness)}` : "Whole period, all harnesses"}</th>
              {row(total)}
            </tr>
            {harness === "" &&
              byHarness.length > 1 &&
              byHarness.map((h) => (
                <tr key={text(h.harness)}>
                  <th scope="row">{harnessName(text(h.harness))}</th>
                  {row(h)}
                </tr>
              ))}
          </tfoot>
        </table>
      </div>
      <Pager id="rep-answers-p" page={paged.page} pageSize={paged.size} total={paged.total} onPage={paged.setPage} onSize={paged.setSize} />
      <SinceNote reply={reply} />
      <div className="note-line">
        Only the kind and the time of each answer are kept, never what was said. An answer given in the terminal is not counted, and neither is a message sent from Chat: this is how much the console is used to answer
        sessions, not how many asks there were.
      </div>
    </>
  );
}

function WaitBody({ reply, harness }: { reply: ReportReply; harness: string }) {
  const total = reply.total ?? {};
  const byHarness = list(reply.byHarness);
  const paged = usePaged(list(reply.periods));
  const wait = (r: ReportRow) => (
    <>
      <td className={cellClass(r.medianS)}>{dur(r.medianS)}</td>
      <td className={cellClass(r.p90S)}>{dur(r.p90S)}</td>
    </>
  );
  return (
    <>
      <div className="tool alone">
        <div className="sum left">
          <div>
            <span className="big mono">{dur(total.medianS)}</span>
            <span className="cap">median wait</span>
          </div>
          <div>
            <span className="big mono">{dur(total.p90S)}</span>
            <span className="cap">90th percentile</span>
          </div>
        </div>
      </div>
      <div className="tw2">
        <table className="ptab" aria-label="Wait before an answer, by kind">
          <thead>
            <tr>
              <th scope="col">Answer to</th>
              <th scope="col" className="n">
                Answers
              </th>
              <th scope="col" className="n">
                Median wait
              </th>
              <th scope="col" className="n">
                90th percentile
              </th>
            </tr>
          </thead>
          <tbody>
            {list(reply.kinds).map((k) => (
              <tr key={text(k.kind)}>
                <td className="who">{KIND_NAMES[text(k.kind)] ?? text(k.kind)}</td>
                {text(k.kind) === "message" ? (
                  <>
                    <td className="n mono muted" title={NO_WAIT}>
                      –
                    </td>
                    <td className="n mono muted" title={NO_WAIT}>
                      –
                    </td>
                    <td className="n mono muted" title={NO_WAIT}>
                      –
                    </td>
                  </>
                ) : (
                  <>
                    <td className="n mono">{count(k.answers)}</td>
                    {wait(k)}
                  </>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{harness ? `Whole period, ${harnessName(harness)}` : "Whole period, all harnesses"}</th>
              <td className="n mono">{count(total.answers)}</td>
              {wait(total)}
            </tr>
            {harness === "" &&
              byHarness.length > 1 &&
              byHarness.map((h) => (
                <tr key={text(h.harness)}>
                  <th scope="row">{harnessName(text(h.harness))}</th>
                  <td className="n mono">{count(h.answers)}</td>
                  {wait(h)}
                </tr>
              ))}
          </tfoot>
        </table>
      </div>
      <div className="tw2">
        <table className="ptab" aria-label={`Wait before an answer, by ${reply.by ?? "week"}`}>
          <thead>
            <tr>
              <th scope="col">{periodHead(reply.by)}</th>
              <th scope="col" className="n">
                Answers
              </th>
              <th scope="col" className="n">
                Median wait
              </th>
              <th scope="col" className="n">
                90th percentile
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.shown.map((p) => (
              <tr key={text(p.period)}>
                <td className="who">{text(p.period)}</td>
                <td className={cellClass(p.answers)}>{count(p.answers)}</td>
                {wait(p)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager id="rep-answerwait-p" page={paged.page} pageSize={paged.size} total={paged.total} onPage={paged.setPage} onSize={paged.setSize} />
      <SinceNote reply={reply} />
      <div className="note-line">
        Times are minutes and seconds. A wait is counted only when someone answered from Podium: an ask answered in the terminal, one that closed unanswered, and a message (which
        goes to a session that is not waiting) have no wait here. A wait is counted from when Podium first heard of the ask, so one still open when the server restarts counts from the restart. The median and the 90th percentile are read from time classes, so they can be a few seconds off.
      </div>
    </>
  );
}

export function AnswerSections({ client, r, onLocked }: { client: ReportsClient; r: ReportState; onLocked: () => void }) {
  const { prefs } = r;
  const blocked = prefs.person || prefs.group || prefs.model ? BLOCKED : null;
  const answers = useSection(client, r, { report: "sessiontime", breakdown: "answers", by: true, blocked }, onLocked);
  const wait = useSection(client, r, { report: "sessiontime", breakdown: "answerwait", by: true, blocked }, onLocked);
  const period = `${r.range.from} to ${r.range.to}`;
  const blockedLine = blocked && <div className="note-line">{blocked}</div>;
  return (
    <>
      <DataSection
        id="rep-sessiontime-answers"
        title="Answers sent through Podium"
        help={`Each time someone answered a session from the console: a question, a plan, a tool's permission, or a message. ${period}.`}
        noun="answers sent "
        s={answers}
      >
        {blockedLine ?? (
          <Loaded reply={answers.reply} error={answers.error} problem={r.problem} empty={(rep) => rep.rows.length === 0 && !rep.partial} none="No answers were sent from Podium in this period.">
            {(rep) => <AnswersBody reply={rep} harness={prefs.harness} />}
          </Loaded>
        )}
      </DataSection>
      <DataSection
        id="rep-sessiontime-answerwait"
        title="How long sessions waited for an answer"
        help="From the moment a session asked until the answer was sent from Podium. Half of the waits were shorter than the median; nine in ten were shorter than the 90th percentile."
        noun="wait before an answer "
        s={wait}
      >
        {blockedLine ?? (
          <Loaded
            reply={wait.reply}
            error={wait.error}
            problem={r.problem}
            empty={(rep) => rep.rows.length === 0 && !rep.partial && list(rep.kinds).every((k) => num(k.answers) === 0)}
            none="No answers were sent from Podium in this period."
          >
            {(rep) => <WaitBody reply={rep} harness={prefs.harness} />}
          </Loaded>
        )}
      </DataSection>
    </>
  );
}
