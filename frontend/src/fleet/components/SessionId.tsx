import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { IconCheck, IconCopy } from "./Icons";

/** How long "Copied" stays on a copy control. */
export const COPIED_MS = 1600;

/** The characters of a session id shown on the card and the orchestrator page; the click copies all of it. */
export const SHORT_ID = 8;

/** Copies `text` inside a click handler. `state` is "copied" or "failed" for 1.6 s after a try, then "idle". */
export function useCopy(text: string) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const settle = (next: "copied" | "failed") => {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };
  const copy = () => {
    if (!navigator.clipboard) return settle("failed");
    try {
      navigator.clipboard.writeText(text).then(() => settle("copied")).catch(() => settle("failed"));
    } catch {
      settle("failed");
    }
  };
  return { state, copy };
}

/**
 * The session id, shortened, copied whole on a click (#322). On a card it sits inside the card's own button, so it is a `role="button"` span that
 * keeps its click and Enter/Space from opening the card. On the orchestrator page the id is a cell of the facts grid instead (#352).
 */
export function SessionId({ id, nested }: { id: string; nested?: boolean }) {
  const { state, copy } = useCopy(id);
  const short = id.slice(0, SHORT_ID);
  const label = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : short;
  const props = {
    className: "sid",
    title: `Copy session id ${id}`,
    "aria-label": `Copy session id ${short}`,
  };
  const body = (
    <>
      <span aria-live="polite">{label}</span>
      {state === "copied" ? <IconCheck /> : <IconCopy />}
    </>
  );
  if (!nested) {
    return (
      <button type="button" {...props} onClick={copy}>
        {body}
      </button>
    );
  }
  const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();
  return (
    <span
      role="button"
      tabIndex={0}
      {...props}
      onClick={(e) => {
        stop(e);
        copy();
      }}
      onKeyDown={(e) => {
        stop(e);
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          copy();
        }
      }}
    >
      {body}
    </span>
  );
}
