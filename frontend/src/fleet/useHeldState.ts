import { useEffect, useRef, useState } from "react";
import { usePageVisible } from "./usePageVisible";

/**
 * Returns `value` as it stood at the last tick of `everyMs`, so the page below redraws once per interval instead of
 * on every change. A change for which `urgent(held, next)` is true shows at once. Changing `everyMs` shows the newest
 * value straight away and restarts the clock. While the tab is hidden nothing is shown, urgent or not, and the clock
 * stops (#751); the newest value shows as soon as the tab is shown again.
 */
export function useHeldState<T>(value: T, everyMs: number, urgent: (held: T, next: T) => boolean): T {
  const [held, setHeld] = useState(value);
  const visible = usePageVisible();
  const latest = useRef(value);
  latest.current = value;

  const shown = visible && held !== value && urgent(held, value) ? value : held;

  useEffect(() => {
    if (shown !== held) setHeld(shown);
  }, [shown, held]);

  useEffect(() => {
    if (!visible) return;
    setHeld(latest.current);
    const t = setInterval(() => setHeld(latest.current), everyMs);
    return () => clearInterval(t);
  }, [everyMs, visible]);

  return shown;
}
