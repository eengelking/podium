import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useUpdateEvery } from "../updateInterval";
import type { useTheme } from "../useTheme";
import { EdgeTab } from "./EdgeTab";
import { ShortcutsSwitch, ThemePicker } from "./ThemePicker";
import { UpdateEveryPicker } from "./UpdateEveryPicker";

/**
 * The display controls at the right of the banner, folded into one drawer (#1129, mockup/podium-wall-options.html). Every page
 * that shows the banner renders this and nothing else there, so the controls look and sit the same everywhere.
 *
 * Shut, it is one EdgeTab pill with the sliders glyph, named "Wall options". Open, the same pill is the drawer's collapse button
 * at its left end, followed by Refresh every, Shortcuts, Theme and the mode radios. A press outside the drawer, the pill, or
 * Escape closes it, and Escape puts focus back on the pill. It starts shut on every page load.
 *
 * Each control keeps its one stored setting. A page that runs on the refresh interval passes `every` and `onEvery`; one that
 * does not yet (History, Admin) passes neither, and the drawer reads and saves `podium.updateEvery` itself, so the value is
 * the same on every page.
 */
export function WallOptions(props: {
  theme: ReturnType<typeof useTheme>;
  shortcuts: boolean;
  onShortcuts: (on: boolean) => void;
  every?: number;
  onEvery?: (seconds: number) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [stored, setStored] = useUpdateEvery();
  const owned = props.every === undefined;
  const every = props.every ?? stored;
  const { onEvery: passed } = props;
  const onEvery = useCallback((n: number) => (owned ? setStored(n) : passed?.(n)), [owned, passed, setStored]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      // The Keyboard shortcuts list opens from inside the drawer but is portaled to <body>, so a press in it is not outside.
      if (!(t instanceof Node) || root.current?.contains(t) || (t instanceof Element && t.closest(".podium-modal"))) return;
      setOpen(false);
    };
    // A modal stops Escape before it gets here, so Escape in the Keyboard shortcuts list closes the list and leaves the drawer open.
    // Focus goes back to the pill when it was in the drawer or nowhere; a field the person has since moved to keeps it.
    const onKey = (e: KeyboardEvent) => {
      // An Escape another control already used (the chat box's command list, a row menu) is that control's, not the drawer's.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setOpen(false);
      const at = document.activeElement;
      if (!at || at === document.body || root.current?.contains(at)) root.current?.querySelector<HTMLButtonElement>(".edge-tab-opts")?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const body = `${id}-body`;
  return (
    <div ref={root} className={`wallopts${open ? " open" : ""}`}>
      <EdgeTab place="opts" name={open ? "Hide wall options" : "Wall options"} points="right" sliders={!open} controls={body} expanded={open} onToggle={() => setOpen((o) => !o)} />
      <div className="wallopts-body" id={body} hidden={!open}>
        <UpdateEveryPicker every={every} onChange={onEvery} />
        <ShortcutsSwitch on={props.shortcuts} onChange={props.onShortcuts} />
        <ThemePicker theme={props.theme} />
      </div>
    </div>
  );
}
