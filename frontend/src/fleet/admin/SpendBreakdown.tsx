// What a Spend today row is made of (#482): the same "since midnight" figure cut by session, by model, and orchestrator
// against agents, each adding up to the row. A group opens with its people first. Names are text nodes.
import { useEffect, useRef, useState } from "react";
import { sharePct } from "../people";
import { AdminError } from "./adminApi";
import { Panel } from "./Page";
import { DASH, fmtMoney, reportErrorText, ymd, type BreakdownReply, type ReportsClient } from "./reportsApi";

export interface OpenBreakdown {
  /** The row it belongs to, so the row can say it is expanded. */
  key: string;
  /** The route's `:owner`: a name, `Admin`, or `-` for sessions with no owner. */
  owner: string;
  group: boolean;
  label: string;
}

const amount = (v: number | { costUsd: number | null } | null | undefined): number | null => (typeof v === "number" ? v : (v?.costUsd ?? null));
const share = (part: number | null, total: number | null): string => (part === null || total === null ? DASH : `${sharePct(part, total)}%`);

function Money({ v }: { v: number | null }) {
  return <td className={`n mono${v === null ? " muted" : ""}`}>{fmtMoney(v)}</td>;
}

export function SpendBreakdown(props: { client: ReportsClient; open: OpenBreakdown; onClose: () => void; onOpenPerson: (owner: string) => void; onLocked: () => void }) {
  const { client, open, onLocked } = props;
  const [data, setData] = useState<BreakdownReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const lock = useRef(onLocked);
  lock.current = onLocked;
  // Focus moves to the heading when a breakdown opens, so a keyboard or screen reader user lands on it.
  useEffect(() => {
    heading.current?.focus();
  }, [open.key, open.owner, open.group]);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    client.get<BreakdownReply>(`/reports/spend/today/${encodeURIComponent(open.owner)}${open.group ? "?group=1" : ""}`).then(
      (d) => live && setData(d),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof AdminError && e.status === 401) lock.current();
        else setError(reportErrorText(e, `${open.label}'s spend`));
      },
    );
    return () => {
      live = false;
    };
  }, [client, open.owner, open.group, open.label, tick]);

  const today = ymd(new Date());
  const total = data ? data.total : null;
  const unpriced = data?.unpriced ?? 0;
  return (
    <section className="asec" id="spend-bd" aria-labelledby="spend-bd-h">
      <div className="asec-h">
        <div>
          <h2 id="spend-bd-h" tabIndex={-1} ref={heading}>
            {open.label}, spend today
          </h2>
          <p className="hint">{data ? `${fmtMoney(total)} since midnight, cut three ways. Each cut adds up to the row.` : "Since midnight on the server, cut three ways."}</p>
        </div>
        <button type="button" className="btn sm" onClick={props.onClose}>
          Close
        </button>
      </div>
      <Panel>
        {error && (
          <div className="err" role="alert">
            {error}{" "}
            <button type="button" className="btn sm" onClick={() => setTick((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {!data && !error && <div className="empty">Loading…</div>}
        {data && (
          <>
            {data.byPerson && data.byPerson.length > 0 && (
              <div className="tw2">
                <table className="ptab" aria-label="By person">
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col" className="n">
                        Spent today
                      </th>
                      <th scope="col" className="n">
                        Share
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byPerson.map((p) => (
                      <tr key={p.owner}>
                        <td className="who">
                          <button type="button" className="rowbtn" onClick={() => props.onOpenPerson(p.owner)}>
                            {p.owner === "-" ? "No owner" : p.owner}
                          </button>
                        </td>
                        <Money v={p.costUsd} />
                        <td className="n mono">{share(p.costUsd, total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="tw2">
              <table className="ptab" aria-label="By session">
                <thead>
                  <tr>
                    <th scope="col">Session</th>
                    <th scope="col">Model</th>
                    <th scope="col" className="n">
                      Spent today
                    </th>
                    <th scope="col" className="n">
                      Share
                    </th>
                    <th scope="col">
                      <span className="sr-only">History</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.bySession.map((s) => (
                    <tr key={s.id}>
                      <td className="who">{s.name}</td>
                      <td>{s.model}</td>
                      <Money v={s.costUsd} />
                      <td className={`n mono${s.costUsd === null ? " muted" : ""}`}>{share(s.costUsd, total)}</td>
                      <td>
                        <a className="klink" href={`#/history?day=${today}&page=1&size=50&open=${encodeURIComponent(s.id)}`} aria-label={`Open ${s.name} in History`}>
                          Open
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Total</th>
                    <td />
                    <td className="n mono">{fmtMoney(total)}</td>
                    <td className="n mono">{total === null ? DASH : "100%"}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="tool alone cuts">
              <div className="f cut">
                <span className="lab">By model</span>
                <div className="mono">
                  {data.byModel.map((m) => (
                    <div key={m.model} className={m.costUsd === null ? "muted" : undefined}>
                      {m.model} <b>{fmtMoney(m.costUsd)}</b>
                      {m.costUsd !== null && ` (${share(m.costUsd, total)})`}
                    </div>
                  ))}
                </div>
              </div>
              <div className="f cut">
                <span className="lab">Orchestrator and agents</span>
                <div className="mono">
                  <div>
                    Orchestrator <b>{fmtMoney(amount(data.bySource.orchestrator))}</b> ({share(amount(data.bySource.orchestrator), total)})
                  </div>
                  <div>
                    Agents <b>{fmtMoney(amount(data.bySource.agents))}</b> ({share(amount(data.bySource.agents), total)})
                  </div>
                </div>
              </div>
            </div>
            {unpriced > 0 && (
              <div className="note-line">
                Plus {unpriced} {unpriced === 1 ? "session" : "sessions"} on {unpriced === 1 ? "a model" : "models"} without a price. {unpriced === 1 ? "It is" : "They are"} left out of the sums, so the priced parts add up to {fmtMoney(total)}.
              </div>
            )}
          </>
        )}
      </Panel>
    </section>
  );
}
