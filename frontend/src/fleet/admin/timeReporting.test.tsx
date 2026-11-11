// Admin > Reporting > Sessions and Usage (#722): the sections they add for how long sessions ran and waited, which agents they launched and
// how deep the chains went, who ran sessions on a day, and the busiest hours, with the harness filter and each table's export.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 20, 12));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PERIOD = "from=2026-09-21&to=2026-10-20";

async function open(page: "Sessions" | "Usage", table: string, server = fakeServer({ unlocked: true })) {
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("button", { name: page }));
  await screen.findByRole("table", { name: table });
  return server;
}
const openSessions = (s?: ReturnType<typeof fakeServer>) => open("Sessions", "Length and waiting by period", s);
const openUsage = (s?: ReturnType<typeof fakeServer>) => open("Usage", "Sessions per person per day", s);
const row = (table: HTMLElement, text: string) => within(table).getByText(text).closest("tr")!;

describe("the Sessions page", () => {
  it("asks for the period four ways, beside the report it already had", async () => {
    const s = await openSessions();
    await screen.findByRole("table", { name: "Agent chain depth" });
    expect(s.calls.filter((c) => c.startsWith("GET /reports/sessiontime?"))).toEqual(
      expect.arrayContaining([
        `GET /reports/sessiontime?${PERIOD}&by=day&breakdown=time`,
        `GET /reports/sessiontime?${PERIOD}&breakdown=reason`,
        `GET /reports/sessiontime?${PERIOD}&breakdown=agents`,
        `GET /reports/sessiontime?${PERIOD}&breakdown=depth`,
      ]),
    );
    expect(s.calls.some((c) => c.startsWith("GET /reports/sessions?"))).toBe(true);
  });

  it("draws length and waiting, with a row for the whole period and for each harness, and says when waiting began", async () => {
    await openSessions();
    const table = screen.getByRole("table", {
      name: "Length and waiting by period",
    });
    expect(row(table, "2026-10-05")).toHaveTextContent("6056:407h 05m20h 06m24%");
    expect(row(table, "2026-10-12")).toHaveTextContent("6949:104h 55m13h 24m18%");
    expect(row(table, "Whole period, all harnesses")).toHaveTextContent("12951:407h 05m1d 09h21%");
    expect(row(table, "Claude Code")).toHaveTextContent("11053:207h 05m1d 07h21%");
    expect(row(table, "OpenCode")).toHaveTextContent("1945:003h 40m2h 30m17%");
    expect(screen.getByText("waiting on people, since 2026-10-12").previousElementSibling).toHaveTextContent("1d 09h");
    expect(screen.getByText("of session time spent waiting").previousElementSibling).toHaveTextContent("21%");
    expect(screen.getByText(/Waiting time is recorded from 2026-10-12,/)).toBeInTheDocument();
    // the chart of hours waited has the short axis labels and the exact figure for a screen reader
    expect(
      screen.getByRole("img", {
        name: /Time waiting on people per week|Time waiting on people per day/,
      }),
    ).toBeInTheDocument();
  });

  it("splits the waiting by kind, and it adds up to the total", async () => {
    await openSessions();
    const table = await screen.findByRole("table", {
      name: "Waiting by reason",
    });
    expect(row(table, "Permission for a tool")).toHaveTextContent("64031:052:5563%");
    expect(row(table, "An answer to a question")).toHaveTextContent("18618:406:0138%");
    expect(row(table, "Approval of a plan")).toHaveTextContent("0");
    expect(row(table, "Total")).toHaveTextContent("82649:453:37100%");
  });

  it("draws agents by type for each harness with the long tail as one row, and the deepest chain", async () => {
    await openSessions();
    const table = await screen.findByRole("table", {
      name: "Agents launched by type",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Agent type", "Claude Code", "OpenCode", "Launched", "Share"]);
    expect(row(table, "general-purpose")).toHaveTextContent("52096616");
    expect(row(table, "Other, 2 types")).toHaveTextContent("6046106");
    expect(row(table, "Total")).toHaveTextContent("9861421,128100%");
    expect(screen.getByText("agents per session").previousElementSibling).toHaveTextContent("3.9");
    await waitFor(() => expect(screen.getByText("levels deep at most").previousElementSibling).toHaveTextContent("4"));
  });

  it("draws chain depth for each harness, with three or deeper as one row", async () => {
    await openSessions();
    const table = await screen.findByRole("table", {
      name: "Agent chain depth",
    });
    expect(row(table, "1, launched by the session itself")).toHaveTextContent("1,0101241,134");
    expect(row(table, "2, launched by an agent")).toHaveTextContent("58058");
    expect(row(table, "3 or deeper")).toHaveTextContent("022");
  });

  it("narrows the added sections to a harness, says the older report is not kept that way, and does not send it there", async () => {
    const s = await openSessions();
    fireEvent.change(screen.getByLabelText("Harness"), {
      target: { value: "opencode" },
    });
    await waitFor(() => expect(s.calls.filter((c) => c.startsWith("GET /reports/sessiontime?") && c.includes("harness=opencode"))).toHaveLength(6));
    expect(s.calls.filter((c) => c.startsWith("GET /reports/sessions?") && c.includes("harness"))).toEqual([]);
    expect(await screen.findByText(/This section is not kept per harness, so it covers every harness/)).toBeInTheDocument();
    const table = screen.getByRole("table", {
      name: "Length and waiting by period",
    });
    expect(within(table).getByText("Whole period, OpenCode")).toBeInTheDocument();
    expect(localStorage.getItem("podium.adminReporting")).toContain('"harness":"opencode"');
  });

  it("offers the harnesses the report names, and a person, group or model filter holds the sections back with a line that says why", async () => {
    const server = fakeServer({ unlocked: true });
    server.groups.push({ id: 1, name: "Platform" });
    const s = await openSessions(server);
    expect(
      within(screen.getByLabelText("Harness"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All harnesses", "Claude Code", "OpenCode"]);
    const before = s.calls.filter((c) => c.startsWith("GET /reports/sessiontime?")).length;
    fireEvent.change(screen.getByLabelText("Group"), {
      target: { value: "Platform" },
    });
    await waitFor(() => expect(screen.getAllByText(/not shown while a Person, Group or Model filter is set/)).toHaveLength(8));
    expect(s.calls.filter((c) => c.startsWith("GET /reports/sessiontime?")).length).toBe(before);
    expect(screen.queryByRole("table", { name: "Length and waiting by period" })).toBeNull();
  });

  it("leaves the added sections out when the period cannot be asked for, so the message is said once", async () => {
    await openSessions();
    fireEvent.change(screen.getByLabelText("Period"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "2026-10-25" },
    });
    expect(await screen.findByText("To cannot be after today.")).toBeInTheDocument();
    expect(screen.getAllByText("Fix the period above to see the report.")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Agents launched" })).toBeNull();
  });

  it("downloads each table as it is shown: the exact query with the format added", async () => {
    const s = await openSessions();
    fireEvent.click(screen.getByRole("button", { name: "Download waiting by reason CSV" }));
    await waitFor(() => expect(s.calls.some((c) => c.includes("/reports/sessiontime?") && c.includes("breakdown=reason") && c.includes("format=csv"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Download chain depth CSV" }));
    await waitFor(() => expect(s.calls.some((c) => c.includes("breakdown=depth") && c.includes("format=csv"))).toBe(true));
    // the page's own Download CSV is still the report it had
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeEnabled();
  });
});

describe("the Usage page", () => {
  it("asks for each person's days and for the hours, and the hours are not cut by group", async () => {
    const server = fakeServer({ unlocked: true });
    server.groups.push({ id: 1, name: "Platform" });
    const s = await openUsage(server);
    await screen.findByRole("heading", { name: "Busiest hours" });
    expect(s.calls).toEqual(expect.arrayContaining([`GET /reports/workload?${PERIOD}&breakdown=person`, `GET /reports/workload?${PERIOD}&breakdown=hour`]));
    fireEvent.change(screen.getByLabelText("Group"), {
      target: { value: "Platform" },
    });
    await waitFor(() => expect(s.calls.some((c) => c.includes("breakdown=person") && c.includes("group=Platform"))).toBe(true));
    expect(s.calls.some((c) => c.includes("breakdown=hour") && c.includes("group="))).toBe(false);
    expect(await screen.findByText(/so the Group filter does not apply to them/)).toBeInTheDocument();
  });

  it("gives each person's days, sessions per active day and busiest day, with the total and a pager", async () => {
    await openUsage();
    const table = screen.getByRole("table", {
      name: "Sessions per person per day",
    });
    expect(row(table, "Maya Okafor")).toHaveTextContent("Platform221185.42026-10-07, 11 sessions");
    expect(row(table, "No owner")).toHaveTextContent("None6142.32026-10-09, 4 sessions");
    expect(row(table, "All 4 people")).toHaveTextContent("562374.22026-10-07, 21 sessions");
    expect(screen.getByText("Showing 1 to 4 of 4")).toBeInTheDocument();
  });

  it("draws the 24 hours as a chart that names the busiest, and as a table", async () => {
    await openUsage();
    const chart = await screen.findByRole("img", {
      name: /Most sessions live at once by hour of day/,
    });
    expect(chart.getAttribute("aria-label")).toContain("Busiest at 11:00 and 14:00 with 9.");
    expect(chart.querySelectorAll("rect.rbar")).toHaveLength(17);
    expect(screen.getByText("busiest hour, first reached").previousElementSibling).toHaveTextContent("11:00");
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    const table = screen.getByRole("table", {
      name: "Most sessions live at once by hour of day",
    });
    expect(within(table).getAllByRole("row")).toHaveLength(25);
    expect(row(table, "11:00 to 12:00")).toHaveTextContent("9");
    expect(row(table, "23:00 to 00:00")).toHaveTextContent("0");
  });

  it("narrows both sections to a harness and says the report above them is not kept that way", async () => {
    const s = await openUsage();
    fireEvent.change(screen.getByLabelText("Harness"), {
      target: { value: "opencode" },
    });
    await waitFor(() => expect(s.calls.filter((c) => c.startsWith("GET /reports/workload?") && c.includes("harness=opencode"))).toHaveLength(3));
    expect(s.calls.filter((c) => c.startsWith("GET /reports/usage?") && c.includes("harness"))).toEqual([]);
    expect(await screen.findByText(/This section is not kept per harness/)).toBeInTheDocument();
  });

  it("downloads the busiest hours and each person's days", async () => {
    const s = await openUsage();
    fireEvent.click(screen.getByRole("button", { name: "Download busiest hours CSV" }));
    await waitFor(() => expect(s.calls.some((c) => c.includes("breakdown=hour") && c.includes("format=csv"))).toBe(true));
    expect(screen.getByRole("button", { name: "Download sessions per person JSON" })).toBeEnabled();
  });
});
