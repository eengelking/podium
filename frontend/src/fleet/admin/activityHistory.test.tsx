// Admin > Server > Data and Stored activity (#432, mockup/podium-activity-history.html): the menu, the policy form and each of its
// confirmations, the two pages' links to each other, and bulk delete by ids, by filter and of everything.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeServer } from "./fakeAdmin";
import { fmtBytes } from "./activityFormat";
import { filterOf } from "./StoredActivityTab";
import { parseDraft, policyText } from "./DataPage";

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
});

type Server = ReturnType<typeof fakeServer>;
const ROWS = [
  { sessionId: "s1", name: "api-refactor", project: "podium", owner: "Maya Okafor", live: true, entries: 2310, bytes: 1_258_291, oldestAt: Date.UTC(2026, 9, 9, 12) },
  { sessionId: "s2", name: "docs-sweep", project: "docs-site", owner: "Jonas Weber", live: false, entries: 1186, bytes: 629_145, oldestAt: Date.UTC(2026, 9, 12, 12) },
  { sessionId: "s3", name: "flaky-tests", project: "podium", owner: null, live: false, entries: 842, bytes: 419_430, oldestAt: Date.UTC(2026, 9, 14, 12) },
];
const POLICY_AFTER = { policy: "after", n: 30, unit: "days", capGb: null } as const;

/** A server that keeps history after 30 days with `entries` stored. */
function kept(entries = 1000, extra: Partial<Server["activity"]> = {}) {
  const s = fakeServer({ unlocked: true });
  s.activity = { settings: { ...POLICY_AFTER }, totals: { entries, bytes: 430_000, sessions: 5, fileBytes: 430_000 }, lastPurge: null, authOn: true, ...extra };
  return s;
}
async function openPage(name: string | RegExp) {
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("button", { name }));
}
const openData = async () => {
  await openPage("Data");
  await screen.findByRole("form", { name: "Activity history retention" });
};
const navStored = () => within(screen.getByRole("navigation", { name: "Admin sections" })).getByRole("button", { name: /^Stored activity/ });
const openStored = async () => {
  render(<AdminView />);
  await screen.findByRole("navigation", { name: "Admin sections" });
  fireEvent.click(navStored());
  await screen.findByRole("heading", { level: 2, name: "What is stored" });
};
const policy = () => screen.getByRole("combobox", { name: "Keep activity history" }) as HTMLSelectElement;
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));
const putBodies = (s: Server) => s.bodies.filter((b) => (b as { activityHistory?: unknown }).activityHistory);

