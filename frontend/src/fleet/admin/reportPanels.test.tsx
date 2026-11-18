// The panel rule on the Reporting pages (#1136, #724): summary figures share a panel with the chart after them, and a headed table is a panel of its own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeServer } from "./fakeAdmin";

class QuietSource {
  onerror = null;
  readyState = 1;
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", QuietSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** page: the menu button; sections: each section heading's start, as the issue lists them. */
const PAGES: { page: string; sections: string[] }[] = [
  { page: "Usage", sections: ["Usage by "] },
  { page: "Spend", sections: ["Projection", "Spend over time", "Tokens and cache hit rate"] },
  { page: "People and groups", sections: ["People and groups"] },
  { page: "Sessions", sections: ["Sessions by ", "Length and waiting by ", "Agents launched", "Context fullness at the end"] },
  { page: "Tools", sections: ["Cost per tool call and per session", "Tool failures", "Permission prompts", "Harness versions"] },
  { page: "Failures", sections: ["Failures by "] },
];

function section(start: string): HTMLElement | null {
  const h = screen.queryAllByRole("heading", { level: 2 }).find((x) => (x.textContent ?? "").startsWith(start));
  return (h?.closest("section") as HTMLElement | null) ?? null;
}

describe.each(PAGES)("the $page page", ({ page, sections }) => {
  it.each(sections)("keeps the summary figures out of the panel of the headed table in %s", async (start) => {
    fakeServer({ unlocked: true });
    render(<AdminView />);
    fireEvent.click(await screen.findByRole("button", { name: page }));
    await waitFor(() => expect(section(start)).not.toBeNull());
    await waitFor(() => {
      const panels = [...section(start)!.querySelectorAll(".panel")];
      expect(panels.some((p) => p.querySelector("table"))).toBe(true);
    });
    const panels = [...section(start)!.querySelectorAll(".panel")];
    for (const p of panels) {
      const figures = p.querySelector(".sum") !== null || p.querySelector(".chart") !== null;
      expect(figures && p.querySelector("table") !== null).toBe(false);
    }
    // the figures come first, then the table: each is in a panel of its own under the same heading
    const withTable = panels.findIndex((p) => p.querySelector("table"));
    expect(withTable).toBeGreaterThan(0);
  });
});
