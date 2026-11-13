// The sections #723 adds to Admin > Reporting (mockup/podium-admin-reporting-cost-tokens.html): what sessions cost per tool call and per session and what the
// sessions that used each tool cost (Tools), the token split and cache hit rate (Spend), and the model and effort mix and how full the context was at the end
// (Sessions). Each reads the costs report for the period the page has and the Harness filter, and exports exactly its own table. A tool has no cost of its
// own, so nothing here says it does. Names of models, efforts, tools and harnesses come from reporters and are drawn as text nodes.
import { useState } from "react";
import { Choice } from "./Page";
import { Pager } from "./Pager";
import { HarnessSelect, ReportChart } from "./ReportParts";
import { formatCell, harnessName, type ReportColumn, type ReportReply, type ReportRow, type ReportsClient } from "./reportsApi";
import { Waiting } from "./ToolsPage";
import { BLOCKED, DataSection, useSection } from "./TimePages";
import type { ReportState } from "./useReport";

const COUNT: ReportColumn = { key: "n", label: "", unit: "count" };
const USD: ReportColumn = { key: "u", label: "", unit: "usd" };
const TOKENS: ReportColumn = { key: "t", label: "", unit: "tokens" };
const PERCENT: ReportColumn = { key: "p", label: "", unit: "percent" };
const count = (v: unknown): string => formatCell(COUNT, v);
const usd = (v: unknown): string => formatCell(USD, v);
const tok = (v: unknown): string => formatCell(TOKENS, v);
const pct = (v: unknown): string => formatCell(PERCENT, v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const list = (v: unknown): ReportRow[] => (Array.isArray(v) ? (v as ReportRow[]) : []);
/** A figure with nothing behind it is a dash in the muted ink, never a zero. */
const cellClass = (v: unknown): string => (v === null || v === undefined ? "n mono muted" : "n mono");
const periodHead = (by: string | null | undefined): string => (by === "month" ? "Month" : by === "day" ? "Day" : "Week of");
const NONE = "No model";

// ---- Tools ------------------------------------------------------------------------------------------

function ModelBody({ reply }: { reply: ReportReply }) {
  const total = reply.total ?? {};
  const rows = reply.rows;
  const unpriced = num(total.unpricedCalls);
  return (
    <>
      <div className="tool alone">
        <div className="sum left">
          <div>
            <span className="big mono">{usd(total.perCallUsd)}</span>
            <span className="cap">per tool call</span>
          </div>
          <div>
            <span className="big mono">{usd(total.perSessionUsd)}</span>
            <span className="cap">per session</span>
          </div>
          <div>
            <span className="big mono">{count(total.pricedCalls)}</span>
            <span className="cap">priced calls</span>
          </div>
          {unpriced > 0 && (
            <div>
              <span className="big mono">{count(unpriced)}</span>
              <span className="cap">calls on a model without a price, left out</span>
            </div>
          )}
        </div>
      </div>
      <div className="tw2">
        <table className="ptab" aria-label="Cost per call by model">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Harness</th>
              <th scope="col" className="n">
                Sessions
              </th>
              <th scope="col" className="n">
                Tool calls
              </th>
              <th scope="col" className="n">
                Spend
              </th>
              <th scope="col" className="n">
                Per call
              </th>
              <th scope="col" className="n">
                Per session
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={`${text(m.model)}/${text(m.harness)}`}>
                <td className="who">{text(m.model) === "-" ? NONE : text(m.model)}</td>
                <td>{harnessName(text(m.harness))}</td>
                <td className="n mono">{count(m.sessions)}</td>
                <td className="n mono">{count(m.calls)}</td>
                <td className={cellClass(m.spendUsd)}>{usd(m.spendUsd)}</td>
                <td className={cellClass(m.perCallUsd)}>{usd(m.perCallUsd)}</td>
                <td className={cellClass(m.perSessionUsd)}>{usd(m.perSessionUsd)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Priced total</th>
              <td />
              <td className="n mono">{count(total.pricedSessions)}</td>
              <td className="n mono">{count(total.pricedCalls)}</td>
              <td className="n mono">{usd(total.spendUsd)}</td>
              <td className="n mono">{usd(total.perCallUsd)}</td>
              <td className="n mono">{usd(total.perSessionUsd)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="note-line">
        <b>A tool has no cost of its own.</b> A model call costs tokens, and a call to a tool is only one step in it, so Podium cannot say what one tool spent. Per call is a
        model&apos;s spend over all its tool calls. A model without a price shows a dash and stays out of the totals.
      </div>
    </>
  );
}

function ToolBody({ reply }: { reply: ReportReply }) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const rows = list(reply.tools);
  const at = Math.min(page, Math.max(1, Math.ceil(rows.length / size)));
  return (
    <>
      <div className="tw2">
        <table className="ptab" aria-label="Sessions that used each tool">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col" className="n">
                Sessions
              </th>
              <th scope="col" className="n">
                Average session spend
              </th>
              <th scope="col" className="n">
                Average calls in it
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice((at - 1) * size, at * size).map((t) => (
              <tr key={text(t.tool)}>
                <td className="who mono">{text(t.tool)}</td>
                <td className="n mono">{count(t.sessions)}</td>
                <td className={cellClass(t.avgSpendUsd)}>{usd(t.avgSpendUsd)}</td>
                <td className={cellClass(t.avgCalls)}>{t.avgCalls === null || t.avgCalls === undefined ? "–" : String(t.avgCalls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager id="rep-costs-tp" page={at} pageSize={size} total={rows.length} onPage={setPage} onSize={(n) => (setSize(n), setPage(1))} />
    </>
  );
}

export function ToolCostSections({ client, r, onLocked }: { client: ReportsClient; r: ReportState; onLocked: () => void }) {
  const model = useSection(client, r, { report: "costs", breakdown: "model", blocked: null }, onLocked);
  const tool = useSection(client, r, { report: "costs", breakdown: "tool", blocked: null }, onLocked);
  const period = `${r.range.from} to ${r.range.to}`;
  return (
    <>
      <DataSection
        id="rep-costs-m"
        title="Cost per tool call and per session"
        help={`Spend divided by the calls and sessions behind it, by model, ${period}. Priced models only.`}
        noun="cost per call "
        s={model}
      >
        <Waiting reply={model.reply} error={model.error} problem={r.problem} empty="No sessions in this period.">
          {(rep) => <ModelBody reply={rep} />}
        </Waiting>
      </DataSection>
      <DataSection
        id="rep-costs-t"
        title="What sessions that used a tool cost"
        help="The average priced spend of a session that called the tool at least once. It says where heavy sessions use a tool, not what the tool cost."
        noun="sessions by tool "
        s={tool}
      >
        <Waiting reply={tool.reply} error={tool.error} problem={r.problem} empty="No tool calls in this period.">
          {(rep) => <ToolBody reply={rep} />}
        </Waiting>
      </DataSection>
    </>
  );
}

// ---- Spend ------------------------------------------------------------------------------------------

function TokenBody({ reply, harness }: { reply: ReportReply; harness: string }) {
  const total = reply.total ?? {};
  const periods = list(reply.periods);
  const byHarness = list(reply.byHarness);
  const col = reply.columns.find((c) => c.key === "cacheHitPct") ?? { key: "cacheHitPct", label: "Cache hit rate", unit: "percent" as const };
  return (
    <>
      <div className="tool alone">
        <div className="sum left">
          <div>
            <span className="big mono">{pct(total.cacheHitPct)}</span>
            <span className="cap">cache hit rate</span>
          </div>
          <div>
            <span className="big mono">{tok(total.tokIn)}</span>
            <span className="cap">input tokens</span>
          </div>
          <div>
            <span className="big mono">{tok(total.tokOut)}</span>
            <span className="cap">output tokens</span>
          </div>
          <div>
            <span className="big mono">{tok(total.tokCr)}</span>
            <span className="cap">read from cache</span>
          </div>
        </div>
      </div>
      <ReportChart rows={periods} valueKey="cacheHitPct" column={col} unit="Cache hit rate" by={reply.by ?? undefined} axis={(v) => `${Math.round(v)}%`} />
      <div className="tw2">
        <table className="ptab" aria-label="Tokens by period">
          <thead>
            <tr>
              <th scope="col">{periodHead(reply.by)}</th>
              <th scope="col" className="n">
                Input
              </th>
              <th scope="col" className="n">
                Output
              </th>
              <th scope="col" className="n">
                Cache read
              </th>
              <th scope="col" className="n">
                Cache write
              </th>
              <th scope="col" className="n">
                Cache hit rate
              </th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={text(p.period)}>
                <td className="who">{text(p.period)}</td>
                <td className="n mono">{tok(p.tokIn)}</td>
                <td className="n mono">{tok(p.tokOut)}</td>
                <td className="n mono">{tok(p.tokCr)}</td>
                <td className="n mono">{tok(p.tokCw)}</td>
                <td className={cellClass(p.cacheHitPct)}>{pct(p.cacheHitPct)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{harness ? `Whole period, ${harnessName(harness)}` : "Whole period, all harnesses"}</th>
              <td className="n mono">{tok(total.tokIn)}</td>
              <td className="n mono">{tok(total.tokOut)}</td>
              <td className="n mono">{tok(total.tokCr)}</td>
              <td className="n mono">{tok(total.tokCw)}</td>
              <td className={cellClass(total.cacheHitPct)}>{pct(total.cacheHitPct)}</td>
            </tr>
            {harness === "" &&
              byHarness.length > 1 &&
              byHarness.map((h) => (
                <tr key={text(h.harness)}>
                  <th scope="row">{harnessName(text(h.harness))}</th>
                  <td className="n mono">{tok(h.tokIn)}</td>
                  <td className="n mono">{tok(h.tokOut)}</td>
                  <td className="n mono">{tok(h.tokCr)}</td>
                  <td className="n mono">{tok(h.tokCw)}</td>
                  <td className={cellClass(h.cacheHitPct)}>{pct(h.cacheHitPct)}</td>
                </tr>
              ))}
          </tfoot>
        </table>
      </div>
      <div className="note-line">
        <b>Cache hit rate</b> is the tokens read from the cache over all the input the model was given: input, cache read and cache write. A harness that does not report
        cache tokens counts as none, so it lowers the rate. Cost estimates are unchanged.
      </div>
    </>
  );
}

export function TokenSection({ client, r, onLocked }: { client: ReportsClient; r: ReportState; onLocked: () => void }) {
  const [harness, setHarness] = useState("");
  const blocked = r.prefs.person || r.prefs.group ? BLOCKED : null;
  const s = useSection(client, r, { report: "costs", breakdown: "tokens", by: true, harness, blocked }, onLocked);
  return (
    <DataSection
      id="rep-costs-k"
      title="Tokens and cache hit rate"
      help={`How many tokens went in, came out and were served from the cache, ${r.range.from} to ${r.range.to}.`}
      noun="tokens "
      s={s}
    >
      <div className="tool">
        <HarnessSelect value={harness} ids={s.reply?.harnesses ?? []} onChange={setHarness} />
      </div>
      {blocked ? (
        <div className="note-line">{blocked}</div>
      ) : (
        <Waiting reply={s.reply} error={s.error} problem={r.problem} empty="No sessions in this period.">
          {(rep) => <TokenBody reply={rep} harness={harness} />}
        </Waiting>
      )}
    </DataSection>
  );
}

// ---- Sessions ---------------------------------------------------------------------------------------

function MixBody({ reply, mixOf }: { reply: ReportReply; mixOf: string }) {
  const cells = list(reply.combined);
  const keyed = (c: ReportRow): string => text(c[mixOf]);
  const keys = [...new Set(cells.map(keyed))];
  // the keys with the most sessions over the period come first, and the long tail folds into one column
  const weight = new Map<string, number>();
  for (const c of cells) weight.set(keyed(c), (weight.get(keyed(c)) ?? 0) + num(c.sessions));
  const ordered = keys.sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0) || (a < b ? -1 : 1));
  const SHOWN = 3;
  const named = ordered.length > SHOWN + 1 ? ordered.slice(0, SHOWN) : ordered;
  const rest = ordered.filter((k) => !named.includes(k));
  const label = (k: string): string => (k === "-" ? (mixOf === "model" ? NONE : "Not reported") : k);
  const periods = list(reply.periods);
  const shareOf = (period: string, ks: string[]): number | null => {
    const all = num(periods.find((p) => text(p.period) === period)?.sessions);
    if (all === 0) return null;
    return Math.round((ks.reduce((n, k) => n + num(cells.find((c) => text(c.period) === period && keyed(c) === k)?.sessions), 0) / all) * 100);
  };
  const whole = num(reply.total?.sessions);
  const wholeShare = (ks: string[]): number | null => (whole === 0 ? null : Math.round((ks.reduce((n, k) => n + (weight.get(k) ?? 0), 0) / whole) * 100));
  const shown = (v: number | null): string => (v === null ? "–" : `${v}%`);
  return (
    <>
      <div className="tw2">
        <table className="ptab" aria-label={`${mixOf === "model" ? "Model" : "Effort"} mix by period`}>
          <thead>
            <tr>
              <th scope="col">{periodHead(reply.by)}</th>
              <th scope="col" className="n">
                Sessions
              </th>
              {named.map((k) => (
                <th key={k} scope="col" className="n">
                  {label(k)}
                </th>
              ))}
              {rest.length > 0 && (
                <th scope="col" className="n">
                  {`Other, ${rest.length} ${mixOf === "model" ? "models" : "efforts"}`}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={text(p.period)}>
                <td className="who">{text(p.period)}</td>
                <td className="n mono">{count(p.sessions)}</td>
                {named.map((k) => (
                  <td key={k} className="n mono">
                    {shown(shareOf(text(p.period), [k]))}
                  </td>
                ))}
                {rest.length > 0 && <td className="n mono">{shown(shareOf(text(p.period), rest))}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Whole period</th>
              <td className="n mono">{count(whole)}</td>
              {named.map((k) => (
                <td key={k} className="n mono">
                  {shown(wholeShare([k]))}
                </td>
              ))}
              {rest.length > 0 && <td className="n mono">{shown(wholeShare(rest))}</td>}
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="note-line">
        A session counts once, on the day it was last seen, under the {mixOf === "model" ? "model" : "effort"} it ended on. Each row adds up to 100%, rounded.
        {mixOf === "effort" && " A harness that reports no effort shows as Not reported."}
      </div>
    </>
  );
}

function ContextBody({ reply, harness }: { reply: ReportReply; harness: string }) {
  const t = reply.total ?? {};
  const low = num(t.endedLow);
  const mid = num(t.endedMid);
  const high = num(t.endedHigh);
  const known = low + mid + high;
  const share = (n: number): string => (known > 0 ? `${Math.round((n / known) * 100)}%` : "–");
  const byHarness = list(reply.byHarness);
  return (
    <>
      <div className="tool alone">
        <div className="sum left">
          <div>
            <span className="big mono">{count(high)}</span>
            <span className="cap">sessions ended above 80%</span>
          </div>
          <div>
            <span className="big mono">{pct(t.endedHighPct)}</span>
            <span className="cap">of sessions with a context size ended above 80%</span>
          </div>
          <div>
            <span className="big mono">{count(t.compacted)}</span>
            <span className="cap">sessions compacted on their own</span>
          </div>
          <div>
            <span className="big mono">{count(t.cleared)}</span>
            <span className="cap">sessions continued after /clear</span>
          </div>
        </div>
      </div>
      <div className="tw2">
        <table className="ptab" aria-label="Context fullness at the end">
          <thead>
            <tr>
              <th scope="col">Context used at the end</th>
              <th scope="col" className="n">
                Sessions
              </th>
              <th scope="col" className="n">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="who">Under 50%</td>
              <td className="n mono">{count(low)}</td>
              <td className="n mono">{share(low)}</td>
            </tr>
            <tr>
              <td className="who">50% to 80%</td>
              <td className="n mono">{count(mid)}</td>
              <td className="n mono">{share(mid)}</td>
            </tr>
            <tr>
              <td className="who">Above 80%</td>
              <td className="n mono">{count(high)}</td>
              <td className="n mono">{share(high)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{harness ? `Total, ${harnessName(harness)}` : "Total, all harnesses"}</th>
              <td className="n mono">{count(known)}</td>
              <td className="n mono">{known > 0 ? "100%" : "–"}</td>
            </tr>
            {harness === "" &&
              byHarness.length > 1 &&
              byHarness.map((h) => (
                <tr key={text(h.harness)}>
                  <th scope="row">{harnessName(text(h.harness))}</th>
                  <td className="n mono">{count(num(h.endedLow) + num(h.endedMid) + num(h.endedHigh))}</td>
                  <td className="n mono">{pct(h.endedHighPct)} above 80%</td>
                </tr>
              ))}
          </tfoot>
        </table>
      </div>
      <div className="note-line">
        Sessions are counted on the day they were last seen, by the context window as it stood in their last report.
        {num(t.endedUnknown) > 0 && ` ${count(t.endedUnknown)} ${num(t.endedUnknown) === 1 ? "session" : "sessions"} reported no context size and ${num(t.endedUnknown) === 1 ? "is" : "are"} left out of the rows above.`}{" "}
        Compacted counts sessions Claude Code compacted on its own while its events are kept, 30 days; a /compact you ran yourself is not counted. A session that continued after
        /clear starts again under a new session id, so each /clear is counted once, on the session it started.
      </div>
    </>
  );
}

export function MixSections({ client, r, onLocked }: { client: ReportsClient; r: ReportState; onLocked: () => void }) {
  const [mixOf, setMixOf] = useState<"model" | "effort">("model");
  const blocked = r.prefs.person || r.prefs.group || r.prefs.model ? BLOCKED : null;
  const mix = useSection(client, r, { report: "costs", breakdown: "mix", mixof: mixOf, by: true, blocked }, onLocked);
  const context = useSection(client, r, { report: "costs", breakdown: "context", by: true, blocked }, onLocked);
  const period = `${r.range.from} to ${r.range.to}`;
  const blockedLine = blocked && <div className="note-line">{blocked}</div>;
  return (
    <>
      <DataSection
        id="rep-costs-x"
        title="Model and effort mix"
        help={`Each ${r.prefs.by}, the share of sessions on each model, and the share at each effort. ${period}.`}
        noun={`${mixOf} mix `}
        s={mix}
      >
        <div className="tool">
          <Choice
            label="Mix of"
            value={mixOf}
            options={[
              ["model", "Model"],
              ["effort", "Effort"],
            ]}
            onChange={setMixOf}
          />
        </div>
        {blockedLine ?? (
          <Waiting reply={mix.reply} error={mix.error} problem={r.problem} empty="No sessions in this period.">
            {(rep) => <MixBody reply={rep} mixOf={mixOf} />}
          </Waiting>
        )}
      </DataSection>
      <DataSection
        id="rep-costs-c"
        title="Context fullness at the end"
        help={`How full the context window was when a session ended, and how many sessions compacted or continued after /clear. ${period}.`}
        noun="context at the end "
        s={context}
      >
        {blockedLine ?? (
          <Waiting reply={context.reply} error={context.error} problem={r.problem} empty="No sessions in this period.">
            {(rep) => <ContextBody reply={rep} harness={r.prefs.harness} />}
          </Waiting>
        )}
      </DataSection>
    </>
  );
}