describe("the menu", () => {
  it("puts Data and Stored activity in the Server group and leaves Reporting with six", async () => {
    fakeServer({ unlocked: true });
    render(<AdminView />);
    const server = await screen.findByRole("group", { name: "Server" });
    expect(within(server).getAllByRole("button").map((b) => b.textContent)).toEqual(["Settings", "Model prices", "Security", "Data", "Stored activity"]);
    expect(within(screen.getByRole("group", { name: "Reporting" })).getAllByRole("button")).toHaveLength(6);
    expect(screen.queryByRole("button", { name: "Data kept" })).toBeNull();
  });

  it("shows one header on Data, with the mockup's lead, and one on Stored activity", async () => {
    fakeServer({ unlocked: true });
    await openPage("Data");
    expect(await screen.findByRole("heading", { level: 1, name: "Data" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("What Podium stores, for how long, and what you can remove. Reports read this, never the live stream alone.")).toBeInTheDocument();
    fireEvent.click(navStored());
    expect(await screen.findByRole("heading", { level: 1, name: "Stored activity" })).toBeInTheDocument();
    expect(screen.getByText("The Activity history Podium has kept, by session. Delete what you no longer need, in bulk.")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("counts the stored sessions on the Stored activity button once either page has loaded", async () => {
    const s = kept(1000);
    s.stored = ROWS;
    render(<AdminView />);
    fireEvent.click(await screen.findByRole("button", { name: "Data" }));
    await screen.findByRole("form", { name: "Activity history retention" });
    expect(navStored()).toHaveTextContent("Stored activity5");
    fireEvent.click(navStored());
    await screen.findByRole("table", { name: "Stored activity by session" });
    expect(navStored()).toHaveTextContent("Stored activity3");
  });
});

describe("Data, the Activity history section", () => {
  it("lists Activity history under Detail rows, with the note that the other periods are set on the server", async () => {
    kept(1000, { settings: { policy: "after", n: 7, unit: "weeks", capGb: 2 } });
    await openData();
    const detail = screen.getByRole("table", { name: "Detail rows" });
    expect(within(detail).getByText("Activity history").closest("tr")).toHaveTextContent("Purge after 7 weeks, capped at 2 GB");
    expect(screen.getByText(/RETAIN_SAMPLES_MS/).closest(".note-line")).toHaveTextContent("cannot be changed here. Activity history is set below.");
    expect(screen.getByRole("heading", { level: 2, name: "Activity history" })).toBeInTheDocument();
  });

  it("says what is stored now, the last purge, and links to Stored activity", async () => {
    kept(18_402, { totals: { entries: 18_402, bytes: 8_283_750, sessions: 52, fileBytes: 8_283_750 }, lastPurge: { at: Date.UTC(2026, 9, 20, 11, 2), entries: 214, bytes: 98_304 } });
    await openData();
    expect(screen.getByText("18,402 entries, 7.9 MB")).toBeInTheDocument();
    expect(screen.getByText(/stored now, in 52 sessions\./)).toBeInTheDocument();
    expect(screen.getByText(/removed 214 entries \(about 96 KB\)\./)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("form", { name: "Activity history retention" })).getByRole("button", { name: "Stored activity" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Stored activity" })).toBeInTheDocument();
  });

  it("says no purge has run, and one session in the singular", async () => {
    kept(1, { totals: { entries: 1, bytes: 100, sessions: 1, fileBytes: 100 } });
    await openData();
    expect(screen.getByText(/None since the server started\./)).toBeInTheDocument();
    expect(screen.getByText(/stored now, in 1 session\./)).toBeInTheDocument();
  });

  it("shows only the policy under the default, and the time, size cap and warning once a keep policy is chosen", async () => {
    const s = fakeServer({ unlocked: true });
    await openData();
    expect(s.activity.settings.policy).toBe("default");
    expect(policy().value).toBe("default");
    expect(screen.queryByLabelText("Number")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.change(policy(), { target: { value: "after" } });
    expect(screen.getByLabelText("Number")).toHaveValue("30");
    expect(screen.getByLabelText("Unit")).toHaveValue("days");
    expect(screen.getByLabelText("Size in gigabytes")).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("Podium will ask every reporter to send the activity of each running loop");
    fireEvent.change(policy(), { target: { value: "end" } });
    expect(screen.queryByLabelText("Number")).toBeNull();
    expect(screen.getByLabelText("Use a size cap")).toBeInTheDocument();
    expect(screen.getByRole("note")).toBeInTheDocument();
    fireEvent.change(policy(), { target: { value: "all" } });
    expect(screen.getByText(/the shorter of the two wins/)).toBeInTheDocument();
  });

  it("disables the keep choices and says a token is needed when the server runs without one", async () => {
    const s = fakeServer({ unlocked: true });
    s.activity = { ...s.activity, authOn: false };
    await openData();
    expect(screen.getByText(/A token is needed to keep history/)).toBeInTheDocument();
    expect(within(policy()).getByRole("option", { name: "Not stored (default)" })).toBeEnabled();
    for (const name of [/Purge after a set time/, /Purge when the session ends/, /Keep everything/]) expect(within(policy()).getByRole("option", { name })).toBeDisabled();
  });

  it("saves a first policy straight away when nothing is stored, with the exact body, and says it is in the Admin log", async () => {
    const s = fakeServer({ unlocked: true });
    await openData();
    fireEvent.change(policy(), { target: { value: "after" } });
    fireEvent.change(screen.getByLabelText("Number"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "hours" } });
    fireEvent.click(screen.getByLabelText("Use a size cap"));
    fireEvent.change(screen.getByLabelText("Size in gigabytes"), { target: { value: "5" } });
    save();
    expect(await screen.findByText("Saved. Written to the Admin log.")).toBeInTheDocument();
    expect(putBodies(s)).toEqual([{ activityHistory: { policy: "after", n: 14, unit: "hours", capGb: 5 } }]);
    expect(s.previewBodies).toEqual([]);
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Detail rows" })).getByText("Activity history").closest("tr")).toHaveTextContent("Purge after 14 hours, capped at 5 GB"));
  });

  it("sends a policy with no time or cap as the defaults for them", async () => {
    const s = fakeServer({ unlocked: true });
    await openData();
    fireEvent.change(policy(), { target: { value: "all" } });
    save();
    await screen.findByText("Saved. Written to the Admin log.");
    expect(putBodies(s)).toEqual([{ activityHistory: { policy: "all", n: 30, unit: "days", capGb: null } }]);
  });

  it("says nothing changed, and sends nothing, when Save is pressed on the saved policy", async () => {
    const s = kept(0);
    await openData();
    save();
    expect(await screen.findByText("Nothing changed.")).toBeInTheDocument();
    expect(putBodies(s)).toEqual([]);
  });

  it("restores the saved policy on Cancel", async () => {
    kept(0);
    await openData();
    fireEvent.change(screen.getByLabelText("Number"), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Number")).toHaveValue("30");
  });

  it("refuses a time or a cap that is not a whole number in range, without asking the server", async () => {
    const s = kept(0);
    await openData();
    fireEvent.change(screen.getByLabelText("Number"), { target: { value: "0" } });
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a whole number from 1 to 3650 for the time.");
    fireEvent.change(screen.getByLabelText("Number"), { target: { value: "5" } });
    fireEvent.click(screen.getByLabelText("Use a size cap"));
    fireEvent.change(screen.getByLabelText("Size in gigabytes"), { target: { value: "1.5" } });
    save();
    expect(await screen.findByText("Enter a whole number from 1 to 1000 for the size cap.")).toBeInTheDocument();
    expect(putBodies(s)).toEqual([]);
    expect(s.previewBodies).toEqual([]);
  });

  it("shows the server's reason when a save is refused", async () => {
    const s = kept(0);
    s.activityError = "capGb must be a whole number";
    await openData();
    fireEvent.change(screen.getByLabelText("Number"), { target: { value: "5" } });
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("capGb must be a whole number. Change it and try again.");
    expect(screen.queryByText(/^Saved\./)).toBeNull();
  });

  it("locks Admin when the session has ended while saving", async () => {
    const s = kept(0);
    await openData();
    fireEvent.change(screen.getByLabelText("Number"), { target: { value: "5" } });
    s.expire = true;
    save();
    expect(await screen.findByRole("button", { name: "Unlock Admin" })).toBeInTheDocument();
  });

  it("says why the setting could not be read", async () => {
    const s = fakeServer({ unlocked: true });
    s.settingsError = "disk full";
    await openPage("Data");
    expect(await screen.findByText("Could not load the Activity history setting. Check that the server is running, then try again.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Activity history retention" })).toBeNull();
  });

  describe("with entries stored", () => {
    it("asks first when a shorter time would remove entries, and saves and removes on confirm", async () => {
      const s = kept(1000);
      s.preview = { entries: 400, bytes: 2048, sessions: 3, stopsCapturing: false };
      await openData();
      fireEvent.change(screen.getByLabelText("Number"), { target: { value: "7" } });
      save();
      const box = await screen.findByRole("alert");
      expect(box).toHaveTextContent("Saving removes entries that are already stored");
      expect(box).toHaveTextContent("400 entries (about 2 KB)");
      expect(box).toHaveTextContent("3 sessions");
      expect(s.previewBodies).toEqual([{ settings: { policy: "after", n: 7, unit: "days", capGb: null } }]);
      expect(putBodies(s)).toEqual([]);
      fireEvent.click(within(box).getByRole("button", { name: "Save and remove 400 entries" }));
      expect(await screen.findByText("Saved. Removed 400 entries (about 2 KB). Written to the Admin log.")).toBeInTheDocument();
      expect(putBodies(s)).toEqual([{ activityHistory: { policy: "after", n: 7, unit: "days", capGb: null } }]);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("saves nothing when the confirmation is cancelled", async () => {
      const s = kept(1000);
      s.preview = { entries: 400, bytes: 2048, sessions: 1, stopsCapturing: false };
      await openData();
      fireEvent.change(screen.getByLabelText("Number"), { target: { value: "7" } });
      save();
      const box = await screen.findByRole("alert");
      expect(box).toHaveTextContent("from 1 session.");
      fireEvent.click(within(box).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(putBodies(s)).toEqual([]);
    });

    it("saves without asking when the preview says nothing is removed", async () => {
      const s = kept(1000);
      await openData();
      fireEvent.change(screen.getByLabelText("Number"), { target: { value: "90" } });
      save();
      expect(await screen.findByText("Saved. Written to the Admin log.")).toBeInTheDocument();
      expect(s.previewBodies).toHaveLength(1);
      expect(putBodies(s)).toHaveLength(1);
    });

    it("offers to stop and delete when the policy goes back to not stored, and deletes everything after saving", async () => {
      const s = kept(1000);
      s.preview = { entries: 1000, bytes: 430_000, sessions: 5, stopsCapturing: true };
      s.storedDeleteResult = { entries: 1000, sessions: 5, bytes: 430_000, freed: 400_000 };
      await openData();
      fireEvent.change(policy(), { target: { value: "default" } });
      save();
      const box = await screen.findByRole("alert");
      expect(box).toHaveTextContent("Stop keeping Activity history?");
      expect(box).toHaveTextContent("Podium stops capturing now. 1,000 entries (about 420 KB) are still stored.");
      expect(s.previewBodies).toEqual([{ settings: { policy: "default", n: 30, unit: "days", capGb: null } }]);
      fireEvent.click(within(box).getByRole("button", { name: "Stop and delete 1,000 entries" }));
      expect(await screen.findByText("Saved. Stopped capturing and removed 1,000 entries (about 420 KB). Written to the Admin log.")).toBeInTheDocument();
      expect(putBodies(s)).toEqual([{ activityHistory: { policy: "default", n: 30, unit: "days", capGb: null } }]);
      expect(s.storedDeleteBodies).toEqual([{ all: true }]);
      expect(s.calls.findIndex((c) => c.startsWith("PUT /settings"))).toBeLessThan(s.calls.findIndex((c) => c.startsWith("POST /stored-activity/delete")));
    });

    it("stops and keeps what is stored, with no delete", async () => {
      const s = kept(1000);
      s.preview = { entries: 1000, bytes: 430_000, sessions: 5, stopsCapturing: true };
      await openData();
      fireEvent.change(policy(), { target: { value: "default" } });
      save();
      fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Stop, keep what is stored" }));
      expect(await screen.findByText("Saved. Stopped capturing. 1,000 entries are still stored, and Stored activity can delete them. Written to the Admin log.")).toBeInTheDocument();
      expect(putBodies(s)).toHaveLength(1);
      expect(s.storedDeleteBodies).toEqual([]);
    });

    it("cancels a stop", async () => {
      const s = kept(1000);
      s.preview = { entries: 1000, bytes: 430_000, sessions: 5, stopsCapturing: true };
      await openData();
      fireEvent.change(policy(), { target: { value: "default" } });
      save();
      fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(putBodies(s)).toEqual([]);
      expect(policy().value).toBe("default");
    });

    it("drops the confirmation when the form changes, and shows an error if the preview fails", async () => {
      const s = kept(1000);
      s.preview = { entries: 400, bytes: 2048, sessions: 3, stopsCapturing: false };
      await openData();
      fireEvent.change(screen.getByLabelText("Number"), { target: { value: "7" } });
      save();
      await screen.findByRole("alert");
      fireEvent.change(screen.getByLabelText("Number"), { target: { value: "8" } });
      expect(screen.queryByRole("alert")).toBeNull();
      s.previewError = "no preview";
      save();
      expect(await screen.findByRole("alert")).toHaveTextContent("no preview. Change it and try again.");
    });

    it("locks Admin when the session has ended while previewing", async () => {
      const s = kept(1000);
      await openData();
      fireEvent.change(screen.getByLabelText("Number"), { target: { value: "7" } });
      s.expire = true;
      save();
      expect(await screen.findByRole("button", { name: "Unlock Admin" })).toBeInTheDocument();
    });
  });
});

describe("Stored activity", () => {
  it("says nothing is stored, and points to Data", async () => {
    fakeServer({ unlocked: true });
    await openStored();
    expect(await screen.findByText("Nothing is stored. Choose a keep policy on Data and Podium starts keeping activity.")).toBeInTheDocument();
    expect(screen.getByText("None selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete everything…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete selected…" })).toBeDisabled();
    expect(screen.queryByRole("table", { name: "Stored activity by session" })).toBeNull();
  });

  it("shows the totals, the sessions with their state, and the policy with a link back to Data", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    const table = await screen.findByRole("table", { name: "Stored activity by session" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["", "Session", "Owner", "State", "Entries", "Size", "Oldest entry"]);
    const live = within(table).getByText("api-refactor").closest("tr")!;
    expect(live).toHaveTextContent("podium");
    expect(live).toHaveTextContent("Maya Okafor");
    expect(live).toHaveTextContent("Live");
    expect(live).toHaveTextContent("2,310");
    expect(live).toHaveTextContent("1.2 MB");
    expect(live).toHaveTextContent("2026-10-09");
    expect(within(table).getByText("docs-sweep").closest("tr")).toHaveTextContent("Ended");
    expect(within(table).getByText("flaky-tests").closest("tr")).toHaveTextContent("–");
    expect(screen.getByText("entries stored").previousElementSibling).toHaveTextContent("4,338");
    expect(screen.getByText("on disk").previousElementSibling).toHaveTextContent("3.2 MB");
    expect(screen.getByText("sessions").previousElementSibling).toHaveTextContent("3");
    expect(screen.getByText("match the filter").previousElementSibling).toHaveTextContent("3");
    expect(screen.getByText("Showing 1 to 3 of 3")).toBeInTheDocument();
    expect(await screen.findByText(/Policy: purge after 30 days\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change it" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Data" })).toBeInTheDocument();
  });

  it("words each policy on the line under the heading", async () => {
    for (const [settings, words] of [
      [{ policy: "end", n: 30, unit: "days", capGb: null }, "purge when the session ends"],
      [{ policy: "all", n: 30, unit: "days", capGb: null }, "keep everything"],
      [{ policy: "default", n: 30, unit: "days", capGb: null }, "not stored"],
    ] as const) {
      const s = kept(0, { settings });
      s.stored = ROWS;
      await openStored();
      expect(await screen.findByText(new RegExp(`Policy: ${words}\\.`))).toBeInTheDocument();
      cleanup();
    }
  });

  it("ticks sessions, counts them, and deletes them by id after a confirmation that names the live one", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    fireEvent.click(screen.getByLabelText("Select api-refactor"));
    fireEvent.click(screen.getByLabelText("Select docs-sweep"));
    expect(screen.getByText("2 selected, 3,496 entries, 1.8 MB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete 2…" }));
    const box = screen.getByRole("alert");
    expect(box).toHaveTextContent("Delete the stored activity of 2 sessions?");
    expect(box).toHaveTextContent("3,496 entries, about 1.8 MB");
    expect(box).toHaveTextContent("A session that is still running keeps being captured while the policy keeps history.");
    expect(s.storedDeleteBodies).toEqual([]);
    fireEvent.click(within(box).getByRole("button", { name: "Delete 3,496 entries" }));
    expect(await screen.findByText("Deleted 3,496 entries (about 1.8 MB). 1.0 MB freed on disk and the file compacted. Written to the Admin log.")).toBeInTheDocument();
    expect(s.storedDeleteBodies).toEqual([{ ids: ["s1", "s2"] }]);
    await waitFor(() => expect(screen.queryByText("api-refactor")).toBeNull());
    expect(screen.getByText("None selected")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not mention a running session when none of the ticked ones is live, says 1 session, and keeps them on Keep them", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    fireEvent.click(screen.getByLabelText("Select docs-sweep"));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1…" }));
    const box = screen.getByRole("alert");
    expect(box).toHaveTextContent("Delete the stored activity of 1 session?");
    expect(box).not.toHaveTextContent("still running");
    fireEvent.click(within(box).getByRole("button", { name: "Keep them" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(s.storedDeleteBodies).toEqual([]);
    expect(screen.getByText("1 selected, 1,186 entries, 614 KB")).toBeInTheDocument();
  });

  it("ticks and unticks every row of the page, and drops a waiting confirmation when a tick changes", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    const all = screen.getByLabelText("Select all 3 on this page");
    fireEvent.click(all);
    expect(screen.getByText("3 selected, 4,338 entries, 2.2 MB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete 3…" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select flaky-tests"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/^2 selected/)).toBeInTheDocument();
    fireEvent.click(all);
    expect(all).toBeChecked();
    fireEvent.click(all);
    expect(screen.getByText("None selected")).toBeInTheDocument();
  });

  it("deletes everything that matches a filter, with the filter in the body, and says what the filter was", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    expect(screen.getByRole("button", { name: "Delete all 3 that match…" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Session"), { target: { value: "ap" } });
    await waitFor(() => expect(s.calls.some((c) => c.includes("/stored-activity?page=1&pageSize=25&q=ap"))).toBe(true));
    await screen.findByRole("button", { name: "Delete all 1 that match…" });
    fireEvent.click(screen.getByRole("button", { name: "Delete all 1 that match…" }));
    const box = screen.getByRole("alert");
    expect(box).toHaveTextContent('Delete the stored activity of the 1 session that matches: session matches "ap"?');
    expect(box).toHaveTextContent("2,310 entries, about 1.2 MB");
    fireEvent.click(within(box).getByRole("button", { name: "Delete 2,310 entries" }));
    expect(await screen.findByText(/^Deleted 2,310 entries \(about 1\.2 MB\)\./)).toBeInTheDocument();
    expect(s.storedDeleteBodies).toEqual([{ match: { q: "ap" } }]);
  });

  it("sends each filter in the query and the body: loop, project, owner, age, custom age and dates", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    fireEvent.change(screen.getByLabelText("Loop"), { target: { value: "agents" } });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "podium" } });
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "Maya Okafor" } });
    fireEvent.change(screen.getByLabelText("Older than"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Entries from"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("to"), { target: { value: "2026-10-08" } });
    const from = new Date("2026-10-01T00:00:00").getTime();
    const to = new Date("2026-10-08T00:00:00").getTime() + 86_400_000;
    await waitFor(() => expect(s.calls[s.calls.length - 1]).toContain(`loop=agents&project=podium&owner=Maya%20Okafor&olderThanDays=30&from=${from}&to=${to}`));
    fireEvent.click(await screen.findByRole("button", { name: "Delete all 1 that match…" }));
    expect(screen.getByRole("alert")).toHaveTextContent("agents only, project podium, owner Maya Okafor, older than 30 days, entries from 2026-10-01, entries before 2026-10-09");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /^Delete [\d,]+ entries$/ }));
    await screen.findByText(/^Deleted /);
    expect(s.storedDeleteBodies).toEqual([{ match: { loop: "agents", project: "podium", owner: "Maya Okafor", olderThanDays: 30, from, to } }]);
    fireEvent.change(screen.getByLabelText("Loop"), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText("Older than"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "12" } });
    await waitFor(() => expect(s.calls[s.calls.length - 1]).toContain("loop=main&project=podium&owner=Maya%20Okafor&olderThanDays=12"));
  });

  it("asks the loop filter for orchestrators only in words", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    fireEvent.change(screen.getByLabelText("Loop"), { target: { value: "main" } });
    fireEvent.click(await screen.findByRole("button", { name: "Delete all 3 that match…" }));
    expect(screen.getByRole("alert")).toHaveTextContent("orchestrator only");
  });

  it("says a date is not a day, and leaves it out of the request", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    fireEvent.change(screen.getByLabelText("Entries from"), { target: { value: "last week" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Write the dates as 2026-10-01.");
    expect(s.calls[s.calls.length - 1]).not.toContain("from=");
    fireEvent.change(screen.getByLabelText("Entries from"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("to"), { target: { value: "soon" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Write the dates as 2026-10-01.");
    expect(s.calls[s.calls.length - 1]).not.toContain("to=");
  });

  it("says no session matches when a filter finds none", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    fireEvent.change(screen.getByLabelText("Session"), { target: { value: "zzz" } });
    expect(await screen.findByText("No stored session matches. Clear a filter or widen the dates.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete all 0 that match…" })).toBeDisabled();
  });

  it("deletes everything after a confirmation, with all:true", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    fireEvent.click(screen.getByRole("button", { name: "Delete everything…" }));
    const box = screen.getByRole("alert");
    expect(box).toHaveTextContent("Delete all stored activity, for all 3 sessions?");
    expect(box).toHaveTextContent("4,338 entries, about 2.2 MB");
    fireEvent.click(within(box).getByRole("button", { name: "Delete 4,338 entries" }));
    expect(await screen.findByText(/^Deleted 4,338 entries \(about 2\.2 MB\)\. 1\.0 MB freed on disk/)).toBeInTheDocument();
    expect(s.storedDeleteBodies).toEqual([{ all: true }]);
    expect(await screen.findByText("Nothing has been captured yet. Activity appears here once a session runs under this policy.")).toBeInTheDocument();
  });

  it("pages through the sessions and changes the page size", async () => {
    const s = kept(4338);
    s.stored = Array.from({ length: 30 }, (_, i) => ({ ...ROWS[1]!, sessionId: `p${i}`, name: `session-${String(i).padStart(2, "0")}` }));
    await openStored();
    await screen.findByText("Showing 1 to 25 of 30");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Showing 26 to 30 of 30")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "50" } });
    expect(await screen.findByText("Showing 1 to 30 of 30")).toBeInTheDocument();
    expect(s.calls[s.calls.length - 1]).toContain("pageSize=50");
  });

  it("shows why a delete failed and keeps the ticks", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    fireEvent.click(screen.getByLabelText("Select docs-sweep"));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1…" }));
    s.storedError = "the file is busy";
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Delete 1,186 entries" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => a.textContent === "Could not delete the stored activity. Check that the server is running, then try again.")).toBe(true));
    expect(screen.getByText("1 selected, 1,186 entries, 614 KB")).toBeInTheDocument();
  });

  it("locks Admin when the session has ended while deleting", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    fireEvent.click(screen.getByRole("button", { name: "Delete everything…" }));
    s.expire = true;
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /^Delete [\d,]+ entries$/ }));
    expect(await screen.findByRole("button", { name: "Unlock Admin" })).toBeInTheDocument();
  });

  it("says when the list could not be loaded", async () => {
    const s = kept(4338);
    s.storedError = "database locked";
    await openStored();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the stored activity. Check that the server is running, then try again.");
    expect(screen.getByRole("button", { name: "Delete everything…" })).toBeDisabled();
  });
});

