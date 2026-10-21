// Admin > Settings > Session recording and Stored activity's Source filter (#353, mockup/podium-recording.html): the warning under the
// flag, the limits form, the Recordings table with its confirmations, and the recordings listed and deleted as a source.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeServer } from "./fakeAdmin";
import { keepShown, limitsOf } from "./RecordingAdmin";
import type { RecordingAdminRow } from "../types";

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

const KEPT = new Date(2026, 9, 21, 17, 42).getTime();
const REC = (over: Partial<RecordingAdminRow> = {}): RecordingAdminRow => ({ sessionId: "s1", name: "api-refactor", owner: "Maya Okafor", startedBy: "Maya Okafor", state: "recording", limit: null, loops: 4, label: "orchestrator and 3 agents", bytes: 18 * 1024 * 1024, keptUntil: KEPT, ...over });

/** A server with session recording on, its limits at the defaults and `rows` in the table. */
function recording(rows: RecordingAdminRow[] = [REC(), REC({ sessionId: "s2", name: "flaky-tests", state: "stopped", owner: null, startedBy: "Admin", bytes: 21 * 1024 * 1024 }), REC({ sessionId: "s3", name: "docs-sweep", state: "limit", limit: "session", keptUntil: null }), REC({ sessionId: "s4", name: "big", state: "limit", limit: "budget" })], on = true, authOn = true) {
  const s = fakeServer({ unlocked: true });
  s.features["session-recording"] = on;
  s.recording = { settings: { keepHours: 6, budgetMb: 4096, sessionMb: 512 }, totals: { recordings: rows.length, bytes: 41 * 1024 * 1024, running: 1 }, authOn };
  s.recordings = rows;
  return s;
}
async function openSettings() {
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { level: 2, name: "Feature flags" });
}
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
const putBodies = (s: ReturnType<typeof fakeServer>) => s.bodies.filter((b) => (b as { recording?: unknown }).recording) as { recording: Record<string, number> }[];

