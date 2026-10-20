// Admin > Reporting > Spend (#484): its three sections, the breakdown a Spend today row opens (#482) and the projection (#483).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeServer } from "./fakeAdmin";
import { REPORTING_KEY } from "./reportsApi";
import { breakdownFor } from "./SpendTab";
import { projectionEnd } from "./SpendProjection";
import { makeKpis, makeSession, makeState } from "../fixtures";
import type { OwnerSpend } from "../types";
import type { FleetSource } from "../useFleet";

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
});

const SPEND: OwnerSpend[] = [
  { owner: "Maya Okafor", group: "Platform", costUsd: 16.4 },
  { owner: "Jonas Weber", group: "Research", costUsd: 10.31 },
  { owner: "Admin", group: null, costUsd: 5.6 },
  { owner: null, group: null, costUsd: 1.2 },
];
const breakdown = (owner: string, extra: Record<string, unknown> = {}) => ({
  owner,
  total: 16.4,
  bySession: [
    { id: "s-api", name: "api-refactor", model: "Opus 5.5", costUsd: 9.12 },
    { id: "s-docs", name: "docs-sweep", model: "Sonnet 5.5", costUsd: 4.28 },
    { id: "s-odd", name: "scratch-local", model: "mystery-model", costUsd: null },
  ],
  byModel: [
    { model: "Opus 5.5", costUsd: 9.12 },
    { model: "Sonnet 5.5", costUsd: 7.28 },
    { model: "mystery-model", costUsd: null },
  ],
  bySource: { orchestrator: 11.9, agents: 4.5 },
  unpriced: 1,
  ...extra,
});

/** A line of a breakdown, whose amount is bold inside it. */
const line = (text: string) => screen.getByText((_, el) => el?.tagName === "DIV" && el.textContent === text);

async function openSpend(server = fakeServer({ unlocked: true }), spend: OwnerSpend[] = SPEND) {
  const body = makeState({ sessions: [makeSession({ id: "x1", owner: "Maya Okafor", ownerGroup: "Platform" })], kpis: makeKpis({ costToday: 33.5, costTodayByOwner: spend }) });
  render(<AdminView fleetOptions={{ open: () => new QuietSource() as unknown as FleetSource, fetchState: async () => body }} />);
  fireEvent.click(await screen.findByRole("button", { name: /^Spend/ }));
  const today = await screen.findByRole("region", { name: "Spend today, by person" });
  await waitFor(() => expect(within(today).getByRole("status")).toHaveTextContent(/Showing [1-9]/));
  return { server, today };
}

