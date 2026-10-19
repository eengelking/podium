// Traffic (#347, #417, SPEC 8.1, mockup/podium-traffic.html): a console page that maps which orchestrators message
// which, like a service mesh's traffic view. The map and the counts are open to every reader of the console; a
// conversation's text opens only for its owner and an Admin, and the page does not even ask for it otherwise. Pause
// link and Remove link act through the owner's routes. Text an orchestrator wrote is drawn as text nodes.
import { useEffect, useMemo, useRef, useState } from "react";
import "./admin/admin.css";
import { PageHeader, Panel, Section } from "./admin/Page";
import { ago } from "./admin/ReportersTab";
import { LEVEL_ICON, PausedTag, Segmented } from "./components/PeerRights";
import { stateKind, type StateKind } from "./components/Chips";
import { IconCheck, IconX } from "./components/Icons";
import { TrafficLegend, TrafficMap, type NodeState } from "./components/TrafficMap";
import {
  canManage,
  canRead,
  deliveryWords,
  hm,
  keptWords,
  layoutMap,
  linkId,
  noRightToSend,
  ordered,
  plural,
  RANGES,
  redactedParts,
  stateWords,
  tripsWords,
  waysOf,
  whereWords,
  type DeliveryIcon,
  type PeerMessage,
  type TrafficApi,
  type TrafficLink,
  type TrafficRange,
} from "./trafficData";
import { useConversation, useTraffic } from "./useTraffic";
import { failReason, type MyPeers } from "./useMyPeers";
import type { RespondMe, SessionView } from "./types";

type View = "map" | "table";
const VIEWS = [
  { id: "map", label: "Map" },
  { id: "table", label: "Table" },
] as const;

const STATE_WORD: Record<StateKind, string> = {
  running: "running",
  waiting: "waiting",
  bg: "idle on background work",
  stale: "heartbeat lost",
  done: "done",
  deleg: "delegating",
};

const svg = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false } as const;
const ICON_ACTIVE = (
  <svg {...svg}>
    <path d="M2 8h12M10 4l4 4-4 4" />
  </svg>
);
const ICON_CLOCK = (
  <svg {...svg} strokeWidth={1.5}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.6V8l2.4 1.4" />
  </svg>
);
const ICON_PAUSE = (
  <svg {...svg}>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.5 5.5v5M9.5 5.5v5" />
  </svg>
);
const ICON_QUEUE = (
  <svg {...svg} strokeWidth={1.5}>
    <path d="M3 4h10M3 8h10M3 12h6" />
  </svg>
);
const ICON_MSG = (
  <svg {...svg} width="12" height="12">
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
  </svg>
);
const DELIVERY_ICON: Record<DeliveryIcon, React.ReactNode> = { ok: <IconCheck />, queue: ICON_QUEUE, clock: ICON_CLOCK, pause: ICON_PAUSE, no: <IconX /> };

/**
 * A link's state as an icon and a word. `state` reads `waiting` on a paused link while a message also waits for
 * approval, so `paused` (the server's, or the panel's newer read) adds the paused tag beside it.
 */
function StateTag({ link, paused = link.paused === true }: { link: TrafficLink; paused?: boolean }) {
  if (link.state === "paused" || (paused && link.state !== "waiting")) return <PausedTag />;
  let icon: React.ReactNode = ICON_ACTIVE;
  if (link.state === "waiting") icon = ICON_CLOCK;
  else if (noRightToSend(link)) icon = LEVEL_ICON.none;
  return (
    <>
      <span className={`pm-state${link.state === "waiting" ? " waiting" : ""}`}>
        {icon}
        <span>{stateWords(link)}</span>
      </span>
      {paused && (
        <>
          {" "}
          <PausedTag />
        </>
      )}
    </>
  );
}

function Blank({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="kb-blank">
      <b>{title}</b>
      <p className="hint">{children}</p>
    </div>
  );
}

const initialView = (): View => (globalThis.matchMedia?.("(max-width: 640px)")?.matches ? "table" : "map");