describe("the feature flag", () => {
  it("lists Session recording with the other flags, and shows the warning under it while it is on", async () => {
    recording();
    await openSettings();
    const sw = await screen.findByRole("switch", { name: /Session recording/ });
    expect(sw).toHaveAttribute("aria-checked", "true");
    const warn = screen.getByText(/A recording holds whole prompts, file contents, command output and tool results\./);
    expect(warn.textContent).toMatch(/Only the owner and an Admin can read a recording\./);
    expect(warn.closest(".warnbar")).toHaveAttribute("role", "note");
    expect(screen.getByText("session-recording")).toHaveClass("fid");
  });

  it("shows neither the warning nor the limits nor the table while it is off, and turns on with the switch", async () => {
    const s = recording([], false);
    await openSettings();
    const sw = await screen.findByRole("switch", { name: /Session recording/ });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/A recording holds whole prompts/)).toBeNull();
    expect(screen.queryByRole("form", { name: "Session recording limits" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Recordings" })).toBeNull();
    fireEvent.click(sw);
    await screen.findByRole("form", { name: "Session recording limits" });
    expect(s.bodies).toContainEqual({ features: { "session-recording": true } });
  });

  it("says nothing can be recorded when the server has no sign-in", async () => {
    recording([], true, false);
    await openSettings();
    expect(await screen.findByText(/This server has no sign-in, so nothing can be recorded\./)).toBeInTheDocument();
  });

  it("shows no recording sections from a server that predates recording", async () => {
    const s = fakeServer({ unlocked: true });
    s.features["session-recording"] = true;
    await openSettings();
    await screen.findByRole("switch", { name: /Session recording/ });
    expect(screen.queryByRole("form", { name: "Session recording limits" })).toBeNull();
  });
});

describe("the limits", () => {
  const form = () => screen.findByRole("form", { name: "Session recording limits" });
  const n = () => screen.getByRole("textbox", { name: "Number" }) as HTMLInputElement;
  const unit = () => screen.getByRole("combobox", { name: "Unit" }) as HTMLSelectElement;
  const gb = () => screen.getByRole("textbox", { name: "Size in gigabytes" }) as HTMLInputElement;
  const mb = () => screen.getByRole("textbox", { name: "Size in megabytes" }) as HTMLInputElement;

  it("shows the defaults: 6 hours, 4 GB, 512 MB, and what is stored now", async () => {
    recording();
    await openSettings();
    const f = within(await form());
    expect([n().value, unit().value, gb().value, mb().value]).toEqual(["6", "hours", "4", "512"]);
    expect(f.getByText(/4 recordings, 41\.0 MB/)).toBeInTheDocument();
    expect(f.getByText(/stored now, of a 4 GB budget\. Stored activity lists them with its Source filter set to Recordings\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Session recording" })).toBeInTheDocument();
  });

  it("saves what was typed, in hours, and says so", async () => {
    const s = recording();
    await openSettings();
    await form();
    fireEvent.change(n(), { target: { value: "2" } });
    fireEvent.change(unit(), { target: { value: "days" } });
    fireEvent.change(gb(), { target: { value: "0.5" } });
    fireEvent.change(mb(), { target: { value: "64" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBodies(s)).toHaveLength(1));
    expect(putBodies(s)[0]!.recording).toEqual({ keepHours: 48, budgetMb: 512, sessionMb: 64 });
    expect(await screen.findByText("Saved. Written to the Admin log.")).toBeInTheDocument();
    await waitFor(() => expect(n().value).toBe("2"));
    expect(unit().value).toBe("days");
  });

  it("says what is wrong before it sends anything", async () => {
    const s = recording();
    await openSettings();
    await form();
    fireEvent.change(n(), { target: { value: "8" } });
    fireEvent.change(unit(), { target: { value: "days" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a whole number of hours or days, from 1 hour to 7 days.");
    expect(putBodies(s)).toHaveLength(0);
  });

  it("shows the server's refusal in its words, and a failure in plain ones", async () => {
    const s = recording();
    await openSettings();
    await form();
    s.recordingError = "disk budget is below what is stored";
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("disk budget is below what is stored. Change it and try again.");
  });

  it("puts the saved values back with Cancel", async () => {
    recording();
    await openSettings();
    await form();
    fireEvent.change(n(), { target: { value: "99" } });
    fireEvent.change(gb(), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(n().value).toBe("6");
    expect(gb().value).toBe("4");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads a whole number of days as days and anything else as hours", () => {
    expect(keepShown(6)).toEqual({ n: "6", unit: "hours" });
    expect(keepShown(24)).toEqual({ n: "1", unit: "days" });
    expect(keepShown(36)).toEqual({ n: "36", unit: "hours" });
    expect(keepShown(168)).toEqual({ n: "7", unit: "days" });
  });

  it("checks each limit against the range the server takes", () => {
    const ok = { n: "6", unit: "hours", gb: "4", mb: "512" };
    expect(limitsOf(ok)).toEqual({ ok: true, value: { keepHours: 6, budgetMb: 4096, sessionMb: 512 } });
    expect(limitsOf({ ...ok, n: "0" })).toMatchObject({ ok: false });
    expect(limitsOf({ ...ok, n: "169" })).toMatchObject({ ok: false });
    expect(limitsOf({ ...ok, n: "1.5" })).toMatchObject({ ok: false });
    expect(limitsOf({ ...ok, unit: "days", n: "7" })).toMatchObject({ ok: true });
    expect(limitsOf({ ...ok, gb: "0" })).toMatchObject({ ok: false, error: expect.stringMatching(/disk budget/) });
    expect(limitsOf({ ...ok, gb: "" })).toMatchObject({ ok: false });
    expect(limitsOf({ ...ok, gb: "101" })).toMatchObject({ ok: false });
    expect(limitsOf({ ...ok, mb: "4" })).toMatchObject({ ok: false, error: expect.stringMatching(/one session/) });
    expect(limitsOf({ ...ok, mb: "5000" })).toMatchObject({ ok: false });
  });
});

describe("the Recordings table", () => {
  const table = () => screen.findByRole("table", { name: "Recordings" });
  const rowOf = (name: string) => within(screen.getByRole("table", { name: "Recordings" })).getByText(name).closest("tr") as HTMLElement;

  it("lists every recording with its owner, who started it, its state in shape and word, size, and when it is deleted", async () => {
    recording();
    await openSettings();
    await table();
    const running = rowOf("api-refactor");
    expect(running.textContent).toContain("orchestrator and 3 agents");
    expect(within(running).getAllByText("Maya Okafor")).toHaveLength(2);
    expect(running.querySelector(".badge.recording")!.textContent).toBe("● Recording");
    expect(running.textContent).toContain("18.0 MB");
    expect(running.textContent).toContain("2026-10-21 17:42");
    expect(rowOf("flaky-tests").querySelector(".badge.off")!.textContent).toBe("○ Stopped");
    expect(rowOf("flaky-tests").textContent).toContain("Admin");
    expect(rowOf("docs-sweep").querySelector(".badge.off")!.textContent).toBe("○ Limit reached");
    expect(rowOf("docs-sweep").textContent).toContain("–");
    expect(rowOf("big").querySelector(".badge.off")!.textContent).toBe("○ Budget reached");
    expect(screen.getByText("Showing 1 to 4 of 4")).toBeInTheDocument();
  });

  it("gives a running recording Stop and a kept one Open replay, each with Delete", async () => {
    recording();
    await openSettings();
    await table();
    expect(within(rowOf("api-refactor")).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(within(rowOf("api-refactor")).queryByRole("link", { name: "Open replay" })).toBeNull();
    const link = within(rowOf("flaky-tests")).getByRole("link", { name: "Open replay" });
    expect(link).toHaveAttribute("href", "#/?open=s2&replay");
    expect(within(rowOf("flaky-tests")).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("asks before it stops, says what stays, and stops it", async () => {
    const s = recording();
    await openSettings();
    await table();
    fireEvent.click(within(rowOf("api-refactor")).getByRole("button", { name: "Stop" }));
    const box = screen.getByRole("alert", { name: "" });
    expect(box.textContent).toMatch(/Stop recording api-refactor\?/);
    expect(box.textContent).toMatch(/What was recorded up to now is kept until it expires, and the owner can still replay it\. This is written to the Admin log\./);
    expect(within(box).getByRole("button", { name: "Stop recording" })).toHaveFocus();
    fireEvent.click(within(box).getByRole("button", { name: "Stop recording" }));
    await flush();
    expect(s.calls).toContain("POST /recordings/s1/stop");
    expect(await screen.findByText(/Stopped the recording of api-refactor\. What was recorded is kept\. Written to the Admin log\./)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Stop recording api-refactor/ })).toBeNull();
  });

  it("keeps the recording when asked to, and with Escape, and gives the focus back", async () => {
    const s = recording();
    await openSettings();
    await table();
    const stop = within(rowOf("api-refactor")).getByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    fireEvent.click(screen.getByRole("button", { name: "Keep recording" }));
    expect(screen.queryByText(/Stop recording api-refactor\?/)).toBeNull();
    expect(stop).toHaveFocus();
    fireEvent.click(stop);
    fireEvent.keyDown(screen.getByRole("button", { name: "Keep recording" }), { key: "Escape" });
    expect(screen.queryByText(/Stop recording api-refactor\?/)).toBeNull();
    expect(s.calls.some((c) => c.includes("/stop"))).toBe(false);
  });

  it("asks before it deletes, then deletes and says so", async () => {
    const s = recording();
    await openSettings();
    await table();
    fireEvent.click(within(rowOf("flaky-tests")).getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete the recording of flaky-tests?")).toBeInTheDocument();
    expect(screen.getByText(/The whole recording is removed for good, and the space freed\. The session, History and the live feed are not touched\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete recording" }));
    await flush();
    expect(s.calls).toContain("DELETE /recordings/s2");
    expect(await screen.findByText("Deleted the recording of flaky-tests. Written to the Admin log.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("flaky-tests", { selector: "td" })).toBeNull());
    fireEvent.click(within(rowOf("api-refactor")).getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByText("Delete the recording of api-refactor?")).toBeNull();
  });

  it("says what went wrong, and what to try", async () => {
    const s = recording();
    await openSettings();
    await table();
    s.recordingError = "the store is busy";
    fireEvent.click(within(rowOf("api-refactor")).getByRole("button", { name: "Stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect((await screen.findByText(/Could not stop the recording/)).textContent).toBe("Could not stop the recording: the store is busy. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Keep recording" }));
    fireEvent.click(within(rowOf("flaky-tests")).getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete recording" }));
    expect((await screen.findByText(/Could not delete the recording/)).textContent).toBe("Could not delete the recording: the store is busy. Try again.");
  });

  it("says no session is recorded when the table is empty", async () => {
    recording([]);
    await openSettings();
    expect(await screen.findByText(/No session is recorded\./)).toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it("says it could not load the recordings, and tries again by itself", async () => {
    const s = recording();
    s.storedError = "boom";
    await openSettings();
    expect(await screen.findByText(/Could not load the recordings \(boom\)\./)).toBeInTheDocument();
  });

  it("pages with the Admin pager", async () => {
    const many = Array.from({ length: 30 }, (_, i) => REC({ sessionId: `r${i}`, name: `session-${i}`, state: "stopped" }));
    const s = recording(many);
    await openSettings();
    await table();
    expect(screen.getByText("Showing 1 to 25 of 30")).toBeInTheDocument();
    fireEvent.click(document.getElementById("rec-next")!);
    await screen.findByText("Showing 26 to 30 of 30");
    expect(s.calls.some((c) => c.startsWith("GET /recordings?page=2"))).toBe(true);
    fireEvent.change(document.getElementById("rec-size")!, { target: { value: "50" } });
    await screen.findByText("Showing 1 to 30 of 30");
  });
});

describe("Stored activity with Source = Recordings", () => {
  const ROWS = [
    { sessionId: "a1", name: "api-refactor", project: "podium", owner: "Maya Okafor", live: false, entries: 2310, bytes: 1_258_291, oldestAt: Date.UTC(2026, 9, 9, 12) },
    { sessionId: "a2", name: "flaky-tests", project: "podium", owner: null, live: false, entries: 842, bytes: 419_430, oldestAt: Date.UTC(2026, 9, 14, 12) },
  ];
  async function openStored(s: ReturnType<typeof fakeServer>) {
    s.stored = [ROWS[0]!];
    s.storedRecordings = ROWS;
    render(<AdminView />);
    await screen.findByRole("navigation", { name: "Admin sections" });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Admin sections" })).getByRole("button", { name: /^Stored activity/ }));
    await screen.findByRole("heading", { level: 2, name: "What is stored" });
  }
  const source = () => screen.getByRole("combobox", { name: "Source" }) as HTMLSelectElement;

  it("offers Activity and Recordings, and lists the recordings when Recordings is chosen", async () => {
    const s = fakeServer({ unlocked: true });
    await openStored(s);
    expect([...source().options].map((o) => o.textContent)).toEqual(["Activity", "Recordings"]);
    await screen.findByText("api-refactor");
    expect(screen.queryByText("flaky-tests")).toBeNull();
    fireEvent.change(source(), { target: { value: "recordings" } });
    await screen.findByText("flaky-tests");
    expect(s.calls.some((c) => c.includes("/stored-activity?") && c.includes("source=recordings"))).toBe(true);
    expect(screen.getByRole("group", { name: "Delete recordings" })).toBeInTheDocument();
  });

  it("leaves the loop filter out of it, because a whole recording has no loop", async () => {
    const s = fakeServer({ unlocked: true });
    await openStored(s);
    fireEvent.change(screen.getByRole("combobox", { name: "Loop" }), { target: { value: "main" } });
    fireEvent.change(source(), { target: { value: "recordings" } });
    expect(screen.getByRole("combobox", { name: "Loop" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Loop" })).toHaveAttribute("title", "A recording covers the whole session, so it has no loop to filter by");
    fireEvent.change(source(), { target: { value: "activity" } });
    expect(screen.getByRole("combobox", { name: "Loop" })).not.toHaveAttribute("title");
    fireEvent.change(source(), { target: { value: "recordings" } });
    await screen.findByText("flaky-tests");
    expect(s.calls.filter((c) => c.includes("source=recordings")).every((c) => !c.includes("loop="))).toBe(true);
  });

  it("deletes the ticked recordings with the source named, and not the Activity", async () => {
    const s = fakeServer({ unlocked: true });
    await openStored(s);
    fireEvent.change(source(), { target: { value: "recordings" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select flaky-tests" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1…" }));
    expect(screen.getByText(/Delete the recordings of 1 session\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Delete 842 entries/ }));
    await waitFor(() => expect(s.storedDeleteBodies).toEqual([{ ids: ["a2"], source: "recordings" }]));
    expect(s.stored).toHaveLength(1);
    expect(s.storedRecordings).toHaveLength(1);
  });

  it("deletes everything and what a filter matches in the recordings, with the source in the body", async () => {
    const s = fakeServer({ unlocked: true });
    await openStored(s);
    fireEvent.change(source(), { target: { value: "recordings" } });
    await screen.findByText("flaky-tests");
    fireEvent.click(screen.getByRole("button", { name: "Delete everything…" }));
    expect(screen.getByText(/Delete all recordings, for all 2 sessions\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Delete 3,152 entries/ }));
    await waitFor(() => expect(s.storedDeleteBodies).toEqual([{ all: true, source: "recordings" }]));
    fireEvent.change(source(), { target: { value: "recordings" } });
  });

  it("matches by a filter without sending the loop, and keeps Delete all that match off without a filter", async () => {
    const s = fakeServer({ unlocked: true });
    await openStored(s);
    fireEvent.change(source(), { target: { value: "recordings" } });
    await screen.findByText("flaky-tests");
    expect(screen.getByRole("button", { name: /Delete all 2 that match…/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "podium" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Delete all 2 that match…/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /Delete all 2 that match…/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Delete 3,152 entries/ }));
    await waitFor(() => expect(s.storedDeleteBodies).toEqual([{ match: { project: "podium", source: "recordings" } }]));
  });

  it("goes back to the Activity when Activity is chosen again, and clears what was ticked", async () => {
    const s = fakeServer({ unlocked: true });
    await openStored(s);
    fireEvent.change(source(), { target: { value: "recordings" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select flaky-tests" }));
    fireEvent.change(source(), { target: { value: "activity" } });
    await screen.findByText("api-refactor");
    expect(screen.getByText("None selected")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Delete stored activity" })).toBeInTheDocument();
  });
});
