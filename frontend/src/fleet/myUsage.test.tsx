// My usage (#726, mockup/podium-my-usage.html): the page's states, the requests it makes (only a period, a grouping, a breakdown and a harness, never a person, a
// group or an id), the client's address, and the top bar button that opens it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MyUsagePage, myUsageClient } from "./MyUsage";
import { TopBar } from "./components/TopBar";
import { RespondProvider } from "./useRespond";
import type { RespondApi } from "./respondApi";
import type { ReportReply, ReportsClient } from "./admin/reportsApi";
import type { RespondMe } from "./types";
import { routeFor } from "../route";

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 20, 12));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ME: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false, myUsage: true };
const OUT: RespondMe = { enabled: true, signedIn: false, name: null, admin: false, myUsage: true };

const reply = (report: string, over: Partial<ReportReply>): ReportReply => ({ report, from: "2026-09-21", to: "2026-10-20", by: "day", tz: "Europe/Berlin", basedOn: "rollups and live", oldestDay: "2026-03-02", partial: false, columns: [], rows: [], total: {}, ...over });

const SPEND = reply("spend", {
  columns: [
    { key: "period", label: "Period", unit: "date" },
    { key: "key", label: "Model", unit: "text" },
    { key: "sessions", label: "Sessions", unit: "count" },
    { key: "costUsd", label: "Cost (USD)", unit: "usd" },
  ],
  rows: [{ period: "2026-10-05", key: "Opus 5.5", sessions: 31, costUsd: 71.2 }],
  total: { sessions: 31, costUsd: 71.2 },
});
const PROJECT = reply("spend", {
  columns: [
    { key: "period", label: "Period", unit: "date" },
    { key: "key", label: "Project", unit: "text" },
    { key: "sessions", label: "Sessions", unit: "count" },
  ],
  rows: [{ period: "2026-10-05", key: "podium", sessions: 52 }],
});
const SESSIONS = reply("sessions", {
  basedOn: "your stored sessions",
  oldestDay: "2026-09-19",
  partial: true,
  from: "2026-09-01",
  columns: [
    { key: "period", label: "Period", unit: "date" },
    { key: "key", label: "Outcome", unit: "text" },
    { key: "sessions", label: "Sessions", unit: "count" },
  ],
  rows: [{ period: "2026-10-05", key: "completed", sessions: 81 }],
});
const FAILURES = reply("failures", {
  columns: [
    { key: "period", label: "Period", unit: "date" },
    { key: "key", label: "Failure class", unit: "text" },
    { key: "count", label: "Failures", unit: "count" },
  ],
  rows: [{ period: "2026-10-05", key: "permission", count: 3 }],
});
const TOOLS = reply("tools", {
  harnesses: ["claude-code", "opencode"],
  columns: [
    { key: "period", label: "Period", unit: "date" },
    { key: "harness", label: "Harness", unit: "text" },
    { key: "tool", label: "Tool", unit: "text" },
    { key: "calls", label: "Calls", unit: "count" },
  ],
  rows: [{ period: "2026-10-05", harness: "claude-code", server: "", tool: "Bash", calls: 12 }],
  total: { calls: 12 },
});

