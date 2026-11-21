// One keyboard stop for a long list (#1231): Chat's message list is a single tab stop however many messages it holds. The message that
// holds the stop has tabindex 0 and the rest -1 (a roving tabindex); Up and Down, Home and End move between messages; Enter, the
// ContextMenu key or Shift+F10 on a message asks for its sender's menu (`onMenu`, issue #1235); Escape inside a message returns focus to it.
// `onKey` lets the list's owner take a key first (the message list's keys for your own messages, #1269) and `focusItem` moves the stop.
// It is not on docs/PATTERNS.md yet: the maintainer approves it as a pattern in the PR for #1231.
import { useCallback, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

const ITEM = "data-roving";

export interface RovingOptions {
  /** Sees every key pressed in the list before the list does, with the item's index and whether it was pressed on the item itself; returning true means it was used. */
  onKey?: (e: KeyboardEvent<HTMLElement>, index: number, onItem: boolean) => boolean;
}

export function useRovingList(count: number, onMenu?: (index: number) => void, opts: RovingOptions = {}) {
  const [stop, setStop] = useState(0);
  const onKeyRef = useRef(opts.onKey);
  onKeyRef.current = opts.onKey;
  const root = useRef<HTMLElement | null>(null);
  const active = Math.max(0, Math.min(stop, count - 1));

  const focusItem = useCallback((i: number) => {
    setStop(i);
    root.current?.querySelector<HTMLElement>(`[${ITEM}="${i}"]`)?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(`[${ITEM}]`);
    if (!item) return;
    const i = Number(item.getAttribute(ITEM));
    const onItem = e.target === item;
    if (onKeyRef.current?.(e, i, onItem)) return;
    if (e.key === "Escape") return focusItem(i);
    if (!onItem) return; // a control inside the message keeps its own keys
    if (e.key === "ArrowDown") return e.preventDefault(), focusItem(Math.min(i + 1, count - 1));
    if (e.key === "ArrowUp") return e.preventDefault(), focusItem(Math.max(i - 1, 0));
    if (e.key === "Home") return e.preventDefault(), focusItem(0);
    if (e.key === "End") return e.preventDefault(), focusItem(count - 1);
    if (onMenu && (e.key === "Enter" || e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
      e.preventDefault();
      onMenu(i);
    }
  };

  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(`[${ITEM}]`);
    if (item) setStop(Number(item.getAttribute(ITEM)));
  };

  return {
    /** Moves the stop to message `i` and gives it the focus. */
    focusItem,
    /** Spread on the list element. */
    listProps: { ref: root as React.RefObject<never>, onKeyDown, onFocus },
    /** Spread on message `i`: the one that holds the stop is tabbable, the rest are reached with the arrow keys. */
    itemProps: (i: number) => ({ tabIndex: i === active ? 0 : -1, [ITEM]: i }),
  };
}
