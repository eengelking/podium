// My reporters (#347, #415, SPEC 8.1, mockup/podium-my-reporters.html): a console page for a person signed in to respond.
// It mirrors Admin > Reporters for that person's own reporters, in the Admin page layout under the console's top bar, and
// is where they decide which of their reporters may see and message each other. Messaging joins one person's own
// reporters only; the server refuses anything else whatever this page sends. Text an orchestrator wrote (a reason, a
// message waiting for approval) is drawn as text nodes.
import { useCallback, useState } from "react";
import "./admin/admin.css";
import { PageHeader, Panel, Section } from "./admin/Page";
import { ago, StateBadge, Version } from "./admin/ReportersTab";
import { AnswerBack, LayoutSwitch, QuotedText, RightsBoard, RightsGrid, Segmented, SystemTag, useRightsLayout } from "./components/PeerRights";
import { PEER_LIMIT_FIELDS, PeerLimits, type PeerLimitAction, type PeerLimitField, type PeerLimitKey } from "./components/PeerLimits";
import { asksBack, LEVEL_LABEL, LEVELS, rightsModel, rightWords, withRight, type PeerDefaults, type PeerLevel, type PeerLimitsView, type PeerRequestView, type PeersRead, type RightsModel } from "./peers";
import type { PeersApi } from "./respondApi";
import { ADMIN } from "./people";
import type { MyPeers } from "./useMyPeers";
import type { RespondMe } from "./types";
import { Blank } from "./components/Blank";
import { DESKTOP_OPTIONS, OPTION_CMD } from "./pluginOptions";

const LEAD = "The machines that report your sessions to this server, and which of them may message each other.";

const ON_REQUEST = [
  { id: "ask", label: "Ask me" },
  { id: "allow", label: "Allow" },
  { id: "decline", label: "Decline" },
] as const;
const NEW_SEND = [
  { id: "ask", label: "With approval" },
  { id: "send", label: "Without approval" },
] as const;

// The owner's stricter limits (#436, SPEC 7.7, mockup/podium-my-reporters.html Defaults): the Admin's rows, with the
// owner's words. Each box shows the limit that applies and stops at the Admin's value.
type OwnerLimitKey = keyof PeerLimitsView;
const OWNER_LIMIT_FIELDS: readonly (PeerLimitField & { key: OwnerLimitKey })[] = [
  { key: "roundTrips", label: PEER_LIMIT_FIELDS.roundTrips.label, hint: "After this many exchanges in one conversation, the next message waits for you to approve it." },
  { key: "perMinute", label: PEER_LIMIT_FIELDS.perMinute.label, hint: "More than this is refused, and the sender is told to wait." },
  { key: "maxChars", label: PEER_LIMIT_FIELDS.maxChars.label, hint: "A longer message is refused, never cut, and the sender is told the limit." },
];
const LIMITS_HELP = "What applies to all your reporters, and the limits on your links. The Admin sets the most each limit can be on this server, and yours can only be lower.";

const num = (n: number) => n.toLocaleString("en-US");

/** What was typed, checked against 1 and the Admin's value (`max`): the whole sentence, or null. Nothing is saved on one. */
function ownerLimitCheck(_key: PeerLimitKey, text: string, max: number): string | null {
  const t = text.trim();
  const n = Number(t);
  const range = `Enter a whole number from 1 to ${num(max)}`;
  if (t === "") return `${range}. Nothing was saved.`;
  if (!Number.isInteger(n)) return `${t} is not a whole number. ${range}. Nothing was saved.`;
  if (n < 1) return `${num(n)} is below 1. ${range}, or pause the link under Who can message whom. Nothing was saved.`;
  if (n > max) return `${num(n)} is above the Admin's limit, ${num(max)}. ${range}. Nothing was saved.`;
  return null;
}

/** The line under a limit's name: whose value applies. The owner's own is kept when the Admin later goes below it. */
function ownerLimitState(own: number | undefined, admin: number): string {
  if (own === undefined) return `Uses the Admin's limit, ${num(admin)}.`;
  if (own < admin) return `Yours, stricter than the Admin's limit, ${num(admin)}.`;
  if (own === admin) return `Yours, the same as the Admin's limit, ${num(admin)}.`;
  return `The Admin's limit is now ${num(admin)}, lower than yours, ${num(own)}, so ${num(admin)} applies.`;
}

