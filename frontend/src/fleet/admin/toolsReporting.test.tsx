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
  it("sits in the Reporting group after Sessions and asks for the same period three ways first", async () => {
    const s = await openTools();
    expect(screen.getByRole("heading", { level: 1, name: "Tools" })).toBeInTheDocument();
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names.indexOf("Tools")).toBe(names.indexOf("Sessions") + 1);
    await screen.findByRole("table", { name: "Call duration by tool" });
    expect(s.calls.filter((c) => c.startsWith("GET /reports/tools?")).slice(0, 3)).toEqual([
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
    await waitFor(() => expect(s.calls.filter((c) => c.includes("harness=opencode"))).toHaveLength(8));
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

describe("the Tools page: failures, permission prompts and call duration (#721)", () => {
  it("asks for the same period three more ways", async () => {
    const s = await openTools();
    await screen.findByRole("table", { name: "Failures by tool" });
    const asked = s.calls.filter((c) => c.startsWith("GET /reports/tools?"));
    expect(asked.slice(3)).toEqual([
      "GET /reports/tools?from=2026-09-21&to=2026-10-20&by=day&breakdown=failures",
      "GET /reports/tools?from=2026-09-21&to=2026-10-20&by=day&breakdown=prompts",
      "GET /reports/tools?from=2026-09-21&to=2026-10-20&by=day&breakdown=duration",
    ]);
  });

  it("shows the failures of each tool beside its calls, most failures first, with the figures that sum them up", async () => {
    await openTools();
    const table = await screen.findByRole("table", { name: "Failures by tool" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Tool", "Calls", "Failures", "Failure rate", "History"]);
    const bodyRows = within(table).getAllByRole("row").slice(1, -1);
    expect(bodyRows.map((r) => within(r).getAllByRole("cell")[0]!.textContent)).toEqual(["Bash", expect.stringContaining("github"), "Read"]);
    expect(within(table).getByText("Bash").closest("tr")).toHaveTextContent("5,9042143.6%");
    expect(within(table).getByText("Total").closest("tr")).toHaveTextContent("10,8062592.4%");
    expect(screen.getByText("failed calls").previousElementSibling).toHaveTextContent("259");
    expect(screen.getByText("of 10,806 calls").previousElementSibling).toHaveTextContent("2.4%");
    expect(screen.getByText(/the most failures: 214 of 5,904/).previousElementSibling).toHaveTextContent("3.6%");
    const bars = screen.getByRole("list", { name: "Failed calls by tool, most first" });
    expect(within(bars).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Bash2143.6%", expect.stringContaining("github"), "Read220.6%"]);
  });

  it("links a tool to the sessions that are still stored, and says what it cannot link", async () => {
    await openTools();
    const table = await screen.findByRole("table", { name: "Failures by tool" });
    const bash = within(table).getByText("Bash").closest("tr")!;
    const links = within(bash).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["#/history?day=2026-10-19&page=1&size=50&open=s1", "#/history?day=2026-10-19&page=1&size=50&open=s2"]);
    expect(within(table).getByText("Read").closest("tr")).toHaveTextContent("Counts only");
    expect(within(table).queryByRole("link", { name: /s3/ })).toBeNull();
    fireEvent.click(within(table).getByRole("button", { name: /github/ }));
    expect(within(table).getByText("search_code").closest("tr")).toHaveTextContent("Open");
    expect(within(table).getByText("get_file").closest("tr")).toHaveTextContent("None in History");
  });

  it("adds a tool's asks up over the harnesses, and shows how they ended", async () => {
    await openTools();
    const table = await screen.findByRole("table", { name: "Permission prompts by tool" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Tool", "Asked", "Of its calls", "Allowed", "Denied", "No answer", "Answered in Podium"]);
    expect(within(table).getByText("Bash").closest("tr")).toHaveTextContent("64010.8%5487121139");
    expect(within(table).getByText("Total").closest("tr")).toHaveTextContent("6926.4%5977322148");
    expect(screen.getByText("answered in Podium").previousElementSibling).toHaveTextContent("148");
  });

  it("shows the median and the 95th percentile of each tool, and says which harness gave the times", async () => {
    await openTools();
    const table = await screen.findByRole("table", { name: "Call duration by tool" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Tool", "Calls timed", "Median", "95th percentile"]);
    expect(within(table).getByText("Bash").closest("tr")).toHaveTextContent("4,3101.8 s41 s");
    expect(within(table).getByText("Read").closest("tr")).toHaveTextContent("3,60240 ms310 ms");
    expect(within(table).getByText("MCP server").closest("tr")).toHaveTextContent("1,300900 ms4.2 s");
    expect(within(table).getByText("All timed calls").closest("tr")).toHaveTextContent("9,21280 ms9.4 s");
    expect(screen.getByText(/Claude Code only/)).toBeInTheDocument();
  });

  it("asks all three again for one harness, and says so when that harness gave no times", async () => {
    const s = await openTools();
    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "opencode" } });
    await waitFor(() => expect(s.calls.filter((c) => c.includes("harness=opencode"))).toHaveLength(8));
    expect(await screen.findByText(/OpenCode reported no call times in this period/)).toBeInTheDocument();
  });
});
