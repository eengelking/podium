import { forwardRef, useEffect, useRef, useState } from "react";
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
  const write = async () => {
    if (!navigator.clipboard) return settle("failed");
    try {
      await navigator.clipboard.writeText(text);
      settle("copied");
    } catch {
      settle("failed");
    }
  };
  // `write` settles every outcome itself, so the click handlers need not wait on it.
  const copy = () => {
    void write();
  };
  return { state, copy };
}

/**
 * The session id, shortened, copied whole on a click (#322). A real button: on a card it is a sibling of the card's own button (placed over the
 * path row's `.sidslot`), never a child of it (#759). While it reads "Copied" or "Copy failed" it has no `aria-label`, so its name is that text.
 */
export const SessionId = forwardRef<HTMLButtonElement, { id: string }>(function SessionId({ id }, ref) {
  const { state, copy } = useCopy(id);
  const short = id.slice(0, SHORT_ID);
  const label = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : short;
  return (
    <button ref={ref} type="button" className="sid" title={`Copy session id ${id}`} aria-label={state === "idle" ? `Copy session id ${short}` : undefined} onClick={copy}>
      <span aria-live="polite">{label}</span>
      {state === "copied" ? <IconCheck /> : <IconCopy />}
    </button>
  );
});