describe("the helpers", () => {
  it("writes a size the way the mockup does", () => {
    expect([0, 900, 2048, 96 * 1024, 8_283_750, 3 * 1024 ** 3].map(fmtBytes)).toEqual(["0 B", "900 B", "2 KB", "96 KB", "7.9 MB", "3.0 GB"]);
  });

  it("words the policy for the Detail rows table", () => {
    expect(policyText({ policy: "default", n: 1, unit: "days", capGb: 3 })).toBe("Not stored (default)");
    expect(policyText({ policy: "end", n: 1, unit: "days", capGb: null })).toBe("Purge when the session ends");
    expect(policyText({ policy: "all", n: 1, unit: "days", capGb: 4 })).toBe("Keep everything, no automatic purge, capped at 4 GB");
  });

  it("reads a draft, and says what is wrong with one", () => {
    expect(parseDraft({ policy: "after", n: "3", unit: "weeks", capOn: true, capN: "9" })).toEqual({ settings: { policy: "after", n: 3, unit: "weeks", capGb: 9 } });
    expect(parseDraft({ policy: "end", n: "junk", unit: "days", capOn: true, capN: "9" })).toEqual({ settings: { policy: "end", n: 30, unit: "days", capGb: 9 } });
    expect(parseDraft({ policy: "default", n: "3", unit: "days", capOn: true, capN: "9" })).toEqual({ settings: { policy: "default", n: 3, unit: "days", capGb: null } });
    expect(parseDraft({ policy: "after", n: "4000", unit: "days", capOn: false, capN: "" })).toEqual({ error: "Enter a whole number from 1 to 3650 for the time." });
  });

  it("builds the filter from what is set only", () => {
    expect(filterOf({ q: " a ", loop: "all", project: "", owner: "", age: "", days: "", from: "", to: "" })).toEqual({ filter: { q: "a" }, problem: "" });
    expect(filterOf({ q: "", loop: "all", project: "", owner: "", age: "custom", days: "0", from: "", to: "" }).filter).toEqual({});
  });

  it("shows a refusal from the server that says what to fix, then a next step", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    fireEvent.click(screen.getByRole("button", { name: "Delete everything…" }));
    s.storedBadRequest = "Pick a filter, or delete everything.";
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /^Delete [\d,]+ entries$/ }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => a.textContent === "Pick a filter, or delete everything. Change it and try again.")).toBe(true));
  });
});

