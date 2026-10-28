import { useRef, type ReactNode } from "react";

/** The id of the update notice (#499). Closing it hides one release, not the notice, so it is closed through its own route. */
export const UPDATE_NOTICE_ID = "update-available";

/** One informational wall notice. A later notice adds an entry where the stack is built, and gets its X for free. */
export interface NoticeItem {
  id: string;
  name: string;
  body: ReactNode;
}

/**
 * Informational notices sit together at the bottom of the wall, one per row, each with an X. Closing one turns it off
 * for everyone and the user is told where to switch it back on (Admin > Settings). Errors and connection problems are
 * not notices and never come through here. SPEC 8.1.
 */
export function NoticeStack({ items, onClose }: { items: NoticeItem[]; onClose: (item: NoticeItem) => void }) {
  if (!items.length) return null;
  return (
    <div className="notices">
      {items.map((n) => (
        <div className="fold" key={n.id}>
          <div className="txt">{n.body}</div>
          <button type="button" className="x" aria-label={`Close notice: ${n.name}`} onClick={() => onClose(n)}>
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The confirmation after a notice is closed: which notice, and the link to Admin > Settings. It has its own X. A notice that
 * only hides one release (the update notice) passes `until`, the release it hid, and says it comes back for a newer one.
 */
export function NoticeClosed({ name, until, onDismiss, onHold }: { name: string; until?: string; onDismiss: () => void; onHold: (held: boolean) => void }) {
  // Pointer and focus are tracked apart: the timer waits while either is on the toast, so a pointer leaving must not release a focused one.
  const over = useRef({ pointer: false, focus: false });
  const set = (k: "pointer" | "focus", v: boolean) => {
    over.current[k] = v;
    onHold(over.current.pointer || over.current.focus);
  };
  return (
    <div
      className="toast"
      role="status"
      onMouseEnter={() => set("pointer", true)}
      onMouseLeave={() => set("pointer", false)}
      onFocus={() => set("focus", true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) set("focus", false);
      }}
    >
      <div className="t">
        <b>{until ? "Notice dismissed" : "Notice turned off"}</b>
        <span>
          {until
            ? `“${name}” will show again when a release newer than ${until} comes out. You can turn the release check off in Admin > Settings.`
            : `“${name}” will not show again. You can turn it back on or off in Admin > Settings.`}
        </span>
        <br />
        <a className="go" href="#/admin/settings">
          Open Admin &gt; Settings
        </a>
      </div>
      <button type="button" className="x" aria-label="Close this message" onClick={onDismiss}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>
  );
}