/** A client that records every path it is asked for and answers by report. */
function fake(over: Partial<Record<string, ReportReply>> = {}) {
  const calls: string[] = [];
  const by: Record<string, ReportReply> = { spend: SPEND, sessions: SESSIONS, failures: FAILURES, tools: TOOLS, ...over };
  const client: ReportsClient = {
    get: async <T,>(path: string) => {
      calls.push(path);
      const name = path.replace(/^\/reports\//, "").split("?")[0]!;
      const project = path.includes("breakdown=project");
      return (project ? PROJECT : by[name]!) as unknown as T;
    },
    text: async (path) => {
      calls.push(`text ${path}`);
      return "csv";
    },
  };
  return { client, calls };
}

describe("the page's states", () => {
  it("says the page is not found while the Admin's setting is off", () => {
    render(<MyUsagePage me={ME} on={false} client={fake().client} />);
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says the page is not found when the server says sign-in is off", () => {
    render(<MyUsagePage me={{ ...ME, enabled: false }} on client={fake().client} />);
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });

  it("asks a signed-out person to sign in and shows no figure and makes no request", () => {
    const f = fake();
    render(<MyUsagePage me={OUT} on client={f.client} />);
    expect(screen.getByText("Sign in to see your usage")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it("waits for the server to say who is signed in, asking nothing meanwhile", () => {
    const f = fake();
    render(<MyUsagePage me={null} on client={f.client} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(f.calls).toEqual([]);
  });
});

describe("a signed-in person's page", () => {
  it("draws their spend, projects, sessions, failures and tool calls", async () => {
    render(<MyUsagePage me={ME} on client={fake().client} />);
    expect(await screen.findByRole("table", { name: "Spend" })).toHaveTextContent("Opus 5.5");
    expect(await screen.findByRole("table", { name: "Spend by project" })).toHaveTextContent("podium");
    expect(await screen.findByRole("table", { name: "Sessions by outcome" })).toHaveTextContent("completed");
    expect(await screen.findByRole("table", { name: "Failures" })).toHaveTextContent("permission");
    expect(await screen.findByRole("table", { name: "Tool calls" })).toHaveTextContent("Bash");
    expect(screen.getByRole("heading", { level: 1, name: "My usage" })).toBeInTheDocument();
    expect(screen.getByText(/Only your own sessions\./)).toBeInTheDocument();
  });

  it("asks for the period, the grouping and a breakdown and nothing that names a person, a group, a model or an id", async () => {
    const f = fake();
    render(<MyUsagePage me={ME} on client={f.client} />);
    await screen.findByRole("table", { name: "Tool calls" });
    const asked = f.calls.filter((c) => !c.startsWith("text"));
    expect(asked).toEqual(
      expect.arrayContaining([
        "/reports/spend?from=2026-09-21&to=2026-10-20&by=day&breakdown=model",
        "/reports/spend?from=2026-09-21&to=2026-10-20&by=day&breakdown=project",
        "/reports/sessions?from=2026-09-21&to=2026-10-20&by=day&breakdown=outcome",
        "/reports/failures?from=2026-09-21&to=2026-10-20&by=day&breakdown=class",
        "/reports/tools?from=2026-09-21&to=2026-10-20&by=day&breakdown=tool",
      ]),
    );
    for (const path of asked) for (const key of ["person", "group", "owner", "model=", "session", "id=", "name="]) expect(path.split("?")[1], path).not.toContain(key);
  });

  it("offers no Person, Group or Model filter, and a Harness filter from the harnesses the tool calls hold", async () => {
    render(<MyUsagePage me={ME} on client={fake().client} />);
    await screen.findByRole("table", { name: "Tool calls" });
    for (const name of ["Person", "Group", "Model"]) expect(screen.queryByLabelText(name), name).toBeNull();
    expect(screen.getByLabelText("Harness")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Harness")).getAllByRole("option").map((o) => o.textContent)).toEqual(["All harnesses", "Claude Code", "OpenCode"]);
  });

  it("sends the chosen harness with the tool calls, which are the figures it narrows", async () => {
    const f = fake();
    render(<MyUsagePage me={ME} on client={f.client} />);
    await screen.findByRole("table", { name: "Tool calls" });
    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "opencode" } });
    await waitFor(() => expect(f.calls).toContain("/reports/tools?from=2026-09-21&to=2026-10-20&by=day&breakdown=tool&harness=opencode"));
  });

  it("says when the stored sessions do not reach back as far as the period", async () => {
    render(<MyUsagePage me={ME} on client={fake().client} />);
    const sessions = await screen.findByRole("table", { name: "Sessions by outcome" });
    const section = sessions.closest("section")!;
    expect(within(section).getByText(/Podium has no history before 2026-09-19/)).toBeInTheDocument();
    expect(within(section).getByText(/kept for about a month/)).toBeInTheDocument();
  });

  it("keeps its own choices apart from Admin Reporting's, so a breakdown chosen there cannot break this page", async () => {
    localStorage.setItem("podium.adminReporting", JSON.stringify({ spend: { period: "7d", breakdown: "person" } }));
    const f = fake();
    render(<MyUsagePage me={ME} on client={f.client} />);
    await screen.findByRole("table", { name: "Spend" });
    expect(f.calls[0]).toContain("breakdown=model");
    expect(f.calls.join(" ")).not.toContain("breakdown=person");
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "90d" } });
    const kept = JSON.parse(localStorage.getItem("podium.adminReporting")!) as Record<string, { period: string }>;
    expect(kept["my-spend"]!.period).toBe("90d");
    expect(kept.spend!.period).toBe("7d");
  });

  it("downloads exactly the query a table shows, as CSV", async () => {
    const f = fake();
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    render(<MyUsagePage me={ME} on client={f.client} />);
    const section = (await screen.findByRole("table", { name: "Failures" })).closest("section")!;
    fireEvent.click(within(section).getByRole("button", { name: /CSV/ }));
    await waitFor(() => expect(f.calls).toContain("text /reports/failures?from=2026-09-21&to=2026-10-20&by=day&breakdown=class&format=csv"));
  });

  it("shows an error, not figures, when a report cannot be loaded", async () => {
    const client: ReportsClient = { get: () => Promise.reject(new Error("down")), text: () => Promise.reject(new Error("down")) };
    render(<MyUsagePage me={ME} on client={client} />);
    expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("the client", () => {
  it("maps a report to its own route and sends only the respond header, never anything that names a person", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = myUsageClient();
    await client.get("/reports/spend?from=2026-09-21&to=2026-10-20&breakdown=model");
    await client.text("/reports/failures?breakdown=class&format=csv");
    const [[url1, init1], [url2]] = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(url1).toBe("/api/fleet/respond/usage/spend?from=2026-09-21&to=2026-10-20&breakdown=model");
    expect(url2).toBe("/api/fleet/respond/usage/failures?breakdown=class&format=csv");
    expect(init1).toEqual({ credentials: "same-origin", headers: { "X-Podium-Respond": "1" } });
  });

  it("raises the status on a refusal so the page shows an error and not a figure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    await expect(myUsageClient().get("/reports/spend")).rejects.toMatchObject({ status: 403 });
  });
});

describe("the top bar button", () => {
  const api = (me: RespondMe) => ({ me: async () => me }) as unknown as RespondApi;
  const bar = (page: string, me: RespondMe) =>
    render(
      <RespondProvider flagsOn={false} myUsageOn={me.myUsage === true} api={api(me)}>
        <TopBar page={page} phase="live" reporters={1} />
      </RespondProvider>,
    );

  it("is on every page but its own while a person is signed in and the setting is on", async () => {
    for (const page of ["Fleet", "Board", "History", "Admin", "Chat", "My reporters"]) {
      const { unmount } = bar(page, ME);
      expect(await screen.findByRole("link", { name: "My usage" }), page).toHaveAttribute("href", "#/me/usage");
      unmount();
    }
  });

  it("is left off on My usage itself, as My reporters is on its own page", async () => {
    bar("My usage", ME);
    await screen.findByRole("button", { name: "Sign out" });
    expect(screen.queryByRole("link", { name: "My usage" })).toBeNull();
  });

  it("is not there signed out, nor while the Admin's setting is off", async () => {
    const out = bar("Fleet", OUT);
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByRole("link", { name: "My usage" })).toBeNull();
    out.unmount();
    bar("Fleet", { ...ME, myUsage: false });
    await waitFor(() => expect(screen.queryByRole("link", { name: "My usage" })).toBeNull());
  });
});

describe("the address", () => {
  it("opens My usage for #/me/usage only", () => {
    expect(routeFor("#/me/usage")).toBe("my-usage");
    expect(routeFor("#/me/usage-x")).toBe("fleet");
    expect(routeFor("#/me")).toBe("fleet");
  });
});
