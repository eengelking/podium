// The single-key shortcuts (\ [ ] w) are off until a person turns them on (#636, WCAG 2.1.4). The choice is kept per
// browser in localStorage, the way the theme and the refresh interval are, as a plain true or false.
import { useCallback, useState } from "react";
import { readJson, writeJson } from "./storage";

export const SHORTCUTS_KEY = "podium.shortcuts";

/** True only for a stored `true`: no value, or anything else, leaves the keys off. */
export function readShortcuts(): boolean {
  return readJson<unknown>(SHORTCUTS_KEY, false) === true;
}

export function useShortcuts(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readShortcuts);
  const set = useCallback((next: boolean) => {
    setOn(next);
    writeJson(SHORTCUTS_KEY, next);
  }, []);
  return [on, set];
}
