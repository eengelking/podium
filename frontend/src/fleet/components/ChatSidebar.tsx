// Chat's sidebar (#1034, #1234, mockup/podium-chat-redesign.html): Channels, Direct Messages, and People and agents, each a sticky, collapsible
// section with a "+" in its title. One row is a button that opens it and a "..." button that opens its menu; a right-click opens the same
// menu. A People and agents row takes the color of the agent's state when pointed at or focused, the same colors as its avatar's mark.
// People and agents is paged ten at a time (#1272, mockup/podium-chat-people-cap.html), and its "+" opens New direct message.
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { adminPauseOf, channelTag, conversationName, conversationSub, MAX_PUBLIC_CHANNELS, PEOPLE_PER_PAGE, dmKey, orderPeople, peopleSort, dmName, dmSub, dmTag, liveReaders, type AgentStatus, type ChatAgent, type ChatChannel, type ChatOverview, type ConversationInfo, type DirectInfo, type Tag } from "../chatData";
import type { SessionView } from "../types";
import { AdminTags, ReadPicker } from "./ChatAdmin";
import { ChatAvatar, ChatAvatarPair, type AvatarProps } from "./ChatAvatar";
import { ChChev, ChDm, ChDots, ChGroup, ChHash, ChPlus, TagGlyph } from "./ChatIcons";
import { ChatMenu, agentMenu, channelMenu, dmMenu, personMenu, type MenuAct, type MenuSpec } from "./ChatMenu";
import { stateKind, type StateKind } from "./Chips";
import { PageNav } from "./PageNav";
import { Tip } from "./Tip";
import { useLeaving } from "../useLeaving";

export const STATE_WORD: Record<StateKind, string> = {
  running: "running",
  waiting: "waiting for you",
  deleg: "delegating",
  bg: "idle on background work",
  stale: "heartbeat lost",
  done: "done",
};

/** The state an agent shows: the wall's own (delegating, idle on background work, heartbeat lost) when the console has the session, else its plain status. */
export function agentState(sessions: Record<string, SessionView>, sessionId: string, status: AgentStatus | null, live = true): StateKind {
  const s = sessions[sessionId];
  if (s) return stateKind(s);
  if (!live) return "done";
  return status === "waiting" ? "waiting" : status === "running" ? "running" : status === "done" ? "done" : "stale";
}

/** One sidebar section: a sticky title with a chevron that collapses it, a muted count and, where there is one, a "+" with a tip. */
function Sec(p: { id: string; title: string; count: number; shut: boolean; onToggle: () => void; add?: { label: string; tip: string; onClick: () => void; disabled?: boolean; describedBy?: string }; className?: string; children: ReactNode }) {
  return (
    <section className={`ch-sec${p.shut ? " shut" : ""}${p.className ? ` ${p.className}` : ""}`} aria-labelledby={`sec-${p.id}`}>
      <h2 id={`sec-${p.id}`}>
        <button type="button" className="ch-fold" aria-expanded={!p.shut} aria-controls={`list-${p.id}`} onClick={p.onToggle}>
          <ChChev />
          <span>{p.title}</span>
          <span className="ch-count">{p.count}</span>
        </button>
        {p.add && (
          <Tip bare className="ch-addwrap" text={p.add.tip}>
            {(tip) => (
              <button type="button" className="ch-add" aria-label={p.add!.label} aria-haspopup="dialog" aria-describedby={[tip, p.add!.describedBy].filter(Boolean).join(" ")} disabled={p.add!.disabled} onClick={p.add!.onClick}>
                <ChPlus />
              </button>
            )}
          </Tip>
        )}
      </h2>
      {p.children}
    </section>
  );
}

/** A Direct Message's avatar: one agent's tile, or both parties overlapped (the other person first, then the agent; or two agents). */
function dmAvatar(d: DirectInfo, sessions: Record<string, SessionView>): ReactNode {
  const agentOf = (x: DirectInfo["a"]): AvatarProps => ({ kind: "agent", name: x.name, family: sessions[x.sessionId]?.modelFamily });
  const agents = [d.a, d.b].filter((x) => x.kind === "agent");
  if (d.cross && agents[0]) return <ChatAvatarPair a={{ kind: "person", name: d.cross.person }} b={agentOf(agents[0])} />;
  if (agents.length === 2) return <ChatAvatarPair a={agentOf(agents[0]!)} b={agentOf(agents[1]!)} />;
  const one = agents[0];
  if (!one) return <span className="ic-wrap"><ChDm /></span>;
  return <ChatAvatar {...agentOf(one)} state={agentState(sessions, one.sessionId, one.status, one.live)} size={28} />;
}

