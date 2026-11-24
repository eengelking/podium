// How the keyboard and the pointer reach the messages of a Chat conversation (#1231, #1235, #1269, #1345): one tab stop for the whole list, Enter, the
// ContextMenu key or Shift+F10 on a message to open its menu, E and Delete on one of yours, Up in an empty box to your latest message, and Up and Down
// through your own. Every thread of Chat (a channel, a Direct Message to an agent, a conversation of people) uses this one copy, so they cannot differ.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { useRovingList } from "../useRovingList";
import type { MenuAt } from "./ChatMenu";

export interface OwnMessageNavOptions<M extends { id: string }> {
  messages: M[];
  /** Whether the viewer wrote it. */
  isMine: (m: M) => boolean;
  /** Why one of your own messages cannot be edited or deleted now, or "" when it can. */
  whyNot: (m: M) => string;
  /** Whether one of your own messages has a menu. */
  hasMenu: (m: M) => boolean;
  /** Whether a message has a sender, and so a menu on its avatar. */
  hasSender: (m: M) => boolean;
  /** An Admin is reading: nothing of it can be changed. */
  readOnly: boolean;
  /** What a screen reader hears when a message of yours takes the focus. */
  saidOf: (m: M) => string;
  /** A request to put the focus back on a message (after an edit, a cancel or a delete); each has its own `n`. */
  focus: { id: string; n: number } | null;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  /** Opens the menu on one of your own messages, or on a message's sender, at a place. */
  openMenu: (m: M, which: "own" | "sender", by: "button" | "context", at: MenuAt) => void;
  /** The scrolling list, whose items are found by their index, and the thread that holds the message box. */
  list: RefObject<HTMLElement | null>;
  section: RefObject<HTMLElement | null>;
}

export function useOwnMessageNav<M extends { id: string }>(o: OwnMessageNavOptions<M>) {
  const [said, setSaid] = useState("");
  // How the focus got to a message of yours. From the box's Up, a right-click or a menu, Up and Down visit your own messages only (#1269), the
  // way Teams and Slack do; reached with Tab or a click, they keep the list's own arrows and visit every message (#1231). Tab, a click or
  // a focus that comes from elsewhere ends it, so there is no way the list keeps a person in it or skips a message they came to read.
  const ownNav = useRef(false);
  const programmatic = useRef(false);
  const live = useRef(o);
  useLayoutEffect(() => {
    live.current = o;
  });
  const { messages: items } = o;

  const openOwnMenu = (i: number) => {
    const m = items[i];
    if (!m) return;
    const item = o.list.current?.querySelector<HTMLElement>(`[data-roving="${i}"]`);
    const r = (item?.querySelector(".ch-tx") ?? item)?.getBoundingClientRect();
    if (r) o.openMenu(m, "own", "button", { x: r.left + 16, y: r.bottom + 4, top: r.top, from: item ?? null });
  };
  const roving = useRovingList(
    items.length,
    (i) => {
      const m = items[i];
      if (m && o.isMine(m)) return; // yours opens its own menu, from the keys below
      if (!m || !o.hasSender(m)) return;
      const item = o.list.current?.querySelector<HTMLElement>(`[data-roving="${i}"]`);
      const r = (item?.querySelector(".ch-gut") ?? item)?.getBoundingClientRect();
      if (r) o.openMenu(m, "sender", "button", { x: r.left, y: r.bottom, top: r.top, from: item ?? null });
    },
    {
      onKey: (e, i, onItem) => {
        const m = items[i];
        if (!onItem || !m || !o.isMine(m) || o.readOnly || e.altKey || e.metaKey || e.ctrlKey) return false;
        const k = e.key;
        const mine = items.flatMap((x, n) => (o.isMine(x) ? [n] : []));
        const here = mine.indexOf(i);
        if (ownNav.current && k === "Escape") {
          e.preventDefault();
          toBox();
          return true;
        }
        if (ownNav.current && (k === "ArrowUp" || k === "ArrowDown") && !e.shiftKey) {
          e.preventDefault();
          const next = mine[here + (k === "ArrowUp" ? -1 : 1)];
          if (next !== undefined) toMessageAt(next);
          else if (k === "ArrowDown") toBox();
          return true;
        }
        if (e.repeat) return false;
        const why = o.whyNot(m);
        if (k === "e" || k === "E") {
          e.preventDefault();
          if (why) setSaid(why);
          else o.onEdit(m.id);
          return true;
        }
        if (k === "Delete" || k === "Backspace") {
          e.preventDefault();
          if (why) setSaid(why);
          else o.onDelete(m.id);
          return true;
        }
        if ((k === "Enter" || k === "ContextMenu" || (k === "F10" && e.shiftKey)) && o.hasMenu(m)) {
          e.preventDefault();
          openOwnMenu(i);
          return true;
        }
        return false;
      },
    },
  );
  // A message of yours takes the focus from the keyboard (the box's Up, Up and Down among them), and says what it is.
  const toMessageAt = (i: number) => {
    const m = items[i];
    if (!m) return;
    ownNav.current = true;
    programmatic.current = true;
    roving.focusItem(i);
    programmatic.current = false;
    setSaid(o.saidOf(m));
  };
  const toBox = () => {
    ownNav.current = false;
    setSaid("");
    o.section.current?.querySelector<HTMLTextAreaElement>(".ch-composer textarea")?.focus();
  };
  const focusAsk = o.focus;
  useEffect(() => {
    if (!focusAsk) return;
    const i = items.findIndex((x) => x.id === focusAsk.id);
    if (i >= 0) toMessageAt(i);
    // Each request has its own number.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAsk?.n]);

  // Up in an empty message box, with no @ or / list open to take it, moves to your latest message (#1269).
  const fromBox = (e: KeyboardEvent<HTMLElement>) => {
    const box = e.target;
    if (e.key !== "ArrowUp" || e.defaultPrevented || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return;
    if (!(box instanceof HTMLTextAreaElement) || !box.closest(".ch-composer") || box.value !== "" || o.readOnly) return;
    const last = items.reduce((at, x, n) => (o.isMine(x) ? n : at), -1);
    if (last < 0) return;
    e.preventDefault();
    toMessageAt(last);
  };
  const onListFocus = (e: FocusEvent<HTMLElement>) => {
    roving.listProps.onFocus(e);
    const from = e.relatedTarget;
    if (!programmatic.current && from instanceof Element && !e.currentTarget.contains(from) && !from.closest(".ch-menu")) ownNav.current = false;
  };
  // Stable for the life of the list, so a row that memoizes on them is not drawn again for a new render of the thread (#1296).
  const acts = useMemo(
    () => ({
      /** A right-click on one of your messages. */
      onContext: (m: M, e: MouseEvent<HTMLElement>) => {
        e.preventDefault();
        ownNav.current = true;
        live.current.openMenu(m, "own", "context", { x: e.clientX, y: e.clientY, from: e.currentTarget });
      },
      /** A right-click on a message's avatar opens its sender's menu at the pointer. */
      onSender: (m: M, at: MenuAt) => live.current.openMenu(m, "sender", "context", at),
    }),
    [],
  );

  return {
    roving,
    said,
    setSaid,
    fromBox,
    acts,
    /** Spread on the `ol` of messages. */
    listProps: { ...roving.listProps, onFocus: onListFocus, onMouseDown: () => void (ownNav.current = false) },
  };
}
