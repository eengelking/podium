// Chat's sidebar (#1034, mockup/podium-chat.html): Channels, Direct Messages, and People and agents. One row is a button that
// opens it and a "..." button that opens its menu; a right-click opens the same menu. A People and agents row takes the color
// of the agent's state when pointed at or focused, the same colors as its icon.
import type { MouseEvent, ReactNode } from "react";
import { adminPauseOf, channelTag, dmName, dmSub, dmTag, liveReaders, type AgentStatus, type ChatAgent, type ChatChannel, type ChatOverview, type DirectInfo, type Tag } from "../chatData";
import type { SessionView } from "../types";
import { AdminTags, ReadPicker } from "./ChatAdmin";
import { ChDm, ChDots, ChGroup, ChHash, TagGlyph } from "./ChatIcons";
import { ChatMenu, agentMenu, channelMenu, dmMenu, type MenuAct, type MenuSpec } from "./ChatMenu";
import { StateIcon, stateKind, type StateKind } from "./Chips";

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
  onChannel: (id: "general" | "group") => void;
  onDm: (d: DirectInfo) => void;
  onAgent: (a: ChatAgent) => void;
  /** The person an Admin is reading, or null. While set the sidebar is read only: no unread counts, no People and agents. */
  readAs: string | null;
  /** What the picker is set to, which can run ahead of `readAs` while the person's list is read. */
  picked: string | null;
  onReadAs: (name: string | null) => void;
  /** The server's clock now, for hiding a reading whose time has passed. */
  serverNow: number;
}

export function ChatSidebar(p: SidebarProps) {
  const { overview: o } = p;
  const person = o.me.person;
  const row = (key: string, spec: MenuSpec | null, content: ReactNode, opts: { open: () => void; aria: string; cls?: string; title?: string; menuOwner?: boolean }) => {
    const on = p.selected === key;
    const ctx = (e: MouseEvent) => {
      if (!spec) return;
      e.preventDefault();
      p.onMenu(key, "context");
    };
    return (
      <li key={key} className={`ch-item${on ? " on" : ""}${opts.cls ? ` ${opts.cls}` : ""}`} onContextMenu={ctx} data-testid={`chat-row-${key}`}>
        <button type="button" className="ch-row" onClick={opts.open} aria-current={on ? "true" : undefined} title={opts.title}>
          {content}
        </button>
        {spec && (
          <button type="button" className="ch-more" data-more={key} aria-haspopup="menu" aria-expanded={p.menu === key} aria-label={opts.aria} onClick={(e) => {
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
    const sub = c.id === "general" ? "Everyone signed in to this server" : ro ? `${p.readAs}'s own orchestrators and subagents, read only` : `You and your ${o.agents.length} orchestrator${o.agents.length === 1 ? "" : "s"} and subagents`;
    const readers = ro ? [] : liveReaders(c.adminReading, p.serverNow);
    const pause = c.id === "group" && c.paused && c.pausedByAdmin ? adminPauseOf({ paused: true, pausedByAdmin: c.pausedByAdmin }) : null;
    const badge = ro ? null : c.mentions > 0 ? <span className="unread" aria-label={`${c.mentions} mention${c.mentions === 1 ? "" : "s"} of you`}>@ {c.mentions}</span> : c.unread > 0 ? <span className="unread" aria-label={`${c.unread} new`}>{c.unread}</span> : null;
    const menu = channelMenu(c, ro && p.readAs ? { owner: p.readAs } : undefined);
    return row(`c:${c.id}`, menu.items.length || menu.why ? menu : null, (
      <>
        {c.id === "general" ? <ChHash /> : <ChGroup />}
        <span className="stack">
          <span className="nm">{c.name}</span>
          <span className="sub">{sub}</span>
          <Tags tag={channelTag(c)} admin={<AdminTags readers={readers} pause={pause} />} />
        </span>
        {badge}
      </>
    ), { open: () => p.onChannel(c.id), aria: `Actions for ${c.name}` });
  };

  const dmRow = (d: DirectInfo) => {
    const name = dmName(d);
    const key = `d:${[d.a, d.b].filter((x) => x.kind === "agent").map((x) => x.sessionId).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("+")}`;
    const ro = p.readAs !== null;
    const readers = ro ? [] : liveReaders(d.adminReading, p.serverNow);
    return row(key, dmMenu(d, true, ro), (
      <>
        <ChDm />
        <span className="stack">
          <span className="nm" title={name}>{name}</span>
          <span className="sub">{dmSub(d, ro)}</span>
          <Tags tag={dmTag(d)} admin={<AdminTags readers={readers} pause={adminPauseOf(d)} />} />
        </span>
        {!ro && d.unread > 0 && <span className="unread" aria-label={`${d.unread} new`}>{d.unread}</span>}
      </>
    ), { open: () => p.onDm(d), aria: `Actions for ${name}` });
  };

  const agentRow = (a: ChatAgent) => {
    const kind = agentState(p.sessions, a.sessionId, a.status);
    return row(`a:${a.sessionId}`, agentMenu(a.name, a.sessionId, kind, true), (
      <>
        <StateIcon kind={kind} />
        <span className="stack">
          <span className="nm" title={a.address}>{a.name}</span>
          <span className="sub">Orchestrator on {a.machine}, {STATE_WORD[kind]}</span>
        </span>
      </>
    ), { open: () => p.onAgent(a), aria: `Actions for ${a.name}`, cls: `hl-${kind}`, title: `Message ${a.name}` });
  };

  const reading = p.readAs !== null;
  return (
    <nav className="ch-side" aria-label="Chat">
      {o.me.admin && <ReadPicker people={o.people.filter((x) => !x.you).map((x) => x.name)} value={p.picked} onChange={p.onReadAs} />}
      <section className="ch-sec" aria-labelledby="sec-ch">
        <h2 id="sec-ch">Channels</h2>
        <ul className="ch-list">{o.channels.map(channelRow)}</ul>
      </section>
      {reading ? (
        <section className="ch-sec" aria-labelledby="sec-dm">
          <h2 id="sec-dm">Direct Messages</h2>
          <ul className="ch-list">{o.directs.length ? o.directs.map(dmRow) : <li className="hint ch-pad">{p.readAs} has no Direct Messages.</li>}</ul>
        </section>
      ) : person ? (
        <>
          <section className="ch-sec" aria-labelledby="sec-dm">
            <h2 id="sec-dm">Direct Messages</h2>
            <ul className="ch-list">
              {(o.approvals ?? 0) > 0 && (
                <li className="ch-pad">
                  <a className="ch-notice" href="#/me/reporters">
                    {o.approvals === 1 ? "1 message from another person waits" : `${o.approvals} messages from other people wait`} for your approval in My reporters.
                  </a>
                </li>
              )}
              {o.directs.length ? o.directs.map(dmRow) : <li className="hint ch-pad">No conversations. Start one from People and agents.</li>}
            </ul>
          </section>
          <section className="ch-sec" aria-labelledby="sec-pe">
            <h2 id="sec-pe">People and agents</h2>
            <ul className="ch-list">
              {o.agents.length ? o.agents.map(agentRow) : <li className="hint ch-pad">No orchestrator is reporting yet.</li>}
            </ul>
          </section>
        </>
      ) : (
        <section className="ch-sec" aria-label="Direct Messages">
          <p className="hint ch-pad">Direct Messages and People and agents belong to a person. Sign in with a person's name to message your own agents.</p>
        </section>
      )}
    </nav>
  );
}
