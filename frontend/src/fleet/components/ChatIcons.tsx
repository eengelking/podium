// The small icons Chat draws (#1034, mockup/podium-chat.html). Each is decorative: the words beside it carry the meaning.
import type { ReactNode } from "react";
import type { DeliveryIcon, TagIcon } from "../chatData";

const base = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false } as const;

function Ic({ children, className, solid }: { children: ReactNode; className?: string; solid?: boolean }) {
  return (
    <svg {...base} className={className} {...(solid ? { fill: "currentColor", stroke: "none" } : {})}>
      {children}
    </svg>
  );
}

export const ChHash = () => (
  <Ic className="ic">
    <path d="M6 2.5L5 13.5M11 2.5L10 13.5M2.8 6h10.4M2.3 10h10.4" />
  </Ic>
);
export const ChGroup = () => (
  <Ic className="ic">
    <circle cx="5.5" cy="5.5" r="2.2" />
    <circle cx="11" cy="6.5" r="1.8" />
    <path d="M1.8 13c.5-2.3 2-3.4 3.7-3.4s3.2 1.1 3.7 3.4M10 9.8c2 0 3.6 1 4.2 3.2" />
  </Ic>
);
export const ChDm = () => (
  <Ic className="ic">
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
  </Ic>
);
export const ChDots = () => (
  <Ic solid>
    <circle cx="3.5" cy="8" r="1.4" />
    <circle cx="8" cy="8" r="1.4" />
    <circle cx="12.5" cy="8" r="1.4" />
  </Ic>
);
export const ChPause = () => (
  <Ic>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.5 5.5v5M9.5 5.5v5" />
  </Ic>
);
export const ChPlay = () => (
  <Ic>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.8 5.6v4.8l3.6-2.4z" />
  </Ic>
);
export const ChClock = () => (
  <Ic>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.6V8l2.4 1.4" />
  </Ic>
);
const ChOk = () => (
  <Ic>
    <path d="M3 8.5l3 3 7-7" />
  </Ic>
);
export const ChNo = () => (
  <Ic>
    <circle cx="8" cy="8" r="6" />
    <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
  </Ic>
);
const ChQueue = () => (
  <Ic>
    <path d="M3 4h10M3 8h10M3 12h6" />
  </Ic>
);
export const ChMsg = () => (
  <Ic>
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
  </Ic>
);
export const ChTrash = () => (
  <Ic>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  </Ic>
);

export const ChEye = () => (
  <Ic>
    <path d="M1.5 8s2.3-4.5 6.5-4.5S14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </Ic>
);
export const ChInfo = () => (
  <Ic>
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 7.2v4M8 4.8v.2" />
  </Ic>
);
export const ChLock = () => (
  <Ic>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
  </Ic>
);

export function DeliveryGlyph({ icon }: { icon: DeliveryIcon }) {
  return icon === "ok" ? <ChOk /> : icon === "queue" ? <ChQueue /> : icon === "clock" ? <ChClock /> : icon === "pause" ? <ChPause /> : <ChNo />;
}
export function TagGlyph({ icon }: { icon: TagIcon }) {
  return icon === "pause" ? <ChPause /> : icon === "clock" ? <ChClock /> : <ChTrash />;
}

/** The warning triangle on a chip that says an author's name is not what it seems (#1051). */
export const ChWarn = () => (
  <svg width={10} height={10} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable={false}>
    <path d="M8 2.2L14.2 13H1.8zM8 6.5v3M8 11.3v.1" />
  </svg>
);

/** A channel's link to an issue, a milestone or a project (#1035). */
export const ChLink = () => (
  <Ic>
    <path d="M6.8 9.2a2.6 2.6 0 003.7 0l2-2a2.6 2.6 0 00-3.7-3.7l-.6.6M9.2 6.8a2.6 2.6 0 00-3.7 0l-2 2a2.6 2.6 0 003.7 3.7l.6-.6" />
  </Ic>
);

/** The agent avatar's glyph (#1231, mockup/podium-chat-redesign.html): a chip. It says "agent" by shape, so the tile is never color alone. */
export const ChChip = () => (
  <svg className="ch-av-chip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    <rect x="10" y="10" width="4" height="4" rx=".6" fill="currentColor" stroke="none" />
  </svg>
);

/** The composer's icons (#1233, mockup/podium-chat-redesign.html): Send, the @ tool and the / tool. Decorative; each button carries its own name. */
const tool = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false } as const;
export const ChSend = () => (
  <svg {...tool} strokeWidth={2.2}>
    <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
  </svg>
);
export const ChAt = () => (
  <svg {...tool} strokeWidth={1.8}>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
  </svg>
);
export const ChSlash = () => (
  <svg {...tool} strokeWidth={2}>
    <path d="M16 4 8 20" />
  </svg>
);
export const ChChev = () => (
  <Ic>
    <path d="M3.5 6l4.5 4.5L12.5 6" />
  </Ic>
);
export const ChPlus = () => (
  <Ic>
    <path d="M8 3v10M3 8h10" />
  </Ic>
);
export const ChSearch = () => (
  <Ic>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </Ic>
);
export const ChX = () => (
  <Ic>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Ic>
);
