// Admin > Reporting > Tools (#720): the page, its three tables, the harness filter and its export.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeServer } from "./fakeAdmin";
import { toolEntries } from "./ToolsPage";

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

async function openTools(server = fakeServer({ unlocked: true })) {
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("button", { name: "Tools" }));
  await screen.findByRole("table", { name: "Calls by tool" });
  return server;
}

describe("the Tools page", () => {
  it("sits in the Reporting group after Sessions and asks for the same period three ways", async () => {
    const s = await openTools();
    expect(screen.getByRole("heading", { level: 1, name: "Tools" })).toBeInTheDocument();
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names.indexOf("Tools")).toBe(names.indexOf("Sessions") + 1);
    const asked = s.calls.filter((c) => c.startsWith("GET /reports/tools?"));
    expect(asked).toEqual([
      "GET /reports/tools?from=2026-09-21&to=2026-10-20&by=day",
      "GET /reports/tools?from=2026-09-21&to=2026-10-20&by=day&breakdown=session",
      "GET /reports/tools?from=2026-09-21&to=2026-10-20&by=day&breakdown=version",
    ]);
  });

  it("draws calls by tool with a column for each harness, and an MCP server that opens to its tools", async () => {
    await openTools();
    const table = screen.getByRole("table", { name: "Calls by tool" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Tool", "Claude Code", "OpenCode", "Calls", "Share"]);
    expect(within(table).getByText("Bash").closest("tr")).toHaveTextContent("4,3101,5945,904");
    const server = within(table).getByRole("button", { name: /github/ });
    expect(server).toHaveAttribute("aria-expanded", "false");
    expect(within(table).queryByText("search_code")).toBeNull();
    fireEvent.click(server);
    expect(server).toHaveAttribute("aria-expanded", "true");
    expect(within(table).getByText("search_code").closest("tr")).toHaveTextContent("9002201,120");
    expect(within(table).getByText("get_file")).toBeInTheDocument();
    expect(within(table).getByText("Total").closest("tr")).toHaveTextContent("11,026");
  });

  it("draws the calls per session and the versions, each harness against its own newest", async () => {
    await openTools();
    const per = await screen.findByRole("table", { name: "Calls per session" });
    expect(within(per).getByText("Whole period, all harnesses").closest("tr")).toHaveTextContent("20");
    expect(within(per).getByText("Claude Code").closest("tr")).toHaveTextContent("1458214");
    expect(screen.getByText("median calls per session").previousElementSibling).toHaveTextContent("55");
    const vers = await screen.findByRole("table", { name: "Reporters by harness version and period" });
    expect(within(vers).getByText("Claude Code 2.1.319").closest("tr")).toHaveTextContent("Newest seen");
    expect(within(vers).getByText("Claude Code 2.1.305").closest("tr")).toHaveTextContent("Older");
    expect(within(vers).getByText("OpenCode 1.4.2").closest("tr")).toHaveTextContent("Newest seen");
    expect(screen.getByText("Claude Code reporters older than 2.1.319").previousElementSibling).toHaveTextContent("2 of 6");
    expect(screen.getByText("OpenCode reporters older than 1.4.2").previousElementSibling).toHaveTextContent("0 of 2");
  });

  it("narrows to one harness in all three answers, and remembers the choice", async () => {
    const s = await openTools();
    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "opencode" } });
    await waitFor(() => expect(s.calls.filter((c) => c.includes("harness=opencode"))).toHaveLength(3));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Calls by tool" })).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Tool", "OpenCode", "Calls", "Share"]));
    expect(screen.getByRole("table", { name: "Calls per session" })).toBeInTheDocument();
    expect(localStorage.getItem("podium.adminReporting")).toContain('"harness":"opencode"');
  });

  it("downloads the calls by tool as it is shown, with the harness in each row", async () => {
    const s = await openTools();
    fireEvent.click(screen.getByRole("button", { name: "Download calls by tool CSV" }));
    await waitFor(() => expect(s.calls.some((c) => c.includes("/reports/tools?") && c.includes("format=csv"))).toBe(true));
    expect(s.calls.find((c) => c.includes("format=csv"))).not.toContain("breakdown=");
  });
});

describe("toolEntries", () => {
  it("adds the whole period up, orders by calls and puts an MCP server's tools under it", () => {
    const rows = [
      { period: "a", harness: "claude-code", server: "", tool: "Read", calls: 3 },
      { period: "b", harness: "claude-code", server: "", tool: "Read", calls: 4 },
      { period: "a", harness: "opencode", server: "gh", tool: "x", calls: 2 },
      { period: "a", harness: "claude-code", server: "gh", tool: "y", calls: 9 },
    ];
    const list = toolEntries(rows);
    expect(list.map((e) => [e.name, e.total])).toEqual([["gh", 11], ["Read", 7]]);
    expect(list[0]!.tools.map((t) => [t.name, t.total])).toEqual([["y", 9], ["x", 2]]);
    expect(list[1]!.perHarness.get("claude-code")).toBe(7);
  });
});
