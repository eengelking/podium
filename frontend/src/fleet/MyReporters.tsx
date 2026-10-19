// My reporters (#347, #415, SPEC 8.1, mockup/podium-my-reporters.html): a console page for a person signed in to respond.
// It mirrors Admin > Reporters for that person's own reporters, in the Admin page layout under the console's top bar, and
// is where they decide which of their reporters may see and message each other. Messaging joins one person's own
// reporters only; the server refuses anything else whatever this page sends. Text an orchestrator wrote (a reason, a
// message waiting for approval) is drawn as text nodes.
import { useCallback, useState } from "react";
import "./admin/admin.css";
import { PageHeader, Panel, Section } from "./admin/Page";
import { ago } from "./admin/ReportersTab";
import { AnswerBack, LayoutSwitch, QuotedText, RightsBoard, RightsGrid, Segmented, SystemTag, useRightsLayout } from "./components/PeerRights";
import { asksBack, keyOfMachine, LEVEL_LABEL, reporterLook, rightsModel, rightWords, withRight, type PeerDefaults, type PeerLevel, type PeerRequestView, type PeersRead } from "./peers";
import type { PeersApi } from "./respondApi";
import { ADMIN } from "./people";
import type { MyPeers } from "./useMyPeers";
import type { RespondMe, SessionView } from "./types";

const LEAD = "The machines that report your sessions to this server, and which of them may message each other.";

/** Why the page cannot show the person's reporters, as a dashed block with a heading. */
function Blank({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="kb-blank">
      <b>{title}</b>
      <p className="hint">{children}</p>
    </div>
  );
}

const ON_REQUEST = [
  { id: "ask", label: "Ask me" },
  { id: "allow", label: "Allow" },
  { id: "decline", label: "Decline" },
] as const;
const NEW_SEND = [
  { id: "ask", label: "With approval" },
  { id: "send", label: "Without approval" },
] as const;

