// Admin > Reporting > Harness updates (#724): what stopped after a harness update, and the reporters behind the newest version.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeServer } from "./fakeAdmin";
import { behindWeeks } from "./HarnessPage";

class QuietSource {
  onerror = null;
  readyState = 1;
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", QuietSource);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 20, 12));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openHarness() {
  const server = fakeServer({ unlocked: true });
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("button", { name: "Harness updates" }));
  await screen.findByRole("table", { name: "Features that stopped after a harness update" });
  return server;
}

describe("the Harness updates page", () => {
  it("sits in the Reporting group after Tools and asks for what stopped, then for the reporters behind", async () => {
    const s = await openHarness();
    expect(screen.getByRole("heading", { level: 1, name: "Harness updates" })).toBeInTheDocument();
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names.indexOf("Harness updates")).toBe(names.indexOf("Tools") + 1);
    await screen.findByRole("table", { name: "Reporters behind the newest version, by period" });
    expect(s.calls.filter((c) => c.startsWith("GET /reports/harness?")).slice(0, 2)).toEqual([
      "GET /reports/harness?from=2026-09-21&to=2026-10-20&by=day",
      "GET /reports/harness?from=2026-09-21&to=2026-10-20&by=day&breakdown=behind",
    ]);
  });

  it("lists each feature with its kind, what it affects and the shares, drawn as text", async () => {
    await openHarness();
    const table = screen.getByRole("table", { name: "Features that stopped after a harness update" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[1]!.textContent).toContain("Claude Code 2.1.319");
    expect(rows[1]!.textContent).toContain("tool_response.duration_ms (field)");
    expect(rows[1]!.textContent).toContain("Call duration on Tools shows a dash.");
    expect(rows[1]!.textContent).toContain("98%");
    expect(rows[3]!.textContent).toContain("webfetch (tool name)");
    expect(screen.getByText("features stopped")).toBeInTheDocument();
    expect(screen.getByText("versions affected")).toBeInTheDocument();
    expect(screen.getByText("reporters affected")).toBeInTheDocument();
  });

  it("explains each figure in a tip that opens on hover and on focus", async () => {
    await openHarness();
    const trigger = screen.getByText("reporters affected").closest(".tip") as HTMLElement;
    const box = within(trigger).getByRole("tooltip", { hidden: true });
    expect(box).toHaveAttribute("hidden");
    fireEvent.focus(trigger);
    expect(box).not.toHaveAttribute("hidden");
    expect(box.textContent).toContain("Reporters that run one of the affected versions");
  });

  it("keeps summary and chart in one panel and the table in its own, as the panel rule says", async () => {
    await openHarness();
    const stopped = screen.getByRole("heading", { name: "Features that stopped" }).closest("section")!;
    const own = stopped.querySelectorAll(".panel");
    expect(own).toHaveLength(2);
    expect(own[0]!.querySelector(".sum")).not.toBeNull();
    expect(own[0]!.querySelector("table")).toBeNull();
    expect(own[1]!.querySelector("table")).not.toBeNull();
    await screen.findByRole("table", { name: "Reporters behind the newest version, by period" });
    const behindSection = screen.getByRole("heading", { name: "Reporters behind the newest version" }).closest("section")!;
    const panels = behindSection.querySelectorAll(".panel");
    expect(panels).toHaveLength(2);
    expect(panels[0]!.querySelector(".chart")).not.toBeNull();
    expect(panels[0]!.querySelector("table")).toBeNull();
    expect(panels[1]!.querySelector("table")).not.toBeNull();
  });

  it("narrows to one harness with the Harness filter", async () => {
    const s = await openHarness();
    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "opencode" } });
    await waitFor(() => expect(s.calls.some((c) => c.includes("/reports/harness?") && c.includes("harness=opencode"))).toBe(true));
    const table = await screen.findByRole("table", { name: "Features that stopped after a harness update" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
    expect(within(table).getByText(/OpenCode 1\.4\.2/)).toBeInTheDocument();
  });

  it("sends the same query the CSV downloads", async () => {
    const s = await openHarness();
    expect(screen.getByRole("button", { name: "Download features that stopped CSV" })).toBeEnabled();
    expect(s.calls.some((c) => c.startsWith("GET /reports/harness?"))).toBe(true);
  });
});

describe("behindWeeks", () => {
  it("adds the harnesses of a period together, oldest period first", () => {
    const rows = [
      { period: "2026-10-19", harness: "opencode", reporters: 2, onNewest: 2, behind: 0 },
      { period: "2026-10-12", harness: "claude-code", reporters: 10, onNewest: 5, behind: 5 },
      { period: "2026-10-19", harness: "claude-code", reporters: 6, onNewest: 4, behind: 2 },
    ];
    expect(behindWeeks(rows)).toEqual([
      { period: "2026-10-12", reporters: 10, onNewest: 5, behind: 5 },
      { period: "2026-10-19", reporters: 8, onNewest: 6, behind: 2 },
    ]);
  });
});
