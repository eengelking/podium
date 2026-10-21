// The row Actions menu on Admin > People (#587, T9; mockup decision 16): a native details disclosure whose box is placed beside
// its button and kept in the window. Up, Down, Home, End and Escape work, and it closes when focus leaves or the page scrolls.
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { IconChevron } from "../components/Icons";

export interface MenuItem {
  label: string;
  act: string;
  danger?: boolean;
  disabled?: boolean;
}
export interface MenuGroup {
  heading: string;
  items: MenuItem[];
}

const GUTTER = 8;

export function RowMenu({ label, groups, onChoose }: { label: string; groups: MenuGroup[]; onChoose: (act: string) => void }) {
  const det = useRef<HTMLDetailsElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLElement>(null);

  const close = (refocus: boolean) => {
    if (!det.current?.open) return;
    det.current.open = false;
    if (refocus) summary.current?.focus();
  };

  // Place the box under the button (above it when there is no room), its right edge on the button's, inside the window.
  const place = () => {
    const d = det.current;
    const b = box.current;
    const s = summary.current;
    if (!d?.open || !b || !s) return;
    const r = s.getBoundingClientRect();
    const h = b.offsetHeight;
    const w = b.offsetWidth;
    const below = r.bottom + 4;
    const top = below + h > window.innerHeight - GUTTER && r.top - 4 - h >= GUTTER ? r.top - 4 - h : below;
    b.style.top = `${Math.max(GUTTER, top)}px`;
    b.style.left = `${Math.max(GUTTER, Math.min(r.right - w, window.innerWidth - w - GUTTER))}px`;
  };
  useLayoutEffect(place);

  // An open menu closes on a click outside it, on Escape, and when the page scrolls or resizes under it.
  useEffect(() => {
    const d = det.current;
    if (!d) return;
    const outside = (e: MouseEvent) => {
      if (d.open && !d.contains(e.target as Node)) close(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && d.open) close(true);
    };
    const away = () => close(false);
    document.addEventListener("click", outside);
    document.addEventListener("keydown", esc);
    document.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", esc);
      document.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, []);

  const enabled = () => Array.from(box.current?.querySelectorAll<HTMLButtonElement>(".mi:not(:disabled)") ?? []);
  const key = (e: KeyboardEvent) => {
    const items = enabled();
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === "ArrowDown" ? items[(i + 1) % items.length] : e.key === "ArrowUp" ? items[(i - 1 + items.length) % items.length] : e.key === "Home" ? items[0] : e.key === "End" ? items[items.length - 1] : null;
    if (!to) return;
    e.preventDefault();
    to.focus();
  };

  return (
    <details
      ref={det}
      className="menu"
      onToggle={() => {
        if (!det.current?.open) return;
        place();
        enabled()[0]?.focus();
      }}
      onBlur={(e) => {
        if (det.current?.open && e.relatedTarget && !det.current.contains(e.relatedTarget as Node)) close(false);
      }}
    >
      <summary ref={summary} className="btn sm" aria-label={label}>
        Actions
        <IconChevron />
      </summary>
      <div ref={box} className="menubox" role="menu" onKeyDown={key}>
        {groups.map((g, gi) => (
          <div key={g.heading} role="group" aria-label={g.heading} className="mgroup">
            {gi > 0 && <div className="msep" role="separator" />}
            <div className="mgh" aria-hidden="true">
              {g.heading}
            </div>
            {g.items.map((it) => (
              <button
                key={it.act}
                type="button"
                role="menuitem"
                className={it.danger ? "mi dng" : "mi"}
                disabled={it.disabled}
                onClick={() => {
                  close(false);
                  onChoose(it.act);
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}