function TagLine({ tag }: { tag: Tag | null }) {
  if (!tag) return null;
  return (
    <span className={`tag${tag.warn ? " warn" : ""}`}>
      <TagGlyph icon={tag.icon} />
      <span>{tag.text}</span>
    </span>
  );
}

/** A row's tags: the plain state, then the red ones an Admin's reading or pause adds. Nothing when there is none. */
function Tags({ tag, admin }: { tag: Tag | null; admin: ReactNode }) {
  if (!tag && !admin) return null;
  return (
    <span className="tags">
      <TagLine tag={tag} />
      {admin}
    </span>
  );
}

export interface SidebarProps {
  overview: ChatOverview;
  sessions: Record<string, SessionView>;
  /** The selected row's key: `c:general`, `c:group`, or `d:<agents>`. */
  selected: string | null;
  menu: string | null;
  onMenu: (key: string | null, by: "button" | "context") => void;
  onClose: (restoreFocus: boolean) => void;
  onPick: (key: string, act: MenuAct) => void;
  onChannel: (id: string) => void;
  /** Opens the New channel and New direct message forms (#1035). */
  onNewChannel: () => void;
  onNewDm: () => void;
  onDm: (d: DirectInfo) => void;
  /** Opens a conversation of people and agents (#1278). */
  onConvo: (id: string) => void;
  onAgent: (a: ChatAgent) => void;
  /** A person's row: opens New direct message with their name searched. */
  onPerson: (name: string) => void;
  /** The person an Admin is reading, or null. While set the sidebar is read only: no unread counts, no People and agents. */
  readAs: string | null;
  /** A channel is open, so a row's menu offers Mention too (#1235). */
  mention: boolean;
  /** What the picker is set to, which can run ahead of `readAs` while the person's list is read. */
  picked: string | null;
  onReadAs: (name: string | null) => void;
  /** The server's clock now, for hiding a reading whose time has passed. */
  serverNow: number;
}