export function TrafficPage(props: { me: RespondMe | null; peersOn: boolean; sessions: Record<string, SessionView>; peers: MyPeers; api: TrafficApi; now: number }) {
  const { me, peersOn, api } = props;
  const [range, setRange] = useState<TrafficRange>("live");
  const [view, setView] = useState<View>(initialView);
  const traffic = useTraffic(api, peersOn, range);
  const links = traffic.data?.enabled ? traffic.data.conversations : [];
  const owners = [...new Set(links.map((l) => l.owner))];
  let lead = "Messages between orchestrators, on every machine that reports here.";
  if (owners.length === 1) lead = `Messages between ${owners[0]}'s orchestrators, on every machine that reports here.`;
  else if (owners.length > 1) lead = "Messages between each person's own orchestrators, on every machine that reports here.";

  let body: React.ReactNode;
  if (!peersOn || traffic.data?.enabled === false) {
    body = <Blank title="Orchestrator messaging is off">An Admin turns it on in Admin &gt; Settings &gt; Feature flags. Until then no orchestrator can message another.</Blank>;
  } else if (!traffic.data) {
    body = traffic.loadError ? (
      <div className="errbox" role="alert">
        Could not load the traffic: {traffic.loadError}. It tries again by itself every few seconds.
      </div>
    ) : (
      <div className="hint">Loading…</div>
    );
  } else {
    body = (
      <Who
        links={links}
        range={range}
        onRange={setRange}
        view={view}
        onView={setView}
        loadError={traffic.loadError}
        reload={traffic.reload}
        tick={traffic.data}
        retainDays={traffic.data.retainDays}
        skew={traffic.skew}
        {...props}
      />
    );
  }
  return (
    <main className="adminv" aria-label="Traffic">
      <div className="apage">
        <div className="apage-in">
          <PageHeader title="Traffic" lead={lead} />
          {body}
          {traffic.data?.enabled && links.length > 0 && <Rules retainDays={traffic.data.retainDays} />}
        </div>
      </div>
    </main>
  );
}

function Tools(props: { range: TrafficRange; onRange: (r: TrafficRange) => void; view?: View; onView?: (v: View) => void }) {
  return (
    <div className="pm-tools">
      <span className="hint">Show</span>
      <Segmented label="Show" options={RANGES} value={props.range} onChange={props.onRange} />
      {props.view && props.onView && (
        <>
          <span className="grow" />
          <span className="hint">View</span>
          <Segmented label="View" options={VIEWS} value={props.view} onChange={props.onView} />
        </>
      )}
    </div>
  );
}

interface WhoProps {
  links: TrafficLink[];
  range: TrafficRange;
  onRange: (r: TrafficRange) => void;
  view: View;
  onView: (v: View) => void;
  loadError: string | null;
  reload: () => Promise<void>;
  tick: unknown;
  retainDays: number | undefined;
  /** The server's clock minus the browser's, from the last read. */
  skew: number;
  me: RespondMe | null;
  sessions: Record<string, SessionView>;
  peers: MyPeers;
  api: TrafficApi;
  now: number;
}

const HELP = "A line joins two orchestrators that messaged each other. Select one to read the conversation.";

