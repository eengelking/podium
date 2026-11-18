import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

// The console's modal (issue #97, mockup/podium-prompt-modal.html), shared by the Report modal and the activity
// feed's (#118). Portaled to <body> inside its own .podium wrapper for the theme tokens; the app behind it blurs
// (body.modal-open). It closes with the X, Esc or a mousedown on the dimmed area; focus moves to the X, Tab stays
// inside, and the caller returns focus to whatever opened it. While it is open the page behind gets no keys, so
// Esc does not leave wall mode and the shell shortcuts are off.

const FOCUSABLE = "button:not([disabled]), a[href], select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex='0']";
/** Fields inside the dialog keep their own keys (Enter to send, arrows in a list); the shell's shortcuts already skip fields. */
const FIELD = "input, textarea, select";

/** The widest an anchored modal is, in pixels: the `.modal.anchor` width in fleet.css. */
export const ANCHORED_WIDTH = 440;
/** The room kept between an anchored modal and the window's edge. */
const EDGE = 16;

/** Where an anchored modal goes: 8 px under the element, its left edge 12 px left of it, kept inside the window. */
export function anchoredAt(el: HTMLElement): { top: number; left: number } {
  const r = el.getBoundingClientRect();
  const width = Math.min(ANCHORED_WIDTH, window.innerWidth - 2 * EDGE);
  return { top: Math.round(r.bottom + 8), left: Math.max(EDGE, Math.min(Math.round(r.left - 12), window.innerWidth - width - EDGE)) };
}

export function Modal(props: {
  titleId: string;
  title: ReactNode;
  sub?: ReactNode;
  /** Controls in the header, before the X. */
  actions?: ReactNode;
  /** Esc goes here first; returning true means it was used (a confirmation closed), and the modal stays open. */
  onEscape?: () => boolean;
  onClose: () => void;
  className?: string;
  /** Open under this element instead of in the middle of the page (#1209): the (i) in the banner that opened it. */
  anchor?: HTMLElement | null;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const onEscape = useRef(props.onEscape);
  onEscape.current = props.onEscape;

  useEffect(() => {
    document.body.classList.add("modal-open");
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const inField = e.target instanceof Element && dialog.current?.contains(e.target) && e.target.closest(FIELD) !== null;
      // A tab list keeps the arrow keys that move between its tabs (#897); every other key is the modal's, as before.
      if (e.target instanceof Element && (e.key === "ArrowLeft" || e.key === "ArrowRight") && dialog.current?.contains(e.target) && e.target.closest('[role="tablist"]') !== null) return;
      // A field that offers a choice with Tab (the message box's command list) says so with data-keeps-tab.
      if (inField && e.key !== "Escape" && (e.key !== "Tab" || (e.target as Element).hasAttribute("data-keeps-tab"))) return;
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        if (onEscape.current?.()) return;
        onClose.current();
      } else if (e.key === "Tab") {
        const f = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
        const first = f[0];
        const last = f[f.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.classList.remove("modal-open");
    };
  }, []);

  const place = props.anchor ? anchoredAt(props.anchor) : undefined;
  return createPortal(
    <div className="podium podium-modal">
      <div
        className={`scrim${place ? " anchor" : ""}`}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        <div className={`modal${place ? " anchor" : ""}${props.className ? ` ${props.className}` : ""}`} style={place} role="dialog" aria-modal="true" aria-labelledby={props.titleId} ref={dialog}>
          <div className="mh">
            <div className="ttl">
              <h2 id={props.titleId}>{props.title}</h2>
              {props.sub && <div className="sub2">{props.sub}</div>}
            </div>
            {props.actions}
            <button type="button" className="x" ref={closeBtn} onClick={props.onClose} aria-label="Close (Esc)">
              ✕
            </button>
          </div>
          {props.children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