export function MyReportersPage(props: { me: RespondMe | null; peersOn: boolean; peers: MyPeers; api: PeersApi; sessions: Record<string, SessionView>; now: number }) {
  const { me, peers } = props;
  let body: React.ReactNode;
  if (!props.peersOn || me?.enabled === false) {
    body = <Blank title="Orchestrator messaging is off">An Admin turns it on in Admin &gt; Settings &gt; Feature flags. Until then there is nothing to set here.</Blank>;
  } else if (!me) {
    body = <div className="hint">Loading…</div>;
  } else if (!me.signedIn) {
    body = (
      <Blank title="Sign in to see your reporters">
        Use Sign in at the top right, with your name and token: the same ones as your podium-reporter's userName and token options.
      </Blank>
    );
  } else if (me.name?.toLowerCase() === ADMIN.toLowerCase()) {
    body = <Blank title="The admin secret has no reporters">Its sessions belong to no one, so nothing here applies to it. Sign out, then sign in with your own name and token.</Blank>;
  } else if (peers.loadError?.status === 403 && !peers.data) {
    body = <Blank title="Nothing to show">{capital(peers.loadError.text)}.</Blank>;
  } else if (!peers.data) {
    body = peers.loadError ? (
      <div className="errbox" role="alert">
        Could not load your reporters: {peers.loadError.text}. It tries again by itself every few seconds.
      </div>
    ) : (
      <div className="hint">Loading…</div>
    );
  } else if (!peers.data.reporters.length) {
    body = <Blank title="No reporters yet">A machine shows here once it reports with your name and token. Set both in its podium-reporter options.</Blank>;
  } else {
    body = <Owner data={peers.data} peers={peers} api={props.api} sessions={props.sessions} now={props.now} />;
  }
  return (
    <main className="adminv" aria-label="My reporters">
      <div className="apage">
        <div className="apage-in">
          <PageHeader title="My reporters" lead={peers.data?.reporters.length ? `${LEAD} Only your own reporters are here. Podium does not carry messages between people.` : LEAD} />
          {body}
        </div>
      </div>
    </main>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Owner({ data, peers, api, sessions, now }: { data: PeersRead; peers: MyPeers; api: PeersApi; sessions: Record<string, SessionView>; now: number }) {
  const [err, setErr] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [back, setBack] = useState<{ a: string; b: string; control: string } | null>(null);
  const [layout, setLayout] = useRightsLayout();
  const [boardOf, setBoardOf] = useState<string | null>(null);
  const model = rightsModel(data);
  const machine = (key: string) => data.reporters.find((r) => r.key === key)?.machine ?? key;

  const saved = useCallback((failed: string | null) => {
    setErr(failed ? `Could not save the change: ${failed}. Nothing changed. Try again.` : null);
    return failed === null;
  }, []);

  const setRight = async (a: string, b: string, level: PeerLevel, control: string) => {
    const before = model.level(a, b);
    const reverse = model.level(b, a);
    setBack(null);
    setSaid(`${machine(a)} to ${machine(b)}: ${LEVEL_LABEL[level]}.`);
    const ok = saved(await peers.change(() => api.setRight(a, b, level), (d) => withRight(d, a, b, level)));
    if (!ok) return;
    if (asksBack(before, level, reverse, a, b)) {
      setBack({ a, b, control });
      setSaid(`${machine(a)} to ${machine(b)}: ${LEVEL_LABEL[level]}. Can ${machine(b)} answer? Choose below.`);
    }
  };

  const answerBack = async (level: "ask" | "send" | null) => {
    if (!back) return;
    const { a, b, control } = back;
    setBack(null);
    if (level) {
      setSaid(`${machine(b)} to ${machine(a)}: ${LEVEL_LABEL[level]}.`);
      saved(await peers.change(() => api.setRight(b, a, level), (d) => withRight(d, b, a, level)));
    }
    document.getElementById(control)?.focus();
  };

  const setDefaults = async (patch: Partial<Pick<PeerDefaults, "trust" | "onRequest" | "newSend">>, words: string) => {
    setBack(null);
    setSaid(words);
    saved(await peers.change(() => api.setDefaults(patch), (d) => ({ ...d, defaults: { ...d.defaults, ...patch } })));
  };

  const answer = async (r: PeerRequestView, how: "allow" | "decline" | "deliver") => {
    setBusy(r.id);
    const failed = await peers.change(() => api.answer(r.id, how));
    setBusy(null);
    if (failed) setErr(`Could not answer: ${failed}. Nothing changed${/answered|closed/i.test(failed) ? "" : ". Try again"}.`);
    else {
      setErr(null);
      setSaid(how === "decline" ? "Declined." : how === "deliver" ? "Delivered." : "Allowed.");
    }
  };

  const off = data.reporters.filter((r) => r.peers !== true);
  return (
    <>
      {err && (
        <div className="errbox" role="alert">
          {err}
        </div>
      )}
      <div className="vh" role="status" aria-live="polite">
        {said}
      </div>
      {data.requests.length > 0 && (
        <Section id="pm-req-h" title="Waiting for you" help={`${data.requests.length} ${data.requests.length === 1 ? "request" : "requests"}. Nothing changes until you answer. Each one also shows in your sessions on the machine it concerns, and answering in either place closes the other.`}>
          <Panel>
            <div className="pm-reqs">
              {data.requests.map((r) => (
                <Request key={r.id} r={r} data={data} now={now} busy={busy === r.id} onAnswer={(how) => void answer(r, how)} />
              ))}
            </div>
          </Panel>
        </Section>
      )}
      <Section id="pm-mine-h" title="Your reporters" help="Every machine that reports with your name and token.">
        <Panel>
          <div className="tw2 scroll" tabIndex={0} role="region" aria-label="Table of your reporters">
            <table className="ptab">
              <thead>
                <tr>
                  <th>State</th>
                  <th>Machine</th>
                  <th>System</th>
                  <th>Messaging</th>
                  <th>Reporter version</th>
                  <th>Last report</th>
                  <th className="n">Live orchestrators</th>
                </tr>
              </thead>
              <tbody>
                {data.reporters.map((r) => {
                  const look = reporterLook(r, sessions);
                  return (
                    <tr key={r.key}>
                      <td>
                        {look.state === "reporting" ? (
                          <span className="rstate reporting" title="It has an orchestrator reporting now.">
                            <span className="rdot reporting" aria-hidden="true" />
                            Reporting
                          </span>
                        ) : (
                          <span className="rstate restart" title="No orchestrator on this machine is reporting now. It shows as Reporting again once one starts.">
                            <span className="rdot restart" aria-hidden="true" />
                            No live session
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="pm-name strong" title={r.machine}>
                          {r.machine}
                        </span>
                      </td>
                      <td>
                        <SystemTag os={r.os} />
                      </td>
                      <td>{r.peers === true ? <span className="badge ok">On</span> : <span className="badge off">{r.peers === null ? "Reporter can't message: update it" : "Off on the machine"}</span>}</td>
                      <td>
                        <span className={`compat ${look.compat ?? "ok"}`}>
                          <span className="mono">{r.version}</span>
                        </span>
                      </td>
                      <td className="mono muted nowrap">{look.lastSeenAt === null ? <span title="Not in the live fleet">–</span> : ago(now, look.lastSeenAt)}</td>
                      <td className="n mono">{r.live.length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {off.length > 0 && (
            <div className="pm-note">
              {off.map((r) => (
                <p key={r.key} className="hint">
                  {r.peers === null ? (
                    <>
                      {r.machine}'s reporter is too old to message. Update podium-reporter on that machine: in Claude Code there, run <span className="mono">/plugin</span>, pick podium-reporter on the Installed tab and choose Update now.
                    </>
                  ) : (
                    <>
                      {r.machine} has messaging off. Only that machine can turn it on: in Claude Code there, run <span className="mono">/plugin configure podium-reporter</span> and set <span className="mono">peers</span> to on.
                    </>
                  )}
                </p>
              ))}
            </div>
          )}
          <div className="apager">
            <span className="hint" role="status">
              Showing 1 to {data.reporters.length} of {data.reporters.length}
            </span>
          </div>
        </Panel>
      </Section>
      <Section id="pm-def-h" title="Defaults">
        <Panel>
          <div className="pm-defs">
          <div className="srow">
            <div className="setname">
              <b id="pm-trust-n">Trust my own reporters</b>
              <p className="hint ink2">Every reporter of yours can send to every other one, and messages are delivered without approval. A reporter you add later is included. Off by default.</p>
            </div>
            <div className="sw">
              <button type="button" role="switch" aria-checked={data.defaults.trust} aria-labelledby="pm-trust-n pm-trust-s" onClick={() => void setDefaults({ trust: !data.defaults.trust }, `Trust my own reporters: ${data.defaults.trust ? "Off" : "On"}.`)} />
              <span id="pm-trust-s">{data.defaults.trust ? "On" : "Off"}</span>
            </div>
          </div>
          <div className="srow">
            <div className="setname">
              <b id="pm-ask-n">When an orchestrator asks for access</b>
              <p className="hint ink2">One of your orchestrators can ask to see or send to another of your reporters. A change an Admin proposes always waits for you, whatever this says.</p>
            </div>
            <Segmented labelledBy="pm-ask-n" options={ON_REQUEST} value={data.defaults.onRequest} onChange={(v) => void setDefaults({ onRequest: v }, `When an orchestrator asks for access: ${ON_REQUEST.find((o) => o.id === v)!.label}.`)} />
          </div>
          <div className="srow">
            <div className="setname">
              <b id="pm-new-n">A new right to send starts as</b>
              <p className="hint ink2">You can change it for each pair below.</p>
            </div>
            <Segmented labelledBy="pm-new-n" options={NEW_SEND} value={data.defaults.newSend} onChange={(v) => void setDefaults({ newSend: v }, `A new right to send starts as: ${NEW_SEND.find((o) => o.id === v)!.label}.`)} />
          </div>
          </div>
        </Panel>
      </Section>
      <section className="asec" aria-labelledby="pm-rights-h">
        <div className="asec-h">
          <div>
            <h2 id="pm-rights-h">Who can message whom</h2>
            <p className="hint">Messages go from orchestrator to orchestrator, never to an agent they launched. An orchestrator receives one when its turn has ended.</p>
          </div>
          <LayoutSwitch
            layout={layout}
            onLayout={(l) => {
              setBack(null);
              setLayout(l);
            }}
          />
        </div>
        <Panel>
          {data.defaults.trust && (
            <div className="warnbar" role="status">
              <svg className="wicon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 2l6.5 11.5h-13z" />
                <path d="M8 6.5v3M8 11.6v.1" />
              </svg>
              <div className="tx">
                <b>Trust my own reporters is on.</b> Every reporter below can send to every other one, so these choices are locked. Turn it off under Defaults to set them one by one.
              </div>
            </div>
          )}
          {layout === "grid" ? (
            <RightsGrid model={model} waitingFor="you" onSet={(a, b, l, c) => void setRight(a, b, l, c)} />
          ) : (
            <RightsBoard
              model={model}
              waitingFor="you"
              of={boardOf}
              onOf={(k) => {
                setBack(null);
                setBoardOf(k);
              }}
              onSet={(a, b, l, c) => void setRight(a, b, l, c)}
            />
          )}
          {back && <AnswerBack a={machine(back.a)} b={machine(back.b)} onAnswer={(l) => void answerBack(l)} />}
          <div className="pm-note">
            <p className="hint">
              {layout === "grid"
                ? "Read a row as: this reporter's orchestrators can do this to the column's. Can see lists their orchestrators with project, system and status. Can send includes Can see."
                : "Drag a card to another column, or use its Move to list. The line at the bottom of a card is what that reporter can do back."}
            </p>
          </div>
        </Panel>
      </section>
    </>
  );
}

/** One open request as a consent box: who asked, what changes, and a button per answer. */
function Request({ r, data, now, busy, onAnswer }: { r: PeerRequestView; data: PeersRead; now: number; busy: boolean; onAnswer: (how: "allow" | "decline" | "deliver") => void }) {
  const when = ago(now, r.at);
  let lead: React.ReactNode;
  let hint: React.ReactNode;
  let yes: { how: "allow" | "deliver"; label: string };
  if (r.kind === "message") {
    lead = (
      <>
        A message from <b>{r.from.name ?? "an orchestrator"}</b> on <b>{r.from.machine}</b> to <b>{r.to.name ?? "an orchestrator"}</b> on <b>{r.to.machine}</b> waits for your approval.
      </>
    );
    hint = `Sent ${when}. It is delivered when you approve it and the receiving orchestrator's turn has ended.`;
    yes = { how: "deliver", label: "Deliver" };
  } else if (r.kind === "access") {
    const level = r.level ?? "see";
    lead = (
      <>
        <b>{r.by}</b> on <b>{r.from.machine}</b> asks to {level === "see" ? "see" : "send to"} <b>{r.to.machine}</b>.
      </>
    );
    hint = `Asked ${when}. Allowing it gives ${LEVEL_LABEL[level]}.${r.reason ? " Its reason, in its own words:" : ""}`;
    yes = { how: "allow", label: "Allow" };
  } else {
    const level = r.level ?? "see";
    const [w, tail] = rightWords(level);
    const from = keyOfMachine(data.reporters, r.from.machine);
    const to = keyOfMachine(data.reporters, r.to.machine);
    const today = from && to ? rightsModel(data).level(from, to) : null;
    const [tw, ttail] = today ? rightWords(today, true) : ["", ""];
    lead = (
      <>
        An Admin proposes that <b>{r.from.machine}</b> {w} <b>{r.to.machine}</b>
        {tail}.
      </>
    );
    hint = `Proposed ${when}.${today ? ` Today ${r.from.machine} ${tw} ${r.to.machine}${ttail}.` : ""}`;
    yes = { how: "allow", label: "Accept change" };
  }
  const quote = r.kind === "message" ? r.text : r.kind === "access" ? r.reason : null;
  return (
    <div className="confirm" role="group" aria-label={r.kind === "message" ? "A message waiting for approval" : r.kind === "access" ? "A request for access" : "A change an Admin proposes"}>
      <div className="q">
        <span>{lead}</span>
        <span className="hint">{hint}</span>
        {quote && <QuotedText text={quote} />}
      </div>
      <button type="button" className="btn sm" disabled={busy} onClick={() => onAnswer("decline")}>
        Decline
      </button>
      <button type="button" className="btn sm" disabled={busy} onClick={() => onAnswer(yes.how)}>
        {yes.label}
      </button>
    </div>
  );
}