function Who(p: WhoProps) {
  const { links } = p;
  const [sel, setSel] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  // The first conversation opens by itself, and stays open: the read is newest first, so falling back to links[0] on
  // every read would jump to whichever conversation got the latest message.
  const first = links[0] ? linkId(links[0]) : null;
  useEffect(() => {
    if (sel === null && first !== null) setSel(first);
  }, [sel, first]);
  const selected = links.find((l) => linkId(l) === sel) ?? links[0] ?? null;
  const layout = useMemo(() => layoutMap(links), [links]);
  const reporters = p.peers.data?.reporters ?? [];

  if (!links.length) {
    return (
      <Section id="map-h" title="Who is talking" help={HELP}>
        <Panel>
          <Tools range={p.range} onRange={p.onRange} />
          <div className="pm-empty">
            <Blank title="No orchestrator has messaged another yet">A line appears here once one of your orchestrators sends a message. Choose which reporters can talk in My reporters.</Blank>
            <a className="btn sm" href="#/me/reporters">
              Open My reporters
            </a>
          </div>
        </Panel>
      </Section>
    );
  }

  const choose = (id: string) => {
    setSel(id);
    const l = links.find((x) => linkId(x) === id);
    if (l) setSaid(`Showing the conversation between ${l.a.name} and ${l.b.name}.`);
  };
  const osOf = (key: string): string | null => {
    const r = reporters.find((x) => x.key === key);
    if (r?.os) return r.os;
    for (const n of layout.nodes) if (n.machine === key && p.sessions[n.sessionId]?.machine?.os) return p.sessions[n.sessionId]!.machine!.os!;
    // Signed out, or once the conversation's own sessions ended: any live session on that machine. A reporter's key is
    // its machine id, or `<machine id>#<owner>` for a second account on the machine (ReporterStore).
    const id = key.split("#")[0];
    for (const s of Object.values(p.sessions)) if (s.machine?.id === id && s.machine.os) return s.machine.os;
    return null;
  };
  const nodeState = (id: string): NodeState => {
    const s = p.sessions[id];
    if (!s) return { kind: "done", word: "ended" };
    const kind = stateKind(s);
    return { kind, word: STATE_WORD[kind] };
  };
  // The owner's machines that cannot take part and are not on the map; one that talked before it went off is drawn.
  const drawn = new Set(layout.machines.map((m) => m.key));
  const off = reporters
    .filter((r) => r.peers !== true && !drawn.has(r.key))
    .map((r) => ({ machine: r.machine, why: r.peers === null ? "its reporter is too old to message, so update it" : "messaging is off on that machine" }));

  return (
    <Section id="map-h" title="Who is talking" help={HELP}>
      <Panel>
        <Tools range={p.range} onRange={p.onRange} view={p.view} onView={p.onView} />
        {p.loadError && (
          <div className="errbox pm-err" role="alert">
            Could not read the traffic again: {p.loadError}. What is shown is from the last read. It tries again by itself every few seconds.
          </div>
        )}
        <div className="vh" role="status" aria-live="polite">
          {said}
        </div>
        <div className="pm-split">
          {p.view === "map" ? (
            <div className="pm-left">
              <div className="pm-mapscroll">
                <TrafficMap layout={layout} selected={selected ? linkId(selected) : null} onSelect={choose} osOf={osOf} nodeState={nodeState} />
              </div>
              <TrafficLegend off={off} />
            </div>
          ) : (
            <div className="pm-left">
              {/* Timed by the server's clock, as Admin > Reporters is: the read's offset applied to the page's clock. */}
              <LinkTable links={links} selected={selected ? linkId(selected) : null} onSelect={choose} now={p.now + p.skew} />
            </div>
          )}
          {selected && <ConversationPanel key={linkId(selected)} link={selected} {...p} onSaid={setSaid} />}
        </div>
      </Panel>
    </Section>
  );
}

