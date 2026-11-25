// The members of a thread (#1236, mockup/podium-chat-redesign.html): an avatar stack with a count in the thread header, and the panel it
// toggles on the right (a sheet over the thread on a narrow window) with search, filter chips, People and Agents and "Showing N of M". It
// is built from what the client already has (the overview and the console's sessions), so it adds no route; a public channel's list is
// only what this page knows, and the panel says so.
import { useEffect, useRef, useState } from "react";
import type { ChatOverview } from "../chatData";
import type { ModelFamily, SessionView } from "../types";
import { ChatAvatar } from "./ChatAvatar";
import { ChatMenu, agentMenu, personMenu, type MenuAct } from "./ChatMenu";
import { agentState } from "./ChatSidebar";
import { ChSearch, ChX } from "./ChatIcons";
import { StateIcon, type StateKind } from "./Chips";

/** How many members the panel lists before "Show more". */
export const MEMBER_PAGE = 20;
/** The avatars the stack draws before the count. */
const STACK_MAX = 4;

export interface Member {
  key: string;
  kind: "you" | "person" | "agent";
  name: string;
  /** The muted line: Owner or Member for a person; model and role for an agent. */
  line: string;
  /** An agent's state, or null for a person (the client has no presence to show). */
  state: StateKind | null;
  word: string | null;
  family?: ModelFamily;
  /** An orchestrator's session, which its menu opens. A subagent or a fork has none and no menu. */
  sessionId?: string;
}

export type MemberFilter = "all" | "waiting" | "running";

const STATE_WORD: Record<StateKind, string> = { running: "Running", waiting: "Waiting", deleg: "Delegating", bg: "Idle", stale: "Lost", done: "Done" };
const famWord = (f: ModelFamily, model: string | null) => (f === "other" ? (model ?? "Model") : f[0]!.toUpperCase() + f.slice(1));

/**
 * Who is in a thread, from the data the client has. My group is the person (the one an Admin reads as, when reading) and their
 * orchestrators with the subagents and forks the console knows. A channel is the people and agents the overview lists, which is not
 * everyone who can read it, so it is partial (decision 16 on #1229: no route to list a large channel).
 */
export function membersOf(o: ChatOverview, sessions: Record<string, SessionView>, opts: { group: boolean; person: string | null; mine: boolean }): { members: Member[]; partial: boolean } {
  const members: Member[] = [];
  if (opts.group) {
    if (opts.person) {
      // Whether My group is the viewer's own is the caller's: it is, unless an Admin reads as someone. Never a name comparison.
      members.push({ key: `p:${opts.person}`, kind: opts.mine ? "you" : "person", name: opts.person, line: "Owner", state: null, word: null });
    }
  } else {
    for (const p of o.people) members.push({ key: `p:${p.name}`, kind: p.you ? "you" : "person", name: p.name, line: "Member", state: null, word: null });
  }
  for (const a of o.agents) {
    const s = sessions[a.sessionId];
    const state = agentState(sessions, a.sessionId, a.status, true);
    members.push({ key: `a:${a.sessionId}`, kind: "agent", name: a.name, line: s ? `${famWord(s.modelFamily, s.model)} · orchestrator` : `Orchestrator on ${a.machine}`, state, word: STATE_WORD[state], ...(s ? { family: s.modelFamily } : {}), sessionId: a.sessionId });
    if (!opts.group) continue;
    for (const g of s?.agents ?? []) {
      const gs: StateKind = g.status === "done" || g.status === "failed" || g.status === "aborted" ? "done" : "running";
      const what = g.kind === "fork" ? "fork" : "subagent";
      members.push({ key: `g:${a.sessionId}:${g.id}`, kind: "agent", name: g.name ?? g.description ?? what, line: `${famWord(g.modelFamily, g.model)} · ${what} of ${a.name}`, state: gs, word: STATE_WORD[gs], family: g.modelFamily });
    }
  }
  return { members, partial: !opts.group };
}

const isRunning = (m: Member) => m.state === "running" || m.state === "deleg";

export function filterMembers(all: readonly Member[], q: string, filter: MemberFilter): Member[] {
  const needle = q.trim().toLowerCase();
  return all.filter((m) => (filter === "all" || (filter === "waiting" ? m.state === "waiting" : isRunning(m))) && (!needle || `${m.name} ${m.line}`.toLowerCase().includes(needle)));
}

const avatarOf = (m: Member, size: 22 | 28) => <ChatAvatar kind={m.kind === "agent" ? "agent" : m.kind} name={m.name} size={size} css {...(m.family ? { family: m.family } : {})} />;

/** The toggle in the thread header: up to four avatars overlapped, then the count. One button, named for what it does. */
export function ChatMembersStack(p: { members: readonly Member[]; open: boolean; controls: string; onToggle: () => void }) {
  const n = p.members.length;
  return (
    <button type="button" className="ch-stack" aria-expanded={p.open} aria-controls={p.controls} aria-label={`Members, ${n}. ${p.open ? "Hide" : "Show"} the list`} data-testid="chat-members-toggle" onClick={p.onToggle}>
      <span className="ch-stack-av" aria-hidden="true">
        {p.members.slice(0, STACK_MAX).map((m) => (
          <span key={m.key}>{avatarOf(m, 22)}</span>
        ))}
      </span>
      {n}
    </button>
  );
}