export function ChatSidebar(p: SidebarProps) {
  const { overview: o } = p;
  const person = o.me.person;
  // An agent whose session ended leaves with the wall's own animation, and is not offered while it does (#1110).
  const agentRows = useLeaving(o.agents, (a) => a.sessionId);
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const [pePage, setPePage] = useState(0);
  const [said, setSaid] = useState("");
  // The page announcement is spoken once, then cleared, so it does not linger after the list changes.
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(""), 2000);
    return () => clearTimeout(t);
  }, [said]);
  const fold = (id: string) => () => setShut((m) => ({ ...m, [id]: !m[id] }));
  const row = (key: string, spec: MenuSpec | null, content: ReactNode, opts: { open: () => void; aria: string; cls?: string; title?: string; menuOwner?: boolean; leaving?: boolean; unread?: boolean }) => {
    const on = p.selected === key;
    const ctx = (e: MouseEvent) => {
      if (!spec) return;
      e.preventDefault();
      p.onMenu(key, "context");
    };
    return (
      <li key={key} className={`ch-item${on ? " on" : ""}${opts.unread ? " un" : ""}${opts.cls ? ` ${opts.cls}` : ""}`} onContextMenu={ctx} data-testid={`chat-row-${key}`}>
        <button type="button" className="ch-row" disabled={opts.leaving} onClick={opts.open} aria-current={on ? "true" : undefined} title={opts.title}>
          {content}
        </button>
        {spec && (
          <button type="button" className="ch-more" disabled={opts.leaving} data-more={key} aria-haspopup="menu" aria-expanded={p.menu === key} aria-label={opts.aria} onClick={(e) => {
            e.stopPropagation();
            p.onMenu(p.menu === key ? null : key, "button");
          }}>
            <ChDots />
          </button>
        )}
        {spec && p.menu === key && <ChatMenu spec={spec} onPick={(act) => p.onPick(key, act)} onClose={p.onClose} />}
      </li>
    );
  };

  const channelRow = (c: ChatChannel) => {
    const ro = p.readAs !== null && c.id === "group";
    const sub = c.id === "general" ? "Everyone signed in to this server" : c.kind === "public" ? c.description || "No description yet." : ro ? `${p.readAs}'s own orchestrators and subagents, read only` : `You and your ${o.agents.length} orchestrator${o.agents.length === 1 ? "" : "s"} and subagents`;
    const readers = ro ? [] : liveReaders(c.adminReading, p.serverNow);
    const pause = c.id === "group" && c.paused && c.pausedByAdmin ? adminPauseOf({ paused: true, pausedByAdmin: c.pausedByAdmin }) : null;
    const badge = ro ? null : c.mentions > 0 ? <span className="unread" aria-label={`${c.mentions} mention${c.mentions === 1 ? "" : "s"} of you`}>@ {c.mentions}</span> : c.unread > 0 ? <span className="unread" aria-label={`${c.unread} new`}>{c.unread}</span> : null;
    const menu = channelMenu(c, ro && p.readAs ? { owner: p.readAs } : undefined);
    return row(`c:${c.id}`, menu.items.length || menu.why ? menu : null, (
      <>
        <span className="ic-wrap">{c.kind === "public" ? <ChHash /> : <ChGroup />}</span>
        <span className="stack">
          <span className="nm">{c.name}</span>
          <span className="sub">{sub}</span>
          <Tags tag={channelTag(c)} admin={<AdminTags readers={readers} pause={pause} />} />
        </span>
        {badge}
      </>
    ), { open: () => p.onChannel(c.id), aria: `Actions for ${c.name}`, unread: !ro && c.unread + c.mentions > 0 });
  };

  const dmRow = (d: DirectInfo) => {
    const name = dmName(d);
    const key = `d:${dmKey(d)}`;
    const ro = p.readAs !== null;
    const readers = ro ? [] : liveReaders(d.adminReading, p.serverNow);
    return row(key, dmMenu(d, true, ro), (
      <>
        {dmAvatar(d, p.sessions)}
        <span className="stack">
          <span className="nm" title={name}><bdi>{name}</bdi></span>
          <span className="sub">{dmSub(d, ro)}</span>
          <Tags tag={dmTag(d)} admin={<AdminTags readers={readers} pause={adminPauseOf(d)} />} />
        </span>
        {!ro && d.unread > 0 && <span className="unread" aria-label={`${d.unread} new`}>{d.unread}</span>}
      </>
    ), { open: () => p.onDm(d), aria: `Actions for ${name}`, unread: !ro && d.unread + d.mentions > 0 });
  };

  /** A conversation of people and agents: the other person's avatar, or two of them overlapped (the people first, then the agents). */
  const convoAvatar = (c: ConversationInfo): ReactNode => {
    const others = c.members.filter((m) => !m.you).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "person" ? -1 : 1));
    const av = (m: ConversationInfo["members"][number]): AvatarProps => (m.kind === "agent" ? { kind: "agent", name: m.name } : { kind: "person", name: m.name });
    if (others.length >= 2) return <ChatAvatarPair a={av(others[0]!)} b={av(others[1]!)} />;
    return <ChatAvatar {...av(others[0] ?? c.members[0]!)} size={28} />;
  };

  const convoRow = (c: ConversationInfo) => {
    const name = conversationName(c);
    const ro = p.readAs !== null;
    const readers = ro ? [] : liveReaders(c.adminReading, p.serverNow);
    return row(`v:${c.id}`, null, (
      <>
        {convoAvatar(c)}
        <span className="stack">
          <span className="nm" title={name}><bdi>{name}</bdi></span>
          <span className="sub">{conversationSub(c)}</span>
          <Tags tag={null} admin={<AdminTags readers={readers} pause={null} />} />
        </span>
        {!ro && c.unread > 0 && <span className="unread" aria-label={`${c.unread} new`}>{c.unread}</span>}
      </>
    ), { open: () => p.onConvo(c.id), aria: `Actions for ${name}`, unread: !ro && c.unread + c.mentions > 0 });
  };

  const agentRow = ({ item: a, leaving }: { item: ChatAgent; leaving: boolean }) => {
    const kind = agentState(p.sessions, a.sessionId, a.status);
    return row(`a:${a.sessionId}`, agentMenu(a.name, a.sessionId, kind, true, { mention: p.mention }), (
      <>
        <ChatAvatar kind="agent" name={a.name} family={p.sessions[a.sessionId]?.modelFamily} state={kind} size={28} />
        <span className="stack">
          <span className="nm" title={a.address}><bdi>{a.name}</bdi></span>
          <span className="sub">Orchestrator on <bdi>{a.machine}</bdi>, {STATE_WORD[kind]}</span>
        </span>
      </>
    ), { open: () => p.onAgent(a), aria: `Actions for ${a.name}`, leaving, cls: `hl-${kind}${leaving ? " leave" : ""}`, title: `Message ${a.name}` });
  };

  const personRow = (name: string) => {
    const key = `p:${name}`;
    return row(key, personMenu(name, { mention: p.mention }), (
      <>
        <ChatAvatar kind="person" name={name} size={28} />
        <span className="stack">
          <span className="nm" title={name}><bdi>{name}</bdi></span>
          <span className="sub">Person</span>
        </span>
      </>
    ), { open: () => p.onPerson(name), aria: `Actions for ${name}`, title: `Message ${name}` });
  };
  const others = o.people.filter((x) => !x.you);
  // People and agents, paged ten at a time (#1272): rows that need this person first (unread, mentions, a running agent), then the newest last message.
  const peopleEntries = orderPeople([
    ...agentRows.map((it) => ({ key: `a:${it.item.sessionId}`, name: it.item.name, ...peopleSort(o.directs, (x) => x.sessionId === it.item.sessionId, it.leaving || agentState(p.sessions, it.item.sessionId, it.item.status) === "running"), node: () => agentRow(it) })),
    ...others.map((x) => ({ key: `p:${x.name}`, name: x.name, ...peopleSort(o.directs, (q) => q.kind === "person" && q.name === x.name, false), node: () => personRow(x.name) })),
  ]);
  const pePages = Math.max(1, Math.ceil(peopleEntries.length / PEOPLE_PER_PAGE));
  const peAt = Math.min(pePage, pePages - 1);
  // The list shrank under the page: the state follows, so it does not jump back when the list grows again.
  if (pePage !== peAt) setPePage(peAt);
  const peFrom = peAt * PEOPLE_PER_PAGE;
  const peShown = peopleEntries.slice(peFrom, peFrom + PEOPLE_PER_PAGE);
  const goPe = (n: number) => {
    setPePage(n);
    setSaid(`Page ${n + 1} of ${pePages}`);
  };

  const reading = p.readAs !== null;
  const convos = o.conversations ?? [];
  // The server keeps 50 public channels besides General; at the limit New channel is off and says why (#1035).
  const capped = o.channels.filter((c) => c.kind === "public" && c.id !== "general").length >= MAX_PUBLIC_CHANNELS;
  return (
    <nav className="ch-side" aria-label="Chat">
      {o.me.admin && <ReadPicker people={o.people.filter((x) => !x.you).map((x) => x.name)} value={p.picked} onChange={p.onReadAs} />}
      <Sec id="ch" title="Channels" count={o.channels.length} shut={!!shut.ch} onToggle={fold("ch")} add={{ label: "New channel", tip: "Create a channel", onClick: p.onNewChannel, disabled: capped, describedBy: capped ? "cap-why" : undefined }}>
        {capped && (
          <p className="hint ch-pad" id="cap-why">
            This server has {MAX_PUBLIC_CHANNELS} channels besides General, the most it keeps. An Admin can remove one that is no longer used.
          </p>
        )}
        <ul className="ch-list" id="list-ch">{o.channels.map(channelRow)}</ul>
      </Sec>
      {reading ? (
        <Sec id="dm" title="Direct Messages" count={o.directs.length + convos.length} shut={!!shut.dm} onToggle={fold("dm")}>
          <ul className="ch-list" id="list-dm">
            {convos.map(convoRow)}
            {o.directs.length + convos.length ? o.directs.map(dmRow) : <li className="hint ch-pad">{p.readAs} has no Direct Messages.</li>}
            <li className="hint ch-pad">Conversations between people are not shown to an Admin.</li>
          </ul>
        </Sec>
      ) : person ? (
        <>
          <Sec id="dm" title="Direct Messages" count={o.directs.length + convos.length} shut={!!shut.dm} onToggle={fold("dm")} add={{ label: "New direct message", tip: "Start a direct message", onClick: p.onNewDm }}>
            <ul className="ch-list" id="list-dm">
              {(o.approvals ?? 0) > 0 && (
                <li className="ch-pad">
                  <a className="ch-notice" href="#/me/reporters">
                    {o.approvals === 1 ? "1 message from another person waits" : `${o.approvals} messages from other people wait`} for your approval in My reporters.
                  </a>
                </li>
              )}
              {convos.map(convoRow)}
              {o.directs.length + convos.length ? o.directs.map(dmRow) : <li className="hint ch-pad">No conversations. Use + to start one.</li>}
            </ul>
          </Sec>
          <Sec id="pe" title="People and agents" count={peopleEntries.length} shut={!!shut.pe} onToggle={fold("pe")} add={{ label: "New direct message", tip: "Start a direct message", onClick: p.onNewDm }}>
            <ul className="ch-list" id="list-pe">
              {peopleEntries.length ? peShown.map((e) => e.node()) : <li className="hint ch-pad">No orchestrator is reporting yet.</li>}
            </ul>
            {peopleEntries.length > 0 && !shut.pe && (
              <PageNav label="People and agents pages" compact at={peAt} pages={pePages} from={peFrom} shown={peShown.length} total={peopleEntries.length} perPage={PEOPLE_PER_PAGE} onPage={goPe} />
            )}
            {pePages > 1 && !shut.pe && (
              <div className="vh" role="status">
                {said}
              </div>
            )}
          </Sec>
        </>
      ) : (
        <section className="ch-sec" aria-label="Direct Messages">
          <p className="hint ch-pad">Direct Messages and People and agents belong to a person. Sign in with a person's name to message your own agents.</p>
        </section>
      )}
    </nav>
  );
}