describe("the Spend page", () => {
  it("has three sections in order: Spend today, Projection, Spend over time", async () => {
    await openSpend();
    expect(screen.getByRole("heading", { level: 1, name: "Spend" })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Spend today, by person", "Projection", "Spend over time"]);
  });

  it("keeps Spend over time's report, with Break down by and its own Export", async () => {
    const { server } = await openSpend();
    const over = screen.getByRole("region", { name: "Spend over time" });
    expect(await within(over).findByRole("table", { name: "Spend" })).toBeInTheDocument();
    expect(server.calls.find((c) => c.startsWith("GET /reports/spend?") && c.includes("by=day"))).toBeDefined();
    fireEvent.change(within(over).getByLabelText("Break down by"), { target: { value: "model" } });
    await waitFor(() => expect(server.calls.slice(-1)[0]).toContain("breakdown=model"));
    expect(screen.getByRole("button", { name: "Download spend over time CSV" })).toBeInTheDocument();
    // An unpriced model is a dash and never $0.00.
    const table = await within(over).findByRole("table", { name: "Spend" });
    expect(within(table).getByText("mystery-model").closest("tr")).toHaveTextContent("–");
    expect(within(table).getAllByText("$301.15").length).toBeGreaterThan(0);
    expect(within(table).getByText("88.60M")).toBeInTheDocument();
  });
});

describe("the breakdown (#482)", () => {
  it("makes each row a button that opens the person's breakdown, moves focus to its heading and says it is expanded", async () => {
    const { server, today } = await openSpend();
    server.breakdowns["Maya Okafor"] = breakdown("Maya Okafor");
    const row = within(today).getByRole("button", { name: /Maya Okafor/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    const heading = await screen.findByRole("heading", { level: 2, name: "Maya Okafor, spend today" });
    expect(heading).toHaveFocus();
    expect(row).toHaveAttribute("aria-controls", "spend-bd");
    expect(server.calls).toContain("GET /reports/spend/today/Maya%20Okafor");
    expect(await screen.findByText("$16.40 since midnight, cut three ways. Each cut adds up to the row.")).toBeInTheDocument();
  });

  it("cuts the figure by session with a History link, by model, and orchestrator against agents, with a dash for no price", async () => {
    const { server, today } = await openSpend();
    server.breakdowns["Maya Okafor"] = breakdown("Maya Okafor");
    fireEvent.click(within(today).getByRole("button", { name: /Maya Okafor/ }));
    const bySession = await screen.findByRole("table", { name: "By session" });
    expect(within(bySession).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "#/history?day=2026-10-20&page=1&size=50&open=s-api",
      "#/history?day=2026-10-20&page=1&size=50&open=s-docs",
      "#/history?day=2026-10-20&page=1&size=50&open=s-odd",
    ]);
    expect(within(bySession).getByText("api-refactor").closest("tr")).toHaveTextContent("$9.12");
    expect(within(bySession).getByText("api-refactor").closest("tr")).toHaveTextContent("56%");
    expect(within(bySession).getByText("scratch-local").closest("tr")).toHaveTextContent("–");
    expect(within(bySession).getByText("Total").closest("tr")).toHaveTextContent("$16.40");
    expect(screen.getByText("By model")).toBeInTheDocument();
    expect(line("Opus 5.5 $9.12 (56%)")).toBeInTheDocument();
    expect(line("mystery-model –")).toBeInTheDocument();
    expect(line("Orchestrator $11.90 (73%)")).toBeInTheDocument();
    expect(line("Agents $4.50 (27%)")).toBeInTheDocument();
    expect(screen.getByText(/Plus 1 session on a model without a price\. It is left out of the sums, so the priced parts add up to \$16\.40\./)).toBeInTheDocument();
  });

  it("counts several unpriced sessions, accepts a source as an object, and leaves the line out when all are priced", async () => {
    const { server, today } = await openSpend();
    server.breakdowns["Maya Okafor"] = breakdown("Maya Okafor", { unpriced: 2, bySource: { orchestrator: { costUsd: 10 }, agents: null } });
    fireEvent.click(within(today).getByRole("button", { name: /Maya Okafor/ }));
    expect(await screen.findByText(/Plus 2 sessions on models without a price\. They are left out/)).toBeInTheDocument();
    expect(line("Orchestrator $10.00 (61%)")).toBeInTheDocument();
    expect(line("Agents – (–)")).toBeInTheDocument();
    fireEvent.click(within(today).getByRole("button", { name: /Jonas Weber/ }));
    server.breakdowns["Jonas Weber"] = breakdown("Jonas Weber", { unpriced: 0, total: null });
    fireEvent.click(within(today).getByRole("button", { name: /Maya Okafor/ }));
    fireEvent.click(within(today).getByRole("button", { name: /Jonas Weber/ }));
    await waitFor(() => expect(screen.queryByText(/Plus \d+ session/)).toBeNull());
    expect(screen.getAllByText("–").length).toBeGreaterThan(0);
  });

  it("closes with Close and returns focus to the row; clicking the open row again also closes it", async () => {
    const { server, today } = await openSpend();
    server.breakdowns["Maya Okafor"] = breakdown("Maya Okafor");
    const row = within(today).getByRole("button", { name: /Maya Okafor/ });
    fireEvent.click(row);
    await screen.findByRole("table", { name: "By session" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { name: "Maya Okafor, spend today" })).toBeNull();
    expect(row).toHaveFocus();
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    await screen.findByRole("table", { name: "By session" });
    fireEvent.click(row);
    expect(screen.queryByRole("table", { name: "By session" })).toBeNull();
  });

  it("opens the Admin row and the no-owner row with the owner the route expects", async () => {
    const { server, today } = await openSpend();
    server.breakdowns.Admin = breakdown("Admin");
    server.breakdowns["-"] = breakdown("-");
    fireEvent.click(within(today).getByRole("button", { name: /^Admin/ }));
    await screen.findByRole("heading", { name: "Admin, spend today" });
    fireEvent.click(within(today).getByRole("button", { name: /Unassigned/ }));
    await screen.findByRole("heading", { name: "Unassigned, spend today" });
    expect(server.calls).toContain("GET /reports/spend/today/Admin");
    expect(server.calls).toContain("GET /reports/spend/today/-");
  });

  it("opens a group with its people first, and a member opens that person", async () => {
    const { server, today } = await openSpend();
    server.breakdowns.Platform = breakdown("Platform", { byPerson: [{ owner: "Maya Okafor", costUsd: 12, share: 0.7 }, { owner: "Cai Lindqvist", costUsd: 4.4 }] });
    server.breakdowns["Maya Okafor"] = breakdown("Maya Okafor");
    fireEvent.click(within(today).getByRole("button", { name: "Groups" }));
    const groups = await screen.findByRole("region", { name: "Spend today, by group" });
    fireEvent.click(within(groups).getByRole("button", { name: "Platform" }));
    const people = await screen.findByRole("table", { name: "By person" });
    expect(server.calls).toContain("GET /reports/spend/today/Platform?group=1");
    expect(within(people).getByText("Cai Lindqvist").closest("tr")).toHaveTextContent("$4.40");
    expect(within(people).getByText("Maya Okafor").closest("tr")).toHaveTextContent("73%");
    expect(screen.getByRole("table", { name: "By session" })).toBeInTheDocument();
    fireEvent.click(within(people).getByRole("button", { name: "Maya Okafor" }));
    await screen.findByRole("heading", { name: "Maya Okafor, spend today" });
    expect(screen.queryByRole("table", { name: "By person" })).toBeNull();
    // Choosing another grouping drops a breakdown that belonged to the old one.
    fireEvent.click(within(groups).getByRole("button", { name: "People" }));
    expect(screen.queryByRole("heading", { name: /spend today$/ })).toBeNull();
  });

  it("gives the No group row no breakdown, since it holds people from several groups", async () => {
    const { today } = await openSpend(undefined, [{ owner: "Admin", group: null, costUsd: 3 }, { owner: "Maya Okafor", group: "Platform", costUsd: 2 }]);
    fireEvent.click(within(today).getByRole("button", { name: "Groups" }));
    const groups = await screen.findByRole("region", { name: "Spend today, by group" });
    expect(within(groups).getByText("No group")).toBeInTheDocument();
    expect(within(groups).queryByRole("button", { name: /No group/ })).toBeNull();
    expect(within(groups).getByRole("button", { name: "Platform" })).toBeInTheDocument();
  });

  it("works in the table view too", async () => {
    const { server, today } = await openSpend();
    server.breakdowns["Maya Okafor"] = breakdown("Maya Okafor");
    fireEvent.click(within(today).getByRole("button", { name: "Table" }));
    const table = within(today).getByRole("table", { name: "Spend today, by person" });
    fireEvent.click(within(table).getByRole("button", { name: "Maya Okafor" }));
    expect(await screen.findByRole("heading", { name: "Maya Okafor, spend today" })).toBeInTheDocument();
  });

  it("says what went wrong, asks again, and locks Admin if the session ended", async () => {
    const { server, today } = await openSpend();
    fireEvent.click(within(today).getByRole("button", { name: /Maya Okafor/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load Maya Okafor's spend. Check that the server is running, then try again.");
    expect(alert.textContent).not.toMatch(/404|nope|unknown owner/);
    server.breakdowns["Maya Okafor"] = breakdown("Maya Okafor");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "By session" })).toBeInTheDocument();
    server.expire = true;
    fireEvent.click(within(today).getByRole("button", { name: /Jonas Weber/ }));
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
  });

  it("draws a hostile name as text", async () => {
    const { server, today } = await openSpend(undefined, [{ owner: '<b onmouseover="x">Evil</b>', group: null, costUsd: 4 }]);
    server.breakdowns['<b onmouseover="x">Evil</b>'] = breakdown("x", { bySession: [{ id: "s1", name: "<script>x</script>", model: "<i>m</i>", costUsd: 1 }] });
    fireEvent.click(within(today).getByRole("button", { name: /Evil/ }));
    const table = await screen.findByRole("table", { name: "By session" });
    expect(table.querySelector("script, i")).toBeNull();
    expect(within(table).getByText("<script>x</script>")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: '<b onmouseover="x">Evil</b>, spend today' })).toBeInTheDocument();
  });

  it("knows which rows have a breakdown", () => {
    const row = (kind: string, name: string) => ({ key: `${kind}:${name}`, kind, name, group: null, spend: 1, sessions: 0 }) as Parameters<typeof breakdownFor>[0];
    expect(breakdownFor(row("person", "Ana"))).toMatchObject({ owner: "Ana", group: false });
    expect(breakdownFor(row("admin", "Admin"))).toMatchObject({ owner: "Admin" });
    expect(breakdownFor(row("unassigned", "Unassigned"))).toMatchObject({ owner: "-", label: "Unassigned" });
    expect(breakdownFor(row("group", "Data"))).toMatchObject({ owner: "Data", group: true });
    expect(breakdownFor(row("nogroup", "No group"))).toBeNull();
  });
});