function LinkTable({ links, selected, onSelect, now }: { links: TrafficLink[]; selected: string | null; onSelect: (id: string) => void; now: number }) {
  return (
    <div>
      {/* A scrolling region takes focus so the keyboard can scroll it (accessibility.html). */}
      <div className="tw2 scroll" tabIndex={0} role="region" aria-label="Links" /* NOSONAR S6845: a focusable scroll region, by design */>
        <table className="ptab">
          <thead>
            <tr>
              <th>Link</th>
              <th className="n">Messages</th>
              <th>Last message</th>
              <th className="n">Round trips</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => {
              const id = linkId(l);
              const [x, y] = ordered(l);
              const one = waysOf(l) === "aToB" || waysOf(l) === "bToA";
              return (
                <tr key={id} className={`rw${selected === id ? " sel" : ""}`}>
                  <td>
                    <button type="button" className="rname" title={`${x.name} and ${y.name}`} aria-current={selected === id ? "true" : undefined} onClick={() => onSelect(id)}>
                      {x.name}
                      {one ? " to " : " and "}
                      {y.name}
                    </button>
                    <span className="sub">{whereWords(l)}</span>
                  </td>
                  <td className="n mono">{l.messages}</td>
                  <td className="mono muted nowrap">{ago(now, l.lastAt)}</td>
                  <td className="n mono">{tripsWords(l)}</td>
                  <td>
                    <StateTag link={l} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="apager">
        <span className="hint" role="status">
          Showing 1 to {links.length} of {links.length}
        </span>
      </div>
    </div>
  );
}

/** Whether the owner's own read says the link between two reporters is paused, either way. */
function pausedByRights(peers: MyPeers, l: TrafficLink): boolean {
  const a = l.a.reporterKey;
  const b = l.b.reporterKey;
  return (peers.data?.rights ?? []).some((r) => r.paused && ((r.from === a && r.to === b) || (r.from === b && r.to === a)));
}

function ConversationPanel(p: WhoProps & { link: TrafficLink; onSaid: (s: string) => void }) {
  const { link, me, api } = p;
  const readable = canRead(me, link.owner);
  const manage = canManage(me, link.owner);
  const conv = useConversation(api, link, readable, p.tick);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const removeBtn = useRef<HTMLButtonElement>(null);
  const keepBtn = useRef<HTMLButtonElement>(null);
  // `paused` from the server, which `state` hides while a message also waits for approval; the owner's own read can be
  // newer after a Pause link.
  const paused = link.paused || link.state === "paused" || pausedByRights(p.peers, link);
  const [x, y] = ordered(link);
  const ways = waysOf(link);
  const one = ways === "aToB" || ways === "bToA";
  const same = link.a.reporterKey === link.b.reporterKey;

  useEffect(() => {
    if (removing) keepBtn.current?.focus();
  }, [removing]);

  const refresh = () => Promise.all([p.reload(), p.peers.reload()]);
  const togglePause = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.pause(link.a.reporterKey, link.b.reporterKey, !paused);
      p.onSaid(paused ? "Link resumed." : "Link paused.");
    } catch (e) {
      setErr(`Could not ${paused ? "resume" : "pause"} the link: ${failReason(e)}. The link is still ${paused ? "paused" : "active"}. Try again.`);
    }
    await refresh();
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.remove(link.a.reporterKey, link.b.reporterKey);
      p.onSaid(same ? `Link removed. The orchestrators on ${link.a.machine} cannot message each other now.` : "Link removed. Neither machine can send to the other now.");
    } catch (e) {
      setErr(`Could not remove the link: ${failReason(e)}. Nothing changed. Try again.`);
    }
    setRemoving(false);
    await refresh();
    setBusy(false);
    removeBtn.current?.focus();
  };
  const keep = () => {
    setRemoving(false);
    removeBtn.current?.focus();
  };

  const head = (
    <>
      <h2 id="conv-h">
        {x.name}{" "}
        <span className="sep" aria-hidden="true">
          {one ? "→" : "⇄"}
        </span>
        <span className="vh">{one ? " to " : " and "}</span> {y.name}
      </h2>
      <div className="sub">
        <span>{whereWords(link)}</span>
        <span>{plural(link.messages, "message")}</span>
        <StateTag link={link} paused={paused} />
      </div>
    </>
  );

  if (!readable) {
    return (
      <section className="pm-conv" aria-labelledby="conv-h">
        {head}
        <div className="offnote">
          <b>Only {link.owner} and an Admin can read this conversation.</b>
          <span>Messages can hold source code and paths, so the text is not open to everyone who can see the console. Sign in as its owner to read it.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="pm-conv" aria-labelledby="conv-h">
      {head}
      {manage ? (
        <div className="acts">
          {/* Not disabled while saving, which would drop the focus: a press while busy waits for the first. */}
          <button type="button" className="btn sm" aria-busy={busy || undefined} onClick={() => !busy && void togglePause()}>
            {paused ? "Resume link" : "Pause link"}
          </button>
          <button type="button" className="btn sm dng" ref={removeBtn} aria-busy={busy || undefined} aria-expanded={removing} aria-controls={removing ? "conv-remove" : undefined} onClick={() => !busy && setRemoving(true)}>
            Remove link…
          </button>
          <a className="btn sm" href="#/me/reporters">
            Open My reporters
          </a>
        </div>
      ) : (
        <p className="hint">
          This is {link.owner}'s link. Only {link.owner} can pause or remove it. An Admin can pause all of a reporter's links in Admin &gt; Reporters.
        </p>
      )}
      {err && (
        <div className="errbox" role="alert">
          {err}
        </div>
      )}
      {removing && (
        <div className="confirm" id="conv-remove" role="group" aria-label="Remove the link">
          {same ? `Remove the link between the orchestrators on ${link.a.machine}?` : `Remove the link between ${link.a.machine} and ${link.b.machine}?`} Both directions lose every right, a message still waiting is dropped, and this conversation stays here until it expires.
          <button type="button" className="btn sm" ref={keepBtn} onClick={keep}>
            Keep it
          </button>
          <button type="button" className="btn sm dng" disabled={busy} onClick={() => void remove()}>
            Remove link
          </button>
        </div>
      )}
      <Capacity link={link} />
      <div className="feedwrap">
        <ol className="feed" aria-label="Messages, oldest first" tabIndex={0}>
          {conv.messages === null ? (
            <li className="empty">{conv.error ? "No messages to show." : "Loading…"}</li>
          ) : conv.messages.length ? (
            conv.messages.map((m) => <Message key={m.id} m={m} paused={paused} />)
          ) : (
            <li className="empty">No messages in this conversation.</li>
          )}
        </ol>
      </div>
      {conv.error && (
        <div className="errbox" role="alert">
          Could not load the conversation: {conv.error}. It tries again by itself every few seconds.
        </div>
      )}
      <div className="feedfoot">
        <span>Kept {keptWords(p.retainDays)} after the last message. Secrets were replaced on the sending machine, before the message left it.</span>
      </div>
    </section>
  );
}

