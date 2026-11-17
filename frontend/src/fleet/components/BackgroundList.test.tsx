import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { ActivityFeed } from "./ActivityFeed";
import { BackgroundList, BackgroundOutputFlag, BackgroundPane, agoOf, isQuiet, lengthOf, phaseOf, QUIET_MS, wordOf } from "./BackgroundList";
import { makeAgent, makeSession } from "../fixtures";
import type { ActivityReply, FetchActivity } from "../useActivityFeed";
import type { BackgroundItem, SessionView } from "../types";

const T0 = 1_800_000_000_000;
const item = (over: Partial<BackgroundItem> = {}): BackgroundItem => ({ id: "b1", kind: "shell", state: "running", startedAt: T0, startedKnown: false, label: "npm", ...over });
const session = (over: Partial<SessionView> = {}) => makeSession({ reporterVersion: "1.7.0", activityFeed: true, backgroundOutput: true, ...over });

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.classList.remove("modal-open");
});

describe("the words an item says", () => {
  it("is a shape, a word and a color for each way an item can be: running, finished, failed, ended without a code", () => {
    expect(wordOf(item())).toBe("Running");
    expect(wordOf(item({ state: "exited", exitCode: 0 }))).toBe("Finished, exit 0");
    expect(wordOf(item({ state: "exited", exitCode: 2 }))).toBe("Failed, exit 2");
    expect(wordOf(item({ state: "exited" }))).toBe("Ended without an exit code");
    expect(["run", "ok", "bad", "end"]).toEqual([phaseOf(item()), phaseOf(item({ state: "exited", exitCode: 0 })), phaseOf(item({ state: "exited", exitCode: 1 })), phaseOf(item({ state: "exited" }))]);
  });

  it("formats a length as m:ss, or h:mm:ss from an hour, and an age in the shortest unit", () => {
    expect(lengthOf(5 * 60_000 + 12_000)).toBe("5:12");
    expect(lengthOf(3_725_000)).toBe("1:02:05");
    expect(agoOf(4000)).toBe("4 s ago");
    expect(agoOf(6 * 60_000)).toBe("6 min ago");
    expect(agoOf(3 * 3_600_000)).toBe("3 h ago");
  });

  it("is quiet only when it runs and its last output is 5 minutes old or more: a reporter that cannot read the file says nothing, so it is never quiet", () => {
    const now = T0 + 10 * 60_000;
    expect(isQuiet(item({ lastOutputAt: now - QUIET_MS }), now)).toBe(true);
    expect(isQuiet(item({ lastOutputAt: now - QUIET_MS + 1 }), now)).toBe(false);
    expect(isQuiet(item(), now)).toBe(false);
    expect(isQuiet(item({ state: "exited", lastOutputAt: T0 }), now)).toBe(false);
  });
});

