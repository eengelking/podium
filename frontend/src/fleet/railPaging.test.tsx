import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, within, fireEvent, cleanup } from "@testing-library/react";
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