/** The round trips used against the limit, or why one side cannot answer. */
function Capacity({ link }: { link: TrafficLink }) {
  const ways = waysOf(link);
  if (ways === "aToB" || ways === "bToA") {
    const [x, y] = ordered(link);
    return (
      <div className="cap">
        <span>
          <b>{y.name} cannot answer.</b> {y.machine} cannot send to {x.machine}. Give it that right in My reporters if a reply is wanted.
        </span>
      </div>
    );
  }
  if (ways === "none") {
    return (
      <div className="cap">
        <span>
          <b>Neither can send now.</b> {link.a.machine === link.b.machine ? `${link.a.machine} has no right to send to itself.` : `${link.a.machine} and ${link.b.machine} have no right to send to each other.`} Give one in My reporters to start again.
        </span>
      </div>
    );
  }
  const { used, cap } = link.roundTrips;
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div className="cap">
      <span>
        {used} of {cap} round trips. At {cap}, {link.owner} approves the next message, so two orchestrators cannot keep going on their own.
      </span>
      <div className="bar" role="img" aria-label={`${used} of ${cap} round trips`}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** One message as an Activity feed entry. Its text is text nodes; the only element inside it is `[redacted]`. */
function Message({ m, paused }: { m: PeerMessage; paused: boolean }) {
  const ds = deliveryWords(m, paused);
  // Each part is keyed by where it starts in the text, which never changes for a message.
  let at = 0;
  const parts = redactedParts(m.text).map((text) => {
    const start = at;
    at += text.length + "[redacted]".length;
    return { start, text };
  });
  return (
    <li className="txt">
      <span className="at" title={new Date(m.sentAt).toLocaleString()}>
        {hm(m.sentAt)}
      </span>
      <span className="k" role="img" aria-label="Message" title="Message">
        {ICON_MSG}
      </span>
      <span className="body">
        <span className="who">
          {m.from.name} to {m.to.name}
        </span>
        {parts.map((t, i) => (
          <Part key={t.start} text={t.text} last={i === parts.length - 1} />
        ))}
        <span className={`ds${ds.wait ? " wait" : ""}`}>
          {DELIVERY_ICON[ds.icon]}
          <span>{ds.text}</span>
        </span>
      </span>
    </li>
  );
}

function Part({ text, last }: { text: string; last: boolean }) {
  return (
    <>
      {text}
      {!last && (
        <span className="rd" title="Replaced on the sending machine. The original never left it.">
          [redacted]
        </span>
      )}
    </>
  );
}

function Rules({ retainDays }: { retainDays: number | undefined }) {
  return (
    <Section id="rules-h" title="What a line means">
      <Panel>
        <ul className="plain">
          <li>Messages go only between one person's own orchestrators, through this server. Agents they launched never receive one.</li>
          <li>A message reaches an orchestrator when its turn has ended. Until then it waits, and the conversation says so.</li>
          <li>Pause link stops delivery at once and keeps the rights. Remove link takes every right away, in both directions.</li>
          <li>Secrets, tokens and personal data are replaced on the sending machine before a message leaves it, so this server never holds them.</li>
          <li>Conversations are kept {keptWords(retainDays)} after their last message, as Admin &gt; Settings says. Only their owner and an Admin can read them.</li>
        </ul>
      </Panel>
    </Section>
  );
}