describe("Stored activity, keyboard and loading (#432)", () => {
  it("says the policy could not be read, rather than loading forever, when settings fail", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    s.settingsError = "disk full";
    await openStored();
    expect(await screen.findByText(/Policy: could not be read\./)).toBeInTheDocument();
  });

  it("says Loading while the list and the policy load, not that they failed", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    render(<AdminView />);
    await screen.findByRole("navigation", { name: "Admin sections" });
    fireEvent.click(navStored());
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByText(/Policy: Loading…/)).toBeInTheDocument();
    expect(screen.queryByText(/not loaded/)).toBeNull();
    await screen.findByRole("table", { name: "Stored activity by session" });
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("focuses the destructive answer when the confirmation opens, and the opener when it is kept", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    const opener = screen.getByRole("button", { name: "Delete everything…" });
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getByRole("alert")).getByRole("button", { name: "Delete 4,338 entries" })));
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Keep them" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("puts focus on the first table control after a delete that leaves rows, and on the Session filter when none are left", async () => {
    const s = kept(4338);
    s.stored = ROWS;
    await openStored();
    await screen.findByRole("table", { name: "Stored activity by session" });
    fireEvent.click(screen.getByLabelText("Select docs-sweep"));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1…" }));
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /^Delete [\d,]+ entries$/ }));
    await screen.findByText(/^Deleted /);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Select all 2 on this page")));
    fireEvent.click(screen.getByRole("button", { name: "Delete everything…" }));
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /^Delete [\d,]+ entries$/ }));
    await screen.findByText("Nothing has been captured yet. Activity appears here once a session runs under this policy.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Session")));
  });
});
