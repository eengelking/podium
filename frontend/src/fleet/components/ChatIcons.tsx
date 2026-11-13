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
export const ChOk = () => (
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
export const ChQueue = () => (
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