describe("the list", () => {
  const list = (items: BackgroundItem[], over: Partial<Parameters<typeof BackgroundList>[0]> = {}) =>
    render(<BackgroundList items={items} now={T0 + 5 * 60_000 + 12_000} harness={undefined} flagOn={true} optionOn={true} {...over} />);

  it("draws a row per item in the feed's own markup: the start time, a shape with a name, the kind, the command, the state and the run time", () => {
    const { container } = list([item({ id: "b1", command: "npm run test:e2e" }), item({ id: "m1", kind: "monitor", label: "tail", command: "tail -f log", startedAt: T0 + 1000 })]);
    const rows = container.querySelectorAll(".feed li");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".at")!.textContent).toMatch(/^\d\d:\d\d$/);
    expect(within(rows[0] as HTMLElement).getByRole("img", { name: "Running" })).toBeInTheDocument();
    expect(rows[0]!.querySelector(".name")!.textContent).toBe("Shell");
    expect(rows[1]!.querySelector(".name")!.textContent).toBe("Monitor");
    expect(rows[0]!.querySelector(".arg")!.textContent).toBe("npm run test:e2e");
    expect(rows[0]!.querySelector(".bgs")!.textContent).toBe("Running");
    expect(rows[0]!.querySelector(".bgline .mono")!.textContent).toBe("5:12");
  });

  it("shows only the first word, with an ellipsis, while the command is not sent", () => {
    const { container } = list([item()]);
    expect(container.querySelector(".arg")!.textContent).toBe("npm …");
  });

  it("marks the time as first seen when the harness reports no start time, and as started when it does", () => {
    const { container } = list([item({ id: "a", startedKnown: false }), item({ id: "b", startedKnown: true })]);
    const times = [...container.querySelectorAll(".at")].map((e) => e.getAttribute("title"));
    expect(times[0]).toMatch(/^First seen .*the harness does not report a start time$/);
    expect(times[1]).toMatch(/^Started /);
  });

  it("says Quiet under Running, with a shape, once the last output is 5 minutes old, and the last output otherwise", () => {
    const now = T0 + 20 * 60_000;
    const { container } = render(<BackgroundList items={[item({ id: "q", lastOutputAt: now - 12 * 60_000 }), item({ id: "l", lastOutputAt: now - 4000 })]} now={now} harness={undefined} flagOn={true} optionOn={true} />);
    const [quiet, live] = [...container.querySelectorAll(".feed li")];
    expect(quiet!.querySelector(".bgq")!.textContent).toBe("Quiet for 12 min");
    expect(quiet!.textContent).not.toContain("last output");
    expect(live!.querySelector(".bgq")).toBeNull();
    expect(live!.textContent).toContain("last output 4 s ago");
  });

  it("knows the run time of a finished item from when it ended, and says none when it does not know", () => {
    const { container } = list([item({ id: "a", state: "exited", exitCode: 0, endedAt: T0 + 41_000 }), item({ id: "b", state: "exited" })]);
    const [a, b] = [...container.querySelectorAll(".feed li")];
    expect(a!.querySelector(".bgline .mono")!.textContent).toBe("0:41");
    expect(b!.querySelector(".bgline .mono")).toBeNull();
  });

  it("opens a row to the whole command and its output, each with Copy, and Collapse closes it", () => {
    const { container } = list([item({ command: "npm run dev", output: "ready\n[redacted]\n", state: "exited", exitCode: 2 })]);
    const row = container.querySelector(".feed li") as HTMLElement;
    expect(container.querySelector(".xp")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: /Shell/ }));
    expect(row.classList.contains("open")).toBe(true);
    expect(container.querySelector(".xcmd")!.textContent).toBe("npm run dev");
    expect(container.querySelector(".xout")!.textContent).toBe("ready\n[redacted]\n");
    expect(container.querySelector(".xout .rd")!.textContent).toBe("[redacted]");
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy output" })).toBeInTheDocument();
    expect(container.querySelector(".xh .exit.bad")!.textContent).toContain("Exit 2, failed");
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(container.querySelector(".xp")).toBeNull();
  });

  it("opens and closes with a click anywhere on the row, but not from inside the opened part", () => {
    const { container } = list([item({ command: "make", output: "built" })]);
    const row = container.querySelector(".feed li") as HTMLElement;
    fireEvent.click(row.querySelector(".at")!);
    expect(container.querySelector(".xp")).not.toBeNull();
    fireEvent.click(container.querySelector(".xout")!);
    expect(container.querySelector(".xp")).not.toBeNull();
    fireEvent.click(row.querySelector(".at")!);
    expect(container.querySelector(".xp")).toBeNull();
  });

  it("explains an output that is not there: the Admin's flag off, the option off (with where to turn it on), or an output not collected", () => {
    const flagOff = list([item({ command: "make" })], { flagOn: false });
    fireEvent.click(flagOff.container.querySelector(".tgl")!);
    expect(flagOff.container.querySelector(".feedoff")!.textContent).toContain("Admin > Settings");
    cleanup();
    const optionOff = list([item({ command: undefined })], { optionOn: false });
    fireEvent.click(optionOff.container.querySelector(".tgl")!);
    expect(optionOff.container.textContent).toContain("backgroundOutput");
    expect(optionOff.container.textContent).toContain("Only the first word is shown.");
    cleanup();
    const opencode = list([item({ command: undefined })], { optionOn: false, harness: "opencode" });
    fireEvent.click(opencode.container.querySelector(".tgl")!);
    expect(opencode.container.textContent).toContain("PODIUM_BACKGROUND_OUTPUT=true");
    cleanup();
    const lost = list([item({ command: "make" })]);
    fireEvent.click(lost.container.querySelector(".tgl")!);
    expect(lost.container.querySelector(".feedoff b")!.textContent).toBe("Output was not collected.");
  });

  it("says a shell that printed nothing printed nothing, while it runs and after", () => {
    const run = list([item({ command: "sleep 9", output: "" })]);
    fireEvent.click(run.container.querySelector(".tgl")!);
    expect(run.container.querySelector(".feedoff b")!.textContent).toBe("Nothing printed yet.");
    cleanup();
    const done = list([item({ command: "true", output: "", state: "exited", exitCode: 0 })]);
    fireEvent.click(done.container.querySelector(".tgl")!);
    expect(done.container.querySelector(".feedoff b")!.textContent).toBe("The command printed nothing.");
  });

  it("draws a command from a session as text, never as markup", () => {
    const { container } = list([item({ command: "<img src=x onerror=alert(1)>", output: "<b>bold</b>" })]);
    fireEvent.click(container.querySelector(".tgl")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector(".xcmd")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("the whole tab", () => {
  const pane = (s: SessionView, items: BackgroundItem[], over: Partial<Parameters<typeof BackgroundPane>[0]> = {}) =>
    render(
      <BackgroundOutputFlag.Provider value={true}>
        <BackgroundPane s={s} items={items} now={T0} when="Updated 1s ago" adminOff={false} refused={null} {...over} />
      </BackgroundOutputFlag.Provider>,
    );

  it("says an older reporter does not send background items, and where the Output tab stays as it was", () => {
    const { container } = pane(session({ backgroundOutput: null }), []);
    expect(container.textContent).toContain("This reporter does not send background items.");
    expect(container.textContent).toContain("1.7.0");
    expect(container.querySelector(".feed")).toBeNull();
  });

  it("says nothing is running, in words, with no list", () => {
    const { container } = pane(session({ name: "Silverbolt" }), []);
    expect(container.textContent).toContain("No background shells or monitors");
    expect(container.textContent).toContain("Silverbolt");
    expect(container.querySelector(".feed")).toBeNull();
  });

  it("gives OpenCode its own words: no monitors", () => {
    const { container } = pane(session({ harness: "opencode" }), [item()]);
    expect(container.querySelector(".bgnote")!.textContent).toBe("OpenCode has no monitors, so none are listed.");
    const claude = pane(session({ harness: "claude-code" }), [item()]);
    expect(claude.container.querySelector(".bgnote")).toBeNull();
  });

  it("ends with the feed's own footer: the count and Updated line, the fixed line and the keep line", () => {
    const { container } = pane(session(), [item(), item({ id: "b2" })]);
    expect(container.querySelector(".feedfoot.stat .count")!.textContent).toBe("Showing the newest 2 of 2");
    expect(container.querySelector(".feedfoot.stat .when")!.textContent).toBe("Updated 1s ago");
    const lines = [...container.querySelectorAll(".feedfoot:not(.stat) span")].map((e) => e.textContent);
    expect(lines[0]).toContain("Kept only while someone is watching.");
    expect(lines[1]).toContain("20 latest finished");
  });

  it("says the feed is off or refused instead of listing", () => {
    expect(pane(session(), [item()], { adminOff: true }).container.querySelector(".feed")).toBeNull();
    cleanup();
    expect(pane(session(), [item()], { refused: "Sign in." }).container.textContent).toContain("Sign in.");
  });
});

describe("the tabs of the Activity modal", () => {
  const reply = (background: BackgroundItem[]): ActivityReply => ({ entries: [{ seq: 1, at: T0 + 1000, kind: "tool", text: "Read a.ts" }], background, since: T0, live: true, enabled: true, serverTime: T0 });
  const show = (background: BackgroundItem[], over: Partial<SessionView> = {}) => {
    const a = makeAgent({ id: "a1", startedAt: T0 });
    const s = session({ agents: [a], ...over });
    // The first answer is the lease beginning: what it holds already happened, so the feed starts with the entries of the next.
    let calls = 0;
    const fetchActivity = vi.fn<FetchActivity>(async () => ({ ...reply(background), entries: calls++ === 0 ? [] : reply(background).entries }));
    render(
      <BackgroundOutputFlag.Provider value={true}>
        <ActivityFeed s={s} loop="a1" title="Map call sites" startedAt={T0} active={true} now={T0} fetchActivity={fetchActivity} />
      </BackgroundOutputFlag.Provider>,
    );
    return fetchActivity;
  };
  const open = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
  };

  it("has Output and Background tabs, with the feed on Output and the count of items on Background", async () => {
    show([item({ id: "a", command: "make" }), item({ id: "b", command: "npm run dev" })]);
    await open();
    const dialog = screen.getByRole("dialog");
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Output", "Background2"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(dialog.querySelectorAll(".feed li")).toHaveLength(1);
    expect(dialog.querySelector(".feed li")!.textContent).toContain("Read a.ts");
  });

  it("shows the Background list on its tab, from the same answers, and the feed again on Output", async () => {
    show([item({ id: "a", command: "make" })]);
    await open();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("tab", { name: /Background/ }));
    expect(within(dialog).getByRole("tab", { name: /Background/ })).toHaveAttribute("aria-selected", "true");
    expect(dialog.querySelector(".feed li .name")!.textContent).toBe("Shell");
    expect(dialog.querySelector(".feed li")!.textContent).not.toContain("Read a.ts");
    fireEvent.click(within(dialog).getByRole("tab", { name: "Output" }));
    expect(dialog.querySelector(".feed li")!.textContent).toContain("Read a.ts");
  });

  it("moves between the tabs with the arrow keys", async () => {
    show([]);
    await open();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(within(dialog).getByRole("tab", { name: "Output" }), { key: "ArrowRight" });
    expect(within(dialog).getByRole("tab", { name: /Background/ })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the modal one size and its Refresh every select on both tabs", async () => {
    show([item()]);
    await open();
    const dialog = screen.getByRole("dialog");
    const before = dialog.className;
    fireEvent.click(within(dialog).getByRole("tab", { name: /Background/ }));
    expect(dialog.className).toBe(before);
    expect(within(dialog).getByLabelText("Refresh interval")).toBeInTheDocument();
  });

  it("shows no count and says why on the tab of an older reporter, and leaves the Output tab alone", async () => {
    show([], { backgroundOutput: null });
    await open();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Output", "Background"]);
    fireEvent.click(within(dialog).getByRole("tab", { name: "Background" }));
    expect(dialog.textContent).toContain("This reporter does not send background items.");
  });
});
