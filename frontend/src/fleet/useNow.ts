import { useEffect, useMemo, useState } from "react";
import { usePageVisible } from "./usePageVisible";

/**
 * The current time, updated every `ms` so elapsed times move between server messages. It stops while the tab is
 * hidden (#751) and shows the current time as soon as the tab is shown again.
 */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  const visible = usePageVisible();
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, visible]);
  return now;
}

/**
 * `now`, held while the local date stays the same. For a page that prints a time only as a time of day or as the name of a day
 * (Chat, #1311): the clock's tick leaves it alone, so the page is not drawn again, and it moves when the day does.
 */
export function useDayNow(now: number): number {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the date is the only part of `now` that matters here
  return useMemo(() => now, [new Date(now).toDateString()]);
}
