// Defects an independent verifier found in the Data and Stored activity pages (#432): bad filters that still delete, focus after
// Cancel and Escape, sizes, singular units, stale totals, empty-state wording, and the local day.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminView } from "./AdminView";
import { dayOf, fmtBytes } from "./activityFormat";
import { policyText } from "./DataPage";
import { fakeServer } from "./fakeAdmin";
import { fmtDay } from "../format";

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Server = ReturnType<typeof fakeServer>;
const ROWS = [
  { sessionId: "s1", name: "api-refactor", project: "podium", owner: "Maya Okafor", live: true, entries: 2310, bytes: 1_258_291, oldestAt: Date.UTC(2026, 9, 9, 12) },
  { sessionId: "s2", name: "docs-sweep", project: "docs-site", owner: "Jonas Weber", live: false, entries: 1186, bytes: 629_145, oldestAt: Date.UTC(2026, 9, 12, 12) },
];
function kept(entries = 1000, settings: Server["activity"]["settings"] = { policy: "after", n: 30, unit: "days", capGb: null }) {
  const s = fakeServer({ unlocked: true });
  s.activity = { settings, totals: { entries, bytes: 430_000, sessions: 5, fileBytes: 2_500_000 }, lastPurge: null, authOn: true };
  return s;
}
const nav = () => screen.getByRole("navigation", { name: "Admin sections" });
async function openData() {
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("button", { name: "Data" }));
  await screen.findByRole("form", { name: "Activity history retention" });
}
async function openStored() {
  render(<AdminView />);
  await screen.findByRole("navigation", { name: "Admin sections" });
  fireEvent.click(within(nav()).getByRole("button", { name: /^Stored activity/ }));
  await screen.findByRole("heading", { level: 2, name: "What is stored" });
}
const table = () => screen.findByRole("table", { name: "Stored activity by session" });

describe("a filter with a problem cannot delete (#432)", () => {
  it("disables Delete all that match for a bad date, and enables it again once the date is fixed", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await table();
    fireEvent.change(screen.getByLabelText("Session"), { target: { value: "api" } });
    fireEvent.change(screen.getByLabelText("Entries from"), { target: { value: "2026-13-45" } });
    expect(await screen.findByText("Write the dates as 2026-10-01.")).toBeInTheDocument();
    await waitFor(() => expect(s.calls[s.calls.length - 1]).toContain("q=api"));
    expect(screen.getByRole("button", { name: /^Delete all \d+ that match…$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete everything…" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Entries from"), { target: { value: "2026-10-01" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Delete all \d+ that match…$/ })).toBeEnabled());
  });

  it("says a Custom days value that is not a number, and disables Delete all that match", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await table();
    fireEvent.change(screen.getByLabelText("Older than"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "abc" } });
    expect(await screen.findByText("Write the days as a whole number, like 14.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Delete all \d+ that match…$/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "14" } });
    expect(screen.queryByText("Write the days as a whole number, like 14.")).toBeNull();
  });

  it("still lets a ticked session be deleted while a filter has a problem", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await table();
    fireEvent.change(screen.getByLabelText("Entries from"), { target: { value: "nope" } });
    fireEvent.click(screen.getByLabelText("Select docs-sweep"));
    expect(screen.getByRole("button", { name: "Delete 1…" })).toBeEnabled();
  });
});

describe("Cancel and Escape (#432)", () => {
  it("returns focus to Save when a save confirmation is cancelled or closed with Escape", async () => {
    const s = kept(1000);
    s.preview = { entries: 400, bytes: 2048, sessions: 3, stopsCapturing: false };
    await openData();
    fireEvent.change(screen.getByLabelText("Number"), { target: { value: "7" } });
    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(saveBtn));
    fireEvent.click(saveBtn);
    fireEvent.keyDown(await screen.findByRole("alert"), { key: "Escape" });
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(saveBtn));
  });

  it("returns focus to Save after a confirmed save too", async () => {
    const s = kept(1000);
    s.preview = { entries: 400, bytes: 2048, sessions: 3, stopsCapturing: false };
    await openData();
    fireEvent.change(screen.getByLabelText("Number"), { target: { value: "7" } });
    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Save and remove 400 entries" }));
    await screen.findByText(/^Saved\. .* go at the next purge/);
    await waitFor(() => expect(document.activeElement).toBe(saveBtn));
  });

  it("closes the Stored activity confirmation on Escape and returns focus to the button that opened it", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await table();
    const opener = screen.getByRole("button", { name: "Delete everything…" });
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("alert"), { key: "Escape" });
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(s.storedDeleteBodies).toEqual([]);
  });
});

