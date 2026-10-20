// The pure parts of Admin > Reporting (#484): the period, what the page remembers, and the text of a cell.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminError } from "./adminApi";
import {
  REPORTING_KEY,
  chartPoints,
  fmtMoney,
  formatCell,
  isNumericColumn,
  makeReportsClient,
  periodRange,
  rangeProblem,
  readProjectionPrefs,
  readReportPrefs,
  reportErrorText,
  saveFile,
  writeProjectionPrefs,
  writeReportPrefs,
  ymd,
} from "./reportsApi";

// 2026-10-20 is a Tuesday; the 400-day cap and "this month" all hang off it.
const NOW = new Date(2026, 9, 20, 15, 30);

describe("periodRange", () => {
  it("counts the last N days with today as the last one", () => {
    expect(periodRange("7d", { from: "", to: "" }, NOW)).toEqual({ from: "2026-10-14", to: "2026-10-20" });
    expect(periodRange("30d", { from: "", to: "" }, NOW)).toEqual({ from: "2026-09-21", to: "2026-10-20" });
    expect(periodRange("90d", { from: "", to: "" }, NOW)).toEqual({ from: "2026-07-23", to: "2026-10-20" });
  });
  it("gives this month so far and the whole of last month", () => {
    expect(periodRange("month", { from: "", to: "" }, NOW)).toEqual({ from: "2026-10-01", to: "2026-10-20" });
    expect(periodRange("last-month", { from: "", to: "" }, NOW)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(periodRange("last-month", { from: "", to: "" }, new Date(2026, 0, 5))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("uses the dates typed for Custom", () => {
    expect(periodRange("custom", { from: "2026-01-01", to: "2026-02-01" }, NOW)).toEqual({ from: "2026-01-01", to: "2026-02-01" });
  });
});

describe("rangeProblem", () => {
  it("accepts a range of at most 400 days that ends today or before", () => {
    expect(rangeProblem("2025-09-16", "2026-10-20", NOW)).toBeNull();
    expect(rangeProblem("2026-10-20", "2026-10-20", NOW)).toBeNull();
  });
  it("says what to fix", () => {
    expect(rangeProblem("", "2026-10-20", NOW)).toMatch(/Enter From and To as dates/);
    expect(rangeProblem("2026-02-30", "2026-03-01", NOW)).toMatch(/Enter From and To as dates/);
    expect(rangeProblem("2026-10-20", "2026-10-01", NOW)).toBe("From must be on or before To.");
    expect(rangeProblem("2025-09-15", "2026-10-20", NOW)).toMatch(/at most 400 days/);
    expect(rangeProblem("2026-10-01", "2026-10-21", NOW)).toBe("To cannot be after today.");
  });
});

describe("what the page remembers", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("defaults to Last 30 days by day, and replaces anything unreadable", () => {
    expect(readReportPrefs("usage")).toMatchObject({ period: "30d", by: "day", pageSize: 25, breakdown: "" });
    localStorage.setItem(REPORTING_KEY, "{not json");
    expect(readReportPrefs("usage").period).toBe("30d");
    localStorage.setItem(REPORTING_KEY, JSON.stringify({ usage: { period: "century", by: "hour", pageSize: 7, person: 4 } }));
    expect(readReportPrefs("usage")).toMatchObject({ period: "30d", by: "day", pageSize: 25, person: "" });
    localStorage.setItem(REPORTING_KEY, JSON.stringify([1]));
    expect(readReportPrefs("usage").period).toBe("30d");
  });

  it("keeps each report's choice apart in one key", () => {
    writeReportPrefs("usage", { ...readReportPrefs("usage"), period: "7d", by: "week" });
    writeReportPrefs("spend", { ...readReportPrefs("spend", "none"), group: "Platform" });
    expect(readReportPrefs("usage")).toMatchObject({ period: "7d", by: "week" });
    expect(readReportPrefs("spend", "none")).toMatchObject({ group: "Platform", breakdown: "none", period: "30d" });
  });

  it("reads and writes the projection choices, with defaults", () => {
    expect(readProjectionPrefs()).toEqual({ horizon: "month", window: 14, by: "person", pageSize: 25 });
    writeProjectionPrefs({ horizon: "30d", window: 30, by: "group", pageSize: 50 });
    expect(readProjectionPrefs()).toEqual({ horizon: "30d", window: 30, by: "group", pageSize: 50 });
    localStorage.setItem(REPORTING_KEY, JSON.stringify({ projection: { window: 3 } }));
    expect(readProjectionPrefs().window).toBe(14);
    writeProjectionPrefs({ ...readProjectionPrefs(), window: 7 });
    expect(readProjectionPrefs().window).toBe(7);
  });

  it("works when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readReportPrefs("usage").period).toBe("30d");
    expect(() => writeReportPrefs("usage", readReportPrefs("usage"))).not.toThrow();
  });
});

describe("formatCell", () => {
  const col = (key: string, unit?: string) => ({ key, label: key, unit });
  it("draws an unknown figure as a dash, never zero", () => {
    expect(formatCell(col("costUsd", "usd"), null)).toBe("–");
    expect(formatCell(col("costUsd"), undefined)).toBe("–");
    expect(formatCell(col("n"), Number.NaN)).toBe("–");
    expect(fmtMoney(null)).toBe("–");
    expect(fmtMoney(0)).toBe("$0.00");
  });
  it("formats money, tokens, durations, percentages and counts by unit, or by key when the unit is unknown", () => {
    expect(formatCell(col("costUsd", "usd"), 1134.8)).toBe("$1,134.80");
    expect(formatCell(col("costUsd", "weird"), 12)).toBe("$12.00");
    expect(formatCell(col("tokIn", "tokens"), 41_200_000)).toBe("41.20M");
    expect(formatCell(col("tokOut"), 1500)).toBe("1.5k");
    expect(formatCell(col("avgDurationS", "seconds"), 754)).toBe("12:34");
    expect(formatCell(col("maxDurationS"), 125)).toBe("2:05");
    expect(formatCell(col("maxContextPct", "percent"), 91.4)).toBe("91%");
    expect(formatCell(col("sessions", "count"), 12345)).toBe("12,345");
    expect(formatCell(col("sessions"), 3)).toBe("3");
  });
  it("draws times, words and booleans", () => {
    expect(formatCell(col("t", "time"), Date.UTC(2026, 9, 20, 12))).toMatch(/2026/);
    expect(formatCell(col("lastReportAt"), Date.UTC(2026, 9, 20, 12))).toMatch(/2026/);
    expect(formatCell(col("kind", "text"), "unlock_failed")).toBe("unlock_failed");
    expect(formatCell(col("on"), true)).toBe("Yes");
    expect(formatCell(col("on"), false)).toBe("No");
  });
  it("lines numbers up on the right, and a column of unknown money too", () => {
    expect(isNumericColumn(col("sessions"), 3)).toBe(true);
    expect(isNumericColumn(col("costUsd", "usd"), undefined)).toBe(true);
    expect(isNumericColumn(col("costUsd", "usd"), null)).toBe(true);
    expect(isNumericColumn(col("kind", "text"), "x")).toBe(false);
    expect(isNumericColumn(col("t", "time"), 5)).toBe(false);
    expect(isNumericColumn(col("kind"), undefined)).toBe(false);
  });
});

describe("chartPoints", () => {
  it("sums a break-down per period, in order, and leaves a period with nothing known as a gap", () => {
    const rows = [
      { period: "2026-10-12", key: "a", costUsd: 2 },
      { period: "2026-10-05", key: "a", costUsd: null },
      { period: "2026-10-12", key: "b", costUsd: 3 },
      { period: "2026-10-12", key: "c", costUsd: null },
      { key: "no period", costUsd: 9 },
    ];
    expect(chartPoints(rows, "costUsd")).toEqual([
      { period: "2026-10-05", value: null },
      { period: "2026-10-12", value: 5 },
    ]);
  });
});

describe("the client and the download", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads a report as text with the Admin header, and says a refusal by status", async () => {
    const fetchFn = vi.fn((_u: string, _i?: RequestInit) => Promise.resolve(new Response("a,b\n", { status: 200 })));
    vi.stubGlobal("fetch", fetchFn);
    const client = makeReportsClient("/api/admin", vi.fn());
    await expect(client.text("/reports/usage?format=csv")).resolves.toBe("a,b\n");
    expect(fetchFn.mock.calls[0]![0]).toBe("/api/admin/reports/usage?format=csv");
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ credentials: "same-origin", headers: { "X-Podium-Admin": "1" } });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("", { status: 401 }))));
    await expect(client.text("/reports/usage")).rejects.toMatchObject({ status: 401 });
  });

  it("reads JSON through the Admin api", async () => {
    const api = vi.fn().mockResolvedValue({ ok: 1 });
    await expect(makeReportsClient("/api/admin", api).get("/reports/usage")).resolves.toEqual({ ok: 1 });
    expect(api).toHaveBeenCalledWith("GET", "/reports/usage");
  });

  it("says what went wrong without a status code", () => {
    expect(reportErrorText(new AdminError(400, "bad"))).toMatch(/did not accept that period or filter/);
    expect(reportErrorText(new AdminError(500, "HTTP 500"), "the projection")).toBe("Could not load the projection. Check that the server is running, then try again.");
    expect(reportErrorText(new Error("x"))).not.toMatch(/HTTP|\d{3}/);
  });

  it("saves a file by a temporary link and revokes its address", () => {
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    saveFile("a.csv", "text/csv", "x");
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:x");
    expect(document.querySelector("a[download]")).toBeNull();
    click.mockRestore();
  });

  it("formats a date the way the server reads one", () => {
    expect(ymd(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