/** `notice` is the console's own message, such as a failed Remove in the rail (#446), shown at the top of the page as on the wall. */
export function MyReportersPage(props: { me: RespondMe | null; peersOn: boolean; peers: MyPeers; api: PeersApi; now: number; notice?: string | null }) {
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
    body = <Owner data={peers.data} peers={peers} api={props.api} now={props.now + peers.skew} />;
  }
  return (
    <main className="adminv" aria-label="My reporters">
      <div className="apage">
        <div className="apage-in">
          {props.notice && (
            <div className="callout notice" role="status">
              <div>{props.notice}</div>
            </div>
          )}
          <PageHeader title="My reporters" lead={peers.data?.reporters.length ? `${LEAD} Only your own reporters are here. Podium does not carry messages between people.` : LEAD} />
          {body}
        </div>
      </div>
    </main>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Owner({ data, peers, api, now }: { data: PeersRead; peers: MyPeers; api: PeersApi; now: number }) {
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

  // One of the owner's limits (#436): null uses the Admin's. The box keeps what was typed until the server has it, so a
  // refusal shows in the limit's own row (PeerLimits) and not in the page's error.
  const saveLimit = async (k: PeerLimitKey, value: number | null): Promise<string | null> => {
    const f = OWNER_LIMIT_FIELDS.find((x) => x.key === k)!;
    setBack(null);
    const failed = await peers.change(() => api.setDefaults({ limits: { [f.key]: value } }));
    if (!failed) setSaid(value === null ? `${f.label}: ${num(data.limits.server[f.key])}, the Admin's limit.` : `${f.label}: ${num(value)}, yours.`);
    return failed;
  };
  const limitState: Partial<Record<PeerLimitKey, string>> = {};
  const limitAction: Partial<Record<PeerLimitKey, PeerLimitAction>> = {};
  for (const f of OWNER_LIMIT_FIELDS) {
    const own = data.defaults.limits[f.key];
    limitState[f.key] = ownerLimitState(own, data.limits.server[f.key]);
    if (own !== undefined) {
      limitAction[f.key] = {
        label: "Use the Admin's limit",
        ariaLabel: `${f.label}: use the Admin's limit, ${num(data.limits.server[f.key])}`,
        onClick: () => void saveLimit(f.key, null).then(saved),
      };
    }
  }

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
                <Request key={r.id} r={r} model={model} now={now} busy={busy === r.id} onAnswer={(how) => void answer(r, how)} />
              ))}
            </div>
          </Panel>
        </Section>
      )}
      <Section id="pm-mine-h" title="Your reporters" help="Every machine that reports with your name and token.">
        <Panel>
          {/* A scrolling region takes focus so the keyboard can scroll it (accessibility.html). */}
          <div className="tw2 scroll" tabIndex={0} role="region" aria-label="Table of your reporters" /* NOSONAR S6845: a focusable scroll region, by design */>
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
                  return (
                    <tr key={r.key}>
                      <td>
                        <StateBadge r={r} serverTime={data.serverTime} serverStartedAt={data.serverStartedAt} />
                      </td>
                      <td>
                        <span className="pm-name strong" title={r.machine}>
                          {r.machine}
                        </span>
                      </td>
                      <td>
                        <SystemTag os={r.os} />
                      </td>
                      <td>
                        {r.peers === true ? (
                          <span className="badge ok">
                            <span className="dot running" aria-hidden="true" />
                            On
                          </span>
                        ) : (
                          <span className="badge off">
                            <span className="dot" aria-hidden="true" />
                            {r.peers === null ? "Reporter can't message: update it" : "Off on the machine"}
                          </span>
                        )}
                      </td>
                      <td>
                        <Version r={r} />
                      </td>
                      <td className="mono muted nowrap">{ago(data.serverTime, r.lastSeenAt)}</td>
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
                      {r.machine} has messaging off. Only that machine can turn it on. In Claude Code there, run <span className="mono">{OPTION_CMD}</span> and set <span className="mono">peers</span> to on. In the Claude desktop app there, open {DESKTOP_OPTIONS} and turn on <span className="mono">peers</span>.
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
      <Section id="pm-def-h" title="Defaults" help={LIMITS_HELP}>
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
          <PeerLimits
            idPrefix="pm-lim"
            fields={OWNER_LIMIT_FIELDS}
            values={data.limits.effective}
            max={data.limits.server}
            state={limitState}
            action={limitAction}
            check={ownerLimitCheck}
            toValue={(k, n) => (n === data.limits.server[k as OwnerLimitKey] ? null : n)}
            stored={data.defaults.limits}
            onSave={saveLimit}
          />
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
function Request({ r, model, now, busy, onAnswer }: { r: PeerRequestView; model: RightsModel; now: number; busy: boolean; onAnswer: (how: "allow" | "decline" | "deliver") => void }) {
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
    // Allowing never lowers a right (the server keeps the higher level), so a pair that already has as much is unchanged.
    const today = model.level(r.fromKey, r.toKey);
    let gives = `Allowing it gives ${LEVEL_LABEL[level]}.`;
    if (LEVELS.indexOf(today) >= LEVELS.indexOf(level)) {
      const [tw, ttail] = rightWords(today, true);
      gives = `Allowing it changes nothing: today ${r.from.machine} ${tw} ${r.to.machine}${ttail}.`;
    }
    hint = `Asked ${when}. ${gives}${r.reason ? " Its reason, in its own words:" : ""}`;
    yes = { how: "allow", label: "Allow" };
  } else {
    const level = r.level ?? "see";
    const [w, tail] = rightWords(level);
    // By key, not machine name: two of the person's machines can share a name.
    const [tw, ttail] = rightWords(model.level(r.fromKey, r.toKey), true);
    lead = (
      <>
        An Admin proposes that <b>{r.from.machine}</b> {w} <b>{r.to.machine}</b>
        {tail}.
      </>
    );
    hint = `Proposed ${when}. Today ${r.from.machine} ${tw} ${r.to.machine}${ttail}.`;
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