describe("the projection (#483)", () => {
  it("asks for the rest of this month over 14 days by person, and shows the window, the run rate and the assumptions", async () => {
    const { server } = await openSpend();
    const section = screen.getByRole("region", { name: "Projection" });
    expect(await within(section).findByRole("table", { name: "Projection by person" })).toBeInTheDocument();
    expect(server.calls).toContain("GET /reports/spend/projection?horizon=month&window=14&by=person");
    expect(within(section).getByText("projected to 2026-10-31").previousElementSibling).toHaveTextContent("$1,134.80");
    expect(within(section).getByText("run rate per day").previousElementSibling).toHaveTextContent("$38.40");
    expect(within(section).getByText("Based on the 14 days 2026-10-06 to 2026-10-19.")).toBeInTheDocument();
    expect(within(section).getByText(/Straight run rate: weekdays, trends and price changes are not allowed for\. Not a budget\. 3 sessions on models without a price are left out\./)).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Rest of this month" })).toHaveAttribute("aria-pressed", "true");
    expect(within(section).getByRole("button", { name: "14 days" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows Not enough history in a person's cell, with a dash for the run rate, and still adds up the total", async () => {
    await openSpend();
    const table = await screen.findByRole("table", { name: "Projection by person" });
    const cai = within(table).getByText("Cai Lindqvist").closest("tr")!;
    expect(cai).toHaveTextContent("–");
    expect(cai).toHaveTextContent("$11.75");
    expect(within(cai).getByText("Not enough history")).toBeInTheDocument();
    expect(within(table).getByText("Total").closest("tr")).toHaveTextContent("$1,134.80");
  });

  it("says Not enough history to project in place of the number, and how many days Podium has", async () => {
    const s = fakeServer({ unlocked: true });
    s.projection = { columns: [], rows: [{ key: "Maya Okafor", runRatePerDay: null, spentThisMonth: 5, projected: null, reason: "history" }], total: { runRatePerDay: null, spentThisMonth: 5, projected: null, reason: "history" }, window: { from: "2026-10-14", to: "2026-10-19", days: 6 }, horizon: "month", unpricedSessions: 0, historyDays: 6 };
    await openSpend(s);
    const section = screen.getByRole("region", { name: "Projection" });
    expect(await within(section).findByText("Not enough history to project.")).toBeInTheDocument();
    expect(within(section).getByText("Podium has 6 days so far.")).toBeInTheDocument();
    expect(within(section).queryByText(/projected to/)).toBeNull();
    expect(within(section).getByText(/Models without a price are left out\./)).toBeInTheDocument();
    expect(within(section).getByText("Total").closest("tr")).toHaveTextContent("–");
  });

  it("says one day, one unpriced session, and an empty window plainly", async () => {
    const s = fakeServer({ unlocked: true });
    s.projection = { columns: [], rows: [], total: { runRatePerDay: null, spentThisMonth: 0, projected: null }, window: { from: "2026-10-19", to: "2026-10-19", days: 1 }, horizon: "month", unpricedSessions: 1, historyDays: 1 };
    await openSpend(s);
    const section = screen.getByRole("region", { name: "Projection" });
    expect(await within(section).findByText("Podium has 1 day so far.")).toBeInTheDocument();
    expect(within(section).getByText("Based on the 1 day 2026-10-19 to 2026-10-19.")).toBeInTheDocument();
    expect(within(section).getByText(/1 session on models without a price is left out\./)).toBeInTheDocument();
    expect(within(section).getByText("Nothing was spent in this window yet.")).toBeInTheDocument();
  });

  it("asks again for the next 30 days, a 30-day window and groups, and remembers all three", async () => {
    const { server } = await openSpend();
    const section = screen.getByRole("region", { name: "Projection" });
    await within(section).findByRole("table", { name: "Projection by person" });
    fireEvent.click(within(section).getByRole("button", { name: "Next 30 days" }));
    await waitFor(() => expect(server.calls.slice(-1)[0]).toBe("GET /reports/spend/projection?horizon=30d&window=14&by=person"));
    expect(await within(section).findByText("projected to 2026-11-19")).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "30 days" }));
    fireEvent.click(within(section).getByRole("button", { name: "Groups" }));
    await waitFor(() => expect(server.calls.slice(-1)[0]).toBe("GET /reports/spend/projection?horizon=30d&window=30&by=group"));
    expect(await within(section).findByRole("table", { name: "Projection by group" })).toBeInTheDocument();
    expect(within(section).getByRole("columnheader", { name: "Group" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(REPORTING_KEY) ?? "{}").projection).toMatchObject({ horizon: "30d", window: 30, by: "group" });
  });

  it("downloads the projection as CSV and JSON", async () => {
    const saved: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:p"), revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    const { server } = await openSpend();
    const section = screen.getByRole("region", { name: "Projection" });
    await within(section).findByRole("table", { name: "Projection by person" });
    expect(within(section).queryByRole("button", { name: /Print/ })).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Download projection JSON" }));
    fireEvent.click(within(section).getByRole("button", { name: "Download projection CSV" }));
    await waitFor(() => expect(saved).toEqual(["podium-spend-projection-2026-10-20.json", "podium-spend-projection-2026-10-20.csv"]));
    expect(server.calls).toContain("GET /reports/spend/projection?horizon=month&window=14&by=person&format=csv");
    server.reportStatus = 500;
    fireEvent.click(within(section).getByRole("button", { name: "Download projection CSV" }));
    expect(await within(section).findByText("Could not download the file. Try again.")).toBeInTheDocument();
    server.reportStatus = 401;
    fireEvent.click(within(section).getByRole("button", { name: "Download projection CSV" }));
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
  });

  it("says what went wrong without a code, and asks again", async () => {
    const s = fakeServer({ unlocked: true });
    s.reportStatus = 500;
    await openSpend(s);
    const section = screen.getByRole("region", { name: "Projection" });
    const alert = await within(section).findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the projection. Check that the server is running, then try again.");
    s.reportStatus = 0;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(section).findByRole("table", { name: "Projection by person" })).toBeInTheDocument();
  });

  it("works out the day a projection runs to", () => {
    expect(projectionEnd("month", new Date(2026, 9, 20))).toEqual({ date: "2026-10-31", daysAfterToday: 11 });
    expect(projectionEnd("month", new Date(2026, 1, 3))).toEqual({ date: "2026-02-28", daysAfterToday: 25 });
    expect(projectionEnd("30d", new Date(2026, 9, 20))).toEqual({ date: "2026-11-19", daysAfterToday: 30 });
  });
});
