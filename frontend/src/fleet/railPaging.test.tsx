import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, within, fireEvent, cleanup, act } from "@testing-library/react";
import { Rail } from "./components/Rail";
import { makeSession } from "./fixtures";
import { buildUnits } from "./people";
import type { SessionView } from "./types";

// jsdom has no layout, so every measure the rail reads is faked here: a 600px panel, with the head, the "All
// orchestrators" row and the footer taking 38 + 50 + 46, the pager 40, a row 50 and a band header 30.
const SIZE: Record<string, number> = { rail: 600, "rail-head": 38, all: 50, "rail-foot": 46, pager: 40, "ritem-slot": 50, rgh: 30 };
const measure = (el: HTMLElement) => {
  // a row with a Remove button is taller than the rest
  if (el.classList.contains("has-remove")) return 70;
  for (const c of el.classList) if (c in SIZE) return SIZE[c]!;
  return 0;
};
let height = 600;
beforeEach(() => {
  height = 600;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rail") ? height : measure(this);
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return measure(this);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Room for rows: 600 - (38 + 50 + 46) - 40 (the pager) = 426, so 8 rows a page.
const fleet = (n: number, over: (i: number) => Partial<SessionView> = () => ({})) => Array.from({ length: n }, (_, i) => makeSession({ id: `s${i + 1}`, name: `proj-${i + 1}`, ...over(i) }));
const split = { running: 1, waiting: 0, stale: 0 };
const view = (sessions: SessionView[], selected: string | null = null, extra: Partial<Parameters<typeof Rail>[0]> = {}) => (
  <Rail sessions={sessions} selected={selected} onSelect={() => {}} split={split} entering={() => false} leaving={{}} liveCount={sessions.length} {...extra} />
);
const names = () => [...document.querySelectorAll(".ritem-slot .nm")].map((e) => e.textContent);
const pager = () => screen.queryByRole("navigation", { name: "Orchestrators pages" });

describe("rail paging (#242)", () => {
  it("shows every row and no pager when the list fits", () => {
    render(view(fleet(7)));
    expect(names()).toHaveLength(7);
    expect(pager()).toBeNull();
  });

  it("pages a list that would need a scrollbar, by what the panel's height holds", () => {
    render(view(fleet(24)));
    expect(names()).toEqual(Array.from({ length: 8 }, (_, i) => `proj-${i + 1}`));
    expect(screen.getByText("Showing 1–8 of 24")).toBeInTheDocument();
    expect(within(pager()!).getByText("1 of 3")).toBeInTheDocument();
    expect(within(pager()!).getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(within(pager()!).getByRole("button", { name: "Next page" }));
    expect(names()[0]).toBe("proj-9");
    expect(screen.getByText("Showing 9–16 of 24")).toBeInTheDocument();
  });

  it("holds more rows a page in a taller panel and fewer in a shorter one", () => {
    height = 900;
    const { unmount } = render(view(fleet(24)));
    expect(names()).toHaveLength(14);
    unmount();
    height = 400;
    render(view(fleet(24)));
    expect(names()).toHaveLength(4);
  });

  it("sizes a page by the tallest row, so a row with a Remove button does not overflow it", () => {
    const sessions = fleet(24, (i) => (i === 2 ?{ status: "stale" as const } : {}));
    render(view(sessions, null, { onRemove: () => {} }));
    // 404 / 70 = 5 rows, not the 8 a 50px row would give
    expect(names()).toHaveLength(5);
  });

  it("pins the pager directly above the footer, with the All row still on top", () => {
    render(view(fleet(24)));
    expect(pager()!.closest(".rail-pager")!.nextElementSibling?.nextElementSibling).toHaveClass("rail-foot");
    expect(screen.getByRole("button", { name: /All orchestrators/ })).toBeInTheDocument();
  });

  it("announces a page change", () => {
    render(view(fleet(24)));
    expect(screen.getByRole("status")).toHaveTextContent("");
    fireEvent.click(within(pager()!).getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("status")).toHaveTextContent("Page 2 of 3, showing 9 to 16 of 24 orchestrators");
  });

  it("keeps a selection on another page selected and says which page holds it", () => {
    render(view(fleet(24), "s20"));
    expect(screen.queryByRole("button", { current: true, name: /proj-20/ })).toBeNull();
    expect(screen.getByRole("button", { name: /All orchestrators/ })).toHaveAttribute("aria-current", "false");
    const jump = screen.getByRole("button", { name: "page 3" });
    expect(screen.getByText(/proj-20 is on/)).toBeInTheDocument();
    fireEvent.click(jump);
    expect(screen.getByRole("button", { name: /proj-20/ })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByText(/proj-20 is on/)).toBeNull();
  });

  it("stays on the page when the list changes, and falls back to the last page when it no longer exists", () => {
    const { rerender } = render(view(fleet(24)));
    const next = () => fireEvent.click(within(pager()!).getByRole("button", { name: "Next page" }));
    next();
    next();
    expect(names()[0]).toBe("proj-17");
    rerender(view(fleet(23)));
    expect(names()[0]).toBe("proj-17");
    rerender(view(fleet(10)));
    expect(within(pager()!).getByText("2 of 2")).toBeInTheDocument();
    expect(names()).toEqual(["proj-9", "proj-10"]);
    // growing again stays where the reader was, not back on the page that was dropped
    rerender(view(fleet(24)));
    expect(within(pager()!).getByText("2 of 3")).toBeInTheDocument();
    rerender(view(fleet(10)));
    rerender(view(fleet(5)));
    expect(pager()).toBeNull();
    expect(names()).toHaveLength(5);
  });

  it("lists the sessions that arrive after the list was empty (#420)", () => {
    const { rerender } = render(view([]));
    expect(names()).toEqual([]);
    rerender(view(fleet(2)));
    expect(names()).toEqual(["proj-1", "proj-2"]);
  });

  it("lists the sessions again after the list empties, even from a later page (#420)", () => {
    const { rerender } = render(view(fleet(24)));
    fireEvent.click(within(pager()!).getByRole("button", { name: "Next page" }));
    expect(names()[0]).toBe("proj-9");
    rerender(view([]));
    expect(names()).toEqual([]);
    expect(pager()).toBeNull();
    rerender(view(fleet(3)));
    expect(names()).toEqual(["proj-1", "proj-2", "proj-3"]);
    expect(pager()).toBeNull();
  });

  it("lists the sessions of a banded people view that arrive after it was empty (#420)", () => {
    const people = (sessions: SessionView[]) => ({ groupBy: "people" as const, units: buildUnits(sessions, "people", [], null), picked: null, onPick: () => {}, visible: new Set(sessions.map((s) => s.id)) });
    const some = fleet(2, () => ({ owner: "Ed E." }));
    const { rerender } = render(view([], null, { people: people([]) }));
    expect(document.querySelectorAll(".rgh")).toHaveLength(0);
    rerender(view(some, null, { people: people(some) }));
    expect(names()).toEqual(["proj-1", "proj-2"]);
    expect(document.querySelectorAll(".rgh")).toHaveLength(1);
  });

  it("never holds a page outside the list, whatever the list does (#420)", () => {
    const { rerender } = render(view([]));
    for (const n of [0, 5, 0, 24, 1, 0, 9, 0, 0, 3]) {
      rerender(view(fleet(n)));
      expect(names().length).toBe(n > 9 ? 8 : n);
      expect(screen.queryByText(/Showing 0/)).toBeNull();
    }
  });

  it("repeats a band's header on the page that continues it, and counts the whole band", () => {
    const sessions = fleet(12, (i) => ({ owner: i < 10 ? "Ed E." : "Priya N." }));
    const units = buildUnits(sessions, "people", [], null);
    const people = { groupBy: "people" as const, units, picked: null, onPick: () => {}, visible: new Set(sessions.map((s) => s.id)) };
    render(view(sessions, null, { people }));
    const heads = () => [...document.querySelectorAll(".rgh")].map((h) => h.textContent);
    // 426 - 3 headers' worth: the first page holds Ed's header and 7 rows
    expect(heads()).toHaveLength(1);
    expect(heads()[0]).toContain("Ed E.");
    expect(heads()[0]).toContain("10");
    expect(heads()[0]).not.toContain("continued");
    fireEvent.click(within(pager()!).getByRole("button", { name: "Next page" }));
    expect(heads()[0]).toContain("Ed E.");
    expect(heads()[0]).toContain("continued");
    expect(heads()[0]).toContain("10");
  });
});

describe("rail paging when the panes are stacked (#474)", () => {
  // Below 1040 px the page scrolls as a whole and the rail's height follows its rows, so the room it measures is only what the rows
  // already take. Faked here as the same 600px panel, with the stacked query matching or not.
  let stacked = true;
  const listeners = new Set<() => void>();
  beforeEach(() => {
    stacked = true;
    listeners.clear();
    vi.stubGlobal("matchMedia", (q: string) => ({
      get matches() {
        return q === "(max-width: 1040px)" && stacked;
      },
      media: q,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());
  const cross = (to: boolean) =>
    act(() => {
      stacked = to;
      listeners.forEach((fn) => fn());
    });

  it("lists every row and no pager, however many there are", () => {
    render(view(fleet(24)));
    expect(names()).toHaveLength(24);
    expect(pager()).toBeNull();
  });

  it("does not shrink to one row a page when the rail's height follows its content", () => {
    // the height a stacked rail reports is what its rows take, which is never more than a page's worth
    height = 134 + 50;
    render(view(fleet(5)));
    expect(names()).toHaveLength(5);
    expect(pager()).toBeNull();
  });

  it("pages again when the window widens, on the page that holds the selection", () => {
    render(view(fleet(24), "s20"));
    expect(names()).toHaveLength(24);
    cross(false);
    expect(pager()).not.toBeNull();
    expect(names()).toContain("proj-20");
  });

  it("stops paging when the window narrows", () => {
    stacked = false;
    render(view(fleet(24)));
    expect(names()).toHaveLength(8);
    cross(true);
    expect(names()).toHaveLength(24);
    expect(pager()).toBeNull();
  });
});