describe("sizes (#432)", () => {
  it("shows the file's size under on disk, and the entries' size where a delete says how much goes", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    s.storedDeleteResult = { entries: 3496, sessions: 2, bytes: 1_887_436, freed: 3_145_728 };
    await openStored();
    await table();
    // entries are 1,887,436 bytes (1.8 MB); the file is that plus 1 MiB.
    expect(screen.getByText("on disk").previousElementSibling).toHaveTextContent(fmtBytes(1_887_436 + 1_048_576));
    fireEvent.click(screen.getByRole("button", { name: "Delete everything…" }));
    expect(screen.getByRole("alert")).toHaveTextContent("3,496 entries, about 1.8 MB");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Delete 3,496 entries" }));
    expect(await screen.findByText("Deleted 3,496 entries (about 1.8 MB). 3.0 MB freed on disk and the file compacted. Written to the Admin log.")).toBeInTheDocument();
  });

  it("says about on what a save will remove", async () => {
    const s = kept(1000);
    s.preview = { entries: 400, bytes: 2048, sessions: 3, stopsCapturing: false };
    await openData();
    fireEvent.change(screen.getByLabelText("Number"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("400 entries (about 2 KB)");
  });
});

describe("singular units (#432)", () => {
  it("writes 1 hour, 1 day, 1 week and 1 month in the singular", () => {
    const row = (unit: "hours" | "days" | "weeks" | "months", n: number) => policyText({ policy: "after", n, unit, capGb: null });
    expect([row("hours", 1), row("days", 1), row("weeks", 1), row("months", 1), row("hours", 2)]).toEqual(["Purge after 1 hour", "Purge after 1 day", "Purge after 1 week", "Purge after 1 month", "Purge after 2 hours"]);
  });

  it("writes the policy line on Stored activity the same way", async () => {
    const s = kept(4338, { policy: "after", n: 1, unit: "hours", capGb: null });
    s.stored = ROWS;
    await openStored();
    expect(await screen.findByText(/Policy: purge after 1 hour\./)).toBeInTheDocument();
  });
});

describe("totals stay fresh (#432)", () => {
  it("asks again every 30 seconds on the Data page, and updates the totals, the last purge and the badge", async () => {
    const s = kept(1000);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await openData();
    expect(screen.getByText("1,000 entries, 420 KB")).toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: /^Stored activity/ })).toHaveTextContent("Stored activity5");
    s.activity = { ...s.activity, totals: { entries: 83_977, bytes: 430_000, sessions: 2, fileBytes: 1 }, lastPurge: { at: Date.UTC(2026, 9, 20, 11, 2), entries: 5, bytes: 2048 } };
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(await screen.findByText("83,977 entries, 420 KB")).toBeInTheDocument();
    expect(screen.getByText(/removed 5 entries \(about 2 KB\)/)).toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: /^Stored activity/ })).toHaveTextContent("Stored activity2");
    // the form is still there, not replaced by a loading state
    expect(screen.getByRole("form", { name: "Activity history retention" })).toBeInTheDocument();
  });

  it("asks again every 30 seconds on Stored activity, keeping the rows on screen meanwhile", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await openStored();
    await table();
    s.stored = ROWS.slice(0, 1);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await waitFor(() => expect(screen.queryByText("docs-sweep")).toBeNull());
    expect(screen.getByText("api-refactor")).toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: /^Stored activity/ })).toHaveTextContent("Stored activity1");
  });

  it("stops asking when the page is left", async () => {
    const s = kept(1000);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await openData();
    fireEvent.click(within(nav()).getByRole("button", { name: "Settings" }));
    const before = s.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(90_000);
    });
    expect(s.calls.slice(before).filter((c) => c.includes("/reports/retention") || c.includes("/stored-activity"))).toEqual([]);
  });
});

describe("wording (#432)", () => {
  it("says nothing has been captured yet, not to choose a policy, when a keep policy is on", async () => {
    kept(0, { policy: "all", n: 30, unit: "days", capGb: null });
    await openStored();
    expect(await screen.findByText(/Policy: keep everything\./)).toBeInTheDocument();
    expect(await screen.findByText("Nothing has been captured yet. Activity appears here once a session runs under this policy.")).toBeInTheDocument();
    expect(screen.queryByText(/Choose a keep policy/)).toBeNull();
  });

  it("still says to choose a keep policy under Not stored", async () => {
    kept(0, { policy: "default", n: 30, unit: "days", capGb: null });
    await openStored();
    expect(await screen.findByText("Nothing is stored. Choose a keep policy on Data and Podium starts keeping activity.")).toBeInTheDocument();
  });

  it("says the first four periods are set on the server, with the four variables", async () => {
    kept(1000);
    await openData();
    const note = screen.getByText(/RETAIN_SAMPLES_MS/).closest(".note-line")!;
    expect(note).toHaveTextContent("The first four periods are set with environment variables on the server (RETAIN_SAMPLES_MS, RETAIN_EVENTS_MS, RETAIN_SESSIONS_MS, RETAIN_ADMIN_LOG_MS) and cannot be changed here. Activity history is set below.");
  });
});

describe("the local day (#432)", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it("writes the same day as the Activity window footer, near midnight in another time zone", () => {
    process.env.TZ = "America/Los_Angeles";
    const t = Date.UTC(2026, 9, 10, 3, 0);
    expect(dayOf(t)).toBe("2026-10-09");
    expect(dayOf(t)).toBe(fmtDay(t));
  });

  it("shows that local day as the Oldest entry", async () => {
    process.env.TZ = "America/Los_Angeles";
    const s = kept(10);
    s.stored = [{ ...ROWS[0]!, oldestAt: Date.UTC(2026, 9, 10, 3, 0) }];
    await openStored();
    expect((await table()).querySelector("tbody tr")).toHaveTextContent("2026-10-09");
  });
});
