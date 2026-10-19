// Which of the left pane, right pane and top bar are collapsed, and wall mode. The flags are kept in
// localStorage apart from the saved widths (useResizable), so expanding a pane returns it to its width.
// Wall mode collapses all three without touching the saved flags, so leaving it restores them, and a
// reload comes back out of it.
import { useCallback, useState } from "react";
import { readJson, writeJson } from "./storage";

export type Pane = "left" | "right" | "top";
export type Collapsed = Record<Pane, boolean>;
/** The console page the flags belong to: each keeps its own. */
export type PanesPage = "fleet" | "board" | "reporters";
const ALL: Collapsed = { left: true, right: true, top: true };
const FLEET_OPEN: Collapsed = { left: false, right: false, top: false };
/** The board (#346) and My reporters (#446) open with both side panels collapsed, so the page gets the width. */
const SIDES_SHUT: Collapsed = { left: true, right: true, top: false };
const PAGES: Record<PanesPage, { key: string; fallback: Collapsed }> = {
  fleet: { key: "podium.collapsed", fallback: FLEET_OPEN },
  board: { key: "podium.collapsed.board", fallback: SIDES_SHUT },
  reporters: { key: "podium.collapsed.reporters", fallback: SIDES_SHUT },
};

function load(page: PanesPage): Collapsed {
  const { key, fallback } = PAGES[page];
  const v = readJson<Partial<Record<Pane, unknown>> | null>(key, null);
  const flag = (p: Pane) => (typeof v?.[p] === "boolean" ? (v[p] as boolean) : fallback[p]);
  return { left: flag("left"), right: flag("right"), top: flag("top") };
}

export interface Panes {
  /** What is collapsed right now: wall mode collapses everything. */
  collapsed: Collapsed;
  wall: boolean;
  toggle: (pane: Pane) => void;
  enterWall: () => void;
  exitWall: () => void;
}

export function usePanes(page: PanesPage = "fleet"): Panes {
  const [savedBy, setSavedBy] = useState<Record<PanesPage, Collapsed>>(() => ({ fleet: load("fleet"), board: load("board"), reporters: load("reporters") }));
  const saved = savedBy[page];
  const [wall, setWall] = useState(false);

  const save = useCallback(
    (next: Collapsed) => {
      setSavedBy((cur) => ({ ...cur, [page]: next }));
      writeJson(PAGES[page].key, next);
    },
    [page],
  );

  const toggle = useCallback(
    (pane: Pane) => {
      if (wall) {
        // Opening a pane from its edge tab ends wall mode and restores the saved flags, with that pane open.
        setWall(false);
        save({ ...saved, [pane]: false });
        return;
      }
      save({ ...saved, [pane]: !saved[pane] });
    },
    [wall, saved, save],
  );

  const enterWall = useCallback(() => setWall(true), []);
  const exitWall = useCallback(() => setWall(false), []);

  return { collapsed: wall ? ALL : saved, wall, toggle, enterWall, exitWall };
}
