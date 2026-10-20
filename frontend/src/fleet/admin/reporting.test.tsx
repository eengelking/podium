// Admin > Reporting (#484): the menu group, the shared report page, each report, Data kept, and Security's new name.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeServer } from "./fakeAdmin";
import { REPORTING_KEY } from "./reportsApi";

class QuietSource {
  onerror = null;
  readyState = 1;
  addEventListener() {}
  close() {}
}

// 2026-10-20: "Last 30 days" is 2026-09-21 to 2026-10-20.
const FROM = "2026-09-21";
const TO = "2026-10-20";

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

async function openPage(name: string | RegExp, server = fakeServer({ unlocked: true })) {
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("button", { name }));
  return server;
}
/** The calls that fetch the report itself, not the models the Model filter offers (a month break-down by model). */
const reportCalls = (s: { calls: string[] }, report: string) => s.calls.filter((c) => c.startsWith(`GET /reports/${report}?`) && !c.includes("by=month&breakdown=model"));

describe("Usage, the shared report page", () => {
  it("asks for the last 30 days by day, and draws the totals, the chart, the table and the pager", async () => {
    const s = await openPage("Usage");
    expect(await screen.findByRole("heading", { level: 1, name: "Usage" })).toBeInTheDocument();
    await screen.findByRole("table", { name: "Usage" });
    expect(reportCalls(s, "usage")[0]).toBe(`GET /reports/usage?from=${FROM}&to=${TO}&by=day`);
    expect(screen.getByRole("heading", { level: 2, name: "Period and filters" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Usage by day" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Usage" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Day", "People", "Reporters", "Sessions", "Most live"]);
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 2 + 1);
    expect(within(table).getByText("Whole period").closest("tr")).toHaveTextContent("157");
    expect(screen.getByText("active people").previousElementSibling).toHaveTextContent("11");
    expect(screen.getByRole("img", { name: /Sessions started per day: 2 periods from 2026-10-12 to 2026-10-19, highest 88 on 2026-10-12, 157 in all/ })).toBeInTheDocument();
    expect(screen.getByText("Showing 1 to 2 of 2")).toBeInTheDocument();
  });

  it("states the time zone and what the figures are based on", async () => {
    await openPage("Usage");
    expect(await screen.findByText("Days are in Europe/Berlin time.")).toBeInTheDocument();
    expect(screen.getByText(/Based on daily rollups since 2026-03-02; today is read live\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(await screen.findByText("Weeks start Monday, in Europe/Berlin time.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(await screen.findByText("Months are in Europe/Berlin time.")).toBeInTheDocument();
  });

  it("offers Last 7, 30 and 90 days, This month, Last month and Custom, and asks again for each", async () => {
    const s = await openPage("Usage");
    const period = await screen.findByLabelText("Period");
    expect([...(period as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Last 7 days", "Last 30 days", "Last 90 days", "This month", "Last month", "Custom"]);
    expect((period as HTMLSelectElement).value).toBe("30d");
    fireEvent.change(period, { target: { value: "last-month" } });
    await waitFor(() => expect(reportCalls(s, "usage").slice(-1)[0]).toBe("GET /reports/usage?from=2026-09-01&to=2026-09-30&by=day"));
    fireEvent.change(period, { target: { value: "month" } });
    await waitFor(() => expect(reportCalls(s, "usage").slice(-1)[0]).toBe("GET /reports/usage?from=2026-10-01&to=2026-10-20&by=day"));
  });

  it("filters by group, with the groups the server has", async () => {
    const s = fakeServer({ unlocked: true });
    s.groups.push({ id: 1, name: "Platform" });
    await openPage("Usage", s);
    const group = await screen.findByLabelText("Group");
    await waitFor(() => expect([...(group as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "-", "Platform"]));
    expect(screen.queryByLabelText("Person")).toBeNull();
    fireEvent.change(group, { target: { value: "Platform" } });
    await waitFor(() => expect(reportCalls(s, "usage").slice(-1)[0]).toContain("group=Platform"));
    expect((group as HTMLSelectElement).value).toBe("Platform");
  });

  it("starts Custom from the dates last shown, refuses a range it cannot ask for, and asks once it can", async () => {
    const s = await openPage("Usage");
    fireEvent.change(await screen.findByLabelText("Period"), { target: { value: "custom" } });
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe(FROM);
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe(TO);
    await waitFor(() => expect(reportCalls(s, "usage").slice(-1)[0]).toContain(`from=${FROM}&to=${TO}`));
    const before = reportCalls(s, "usage").length;
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-25" } });
    expect(await screen.findByText("To cannot be after today.")).toBeInTheDocument();
    expect(screen.getByText("Fix the period above to see the report.")).toBeInTheDocument();
    expect(reportCalls(s, "usage")).toHaveLength(before);
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-10" } });
    await waitFor(() => expect(reportCalls(s, "usage").slice(-1)[0]).toContain("from=2026-10-01&to=2026-10-10"));
    expect(screen.queryByText("To cannot be after today.")).toBeNull();
  });

  it("remembers the choice in this browser under podium.adminReporting", async () => {
    await openPage("Usage");
    fireEvent.click(await screen.findByRole("button", { name: "Week" }));
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "7d" } });
    await waitFor(() => expect(JSON.parse(localStorage.getItem(REPORTING_KEY) ?? "{}").usage).toMatchObject({ by: "week", period: "7d" }));
    cleanup();
    const s = await openPage("Usage");
    await screen.findByRole("table", { name: "Usage" });
    expect(reportCalls(s, "usage")[0]).toBe("GET /reports/usage?from=2026-10-14&to=2026-10-20&by=week");
    expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
  });

  it("works when the browser blocks storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await openPage("Usage");
    expect(await screen.findByRole("table", { name: "Usage" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(await screen.findByText("Weeks start Monday, in Europe/Berlin time.")).toBeInTheDocument();
  });

  it("says a period before the first rollup day has no history, and never draws zeros for it", async () => {
    const s = fakeServer({ unlocked: true });
    s.reports.usage = { report: "usage", from: "2026-01-01", to: "2026-03-31", by: "day", tz: "Europe/Berlin", basedOn: "daily rollups", oldestDay: "2026-03-02", partial: true, columns: [{ key: "period", label: "Day" }, { key: "sessions", label: "Sessions" }], rows: [{ period: "2026-03-02", sessions: 4 }], total: null };
    await openPage("Usage", s);
    expect(await screen.findByText("Podium has no history before 2026-03-02. The figures below cover 2026-03-02 to 2026-03-31.")).toBeInTheDocument();
  });

  it("says so when the whole period is before the first day, and when the server has no history at all", async () => {
    const s = fakeServer({ unlocked: true });
    const empty = { report: "usage", by: "day", tz: "UTC", basedOn: "daily rollups", columns: [], rows: [], total: null, partial: true };
    s.reports.usage = { ...empty, from: "2026-01-01", to: "2026-01-31", oldestDay: "2026-03-02" };
    await openPage("Usage", s);
    expect(await screen.findByText("Podium has no history before 2026-03-02. This period ends before it, so there is nothing to show.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing was recorded in this period.")).toBeNull();
    s.reports.usage = { ...empty, from: FROM, to: TO, oldestDay: null };
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(await screen.findByText("Podium has no history for this period yet.")).toBeInTheDocument();
  });

  it("says nothing was recorded for an empty period, with no table, chart or pager", async () => {
    const s = fakeServer({ unlocked: true });
    s.reports.usage = { report: "usage", from: FROM, to: TO, by: "day", tz: "UTC", basedOn: "daily rollups", oldestDay: "2026-03-02", columns: [{ key: "period", label: "Day" }], rows: [], total: null };
    await openPage("Usage", s);
    expect(await screen.findByText("Nothing was recorded in this period.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it("describes a basis other than rollups in the server's words", async () => {
    const s = fakeServer({ unlocked: true });
    s.reports.usage = { report: "usage", from: FROM, to: TO, by: "day", tz: "UTC", basedOn: "admin log", oldestDay: null, columns: [], rows: [], total: null };
    await openPage("Usage", s);
    expect(await screen.findByText("Based on the Admin log.")).toBeInTheDocument();
  });

  it("says what went wrong without a status code, and asks again on Try again", async () => {
    const s = fakeServer({ unlocked: true });
    s.reportStatus = 500;
    await openPage("Usage", s);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load this report. Check that the server is running, then try again.");
    expect(alert.textContent).not.toMatch(/500|HTTP|nope/);
    s.reportStatus = 0;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Usage" })).toBeInTheDocument();
  });

  it("tells the person to choose another period when the server will not take it", async () => {
    const s = fakeServer({ unlocked: true });
    s.reportStatus = 400;
    await openPage("Usage", s);
    expect(await screen.findByRole("alert")).toHaveTextContent("did not accept that period or filter");
  });

  it("goes back to the lock screen when the session has ended", async () => {
    const s = fakeServer({ unlocked: true });
    await openPage("Usage", s);
    await screen.findByRole("table", { name: "Usage" });
    s.expire = true;
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
  });

  it("draws a hostile name as text", async () => {
    const s = fakeServer({ unlocked: true });
    s.reports.spend = {
      report: "spend",
      from: FROM,
      to: TO,
      by: "day",
      tz: "UTC",
      basedOn: "daily rollups",
      oldestDay: null,
      columns: [{ key: "period", label: "Day" }, { key: "key", label: "Person" }, { key: "costUsd", label: "Spend", unit: "usd" }],
      rows: [{ period: "2026-10-19", key: '<img src=x onerror="alert(1)">', costUsd: 1 }],
      total: null,
    };
    await openPage(/^Spend/, s);
    const table = await screen.findByRole("table", { name: "Spend" });
    expect(table.querySelector("img")).toBeNull();
    expect(within(table).getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
  });
});

describe("a missing owner, group or model", () => {
  it("reads as what it is in a row and in the filters, and is sent back as a dash", async () => {
    const s = fakeServer({ unlocked: true });
    s.reports.spend = { report: "spend", from: FROM, to: TO, by: "day", tz: "UTC", basedOn: "rollups", oldestDay: "2026-03-02", columns: [{ key: "period", label: "Day" }, { key: "key", label: "Model" }, { key: "costUsd", label: "Spend", unit: "usd" }], rows: [{ period: "2026-10-19", key: "-", costUsd: 1 }], total: null };
    localStorage.setItem(REPORTING_KEY, JSON.stringify({ spend: { breakdown: "model" } }));
    await openPage(/^Spend/, s);
    const table = await screen.findByRole("table", { name: "Spend" });
    expect(within(table).getByText("Unknown model")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: "-" } });
    await waitFor(() => expect(s.calls.slice(-1)[0]).toContain("person=-"));
    expect(screen.getByRole("option", { name: "No owner" })).toBeInTheDocument();
  });
});

describe("Export", () => {
  function stubDownload() {
    const saved: { name: string; blob: Blob }[] = [];
    const create = vi.fn((blob: Blob) => (saved.push({ name: "", blob }), `blob:${saved.length}`));
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved[saved.length - 1]!.name = this.download;
    });
    return { saved, revoke };
  }
  const text = (b: Blob) =>
    new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsText(b);
    });

  it("downloads the reply as shown for JSON, named for the report and the period", async () => {
    const { saved, revoke } = stubDownload();
    await openPage("Usage");
    await screen.findByRole("table", { name: "Usage" });
    fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe(`podium-usage-${FROM}-${TO}.json`);
    const body = JSON.parse(await text(saved[0]!.blob));
    expect(body).toMatchObject({ report: "usage", tz: "Europe/Berlin", total: { sessions: 157 } });
    expect(body.rows).toHaveLength(2);
    expect(revoke).toHaveBeenCalledWith("blob:1");
  });

  it("asks the server for the same query as CSV and downloads it", async () => {
    const { saved } = stubDownload();
    const s = await openPage("Usage");
    await screen.findByRole("table", { name: "Usage" });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.name).toBe(`podium-usage-${FROM}-${TO}.csv`);
    expect(await text(saved[0]!.blob)).toBe("period,sessions\n2026-10-19,69\n");
    expect(s.calls).toContain(`GET /reports/usage?from=${FROM}&to=${TO}&by=day&format=csv`);
  });

  it("says when the file could not be made, and what to do", async () => {
    stubDownload();
    const s = await openPage("Usage");
    await screen.findByRole("table", { name: "Usage" });
    s.reportStatus = 500;
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await screen.findByText("Could not download the file. Try again.")).toBeInTheDocument();
  });

  it("locks Admin when the session ended during a CSV download", async () => {
    stubDownload();
    const s = await openPage("Usage");
    await screen.findByRole("table", { name: "Usage" });
    s.reportStatus = 401;
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
  });

  it("prints the page", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    await openPage("Usage");
    fireEvent.click(await screen.findByRole("button", { name: "Print this page" }));
    expect(print).toHaveBeenCalledOnce();
  });
});

describe("People and groups", () => {
  it("counts people, groups and reporters, lists the versions, and says each state in a word", async () => {
    await openPage("People and groups");
    const table = await screen.findByRole("table", { name: "People and groups" });
    expect(screen.getByRole("heading", { level: 2, name: "People and groups" })).toBeInTheDocument();
    expect(screen.getByText("reporters").previousElementSibling).toHaveTextContent("3");
    expect(screen.getByText("Reporter versions")).toBeInTheDocument();
    expect(screen.getByText("1.2.2").parentElement).toHaveTextContent("1.2.2 3");
    expect(screen.getByText("2.1.299").parentElement).toHaveTextContent("2.1.299 2");
    expect(within(table).getByText("Active")).toBeInTheDocument();
    expect(within(table).getByText("Never reported")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByLabelText("By")).toBeNull();
  });

  it("says None when no version is in use, and draws a quiet person", async () => {
    const s = fakeServer({ unlocked: true });
    s.reports.people = {
      report: "people",
      from: FROM,
      to: TO,
      tz: "UTC",
      basedOn: "daily rollups",
      oldestDay: null,
      columns: [{ key: "person", label: "Person" }, { key: "state", label: "State" }],
      rows: [{ person: "Quinn", state: "quiet" }],
      total: null,
      summary: { people: 1, groups: 0, reporters: 0, reporterVersions: {}, engineVersions: {} },
    };
    await openPage("People and groups", s);
    expect(await screen.findByText("Quiet")).toBeInTheDocument();
    expect(screen.getAllByText("None")).toHaveLength(2);
  });
});

describe("Sessions and Failures", () => {
  it("breaks sessions down by outcome, model, effort or plan and asks for it", async () => {
    const s = await openPage("Sessions");
    await screen.findByRole("table", { name: "Sessions" });
    expect(reportCalls(s, "sessions")[0]).toContain("breakdown=outcome");
    const by = screen.getByLabelText("Break down by");
    expect([...(by as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Outcome", "Model", "Effort", "Plan"]);
    fireEvent.change(by, { target: { value: "plan" } });
    await waitFor(() => expect(reportCalls(s, "sessions").slice(-1)[0]).toContain("breakdown=plan"));
    const table = screen.getByRole("table", { name: "Sessions" });
    expect(within(table).getByText("12:34")).toBeInTheDocument();
    expect(within(table).getByText("91%")).toBeInTheDocument();
  });

  it("offers the models the period had as a filter", async () => {
    const s = await openPage("Sessions");
    await screen.findByRole("table", { name: "Sessions" });
    await waitFor(() => expect(s.calls.some((c) => c.includes("/reports/sessions?") && c.includes("breakdown=model") && c.includes("by=month"))).toBe(true));
    const model = screen.getByLabelText("Model") as HTMLSelectElement;
    await waitFor(() => expect([...model.options].map((o) => o.value)).toContain("ended"));
    fireEvent.change(model, { target: { value: "ended" } });
    await waitFor(() => expect(reportCalls(s, "sessions").slice(-1)[0]).toContain("model=ended"));
  });

  it("links a failure row to History for each stored session, and says older ones have counts only", async () => {
    const s = await openPage("Failures");
    const table = await screen.findByRole("table", { name: "Failures" });
    expect(reportCalls(s, "failures")[0]).toContain("breakdown=class");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Day", "Class", "Count", "People", "History"]);
    const links = within(table).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#/history?day=2026-10-19&page=1&size=50&open=s1", "#/history?day=2026-10-19&page=1&size=50&open=s2"]);
    expect(links[1]).toHaveAccessibleName("Open session 2 of 2 in History");
    expect(within(table).getByText("Older than 30 days")).toBeInTheDocument();
  });

  it("names a single session's link plainly, and uses the first of the month for a month bucket", async () => {
    const s = fakeServer({ unlocked: true });
    s.reports.failures = { report: "failures", from: FROM, to: TO, by: "month", tz: "UTC", basedOn: "daily rollups", oldestDay: null, columns: [{ key: "period", label: "Month" }, { key: "count", label: "Count" }], rows: [{ period: "2026-10", count: 2, sessionIds: ["a b"] }], total: null };
    await openPage("Failures", s);
    const link = await screen.findByRole("link", { name: "Open in History" });
    expect(link).toHaveAttribute("href", "#/history?day=2026-10-01&page=1&size=50&open=a%20b");
  });
});

describe("Admin activity", () => {
  it("lists the Admin log and filters it by kind of entry", async () => {
    const s = await openPage("Admin activity");
    const table = await screen.findByRole("table", { name: "Admin activity" });
    expect(screen.queryByLabelText("By")).toBeNull();
    expect(reportCalls(s, "activity")[0]).toBe(`GET /reports/activity?from=${FROM}&to=${TO}`);
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 2);
    const kind = screen.getByLabelText("Kind of entry") as HTMLSelectElement;
    await waitFor(() => expect([...kind.options].map((o) => o.value)).toEqual(["", "person_created", "unlock_failed"]));
    fireEvent.change(kind, { target: { value: "unlock_failed" } });
    await waitFor(() => expect(reportCalls(s, "activity").slice(-1)[0]).toContain("kind=unlock_failed"));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Admin activity" })).getAllByRole("row")).toHaveLength(1 + 1));
    expect([...kind.options].map((o) => o.value)).toEqual(["", "person_created", "unlock_failed"]);
  });

  it("keeps a remembered kind selectable before the kinds are known", async () => {
    localStorage.setItem(REPORTING_KEY, JSON.stringify({ activity: { kind: "rotated" } }));
    const s = fakeServer({ unlocked: true });
    await openPage("Admin activity", s);
    const kind = (await screen.findByLabelText("Kind of entry")) as HTMLSelectElement;
    expect(kind.value).toBe("rotated");
  });
});

describe("Data kept", () => {
  it("lists each rollup table with its oldest day and how long it is kept, then the detail rows", async () => {
    await openPage("Data kept");
    const rollups = await screen.findByRole("table", { name: "Daily rollups" });
    expect(within(rollups).getByText("Usage").closest("tr")).toHaveTextContent("2,418");
    expect(within(rollups).getByText("2026-03-02")).toBeInTheDocument();
    expect(within(rollups).getByText("395 days")).toBeInTheDocument();
    expect(screen.getByText(/It holds no prompts, answers, tool input or paths\./)).toBeInTheDocument();
    const detail = screen.getByRole("table", { name: "Detail rows" });
    expect(within(detail).getByText("24 hours")).toBeInTheDocument();
    expect(within(detail).getByText("90 days")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
  });

  it("says when nothing has been rolled up, and what failed", async () => {
    const s = fakeServer({ unlocked: true });
    s.retention = { tables: [], detail: [{ name: "Events", keptDays: 1 }, { name: "Odd", keptDays: 0.01 }, { name: "Short", keptDays: 0.5 }] };
    await openPage("Data kept", s);
    expect(await screen.findByText("No daily rollups have been written yet.")).toBeInTheDocument();
    expect(screen.getByText("24 hours")).toBeInTheDocument();
    expect(screen.getByText("1 hour")).toBeInTheDocument();
    expect(screen.getByText("12 hours")).toBeInTheDocument();
    cleanup();
    const bad = fakeServer({ unlocked: true });
    bad.reportStatus = 500;
    await openPage("Data kept", bad);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load what Podium keeps.");
  });

  it("shows a rollup table with no rows yet as a dash", async () => {
    const s = fakeServer({ unlocked: true });
    s.retention = { tables: [{ name: "Fleet", rows: 0, oldestDay: null, keptDays: 1 }], detail: [] };
    await openPage("Data kept", s);
    expect(await screen.findByText("24 hours")).toBeInTheDocument();
    expect(screen.getAllByText("–").length).toBeGreaterThan(0);
  });
});

describe("Security", () => {
  it("is what the old Reporting and security page is called, with its content unchanged", async () => {
    await openPage("Security");
    expect(await screen.findByRole("heading", { level: 1, name: "Security" })).toBeInTheDocument();
    expect(screen.getByText("Allow reporters to use the admin secret")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reporting and security" })).toBeNull();
  });
});
