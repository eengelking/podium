// The menus of Chat (#1034, mockup/podium-chat.html): a Direct Message's (the controls Traffic had, on the row), a channel's stop
// buttons, and an agent's. They open on right-click and on the "..." button, move with the arrow keys, close on Escape (the
// caller puts the focus back) and offer only what the viewer may do, as the overview's `can` flags say.
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { adminPauseOf, adminWho, hasLink, dmName, whoWord, type ChatChannel, type Cross, type DirectInfo } from "../chatData";
import { ChMsg, ChPause, ChPlay, ChTrash } from "./ChatIcons";
import { StateIcon, type StateKind } from "./Chips";

export type MenuAct = "pause-link" | "allow-link" | "remove-link" | "delete-dm" | "pause" | "disconnect" | "pause-all" | "clear" | "message" | "open";

export interface MenuItem {
  act: MenuAct;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  /** Words in place of an action the viewer may not take: the item shows, says why and does nothing. */
  disabled?: string;
  /** An item that goes to a page is a link. */
  href?: string;
}

export interface MenuSpec {
  label: string;
  items: MenuItem[];
  /** Words in place of items the viewer may not use. */
  why?: string;
}

/**
 * A conversation across owners (#1034): the person who wrote and the agent's owner may each pause, resume or remove the link; only the
 * owner (and an Admin) opens it again after a removal. A pause by someone else shows Resume link with who paused it, and does nothing.
 */
function crossMenu(label: string, c: Cross): MenuSpec {
  const items: MenuItem[] = [];
  if (c.link === "paused") {
    const by = c.pausedBy ? whoWord(c, c.pausedBy) : null;
    const byAdmin = c.pausedBy === "admin";
    items.push({ act: "pause-link", label: "Resume link", icon: <ChPlay />, ...(c.canResume === false ? { disabled: byAdmin ? `Paused by ${by}. Only an Admin can resume this link.` : by ? `Paused by ${by}. Only ${by} can resume it.` : "Only the one who paused it can resume it." } : {}) });
  } else if (c.link === "open") items.push({ act: "pause-link", label: "Pause link", icon: <ChPause /> });
  if (c.link === "open" || c.link === "paused") items.push({ act: "remove-link", label: "Remove link…", icon: <ChTrash />, danger: true });
  if (c.link === "removed" && c.viewerIs !== "sender") items.push({ act: "allow-link", label: "Allow again", icon: <ChPlay /> });
  items.push({ act: "delete-dm", label: "Delete conversation…", icon: <ChTrash />, danger: true });
  return { label, items };
}

/**
 * An Admin reading a person's Direct Message may stop a runaway conversation (Pause link, Resume link) and nothing else: removing the
 * link and deleting the conversation are its people's. A link that is already removed has nothing to pause.
 */
function adminMenu(label: string, d: DirectInfo): MenuSpec {
  const c = d.cross;
  const removed = c ? c.link === "removed" : hasLink(d) && !d.canSend.aToB && !d.canSend.bToA && d.state === "active";
  const paused = c ? c.link === "paused" : d.state === "paused" || d.paused;
  const items: MenuItem[] = [];
  if ((c || hasLink(d)) && !removed) items.push({ act: "pause-link", label: paused ? "Resume link" : "Pause link", icon: paused ? <ChPlay /> : <ChPause /> });
  return { label, items, why: `An Admin reads a Direct Message and cannot send in it. ${d.owner} removes the link or deletes the conversation. An Admin can pause all of a reporter's links in Admin > Reporters.` };
}

/** Pause link and Remove link are the owner's, and only for a link between two agents that still has one. */
export function dmMenu(d: DirectInfo, owns: boolean, readOnly = false): MenuSpec {
  const label = `Actions for ${dmName(d)}`;
  if (readOnly) return adminMenu(label, d);
  if (d.cross) return crossMenu(label, d.cross);
  if (!owns) return { label, items: [], why: `Only ${d.owner} can pause or remove this link. An Admin can pause all of a reporter's links in Admin > Reporters.` };
  const removed = hasLink(d) && !d.canSend.aToB && !d.canSend.bToA && d.state === "active";
  const paused = d.state === "paused" || d.paused;
  const items: MenuItem[] = [];
  if (hasLink(d) && !removed) {
    const held = adminPauseOf(d);
    items.push({ act: "pause-link", label: paused ? "Resume link" : "Pause link", icon: paused ? <ChPlay /> : <ChPause />, ...(held ? { disabled: `Paused by ${adminWho(held.name)}. Only an Admin can resume this link.` } : {}) });
    items.push({ act: "remove-link", label: "Remove link…", icon: <ChTrash />, danger: true });
  }
  items.push({ act: "delete-dm", label: "Delete conversation…", icon: <ChTrash />, danger: true });
  return { label, items };
}