// An agent keeps the key its chip had (`h:`) and a person gets `mp:`, so the sidebar row of the same one (`a:`, `p:`) is a different menu.
const menuKey = (m: Member) => (m.sessionId ? `h:${m.sessionId}` : `mp:${m.name}`);

export function ChatMembersPanel(p: {
  id: string;
  label: string;
  members: readonly Member[];
  partial: boolean;
  menu: string | null;
  /** A channel is open, so Mention is offered; and whether an Admin is reading, when nothing that sends is (#1235). */
  mention: boolean;
  reading: boolean;
  onMenu: (key: string | null, by: "button" | "context") => void;
  onMenuClose: (restoreFocus: boolean) => void;
  onPick: (key: string, act: MenuAct) => void;
  onClose: () => void;
  /** A button under the title, such as Add people or agents (#1278). */
  action?: React.ReactNode;
  /** No menu on a row: a conversation's members are listed, not messaged from here. */
  plain?: boolean;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<MemberFilter>("all");
  const [shown, setShown] = useState(MEMBER_PAGE);
  // Close (a row's open menu with it), and put the focus back on the stack that opened it.
  const close = () => {
    p.onMenuClose(false);
    p.onClose();
    document.querySelector<HTMLElement>(`[aria-controls="${p.id}"]`)?.focus();
  };
  const closeNow = useRef(close);
  closeNow.current = close;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // An Escape something else already used (the message box closing its @ list) is not this panel's.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      closeNow.current();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  const matches = filterMembers(p.members, q, filter);
  const page = matches.slice(0, shown);
  const people = page.filter((m) => m.kind !== "agent");
  const agents = page.filter((m) => m.kind === "agent");
  const total = (k: "people" | "agents") => matches.filter((m) => (k === "agents") === (m.kind === "agent")).length;
  const waiting = p.members.filter((m) => m.state === "waiting").length;
  const running = p.members.filter(isRunning).length;
  const chip = (f: MemberFilter, text: string) => (
    <button type="button" aria-pressed={filter === f} onClick={() => { setFilter(f); setShown(MEMBER_PAGE); }}>
      {text}
    </button>
  );
  const row = (m: Member) => {
    const key = menuKey(m);
    const opts = { mention: p.mention, reading: p.reading };
    const menu = p.plain ? null : m.kind === "person" ? personMenu(m.name, opts) : m.kind === "agent" && m.sessionId ? agentMenu(m.name, m.sessionId, m.state ?? "done", true, opts) : null;
    return (
      <li
        key={m.key}
        className="ch-mem-row"
        {...(menu ? { onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); p.onMenu(key, "context"); } } : {})}
      >
        <ChatAvatar
          kind={m.kind === "agent" ? "agent" : m.kind}
          name={m.name}
          size={28}
          {...(m.family ? { family: m.family } : {})}
          {...(m.state ? { state: m.state } : {})}
          {...(menu ? { more: key, expanded: p.menu === key, onMenu: () => p.onMenu(p.menu === key ? null : key, "button") } : {})}
        />
        <span className="ch-mem-t">
          <b>
            <bdi>{m.name}</bdi>
            {m.kind === "you" ? " (you)" : ""}
          </b>
          <span>{m.line}</span>
        </span>
        {m.state && m.word && (
          <span className="ch-mem-st">
            <StateIcon kind={m.state} />
            {m.word}
          </span>
        )}
        {menu && p.menu === key && <ChatMenu spec={menu} onPick={(act) => p.onPick(key, act)} onClose={p.onMenuClose} />}
      </li>
    );
  };
  const left = matches.length - page.length;
  return (
    <aside className="ch-mem" id={p.id} aria-label={`Members of ${p.label}`} data-testid="chat-members">
      <div className="ch-mem-h">
        <h3>
          Members <span className="n">{p.members.length}</span>
        </h3>
        <button type="button" className="ch-mem-x" aria-label="Close members" onClick={close}>
          <ChX />
        </button>
      </div>
      {p.action && <div className="ch-mem-act">{p.action}</div>}
      <div className="ch-mem-q">
        <span className="ch-mem-srch">
          <ChSearch />
          <input type="search" aria-label="Find a member" placeholder="Find a member" value={q} onChange={(e) => { setQ(e.target.value); setShown(MEMBER_PAGE); }} />
        </span>
        <div className="ch-mem-filt" role="group" aria-label="Filter members">
          {chip("all", "All")}
          {chip("waiting", `Waiting ${waiting}`)}
          {chip("running", `Running ${running}`)}
        </div>
      </div>
      <div className="ch-mem-list">
        {matches.length === 0 && <p className="hint ch-mem-none">No member matches that.</p>}
        {people.length > 0 && (
          <>
            <h4>
              People <span className="n">{total("people")}</span>
            </h4>
            <ul>{people.map(row)}</ul>
          </>
        )}
        {agents.length > 0 && (
          <>
            <h4>
              Agents <span className="n">{total("agents")}</span>
            </h4>
            <ul>{agents.map(row)}</ul>
          </>
        )}
      </div>
      {matches.length > 0 && (
        <div className="ch-mem-more">
          <span role="status">
            Showing {page.length} of {matches.length}
          </span>
          {left > 0 && (
            <button type="button" onClick={() => setShown(shown + MEMBER_PAGE)}>
              Show {Math.min(left, MEMBER_PAGE)} more
            </button>
          )}
          {p.partial && <span className="ch-mem-note">This is only the people and agents this page knows. Others may read this too.</span>}
        </div>
      )}
    </aside>
  );
}