/** A channel's stop buttons. Pause holds and keeps access, Disconnect takes the agents' access away, Remove all deletes the history. */
export function channelMenu(c: ChatChannel, reading?: { owner: string }): MenuSpec {
  const general = c.id === "general";
  const mine = general ? "my agents in General" : reading ? `every agent in ${reading.owner}'s group` : "every agent in the group";
  const heldByMe = c.paused && !c.pausedForEveryone;
  // An Admin's pause on a group is the Admin's to lift: its person sees the item and the reason, and nothing happens.
  const held = !general && !reading && heldByMe && c.pausedByAdmin ? `Paused by ${adminWho(c.pausedByAdmin)}. Only an Admin can resume it.` : null;
  const items: MenuItem[] = [];
  if (c.can.pause) items.push({ act: "pause", label: `${heldByMe ? "Resume" : "Pause"} ${mine}`, icon: heldByMe ? <ChPlay /> : <ChPause />, ...(held ? { disabled: held } : {}) });
  if (c.can.disconnect) items.push({ act: "disconnect", label: `${c.disconnected ? "Reconnect" : "Disconnect"} ${mine}`, icon: <ChPause /> });
  if (general && c.can.pauseEveryone) items.push({ act: "pause-all", label: c.pausedForEveryone ? "Resume General for everyone" : "Pause General for everyone", icon: <ChPause /> });
  if (c.can.removeAll) items.push({ act: "clear", label: "Remove all messages…", icon: <ChTrash />, danger: true });
  return { label: `Actions for ${c.name}`, items, ...(general && !c.can.removeAll ? { why: "Only an Admin can pause General for everyone or remove its messages." } : {}) };
}

/** An agent's menu, in People and agents and on a thread's participants: start a message, or open its orchestration page. */
export function agentMenu(name: string, sessionId: string, state: StateKind, withMessage: boolean): MenuSpec {
  const items: MenuItem[] = [];
  if (withMessage) items.push({ act: "message", label: `Message ${name}`, icon: <ChMsg /> });
  items.push({ act: "open", label: "Open orchestration page", icon: <StateIcon kind={state} />, href: `#/?open=${encodeURIComponent(sessionId)}` });
  return { label: `Actions for ${name}`, items };
}

export function ChatMenu(props: { spec: MenuSpec; onPick: (act: MenuAct) => void; onClose: (restoreFocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const noteOnly = props.spec.items.length === 0;
  useEffect(() => {
    // A menu with no items is a note: it takes the focus itself so the keyboard can reach and close it.
    if (noteOnly) ref.current?.focus();
    else items()[0]?.focus();
  }, [noteOnly]);
  const key = (e: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose(true);
    } else if (e.key === "Tab") props.onClose(false);
    else if (e.key === "ArrowDown" && all.length) {
      e.preventDefault();
      all[(at + 1) % all.length]!.focus();
    } else if (e.key === "ArrowUp" && all.length) {
      e.preventDefault();
      all[(at + all.length - 1) % all.length]!.focus();
    } else if (e.key === "Home" && all.length) {
      e.preventDefault();
      all[0]!.focus();
    } else if (e.key === "End" && all.length) {
      e.preventDefault();
      all[all.length - 1]!.focus();
    }
  };
  if (noteOnly) {
    return (
      // A reason with nothing to choose is not a menu: a plain note that takes the focus and closes on Escape.
      <div className="ch-menu ch-note" role="note" aria-label={props.spec.label} ref={ref} tabIndex={-1} onKeyDown={key} data-testid="chat-menu-note">
        {props.spec.why}
      </div>
    );
  }
  return (
    // The keys belong to the menu's own items, which take the focus.
    <div className="ch-menu" role="menu" tabIndex={-1} aria-label={props.spec.label} ref={ref} onKeyDown={key} data-testid="chat-menu">
      {props.spec.items.map((it) =>
        it.href ? (
          <a key={it.act} role="menuitem" href={it.href} data-act={it.act} onClick={() => props.onClose(false)}>
            {it.icon}
            {it.label}
          </a>
        ) : (
          <button key={it.act} type="button" role="menuitem" data-act={it.act} className={it.danger ? "dng" : undefined} aria-disabled={it.disabled ? true : undefined} onClick={() => !it.disabled && props.onPick(it.act)}>
            {it.icon}
            <span>
              {it.label}
              {it.disabled && <span className="sub">{it.disabled}</span>}
            </span>
          </button>
        ),
      )}
      {props.spec.why && <div className="why">{props.spec.why}</div>}
    </div>
  );
}
